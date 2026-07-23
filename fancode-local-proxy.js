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
const UPSTREAM_HEADERS = {
  'User-Agent': 'ReactNativeVideo/9.7.0 (Linux;Android 10) AndroidXMedia3/1.6.1',
  'Referer': 'https://fancode.com/',
  'Origin': 'https://fancode.com',
  'Accept': '*/*',
};

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
  const toAbs = (ref) => new URL(ref, baseUrl).toString();
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
    const upstream = await fetch(targetUrl.toString(), { headers: UPSTREAM_HEADERS });
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
