/* pf-dl - Cloudflare pass-through worker fronting the PropFlix media relay.
 *
 * Why: the relay lives on a bare host:port with no TLS, so the browser's
 * download UI used to record that host (or a raw IP) as the download source,
 * and the /go landing page had to be served from an insecure origin just to
 * dodge mixed-content download blocking. This worker gives the whole hand-off
 * a clean https origin: the browser records pf-dl.<account>.workers.dev as
 * the download source, every hop is TLS to the edge, and no mixed-content
 * dance is needed.
 *
 * Behavior:
 *  - forwards GET/HEAD/OPTIONS with the Range/UA headers download managers
 *    and players actually need (Referer intentionally dropped: the relay
 *    does not read it, and it would only leak page context);
 *  - streams the relay's response bodies through untouched (multi-GB movies
 *    pass with negligible CPU: media responses are never buffered);
 *  - passes the relay's renew 302s through UNFOLLOWED (redirect: "manual")
 *    so a paused download's resume chain still reaches the site for a fresh
 *    link and comes back here to complete;
 *  - rewrites the relay's own origin (and the legacy IP/dh origins) to THIS
 *    worker's https origin inside the small /go landing + error HTML pages,
 *    so the landing page's download link stays same-origin https even while
 *    the relay still runs its older http-only code;
 *  - copies exactly the response headers that matter (attachment naming,
 *    ranges, CORS, no-store).
 *
 * The relay itself stays the only place where bytes are verified (v5 chunked
 * serving) - this worker is a dumb, transparent tube.
 */

const ORIGIN = "http://sftp.fr-node-42.katabump.com:20274"; // PropFlix media relay (hostname: Cloudflare Workers cannot fetch IP-literal origins - error 1003)

const LEGACY_ORIGINS = [
  "http://sftp.fr-node-42.katabump.com:20274",
  "http://fr-node-42.katabump.fr:20274",
  "http://193.70.34.27:20274",
];

const FORWARD_REQ_HEADERS = [
  "range",
  "user-agent",
  "accept",
  "if-range",
  "if-none-match",
  "if-modified-since",
];

const FORWARD_RES_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "content-disposition",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "retry-after",
  "referrer-policy",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
];

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      return new Response("method not allowed", { status: 405 });
    }
    const upstream = ORIGIN + incoming.pathname + incoming.search;

    const headers = new Headers();
    for (const h of FORWARD_REQ_HEADERS) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }

    let resp;
    try {
      resp = await fetch(upstream, {
        method: request.method,
        headers,
        redirect: "manual", // the relay's renew bounce must reach the download manager
      });
    } catch (e) {
      return new Response("relay unreachable", { status: 502, headers: { "cache-control": "no-store" } });
    }

    const out = new Headers();
    for (const h of FORWARD_RES_HEADERS) {
      const v = resp.headers.get(h);
      if (v) out.set(h, v);
    }
    if (!out.has("cache-control")) out.set("cache-control", "no-store");

    // Landing/error pages: rewrite the relay's insecure origins to this
    // worker's https origin so the download link the page navigates to is
    // same-origin TLS. These pages are a few KB - buffering them is free.
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html") && request.method !== "HEAD" && resp.body) {
      let html = await resp.text();
      for (const legacy of LEGACY_ORIGINS) {
        if (legacy !== incoming.origin) {
          html = html.split(legacy).join(incoming.origin);
        }
      }
      out.set("content-length", String(new TextEncoder().encode(html).length));
      return new Response(html, { status: resp.status, headers: out });
    }

    return new Response(resp.body, { status: resp.status, headers: out });
  },
};
