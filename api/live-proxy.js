/* A stream proxy that runs in Mumbai.
 *
 * The live sport CDNs refuse requests from outside India, and the Cloudflare
 * worker cannot help: Cloudflare picks the colo nearest the viewer, which for
 * this project has meant Singapore, and Singapore is refused like everywhere
 * else. Measured against four CDN hosts:
 *
 *     Indian ISP / residential     FanCode 200   SonyLiv 200   Hotstar 200
 *     Indian datacenter (any)      FanCode 200   SonyLiv 403   Hotstar 403
 *     outside India (any)          FanCode 403   SonyLiv 403   Hotstar 403
 *
 * So this fixes FanCode and nothing else — that block is purely geographic,
 * and Vercel's bom1 region is in India. SonyLiv and Hotstar additionally
 * refuse datacenter networks, and no hosted proxy of any kind gets past that;
 * they need a residential address, which means a proxy on a home connection.
 * Tested on five providers (DigitalOcean, Google Cloud, Oracle, Azure and
 * one more) with no exceptions.
 *
 * The region is pinned in vercel.json. Deployed anywhere else this file is
 * useless, so check that first if FanCode starts returning 403.
 *
 *   GET /api/live-proxy?url=<encoded>[&cookie=][&ref=][&ua=]
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Only these hosts, so the function cannot be used as an open relay for
   anything on the internet. Add a suffix here to cover another CDN. */
const ALLOWED = [
  'fancode.com',
  'akamaized.net',
  'hotstar.com',
  'jio.com',
];

function allowed(hostname) {
  return ALLOWED.some(s => hostname === s || hostname.endsWith('.' + s));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { url: target, cookie = '', ref = '', ua = '' } = req.query;
  if (!target) return res.status(400).send('Missing ?url=');

  let targetUrl;
  try { targetUrl = new URL(target); } catch { return res.status(400).send('Invalid url'); }
  if (!allowed(targetUrl.hostname)) return res.status(403).send('Host not allowed');

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep the target's */ } }

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent': ua || DEFAULT_UA,
        'Referer': ref || targetUrl.origin + '/',
        'Origin': refOrigin,
        'Accept': '*/*',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
  } catch (e) {
    return res.status(502).send('Upstream failed: ' + e.message);
  }

  /* A refusal is not a playlist, whatever the path says. Rewriting an HTML
     error page as one turns each of its lines into a proxy URL, and the
     player then gets a 200-looking manifest of nonsense instead of the
     reason it failed. */
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
      (ua ? '&ua=' + encodeURIComponent(ua) : '');

    /* A child with no query of its own inherits the parent's. FanCode and
       SonyLiv both sign in the query with an acl covering the whole folder,
       and resolving a relative reference drops it — so without this the
       master plays and every variant comes back 403. */
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
  const buf = Buffer.from(await upstream.arrayBuffer());
  return res.status(200).send(buf);
}
