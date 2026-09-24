/* pf-dl - Cloudflare pass-through worker fronting the PropFlix media relay.
 *
 * Why: the relay lives on a bare host:port with no TLS, so the browser's
 * download UI used to record that host (or a raw IP) as the download source.
 * This worker gives the download a clean https origin - the browser records
 * pf-dl.<account>.workers.dev, the transfer is TLS end-to-end to the edge,
 * and the whole insecure /go mixed-content dance becomes unnecessary.
 *
 * Behavior:
 *  - forwards GET/HEAD/OPTIONS with the Range/UA headers download managers
 *    and players actually need (Referer intentionally dropped: the relay
 *    does not read it, and it would only leak page context);
 *  - streams the relay's response body through untouched (multi-GB movies
 *    pass through with negligible CPU: this worker never buffers);
 *  - passes the relay's renew 302s through UNFOLLOWED (redirect: "manual")
 *    so a paused download's resume chain still reaches the site for a fresh
 *    link and comes back here to complete;
 *  - copies exactly the response headers that matter (attachment naming,
 *    ranges, CORS, no-store).
 *
 * The relay itself stays the only place where bytes are verified (v5 chunked
 * serving) - this worker is a dumb, transparent tube.
 */

const ORIGIN = "http://sftp.fr-node-42.katabump.com:20274"; // PropFlix media relay (hostname: Cloudflare Workers cannot fetch IP-literal origins - error 1003)

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
    return new Response(resp.body, { status: resp.status, headers: out });
  },
};
