/* =====================================================================
   Download relay — the same file, under a clean name.

   The file hosts name every download after their own site — 1TamilMV puts
   "www.1TamilMV.capital_-_…" at the front, HDHub4u stamps "…-HDHub4u.Ms"
   before the extension — and the token is tied to that exact path, so the
   name cannot be fixed in the link. This worker streams the file through
   unchanged and only sets the name the browser saves it under.

     GET /?u=<file url>&n=<name>
       u — the file's full link, token included (https, allowed hosts only)
       n — the name to save it as; optional, read from the link when absent

     GET /?u=<mkv>&play=1&tracks=1   the file's audio tracks, as JSON
     GET /?u=<mkv>&play=1&a=<k>      the file, playing its k-th audio track

   A browser plays only the FIRST audio track of an MKV and gives the page no
   way to pick another. So for &a=k the relay edits the file's track list on
   the way through: every other audio track's TrackType byte is changed from
   audio (2) to subtitle (17), leaving track k the only audio the browser
   sees. One byte per track, in the header — nothing changes length, so byte
   ranges, seeking and the rest of the file pass through untouched. A
   multi-language MKV plays in any of its languages, with nothing converted.

   Range requests pass through, so pausing, resuming and download managers
   work. Nothing is stored. Only the hosts below are relayed, so this is not
   an open proxy for anything on the internet.

   Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker → paste
   this → Deploy. Then set VITE_DL_RELAY on the site to the worker's URL.
   ===================================================================== */

const ALLOWED_HOSTS = [
  'api.1anchormovies.buzz', 'api3.1anchormovies.buzz', 'movies1-backend.onrender.com',   // our /api/fresh/play, which redirects to the file
  'juicybits.site', 'hakunaymatata.com',                 // 1TamilMV / 1TamilBlasters
  'pixeldrain.dev', 'cloudflarestorage.com', 'googleusercontent.com',   // HDHub4u (pixeldrain, R2 FSL, 10Gbps)
  'multidownload.lol',                                   // India4Movies (MultiCloudLinks' Turbo R2)
];

/* India4Movies' older files are served by Cloudflare workers whose name
   changes from one link to the next (…workers.dev/download/<token>/<name>),
   so those are allowed by their path, not by name. */
const allowed = (host, path = '') => ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))
  || (/\.workers\.dev$/i.test(host) && /^\/download\/[A-Za-z0-9_-]{16,}\//.test(path));

/* MoviBox's CDN answers only a request that names movibox.net as its
   Referer (429 otherwise), which a browser on our site cannot send — so
   that is the one thing added here for it. */
const REFERER_FOR = [[/(^|\.)hakunaymatata\.com$/i, 'https://movibox.net/']];
const refererFor = (host) => (REFERER_FOR.find(([re]) => re.test(host)) || [])[1] || '';

/* The site tag a host stamps on, removed wherever it sits:
     "www.1TamilMV.capital - Sardar 2 (2026) …" → "Sardar 2 (2026) …"  (prefix)
     "War.2.2025.…x264-HDHub4u.Ms.mkv"          → "War.2.2025.…x264.mkv" (suffix)
     "Premada.Oorali.…x264-india4Movies.ORG.mkv" → "Premada.Oorali.…x264.mkv"
     "www.1Full4Movies.com - Sarvam.Maya.…mkv"    → "Sarvam.Maya.…mkv"
   Only the known release sites, so an ordinary part of a title is left alone. */
const SITES = '(?:www[._])?(?:1?tamilmv|1?tamilblasters|hdhub4u|india4movies|1?full4movies)';
const SITE_PREFIX = new RegExp(`^\\s*${SITES}[._][a-z]+[\\s_]*-[\\s_]*`, 'i');                       // "www.1TamilMV.capital - "
const SITE_LEAD_TAG = new RegExp(`^\\s*[\\[(@]\\s*${SITES}[._][a-z]{2,4}\\s*[\\])]?\\s*[-–—_]*\\s*`, 'i'); // "[HDHub4u.Dad] "
const SITE_SUFFIX = new RegExp(`[\\s._-]*[\\[(@-]?\\s*${SITES}[._][a-z]{2,4}\\s*[\\])]?(?=\\.[a-z0-9]{2,4}\\s*$|\\s*$)`, 'i'); // "-HDHub4u.Ms.mkv"
const stripSiteTags = (s) => String(s || '').replace(SITE_PREFIX, '').replace(SITE_LEAD_TAG, '').replace(SITE_SUFFIX, '');

function cleanName(name, link, hostName = '') {
  let n = stripSiteTags(name);
  if (!n) {
    /* No name given: the host's own name for it, else the link's file name,
       tags off, underscores as spaces. Some links (MultiCloudLinks' /d/<id>)
       name nothing in the path. */
    const last = hostName || decodeURIComponent(new URL(link).pathname.split('/').pop() || 'video');
    n = stripSiteTags(last).replace(/_/g, ' ');
  }
  // Characters no file system accepts, and a sane length.
  n = n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'video';
  if (!/\.(mkv|mp4|avi|m4v|webm)$/i.test(n)) {
    const ext = (new URL(link).pathname.match(/\.(mkv|mp4|avi|m4v|webm)$/i) || ['.mkv'])[0];
    n += ext;
  }
  return n;
}

/* ── Reading an MKV's track list ───────────────────────────────────────
   EBML: each element is an ID (a variable-length integer that keeps its
   marker bit) and a size (one that drops it), then the data. The Tracks
   element sits near the start of the file, before the first Cluster. */
const HEAD = 1 << 20;   // the track list is read from, and edited in, the first 1 MiB
const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, TRACKS: 0x1654ae6b, CLUSTER: 0x1f43b675, ENTRY: 0xae,
  NUMBER: 0xd7, TYPE: 0x83, CODEC: 0x86, LANG: 0x22b59c, BCP47: 0x22b59d, NAME: 0x536e, DEFAULT: 0x88, AUDIO: 0xe1, CHANNELS: 0x9f };
