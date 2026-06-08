// O'Brien Brief API — Cloudflare Worker proxy
//
// Holds the GitHub PAT server-side so end-users never touch one.
// Users authenticate to this Worker with a shared team passcode
// (X-Auth-Passcode header), which is checked against env.TEAM_PASSCODE.
//
// REQUIRED SECRETS (Cloudflare dashboard → Worker → Settings → Variables):
//   GITHUB_PAT         fine-grained PAT with Contents: read & write on the repo
//   TEAM_PASSCODE      shared passcode that users enter once per browser
//   GITHUB_REPO        e.g. "thomasjnr-eng/eventbrief"
//   GITHUB_BRANCH      e.g. "main" (or the working branch)
//   ALLOWED_ORIGIN     the frontend's URL, e.g. "https://briefs.obriencatering.ie"
//                      set to "*" only during initial testing
//   ANTHROPIC_API_KEY  (optional) Claude API key for the Import screenshot
//                      extraction. If unset, /extract returns a 503 telling
//                      the user to add the key in Settings.
//   GOOGLE_MAPS_API_KEY (optional) Google Geocoding API key. If unset, the
//                      /geocode route falls back to OpenStreetMap Nominatim
//                      (free, low volume only).
//   MANAGER_CODE       Secret code the manager (Tom) enters once in Settings
//                      to unlock the override + payroll-export views.
//                      Without it set, /verify-manager always returns 401.
//   EMAIL_TO           Recipient address for the day-plan email. Defaults to
//                      operations@obrieneventcatering.com when unset.
//   EMAIL_FROM         "From" address. MUST be on a domain whose SPF +
//                      _mailchannels TXT records authorise this worker
//                      account to send via MailChannels — see README.
//                      Without it the route returns 503.
//   EMAIL_FROM_NAME    (optional) Friendly sender name.
//   WEEKLY_DIGEST_TO   Comma-separated list of email addresses that
//                      should receive the Monday-morning "this week"
//                      digest. Falls back to EMAIL_TO, then to
//                      operations@obrieneventcatering.com. Triggered by
//                      the cron trigger configured in wrangler.toml
//                      (default 06:30 UTC every Monday).

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Passcode',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/health') {
      return json({ ok: true, name: "O'Brien Brief API" }, 200, origin);
    }

    const provided = request.headers.get('X-Auth-Passcode');
    if (!provided || provided !== env.TEAM_PASSCODE) {
      return json({ error: 'unauthorized' }, 401, origin);
    }

    try {
      if (path === '/events' && request.method === 'GET') {
        return await listEvents(env, origin);
      }
      if (path === '/extract' && request.method === 'POST') {
        return await extractFromImage(await request.json(), env, origin);
      }
      if (path === '/geocode' && (request.method === 'POST' || request.method === 'GET')) {
        let address;
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          address = body.address;
        } else {
          address = url.searchParams.get('address');
        }
        return await geocodeAddress(address, env, origin);
      }
      if (path === '/reverse-geocode' && (request.method === 'POST' || request.method === 'GET')) {
        let lat, lng;
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          lat = body.lat; lng = body.lng;
        } else {
          lat = parseFloat(url.searchParams.get('lat'));
          lng = parseFloat(url.searchParams.get('lng'));
        }
        return await reverseGeocode(lat, lng, env, origin);
      }
      if (path === '/email-plan' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return await emailPlanViaMailChannels(body, env, origin);
      }
      if (path === '/verify-manager' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const code = body && body.code;
        if (!env.MANAGER_CODE) return json({ error: 'manager_not_configured' }, 401, origin);
        if (!code || code !== env.MANAGER_CODE) return json({ error: 'bad_code' }, 401, origin);
        return json({ ok: true }, 200, origin);
      }
      const m = path.match(/^\/events\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (request.method === 'GET') return await getEvent(id, env, origin);
        if (request.method === 'PUT') return await putEvent(id, await request.json(), env, origin);
        if (request.method === 'DELETE') return await deleteEvent(id, env, origin);
      }
      return json({ error: 'not found' }, 404, origin);
    } catch (e) {
      return json({ error: e.message }, 500, origin);
    }
  },

  // Cron Trigger entry point. Schedule the cron in wrangler.toml:
  //   [triggers]
  //   crons = ["30 6 * * 1"]   # 06:30 UTC every Monday
  // Cloudflare wakes the Worker, invokes scheduled(), and waitUntil
  // keeps the runtime alive until sendWeeklyDigest finishes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendWeeklyDigest(env));
  }
};

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' }
  });
}

