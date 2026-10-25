/* The live proxy, on the Delhi VPS instead of a Vercel function.
 *
 * Measured 2026-10-24, the same tokened URLs from three places:
 *
 *                          home Jio line   Delhi VPS   free Indian proxies (519 tried)
 *   sonydaime (SonyLiv)       200            403          23 work, best ~0.5 s
 *   jcevents  (Hotstar)       200            475          31 work, best ~0.3 s
 *   livetv / live09p          200            475           0 work
 *
 * So the box cannot fetch these itself either — what it can do, and a
 * serverless function cannot, is stay up. The Vercel proxy loses its memory on
 * every cold start and hunts eight proxies at a time down one list, which is
 * the 20-second first frame. Here:
 *
 *   - the pool is three lists, kept warm in the background against each host
 *     somebody is actually watching, so a request goes straight to a proxy
 *     that answered seconds ago;
 *   - each request is hedged — the best proxy first, the next one a moment
 *     later if it is slow — and a refusal drops that proxy for that host;
 *   - one fetch upstream serves every viewer: playlists for a second,
 *     segments for two minutes, concurrent asks for the same URL share it;
 *   - a playlist's newest segments are fetched before the player asks;
 *   - HOME_PROXY (a laptop on the home line, over ssh -R, the same one
 *     anchor-ingest uses) goes first while it is up. It is the only route
 *     livetv and live09p take at all.
 *
 *   GET /?url=<encoded>[&cookie=][&ref=][&ua=]   — the same interface as
 *   /api/live-proxy, so the player only changes its base URL.
 *   GET /health                                  — the pool, per host.
 */
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ProxyAgent, Agent } from "undici";

const PORT = Number(process.env.PORT) || 8790;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const HOME_PROXY = (process.env.HOME_PROXY || "").trim();
/* Proxies of our own — a paid static residential IP, http://user:pass@ip:port,
   comma-separated. Always tried first and never dropped from the pool: a
   refusal from one is the CDN's answer, not a dead stranger. */
const FIXED = (process.env.FIXED_PROXIES || "").split(",").map((x) => x.trim()).filter(Boolean);
const ours = (p) => p === HOME_PROXY || FIXED.includes(p);
const CACHE_BYTES = Number(process.env.CACHE_MB || 300) * 1024 * 1024;

/* The VPS has 1 TB a month. Segments — nearly all of the bytes — are linked
   under /s/, where a free-plan Cloudflare Worker (edge-cache/) caches them per
   data centre, so each one leaves this box about once per city rather than
   once per viewer. What still gets through is metered here, in and out, and
   past SEGMENT_FALLBACK_GB the playlists start linking segments to the Vercel
   proxy instead: slower, but none of it on this box's allowance. */
const SEG_FALLBACK = (process.env.SEGMENT_FALLBACK || "https://m3u8-player-orcin.vercel.app/api/live-proxy").replace(/\/$/, "");
const SEG_FALLBACK_GB = Number(process.env.SEGMENT_FALLBACK_GB || 850);
const STATE = process.env.STATE_DIRECTORY || process.env.STATE_DIR || "/tmp/live-relay";
const USAGE_FILE = path.join(STATE, "usage.json");
const month = () => new Date().toISOString().slice(0, 7);
let usage = { month: month(), inBytes: 0, outBytes: 0 };
try { const u = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); if (u.month === usage.month) usage = u; } catch { /* first run */ }
function meter(inB = 0, outB = 0) {
  if (usage.month !== month()) usage = { month: month(), inBytes: 0, outBytes: 0 };
  usage.inBytes += inB; usage.outBytes += outB;
}
setInterval(() => {
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch { /* next time */ }
}, 60_000).unref();
const usedGB = () => (usage.inBytes + usage.outBytes) / 1024 ** 3;
const overBudget = () => usedGB() >= SEG_FALLBACK_GB;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* Not an open relay: only the CDNs the live pages play from. */
const ALLOWED = ["fancode.com", "akamaized.net", "hotstar.com", "jio.com", "hakunaymatata.com"];
const allowed = (h) => ALLOWED.some((s) => h === s || h.endsWith("." + s));

/* Refuse every datacenter, this one included (the table above). Anything else
   is tried direct first and learned: a 403/451/452/475 sends it to the pool. */
const NEEDS_RESIDENTIAL = ["sonydaime.akamaized.net", "sonydaimenew.akamaized.net",
  "v2-prime.akamaized.net", "hotstar.com"];
const directOk = new Map();
const needsResidential = (h) => directOk.get(h) === false
  || NEEDS_RESIDENTIAL.some((s) => h === s || h.endsWith("." + s));