function vint(b, i, keepMarker) {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1, mask = 0x80;
  while (!(first & mask)) { mask >>= 1; len++; }
  if (i + len > b.length) return null;
  let v = keepMarker ? first : first & (mask - 1), allOnes = v === mask - 1;
  for (let k = 1; k < len; k++) { v = v * 256 + b[i + k]; if (b[i + k] !== 0xff) allOnes = false; }
  return { v: !keepMarker && allOnes ? Infinity : v, len };
}
const uint = (b, i, n) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[i + k]; return v; };
const str = (b, i, n) => new TextDecoder().decode(b.subarray(i, i + n)).replace(/\0+$/, '');
function* children(b, start, end) {
  let i = start;
  while (i < end && i < b.length) {
    const id = vint(b, i, true); if (!id) return;
    const size = vint(b, i + id.len, false); if (!size) return;
    const data = i + id.len + size.len;
    yield { id: id.v, data, size: size.v };
    if (size.v === Infinity) return;
    i = data + size.v;
  }
}
function readTracks(b) {
  const tracks = [];
  for (const top of children(b, 0, b.length)) {
    if (top.id !== ID.SEGMENT) continue;
    const segEnd = top.size === Infinity ? b.length : Math.min(b.length, top.data + top.size);
    for (const el of children(b, top.data, segEnd)) {
      if (el.id === ID.CLUSTER) return tracks;
      if (el.id !== ID.TRACKS) continue;
      for (const e of children(b, el.data, Math.min(b.length, el.data + el.size))) {
        if (e.id !== ID.ENTRY) continue;
        const t = { number: 0, type: 0, typeAt: -1, codec: '', lang: 'eng', name: '', channels: 0, default: true };
        for (const f of children(b, e.data, Math.min(b.length, e.data + e.size))) {
          if (f.id === ID.NUMBER) t.number = uint(b, f.data, f.size);
          else if (f.id === ID.TYPE) { t.type = uint(b, f.data, f.size); if (f.size === 1) t.typeAt = f.data; }
          else if (f.id === ID.CODEC) t.codec = str(b, f.data, f.size);
          else if (f.id === ID.LANG) t.lang = str(b, f.data, f.size) || t.lang;
          else if (f.id === ID.BCP47) t.bcp47 = str(b, f.data, f.size);
          else if (f.id === ID.NAME) t.name = str(b, f.data, f.size);
          else if (f.id === ID.DEFAULT) t.default = uint(b, f.data, f.size) === 1;
          else if (f.id === ID.AUDIO) {
            for (const a of children(b, f.data, Math.min(b.length, f.data + f.size))) if (a.id === ID.CHANNELS) t.channels = uint(b, a.data, a.size);
          }
        }
        tracks.push(t);
      }
      return tracks;
    }
  }
  return tracks;
}

