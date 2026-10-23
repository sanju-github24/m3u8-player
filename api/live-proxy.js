/* A stream proxy that runs in Mumbai, and borrows an Indian address when
 * Mumbai is not enough.
 *
 * Measured against four CDN hosts from five hosting providers:
 *
 *     Indian ISP / residential     FanCode 200   SonyLiv 200   Hotstar 200
 *     Indian datacenter (any)      FanCode 200   SonyLiv 403   Hotstar 403
 *     outside India (any)          FanCode 403   SonyLiv 403   Hotstar 403
 *
 * Two different blocks, so two different answers. FanCode's is geographic
 * alone, and this function being pinned to bom1 clears it — see vercel.json,
 * without which nothing here works. SonyLiv and Hotstar additionally refuse
 * hosted networks, which no cloud region anywhere can help with, so for those
 * the request is forwarded through a public proxy on an Indian consumer or
 * campus network. Those proxies are strangers' machines: fine for a public
 * stream signed with a token that expires in hours, and not a thing to send
 * anything private through.
 *
 *   GET /api/live-proxy?url=<encoded>[&cookie=][&ref=][&ua=][&via=host:port]
 */
import { ProxyAgent } from 'undici';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Only these hosts, so this cannot be used as an open relay for anything on
   the internet. It is a public URL on a domain you own. */
const ALLOWED = ['fancode.com', 'akamaized.net', 'hotstar.com', 'jio.com', 'hakunaymatata.com'];

/* Hosts that want an address no datacenter has. Everything else is served
   straight from Mumbai, which is faster and does not depend on a stranger. */
const NEEDS_RESIDENTIAL = [
  'sonydaimenew.akamaized.net',
  'sonydaime.akamaized.net',      // SonyLiv moved its live feeds here, 2026-10
  'live09p.hotstar.com',
  'hotstar.com',
  'v2-prime.akamaized.net',       // answers 475 to Mumbai and to the Delhi VPS, 2026-10
];

const PROXY_LIST =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => directOk.get(h) === false || NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

// ── the proxy pool ───────────────────────────────────────────
/* Kept on the module, which on a warm instance survives between requests.
   A cold start pays for the list again; that is one small fetch. */
let pool = { list: [], at: 0 };
let known = new Map();          // hostname -> proxy that last worked for it
let directOk = new Map();      // residential-host -> true (this address is accepted) | false (blocked, use a proxy)
/* Proven to block every datacenter address (Mumbai and a Delhi VPS both
   refused, 2026-10): the paid Hotstar/Sony CDNs. Pre-marked so Star Sports
   and the other Digital channels go straight to the residential pool with
   no wasted direct probe. The learning path above still covers any new host. */
for (const h of ['livetv.hotstar.com', 'live09p.hotstar.com', 'sonydaimenew.akamaized.net', 'sonydaime.akamaized.net']) directOk.set(h, false);

async function proxyList() {
  if (pool.list.length && Date.now() - pool.at < 15 * 60_000) return pool.list;
  try {
    const r = await fetch(PROXY_LIST, { cache: 'no-store' });
    const txt = await r.text();
    const list = txt.split('\n').map(l => l.trim())
      .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l));
    if (list.length) pool = { list, at: Date.now() };
  } catch { /* keep whatever we had */ }
  return pool.list;
}

function get(url, headers, proxy, ms) {
  const opts = { headers, signal: AbortSignal.timeout(ms) };
  if (proxy) opts.dispatcher = new ProxyAgent({ uri: `http://${proxy}`, connectTimeout: ms });
  return fetch(url, opts);
}

/* Find a proxy that this particular host accepts.
 *
 * Most entries on a public list are dead, so they are raced in batches rather
 * than tried one after another — serially this would exhaust the function's
 * time long before finding the one that works. The winner is remembered per
 * host, because what SonyLiv accepts and what Hotstar accepts need not match. */
