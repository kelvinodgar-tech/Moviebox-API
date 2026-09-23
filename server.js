// Standalone Node server for the same endpoints the Vercel functions serve.
// Run it anywhere Node 18+ is available (it has zero npm dependencies):
//
//   node server.js            # listens on PORT, default 3000
//
// Routes:
//   GET /                        -> {"status":"ok"}
//   GET /api/search?q=&limit=
//   GET /api/trending?limit=
//   GET /api/details?id=
//   GET /api/movie?id=
//   GET /api/tv?id=&season=&episode=
//   GET /api/subtitles?id=&season=&episode=
//   GET /api/episode-matrix?id=&season=&episode=

import http from "node:http";
import { run as search } from "./lib/search.js";
import { run as trending } from "./lib/trending.js";
import { run as details } from "./lib/details.js";
import { runMovie, runTv } from "./lib/links.js";
import { run as subtitles } from "./lib/subtitles.js";
import { run as episodeMatrix } from "./lib/episode-matrix.js";

const ROUTES = {
  "/api/search": search,
  "/api/trending": trending,
  "/api/details": details,
  "/api/movie": runMovie,
  "/api/tv": runTv,
  "/api/subtitles": subtitles,
  "/api/episode-matrix": episodeMatrix,
};

const startedAt = Date.now();

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(json + "\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { error: "Method not allowed" });
  }

  if (url.pathname === "/") {
    return send(res, 200, {
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  const run = ROUTES[url.pathname];
  if (!run) {
    return send(res, 404, { error: "Not found", endpoints: Object.keys(ROUTES) });
  }

  try {
    const params = Object.fromEntries(url.searchParams.entries());
    const { status, body } = await run(params);
    console.log(`${new Date().toISOString()} ${url.pathname}${url.search} -> ${status}`);
    return send(res, status, body);
  } catch (e) {
    console.error(`${new Date().toISOString()} ${url.pathname} failed:`, e.message);
    return send(res, 500, { error: e.message });
  }
});

// A failed request must never take the whole process down.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e.message));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

const port = parseInt(process.env.PORT || process.env.SERVER_PORT || "3000", 10);
server.listen(port, () => {
  console.log(`moviebox api listening on :${port}`);
});
