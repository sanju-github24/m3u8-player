#!/usr/bin/env node
/**
 * FanCode LOCAL CORS proxy — the only way to play FanCode in DESKTOP browsers.
 *
 * Why local: FanCode's CDN (in-mc-flive.fancode.com) sends no CORS headers AND
 * blocks datacenter IPs (Cloudflare/Vercel/AWS all get 403). It only accepts a
 * residential Indian IP. Your own PC has one — a cloud worker does not. So this
 * proxy must run on YOUR machine, on your home connection.
 *
 * What it does:
 *   GET http://localhost:8787/proxy?url=<ENCODED_FANCODE_URL>
 *   - fetches server-side with FanCode's app headers (no browser CORS)
 *   - rewrites .m3u8 playlists so every variant / segment / key also routes
 *     back through this proxy (so the browser never touches FanCode directly)
 *   - adds Access-Control-Allow-Origin: *
 *
 * Run:  node fancode-local-proxy.js       (needs Node 18+ for global fetch)
 * Then in the player set LOCAL_PROXY to  http://localhost:8787/proxy
 *
 * Note: http://localhost is exempt from mixed-content blocking, so an https
 * page (e.g. your Vercel site) can still call it.
 */
const http = require('http');

const PORT = process.env.PORT || 8787;

// Headers FanCode's edge expects (its Android app identity).
const FANCODE_HEADERS = {
  'User-Agent': 'ReactNativeVideo/9.7.0 (Linux;Android 10) AndroidXMedia3/1.6.1',
  'Referer': 'https://fancode.com/',
  'Origin': 'https://fancode.com',
  'Accept': '*/*',
};

/* Not every upstream wants FanCode's identity.

   The Jio Hotstar entries in the sportlive18 playlist — Star Sports 1/2/3
   Digital and the rest — are served by livetv.hotstar.com, which answers 403
   to anything that does not present Hotstar's own User-Agent, Referer, Origin
   and an hdntl cookie. Those four are exactly the headers a browser refuses to
   let a page set on a cross-origin request, which is why those channels cannot
   play without a proxy no matter what the player does.

   Conveniently the playlist puts them in the URL's own query string
   (?user-agent=&referer=&origin=&cookie=), so the right headers can be read
   off the target rather than guessed per host. */
function upstreamHeaders(target) {
  const h = { Accept: '*/*' };
  let u;
  try { u = new URL(target); } catch { return { ...FANCODE_HEADERS }; }

  const q = u.searchParams;
  const ua = q.get('user-agent');
  const rf = q.get('referer');
  const og = q.get('origin');
  const ck = q.get('cookie');

  if (ua) h['User-Agent'] = ua;
  if (rf) h['Referer'] = rf;
  if (og) h['Origin'] = og;
  if (ck) h['Cookie'] = ck;

  // Hotstar segments inherit the manifest's identity even when the segment URL
  // carries no params of its own.
  if (!ua && /hotstar\.com$/i.test(u.hostname.replace(/^.*\./, 'hotstar.com'))) {
    h['User-Agent'] = 'Virat Kohli';
    h['Referer'] = 'https://www.hotstar.com/';
    h['Origin'] = 'https://www.hotstar.com';
  }

  // Anything that told us nothing falls back to FanCode's identity, which is
  // what this proxy was written for.
  return Object.keys(h).length > 1 ? h : { ...FANCODE_HEADERS };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const PROXY_PATH = '/proxy';

function selfBase(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  return `http://${host}${PROXY_PATH}`;
}

function rewritePlaylist(text, baseUrl, proxyBase) {
  const wrap = (abs) => proxyBase + '?url=' + encodeURIComponent(abs);

  /* A child with no query of its own inherits the parent's. SonyLiv signs in
     the query (?hdnea=, acl=/*), and resolving a relative reference drops it,
     so without this the master plays and every variant returns 403. */
  const parentQuery = baseUrl.search;
  const toAbs = (ref) => {
    const u = new URL(ref, baseUrl);
    if (!u.search && parentQuery) u.search = parentQuery;
    return u.toString();
  };
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      }
      return wrap(toAbs(t));
    })
    .join('\n');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (reqUrl.pathname !== PROXY_PATH) {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('FanCode local proxy running. Use ' + PROXY_PATH + '?url=<encoded stream url>');
  }

  const target = reqUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, CORS);
    return res.end('Missing ?url=');
  }

  let targetUrl;
  try { targetUrl = new URL(target); } catch {
    res.writeHead(400, CORS);
    return res.end('Invalid url');
  }

  try {
    const upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders(target) });
    const ct = upstream.headers.get('content-type') || '';
    const isPlaylist =
      targetUrl.pathname.toLowerCase().endsWith('.m3u8') ||
      ct.includes('mpegurl');

    if (isPlaylist) {
      const text = await upstream.text();
      const body = rewritePlaylist(text, targetUrl, selfBase(req));
      res.writeHead(upstream.status, {
        ...CORS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      });
      return res.end(body);
    }

    // Segments / keys — stream bytes through.
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      ...CORS,
      'Content-Type': ct || 'application/octet-stream',
    });
    return res.end(buf);
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('Upstream fetch failed: ' + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`FanCode local proxy → http://localhost:${PORT}${PROXY_PATH}?url=<encoded>`);
  console.log('Keep this running while you watch. Ctrl+C to stop.');
});