async function findProxy(url, headers, hostname, skip = '') {
  const list = await proxyList();
  if (!list.length) return null;

  const remembered = known.get(hostname);
  const rest = list.filter(p => p !== remembered && p !== skip);
  const ordered = remembered && remembered !== skip ? [remembered, ...rest] : rest;

  for (let i = 0; i < Math.min(ordered.length, 48); i += 8) {
    const batch = ordered.slice(i, i + 8);
    const hit = await Promise.any(batch.map(async (p) => {
      const r = await get(url, headers, p, 7000);
      if (!r.ok) throw new Error(String(r.status));
      return { proxy: p, res: r };
    })).catch(() => null);
    if (hit) { known.set(hostname, hit.proxy); return hit; }
  }
  return null;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { url: target, cookie = '', ref = '', ua = '', via = '' } = req.query;
  if (!target) return res.status(400).send('Missing ?url=');

  let targetUrl;
  try { targetUrl = new URL(target); } catch { return res.status(400).send('Invalid url'); }
  if (!allowed(targetUrl.hostname)) return res.status(403).send('Host not allowed');

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep the target's */ } }

  const headers = {
    'User-Agent': ua || DEFAULT_UA,
    'Referer': ref || targetUrl.origin + '/',
    'Origin': refOrigin,
    'Accept': '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
    // A player seeking in a file asks for a byte range; pass it on.
    ...(req.headers.range ? { Range: req.headers.range } : {}),
  };

  let upstream, usedProxy = '';
  try {
    if (via) {
      /* A playlist names the proxy that fetched it, so its segments go the
         same way instead of each one searching the pool again. Public proxies
         die mid-stream, though, so a pinned one that throws or refuses is
         dropped and the pool is searched again rather than failing the
         segment — the player only sees a slower fetch, not an error. */
      /* If a later request already replaced a dead pin, go the way that works. */
      const pinned = known.get(targetUrl.hostname) || via;
      usedProxy = pinned;
      try { upstream = await get(targetUrl.toString(), headers, pinned, 8000); }
      catch { upstream = null; }
      if (!upstream || !upstream.ok) {
        if (known.get(targetUrl.hostname) === pinned) known.delete(targetUrl.hostname);
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname, pinned);
        if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
        else if (!upstream) { upstream = await get(targetUrl.toString(), headers, null, 15000); usedProxy = ''; }
      }
    } else if (needsResidential(targetUrl.hostname)) {
      /* Some of these hosts — Star Sports and the other Digital channels on
         livetv.hotstar.com, a JioTV-catchup path — may accept this Mumbai
         address and answer in one fast request, while the paid-app CDNs
         block every datacenter IP and must go through a residential proxy.
         Which is which is learned per host and remembered, so the cost is
         paid at most once on a warm instance: a host known to block skips
         straight to the pool; otherwise one quick direct try decides it. A
         real refusal (403/451/452/475) marks it blocking; a 2xx marks it
         direct and serves with no proxy. */
      if (directOk.get(targetUrl.hostname) === false) {
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
        if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
        else upstream = await get(targetUrl.toString(), headers, null, 15000);
      } else {
        const known_direct = directOk.get(targetUrl.hostname) === true;
        try { upstream = await get(targetUrl.toString(), headers, null, known_direct ? 15000 : 4500); }
        catch { upstream = null; }
        if (upstream && upstream.ok) {
          directOk.set(targetUrl.hostname, true);
        } else {
          if (upstream && [403, 451, 452, 475].includes(upstream.status)) directOk.set(targetUrl.hostname, false);
          const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
          if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
          else if (!upstream) upstream = await get(targetUrl.toString(), headers, null, 15000);
        }
      }
    } else {
      upstream = await get(targetUrl.toString(), headers, null, 15000);
      /* 451, 452 and 475 are never about the link: they are an Akamai or
         Fastly edge refusing this network after the token already passed. A
         host that says so is sent to the pool like the listed ones, and
         remembered, so the next request goes there without asking twice. */
      if ([451, 452, 475].includes(upstream.status)) {
        directOk.set(targetUrl.hostname, false);
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
        if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
      }
    }
  } catch (e) {
    return res.status(502).send('Upstream failed: ' + e.message);
  }

  if (usedProxy) res.setHeader('X-Proxy-Via', usedProxy);

  /* A refusal is not a playlist, whatever the path says. Rewriting an HTML
     error page as one turns each of its lines into a proxy URL, and the player
     then gets a 200-looking manifest of nonsense instead of the reason. */
  if (!upstream.ok) {
    const body = await upstream.text();
    res.setHeader('X-Proxy-Upstream', String(upstream.status));
    return res.status(upstream.status).send(body.slice(0, 2000));
  }

  const ct = upstream.headers.get('content-type') || '';
  const lower = targetUrl.pathname.toLowerCase();
  const isPlaylist = lower.endsWith('.m3u8') || ct.includes('mpegurl');
  const isDash = lower.endsWith('.mpd') || ct.includes('dash+xml');

  /* A DASH manifest is not rewritten line by line — its segment names live in
     templates, not as URLs — so the player resolves them against wherever it
     fetched the manifest from, which is this proxy. Left alone it then asks
     the proxy for paths on the proxy's own domain.
   
     Giving the manifest an absolute BaseURL pointing back at the real
     directory fixes that at the source: every segment resolves to a real
     Hotstar URL, and the player's request filter wraps each one on its way
     out. A manifest that already declares an absolute BaseURL is left alone —
     it has already said where its segments live. */
  if (isDash) {
    let xml = await upstream.text();
    const dir = targetUrl.href.slice(0, targetUrl.href.lastIndexOf('/') + 1);
    if (!/<BaseURL>\s*https?:/i.test(xml)) {
      xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${dir}</BaseURL>`);
    }
    res.setHeader('Content-Type', 'application/dash+xml');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(xml);
  }

  if (isPlaylist) {
    const text = await upstream.text();
    const base = `https://${req.headers.host}/api/live-proxy`;
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref ? '&ref=' + encodeURIComponent(ref) : '') +
      (ua ? '&ua=' + encodeURIComponent(ua) : '') +
      (usedProxy ? '&via=' + encodeURIComponent(usedProxy) : '');

    /* A child with no query of its own inherits the parent's. FanCode and
       SonyLiv sign in the query with an acl covering the folder, and resolving
       a relative reference drops it — without this the master plays and every
       variant comes back 403. */
    const parentQuery = targetUrl.search;
    const toAbs = (r) => {
      const u = new URL(r, targetUrl);
      if (!u.search && parentQuery) u.search = parentQuery;
      return u.toString();
    };
    const wrap = (abs) => base + '?url=' + encodeURIComponent(abs) + extras;

    const body = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      return wrap(toAbs(t));
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(body);
  }

  /* Segments and keys: hand the bytes back with CORS added. A public proxy
     can die after sending headers, which throws here — that used to crash
     the function into a bare 500. The segment is fetched once more through
     another proxy instead, so the player sees a slow segment, not a failed one. */
  let bytes;
  try { bytes = Buffer.from(await upstream.arrayBuffer()); }
  catch (e) {
    if (!usedProxy) return res.status(502).send('Upstream dropped: ' + e.message);
    if (known.get(targetUrl.hostname) === usedProxy) known.delete(targetUrl.hostname);
    try {
      const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname, usedProxy);
      if (!hit) return res.status(502).send('Upstream dropped: ' + e.message);
      upstream = hit.res;
      bytes = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('X-Proxy-Via', hit.proxy);
    } catch (e2) {
      return res.status(502).send('Upstream dropped: ' + e2.message);
    }
  }
  res.setHeader('Content-Type', ct || 'application/octet-stream');
  res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'no-cache');
  for (const h of ['content-range', 'accept-ranges']) { const v = upstream.headers.get(h); if (v) res.setHeader(h, v); }
  return res.status(upstream.status === 206 ? 206 : 200).send(bytes);
}
