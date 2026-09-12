// GET /api/search?q=Bridgerton&limit=50&page=1
//
// PRIMARY SOURCE (since 2026-09-12): movieboxonline.net's own search backend -
// the shared aoneroom BFF `POST /wefeed-h5api-bff/subject/search`.
// movieboxonline.net has a dramatically richer search index than the old SSR
// page scrapes (~100+ total hits for broad queries vs 12-19 from netnaija's
// search page), which is why it is now the main site.
//
// RESULT ORDER = movieboxonline.net's order, verbatim. The site's own search
// page (https://movieboxonline.net/search-result?keyword=...) calls this BFF
// with EXACTLY this body (observed in the browser network log):
//   {"keyword":"Odyssey","page":1,"perPage":0,"subjectType":0}
// We replicate that request byte-for-byte - same body, same headers - so the
// items come back in the site's own relevance ranking. perPage:0 lets the BFF
// choose its own page size (~5-13 items); sending any other perPage value
// changes BOTH the item count and the tail ordering, so it must stay 0.
// Deeper results come from walking the BFF's own page sequence (page 2, 3,
// ...) - i.e. exactly the items the site would show next if it paginated.
// No sorting of any kind is applied anywhere in this chain.
//
// The BFF search endpoint requires an auth token. Anonymous visitors get one
// for free, exactly like the movieboxonline.net frontend does:
//   1. POST /subject/search-suggest signed with
//      X-Client-Token: <unix-seconds>,<md5(reverse(unix-seconds-string))>
//      plus an EMPTY Authorization header
//   2. the response carries an `x-user` header whose JSON contains a 90-day
//      anonymous JWT
//   3. POST /subject/search with `Authorization: Bearer <jwt>`
// The suggest call also returns the "try also" suggestion words, which the
// website's search page already knows how to render.
//
// FALLBACK: if the BFF search path fails (endpoint change, token rejection,
// network), fall back to scraping the classic SSR search pages (netnaija
// first - movieboxonline's own SSR page renders 0 items - then
// officialmoviebox, then movieboxonline).

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const API = "https://h5-api.aoneroom.com";
const SITE = "https://movieboxonline.net";

// ---------------------------------------------------------------------------
// Anonymous JWT handling (module scope survives across warm invocations)
//
// The BFF A/B TESTS its search ranking per anonymous uid: the JWT's embedded
// uid decides which ranking variant you see ("ops.search_abt" inside each
// item exposes the experiment ids). Live distribution measured across many
// minted uids: ~75-80% land in the MAJORITY variant, ~20-25% in a minority
// one; the head of the list is stable across variants, the fuzzy tail is
// shuffled. Every movieboxonline.net visitor has their own 90-day `apiToken`
// cookie, so the site's order is per-visitor by design.
//
// We therefore PIN an anonymous JWT that was calibrated to sit in the
// MAJORITY variant (5 of 6 freshly minted uids produced byte-identical
// ordering with it - Odyssey spot check). This makes the API's order match
// what the overwhelming majority of movieboxonline.net visitors - and almost
// certainly THIS deployment's users - see on the site itself. If the pinned
// token is ever rejected or nears expiry, calibrateMajority() re-mints a
// fresh identity that stays in the majority variant (majority vote across 3
// candidates), so the order does not drift into a minority bucket.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";

// Dedicated anonymous identity in the MAJORITY rank bucket
// (uid 8687706835455468792, exp 2026-12-11). Purely anonymous - no account,
// no PII. Refresh by running: node scripts/calibrate-pin.mjs
const PINNED_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjg2ODc3MDY4MzU0NTU0Njg3OTIsImF0cCI6MywiZXh0IjoiMTc4OTE4NTA5MSIsImV4cCI6MTc5Njk2MTA5MSwiaWF0IjoxNzg5MTg0NzkxfQ.Tqn8Ulm3swjwkJcF3mXWkI6JVsFlOLBPsCrGq_XAwsU";

let jwtState = { token: PINNED_JWT, fetchedAt: 0 };

/** Decode a JWT's exp claim (seconds -> ms). 0 when unreadable. */
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

/** POST /subject/search-suggest with a FRESH anonymous identity. Returns the
 *  minted token (does NOT touch jwtState). The response's `x-user` header
 *  carries a freshly minted anonymous 90-day JWT. */
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

/** POST /subject/search-suggest. Returns { token, suggestions } or null.
 *  When called with a valid Bearer there is no x-user at all and the call is
 *  purely the suggestions source ("try also" words), so it never churns the
 *  pinned identity. */
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

