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
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    const reqUrl = new URL(request.url);

    // Route: ?url= → HLS proxy, ?feed=sonyliv → the SonyLiv fixtures,
    // otherwise the JioTV channel feed.
    if (reqUrl.searchParams.has('url')) {
      return handleProxy(reqUrl);
    }
    if (reqUrl.searchParams.get('feed') === 'sonyliv') {
      return handleSonyFeed();
    }
    if (reqUrl.searchParams.get('feed') === 'fancode') {
      return handleFancodeFeed();
    }
    return handleFeed(env);
  },

  /* Hourly cron (see SETUP at the foot of this file).
     This does not serve anything — requests always go to the live feed — it
     just keeps the KV snapshot warm so the fallback is an hour old at worst
     rather than however long ago someone last loaded the page. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshSnapshot(env));
  },
};

// ────────────────────────────────────────────────────────────
// 1. CHANNEL FEED
// ────────────────────────────────────────────────────────────

/* Neither Cloudflare's edge cache nor GitHub's CDN may answer this: a cached
   channel list is a list of expired tokens. `cache: no-store` turns off the
   edge cache, and the cache-buster defeats raw.githubusercontent's own.
   Note the two cannot be combined — pairing no-store with a cf.cacheTtl is a
   runtime error ("CacheTtl: 0, is not compatible with cache: no-store"), so
   this says it once. */
function fetchFresh(url, headers) {
  const bust = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
  return fetch(bust, { headers, cache: 'no-store' });
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

const SOURCES = [
  ['jtv.json', JTV_JSON, { 'accept': 'application/json', 'user-agent': 'player.html/1.0' }],
  ['jtv-plus', JTV_PLUS, BROWSERISH],
];

/* One source, fetched and normalized. Throws rather than returning junk, so
   the caller can move to the next source. */
async function loadSource(name, url, headers) {
  const res  = await fetchFresh(url, headers);
  const text = await res.text();

  // An HTML body means a block page or a 404, not a feed.
  if (!res.ok || text.trim().startsWith('<') || text.includes('telegram')) {
    throw new Error(`HTTP ${res.status}, ${text.slice(0, 120)}`);
  }

  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : (parsed.channels || Object.values(parsed));

  const normalized = rows.map(normalize).filter(ch => ch.channel_id && ch.channel_url);
  if (!normalized.length) throw new Error('parsed 0 channels');
  return normalized;
}

async function handleFeed(env) {
  const errors = [];

  for (const [name, url, headers] of SOURCES) {
    try {
      const channels = await loadSource(name, url, headers);
      // Every success doubles as a snapshot refresh, so the fallback stays
      // current between cron runs without costing the request anything.
      saveSnapshot(env, channels);
      return json(channels, 200, { 'X-Feed-Source': name });
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  /* Both upstreams are down. The snapshot is stale by definition — that is
     why it is last — but a channel list with some live tokens in it beats a
     502, and the header says how old it is so the player could warn. */
  const snap = await readSnapshot(env);
  if (snap) {
    return json(snap.channels, 200, {
      'X-Feed-Source': 'snapshot',
      'X-Snapshot-Age-Seconds': String(Math.round((Date.now() - snap.at) / 1000)),
    });
  }

  return json({ error: 'no_feed', tried: errors }, 502);
}

// ── Warm fallback, kept in KV ────────────────────────────────
// Optional: with no KV binding these are no-ops and the worker behaves
// exactly as it did before, live-only.
const SNAPSHOT_KEY = 'feed-snapshot';

function saveSnapshot(env, channels) {
  if (!env || !env.JTV_CACHE) return;
  // Not awaited on the request path; a failed write must not fail the response.
  env.JTV_CACHE.put(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), channels }))
    .catch(() => {});
}