const REFUSALS = [403, 451, 452, 475];

/* Scored 2026-10-24 against live SonyLiv/Hotstar from this box (working /
   listed): databay 46/310, proxifly 16/219, hideip.me 16/125, proxyscrape
   6/31. roosterkid, monosans, vakhov and iplocate added nothing — not listed.
   hideip.me is every country in one file, tagged ":India" at the end. */
const LISTS = [
  ["https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt", /:India\s*$/i],
  ["https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt", /:India\s*$/i],
  ["https://raw.githubusercontent.com/zloi-user/hideip.me/main/connect.txt", /:India\s*$/i],
  "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/IN/data.txt",
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=in&protocol=http&proxy_format=ipport&format=text",
];

// ── the pool ───────────────────────────────────────────────────────────────
let all = [];                         // every candidate on the lists
async function refreshLists() {
  const seen = new Set();
  for (const entry of LISTS) {
    const [l, keep] = Array.isArray(entry) ? entry : [entry, null];
    try {
      const t = await (await fetch(l, { signal: AbortSignal.timeout(15000) })).text();
      for (const line of t.split("\n")) {
        /* proxifly lists socks too; undici speaks only http CONNECT. */
        if ((keep && !keep.test(line)) || /^socks/i.test(line)) continue;
        const m = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/.exec(line);
        if (m) seen.add(`${m[1]}:${m[2]}`);
      }
    } catch { /* one list down is not the pool down */ }
  }
  if (seen.size) all = [...seen];
  log(`pool: ${all.length} candidates`);
}

/* One keep-alive agent per proxy: a new one per request is a new TCP + CONNECT
   + TLS each segment, which through a stranger's line is most of the wait. */
const agents = new Map();
const agentUsed = new Map();
const agentFor = (p) => {
  if (p === "direct") return directAgent;
  agentUsed.set(p, Date.now());
  if (!agents.has(p)) agents.set(p, new ProxyAgent({ uri: p.includes("://") ? p : `http://${p}`,
    connectTimeout: 6000, keepAliveTimeout: 30000 }));
  return agents.get(p);
};
const directAgent = new Agent({ keepAliveTimeout: 30000, connectTimeout: 6000 });

/* Per host: proxies that answered it, by speed; and a recent playlist request
   to test candidates with — a token only the live traffic has. */
const hosts = new Map();
const hostState = (h) => {
  if (!hosts.has(h)) hosts.set(h, { good: new Map(), bad: new Map(), sample: null, sweeping: null, firstWin: null, starvedUntil: 0 });
  return hosts.get(h);
};
const ranked = (st) => [...st.good.entries()].sort((a, b) => a[1].ms - b[1].ms).map(([p]) => p);
/* A proxy that answers a playlist in 100 ms can still take 13 s over a 1 MB
   segment — and a 4-second segment that takes 13 s is a stream that stalls.
   So segments are routed by measured throughput (bytes per ms), not by how
   fast a small playlist came back. Unmeasured proxies sit between the proven
   fast and the proven slow, so they get tried and measured. */
const FAST_BPMS = 500;                       // ~4 Mbps: comfortably more than 1080p needs
function rankedForSegments(st) {
  const rows = [...st.good.entries()];
  const score = ([, g]) => g.bpms == null ? FAST_BPMS * 0.8 : g.bpms;
  return rows.sort((a, b) => score(b) - score(a) || a[1].ms - b[1].ms).map(([p]) => p);
}
function credit(st, p, ms, bytes = 0) {
  const prev = st.good.get(p);
  const g = { ms: prev ? Math.round(prev.ms * 0.6 + ms * 0.4) : ms, at: Date.now(), bpms: prev?.bpms ?? null };
  if (bytes >= 100_000) {
    const bpms = bytes / Math.max(ms, 1);
    g.bpms = g.bpms == null ? bpms : g.bpms * 0.5 + bpms * 0.5;
  }
  st.good.set(p, g);
  st.bad.delete(p);
}
function blame(st, p) {
  st.good.delete(p);
  st.bad.set(p, Date.now());
}
/* Every proxy tried keeps a keep-alive agent with open sockets. Five hundred
   of them, swept for four hosts, held the box at 127% CPU — slow enough that
   a segment already in cache took 12 s to leave. Once a minute, an agent no
   host counts as good and nobody has used for a minute is closed. Not at the
   moment of blame: the four hosts sweep the same proxies at once, and closing
   one host's reject cut another host's check off mid-flight. */
