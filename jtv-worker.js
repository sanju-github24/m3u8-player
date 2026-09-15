// ────────────────────────────────────────────────────────────
// 5. WILLOW CRICKET
// ────────────────────────────────────────────────────────────
/* Willow's cricket, with playable DASH streams and a ClearKey pair per
 * fixture — the same shape as Prime's rows.
 *
 * The schedule-only feed that used to sit here carried no streams: every
 * url was empty, so nothing played and nothing could. This feed carries
 * them. Every URL is .mpd under ClearKey, so they go to Shaka.
 *
 * The feed lists a map of CDN names to URLs. They are ordered so the one
 * host a browser can reach directly comes first, and the rest follow for
 * the player to fall back through the proxy. Measured: dash-ott accepts a
 * foreign Origin; ss-ott does not. */
const WILLOW_JSON =
  'https://raw.githubusercontent.com/srhady/willow-event/refs/heads/main/live_sports.json';

/* Most-usable first. Names come from the feed verbatim. Anything the feed
   adds later still gets through, just ordered last. */
const WILLOW_SERVER_ORDER = [
  'Cloudfront Server 2',   // dash-ott — the only host a browser can fetch unaided
  'Cloudfront Server 1',   // ss-ott — needs the proxy
  'Amazon Server',
  'Fistly Server',
  'Akamai Server',
];

/* Alpha and bravo are two commentary feeds of the same match. Both are
   offered, alpha first, with the source tagged on the name so the menu
   says which is which. */
function willowServers(alpha, bravo) {
  const seen = new Set();
  const all = [];
  for (const [map, tag] of [[alpha, 'alpha'], [bravo, 'bravo']]) {
    for (const [name, url] of Object.entries(map || {})) {
      if (typeof url !== 'string' || !url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      all.push({ name: `${name} (${tag})`, url });
    }
  }
  const rank = (name) => {
    const base = name.split(' (')[0];
    const i = WILLOW_SERVER_ORDER.indexOf(base);
    return i === -1 ? WILLOW_SERVER_ORDER.length : i;
  };
  return all.sort((a, b) => rank(a.name) - rank(b.name));
}

async function handleWillowFeed() {
  try {
    const res  = await fetchFresh(WILLOW_JSON, { 'accept': 'application/json', 'user-agent': 'player.html/1.0' });
    const text = await res.text();
    if (!res.ok || text.trim().startsWith('<')) {
      return json({ error: 'willow_feed', detail: `HTTP ${res.status}` }, 502);
    }

    const parsed = JSON.parse(text);
    const rows = parsed.Matches || [];

    const shape = (m) => {
      /* "European T20 Premier League 2026 - 26th Match - A vs B" — split on
         the last hyphen so a card shows the fixture and puts the league
         underneath, rather than truncating the lot. */
      const bits = String(m.title || '').split(' - ');
      const name  = bits.length > 1 ? bits[bits.length - 1].trim() : (m.title || '');
      const event = bits.length > 1 ? bits.slice(0, -1).join(' · ').trim() : '';

      const [keyId = '', key = ''] = String(m.drm_key || '').split(':');
      const servers = willowServers(m.stream_url_alpha, m.stream_url_bravo);

      return {
        id:       String(m.match_id || ''),
        name:     name || 'Cricket',
        event,
        category: 'Cricket',
        lang:     '',
        start:    m.time || '',
        poster:   m.cover_image || '',
        logo:     m.cover_image || '',
        link:     m.match_url || '',
        url:      servers[0] ? servers[0].url : '',
        servers,
        keyId:    keyId.trim(),
        key:      key.trim(),
      };
    };

    const isLive = (m) => String(m.status || '').toUpperCase() === 'LIVE';
    const live = rows.filter(isLive).map(shape).filter(m => m.url);
    // An upcoming fixture is not signed until it starts, so its URL is
    // dropped even where the feed has one.
    const upcoming = rows.filter(m => !isLive(m)).map(shape).map(m => ({ ...m, url: '', servers: [] }));

    return json({ live, upcoming }, 200, {
      'X-Feed-Source': 'willow.json',
      'X-Feed-Updated': String((parsed.HeaderInfo || {}).LastUpdate || ''),
    });
  } catch (e) {
    return json({ error: 'willow_feed', detail: e.message }, 502);
  }
}
