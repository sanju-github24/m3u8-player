/**
 * Combined Cloudflare Worker for player.html
 *
 *   1. Channel feed   →  GET https://YOUR-WORKER.workers.dev/
 *                        (no ?url= param) — fetches + normalizes the JioTV feed.
 *
 *   2. HLS CORS proxy →  GET https://YOUR-WORKER.workers.dev/?url=<ENCODED_STREAM_URL>
 *                        Fetches the stream server-side, adds CORS, and rewrites
 *                        .m3u8 playlists so segments route back through the proxy.
 *                        This is what makes CORS-less CDNs (FanCode) play in hls.js.
 *
 * Point both NEW_JSON_URL and HLS_CORS_PROXY in player.html at this one worker.
 */

/* The feed, in preference order.
 *
 *   jtv.json is a scraper that republishes the whole JioTV line-up (~1,170
 *   channels) with a fresh Akamai token every run. It is the source of truth.
 *   jtv-plus is what this worker used to read; it survives only as a fallback
 *   for the minutes when raw.githubusercontent is unreachable, and it carries
 *   a tenth of the channels.
 *
 * Both are read live on every request — no edge cache, see fetchFresh — so a
 * page refresh in the player always gets the newest tokens. That matters:
 * the tokens these feeds carry expire in hours, and a cached copy is a copy
 * of dead links. */
const JTV_JSON   = 'https://raw.githubusercontent.com/sportlive18/jio-tv-auto-update-playlist/refs/heads/main/jtv.json';
const JTV_PLUS   = 'https://jtv-plus.jijenoh451.workers.dev/stream/data.json';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    const reqUrl = new URL(request.url);

    // Route: ?url= present → HLS proxy; otherwise → channel feed.
    if (reqUrl.searchParams.has('url')) {
      return handleProxy(reqUrl);
    }
    return handleFeed();
  },
};

// ────────────────────────────────────────────────────────────
// 1. CHANNEL FEED
// ────────────────────────────────────────────────────────────

/* Neither Cloudflare's edge cache nor GitHub's CDN may answer this: a cached
   channel list is a list of expired tokens. cacheTtl 0 turns off the edge
   cache, and the cache-buster defeats raw.githubusercontent's own. */
function fetchFresh(url, headers) {
  const bust = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
  return fetch(bust, {
    headers,
    cache: 'no-store',
    cf: { cacheTtl: 0, cacheEverything: false },
  });
}

const BROWSERISH = {
  'accept':             '*/*',
  'accept-language':    'en-GB,en;q=0.6',
  'origin':             'https://binge-jiotv.pages.dev',
  'referer':            'https://binge-jiotv.pages.dev/',
  'sec-fetch-dest':     'empty',
  'sec-fetch-mode':     'cors',
  'sec-fetch-site':     'cross-site',
  'sec-ch-ua':          '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  'sec-ch-ua-mobile':   '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-gpc':            '1',
  'user-agent':         'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
  'priority':           'u=1, i',
};

async function handleFeed() {
  const errors = [];

  for (const [name, url, headers] of [
    ['jtv.json',  JTV_JSON, { 'accept': 'application/json', 'user-agent': 'player.html/1.0' }],
    ['jtv-plus',  JTV_PLUS, BROWSERISH],
  ]) {
    try {
      const res  = await fetchFresh(url, headers);
      const text = await res.text();

      // An HTML body means a block page or a 404, not a feed.
      if (!res.ok || text.trim().startsWith('<') || text.includes('telegram')) {
        errors.push(`${name}: HTTP ${res.status}, ${text.slice(0, 120)}`);
        continue;
      }

      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed)
        ? parsed
        : (parsed.channels || Object.values(parsed));

      const normalized = rows.map(normalize).filter(ch => ch.channel_id && ch.channel_url);
      if (!normalized.length) { errors.push(`${name}: parsed 0 channels`); continue; }

      return json(normalized, 200, { 'X-Feed-Source': name });
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  return json({ error: 'no_feed', tried: errors }, 502);
}

/* Both feeds into the one shape player.html reads.
 *
 * Where the row has a `cookie`, the URL is stripped back to its path. Some
 * rows arrive with an `__hdnea__` token already baked into the query string,
 * and those inline tokens are the short-lived kind — about an hour, so usually
 * already dead by the time anyone clicks. The `cookie` field holds the
 * long-lived one, and the player's Shaka request filter appends it to every
 * segment request. Handing the player a bare path lets that happen; leaving
 * the stale token on would make the filter skip the row — it only adds a
 * token where there isn't one — and the CDN would answer 403.
 *
 * Where there is no cookie, the inline token is all the row has, so it stays.
 * It will still expire within the hour, but a token that might work beats a
 * bare URL that certainly will not. */
function normalize(ch) {
  let url = ch.channel_url || ch.url || '';
  const cookie = ch.cookie || '';
  const q = url.indexOf('?');
  if (q !== -1 && cookie) url = url.slice(0, q);

  return {
    channel_id:   String(ch.channel_id || ch.id || ''),
    channel_name: ch.channel_name || ch.name || 'Unknown Channel',
    channel_logo: ch.channel_logo || ch.logo || '',
    channel_url:  url,
    channel_group: ch.group || ch.channel_group || '',
    keyId:        ch.keyId  || '',
    key:          ch.key    || '',
    cookie,
    expire_time:  ch.expire_time || '0',
  };
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(),
      ...extra,
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

// ────────────────────────────────────────────────────────────
// 2. HLS CORS PROXY
// ────────────────────────────────────────────────────────────
async function handleProxy(reqUrl) {
  const target = reqUrl.searchParams.get('url');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('Invalid url', { status: 400, headers: cors() });
  }

  const upstream = await fetch(targetUrl.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Referer': targetUrl.origin + '/',
      'Origin':  targetUrl.origin,
      'Accept':  '*/*',
    },
  });

  const contentType = upstream.headers.get('content-type') || '';
  const path = targetUrl.pathname.toLowerCase();
  const isPlaylist =
    path.endsWith('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('vnd.apple.mpegurl');

  const proxyBase = reqUrl.origin + reqUrl.pathname; // e.g. https://worker.dev/

  if (isPlaylist) {
    const text = await upstream.text();
    const rewritten = rewritePlaylist(text, targetUrl, proxyBase);
    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        ...cors(),
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      },
    });
  }

  // Segments / keys / anything else: stream bytes straight through with CORS added.
  const headers = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(cors())) headers.set(k, v);
  headers.delete('content-security-policy');
  return new Response(upstream.body, { status: upstream.status, headers });
}

function rewritePlaylist(text, baseUrl, proxyBase) {
  const wrap  = (absUrl) => proxyBase + '?url=' + encodeURIComponent(absUrl);
  const toAbs = (ref) => new URL(ref, baseUrl).toString();

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${wrap(toAbs(uri))}"`);
      }
      return wrap(toAbs(trimmed));
    })
    .join('\n');
}

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}
