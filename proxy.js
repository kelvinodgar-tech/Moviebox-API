// Standalone media proxy v5 (zero npm dependencies, Node 18+).
//
// The MP4 links the API returns are signed but also referer-gated: browsers
// requesting them directly get 403/429 because the Referer does not point at
// the source site. This server fetches them with the expected headers and
// relays the bytes to the client, with Range passthrough so players and
// download managers can seek and resume.
//
//   node index.js        (on the hosting container; repo copy: proxy.js)
//
// Env:
//   PORT        listen port (default 3000)
//   PROXY_PATH  secret URL prefix; also read from config.json next to this
//               file as {"pathPrefix": "...", "linkKey": "<64 hex chars>"}.
//               When set, every route lives under /<prefix>/ and all other
//               paths return 404. Leave it empty to serve at the root.
//
// Routes (under the prefix):
//   GET /                    -> {"status":"ok","uptime":..,"served":..,"bytes":..}
//   GET /stream?url=<enc>    -> inline relay (video players)
//   GET /dl?url=<enc>&name=<file>&dp=<detailPath>
//                             -> attachment with a clean filename
//   GET /rdy?n=<nonce>       -> readiness signal for the landing page
//   GET /go[...]&dh=<origin> -> download landing page (see below)
//
// v2 additions (browser mixed-content fix):
//   GET /go?url=...|u=<token> -> landing page on THIS (insecure) origin that
//                                immediately navigates itself to /dl. Modern
//                                browsers block "mixed content downloads" when
//                                a SECURE page initiates an insecure (http://)
//                                download, but downloads initiated by an
//                                insecure page are plain legacy http and are
//                                served normally.
//   GET /dl?u=<token>        -> same as /dl?url= but with an AES-256-GCM
//   GET /stream?u=<token>       encrypted payload (url+name+dp) so the real
//                                CDN link never appears in any URL a browser
//                                displays (address bar, downloads UI, share
//                                sheets). Tokens carry a timestamp and expire
//                                after TOKEN_TTL_MS. Plaintext ?url= stays
//                                supported for trusted server-side callers.
//
// v3 additions (auto-return landing page):
//   GET /go accepts `back=<path>` (plaintext) or a `b` field inside the
//   token: the PropFlix path to return the user to after the download
//   starts. The landing page fires the download, watches a readiness signal
//   (/rdy?n=<nonce>, recorded when the /dl response headers are written) and
//   counts down 3 seconds before sending the user back. The signal keeps the
//   auto-return from ever cancelling a download whose headers have not been
//   handed to the browser yet.
//
// v4 additions (download integrity + host hiding):
//   1) SIZE TRANSPARENCY, ALWAYS. A response without a total size lets a
//      dropped connection (phone sleeping, network switch) finalize a
//      TRUNCATED file as "download complete" - the exact corruption reported
//      when phones lock mid-download. The relay now guarantees a total:
//        - 206 answers get Content-Range plus a computed Content-Length
//          (some CDNs omit the length on range slices);
//        - a 200 answer without Content-Length triggers a 1-byte probe
//          (bytes=0-0) to learn the total, then a re-fetch that serves
//          exact sizes.
//   2) SHORTFALL GUARD. When the upstream ends cleanly but the bytes piped
//      fall short of the promised Content-Length, the socket is DESTROYED
//      instead of cleanly ended, so the browser's download manager sees an
//      aborted transfer and retries with a Range request instead of writing
//      a truncated-but-"complete" (corrupt) file.
//   3) HOSTNAME DOWNLOADS (dh=). The browser download UI records the host of
//      the /dl URL. Browsers never https-upgrade IP literals, but they DO
//      upgrade http hostnames navigated from SECURE pages; the landing page
//      (insecure origin) is exempt, so /go now hands /dl to a chosen
//      HOSTNAME origin (`dh`, e.g. http://node.host.tld:port) and keeps the
//      IP form as an automatic fallback: the download then shows the
//      hostname as its source instead of a raw IP address. The landing page
//      probes the hostname with a 1-byte range request first and falls back
//      to the IP form whenever the probe does not answer.
//
// `url` must be a signed link from an API response (the host must be on the
// allowlist). `dp` optionally rebuilds the Referer as the matching play page;
// otherwise the site root is used, which the CDN also accepts.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const SITE = "https://movieboxonline.net";
const HOME = process.env.RENEW_ORIGIN || "https://propflix.name.ng"; // auto-return target origin for /go + renew-redirect base
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const ALLOW_SUFFIX = process.env.CDN_ALLOW_SUFFIX || ".hakunaymatata.com";
const CONNECT_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 15000;
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // nominal link lifetime (renew keeps older tokens usable)
const RENEW_TTL_MS = 72 * 60 * 60 * 1000; // hard stop: links this old must be re-clicked on the site
const READY_TTL_MS = 15 * 60 * 1000; // nonce -> started records live this long