setInterval(() => {
  const now = Date.now();
  for (const [p, a] of agents) {
    if (ours(p) || now - (agentUsed.get(p) || 0) < 60_000) continue;
    if ([...hosts.values()].some((st) => st.good.has(p))) continue;
    agents.delete(p); agentUsed.delete(p); a.close().catch(() => {});
  }
}, 60_000).unref();

let homeUp = false;
function checkHome() {
  if (!HOME_PROXY) return;
  const u = new URL(HOME_PROXY);
  const s = net.connect(Number(u.port) || 80, u.hostname);
  s.setTimeout(1500);
  s.on("connect", () => { if (!homeUp) log("home tunnel up"); homeUp = true; s.destroy(); });
  const down = () => { if (homeUp) log("home tunnel down"); homeUp = false; s.destroy(); };
  s.on("error", down); s.on("timeout", down);
}

async function get(url, headers, via, ms) {
  const t = Date.now();
  const r = await fetch(url, { headers, dispatcher: agentFor(via), signal: AbortSignal.timeout(ms), redirect: "follow" });
  const body = Buffer.from(await r.arrayBuffer());
  meter(body.length, 0);
  return { status: r.status, ok: r.ok, ct: r.headers.get("content-type") || "", body, via, ms: Date.now() - t,
    range: r.headers.get("content-range"), };
}

/* Some free proxies answer 200 with a page of their own. A playlist must be
   one, and a segment must not be a web page. */