/* The first 1 MiB and its track list, per link, kept for the life of this
   worker instance: a player asks for several ranges of one file. */
const heads = new Map();
async function headOf(link, headers) {
  const hit = heads.get(link);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit;
  const r = await fetch(link, { headers: { ...headers, Range: `bytes=0-${HEAD - 1}` }, redirect: 'follow' });
  if (!r.ok) return null;
  let bytes, size, noRanges = false;
  if (r.status === 206) {
    bytes = new Uint8Array(await r.arrayBuffer());
    size = Number((r.headers.get('Content-Range') || '').split('/')[1]) || 0;
  } else {
    /* A server that ignores ranges (Google's "10Gbps") sends the whole file:
       its first 1 MiB is enough to read the tracks, and the rest is let go. */
    noRanges = true;
    size = Number(r.headers.get('Content-Length')) || 0;
    bytes = await readFirst(r.body, HEAD);
  }
  let tracks = [];
  try { tracks = readTracks(bytes); } catch { /* not an MKV we can read */ }
  const head = { at: Date.now(), bytes, size, tracks, noRanges, type: r.headers.get('Content-Type') || 'video/x-matroska', final: r.url };
  rememberFinal(link, r.url);
  heads.set(link, head);
  if (heads.size > 50) heads.delete(heads.keys().next().value);
  return head;
}
const audioOf = (head) => head.tracks.filter((t) => t.type === 2);

/* The first n bytes of a stream; the reader is released, so what is left
   can still be piped on. Only a handful of chunks — little CPU. */
async function readFirst(body, n, { keep = false } = {}) {
  const reader = body.getReader();
  const parts = []; let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
  }
  const all = new Uint8Array(got); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  if (keep) { reader.releaseLock(); return all; }
  reader.cancel().catch(() => {});
  return all.subarray(0, Math.min(n, got));
}

/* Where a link led. Our /api/hdhub/play and /api/fresh/play answer with a
   redirect to the file, and a player makes many range requests over a film —
   going back through the backend for each added a second before every one,
   and every seek felt it. The file's own link is kept for a quarter of an
   hour (theirs last hours) and used directly; if it has been refused, the
   original link is asked again. */
