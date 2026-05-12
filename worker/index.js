// O'Brien Brief API — Cloudflare Worker proxy
//
// Holds the GitHub PAT server-side so end-users never touch one.
// Users authenticate to this Worker with a shared team passcode
// (X-Auth-Passcode header), which is checked against env.TEAM_PASSCODE.
//
// REQUIRED SECRETS (Cloudflare dashboard → Worker → Settings → Variables):
//   GITHUB_PAT       fine-grained PAT with Contents: read & write on the repo
//   TEAM_PASSCODE    shared passcode that users enter once per browser
//   GITHUB_REPO      e.g. "thomasjnr-eng/eventbrief"
//   GITHUB_BRANCH    e.g. "main" (or the working branch)
//   ALLOWED_ORIGIN   the frontend's URL, e.g. "https://briefs.obriencatering.ie"
//                    set to "*" only during initial testing

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
