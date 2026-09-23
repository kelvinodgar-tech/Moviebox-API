// Standalone media proxy (zero npm dependencies, Node 18+).
//
// The MP4 links the API returns are signed but also referer-gated: browsers
// requesting them directly get 403/429 because the Referer does not point at
// the source site. This server fetches them with the expected headers and
// relays the bytes to the client, with Range passthrough so players and
// download managers can seek and resume.
//
//   node proxy.js
//
// Env:
//   PORT        listen port (default 3000)
//   PROXY_PATH  secret URL prefix; also read from config.json next to this
//               file as {"pathPrefix": "..."}. When set, every route lives
//               under /<prefix>/ and all other paths return 404. Leave it
//               empty to serve at the root.
//
// Routes (under the prefix):
//   GET /                    -> {"status":"ok","uptime":..,"served":..,"bytes":..}
//   GET /stream?url=<enc>    -> inline relay (video players)
//   GET /dl?url=<enc>&name=<file>&dp=<detailPath>
//                             -> attachment with a clean filename
//
// `url` must be a signed link from an API response (the host must be on the
// allowlist). `dp` optionally rebuilds the Referer as the matching play page;
// otherwise the site root is used, which the CDN also accepts.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const SITE = "https://movieboxonline.net";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const ALLOW_SUFFIX = ".hakunaymatata.com";
const CONNECT_TIMEOUT_MS = 20000;

function readPrefix() {
  if (process.env.PROXY_PATH) return String(process.env.PROXY_PATH);
  try {
    const cfg = path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");
    if (fs.existsSync(cfg)) return String(JSON.parse(fs.readFileSync(cfg, "utf8")).pathPrefix || "");
  } catch {}
  return "";
}

const PREFIX = readPrefix().replace(/[^a-z0-9-]/gi, "").toLowerCase();
const ROOT = PREFIX ? `/${PREFIX}` : "";
const startedAt = Date.now();
const stats = { served: 0, bytes: 0, errors: 0 };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
}

function sendJson(req, res, status, body) {
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : JSON.stringify(body) + "\n");
}

/** Clean filename for the Content-Disposition header. */
function sanitizeName(raw, fallbackUrl) {
  let name = String(raw || "")
    .replace(/[\\/\x00-\x1f]+/g, "")
    .replace(/["<>|:]+/g, "")
    .trim();
  if (!name) {
    try {
      name = decodeURIComponent(new URL(fallbackUrl).pathname.split("/").pop() || "");
    } catch {
      name = "";
    }
  }
  if (!name) name = "download.mp4";
  if (name.length > 120) name = name.slice(0, 120);
  return name;
}

async function relay(req, res, query, forceDownload) {
  const rawUrl = String(query.get("url") || "");
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return sendJson(req, res, 400, { error: "Missing or invalid url parameter" });
  }
  if (!/^https?:$/.test(target.protocol) || !target.hostname.endsWith(ALLOW_SUFFIX)) {
    return sendJson(req, res, 403, { error: "Host not allowed" });
  }

  const dp = String(query.get("dp") || "").replace(/[^a-z0-9-]/gi, "");
  const playReferer = dp ? `${SITE}/play/${dp}` : `${SITE}/`;

  const upstreamHeaders = {
    "User-Agent": UA,
    Accept: "*/*",
    Referer: playReferer,
  };
  const range = req.headers.range;
  if (range) upstreamHeaders.Range = range;

  const controller = new AbortController();
  const abortUpstream = () => {
    try {
      controller.abort();
    } catch {}
  };
  res.on("close", abortUpstream);
  const timeout = setTimeout(abortUpstream, CONNECT_TIMEOUT_MS);

  let up;
  try {
    up = await fetch(target, { headers: upstreamHeaders, redirect: "follow", signal: controller.signal });
  } catch (e) {
    clearTimeout(timeout);
    stats.errors++;
    return sendJson(req, res, 502, {
      error: "Upstream fetch failed",
      detail: String(e.cause || e.message || "").slice(0, 200),
    });
  }

  // Retry once with the plain site referer when the CDN rejects the
  // play-page referer (both are accepted in practice; this covers links
  // whose detailPath is not the one the referer was built from).
  if ((up.status === 403 || up.status === 429) && playReferer !== `${SITE}/`) {
    try {
      await up.arrayBuffer();
    } catch {}
    try {
      up = await fetch(target, {
        headers: { ...upstreamHeaders, Referer: `${SITE}/` },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      stats.errors++;
      return sendJson(req, res, 502, {
        error: "Upstream fetch failed",
        detail: String(e.cause || e.message || "").slice(0, 200),
      });
    }
  }
  clearTimeout(timeout);

  stats.served++;
  cors(res);
  const headers = {};
  for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified"]) {
    const v = up.headers.get(h.toLowerCase());
    if (v) headers[h] = v;
  }
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/octet-stream";
  if (!headers["Accept-Ranges"]) headers["Accept-Ranges"] = "bytes";
  if (forceDownload) {
    headers["Content-Disposition"] = `attachment; filename="${sanitizeName(query.get("name"), rawUrl)}"`;
  }
  res.writeHead(up.status, headers);

  if (req.method === "HEAD" || !up.body) {
    res.end();
    return;
  }

  let counted = 0;
  let accounted = false;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      counted += chunk.length;
      cb(null, chunk);
    },
  });
  const account = () => {
    if (!accounted) {
      accounted = true;
      stats.bytes += counted;
    }
  };
  res.on("close", account);

  const body = Readable.fromWeb(up.body);
  body.on("error", () => res.destroy());
  counter.on("error", () => res.destroy());
  body.pipe(counter).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return sendJson(req, res, 400, { error: "Bad request" });
  }

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(req, res, 405, { error: "Method not allowed" });
  }

  try {
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";

    if (!ROOT || pathname === ROOT) {
      return sendJson(req, res, 200, {
        status: "ok",
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        served: stats.served,
        bytes: stats.bytes,
      });
    }
    if (ROOT && pathname !== ROOT && !pathname.startsWith(ROOT + "/")) {
      return sendJson(req, res, 404, { error: "Not found" });
    }

    const sub = ROOT ? pathname.slice(ROOT.length + 1) : pathname.slice(1);
    if (sub === "stream") return await relay(req, res, url.searchParams, false);
    if (sub === "dl") return await relay(req, res, url.searchParams, true);
    return sendJson(req, res, 404, { error: "Not found" });
  } catch (e) {
    try {
      sendJson(req, res, 500, { error: String(e.message || e).slice(0, 200) });
    } catch {}
  }
});

// A failed request must never take the whole process down.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e.message));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const port = parseInt(process.env.PORT || process.env.SERVER_PORT || "3000", 10);
server.listen(port, () => {
  console.log(`media proxy listening on :${port} (prefix ${PREFIX ? "/" + PREFIX : "none"})`);
});