const finals = new Map();   // link -> { url, at }
const finalOf = (link) => { const f = finals.get(link); return f && Date.now() - f.at < 15 * 60e3 ? f.url : null; };
function rememberFinal(link, url) {
  if (!url || url === link) return;
  finals.set(link, { url, at: Date.now() });
  if (finals.size > 500) finals.delete(finals.keys().next().value);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: CORS });

    const q = new URL(request.url).searchParams;
    const link = q.get('u') || '';
    let target;
    try { target = new URL(link); } catch { return new Response('Missing or bad ?u=', { status: 400, headers: CORS }); }
    if (target.protocol !== 'https:' || !allowed(target.hostname, target.pathname)) {
      return new Response('That host is not relayed here', { status: 403, headers: CORS });
    }

    /* The viewer's own browser name, so the file host sees what it expects;
       anything that is not a browser (a tool, a probe) goes as Chrome —
       MultiCloudLinks answers "Bot blocked" to a curl or ffmpeg name. */
    const ua = request.headers.get('User-Agent') || '';
    const headers = { 'User-Agent': /^Mozilla\//.test(ua) ? ua
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' };
    const referer = refererFor(target.hostname);
    if (referer) headers.Referer = referer;
    const range = request.headers.get('Range');

    /* ── A multi-audio MKV: its tracks, or one of them ── */
    if (q.get('tracks') === '1' || q.has('a')) {
      const head = await headOf(target.href, headers).catch(() => null);
      if (q.get('tracks') === '1') {
        const audio = head ? audioOf(head).map((t, k) => ({ a: k, lang: t.bcp47 || t.lang, name: t.name, codec: t.codec, channels: t.channels, default: t.default })) : [];
        const video = head ? head.tracks.filter((t) => t.type === 1).map((t) => t.codec) : [];
        return new Response(JSON.stringify({ size: head?.size || 0, video, audio }), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      const want = Number(q.get('a'));
      const audio = head ? audioOf(head) : [];
      const m = /^bytes=(\d+)-(\d*)$/.exec(range || '');
      const s = m ? Number(m[1]) : 0;
      /* A server without ranges: only a play from the start can be edited —
         the whole file, its head rewritten as it goes past. (Seeking is not
         possible on such a server for anyone; the player plays it through.) */
      if (head && head.noRanges && audio.length > 1 && audio[want] && s === 0) {
        const full = await fetch(head.final || target.href, { headers, redirect: 'follow' });
        if (full.ok && full.body) {
          const body = full.body;
          const firstPart = await readFirst(body, head.bytes.length, { keep: true });
          const patched = firstPart.slice();
          audio.forEach((t, k) => { if (k !== want && t.typeAt >= 0 && t.typeAt < patched.length) patched[t.typeAt] = 17; });
          const out = new Headers(CORS);
          out.set('Content-Type', head.type);
          if (head.size) out.set('Content-Length', String(head.size));
          out.set('Content-Disposition', 'inline');
          out.set('Cache-Control', 'no-store');
          const { readable, writable } = new TransformStream();
          ctx.waitUntil((async () => {
            const w = writable.getWriter(); await w.write(patched); w.releaseLock();
            await body.pipeTo(writable);
          })());
          return new Response(readable, { status: 200, headers: out });
        }
      }
      /* Only a request that touches the first 1 MiB needs the edit; a seek
         further in streams straight through, below. */
      if (head && !head.noRanges && audio.length > 1 && audio[want] && s < head.bytes.length && head.size) {
        const e = m && m[2] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1;
        const patched = head.bytes.slice();
        audio.forEach((t, k) => { if (k !== want && t.typeAt >= 0) patched[t.typeAt] = 17; });
        const first = patched.subarray(s, Math.min(e, patched.length - 1) + 1);
        const out = new Headers(CORS);
        out.set('Content-Type', head.type);
        out.set('Accept-Ranges', 'bytes');
        out.set('Content-Length', String(e - s + 1));
        if (m) out.set('Content-Range', `bytes ${s}-${e}/${head.size}`);
        out.set('Content-Disposition', 'inline');
        out.set('Cache-Control', 'no-store');
        if (e < patched.length) return new Response(first, { status: m ? 206 : 200, headers: out });
        /* The edited head, then the rest of the range straight from the host:
           piped natively, so a long stream costs this worker no CPU. */
        const rest = await fetch(head.final || target.href, { headers: { ...headers, Range: `bytes=${patched.length}-${e}` }, redirect: 'follow' });
        if (rest.status !== 206) return new Response('The file host stopped answering ranges', { status: 502, headers: CORS });
        const { readable, writable } = new TransformStream();
        ctx.waitUntil((async () => {
          const w = writable.getWriter(); await w.write(first); w.releaseLock();
          await rest.body.pipeTo(writable);
        })());
        return new Response(readable, { status: m ? 206 : 200, headers: out });
      }
    }

    if (range) headers.Range = range;

    let upstream = null;
    const known = finalOf(target.href);
    if (known) {
      upstream = await fetch(known, { method: request.method, headers, redirect: 'follow' }).catch(() => null);
      if (!upstream || !upstream.ok) { finals.delete(target.href); upstream = null; }   // expired: ask the original again
    }
    if (!upstream) {
      upstream = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
      if (upstream.ok) rememberFinal(target.href, upstream.url);
    }
    if (!upstream.ok) {
      return new Response(`The file host answered ${upstream.status} — the link may have expired; get a fresh one.`,
        { status: upstream.status === 404 ? 404 : 502, headers: CORS });
    }

    const cd = upstream.headers.get('Content-Disposition') || '';
    const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
    // Some hosts percent-encode even the plain filename ("…com%20-%20Sarvam…").
    const plain = (cd.match(/filename="?([^";]+)"?/i) || [])[1] || '';
    let hostName = star ? star[1] : plain;
    try { hostName = decodeURIComponent(hostName); } catch { /* left as it is */ }
    const name = cleanName(q.get('n'), target.href, hostName);
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