async function readSnapshot(env) {
  if (!env || !env.JTV_CACHE) return null;
  try {
    const raw = await env.JTV_CACHE.get(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function refreshSnapshot(env) {
  for (const [name, url, headers] of SOURCES) {
    try {
      const channels = await loadSource(name, url, headers);
      if (env && env.JTV_CACHE) {
        await env.JTV_CACHE.put(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), channels }));
      }
      return;
    } catch { /* try the next source */ }
  }
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
 * Where there is no cookie, the token in the query string is promoted into
 * the cookie field and taken off the URL. It is the same token either way, but
 * where it sits decides whether anything plays: in the URL it signs the
 * manifest request and nothing else, and a DASH manifest names its segments
 * relative to itself, so every .m4s then goes out unsigned and Akamai answers
 * 403 — the manifest loads and the picture never starts. In the cookie field
 * the player's request filter puts it on every request, segments included.
 * These tokens are scoped to the channel's own directory (acl=/bpk-tv/<ch>/*),
 * which covers exactly those segments.
 *
 * This is what the Star Sports channels need: all 23 of them arrive this way,
 * with a live token that only ever reached the manifest. */
function normalize(ch) {
  let url = ch.channel_url || ch.url || '';
  let cookie = ch.cookie || '';

  const q = url.indexOf('?');
  if (q !== -1) {
    if (!cookie) {
      const inline = new URLSearchParams(url.slice(q + 1)).get('__hdnea__');
      if (inline) cookie = '__hdnea__=' + inline;
    }
    // Only drop the query once something can sign the segments in its place.
    if (cookie) url = url.slice(0, q);
  }

  return {
    channel_id:   String(ch.channel_id || ch.id || ''),
    channel_name: ch.channel_name || ch.name || 'Unknown Channel',
    channel_logo: ch.channel_logo || ch.logo || '',
    channel_url:  url,
    channel_group: ch.group || ch.channel_group || '',
    keyId:        ch.keyId  || '',
    key:          ch.key    || '',
    cookie,
    // Read off the token rather than trusted from the feed, which sends "0".
    // Lets the player tell "this channel's token died" from "this channel is
    // broken" — the two look identical from a 403.
    expire_time:  tokenExpiry(cookie) || ch.expire_time || '0',
  };
}

/* Unix seconds an __hdnea__ token stops being accepted, as a string. */
function tokenExpiry(cookie) {
  const m = /[~&?]exp=(\d+)/.exec(cookie || '');
  return m ? m[1] : '';
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

  /* Optional caller-supplied headers, for CDNs that want more than CORS.
     Hotstar's live09p is the case this exists for: it answers 403 unless
     Cookie, Referer and Origin all arrive together — measured, one or two of
     the three is not enough. A browser cannot set any of them on a
     cross-origin request (they are forbidden header names), which is the whole
     reason those streams need a proxy rather than just a CORS shim. */
  const cookie = reqUrl.searchParams.get('cookie') || '';
  const ref    = reqUrl.searchParams.get('ref')    || '';
  const ua     = reqUrl.searchParams.get('ua')     || '';

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep target's */ } }

  const upstream = await fetch(targetUrl.toString(), {
    headers: {
      'User-Agent': ua ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Referer': ref || targetUrl.origin + '/',
      'Origin':  refOrigin,
      'Accept':  '*/*',
      ...(cookie ? { 'Cookie': cookie } : {}),
    },
  });

  const contentType = upstream.headers.get('content-type') || '';
  const path = targetUrl.pathname.toLowerCase();
  const isPlaylist =
    path.endsWith('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('vnd.apple.mpegurl');

  const proxyBase = reqUrl.origin + reqUrl.pathname; // e.g. https://worker.dev/

  /* A refusal is not a playlist, whatever the path says. Akamai answers a
     denied .m3u8 with an HTML error page, and rewriting that as a playlist
     turned every one of its lines into a proxy URL — the player then got a
     200-looking manifest full of nonsense instead of the actual reason. Hand
     the failure back as it came. */
  if (!upstream.ok) {
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors(), 'Content-Type': 'text/plain', 'X-Proxy-Upstream': String(upstream.status) },
    });
  }

  if (isPlaylist) {
    const text = await upstream.text();
    /* The same headers have to ride along on every segment, not just the
       playlist — the CDN checks each request, and a signed playlist whose
       segments arrive bare is exactly how a stream loads and then stalls. */
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref    ? '&ref='    + encodeURIComponent(ref)    : '') +
      (ua     ? '&ua='     + encodeURIComponent(ua)     : '');
    const rewritten = rewritePlaylist(text, targetUrl, proxyBase, extras);
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

