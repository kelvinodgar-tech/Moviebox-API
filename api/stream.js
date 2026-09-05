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
// Content-Type, Content-Length, Accept-Ranges, Content-Range and status code.
// Range requests are supported so the browser can seek.
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
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Range, Accept-Ranges, Content-Length"
    );
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
    // Send a full set of browser-like headers so the CDN accepts the request.
    // The video CDN (bcdnxw.hakunaymatata.com) returns 426/429 to requests
    // that do not look like a real browser, even with the Referer set.
    const upstreamHeaders = {
      "User-Agent": UA,
      Accept:
        "video/webm,video/ogg,video/*;q=0.9,application/ogg,image/png,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity", // no gzip - video is already compressed
      Origin: "https://netnaija.film",
      Referer: "https://netnaija.film/",
      "Sec-Fetch-Dest": "video",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Ch-Ua":
        '"Not?A_Brand";v="24", "Chromium";v="152"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Linux"',
    };
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const upstream = await fetch(url, {
      headers: upstreamHeaders,
      signal: controller.signal,
      // Force the redirect mode to follow so signed-URL redirects work.
      redirect: "follow",
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
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Range, Accept-Ranges, Content-Length"
    );

    // If the upstream returned an error status, forward the body as-is (it's
    // small) so the client sees the real CDN error.
    if (!upstream.ok && upstream.status !== 206) {
      const errBody = await upstream.text();
      return res.end(errBody || `upstream ${upstream.status}`);
    }

    // Stream the body. Use arrayBuffer for small responses, stream for large.
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = () =>
        reader.read().then(({ done, value }) => {
          if (done) {
            res.end();
            return;
          }
          res.write(value);
          return pump();
        });
      await pump();
    } else {
      res.end();
    }
  } catch (e) {
    if (e.name === "AbortError") {
      return res
        .status(504)
        .json({ error: "Upstream stream timed out. Try again." });
    }
    // If headers have already been sent (partial stream), we cannot send JSON.
    if (res.headersSent) {
      return res.end();
    }
    return res.status(502).json({ error: e.message });
  }
}
