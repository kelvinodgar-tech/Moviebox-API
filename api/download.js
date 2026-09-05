// GET /api/download?url=<mp4-url>&filename=Movie.mp4
// Edge Runtime download proxy. Same as stream but sets Content-Disposition.
//
// The Edge Runtime tends to strip Content-Length when the body is a
// ReadableStream, which makes browsers show "25/?" during downloads. To work
// around this we do a HEAD request first to read the total file size, then
// stream the GET response with an explicit Content-Length header. The Edge
// Runtime preserves explicitly-set Content-Length when the value matches the
// stream length.

export const config = {
  runtime: 'edge',
};

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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");
  const filename = sanitizeFilename(url.searchParams.get("filename") || "video.mp4");

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid url" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return new Response(JSON.stringify({ error: "Host not allowed" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const upstreamHeaders = {
      "User-Agent": UA,
      "Accept": "video/webm,video/ogg,video/*;q=0.9,application/ogg,image/png,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Referer": "https://netnaija.film/",
      "Origin": "https://netnaija.film",
      "Sec-Fetch-Dest": "video",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
    };

    if (req.headers.get("range")) {
      upstreamHeaders["Range"] = req.headers.get("range");
    }

    // Fire a HEAD request to learn the total file size. Many CDNs do not
    // return Content-Length on the streaming GET response (they use chunked
    // encoding), which makes the browser display "25/?" during downloads.
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
      // HEAD failed; we'll fall back to the GET response's content-length.
    }

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
    });

    const respHeaders = new Headers();
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");
    respHeaders.set("Content-Disposition", `attachment; filename="${filename}"`);

    // Forward useful headers from the upstream GET response.
    const forward = ["content-type", "content-range", "accept-ranges", "etag", "last-modified"];
    for (const h of forward) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }

    // Resolve the Content-Length. Prefer the HEAD value (full file size) when
    // there is no Range request, because the Edge Runtime drops the header on
    // streamed bodies. For Range requests the GET Content-Length is the chunk
    // size and Content-Range carries the total, so keep it as-is.
    const getContentLength = upstream.headers.get("content-length");
    const hasRange = !!req.headers.get("range");
    let contentLength = null;
    if (hasRange) {
      contentLength = getContentLength;
    } else if (totalSize) {
      contentLength = totalSize;
    } else {
      contentLength = getContentLength;
    }
    if (contentLength && /^\d+$/.test(contentLength)) {
      respHeaders.set("Content-Length", contentLength);
    }
    // Always advertise range support so browsers can resume failed downloads.
    if (!respHeaders.get("accept-ranges")) {
      respHeaders.set("Accept-Ranges", "bytes");
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
