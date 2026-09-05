// GET /api/download?url=<mp4-url>&filename=Movie.mp4
// Download proxy. Sets Content-Disposition and forwards Content-Length so
// the browser shows real download progress instead of "25/?".
//
// This uses the Node.js Serverless runtime (not Edge) because the Edge
// Runtime strips Content-Length when the body is a ReadableStream. Node.js
// lets us write the header explicitly and pipe the upstream stream through,
// which preserves Content-Length for the browser.

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const ALLOWED_HOSTS = [
  "bcdnxw.hakunaymatata.com",
  "cacdn.hakunaymatata.com",
  "macdn.aoneroom.com",
  "pbcdnw.aoneroom.com",
  "pbcdn.aoneroom.com",
  "pacdn.aoneroom.com",
];

function sanitizeFilename(name) {
  return (name || "video.mp4").replace(/[^\w.\- ]/g, "").substring(0, 100) || "video.mp4";
}

export const config = {
  maxDuration: 300,
};

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const url = new URL(req.url, "https://example.com");
  const targetUrl = url.searchParams.get("url");
  const filename = sanitizeFilename(url.searchParams.get("filename") || "video.mp4");

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  try {
    const upstreamHeaders = {
      "User-Agent": UA,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Referer": "https://netnaija.film/",
      "Origin": "https://netnaija.film",
    };

    if (req.headers.range) {
      upstreamHeaders["Range"] = req.headers.range;
    }

    // HEAD request to learn the total file size. Many CDNs return chunked
    // encoding on the streaming GET response and omit Content-Length, which
    // makes the browser display "25/?" during downloads.
    let totalSize = null;
    try {
      const headResp = await fetch(targetUrl, {
        method: "HEAD",
        headers: upstreamHeaders,
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      const cl = headResp.headers.get("content-length");
      if (cl && /^\d+$/.test(cl)) totalSize = cl;
    } catch {
      // HEAD failed; fall back to the GET response's content-length.
    }

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: "Upstream error: " + upstream.status });
    }

    // Build response headers.
    const respHeaders = {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    };

    // Forward Content-Range for partial responses.
    const cr = upstream.headers.get("content-range");
    if (cr) respHeaders["Content-Range"] = cr;

    // Resolve the Content-Length. Prefer the HEAD value (full file size)
    // when there is no Range request. For Range requests the GET
    // Content-Length is the chunk size and Content-Range carries the total.
    const getContentLength = upstream.headers.get("content-length");
    const hasRange = !!req.headers.range;
    let contentLength = null;
    if (hasRange) {
      contentLength = getContentLength;
    } else if (totalSize) {
      contentLength = totalSize;
    } else {
      contentLength = getContentLength;
    }
    if (contentLength && /^\d+$/.test(contentLength)) {
      respHeaders["Content-Length"] = contentLength;
    }

    // Write the status line + headers. For Range requests the upstream
    // returns 206; otherwise 200.
    res.writeHead(upstream.status, respHeaders);

    // Pipe the upstream body through. Because we set Content-Length above,
    // Node's HTTP server sends a fixed-length response (not chunked), so
    // the browser knows the total download size.
    const reader = upstream.body.getReader();
    const nodeStream = res;
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          nodeStream.write(Buffer.from(value));
        }
        nodeStream.end();
      } catch (e) {
        try { nodeStream.destroy(); } catch (_) {}
      }
    })();
  } catch (e) {
    if (!res.headersSent) {
      return res.status(502).json({ error: e.message });
    }
    try { res.destroy(); } catch (_) {}
  }
}
