/* Edge cache for the live relay's segments — Cloudflare Workers FREE plan.
 *
 * Bound to the route live.1anchormovies.buzz/s/* only. The relay links every
 * segment and key there; playlists stay on the plain hostname, uncached,
 * because a live playlist changes every few seconds.
 *
 * Each Cloudflare data centre keeps a segment for as long as the relay's
 * Cache-Control allows (two minutes), so the Delhi VPS sends it about once per
 * city instead of once per viewer — that is the whole point: the box has 1 TB
 * a month.
 *
 * Free plan, nothing billable: 100,000 requests a day. Set the route's
 * "request limit failure mode" to FAIL OPEN, so past the limit a request goes
 * straight to the relay (uncached) instead of erroring. The relay meters what
 * reaches it either way.
 *
 * A fetch() of the request's own URL from a route Worker goes to the origin —
 * the tunnel, then the relay — not back into this Worker.
 */
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return fetch(request);
    /* A byte range is the player seeking inside one file; not worth a slot. */
    if (request.method !== "GET" || request.headers.has("range")) return fetch(request);

    const cache = caches.default;
    const key = new Request(request.url, { method: "GET" });

    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("X-Edge", "HIT");
      return res;
    }

    const res = await fetch(request);
    /* Only a real segment: a refusal (403/475 from the CDN) or a proxy hiccup
       must not be served to the next viewer for two minutes. */
    const cacheable = res.status === 200 && /\bpublic\b/.test(res.headers.get("cache-control") || "");
    const out = new Response(res.body, res);
    out.headers.set("X-Edge", cacheable ? "MISS" : "BYPASS");
    if (cacheable) ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
