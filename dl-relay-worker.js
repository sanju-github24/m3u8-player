/* =====================================================================
   Download relay — the same file, under a clean name.

   The file host names every download after its own link, which starts
   "www.1TamilMV.capital_-_…", and its token is tied to that exact path, so
   the name cannot be fixed in the link. This worker streams the file
   through unchanged and only sets the name the browser saves it under.

     GET /?u=<file url>&n=<name>
       u — the file's full link, token included (https, allowed hosts only)
       n — the name to save it as; optional, read from the link when absent

   Range requests pass through, so pausing, resuming and download managers
   work. Nothing is stored. Only the hosts below are relayed, so this is not
   an open proxy for anything on the internet.

   Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker → paste
   this → Deploy. Then set VITE_DL_RELAY on the site to the worker's URL.
   ===================================================================== */

const ALLOWED_HOSTS = ['juicybits.site', 'hakunaymatata.com'];

const allowed = (host) => ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));

/* MoviBox's CDN answers only a request that names movibox.net as its
   Referer (429 otherwise), which a browser on our site cannot send — so
   that is the one thing added here for it. */
const REFERER_FOR = [[/(^|\.)hakunaymatata\.com$/i, 'https://movibox.net/']];
const refererFor = (host) => (REFERER_FOR.find(([re]) => re.test(host)) || [])[1] || '';

// "www.1TamilMV.capital - Sardar 2 (2026) …" / "www.1TamilMV.capital_-_Sardar_2…" → "Sardar 2 (2026) …"
const stripPrefix = (s) => String(s || '').replace(/^\s*www[._]1tamilmv[._][a-z]+[\s_]*-[\s_]*/i, '');

function cleanName(name, link) {
  let n = stripPrefix(name);
  if (!n) {
    // No name given: the link's own file name, prefix off, underscores as spaces.
    const last = decodeURIComponent(new URL(link).pathname.split('/').pop() || 'video');
    n = stripPrefix(last).replace(/_/g, ' ');
  }
  // Characters no file system accepts, and a sane length.
  n = n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'video';
  if (!/\.(mkv|mp4|avi|m4v|webm)$/i.test(n)) {
    const ext = (new URL(link).pathname.match(/\.(mkv|mp4|avi|m4v|webm)$/i) || ['.mkv'])[0];
    n += ext;
  }
  return n;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: CORS });

    const q = new URL(request.url).searchParams;
    const link = q.get('u') || '';
    let target;
    try { target = new URL(link); } catch { return new Response('Missing or bad ?u=', { status: 400, headers: CORS }); }
    if (target.protocol !== 'https:' || !allowed(target.hostname)) {
      return new Response('That host is not relayed here', { status: 403, headers: CORS });
    }

    const headers = { 'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0' };
    const referer = refererFor(target.hostname);
    if (referer) headers.Referer = referer;
    const range = request.headers.get('Range');
    if (range) headers.Range = range;

    const upstream = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
    if (!upstream.ok) {
      return new Response(`The file host answered ${upstream.status} — the link may have expired; get a fresh one.`,
        { status: upstream.status === 404 ? 404 : 502, headers: CORS });
    }

    const name = cleanName(q.get('n'), target.href);
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    const out = new Headers(CORS);
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    if (!out.has('Accept-Ranges')) out.set('Accept-Ranges', 'bytes');
    // ?play=1 serves it for a player to stream; otherwise it saves as a download.
    out.set('Content-Disposition', `${q.get('play') === '1' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    out.set('Cache-Control', 'no-store');

    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