/* ===== v5: verified chunked serving ======================================
 * Live diagnosis (2026-09-24): the CDN intermittently answers an open-ended
 * ranged request (bytes=X-) with PERFECT headers (206, correct Content-Range,
 * correct Content-Length) but a body whose bytes are NOT the file's bytes at
 * X. A browser that pauses a download and resumes appends those wrong bytes
 * at the pause offset: the file reaches its full size, "completes", and then
 * plays corrupt / stops part-way - exactly the owner-reported bug. Bounded
 * ranges (bytes=X-Y) tested correct every time.
 *
 * So v5 NEVER sends the CDN an open-ended range. Every transfer is served in
 * bounded chunks, and every chunk is VERIFIED before its bytes are trusted:
 *   - the chunk response must be 206 with Content-Range starting exactly at
 *     the requested offset, and must deliver exactly the requested length;
 *   - the chunk's first VERIFY_BYTES are re-fetched in an independent tiny
 *     bounded request and compared - a mismatching body (the corruption
 *     signature) triggers a retry on a fresh connection;
 *   - a chunk that ends short is re-fetched for just the missing tail;
 *   - exhausted retries destroy the client socket (never a clean end): the
 *     download manager then restarts/resumes instead of finalizing a file
 *     whose bytes were never verified.
 */
const CHUNK_SIZE = 16 * 1024 * 1024; // upstream slices are fetched in 16 MiB bounded ranges
const VERIFY_BYTES = 64 * 1024; // head of each chunk is cross-checked against an independent fetch (capped)
const CHUNK_RETRIES = 3; // fresh-connection retries per chunk before giving up
const STREAM_IDLE_MS = 5000; // no upstream data for this long => treat the body as ended (tail-refetch)

function readConfig() {
  const out = { pathPrefix: "", linkKey: "" };
  try {
    const cfg = path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");
    if (fs.existsSync(cfg)) {
      const parsed = JSON.parse(fs.readFileSync(cfg, "utf8"));
      out.pathPrefix = String(parsed.pathPrefix || "");
      out.linkKey = String(parsed.linkKey || "");
    }
  } catch {}
  return out;
}

const CONFIG = readConfig();
const PREFIX = (process.env.PROXY_PATH || CONFIG.pathPrefix)
  .replace(/[^a-z0-9-]/gi, "")
  .toLowerCase();
const ROOT = PREFIX ? `/${PREFIX}` : "";
const LINK_KEY_HEX = (process.env.LINK_KEY || CONFIG.linkKey).replace(/[^0-9a-f]/gi, "");
const LINK_KEY =
  LINK_KEY_HEX.length === 64 ? Buffer.from(LINK_KEY_HEX, "hex") : null;
const startedAt = Date.now();
const stats = { served: 0, bytes: 0, errors: 0, go: 0, shortfalls: 0, chunkRetries: 0, chunkErrors: 0, verifyMismatches: 0 };

/* ===== download-started registry (nonce -> timestamp) ==================== */
const startedNonces = new Map();

function markStarted(nonce) {
  if (!nonce) return;
  if (startedNonces.size > 1000) {
    const cutoff = Date.now() - READY_TTL_MS;
    for (const [k, t] of startedNonces) {
      if (t < cutoff) startedNonces.delete(k);
      else break; // Map iterates in insertion order; old entries come first
    }
  }
  startedNonces.set(nonce, Date.now());
}

function isStarted(nonce) {
  const t = startedNonces.get(nonce);
  if (t === undefined) return false;
  if (Date.now() - t > READY_TTL_MS) {
    startedNonces.delete(nonce);
    return false;
  }
  return true;
}

/* ===== AES-256-GCM link tokens ========================================== */
/* payload: {u:"https://cdn...", n:"File.mp4", d:"detailPath", b:"/download/x",
 *           t:1690000000000, c:"/api/dl?title=...&res=...&variant=..."}
 * token:   base64url(iv[12] || ciphertext+tag)
 * Both sides (this server and the site backend) share the 32-byte key.
 *
 * `c` is the calling site's download-coordinate path: when the CDN link
 * behind the token goes stale (paused download resumed hours later), the
 * relay 302s the download manager to SITE + c so it re-resolves a FRESH
 * link and the paused download completes instead of dying half-written. */

function sealToken(payload) {
  if (!LINK_KEY) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", LINK_KEY, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64url");
}

