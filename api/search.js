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
// The BFF rank-buckets anonymous visitors: the JWT's embedded uid decides
// which ranking variant you see (verified live: replaying the browser's JWT
// from node reproduces the site's rendered order exactly, while a freshly
// minted uid can land in a different variant - 3 variants observed across 8
// fresh uids, head items stable, fuzzy tail shuffled). Every site visitor has
// their own 90-day `apiToken` cookie, so the site's order is per-visitor.
// To give this API ONE stable, site-faithful order, we PIN a dedicated
// anonymous JWT whose ranking was verified to match movieboxonline.net's
// rendered search page (both "Odyssey" and "One Piece" spot checks, DOM order
// == API order, 21/21 items). If the pinned token is ever rejected, we
// transparently re-bootstrap a fresh anonymous identity (order then follows
// that new uid's variant - still a valid movieboxonline.net ranking).
// ---------------------------------------------------------------------------
import crypto from "node:crypto";

// Dedicated anonymous identity (uid 9004814784999089400, exp 2026-12-09).
// Purely anonymous - no account, no PII. Refresh by minting a new one:
//   node scripts/probe-bff-search2.mjs   (shows the mint flow), or grab the
// `apiToken` cookie value after visiting movieboxonline.net once.
const PINNED_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjkwMDQ4MTQ3ODQ5OTkwODk0MDAsImF0cCI6MywiZXh0IjoiMTc4OTE3ODE3NyIsImV4cCI6MTc5Njk1NDE3NywiaWF0IjoxNzg5MTc3ODc3fQ.o_6kE0pb-R7Ugbw_3WE4iIJhBJFquyynVRaR8_wDjMo";

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

/** POST /subject/search-suggest. Returns { token, suggestions } or null.
 *  When called anonymously (no Bearer / forceAnonymous) the response's
 *  `x-user` header carries a freshly minted anonymous JWT - that is the
 *  bootstrap/refresh path. When called with a valid Bearer there is no
 *  x-user at all and the call is purely the suggestions source ("try also"
 *  words), so it never churns the pinned identity. */
async function suggest(keyword, { forceAnonymous = false } = {}) {
  const anon = forceAnonymous || !jwtState.token;
  try {
    const r = await fetch(`${API}/wefeed-h5api-bff/subject/search-suggest`, {
      method: "POST",
      headers: bffHeaders({
        Authorization: anon ? "" : `Bearer ${jwtState.token}`,
        ...(anon ? { "X-Client-Token": clientToken() } : {}),
      }),
      body: JSON.stringify({ keyword, perPage: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const xuser = r.headers.get("x-user");
    if (xuser) {
      try {
        const token = JSON.parse(xuser).token;
        if (token) jwtState = { token, fetchedAt: Date.now() };
      } catch {}
    }
    const data = await r.json();
    const words = (data?.data?.items || [])
      .map((i) => i?.word)
      .filter((w) => typeof w === "string" && w.trim());
    return { token: jwtState.token, suggestions: [...new Set(words)].slice(0, 10) };
  } catch {
    return null;
  }
}

async function ensureJwt() {
  if (!jwtState.token) {
    await suggest("movie"); // bootstrap a fresh anonymous identity
    return jwtState.token;
  }
  // Refresh only when the token is within 7 days of its real expiry (the
  // pinned token lasts 90 days; dynamically minted ones too). Must go
  // ANONYMOUS: suggest with a valid Bearer returns no x-user, so a Bearer
  // refresh would be a silent no-op. A warm instance therefore keeps ONE
  // stable identity - and ONE stable ranking - until the token nears expiry.
  const exp = jwtExpiryMs(jwtState.token);
  if (exp && Date.now() > exp - 7 * 24 * 3600 * 1000) {
    await suggest("movie", { forceAnonymous: true });
  }
  return jwtState.token;
}

/** POST /subject/search with the anonymous JWT, using the EXACT body the
 *  movieboxonline.net frontend sends: {keyword, page, perPage: 0,
 *  subjectType: 0}. The BFF picks its own page size (~5-13 items) and its
 *  own relevance ranking - we must not tamper with either. Retries once with
 *  a freshly bootstrapped token when the BFF rejects the one we sent. */
const MAX_BFF_PAGES = 10; // safety cap for the page walk

async function searchPage(keyword, page) {
  if (!jwtState.token) return null;
  try {
    const r = await fetch(`${API}/wefeed-h5api-bff/subject/search`, {
      method: "POST",
      headers: bffHeaders({ Authorization: `Bearer ${jwtState.token}` }),
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
      // Token rejected - re-bootstrap once and retry this page.
      jwtState = { token: null, fetchedAt: 0 };
      await suggest(keyword);
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