function real(url, r) {
  if (!r.body.length) return false;
  if (looksPlaylist(url)) { const head = r.body.toString("utf8", 0, 512); return /#EXTM3U|<MPD/i.test(head); }
  return !/text\/html/i.test(r.ct);
}

/* Sweep the whole list against a host, 48 at a time. Resolves on the first
   proxy that answers so a waiting viewer is not held for the rest; the sweep
   carries on and every other winner joins the pool. */
function sweep(host) {
  const st = hostState(host);
  if (st.sweeping) return st.firstWin;
  /* A sweep that found nobody is not repeated straight away: it waits, longer
     each time, so a host that takes few free proxies does not keep the CPU
     busy proving that again and again. */
  if (Date.now() < (st.nextSweep || 0) && st.good.size) return Promise.resolve(null);
  const sample = st.sample;
  if (!sample || !all.length) return Promise.resolve(null);
  /* Free proxies fail on and off, so a failure benches one for a minute, not
     ten — with ten, one sweep benched nearly the whole list and the next
     sweeps found "0 of 0" while the pool dwindled to one slow proxy. The
     longest-benched are tried first. */
  const queue = all.filter((p) => !st.good.has(p) && Date.now() - (st.bad.get(p) || 0) > 60_000)
    .sort((a, b) => (st.bad.get(a) || 0) - (st.bad.get(b) || 0));
  if (!queue.length) return Promise.resolve(null);
  let settle;
  st.firstWin = new Promise((ok) => { settle = ok; });
  let i = 0, found = 0, refused = 0;
  const marked = [];
  const lane = async () => {
    while (i < queue.length) {
      const p = queue[i++];
      try {
        const r = await get(sample.url, sample.headers, p, 6000);
        if (r.ok && real(sample.url, r)) { credit(st, p, r.ms); found++; settle(p); }
        else { if (r.status >= 400 && r.status < 500) refused++; blame(st, p); marked.push(p); }
      } catch { blame(st, p); marked.push(p); }
    }
  };
  st.sweeping = Promise.all(Array.from({ length: 24 }, lane)).then(() => {
    log(`sweep ${host}: ${found} of ${queue.length} answered — ${st.good.size} in pool`);
    st.backoff = found >= 3 ? 20_000 : Math.min((st.backoff || 20_000) * 2, 5 * 60_000);
    st.nextSweep = Date.now() + st.backoff;
    /* Nobody at all, and many reached the CDN only to be told no: the test
       link is dead, not five hundred proxies. Undo the marks, drop the link. */
    if (!found && refused >= 5) {
      for (const p of marked) st.bad.delete(p);
      if (st.sample === sample) st.sample = null;
      log(`sweep ${host}: ${refused} proxies reached the CDN and were refused — the test link is dead, not them`);
    } else if (!found && !st.good.size) st.starvedUntil = Date.now() + 60_000;
    st.sweeping = null;
    settle(null);
  });
  return st.firstWin;
}

/* Fetch through the best routes, hedged: the next one starts if the current
   one has not answered in a moment, and the first good answer wins. */
async function viaPool(url, headers, host, isPlaylist) {
  const st = hostState(host);
  const routes = [...FIXED, ...(homeUp ? [HOME_PROXY] : []),
    ...(isPlaylist ? ranked(st) : rankedForSegments(st)).slice(0, 5)];
  if (st.good.size < 3 && Date.now() > st.starvedUntil) sweep(host);   // grow the pool in the background
  const timeout = isPlaylist ? 6000 : 15000;
  /* A segment that has not finished in 2 s is already losing to the clock:
     the next proxy starts alongside it, and whichever lands first wins. */
  const hedge = isPlaylist ? 900 : 2000;

  /* A refusal is only the proxy's fault if another proxy got the same URL
     through. When every route is refused, the link itself is dead (SonyLiv's
     Tamil, an expired token) — blaming each proxy for it emptied the pool and
     took every other commentary down with it. */
  const attempt = (list) => new Promise((resolve) => {
    let pending = 0, done = false, idx = 0, lastBad = null;
    const refusedBy = [];
    const next = () => {
      if (done || idx >= list.length) { if (!pending && !done) { done = true; resolve(lastBad); } return; }
      const p = list[idx++]; pending++;
      const timer = setTimeout(next, hedge);
      const started = Date.now();
      get(url, headers, p, timeout).then((r) => {
        if (r.ok && !real(url, r)) { r = { ...r, ok: false, status: 502 }; }
        if (r.ok) {
          if (!ours(p)) credit(st, p, r.ms, r.body.length);
          for (const q of refusedBy.splice(0)) blame(st, q);
          if (!done) { done = true; resolve(r); }
        } else {
          if (!ours(p) && r.status === 502) blame(st, p);            // a page of its own, not the CDN's
          else if (!ours(p) && REFUSALS.includes(r.status)) refusedBy.push(p);
          lastBad = r; clearTimeout(timer); next();
        }
      }).catch(() => {
        /* Lost the race on a segment it was still downloading: slow, not
           dead. Marked slow, so it stops being chosen for segments. */
        if (!ours(p)) { const g = st.good.get(p); if (g && done && !isPlaylist && Date.now() - started < timeout) g.bpms = Math.min(g.bpms ?? FAST_BPMS, 50); else blame(st, p); }
        clearTimeout(timer); next();
      })
        .finally(() => { pending--; if (!pending && !done && idx >= list.length) { done = true; resolve(lastBad); } });
    };
    next();
  });

  /* Only a playlist that loaded becomes the sample the pool is tested
     against. A dead link as the sample (SonyLiv's Tamil) failed every proxy
     in the background check and emptied the pool for every other language. */
  const keep = (res) => { if (res?.ok && isPlaylist) st.sample = { url, headers, at: Date.now() }; return res; };
  if (isPlaylist && !st.sample) st.sample = { url, headers, at: Date.now(), unproven: true };
  let r = routes.length ? keep(await attempt(routes)) : null;
  if (r?.ok) return r;
  /* Every proxy in hand reached the CDN and was told no (or 4xx): the link is
     the problem, and a sweep for more proxies would only make the viewer wait. */
  if (r && r.status >= 400 && r.status < 500 && r.status !== 407) return r;
  /* Nothing in hand worked. If a sweep can find one, wait for its first
     winner — but not for a host already shown to have none. */
  if (Date.now() > st.starvedUntil) {
    const p = await Promise.race([sweep(host), new Promise((ok) => setTimeout(() => ok(null), 20000))]);
    if (p) { const again = keep(await attempt([p, ...ranked(st).filter((x) => x !== p).slice(0, 3)])); if (again?.ok) return again; r = again || r; }
  }
  return r || await get(url, headers, "direct", 8000);       // the refusal, so the player sees why
}

/* Keep the pool full for every host watched in the last ten minutes, and
   forget proxies that have not answered for a while so they are re-proven. */
setInterval(() => {
  for (const [host, st] of hosts) {
    if (!st.sample || Date.now() - st.sample.at > 10 * 60_000) continue;
    /* Free proxies die within minutes, so the best few are asked again every
       round: a dead one leaves the pool before a viewer finds it dead. */
    /* Checked together, judged together: if not one of them can load the
       sample, the sample has died (its token expired, the feed moved), not
       eight proxies at once — so it is dropped and the proxies are kept. */
    const sample = st.sample;
    const checks = ranked(st).slice(0, 8).map((p) => get(sample.url, sample.headers, p, 6000)
      .then((r) => ({ p, ok: r.ok && real(sample.url, r), ms: r.ms, status: r.status }))
      .catch(() => ({ p, ok: false, status: 0 })));
    Promise.all(checks).then((rs) => {
      if (rs.length && !rs.some((x) => x.ok) && rs.some((x) => x.status >= 400)) {
        if (st.sample === sample) st.sample = null;
        log(`${host}: the pool's test link stopped loading through every proxy — dropping the link, keeping the proxies`);
        return;
      }
      for (const x of rs) x.ok ? credit(st, x.p, x.ms) : blame(st, x.p);
    });
    if (st.good.size < 8 && Date.now() > st.starvedUntil) sweep(host);
    for (const [p, g] of st.good) if (Date.now() - g.at > 3 * 60_000) st.good.delete(p);
  }
}, 20_000).unref();

// ── one upstream fetch for every viewer ────────────────────────────────────
const cache = new Map();             // key -> { r, exp, size }
let cacheSize = 0;
const inflight = new Map();          // key -> Promise
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (e.exp < Date.now()) { cache.delete(k); cacheSize -= e.size; return null; }
  cache.delete(k); cache.set(k, e);  // most recently used last
  return e.r;
}
function cachePut(k, r, ttl) {
  const size = r.body.length;
  if (size > CACHE_BYTES / 10) return;
  const old = cache.get(k); if (old) { cache.delete(k); cacheSize -= old.size; }
  cache.set(k, { r, exp: Date.now() + ttl, size }); cacheSize += size;
  for (const [key, e] of cache) { if (cacheSize <= CACHE_BYTES) break; cache.delete(key); cacheSize -= e.size; }
}

