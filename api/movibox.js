/* MoviBox watch pages for one title, every language — for AnchorMB.
 *
 *   GET /api/movibox?tmdb=<id>[&type=movie|tv][&se=1&ep=1]
 *     { title, year, type, languages: [{ language, code, original, subjectId, url }] }
 *
 * AnchorMB plays MoviBox's own watch page in a frame, so the video goes from
 * their CDN straight to the viewer: none of it passes through us. Their CDN
 * only answers its own page (their Referer and signed token), which is why
 * the page is framed rather than its streams fed to our player.
 *
 * All this does is find the pages. MoviBox posts each language of a film as
 * its own title (Original, Hindi dub, Tamil dub…), every one listing the
 * others, so one search and one detail call give all of them. It runs here,
 * in Mumbai (vercel.json → bom1), because MoviBox answers Indian addresses.
 *
 * The site's web client works without an account: its first reply hands out
 * a guest token in an x-user header, used as a Bearer from then on; before
 * that it sends X-Client-Token, the time and an MD5 of it reversed.
 */
import crypto from "node:crypto";

const BASE = "https://movibox.net";
const API = `${BASE}/wefeed-h5api-bff`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TMDB_KEY = process.env.TMDB_API_KEY || "452111addfd12727f394865d09a805b4";

const clientToken = () => {
  const t = Math.floor(Date.now() / 1000);
  return `${t},${crypto.createHash("md5").update(String(t).split("").reverse().join("")).digest("hex")}`;
};

// Kept while the function stays warm.
let guest = { token: "", at: 0 };
async function once(path, method, body) {
  const headers = {
    Accept: "application/json", "content-type": "application/json",
    "X-Client-Info": JSON.stringify({ timezone: "Asia/Kolkata" }), "X-Request-Lang": "en",
    "User-Agent": UA, Origin: BASE, Referer: `${BASE}/`,
    ...(guest.token && Date.now() - guest.at < 6 * 3600e3 ? { Authorization: `Bearer ${guest.token}` } : { "X-Client-Token": clientToken() }),
  };
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const user = res.headers.get("x-user");
  if (user) { try { const t = JSON.parse(user).token; if (t) guest = { token: t, at: Date.now() }; } catch { /* keep the old one */ } }
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) {
    if (/token/i.test(json?.message || "")) guest = { token: "", at: 0 };   // a stale guest: start again
    throw new Error(`MoviBox ${path.split("?")[0]}: ${json?.message || res.status}`);
  }
  return json.data;
}
/* The site resets connections that come too close together, and turns down
   a search sent before it has handed out a guest token, so each call gets
   four tries, further apart each time. The answers are cached at the edge
   for hours, so few lookups ever get this far. */
async function mb(path, { method = "GET", body } = {}) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      if (!guest.token && !path.startsWith("/home")) await once("/home?host=movibox.net", "GET").catch(() => {});
      return await once(path, method, body);
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1200 * (i + 1))); }
  }
  throw last;
}

// A series is listed once a season, "Panchayat S4" or "Panchayat [Hindi] S1-S3".
const norm = (s) => String(s || "").toLowerCase().replace(/\s+s\d+(\s*-\s*s\d+)?\s*$/, "").replace(/\[[^\]]*\]/g, " ").replace(/&/g, " and ")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const yearOf = (s) => Number(String(s || "").slice(0, 4)) || 0;

async function tmdbTitle(id, type) {
  for (const k of type ? [type] : ["movie", "tv"]) {
    const r = await fetch(`https://api.themoviedb.org/3/${k}/${id}?api_key=${TMDB_KEY}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) continue;
    const d = await r.json();
    return { type: k, titles: [...new Set([d.title || d.name, d.original_title || d.original_name].filter(Boolean))],
      year: yearOf(d.release_date || d.first_air_date) };
  }
  throw new Error("TMDB has no title with that id");
}

/* The MoviBox title that is this one: the same name (any language's version
   — they all list the others) and, for a film, the same year give or take one. */
async function findSubject(titles, year, type) {
  const want = titles.map(norm).filter(Boolean);
  for (const t of titles) {
    const d = await mb("/subject/search", { method: "POST", body: { keyword: t, page: 1, perPage: 20, subjectType: type === "tv" ? 2 : 1 } });
    const hit = (d.items || []).find((x) => want.includes(norm(x.title))
      && (!year || type === "tv" || Math.abs(yearOf(x.releaseDate) - year) <= 1));
    if (hit) return hit;
  }
  return null;
}

const watchUrl = (detailPath, subjectId, se, ep) =>
  `${BASE}/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=${se || ""}&detailEp=${ep || ""}&lang=en`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  const tmdb = String(q.tmdb || "").replace(/\D/g, "");
  if (!tmdb) return res.status(400).json({ error: "tmdb is required" });
  const type = q.type === "tv" ? "tv" : q.type === "movie" ? "movie" : "";
  const se = Number(q.se) || 0, ep = Number(q.ep) || 0;

  try {
    const t = await tmdbTitle(tmdb, type);
    const subject = await findSubject(t.titles, t.year, t.type);
    if (!subject) {
      res.setHeader("Cache-Control", "public, s-maxage=3600");
      return res.status(404).json({ error: "MoviBox has no title by that name", title: t.titles[0], year: t.year });
    }
    const detail = await mb(`/detail?detailPath=${encodeURIComponent(subject.detailPath)}`);
    const dubs = detail?.subject?.dubs || detail?.dubs || [];
    const versions = dubs.length ? dubs
      : [{ subjectId: subject.subjectId, detailPath: subject.detailPath, lanName: "Original", lanCode: "", original: true }];
    const languages = versions.map((d) => ({
      language: d.lanName || "Original", code: d.lanCode || "", original: !!d.original,
      subjectId: d.subjectId, url: watchUrl(d.detailPath, d.subjectId, se, ep),
    }));
    // The pages do not move, so the CDN can keep the answer for hours.
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({ title: t.titles[0], year: t.year, type: t.type, se: se || undefined, ep: ep || undefined, languages });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: e.message });
  }
}
