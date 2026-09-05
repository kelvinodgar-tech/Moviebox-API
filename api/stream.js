// GET /api/stream?url=<mp4-url>
// Edge Runtime streaming proxy. Injects Referer header for the video CDN.

export const config = { runtime: 'edge' };

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const ALLOWED_HOSTS = [
  "bcdnxw.hakunaymatata.com", "cacdn.hakunaymatata.com",
  "macdn.aoneroom.com", "pbcdnw.aoneroom.com",
  "pbcdn.aoneroom.com", "pacdn.aoneroom.com",
];

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range",
      "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
    }});
  }

  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) return new Response(JSON.stringify({error:"Missing url"}), {status:400, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});

  let parsed;
  try { parsed = new URL(targetUrl); } catch { return new Response(JSON.stringify({error:"Invalid url"}), {status:400, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}}); }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) return new Response(JSON.stringify({error:"Host not allowed"}), {status:403, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});

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
    if (req.headers.get("range")) upstreamHeaders["Range"] = req.headers.get("range");

    const upstream = await fetch(targetUrl, { headers: upstreamHeaders, redirect: "follow" });

    const respHeaders = new Headers();
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");

    // Forward ALL relevant headers including Content-Length
    const forward = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"];
    for (const h of forward) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }

    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
  } catch (e) {
    return new Response(JSON.stringify({error:e.message}), {status:502, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  }
}