const looksPlaylist = (u) => /\.(m3u8|mpd)$/i.test(new URL(u).pathname);

/* SonyLiv signs every child and segment with an Akamai token in the PATH —
   ".../ENG/hdntl=exp=…~hmac=…/7-448206182.ts" — and mints a new one on each
   playlist refresh. The same segment then has a new URL every few seconds,
   so no cache anywhere (here, the prefetch, the Cloudflare edge) could ever
   reuse it: every viewer fetched every segment afresh through a free proxy.
   Links handed out carry a fixed placeholder instead; the newest token for
   that directory is put back when the segment is actually fetched. */
const PATH_TOKEN = /\/(hdntl=[^/]*?~hmac=[0-9a-f]+)\//i;
const PLACEHOLDER = "/__tok__/";
const tokens = new Map();                    // dir before the token -> newest token
function canonical(url) {
  const m = PATH_TOKEN.exec(url);
  if (!m) return url;
  tokens.set(url.slice(0, m.index), m[1]);
  return url.slice(0, m.index) + PLACEHOLDER + url.slice(m.index + m[0].length);
}
function resolveToken(url) {
  const at = url.indexOf(PLACEHOLDER);
  if (at < 0) return url;
  const tok = tokens.get(url.slice(0, at));
  return tok ? `${url.slice(0, at)}/${tok}/${url.slice(at + PLACEHOLDER.length)}` : null;
}

/* The SonyLiv feed has listed a commentary under the wrong event name — Hindi
   as ".../criclive2410/HIN/master.m3u8" when the stream is at
   ".../cricodi_2410/HIN/…" (404 at the feed's spelling, from every address).
   A 404 on one spelling tries the other, and the answer is remembered. */