function openToken(token) {
  if (!LINK_KEY || !token) return null;
  try {
    const raw = Buffer.from(String(token), "base64url");
    if (raw.length < 12 + 16 + 10) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", LINK_KEY, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    const payload = JSON.parse(pt.toString("utf8"));
    if (typeof payload.u !== "string") return null;
    if (typeof payload.t !== "number") return null;
    // Past the nominal TTL the CDN link is usually stale but not always -
    // keep the token usable (the upstream fetch decides) up to RENEW_TTL,
    // so long-paused downloads can still self-heal via the renew redirect.
    if (Date.now() - payload.t > RENEW_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Resolve the relay target from either a token or plaintext params. */
function resolveTarget(query) {
  const token = query.get("u");
  if (token) {
    const payload = openToken(token);
    if (payload) {
      return {
        url: payload.u,
        name: typeof payload.n === "string" ? payload.n : "",
        dp: typeof payload.d === "string" ? payload.d : "",
        back: typeof payload.b === "string" ? payload.b : "",
        renew: typeof payload.c === "string" && /^\/[a-z0-9/._?&=%-]*$/i.test(payload.c) ? payload.c : "",
        via: "token",
      };
    }
    return { error: "bad token" };
  }
  const url = String(query.get("url") || "");
  if (!url) return { error: "missing url" };
  return {
    url,
    name: String(query.get("name") || ""),
    dp: String(query.get("dp") || ""),
    back: String(query.get("back") || ""),
    renew: "",
    via: "plain",
  };
}

/** 302 to the calling site's re-resolve endpoint. The browser download
 * manager follows the chain (site re-resolves -> 302 back to a FRESH relay
 * link) so a paused download resumes seamlessly even after the signed CDN
 * link behind the token expired - instead of failing and leaving a
 * half-written file that plays corrupt up to the pause point. */
function renewRedirect(req, res, renewPath) {
  const base = String(HOME).replace(/\/+$/, "");
  const sep = renewPath.includes("?") ? "&" : "?";
  res.writeHead(302, {
    Location: base + renewPath + sep + "auto=1",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  return res.end();
}

/** PropFlix-internal return path for the /go auto-return. Strict whitelist:
 * only /download/... or /title/... paths (1-3 slug segments, optional clean
 * query). Defense in depth - the site backend applies the same rule. */
function sanitizeBackPath(raw) {
  const s = String(raw || "");
  // /download/{slug}, /download/{slug}/{season}/{episode}, /title/{slug} (+ optional clean query)
  if (!/^\/(download|title)(\/[a-z0-9._-]+){1,3}(\?[a-z0-9._&=%-]*)?$/i.test(s)) return "";
  if (s.length > 200) return "";
  return s;
}

/** Preferred download origin for /go's dh param: a plain http or https
 * origin (scheme + host[:port]) and nothing else - no userinfo, path or
 * query. https origins are how the Cloudflare pass-through worker fronts the
 * relay (see the pf-dl worker in the Moviebox-API repo): the browser then
 * records the worker's hostname as the download source, and the download
 * itself is TLS - no mixed-content dance needed at all. */
function sanitizeOrigin(raw) {
  const s = String(raw || "").trim();
  if (!/^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/i.test(s)) return "";
  if (s.length > 100) return "";
  return s;
}

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

/** Small friendly HTML page shown when the CDN refuses a link (usually an
 * expired signed URL). Raw upstream error bodies are useless to humans. */
function sendHtmlError(req, res, status, title, detail) {
  cors(res);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><style>` +
      `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e7ecf3;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}` +
      `.card{max-width:420px;margin:20px;padding:28px 26px;background:#151a24;border:1px solid #2a3345;border-radius:16px;text-align:center}` +
      `h1{font-size:17px;margin:0 0 10px}p{margin:0;color:#9aa7ba;font-size:13.5px}` +
      `a{display:inline-block;margin-top:18px;padding:10px 22px;background:#22c55e;color:#04140a;font-weight:700;border-radius:10px;text-decoration:none;font-size:14px}` +
      `</style></head><body><div class="card"><h1>${title}</h1><p>${detail}</p>` +
      `<a href="javascript:history.back()">Go back</a></div></body></html>`,
  );
}

/** Landing page: this document lives on an insecure origin, so a download
 * started from it is a plain legacy http download rather than mixed content.
 * It picks the /dl URL to use (hostname form when `dh` was given and probes
 * fine, the request origin otherwise), hands off to it, watches the
 * readiness signal and AUTO-RETURNS the user ~3 seconds after the download
 * actually starts. It never auto-returns while the download start is still
 * pending, and after 12 slow seconds it surfaces a manual retry button. */
function sendLanding(req, res, dlHref, dlFallback, probeUrl, filename, backPath, rdyUrl) {
  stats.go++;
  const safeName = String(filename || "your file").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
  );
  const backUrl = backPath ? HOME + backPath : "";
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  res.end(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Downloading ${safeName}</title>` +
      // No-JS path: after 4s go straight to the guaranteed (request-origin)
      // /dl form. Browsers with JS never see this (noscript).
      `<noscript><meta http-equiv="refresh" content="4;url=${dlFallback}"></noscript>` +
      `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e7ecf3;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}` +
      `.card{max-width:420px;margin:20px;padding:30px 28px;background:#151a24;border:1px solid #2a3345;border-radius:16px;text-align:center}` +
      `.brand{font-size:20px;font-weight:800;letter-spacing:.02em}.brand span{color:#22c55e}` +
      `.file{margin:10px 0 4px;font-size:15px;font-weight:600;color:#e7ecf3;word-break:break-word}` +
      `.note{margin:0;color:#9aa7ba;font-size:13.5px}` +
      `.spin{margin:18px auto 6px;width:28px;height:28px;border:3px solid #2a3345;border-top-color:#22c55e;border-radius:50%;animation:r 1s linear infinite}` +
      `@keyframes r{to{transform:rotate(360deg)}}` +
      `a.retry{display:none;margin-top:16px;padding:10px 22px;background:#22c55e;color:#04140a;font-weight:700;border-radius:10px;text-decoration:none;font-size:14px}` +
      `</style></head><body><div class="card">` +
      `<div class="brand">Prop<span>Flix</span></div>` +
      `<div class="file">${safeName}</div>` +
      `<div class="spin"></div>` +
      `<p class="note">Your download is starting...</p>` +
      `<a class="retry" href="${dlFallback}">Tap here if it does not start</a>` +
      `<script>(function(){` +
      `var DL=${JSON.stringify(dlHref)},FB=${JSON.stringify(dlFallback)},PR=${JSON.stringify(probeUrl || "")},RDY=${JSON.stringify(rdyUrl)},BACK=${JSON.stringify(backUrl)};` +
      `var note=document.querySelector('.note');` +
      `function say(t){if(note)note.textContent=t}` +
      // 1) start the download: prefer the hostname form (nicer source host in
      //    the browser's download UI) when its probe answers, else the
      //    request-origin form. One navigation, never twice.
      `var gone=false;function nav(h){if(gone)return;gone=true;try{location.replace(h)}catch(e){}}` +
      `if(PR){try{` +
      `fetch(PR,{headers:{Range:'bytes=0-0'}}).then(function(r){nav(r&&r.ok?DL:FB)}).catch(function(){nav(FB)});` +
      `setTimeout(function(){nav(FB)},5000)` +
      `}catch(e){nav(FB)}}else{nav(DL)}` +
      // 2) readiness watch: only return once the attachment headers were served
      `var done=false,poller=null,fails=0;` +
      `function goBack(){if(done)return;done=true;` +
      `try{window.close()}catch(e){}` +
      `setTimeout(function(){try{location.replace(BACK||${JSON.stringify(HOME + "/")})}catch(e){}},400)}` +
      `function tick(n){say('Download started \\u2014 taking you back in '+n+'...');` +
      `if(n>1)setTimeout(function(){tick(n-1)},1000);else setTimeout(goBack,1000)}` +
      `function started(){if(done)return;if(poller)clearInterval(poller);tick(3)}` +
      `try{poller=setInterval(function(){` +
      `fetch(RDY).then(function(r){return r.json()}).then(function(j){fails=0;if(j&&j.started)started()}).catch(function(){fails++});` +
      `if(fails>=10){if(poller)clearInterval(poller);started()}` +
      `},400)}catch(e){started()}` +
      // 3) genuinely slow: surface the manual retry and stay (never kill a
      //    possibly-pending download start by leaving the page)
      `setTimeout(function(){if(done)return;if(poller)clearInterval(poller);` +
      `var a=document.querySelector('a.retry');if(a)a.style.display='inline-block';` +
      `var s=document.querySelector('.spin');if(s)s.style.display='none';` +
      `say('The file server is slow to respond. Tap the green button to try again, or close this tab.')},12000);` +
      `})();</script>` +
      `</div></body></html>`,
  );
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

/** Parse a Content-Range header of the form "bytes S-E/T". */
function parseContentRange(cr) {
  const m = String(cr || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = Number(m[3]);
  if (!(end >= start) || !(total > 0) || end >= total) return null;
  return { start, end, total };
}

/** One upstream fetch with the 403/429 referer retry baked in. */
async function fetchUpstream(target, rangeHeader, playReferer, controller) {
  const headers = {
    "User-Agent": UA,
    Accept: "*/*",
    Referer: playReferer,
    // Probe with an open-ended range even when the client sent none: a 206
    // answer carries Content-Range (total size) and a 200 answer carries
    // Content-Length - either way the response is size-transparent.
    Range: rangeHeader || "bytes=0-",
  };
  let up = await fetch(target, { headers, redirect: "follow", signal: controller.signal });
  if ((up.status === 403 || up.status === 429) && playReferer !== `${SITE}/`) {
    try {
      await up.arrayBuffer();
    } catch {}
    up = await fetch(target, {
      headers: { ...headers, Referer: `${SITE}/` },
      redirect: "follow",
      signal: controller.signal,
    });
  }
  return up;
}

async function relay(req, res, query, forceDownload) {
  const target = resolveTarget(query);
  if (target.error) return sendJson(req, res, 400, { error: target.error });

  let upstreamUrl;
  try {
    upstreamUrl = new URL(target.url);
  } catch {
    return sendJson(req, res, 400, { error: "Missing or invalid url parameter" });
  }
  if (!/^https?:$/.test(upstreamUrl.protocol) || !upstreamUrl.hostname.endsWith(ALLOW_SUFFIX)) {
    return sendJson(req, res, 403, { error: "Host not allowed" });
  }

  const dp = String(target.dp || "").replace(/[^a-z0-9-]/gi, "");
  const playReferer = dp ? `${SITE}/play/${dp}` : `${SITE}/`;
  // Landing-page readiness nonce (harmless for probes/server-side callers).
  const nonce = String(query.get("n") || "").replace(/[^a-f0-9]/gi, "").slice(0, 32);

  const clientRange = req.headers.range || "";
  const isHead = req.method === "HEAD";

  const controller = new AbortController();
  const abortUpstream = () => {
    try {
      controller.abort();
    } catch {}
  };
  res.on("close", abortUpstream);

  /** Stale-link handling BEFORE any byte reaches the client: the CDN refusing
   * the link (403/429 = referer rejected, 404/410 = expired signature) or
   * serving an HTML edge-error as a 200 means the signed URL went stale. With
   * renew coordinates in the token, bounce the download manager to the site
   * for a fresh link (paused downloads then COMPLETE instead of dying
   * half-written); otherwise relay a friendly page, not the upstream noise. */
  const staleRespond = async (up) => {
    try {
      await up.arrayBuffer();
    } catch {}
    stats.errors++;
    if (target.renew) return renewRedirect(req, res, target.renew);
    return sendHtmlError(
      req,
      res,
      503,
      "This download link has expired",
      "The file link was only valid for a couple of hours. Close this tab, reload the download page and click Download again for a fresh link.",
    );
  };

  /* ---- v5 step 1: size probe (bytes=0-0; open-ended ranges NEVER used) ---- */
  let total = null;
  let upMeta = {};
  {
    const probeCtrl = new AbortController();
    const pt = setTimeout(() => probeCtrl.abort(), PROBE_TIMEOUT_MS);
    let probe;
    try {
      probe = await fetchUpstream(upstreamUrl, "bytes=0-0", playReferer, probeCtrl);
    } catch (e) {
      clearTimeout(pt);
      stats.errors++;
      return sendJson(req, res, 502, {
        error: "Upstream fetch failed",
        detail: String(e.cause || e.message || "").slice(0, 200),
      });
    }
    clearTimeout(pt);
    if ([403, 429, 404, 410].includes(probe.status)) {
      return staleRespond(probe);
    }
    {
      const ct = String(probe.headers.get("content-type") || "").toLowerCase();
      if (probe.status === 200 && ct.includes("text/html")) {
        return staleRespond(probe);
      }
    }
    if (probe.status === 206) {
      const pr = parseContentRange(probe.headers.get("content-range"));
      if (pr) total = pr.total;
    } else if (probe.status === 200) {
      const cl = probe.headers.get("content-length");
      if (cl && Number(cl) > 0) total = Number(cl);
    }
    upMeta = {
      contentType: probe.headers.get("content-type"),
      lastModified: probe.headers.get("last-modified"),
      etag: probe.headers.get("etag"),
    };
    try {
      await probe.arrayBuffer();
    } catch {}
  }

  /* ---- v5 step 2: resolve the client's requested slice -------------------- */
  let start = 0;
  let end = null; // null = to the end of the file
  let rangeOk = false;
  {
    const m = String(clientRange).match(/^bytes=(\d*)-(\d*)\s*$/);
    if (clientRange && m && (m[1] || m[2])) {
      rangeOk = true;
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : null;
      } else {
        // suffix range: last N bytes
        const n = Number(m[2]);
        if (total && n > 0) start = Math.max(0, total - n);
      }
    }
  }
  if (total === null) {
    // No total could be determined (CDN ignored the range probe): fall back
    // to the legacy single-stream pass-through. Happens only on CDNs without
    // range support, where byte offsets are meaningless anyway.
    return legacyRelay(req, res, upstreamUrl, clientRange, playReferer, target,
      forceDownload, nonce, controller, abortUpstream, staleRespond);
  }
  if (start >= total) {
    // 416 with a usable Content-Range so download managers self-correct
    res.writeHead(416, {
      "Content-Range": `bytes */${total}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    return res.end();
  }
  if (end === null || end > total - 1) end = total - 1;
  const promised = end - start + 1;

  /* ---- v5 step 3: write headers ------------------------------------------- */
  stats.served++;
  cors(res);
  const headers = {
    "Content-Type": upMeta.contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    // Never let a cache layer store multi-hundred-MB media responses.
    "Cache-Control": "no-store",
  };
  if (upMeta.lastModified) headers["Last-Modified"] = upMeta.lastModified;
  if (upMeta.etag) headers["ETag"] = upMeta.etag;
  if (forceDownload) {
    headers["Content-Disposition"] = `attachment; filename="${sanitizeName(target.name, target.url)}"`;
  }
  if (rangeOk) {
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    headers["Content-Length"] = String(promised);
  } else {
    headers["Content-Length"] = String(total);
  }
  res.writeHead(rangeOk ? 206 : 200, headers);
  // Headers are on the wire: the download now belongs to the browser's
  // download manager - tell the landing page it may send the user back.
  if (forceDownload) markStarted(nonce);

  if (isHead) {
    res.end();
    return;
  }

  /* ---- v5 step 4: verified chunked transfer ------------------------------- */
  let served = 0;
  const fail = () => {
    stats.errors++;
    try {
      res.destroy();
    } catch {}
  };
  /** Write with real backpressure; resolves false when the client is gone. */
  const writeBuf = (buf) =>
    new Promise((resolve) => {
      if (res.destroyed || res.writableEnded) return resolve(false);
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        res.removeListener("close", onClose);
        res.removeListener("drain", onDrain);
        resolve(v);
      };
      const onClose = () => finish(false);
      const onDrain = () => finish(true);
      res.once("close", onClose);
      if (res.write(buf)) {
        finish(true);
      } else {
        res.once("drain", onDrain);
      }
    });

  for (let c0 = start; c0 <= end; ) {
    if (res.destroyed || res.writableEnded) return;
    const c1 = Math.min(c0 + CHUNK_SIZE - 1, end);
    const want = c1 - c0 + 1;

    /* fetch + verify one chunk (fresh connection per attempt) */
    let ok = false;
    let written = 0;
    for (let attempt = 0; attempt <= CHUNK_RETRIES && !ok; attempt++) {
      if (res.destroyed || res.writableEnded) return;
      if (attempt > 0) stats.chunkRetries = (stats.chunkRetries || 0) + 1;
      let up;
      try {
        up = await fetchUpstream(upstreamUrl, `bytes=${c0}-${c1}`, playReferer, controller);
      } catch {
        stats.chunkErrors = (stats.chunkErrors || 0) + 1;
        continue;
      }
      if ([403, 429, 404, 410].includes(up.status)) {
        // Mid-transfer staleness cannot redirect (headers are already on the
        // wire): destroy so the download manager re-requests, and the NEXT
        // relay pass takes the renew bounce before any byte is served.
        try { await up.arrayBuffer(); } catch {}
        stats.chunkErrors = (stats.chunkErrors || 0) + 1;
        fail();
        return;
      }
      {
        const ct = String(up.headers.get("content-type") || "").toLowerCase();
        if (up.status === 200 && ct.includes("text/html")) {
          try { await up.arrayBuffer(); } catch {}
          stats.chunkErrors = (stats.chunkErrors || 0) + 1;
          fail();
          return;
        }
        if (up.status !== 206) {
          // A bounded range must answer 206; a 200 means the CDN ignored the
          // range - retry on a fresh connection before trusting anything.
          try { await up.arrayBuffer(); } catch {}
          stats.chunkErrors = (stats.chunkErrors || 0) + 1;
          continue;
        }
      }
      const cr = parseContentRange(up.headers.get("content-range"));
      if (!cr || cr.start !== c0) {
        try { await up.arrayBuffer(); } catch {}
        stats.chunkErrors = (stats.chunkErrors || 0) + 1;
        continue;
      }

      // Stream through ONE Node Readable (async iterator - no double readers)
      const stream = Readable.fromWeb(up.body);
      const it = stream[Symbol.asyncIterator]();
      const next = idleReader(it, STREAM_IDLE_MS);

      // Peek the chunk head, verify against an independent tiny fetch
      let head = Buffer.alloc(0);
      try {
        while (head.length < VERIFY_BYTES) {
          const r = await next();
          if (r.done || r.idle) break;
          head = Buffer.concat([head, Buffer.from(r.value)]);
        }
      } catch {
        // truncated stream mid-peek: keep whatever arrived (the tail-refetch
        // below continues from `written` once the iterator is exhausted)
      }
      if (head.length === 0) {
        stats.chunkErrors = (stats.chunkErrors || 0) + 1;
        endIter(it)
        continue;
      }
      const headOk = await verifyHead(upstreamUrl, playReferer, controller, c0, head);
      if (!headOk) {
        stats.verifyMismatches = (stats.verifyMismatches || 0) + 1;
        endIter(it)
        continue; // corruption signature: fresh-connection retry
      }

      // Verified: stream this chunk (head first, exact byte count)
      written = 0;
      ok = true;
      const writePiece = async (piece) => {
        const room = want - written;
        if (room <= 0) return true;
        const out = piece.length > room ? piece.subarray(0, room) : piece;
        written += out.length;
        served += out.length;
        stats.bytes += out.length;
        return writeBuf(out);
      };
      if (!(await writePiece(head))) { endIter(it); return; }
      while (written < want) {
        if (res.destroyed || res.writableEnded) { endIter(it); return; }
        let r;
        try {
          r = await next();
        } catch {
          break; // upstream stream error: fall into the tail-refetch below
        }
        if (r.done || r.idle) break; // ended, errored or stalled: tail-refetch
        if (!(await writePiece(Buffer.from(r.value)))) { endIter(it); return; }
      }
      // Short body (upstream ended early / errored): fetch JUST the missing
      // tail as fresh bounded ranges and keep going; never write unverified
      // gaps and never finalize short.
      while (written < want) {
        if (res.destroyed || res.writableEnded) return;
        const missingFrom = c0 + written;
        const missingTo = c1;
        let tailUp = null;
        for (let t = 0; t <= CHUNK_RETRIES && !tailUp; t++) {
          try {
            const tu = await fetchUpstream(upstreamUrl, `bytes=${missingFrom}-${missingTo}`, playReferer, controller);
            if (tu.status === 206) {
              const tcr = parseContentRange(tu.headers.get("content-range"));
              if (tcr && tcr.start === missingFrom) {
                tailUp = tu;
                break;
              }
            }
            try { await tu.arrayBuffer(); } catch {}
          } catch {}
          stats.chunkErrors = (stats.chunkErrors || 0) + 1;
        }
        if (!tailUp) { fail(); return; }
        const tstream = Readable.fromWeb(tailUp.body);
        const tit = tstream[Symbol.asyncIterator]();
        const tnext = idleReader(tit, STREAM_IDLE_MS);
        // verify the tail's head too (it resumes mid-chunk)
        let thead = Buffer.alloc(0);
        try {
          while (thead.length < VERIFY_BYTES && written + thead.length < want) {
            const r = await tnext();
            if (r.done || r.idle) break;
            thead = Buffer.concat([thead, Buffer.from(r.value)]);
          }
        } catch {}
        if (thead.length === 0) {
          stats.chunkErrors = (stats.chunkErrors || 0) + 1;
          endIter(tit)
          continue;
        }
        const tailOk = await verifyHead(upstreamUrl, playReferer, controller, missingFrom, thead);
        if (!tailOk) {
          stats.verifyMismatches = (stats.verifyMismatches || 0) + 1;
          endIter(tit)
          continue;
        }
        if (!(await writePiece(thead))) { endIter(tit); return; }
        while (written < want) {
          if (res.destroyed || res.writableEnded) { endIter(tit); return; }
          let r;
          try {
            r = await tnext();
          } catch {
            break;
          }
          if (r.done || r.idle) break;
          if (!(await writePiece(Buffer.from(r.value)))) { endIter(tit); return; }
        }
        endIter(tit)
      }
      endIter(it)
    }
    if (!ok || written < want) { fail(); return; }
    c0 = c1 + 1;
  }

  // Exact delivery: a clean end is only allowed when every promised byte was
  // verified and written (shortfall => destroy, never finalize truncated).
  if (served < promised) {
    stats.shortfalls++;
    fail();
    return;
  }
  try {
    res.end();
  } catch {}
}

/* ===== v5 helpers ========================================================= */

/** Wrap an async iterator so a read that yields no data within `idleMs`
 * resolves as {idle:true} instead of waiting for the stream's end signal -
 * a CDN (or an intermediary) that truncates a body may hold the socket open
 * for its own keep-alive timeout before signaling end, which would otherwise
 * stall the client transfer for that whole timeout per truncation. The
 * abandoned in-flight next() is harmlessly superseded: the caller treats the
 * body as ended and re-fetches the missing tail on a fresh connection, so no
 * byte is ever served twice or lost. */
const IDLE = Symbol("pf-idle");
function idleReader(it, idleMs) {
  let pending = null;
  return async function next() {
    if (!pending) pending = it.next();
    let timer;
    const idle = new Promise((resolve) => {
      timer = setTimeout(() => resolve(IDLE), idleMs);
    });
    const r = await Promise.race([pending, idle]);
    clearTimeout(timer);
    if (r === IDLE) return { done: false, idle: true };
    pending = null;
    return r;
  };
}

/** End an async iterator WITHOUT awaiting it: .return() on a stream whose
 * underlying connection already died can hang for a full close-timeout, and
 * every millisecond of that would stall the client transfer. Fire-and-forget
 * with an internal catch - the undici body is released either way. */
function endIter(it) {
  try {
    const p = it.return();
    if (p && typeof p.then === "function") p.then(() => {}, () => {});
  } catch {}
}

/** Read at most `max` bytes from a web ReadableStream (reader-based; used
 * only on short-lived verify responses whose body is read exactly once).
 * Returns whatever arrived even when the stream errors mid-read: a CDN that
 * truncates bodies still delivered its honest prefix, and the overlap
 * comparison in verifyHead makes that prefix usable evidence. */
async function readAtMost(webBody, max) {
  if (!webBody) return Buffer.alloc(0);
  let out = Buffer.alloc(0);
  try {
    const reader = webBody.getReader();
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out = Buffer.concat([out, Buffer.from(value)]);
    }
    return out;
  } catch {
    return out;
  }
}

/** Independent bounded fetch whose bytes must agree with `peek` (the head
 * of the chunk we are about to serve). Two independent reads agreeing is the
 * cheapest reliable detector of the wrong-body failure mode. The comparison
 * is on the OVERLAP: a CDN that truncates bodies may shorten either read,
 * and any agreeing prefix still proves the bytes at `offset` are right -
 * while a wrong-body read disagrees from its first bytes. */
async function verifyHead(upstreamUrl, playReferer, controller, offset, peek) {
  const n = Math.min(peek.length, VERIFY_BYTES);
  const vEnd = offset + n - 1;
  try {
    const v = await fetchUpstream(upstreamUrl, `bytes=${offset}-${vEnd}`, playReferer, controller);
    if (v.status !== 206) {
      try { await v.arrayBuffer(); } catch {}
      return v.status === 200 ? false : v.status < 400;
    }
    const vcr = parseContentRange(v.headers.get("content-range"));
    if (!vcr || vcr.start !== offset) {
      try { await v.arrayBuffer(); } catch {}
      return false;
    }
    const vbody = await readAtMost(v.body, n);
    const overlap = Math.min(vbody.length, n);
    if (overlap === 0) return false;
    return vbody.subarray(0, overlap).equals(peek.subarray(0, overlap));
  } catch {
    return false;
  }
}

/** Legacy single-stream relay for range-less CDNs (no total size known). */
async function legacyRelay(req, res, upstreamUrl, clientRange, playReferer, target,
  forceDownload, nonce, controller, abortUpstream, staleRespond) {
  const timeout = setTimeout(abortUpstream, CONNECT_TIMEOUT_MS);
  let up;
  try {
    up = await fetchUpstream(upstreamUrl, clientRange, playReferer, controller);
  } catch (e) {
    clearTimeout(timeout);
    stats.errors++;
    return sendJson(req, res, 502, {
      error: "Upstream fetch failed",
      detail: String(e.cause || e.message || "").slice(0, 200),
    });
  }
  clearTimeout(timeout);
  if ([403, 429, 404, 410].includes(up.status) || (up.status === 200 &&
      String(up.headers.get("content-type") || "").toLowerCase().includes("text/html"))) {
    return staleRespond(up);
  }

  stats.served++;
  cors(res);
  const headers = {};
  for (const h of ["Content-Type", "Last-Modified", "ETag"]) {
    const v = up.headers.get(h.toLowerCase());
    if (v) headers[h] = v;
  }
  headers["Accept-Ranges"] = "bytes";
  headers["Cache-Control"] = "no-store";
  if (forceDownload) {
    headers["Content-Disposition"] = `attachment; filename="${sanitizeName(target.name, target.url)}"`;
  }
  let status = up.status;
  const rangeInfo = up.status === 206 ? parseContentRange(up.headers.get("content-range")) : null;
  const contentLength = up.headers.get("content-length");
  let promised = 0;
  if (status === 206 && rangeInfo) {
    promised = rangeInfo.end - rangeInfo.start + 1;
    headers["Content-Length"] = String(promised);
    headers["Content-Range"] = `bytes ${rangeInfo.start}-${rangeInfo.end}/${rangeInfo.total}`;
    if (!clientRange && rangeInfo.start === 0 && rangeInfo.end === rangeInfo.total - 1) {
      status = 200;
      delete headers["Content-Range"];
      headers["Content-Length"] = String(rangeInfo.total);
    }
  } else if (contentLength && Number(contentLength) > 0) {
    promised = Number(contentLength);
    headers["Content-Length"] = String(promised);
  }
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/octet-stream";
  res.writeHead(status, headers);
  if (forceDownload) markStarted(nonce);
  if (req.method === "HEAD" || !up.body) {
    res.end();
    return;
  }
  let written = 0;
  const body = Readable.fromWeb(up.body);
  const pump = async () => {
    for await (const chunk of body) {
      if (res.destroyed || res.writableEnded) return;
      written += chunk.length;
      stats.bytes += chunk.length;
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    if (res.destroyed || res.writableEnded) return;
    if (promised > 0 && written < promised) {
      stats.shortfalls++;
      stats.errors++;
      res.destroy();
      return;
    }
    res.end();
  };
  body.on("error", () => {
    stats.errors++;
    try {
      res.destroy();
    } catch {}
  });
  pump().catch(() => {
    stats.errors++;
    try {
      res.destroy();
    } catch {}
  });
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
        version: 5,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        served: stats.served,
        bytes: stats.bytes,
        go: stats.go,
        shortfalls: stats.shortfalls,
        chunkRetries: stats.chunkRetries,
        chunkErrors: stats.chunkErrors,
        verifyMismatches: stats.verifyMismatches,
        tokens: LINK_KEY ? "aes-256-gcm" : "off",
      });
    }
    if (ROOT && pathname !== ROOT && !pathname.startsWith(ROOT + "/")) {
      return sendJson(req, res, 404, { error: "Not found" });
    }

    const sub = ROOT ? pathname.slice(ROOT.length + 1) : pathname.slice(1);
    if (sub === "stream") return await relay(req, res, url.searchParams, false);
    if (sub === "dl") return await relay(req, res, url.searchParams, true);
    // Readiness signal for the /go landing page (auto-return timing).
    if (sub === "rdy") {
      const n = String(url.searchParams.get("n") || "").replace(/[^a-f0-9]/gi, "").slice(0, 32);
      return sendJson(req, res, 200, { ok: true, started: isStarted(n) });
    }
    // Landing route: hand the browser an insecure page that starts the
    // download itself (mixed-content download workaround) and then returns
    // the user to PropFlix once the download is underway.
    if (sub === "go") {
      const target = resolveTarget(url.searchParams);
      if (target.error) return sendJson(req, res, 400, { error: target.error });
      let upstreamUrl;
      try {
        upstreamUrl = new URL(target.url);
      } catch {
        return sendJson(req, res, 400, { error: "Missing or invalid url parameter" });
      }
      if (!/^https?:$/.test(upstreamUrl.protocol) || !upstreamUrl.hostname.endsWith(ALLOW_SUFFIX)) {
        return sendJson(req, res, 403, { error: "Host not allowed" });
      }
      // Keep the hand-off URL in the SAME form the caller used: token stays
      // token, plaintext stays plaintext (no CDN URL leakage either way).
      const nonce = crypto.randomBytes(8).toString("hex");
      const dlParams = new URLSearchParams();
      if (url.searchParams.get("u")) dlParams.set("u", url.searchParams.get("u"));
      else {
        dlParams.set("url", target.url);
        if (target.name) dlParams.set("name", target.name);
        if (target.dp) dlParams.set("dp", target.dp);
      }
      dlParams.set("n", nonce);
      const dlPath = (ROOT || "") + "/dl?" + dlParams.toString();
      // Preferred (hostname) origin for the /dl hand-off: the browser's
      // download UI then records the hostname as the source instead of a raw
      // IP. The request origin (as navigated, an IP literal that browsers
      // never https-upgrade) stays the guaranteed fallback.
      const selfOrigin = `http://${req.headers.host || "localhost"}`;
      const dh = sanitizeOrigin(url.searchParams.get("dh"));
      const primary = dh && dh !== selfOrigin ? dh : selfOrigin;
      const dlHref = primary + dlPath;
      const dlFallback = selfOrigin + dlPath;
      // 1-byte probe of the preferred origin (cross-origin fetch is fine: the
      // relay answers CORS GETs). If it does not answer, the page uses the
      // fallback origin instead.
      const probeUrl = primary !== selfOrigin ? primary + (ROOT || "") + "/stream?" + dlParams.toString() : "";
      const display = sanitizeName(target.name, target.url);
      const rdyUrl = (ROOT || "") + "/rdy?n=" + nonce;
      return sendLanding(req, res, dlHref, dlFallback, probeUrl, display, sanitizeBackPath(target.back), rdyUrl);
    }
    return sendJson(req, res, 404, { error: "Not found" });
  } catch (e) {
    try {
      sendJson(req, res, 500, { error: String(e.message || e).slice(0, 200) });
    } catch {}
  }
});

// A failed request must never take the whole process down.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e.message));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", String(e)));

const port = parseInt(process.env.PORT || process.env.SERVER_PORT || "3000", 10);
server.listen(port, () => {
  console.log(`media proxy v5 listening on :${port} (prefix ${PREFIX ? "/" + PREFIX : "none"}, tokens ${LINK_KEY ? "on" : "off"})`);
});
