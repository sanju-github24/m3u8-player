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
const ALLOWED = ['fancode.com', 'akamaized.net', 'hotstar.com', 'jio.com'];

/* Hosts that want an address no datacenter has. Everything else is served
   straight from Mumbai, which is faster and does not depend on a stranger. */
const NEEDS_RESIDENTIAL = [
  'sonydaimenew.akamaized.net',
  'live09p.hotstar.com',
  'hotstar.com',
];

const PROXY_LIST =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

// ── the proxy pool ───────────────────────────────────────────
/* Kept on the module, which on a warm instance survives between requests.
   A cold start pays for the list again; that is one small fetch. */
let pool = { list: [], at: 0 };
let known = new Map();          // hostname -> proxy that last worked for it

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
async function findProxy(url, headers, hostname) {
  const list = await proxyList();
  if (!list.length) return null;

  const remembered = known.get(hostname);
  const ordered = remembered ? [remembered, ...list.filter(p => p !== remembered)] : list;

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
  };

  let upstream, usedProxy = '';
  try {
    if (via) {
      /* A playlist names the proxy that fetched it, so its segments go the
         same way instead of each one searching the pool again. */
      usedProxy = via;
      upstream = await get(targetUrl.toString(), headers, via, 15000);
      if (!upstream.ok && needsResidential(targetUrl.hostname)) {
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
        if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
      }
    } else if (needsResidential(targetUrl.hostname)) {
      const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
      if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
      else upstream = await get(targetUrl.toString(), headers, null, 15000);
    } else {
      upstream = await get(targetUrl.toString(), headers, null, 15000);
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
  const isPlaylist =
    targetUrl.pathname.toLowerCase().endsWith('.m3u8') || ct.includes('mpegurl');

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

  // Segments and keys: hand the bytes back with CORS added.
  res.setHeader('Content-Type', ct || 'application/octet-stream');
  res.setHeader('Cache-Control', upstream.headers.get('cache-control') || 'no-cache');
  return res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
}