const ALIASES = new Map();                   // url -> the url that worked
function altSpelling(url) {
  if (!/sonydaime/i.test(url)) return null;
  if (/\/criclive(\d+)\//.test(url)) return url.replace(/\/criclive(\d+)\//, "/cricodi_$1/");
  if (/\/cricodi_(\d+)\//.test(url)) return url.replace(/\/cricodi_(\d+)\//, "/criclive$1/");
  return null;
}

async function fetchUpstream(url, headers, opts = {}) {
  url = ALIASES.get(url) || url;
  const r = await fetchOnce(url, headers, opts);
  const alt = r.status === 404 && looksPlaylist(url) && altSpelling(url);
  if (alt) {
    const again = await fetchOnce(alt, headers, opts);
    if (again.ok) { ALIASES.set(url, alt); log(`404 at the feed's spelling — ${alt.split("?")[0]} works, using that`); return { ...again, aliasOf: alt }; }
  }
  return r;
}

async function fetchOnce(url, headers, { range } = {}) {
  const host = new URL(url).hostname;
  const isPlaylist = looksPlaylist(url);
  const h = range ? { ...headers, Range: range } : headers;
  if (!needsResidential(host)) {
    const r = await get(url, h, "direct", 15000);
    if (!REFUSALS.includes(r.status)) { if (r.ok) directOk.set(host, true); return r; }
    directOk.set(host, false);
    log(`${host} refuses this box (${r.status}) — using the pool from now on`);
  }
  return viaPool(url, h, host, isPlaylist);
}

function shared(url, headers, opts = {}) {
  if (opts.range) return fetchUpstream(url, headers, opts);   // a byte range is not cached
  /* Keyed by the link as handed out (token placeholder in), so a prefetch and
     every viewer's later request for the same segment meet here. */
  const key = crypto.createHash("sha1").update(canonical(url) + "\n" + (headers.Cookie || "")).digest("hex");
  const hit = cacheGet(key);
  if (hit) return Promise.resolve({ ...hit, cached: true });
  if (inflight.has(key)) return inflight.get(key);
  const p = fetchUpstream(url, headers, opts).then((r) => {
    if (r.ok) {
      const pl = looksPlaylist(url) || /mpegurl|dash\+xml/i.test(r.ct);
      const master = pl && /#EXT-X-STREAM-INF/.test(r.body.toString("utf8", 0, 4096));
      cachePut(key, r, pl ? (master ? 10_000 : 1_000) : 120_000);
    }
    return r;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ── the HTTP side ──────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Proxy-Via, X-Proxy-Upstream, X-Cache");
}

// ── What is live on JioHotstar's sports page ───────────────────────────────
/* Metadata only — the matches, their posters, tournaments and official
   pages. No stream: Hotstar's own players need a paid login, and that is not
   something this does. Read the way hotstar.com/in/sports reads it as a
   guest: POST /bff/v2/freshstart mints a guest token (x-hs-updatedusertoken),
   which /bff/v2/slugs/in/sports accepts. Akamai answers 475 to this box, so
   both go through the Indian home proxies the pool already holds for
   Hotstar's hosts (or the home tunnel, or a fixed proxy, when there is one).
   Kept 90 s; a failed refresh serves the last list for ten minutes. */
const HS = "https://www.hotstar.com";
const HS_IMG = "https://img10.hotstar.com/image/upload/";
let hsCache = { at: 0, data: null };
let hsBusy = null;
const uuid = () => crypto.randomUUID();
function hsHeaders(token) {
  return { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "x-country-code": "in", "x-platform-code": "web", "x-client-code": "LR", "x-hs-platform": "web",
    "x-hs-device-id": uuid(), "x-request-id": uuid(), "content-type": "application/json",
    origin: HS, referer: `${HS}/in/sports`, ...(token ? { "x-hs-usertoken": token } : {}) };
}
async function hsVia(p) {
  const fs = await fetch(`${HS}/api/internal/bff/v2/freshstart`, { method: "POST", body: "{}", headers: hsHeaders(),
    dispatcher: agentFor(p), signal: AbortSignal.timeout(12000) });
  await fs.arrayBuffer().catch(() => {});
  const token = fs.headers.get("x-hs-updatedusertoken");
  if (!token) throw new Error(`freshstart ${fs.status}`);
  const r = await fetch(`${HS}/api/internal/bff/v2/slugs/in/sports`, { headers: hsHeaders(token),
    dispatcher: agentFor(p), signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok || !text.startsWith("{")) throw new Error(`sports ${r.status}`);
  return JSON.parse(text);
}
/* Every card on the page: anything with content_info.title and a sports
   page under it. Live = a live-video page, or a LIVE badge. */
function hsCards(tree) {
  const out = [], seen = new Set();
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    const ci = n.content_info;
    if (ci && typeof ci === "object" && ci.title) {
      const s = JSON.stringify(n);
      const slug = (s.match(/"page_slug":\s*"(\/in\/sports\/[^"?]+)"/) || [])[1];
      if (slug) {
        const id = (slug.match(/\/(\d{6,})\//) || [])[1] || slug;
        if (!seen.has(id)) {
          seen.add(id);
          const img = n.hero_img?.src || n.thumbnail?.src || (s.match(/"src":\s*"(sources\/[^"]+)"/) || [])[1] || "";
          const tags = (ci.tags || []).map((t) => t.value || t.text_tag?.value).filter(Boolean);
          out.push({
            id, title: ci.title, description: ci.description || "",
            sport: (slug.match(/^\/in\/sports\/([^/]+)/) || [])[1] || "",
            tournament: tags.find((t) => !/^(baseball|cricket|football|kabaddi|tennis|hockey|badminton|basketball|motorsport|f1|golf|boxing|wwe)$/i.test(t)) || "",
            tags,
            live: /\/video\/live\//.test(slug) || /"(LIVE|Live)"/.test(s),
            kind: (slug.match(/\/video\/([a-z]+)\//) || [])[1] || "",
            poster: img ? HS_IMG + img : null,
            cutout: ci.title_cutout?.src ? HS_IMG + ci.title_cutout.src : null,
            hotstarUrl: HS + slug,
          });
        }
      }
      return;
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(tree);
  return out;
}
async function hotstarSports() {
  if (hsCache.data && Date.now() - hsCache.at < 90_000) return hsCache.data;
  if (hsBusy) return hsBusy;
  hsBusy = (async () => {
    const pooled = ["jcevents.hotstar.com", "livetv.hotstar.com", "live09p.hotstar.com"]
      .flatMap((h) => (hosts.has(h) ? ranked(hosts.get(h)) : []));
    const routes = [...new Set([...FIXED, ...(homeUp ? [HOME_PROXY] : []), ...pooled])].slice(0, 12);
    for (const p of routes) {
      try {
        const cards = hsCards(await hsVia(p));
        if (!cards.length) continue;
        hsCache = { at: Date.now(), data: { updatedAt: new Date().toISOString(), live: cards.filter((c) => c.live), cards } };
        return hsCache.data;
      } catch { /* the next proxy */ }
    }
    if (hsCache.data && Date.now() - hsCache.at < 10 * 60_000) return { ...hsCache.data, stale: true };
    throw new Error(routes.length ? "no proxy reached Hotstar just now" : "the Hotstar proxy pool is still warming up");
  })().finally(() => { hsBusy = null; });
  return hsBusy;
}

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  const q = new URL(req.url, "http://x");
  if (q.pathname === "/hotstar/sports") {
    try {
      const data = await hotstarSports();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: e.message, live: [], cards: [] }));
    }
    return;
  }
  if (q.pathname === "/health") {
    const out = { home: HOME_PROXY ? homeUp : "not configured", fixed: FIXED.length, candidates: all.length,
      bandwidth: { month: usage.month, inGB: +(usage.inBytes / 1024 ** 3).toFixed(2), outGB: +(usage.outBytes / 1024 ** 3).toFixed(2),
        fallbackAtGB: SEG_FALLBACK_GB, segmentsVia: overBudget() ? "vercel (over budget)" : "edge cache → this box" },
      cacheMB: +(cacheSize / 1048576).toFixed(1), hosts: {} };
    for (const [h, st] of hosts) out.hosts[h] = { pool: st.good.size, best: ranked(st).slice(0, 3).map((p) => `${p} ${st.good.get(p).ms}ms`),
      watched: st.sample ? `${Math.round((Date.now() - st.sample.at) / 1000)}s ago` : null, sweeping: !!st.sweeping };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out, null, 1));
    return;
  }

  const target = q.searchParams.get("url");
  const cookie = q.searchParams.get("cookie") || "";
  const ref = q.searchParams.get("ref") || "";
  const ua = q.searchParams.get("ua") || "";
  if (!target) { res.writeHead(400).end("Missing ?url="); return; }
  const real_ = resolveToken(target);
  if (!real_) { res.setHeader("Cache-Control", "no-store"); res.writeHead(410).end("token not seen yet — reload the playlist"); return; }
  let t;
  try { t = new URL(real_); } catch { res.writeHead(400).end("Invalid url"); return; }
  if (!allowed(t.hostname)) { res.writeHead(403).end("Host not allowed"); return; }

  let refOrigin = t.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep the target's */ } }
  const headers = { "User-Agent": ua || DEFAULT_UA, Referer: ref || t.origin + "/", Origin: refOrigin,
    Accept: "*/*", ...(cookie ? { Cookie: cookie } : {}) };

  let up;
  try { up = await shared(t.href, headers, { range: req.headers.range }); }
  catch (e) { res.writeHead(502).end("Upstream failed: " + e.message); return; }

  if (up.via && up.via !== "direct") res.setHeader("X-Proxy-Via", up.via === HOME_PROXY ? "home" : FIXED.includes(up.via) ? "fixed" : up.via);
  res.setHeader("X-Cache", up.cached ? "HIT" : "MISS");
  if (!up.ok) {
    res.setHeader("X-Proxy-Upstream", String(up.status));
    /* A refusal must not be cached at the edge: the next try may well work. */
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(up.status).end(up.body.subarray(0, 2000));
    return;
  }

  const lower = t.pathname.toLowerCase();
  const isPlaylist = lower.endsWith(".m3u8") || up.ct.includes("mpegurl");
  const isDash = lower.endsWith(".mpd") || up.ct.includes("dash+xml");

  /* A manifest's segments live in templates, so it is given an absolute
     BaseURL back at the real directory and the player wraps each segment. */
  if (isDash) {
    let xml = up.body.toString("utf8");
    const dir = t.href.slice(0, t.href.lastIndexOf("/") + 1);
    if (!/<BaseURL>\s*https?:/i.test(xml)) xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${dir}</BaseURL>`);
    meter(0, Buffer.byteLength(xml));
    res.writeHead(200, { "Content-Type": "application/dash+xml", "Cache-Control": "no-cache" }).end(xml);
    return;
  }

  if (isPlaylist) {
    const base = PUBLIC_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
    const extras = (cookie ? "&cookie=" + encodeURIComponent(cookie) : "")
      + (ref ? "&ref=" + encodeURIComponent(ref) : "") + (ua ? "&ua=" + encodeURIComponent(ua) : "");
    /* A child with no query inherits the parent's: FanCode and SonyLiv sign
       the folder in the query, and a relative reference drops it. */
    const from = up.aliasOf ? new URL(up.aliasOf) : t;
    const toAbs = (r) => { const u = new URL(r, from); if (!u.search && from.search) u.search = from.search; return u.href; };
    /* A child playlist stays here (small, and must be fresh); a segment or a
       key goes under /s/ for the edge cache — or to Vercel once over budget. */
    const wrap = (abs) => looksPlaylist(abs)
      ? `${base}/?url=${encodeURIComponent(canonical(abs))}${extras}`
      : overBudget()
        ? `${SEG_FALLBACK}?url=${encodeURIComponent(abs)}${extras}`          // Vercel knows no placeholder
        : `${base}/s/?url=${encodeURIComponent(canonical(abs))}${extras}`;
    const text = up.body.toString("utf8");
    const segs = [];
    const body = text.split("\n").map((line) => {
      const s = line.trim();
      if (!s) return line;
      if (s.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      const abs = toAbs(s);
      segs.push(abs);
      return wrap(abs);
    }).join("\n");
    meter(0, Buffer.byteLength(body));
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" }).end(body);

    /* A media playlist's newest segments are what the player asks for next.
       Fetched now, they are in cache when it does. */
    if (/#EXTINF/.test(text)) for (const s of segs.slice(-3)) shared(s, headers).catch(() => {});
    return;
  }

  /* A live segment never changes once published, and stays in the playlist
     for a minute or two — the edge may keep it that long. A byte range is not
     cached anywhere. */
  const out = { "Content-Type": up.ct || "application/octet-stream",
    "Cache-Control": up.range ? "no-store" : "public, max-age=120" };
  if (up.range) out["Content-Range"] = up.range;
  meter(0, up.body.length);
  res.writeHead(up.status, out).end(up.body);
}).listen(PORT, "127.0.0.1", () => log(`live-relay on 127.0.0.1:${PORT}${HOME_PROXY ? ` · home ${HOME_PROXY}` : ""}`));

/* The pool is only as warm as its last sample, and a sample needs a live
   token — so the relay reads the same feeds the site does and samples every
   host on them, every two minutes, whether or not anyone is watching. The
   first viewer then gets a proxy that answered a minute ago. */
const FEEDS = process.env.FEEDS_URL || "https://jtv-proxy.sanjusanjay0444.workers.dev/";
async function sampleFeeds() {
  const add = (url, headers) => {
    try {
      const h = new URL(url).hostname;
      if (!needsResidential(h)) return;
      const st = hostState(h);
      if (st.sample && Date.now() - st.sample.at < 90_000) return;   // a viewer's is fresher
      st.sample = { url, headers, at: Date.now(), fromFeed: true };
    } catch { /* not a URL */ }
  };
  try {
    const s = await (await fetch(`${FEEDS}?feed=sonyliv&_=${Date.now()}`, { signal: AbortSignal.timeout(15000) })).json();
    const seen = new Set();
    for (const m of s.live || []) {
      const h = (() => { try { return new URL(m.url).hostname; } catch { return ""; } })();
      if (m.url && !seen.has(h)) { seen.add(h); add(m.url, { "User-Agent": DEFAULT_UA, Referer: new URL(m.url).origin + "/", Accept: "*/*" }); }
    }
  } catch (e) { log("feed sonyliv:", e.message); }
  try {
    const hs = await (await fetch(`${FEEDS}?feed=hotstar&_=${Date.now()}`, { signal: AbortSignal.timeout(15000) })).json();
    const seen = new Set();
    for (const c of hs.channels || []) {
      const h = (() => { try { return new URL(c.url).hostname; } catch { return ""; } })();
      if (c.url && !seen.has(h)) { seen.add(h); add(c.url, { "User-Agent": "Virat Kohli", Referer: "https://www.hotstar.com/",
        Origin: "https://www.hotstar.com", Accept: "*/*", ...(hs.token ? { Cookie: hs.token } : {}) }); }
    }
  } catch (e) { log("feed hotstar:", e.message); }
}

refreshLists().then(sampleFeeds);
setInterval(refreshLists, 15 * 60_000).unref();
setInterval(sampleFeeds, 2 * 60_000).unref();
checkHome();
setInterval(checkHome, 10_000).unref();