function rewritePlaylist(text, baseUrl, proxyBase, extras = '') {
  const wrap  = (absUrl) => proxyBase + '?url=' + encodeURIComponent(absUrl) + extras;

  /* A child URL with no query of its own inherits the parent's.

     SonyLiv signs with ?hdnea= in the query and an acl of /*, so every variant
     and segment needs the token too — but a playlist names them relatively,
     and resolving a relative reference throws the query away. Left alone the
     master loads and each variant comes back 403. Children that carry their
     own query are left as they are; they were signed separately. */
  const parentQuery = baseUrl.search;
  const toAbs = (ref) => {
    const u = new URL(ref, baseUrl);
    if (!u.search && parentQuery) u.search = parentQuery;
    return u.toString();
  };

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

// ────────────────────────────────────────────────────────────
// 3. SONYLIV FIXTURES
// ────────────────────────────────────────────────────────────
/* Live sport on SonyLiv, republished with a signed URL per fixture. Read
   through here rather than from the browser for the same reason as the
   channel feed: one place decides what is fresh, and the shape the player
   reads stays this file's business. */
const SONY_JSON = 'https://raw.githubusercontent.com/sportlive18/Sonyliv-Playlist-Autoupdate/refs/heads/main/sonyliv.json';

async function handleSonyFeed() {
  try {
    const res  = await fetchFresh(SONY_JSON, { 'accept': 'application/json', 'user-agent': 'player.html/1.0' });
    const text = await res.text();
    if (!res.ok || text.trim().startsWith('<')) {
      return json({ error: 'sony_feed', detail: `HTTP ${res.status}` }, 502);
    }

    const parsed  = JSON.parse(text);
    const matches = parsed.matches || [];

    /* Only the fixtures that are on air and have a stream. The feed also
       carries promos for things weeks away, with no URL — a card that cannot
       play is worse than no card. */
    const live = matches
      .filter(m => m.isLive && (m.video_url || m.pub_url || m.dai_url))
      .map(m => ({
        id:       String(m.contentId || ''),
        name:     m.match_name || m.event_name || 'Live',
        event:    m.event_name || '',
        category: m.event_category || 'Sports',
        channel:  m.broadcast_channel || '',
        lang:     m.audioLanguageName || '',
        logo:     m.src || '',
        url:      m.video_url || m.pub_url || m.dai_url,
      }));

    return json(live, 200, {
      'X-Feed-Source': 'sonyliv.json',
      'X-Feed-Updated': String(parsed['last update time'] || ''),
    });
  } catch (e) {
    return json({ error: 'sony_feed', detail: e.message }, 502);
  }
}

// ────────────────────────────────────────────────────────────
// 4. FANCODE FIXTURES
// ────────────────────────────────────────────────────────────
/* Live sport on FanCode. Two publishers put this out in two different shapes
   and both are read here, because which one is up varies by the day:

     sportlive18  — dai_url / adfree_url on the row, team names, a thumbnail
     zyphx8       — auto_streams[0].auto, a map of quality to URL

   Normalizing both means swapping the source later is one line, not a rewrite
   of the player. */
const FANCODE_SOURCES = [
  'https://raw.githubusercontent.com/sportlive18/Fancode-New-Auto-Update/refs/heads/main/fancode.json',
  'https://raw.githubusercontent.com/doctor-8trange/zyphx8/refs/heads/main/data/fancode.json',
];

async function handleFancodeFeed() {
  const errors = [];

  for (const url of FANCODE_SOURCES) {
    try {
      const res  = await fetchFresh(url, { 'accept': 'application/json', 'user-agent': 'player.html/1.0' });
      const text = await res.text();
      if (!res.ok || text.trim().startsWith('<')) { errors.push(`HTTP ${res.status}`); continue; }

      const parsed  = JSON.parse(text);
      const matches = parsed.matches || parsed.data || (Array.isArray(parsed) ? parsed : []);

      const live = matches
        .filter(m => String(m.status || '').toUpperCase() === 'LIVE')
        .map(normalizeFancode)
        .filter(m => m && m.url);

      if (!live.length) { errors.push('no live fixtures'); continue; }
      return json(live, 200, {
        'X-Feed-Source': 'fancode',
        'X-Feed-Updated': String(parsed['last update time'] || parsed.last_updated || ''),
      });
    } catch (e) {
      errors.push(e.message);
    }
  }

  return json({ error: 'fancode_feed', tried: errors }, 502);
}

function normalizeFancode(m) {
  /* sportlive18 hands over a playable URL directly. zyphx8 nests a map of
     quality to URL, so pick the highest one it offers. */
  let url = m.adfree_url || m.dai_url || '';
  if (!url && m.auto_streams && m.auto_streams[0]) {
    const auto = m.auto_streams[0].auto || {};
    const best = ['1080p5', '1080p', '720p', '540p', '480p', '360p', '240p'].find(q => auto[q]);
    url = best ? auto[best] : (typeof auto === 'string' ? auto : '');
  }
  if (!url) return null;

  const teams = [m.team_1, m.team_2].filter(Boolean).join(' vs ');
  return {
    id:       String(m.match_id || m.id || ''),
    name:     m.match_name || teams || m.title || m.short_name || 'Live',
    event:    m.event_name || m.title || '',
    category: m.event_category || m.category || 'Sports',
    lang:     m.language || '',
    start:    m.startTime || m.startDate || '',
    logo:     m.src || m.image || (m.image_cdn && (m.image_cdn.LOGO || m.image_cdn.APP)) || '',
    ua:       m['user-agent'] || '',
    url,
  };
}

/* ────────────────────────────────────────────────────────────
   SETUP — the hourly refresh

   Requests always go to the live feed, so the player already gets the newest
   tokens on every page load. The hourly job exists only to keep a fallback
   warm for the times raw.githubusercontent is unreachable.

   Deliberately NOT an hourly cache: the tokens on the jiotvpllive channels
   (Star Sports among them) last about an hour, so an hour-old cache is a
   cache of dead links. Stale data is the last resort here, never the default.

   Both steps are optional — with neither, the worker runs live-only, exactly
   as it does today.

   1. Cron trigger:  Worker → Settings → Triggers → Cron Triggers → Add
                     0 * * * *          (top of every hour)

   2. KV namespace:  Storage & Databases → KV → Create (any name)
                     Worker → Settings → Bindings → Add → KV namespace
                     Variable name:  JTV_CACHE      ← must match exactly

   Check which path answered with the response headers:
     X-Feed-Source: jtv.json | jtv-plus | snapshot
     X-Snapshot-Age-Seconds: <n>   (only when serving the fallback)
   ──────────────────────────────────────────────────────────── */
