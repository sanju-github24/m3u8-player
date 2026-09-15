/* Fetch each feed, check it is what it claims to be, write it if so.
 *
 * The check is the point. A mirror that copies whatever it is given passes on
 * a 404 page or an emptied file just as faithfully as a good one, and then the
 * worker prefers that copy over the upstream that still works. Anything that
 * fails is left alone, so the previous good copy stays.
 */
import { writeFile, readFile } from "node:fs/promises";

const FEEDS = [
  {
    file: "jtv.json",
    url: "https://raw.githubusercontent.com/sportlive18/jio-tv-auto-update-playlist/refs/heads/main/jtv.json",
    ok: (t) => { const d = JSON.parse(t); const r = Array.isArray(d) ? d : Object.values(d);
                 return r.length > 100 && r.some((x) => x.url && x.name); },
  },
  {
    file: "hotstar.m3u",
    url: "https://raw.githubusercontent.com/sportlive18/jio-tv-auto-update-playlist/refs/heads/main/hotstar.m3u",
    ok: (t) => t.startsWith("#EXTM3U") && (t.match(/#EXTINF/g) || []).length > 20 && t.includes("hdntl="),
  },
  {
    file: "sonyliv.json",
    url: "https://raw.githubusercontent.com/sportlive18/Sonyliv-Playlist-Autoupdate/refs/heads/main/sonyliv.json",
    ok: (t) => Array.isArray(JSON.parse(t).matches),
  },
  {
    file: "fancode.json",
    url: "https://raw.githubusercontent.com/sportlive18/Fancode-New-Auto-Update/refs/heads/main/fancode.json",
    ok: (t) => Array.isArray(JSON.parse(t).matches),
  },
  {
    file: "willow.json",
    url: "https://raw.githubusercontent.com/sportlive18/Willow-Cricbuzz-Prime-Video-Sport-Live-Event-Auto-Updated-Playlist/refs/heads/main/willow.json",
    ok: (t) => Array.isArray(JSON.parse(t).Matches),
  },
  {
    file: "primesport.json",
    url: "https://raw.githubusercontent.com/sportlive18/Willow-Cricbuzz-Prime-Video-Sport-Live-Event-Auto-Updated-Playlist/refs/heads/main/primesport.json",
    ok: (t) => Array.isArray(JSON.parse(t).Matches),
  },
];

let failures = 0;

for (const f of FEEDS) {
  try {
    const res = await fetch(f.url + "?_=" + Date.now(), { headers: { "user-agent": "feed-mirror" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();

    let valid = false;
    try { valid = !!f.ok(text); } catch (e) { throw new Error("shape: " + e.message); }
    if (!valid) throw new Error("failed its shape check");

    /* Only write a real change, so the commit step has nothing to do when a
       feed is merely re-served unchanged. */
    const prev = await readFile("feeds/" + f.file, "utf8").catch(() => null);
    if (prev === text) { console.log(`= ${f.file} unchanged`); continue; }

    await writeFile("feeds/" + f.file, text);
    console.log(`✓ ${f.file} ${text.length} bytes`);
  } catch (e) {
    failures++;
    console.log(`✗ ${f.file} kept previous copy — ${e.message}`);
  }
}

/* One bad feed is normal and must not fail the run, or the good ones never get
   committed. All of them failing means something else is wrong. */
if (failures === FEEDS.length) {
  console.error("every feed failed");
  process.exit(1);
}
