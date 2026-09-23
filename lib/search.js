// Search core: POST /api/search?q=<title>&limit=20&page=1
//
// Primary source: movieboxonline.net's own search backend, the shared BFF
// `POST /wefeed-h5api-bff/subject/search`. That index is much richer than the
// old SSR page scrapes (~100+ hits for broad queries vs 12-19).
//
// Result order = movieboxonline.net's order, verbatim. The site's own search
// page calls the BFF with exactly this body (observed in the browser network
// log): {"keyword":...,"page":1,"perPage":0,"subjectType":0}. Any other
// perPage value changes both the item count and the tail ordering, so it must
// stay 0. Deeper results come from walking the BFF's own page sequence.
//
// The BFF search requires an auth token, minted the same way the
// movieboxonline.net frontend does for anonymous visitors:
//   1. POST /subject/search-suggest signed with
//      X-Client-Token: <unix-seconds>,<md5(reverse(unix-seconds-string))>
//   2. the response's `x-user` header carries a 90-day anonymous JWT
//   3. POST /subject/search with `Authorization: Bearer <jwt>`
//
// Fallback: if the BFF path fails, scrape the classic SSR search pages
// (netnaija.film first, then officialmoviebox.com, then movieboxonline.net)
// and parse their __NUXT_DATA__ blobs.

import crypto from "node:crypto";
import { API, SITE, UA, commonHeaders } from "./upstream.js";

// ---------------------------------------------------------------------------
// Anonymous JWT handling (module scope survives across warm invocations).
//
// The BFF A/B-tests its search ranking per anonymous uid: the uid embedded in
// the JWT decides which ranking variant you see (~75-80% of uids land in the
// majority variant; the head of the list is stable, the fuzzy tail is
// shuffled). A dedicated anonymous JWT is pinned so the API always returns
// the same order the site shows the overwhelming majority of visitors. If the
// pinned token is rejected or nears expiry, calibrateMajority() re-mints one
// that stays in the majority bucket (majority vote across 3 candidates).
// ---------------------------------------------------------------------------

// Dedicated anonymous identity in the majority rank bucket
// (uid 8687706835455468792, exp 2026-12-11). Purely anonymous - no account,
// no PII.
const PINNED_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjg2ODc3MDY4MzU0NTU0Njg3OTIsImF0cCI6MywiZXh0IjoiMTc4OTE4NTA5MSIsImV4cCI6MTc5Njk2MTA5MSwiaWF0IjoxNzg5MTg0NzkxfQ.Tqn8Ulm3swjwkJcF3mXWkI6JVsFlOLBPsCrGq_XAwsU";

let jwtState = { token: PINNED_JWT, fetchedAt: 0 };

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function clientToken() {
  const e = Math.floor(Date.now() / 1000);
  const n = crypto.createHash("md5").update(String(e).split("").reverse().join("")).digest("hex");
  return `${e},${n}`;
}

function bffHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Client-Info": '{"timezone":"Africa/Lagos"}',
    "X-Request-Lang": "en",
    Origin: SITE,
    Referer: SITE + "/",
    ...extra,
  };
}

