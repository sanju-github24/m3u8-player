/**
 * Combined Cloudflare Worker:
 *
 *   1. Channel feed   →  GET https://YOUR-WORKER.workers.dev/
 *                        (no ?url= param)  — fetches + normalizes the JioTV feed.
 *
 *   2. HLS CORS proxy →  GET https://YOUR-WORKER.workers.dev/?url=<ENCODED_STREAM_URL>
 *                        Fetches the stream server-side, adds CORS, and rewrites
 *                        .m3u8 playlists so segments route back through the proxy.
 *                        This is what makes CORS-less CDNs (FanCode) play in hls.js.
 *
 * Point both NEW_JSON_URL and HLS_CORS_PROXY in player.html at this one worker.
 */

const TARGET = 'https://jtv-plus.jijenoh451.workers.dev/stream/data.json';

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
async function handleFeed() {
  try {
    const res = await fetch(TARGET, {
      headers: {
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
      },
    });

    const text = await res.text();

    // Catch edge network drops or strict browser blocks early
    if (text.includes('telegram') || text.trim().startsWith('<')) {
      return new Response(
        JSON.stringify({ error: 'still_blocked', raw: text.slice(0, 200) }),
        { status: 502, headers: { ...cors(), 'Content-Type': 'application/json' } }
      );
    }

    try {
      const parsed = JSON.parse(text);
      const channelsArray = Array.isArray(parsed) ? parsed : (parsed.channels || []);

      const normalized = channelsArray.map(ch => {
        let baseMpdUrl = ch.channel_url || ch.url || '';
        if (baseMpdUrl.includes('?')) baseMpdUrl = baseMpdUrl.split('?')[0];

        return {
          channel_id:   ch.channel_id   || ch.id || '',
          channel_name: ch.channel_name || ch.name || 'Unknown Channel',
          channel_logo: ch.channel_logo || ch.logo || '',
          channel_url:  baseMpdUrl,
          keyId:        ch.keyId        || '',
          key:          ch.key          || '',
          cookie:       ch.cookie       || ch['user-agent'] || '',
          expire_time:  ch.expire_time  || '0',
        };
      });

      return new Response(JSON.stringify(normalized), {
        status: 200,
        headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch (parseError) {
      return new Response(text, {
        status: res.status,
        headers: { ...cors(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...cors(), 'Content-Type': 'application/json' } }
    );
  }
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