async function githubApi(path, opts, env) {
  return fetch('https://api.github.com/repos/' + env.GITHUB_REPO + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + env.GITHUB_PAT,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'obrien-brief-worker',
      ...(opts && opts.headers ? opts.headers : {})
    }
  });
}

function refQuery(env) {
  return env.GITHUB_BRANCH ? '?ref=' + encodeURIComponent(env.GITHUB_BRANCH) : '';
}

async function listEvents(env, origin) {
  const res = await githubApi('/contents/events' + refQuery(env), {}, env);
  if (res.status === 404) return json({ files: [] }, 200, origin);
  if (!res.ok) return json({ error: 'github ' + res.status }, 502, origin);
  const items = await res.json();
  return json({
    files: items
      .filter(f => f.type === 'file' && f.name.endsWith('.json'))
      .map(f => f.name)
  }, 200, origin);
}

async function getEvent(id, env, origin) {
  const res = await githubApi('/contents/events/' + encodeURIComponent(id) + refQuery(env), {}, env);
  if (res.status === 404) return json({ error: 'not found' }, 404, origin);
  if (!res.ok) return json({ error: 'github ' + res.status }, 502, origin);
  const meta = await res.json();
  const decoded = decodeBase64Utf8(meta.content.replace(/\n/g, ''));
  return json({ sha: meta.sha, event: JSON.parse(decoded) }, 200, origin);
}

async function putEvent(id, payload, env, origin) {
  const body = {
    message: 'Save event ' + id,
    content: encodeBase64Utf8(JSON.stringify(payload.event, null, 2))
  };
  if (env.GITHUB_BRANCH) body.branch = env.GITHUB_BRANCH;
  if (payload.sha) body.sha = payload.sha;
  const res = await githubApi('/contents/events/' + encodeURIComponent(id), {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }
  }, env);
  if (!res.ok) {
    const errText = await res.text();
    return json({ error: 'save failed (' + res.status + ')', detail: errText }, 502, origin);
  }
  const data = await res.json();
  return json({ sha: data.content.sha, created: !payload.sha }, 200, origin);
}

async function deleteEvent(id, env, origin) {
  const metaRes = await githubApi('/contents/events/' + encodeURIComponent(id) + refQuery(env), {}, env);
  if (!metaRes.ok) return json({ error: 'not found' }, 404, origin);
  const meta = await metaRes.json();
  const body = { message: 'Delete event ' + id, sha: meta.sha };
  if (env.GITHUB_BRANCH) body.branch = env.GITHUB_BRANCH;
  const res = await githubApi('/contents/events/' + encodeURIComponent(id), {
    method: 'DELETE',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }
  }, env);
  if (!res.ok) return json({ error: 'delete failed' }, 502, origin);
  return json({ ok: true }, 200, origin);
}

// ─── EVENT EXTRACTION FROM IMAGE ─────────────────────────────
// Proxies a vision request to the Anthropic API. The frontend sends
// { imageBase64, mediaType } (e.g. mediaType 'image/png'). We send
// the image + an extraction prompt to Claude Haiku and return the
// parsed JSON list of events.
async function extractFromImage(payload, env, origin) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'extraction_disabled', message: "Anthropic API key not configured on the Worker. Add it as the ANTHROPIC_API_KEY secret in Cloudflare." }, 503, origin);
  }
  if (!payload || !payload.imageBase64 || !payload.mediaType) {
    return json({ error: 'imageBase64 and mediaType required' }, 400, origin);
  }
  const systemPrompt =
    "You extract event-booking details from images (screenshots of emails, " +
    "WhatsApp messages, schedules, contracts) for an Irish event-catering company. " +
    "Return ONLY valid JSON with the shape " +
    '{"events":[{"eventName":string,"eventStartDate":"YYYY-MM-DD","venueName":string,' +
    '"clientName":string,"attendance":string,"notes":string}]}. ' +
    "If you're unsure of any field, omit it. When the date format is ambiguous " +
    "assume European DD/MM/YYYY. If you can't find any events at all, return " +
    '{"events":[]}. No commentary, no markdown fences — JSON only.';
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: payload.mediaType, data: payload.imageBase64 } },
            { type: 'text', text: 'Extract any events from this image. Return JSON only.' }
          ]
        }]
      })
    });
  } catch (e) {
    return json({ error: 'anthropic_unreachable', detail: e.message }, 502, origin);
  }
  if (!res.ok) {
    const errText = await res.text();
    return json({ error: 'anthropic_' + res.status, detail: errText }, 502, origin);
  }
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  let parsed;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: 'parse_failed', raw: text }, 502, origin);
  }
  return json({ events: Array.isArray(parsed.events) ? parsed.events : [] }, 200, origin);
}

