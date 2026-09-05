// GET /api/stream?url=<mp4-url>
// Proxies a remote MP4 (or other media) URL while injecting the Referer header
// that the CDN (bcdnxw.hakunaymatata.com) requires. Without
// `Referer: https://netnaija.film/` the CDN returns 429 Too Many Requests for
// browser/curl clients.
//
// This endpoint is used by:
//   - the in-page <video> player (so the browser can play MP4s cross-origin),
//   - the Python scraper's `stream_via_proxy()` helper.
//
// It streams the response body (does not buffer the whole file) and forwards
// Content-Type, Content-Length, Accept-Ranges and status code.
//
// Example:
//   /api/stream?url=https%3A%2F%2Fbcdnxw.hakunaymatata.com%2Fresource%2F...mp4%3Fsign%3D...

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const ALLOWED_HOSTS = [
  "bcdnxw.hakunaymatata.com", // video CDN
  "cacdn.hakunaymatata.com", // subtitle CDN
  "macdn.aoneroom.com", // trailer CDN
  "pbcdnw.aoneroom.com", // image CDN
];

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    return res.status(204).end();
  }

  const url = req.query.url;
  if (!url) {
    return res.status(400).json({
      error:
        "Missing url parameter. Example: /api/stream?url=<encoded-media-url>",
    });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid url parameter" });
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({
      error: `Refused to proxy host '${parsed.hostname}'. Only known media CDN hosts are allowed.`,
      allowed: ALLOWED_HOSTS,
    });
  }

  try {
    // Forward Range header so the browser can seek.
    const upstreamHeaders = {
      "User-Agent": UA,
      Accept: "*/*",
      Origin: "https://netnaija.film",
      Referer: "https://netnaija.film/",
    };
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const upstream = await fetch(url, {
      headers: upstreamHeaders,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // Forward status and important headers.
    res.status(upstream.status);
    const forward = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "etag",
      "last-modified",
    ];
    for (const h of forward) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");

    // Stream the body.
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (e) {
    if (e.name === "AbortError") {
      return res
        .status(504)
        .json({ error: "Upstream stream timed out. Try again." });
    }
    return res.status(502).json({ error: e.message });
  }
}
