// GET /api/download?url=<mp4-url>&filename=Movie.mp4
// Node.js runtime (not Edge) - buffers response to set Content-Length properly.

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const ALLOWED_HOSTS = [
  "bcdnxw.hakunaymatata.com", "cacdn.hakunaymatata.com",
  "macdn.aoneroom.com", "pbcdnw.aoneroom.com",
  "pbcdn.aoneroom.com", "pacdn.aoneroom.com",
];

function sanitizeFilename(name) {
  return (name || "video.mp4").replace(/[^\w.\- ]/g, "").substring(0, 100) || "video.mp4";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    return res.status(204).end();
  }

  const targetUrl = req.query.url;
  const filename = sanitizeFilename(req.query.filename || "video.mp4");

  if (!targetUrl) return res.status(400).json({ error: "Missing url" });
  
  let parsed;
  try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ error: "Invalid url" }); }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) return res.status(403).json({ error: "Host not allowed" });

  try {
    // First do a HEAD request to get Content-Length
    const headResp = await fetch(targetUrl, {
      method: "HEAD",
      headers: {
        "User-Agent": UA,
        "Referer": "https://netnaija.film/",
        "Origin": "https://netnaija.film",
      },
    });
    
    const contentLength = headResp.headers.get("content-length");
    const contentType = headResp.headers.get("content-type") || "video/mp4";
    
    // Set headers
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    // Now stream the actual content
    const upstreamHeaders = {
      "User-Agent": UA,
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      "Referer": "https://netnaija.film/",
      "Origin": "https://netnaija.film",
    };
    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;

    const upstream = await fetch(targetUrl, { headers: upstreamHeaders, redirect: "follow" });
    
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
    }

    // Stream the body
    const reader = upstream.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { res.end(); return; }
      res.write(value);
      return pump();
    });
    await pump();
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e.message });
    else res.end();
  }
}