// ─── GEOCODING ───────────────────────────────────────────────
// Converts a free-text address to lat/lng so the frontend can
// draw a geofence and check whether crew clock-ins are on site.
// Prefers Google Geocoding API when GOOGLE_MAPS_API_KEY is set
// (accurate, low-cost), falling back to Nominatim (free, but low
// volume only — they ask ≤1 req/sec and a real User-Agent).
async function geocodeAddress(address, env, origin) {
  if (!address || !String(address).trim()) {
    return json({ error: 'address required' }, 400, origin);
  }
  const q = String(address).trim();
  if (env.GOOGLE_MAPS_API_KEY) {
    try {
      const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(q) + '&key=' + env.GOOGLE_MAPS_API_KEY);
      if (r.ok) {
        const d = await r.json();
        const hit = d.results && d.results[0];
        if (hit && hit.geometry && hit.geometry.location) {
          return json({
            lat: hit.geometry.location.lat,
            lng: hit.geometry.location.lng,
            formatted: hit.formatted_address,
            source: 'google'
          }, 200, origin);
        }
      }
    } catch (e) {
      // fall through to Nominatim
    }
  }
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1&addressdetails=0', {
      headers: { 'User-Agent': 'obrien-brief-worker (ops@obrieneventcatering.com)' }
    });
    if (!r.ok) return json({ error: 'nominatim_' + r.status }, 502, origin);
    const d = await r.json();
    if (!d.length) return json({ error: 'no_results' }, 404, origin);
    return json({
      lat: parseFloat(d[0].lat),
      lng: parseFloat(d[0].lon),
      formatted: d[0].display_name,
      source: 'nominatim'
    }, 200, origin);
  } catch (e) {
    return json({ error: 'geocode_unreachable', detail: e.message }, 502, origin);
  }
}

// ─── REVERSE GEOCODING ────────────────────────────────────────
// Given a lat/lng (from a clock-in entry), returns a human-readable
// place name. Same provider-preference pattern as /geocode.
async function reverseGeocode(lat, lng, env, origin) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ error: 'lat and lng required' }, 400, origin);
  }
  if (env.GOOGLE_MAPS_API_KEY) {
    try {
      const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?latlng=' + lat + ',' + lng + '&key=' + env.GOOGLE_MAPS_API_KEY);
      if (r.ok) {
        const d = await r.json();
        const hit = d.results && d.results[0];
        if (hit) {
          return json({ formatted: hit.formatted_address, source: 'google' }, 200, origin);
        }
      }
    } catch (e) {
      // fall through
    }
  }
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&zoom=18&addressdetails=0', {
      headers: { 'User-Agent': 'obrien-brief-worker (ops@obrieneventcatering.com)' }
    });
    if (!r.ok) return json({ error: 'nominatim_' + r.status }, 502, origin);
    const d = await r.json();
    if (!d || !d.display_name) return json({ error: 'no_results' }, 404, origin);
    return json({ formatted: d.display_name, source: 'nominatim' }, 200, origin);
  } catch (e) {
    return json({ error: 'revgeo_unreachable', detail: e.message }, 502, origin);
  }
}

// ─── EMAIL DAY PLAN via MailChannels ─────────────────────────
// Sends a "Tomorrows Day Plan" email to env.EMAIL_TO whenever the
// frontend POSTs /email-plan. Uses MailChannels (free transactional
// email service for Cloudflare Workers). Requires DNS setup on the
// "from" domain — SPF allowing MailChannels and a _mailchannels TXT
// record naming this Cloudflare account id. Without it MailChannels
// returns 401/403.
async function emailPlanViaMailChannels(payload, env, origin) {
  if (!env.EMAIL_FROM) {
    return json({ error: 'email_disabled', message: "EMAIL_FROM not configured on the Worker. Set EMAIL_FROM (and optionally EMAIL_TO + EMAIL_FROM_NAME) as variables in Cloudflare, plus the SPF + _mailchannels DNS records on the sending domain." }, 503, origin);
  }
  const to = env.EMAIL_TO || 'operations@obrieneventcatering.com';
  const from = env.EMAIL_FROM;
  const fromName = env.EMAIL_FROM_NAME || "O'Brien Brief Planner";
  const subject = (payload && payload.subject) || 'Tomorrows Day Plan';
  const html = (payload && payload.html) || '';
  const text = (payload && payload.text) || '';
  if (!html && !text) return json({ error: 'empty_body' }, 400, origin);

  const content = [];
  // MailChannels requires text/plain to appear before text/html
  if (text) content.push({ type: 'text/plain', value: text });
  if (html) content.push({ type: 'text/html',  value: html });

  const mailReq = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from, name: fromName },
    subject,
    content
  };

  try {
    const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mailReq)
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return json({ error: 'mailchannels_' + r.status, detail: errText }, 502, origin);
    }
    return json({ ok: true }, 200, origin);
  } catch (e) {
    return json({ error: 'email_unreachable', detail: e.message }, 502, origin);
  }
}