/** Mint a fresh identity that lands in the MAJORITY rank bucket. Mints up to
 *  3 candidate tokens, fetches one search page with each, and keeps the
 *  candidate whose result order matches at least one other candidate
 *  (majority vote). With a ~75-80% majority-bucket rate, 3 candidates agree
 *  on the majority order with very high probability, so token rotations
 *  never drift the API into a minority ranking variant. Falls back to the
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
  // Majority vote on non-null order signatures
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
  // Refresh only when the token is within 7 days of its real expiry (the
  // pinned token lasts 90 days; dynamically minted ones too). The refresh
  // goes through calibrateMajority() so the replacement stays in the
  // MAJORITY rank bucket instead of rolling a random variant.
  const exp = jwtExpiryMs(jwtState.token);
  if (exp && Date.now() > exp - 7 * 24 * 3600 * 1000) {
    const t = await calibrateMajority();
    if (t) jwtState = { token: t, fetchedAt: Date.now() };
  }
  return jwtState.token;
}

/** POST /subject/search with the anonymous JWT, using the EXACT body the
 *  movieboxonline.net frontend sends: {keyword, page, perPage: 0,
 *  subjectType: 0}. The BFF picks its own page size (~5-13 items) and its
 *  own relevance ranking - we must not tamper with either. */
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

/** Walk the BFF's own page sequence (page, page+1, ...) with the site's exact
 *  request body until the caller's limit is filled, the index ends, or the
 *  safety cap is hit. Items are appended strictly in response order - this is
 *  what guarantees "exactly as movieboxonline.net". A subjectId-level dedupe
 *  guards against a result drifting across a page boundary between two of
 *  our sequential calls (the BFF's ranking snapshot can rotate server-side). */
async function bffSearch(keyword, page, limit) {
  await ensureJwt();
  const all = [];
  const seen = new Set();
  let total = 0;
  let hasMore = false;
  let anyPageSucceeded = false;
  for (let p = 0; p < MAX_BFF_PAGES; p++) {
    if (all.length >= limit) break; // limit filled - nothing more to fetch
    let res = await searchPage(keyword, page + p);
    if (res === "UNAUTHORIZED") {
      // Token rejected - re-calibrate into the majority bucket and retry.
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
    if (res.items.length === 0 || !res.hasMore) break; // index exhausted
    if (added === 0 && p > 0) break; // page fully overlapped -> stop walking
  }
  if (!anyPageSucceeded) return null; // nothing worked -> SSR fallback
  const items = all.slice(0, limit);
  return { total, hasMore: items.length < all.length ? true : hasMore, items };
}

/** Normalize a BFF search item into the response shape the site frontend
 *  already consumes (same field names as the old SSR scraper output). */
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
// Fallback: classic SSR search page scrape (previous implementation)
// ---------------------------------------------------------------------------
function resolveNuxt(nuxt, obj) {
  // NUXT_DATA stores objects with integer values that reference array indices.
  // This function resolves those references to get actual values.
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(v => resolveNuxt(nuxt, v));

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "number" && val >= 0 && val < nuxt.length) {
      // This is a reference to another array item
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

  // Walk the nuxt array looking for subject-like objects
  for (let i = 0; i < nuxt.length; i++) {
    const item = nuxt[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;

    // Check if this looks like a subject (has subjectId or detailPath)
    const hasSubjectId = "subjectId" in item || "subjectID" in item;
    const hasDetailPath = "detailPath" in item;
    const hasTitle = "title" in item;

    if ((hasSubjectId || hasDetailPath) && hasTitle) {
      // Resolve all references
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

export default async function handler(req, res) {
  const q = (req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 60);
  const page = Math.max(parseInt(req.query.page) || 1, 1);

  if (!q) {
    return res.status(400).json({ error: "Missing q parameter. Example: /api/search?q=Bridgerton" });
  }

  // --- Primary: movieboxonline.net BFF search (rich index + suggestions) ---
  // Results come back in movieboxonline.net's own ranking order, verbatim.
  const [searchRes, sugg] = await Promise.all([bffSearch(q, page, limit), suggest(q)]);
  if (searchRes) {
    const results = searchRes.items.map(normItem).filter(Boolean);
    return res.status(200).json({
      query: q,
      count: results.length,
      total: searchRes.total,
      page,
      hasMore: searchRes.hasMore,
      results,
      suggestions: (sugg?.suggestions || []).slice(0, 8),
      source: "movieboxonline",
    });
  }

  // --- Fallback: SSR search page scrape ---
  const encoded = encodeURIComponent(q);
  const seen = new Set();
  const results = [];

  // netnaija first (its SSR page actually renders results; movieboxonline's
  // SSR search page returns 0 items - its search only works via the BFF).
  const sites = [
    `https://netnaija.film/search-result?keyword=${encoded}`,
    `https://officialmoviebox.com/newWeb/searchResult?keyword=${encoded}`,
    `https://movieboxonline.net/search-result?keyword=${encoded}`,
  ];

  for (const siteUrl of sites) {
    try {
      const r = await fetch(siteUrl, {
        headers: { "User-Agent": UA, "Accept": "text/html" },
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
      if (results.length > 0) break; // Use first site that returns results
    } catch {}
  }

  res.status(200).json({
    query: q,
    count: Math.min(results.length, limit),
    total: results.length,
    page,
    results: results.slice(0, limit),
    suggestions: [],
    source: results.length > 0 ? "ssr-fallback" : "none",
  });
}