/** Mint a fresh anonymous JWT (search-suggest with an empty Authorization). */
async function mintToken(keyword) {
  try {
    const r = await fetch(`${API}/wefeed-h5api-bff/subject/search-suggest`, {
      method: "POST",
      headers: bffHeaders({ Authorization: "", "X-Client-Token": clientToken() }),
      body: JSON.stringify({ keyword, perPage: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const xuser = r.headers.get("x-user");
    if (!xuser) return null;
    const token = JSON.parse(xuser).token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/** Fetch "try also" suggestion words. With a valid Bearer there is no x-user
 *  header at all, so this never churns the pinned identity. */
async function suggest(keyword) {
  try {
    const r = await fetch(`${API}/wefeed-h5api-bff/subject/search-suggest`, {
      method: "POST",
      headers: bffHeaders({ Authorization: `Bearer ${jwtState.token}` }),
      body: JSON.stringify({ keyword, perPage: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const words = (data?.data?.items || [])
      .map((i) => i?.word)
      .filter((w) => typeof w === "string" && w.trim());
    return { token: jwtState.token, suggestions: [...new Set(words)].slice(0, 10) };
  } catch {
    return null;
  }
}

/** Mint a fresh identity that lands in the MAJORITY rank bucket: mint up to 3
 *  candidate tokens, fetch one search page with each, keep the candidate whose
 *  result order matches at least one other (majority vote). Falls back to the
 *  first successfully minted token when no agreement is found. */
async function calibrateMajority() {
  const candidates = [];
  for (let i = 0; i < 3; i++) {
    const t = await mintToken("movie");
    if (t) candidates.push(t);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const orders = [];
  for (const t of candidates) {
    const sig = await searchPageWith(t, "odyssey", 1);
    orders.push(sig ? sig.items.map((i) => String(i?.subjectId || "")).join(",") : null);
  }
  const counts = new Map();
  for (const sig of orders) if (sig) counts.set(sig, (counts.get(sig) || 0) + 1);
  let bestSig = null, bestN = 0;
  for (const [sig, n] of counts) if (n > bestN) { bestSig = sig; bestN = n; }
  if (bestN >= 2) {
    const idx = orders.indexOf(bestSig);
    if (idx >= 0) return candidates[idx];
  }
  return candidates[0];
}

async function ensureJwt() {
  if (!jwtState.token) {
    const t = await calibrateMajority();
    if (t) jwtState = { token: t, fetchedAt: Date.now() };
    return jwtState.token;
  }
  // Refresh only when the token is within 7 days of its real expiry.
  const exp = jwtExpiryMs(jwtState.token);
  if (exp && Date.now() > exp - 7 * 24 * 3600 * 1000) {
    const t = await calibrateMajority();
    if (t) jwtState = { token: t, fetchedAt: Date.now() };
  }
  return jwtState.token;
}

const MAX_BFF_PAGES = 10; // safety cap for the page walk

async function searchPage(keyword, page) {
  return searchPageWith(jwtState.token, keyword, page);
}

async function searchPageWith(token, keyword, page) {
  if (!token) return null;
  try {
    const r = await fetch(`${API}/wefeed-h5api-bff/subject/search`, {
      method: "POST",
      headers: bffHeaders({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify({ keyword, page, perPage: 0, subjectType: 0 }),
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 401 || r.status === 403) return "UNAUTHORIZED";
    if (!r.ok) return null;
    const data = await r.json();
    const items = data?.data?.items;
    if (!Array.isArray(items)) return null;
    return {
      total: data?.data?.pager?.totalCount ?? items.length,
      hasMore: !!data?.data?.pager?.hasMore,
      items,
    };
  } catch {
    return null;
  }
}

/** Walk the BFF's own page sequence until the limit is filled or the index
 *  ends. Items are appended strictly in response order; a subjectId-level
 *  dedupe guards against a result drifting across a page boundary. */
async function bffSearch(keyword, page, limit) {
  await ensureJwt();
  const all = [];
  const seen = new Set();
  let total = 0;
  let hasMore = false;
  let anyPageSucceeded = false;
  for (let p = 0; p < MAX_BFF_PAGES; p++) {
    if (all.length >= limit) break;
    let res = await searchPage(keyword, page + p);
    if (res === "UNAUTHORIZED") {
      const t = await calibrateMajority();
      jwtState = { token: t, fetchedAt: Date.now() };
      if (!jwtState.token) break;
      res = await searchPage(keyword, page + p);
      if (res === "UNAUTHORIZED" || res === null) break;
    }
    if (res === null || res === undefined) {
      if (p === 0) return null; // primary source broken -> SSR fallback
      break; // later page failed -> serve what we already have
    }
    anyPageSucceeded = true;
    total = res.total;
    hasMore = res.hasMore;
    let added = 0;
    for (const item of res.items) {
      const id = String(item?.subjectId || item?.id || item?.detailPath || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(item);
      added++;
    }
    if (res.items.length === 0 || !res.hasMore) break;
    if (added === 0 && p > 0) break;
  }
  if (!anyPageSucceeded) return null;
  const items = all.slice(0, limit);
  return { total, hasMore: items.length < all.length ? true : hasMore, items };
}

/** Normalize a BFF search item into the public response shape. */
function normItem(s) {
  if (!s) return null;
  return {
    title: s.title || "",
    subjectId: String(s.subjectId || s.id || ""),
    subjectType: s.subjectType,
    detailPath: s.detailPath || "",
    type: s.subjectType === 1 ? "movie" : s.subjectType === 2 ? "tv" : "other",
    genre: s.genre || "",
    imdbRating: s.imdbRatingValue || s.imdbRating || "",
    imdbRatingValue: s.imdbRatingValue || "",
    imdbRatingCount: s.imdbRatingCount || 0,
    country: s.countryName || "",
    description: s.description || "",
    releaseDate: s.releaseDate || "",
    duration: s.duration || 0,
    cover: s.cover?.url || (typeof s.cover === "string" ? s.cover : "") || "",
    hasResource: s.hasResource || false,
  };
}

// ---------------------------------------------------------------------------
// Fallback: classic SSR search page scrape (__NUXT_DATA__ parsing)
// ---------------------------------------------------------------------------

function resolveNuxt(nuxt, obj) {
  // NUXT_DATA stores objects whose integer values reference array indices.
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => resolveNuxt(nuxt, v));

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "number" && val >= 0 && val < nuxt.length) {
      const resolved = nuxt[val];
      if (typeof resolved === "object" && resolved !== null) {
        result[key] = resolveNuxt(nuxt, resolved);
      } else {
        result[key] = resolved;
      }
    } else if (typeof val === "object" && val !== null) {
      result[key] = resolveNuxt(nuxt, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function extractSubjectsFromNuxt(nuxt) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < nuxt.length; i++) {
    const item = nuxt[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const hasSubjectId = "subjectId" in item || "subjectID" in item;
    const hasDetailPath = "detailPath" in item;
    const hasTitle = "title" in item;
    if ((hasSubjectId || hasDetailPath) && hasTitle) {
      const resolved = resolveNuxt(nuxt, item);
      if (resolved.title && resolved.detailPath) {
        const sid = String(resolved.subjectId || resolved.id || resolved.detailPath);
        if (!seen.has(sid)) {
          seen.add(sid);
          const norm = normItem(resolved);
          if (norm) results.push(norm);
        }
      }
    }
  }
  return results;
}

/** Entry point. params: { q, limit, page } -> { status, body }. */
export async function run(params) {
  const q = String(params.q || "").trim();
  const limit = Math.min(parseInt(params.limit) || 20, 60);
  const page = Math.max(parseInt(params.page) || 1, 1);

  if (!q) {
    return { status: 400, body: { error: "Missing q parameter. Example: /api/search?q=one+piece" } };
  }

  // Primary: movieboxonline.net BFF search (rich index + suggestions).
  const [searchRes, sugg] = await Promise.all([bffSearch(q, page, limit), suggest(q)]);
  if (searchRes) {
    const results = searchRes.items.map(normItem).filter(Boolean);
    return {
      status: 200,
      body: {
        query: q,
        count: results.length,
        total: searchRes.total,
        page,
        hasMore: searchRes.hasMore,
        results,
        suggestions: (sugg?.suggestions || []).slice(0, 8),
        source: "movieboxonline",
      },
    };
  }

  // Fallback: SSR search page scrape.
  const encoded = encodeURIComponent(q);
  const seen = new Set();
  const results = [];
  const sites = [
    `https://netnaija.film/search-result?keyword=${encoded}`,
    `https://officialmoviebox.com/newWeb/searchResult?keyword=${encoded}`,
    `https://movieboxonline.net/search-result?keyword=${encoded}`,
  ];
  for (const siteUrl of sites) {
    try {
      const r = await fetch(siteUrl, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const html = await r.text();
      const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) continue;
      const nuxt = JSON.parse(m[1]);
      const subjects = extractSubjectsFromNuxt(nuxt);
      for (const s of subjects) {
        if (s && s.title && !seen.has(s.subjectId)) {
          seen.add(s.subjectId);
          results.push(s);
        }
      }
      if (results.length > 0) break;
    } catch {}
  }

  return {
    status: 200,
    body: {
      query: q,
      count: Math.min(results.length, limit),
      total: results.length,
      page,
      results: results.slice(0, limit),
      suggestions: [],
      source: results.length > 0 ? "ssr-fallback" : "none",
    },
  };
}