// ─── WEEKLY DIGEST ────────────────────────────────────────────
// Cron-triggered Monday morning email. Walks every event file in the
// repo, picks out the ones touching the current week, and emails a
// day-by-day summary to every address in WEEKLY_DIGEST_TO (falls back
// to EMAIL_TO, then operations@obrieneventcatering.com).
async function sendWeeklyDigest(env) {
  try {
    if (!env.EMAIL_FROM) {
      console.error('weekly digest skipped: EMAIL_FROM not configured');
      return;
    }
    const recips = (env.WEEKLY_DIGEST_TO || env.EMAIL_TO || 'operations@obrieneventcatering.com')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!recips.length) { console.error('weekly digest skipped: no recipients'); return; }

    // Load all event JSON files via the GitHub Contents API
    const listRes = await githubApi('/contents/events' + (env.GITHUB_BRANCH ? '?ref=' + encodeURIComponent(env.GITHUB_BRANCH) : ''), {}, env);
    if (!listRes.ok) { console.error('weekly digest list failed:', listRes.status); return; }
    const items = await listRes.json();
    const eventFiles = items.filter(f => f.type === 'file' && f.name.endsWith('.json') &&
      !f.name.startsWith('plan-') &&
      f.name !== 'clocks.json' && f.name !== 'damage-reports.json' && f.name !== 'force-signouts.json');

    const events = [];
    for (const f of eventFiles) {
      try {
        const r = await githubApi('/contents/events/' + encodeURIComponent(f.name) + (env.GITHUB_BRANCH ? '?ref=' + encodeURIComponent(env.GITHUB_BRANCH) : ''), {}, env);
        if (!r.ok) continue;
        const meta = await r.json();
        const decoded = decodeBase64Utf8(meta.content.replace(/\n/g, ''));
        const parsed = JSON.parse(decoded);
        if (parsed && parsed.form) events.push(parsed.form);
      } catch (e) { /* skip broken file */ }
    }

    // Compute the Monday→Sunday window in UTC. The cron fires Monday
    // morning UTC so "today" is the Monday we want.
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - dow);
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    const fmtIso = (d) => d.toISOString().slice(0, 10);
    const mondayStr = fmtIso(monday);
    const sundayStr = fmtIso(sunday);

    // Group events by trading day in this week
    function expandDays(form) {
      const out = new Set();
      if (Array.isArray(form._tradingDays) && form._tradingDays.length) {
        form._tradingDays.forEach(d => { if (d && d.date) out.add(d.date); });
      } else if (form.eventStartDate) {
        const s = new Date(form.eventStartDate + 'T00:00:00Z');
        const e = new Date((form.eventFinishDate || form.eventStartDate) + 'T00:00:00Z');
        const cur = new Date(s);
        let guard = 0;
        while (cur <= e && guard++ < 60) { out.add(fmtIso(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
      } else if (form.eventDate) {
        out.add(form.eventDate);
      }
      return [...out];
    }
    const byDay = {};
    let touched = 0;
    events.forEach(f => {
      const days = expandDays(f);
      let hit = false;
      days.forEach(d => {
        if (d >= mondayStr && d <= sundayStr) {
          hit = true;
          (byDay[d] = byDay[d] || []).push(f);
        }
      });
      if (hit) touched++;
    });
    const sortedDays = Object.keys(byDay).sort();

    const fmtDayLabel = (iso) => {
      const dt = new Date(iso + 'T00:00:00Z');
      return dt.toLocaleDateString('en-IE', { weekday: 'long', day: '2-digit', month: 'short', timeZone: 'Europe/Dublin' });
    };
    const escape = (s) => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const weekRangeLabel =
      new Date(monday + 'T00:00:00').toLocaleDateString('en-IE', { day: '2-digit', month: 'short' }) +
      ' – ' +
      new Date(sunday + 'T00:00:00').toLocaleDateString('en-IE', { day: '2-digit', month: 'short' });

    let bodyDays;
    let textLines = ["O'Brien Event Catering — This week's schedule (" + mondayStr + ' to ' + sundayStr + ')', ''];
    if (!sortedDays.length) {
      bodyDays = '<p style="color:#555;">Nothing on the calendar this week. Enjoy the quiet.</p>';
      textLines.push('Nothing on the calendar this week.');
    } else {
      bodyDays = sortedDays.map(d => {
        const dayLabel = fmtDayLabel(d).toUpperCase();
        textLines.push(dayLabel);
        const evs = byDay[d].map(f => {
          const name = f.eventName || '(unnamed)';
          const venue = f.venueName || '';
          const fleet = (f._fleet || []).length;
          const tw = (f.eventStartTime && f.eventFinishTime) ? (f.eventStartTime + '–' + f.eventFinishTime) : '';
          textLines.push('  • ' + name + (venue ? ' — ' + venue : '') + (tw ? ' (' + tw + ')' : '') + ' · ' + fleet + ' unit' + (fleet === 1 ? '' : 's'));
          return '<tr>' +
            '<td style="padding:6px 12px 6px 0;font-weight:700;color:#111;">' + escape(name) + '</td>' +
            '<td style="padding:6px 12px 6px 0;color:#555;">' + escape(venue || '—') + '</td>' +
            '<td style="padding:6px 12px 6px 0;color:#555;white-space:nowrap;">' + escape(tw || '—') + '</td>' +
            '<td style="padding:6px 0;color:#5a7a4f;font-weight:700;">' + fleet + ' unit' + (fleet === 1 ? '' : 's') + '</td>' +
          '</tr>';
        }).join('');
        textLines.push('');
        return '<h3 style="font-family:\'Bebas Neue\',Arial,sans-serif;font-size:16px;letter-spacing:0.1em;color:#5a7a4f;margin:18px 0 6px;border-bottom:1px solid #e0ddd8;padding-bottom:4px;">' + escape(dayLabel) + '</h3>' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
            '<thead><tr>' +
              '<th style="text-align:left;padding:4px 12px 4px 0;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#888;">Event</th>' +
              '<th style="text-align:left;padding:4px 12px 4px 0;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#888;">Venue</th>' +
              '<th style="text-align:left;padding:4px 12px 4px 0;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#888;">Trade</th>' +
              '<th style="text-align:left;padding:4px 0;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#888;">Fleet</th>' +
            '</tr></thead><tbody>' + evs + '</tbody></table>';
      }).join('');
    }

    const html = '<div style="font-family:Lato,Helvetica,Arial,sans-serif;color:#111;background:#fff;padding:24px 28px;max-width:760px;">' +
      '<div style="border-bottom:3px solid #5a7a4f;padding-bottom:10px;margin-bottom:16px;">' +
        '<div style="font-family:\'Bebas Neue\',Arial,sans-serif;font-size:13px;letter-spacing:0.12em;color:#5a7a4f;">O\'BRIEN EVENT CATERING · WEEKLY DIGEST</div>' +
        '<div style="font-size:22px;font-weight:700;margin-top:4px;">This week\'s schedule</div>' +
        '<div style="font-size:13px;color:#555;margin-top:2px;">' + weekRangeLabel + ' · ' + touched + ' event' + (touched === 1 ? '' : 's') + '</div>' +
      '</div>' +
      bodyDays +
      '<div style="margin-top:22px;font-size:11px;color:#aaa;border-top:1px solid #e0ddd8;padding-top:10px;">Sent automatically every Monday morning by the O\'Brien Brief planner. Open ops.obrieneventcatering.com for full briefs and live progress.</div>' +
    '</div>';
    const text = textLines.join('\n');

    const personalizations = recips.map(to => ({ to: [{ email: to }] }));
    const mailReq = {
      personalizations,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || "O'Brien Brief Planner" },
      subject: "This week's schedule — " + weekRangeLabel,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html }
      ]
    };
    const r = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mailReq)
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('weekly digest send failed', r.status, errText);
    } else {
      console.log('weekly digest sent to', recips.join(', '), '·', touched, 'event(s) ·', mondayStr, 'to', sundayStr);
    }
  } catch (e) {
    console.error('weekly digest exception', e && e.message);
  }
}

// UTF-8 safe base64 (atob/btoa in Workers handle Latin-1 only)
function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
