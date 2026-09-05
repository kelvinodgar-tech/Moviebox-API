// GET /api/search?q=Bridgerton&limit=20
// Scrapes the actual search pages on netnaija.film, movieboxonline.net, and officialmoviebox.com.
// No login/token needed. Returns full results with covers, ratings, genres.

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// Nuxt's __NUXT_DATA__ is a flat JSON array where object values are indices
// that point to other elements in the same array. This resolver follows those
// references to reconstruct the full object tree.
function nuxtResolve(idx, data, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 12) return null;
  if (typeof idx !== "number" || idx < 0 || idx >= data.length) return idx;

  const val = data[idx];
  if (val === null || val === undefined) return val;
  if (typeof val === "string" || typeof val === "boolean") return val;
  if (typeof val === "number") return val;

  if (Array.isArray(val)) {
    // Typed reference like ["ShallowReactive", index] or ["Reactive", index]
    if (val.length >= 2 && typeof val[0] === "string" && typeof val[1] === "number") {
      return nuxtResolve(val[1], data, depth + 1);
    }
    // Regular array - resolve each element
    const arr = [];
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] === "number") {
        arr.push(nuxtResolve(val[i], data, depth + 1));
      } else {
        arr.push(val[i]);
      }
    }
    return arr;
  }

  if (typeof val === "object") {
    const result = {};
    for (const k of Object.keys(val)) {
      if (typeof val[k] === "number") {
        result[k] = nuxtResolve(val[k], data, depth + 1);
      } else {
        result[k] = val[k];
      }
    }
    return result;
  }

  return val;
}

function norm(s) {
  if (!s) return null;
  return {
    title: String(s.title || ""),
    subjectId: String(s.subjectId || s.id || ""),
    subjectType: s.subjectType,
    detailPath: String(s.detailPath || ""),
    type: s.subjectType === 1 ? "movie" : (s.subjectType === 2 ? "tv" : "other"),
    genre: String(s.genre || ""),
    imdbRating: String(s.imdbRatingValue || s.imdbRating || ""),
    imdbRatingValue: String(s.imdbRatingValue || ""),
    imdbRatingCount: s.imdbRatingCount || 0,
    country: String(s.countryName || ""),
    countryName: String(s.countryName || ""),
    description: String(s.description || ""),
    releaseDate: String(s.releaseDate || ""),
    duration: s.duration || 0,
    cover: s.cover?.url || (typeof s.cover === "string" ? s.cover : "") || "",
    hasResource: s.hasResource || false,
  };
}

function extractSubjectsFromNuxt(data) {
  const results = [];
  const seen = new Set();

  // Walk the flat array and find objects that have subjectId/title/detailPath
  // keys. These are subject (movie/TV) objects. Resolve each one fully.
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (
      item.hasOwnProperty("subjectId") &&
      item.hasOwnProperty("title") &&
      item.hasOwnProperty("detailPath") &&
      item.hasOwnProperty("subjectType")
    ) {
      const resolved = nuxtResolve(i, data, 0);
      if (!resolved || !resolved.title || !resolved.detailPath) continue;
      const sid = String(resolved.subjectId || "");
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        results.push(norm(resolved));
      }
    }
  }
  return results;
}

export default async function handler(req, res) {
  const q = (req.query.q || "").trim();
  const limit = parseInt(req.query.limit) || 20;

  if (!q) {
    return res.status(400).json({ error: "Missing q parameter. Example: /api/search?q=Bridgerton" });
  }

  const encoded = encodeURIComponent(q);
  const seen = new Set();
  const results = [];
  const errors = [];

  const sites = [
    { name: "netnaija", url: `https://netnaija.film/search-result?keyword=${encoded}` },
    { name: "officialmoviebox", url: `https://officialmoviebox.com/newWeb/searchResult?keyword=${encoded}` },
    { name: "movieboxonline", url: `https://movieboxonline.net/search-result?keyword=${encoded}` },
  ];

  const responses = await Promise.allSettled(sites.map(async (site) => {
    const r = await fetch(site.url, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`${site.name}: HTTP ${r.status}`);
    const html = await r.text();

    const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`${site.name}: no NUXT_DATA`);

    const nuxt = JSON.parse(m[1]);
    const subjects = extractSubjectsFromNuxt(nuxt);
    return { site: site.name, subjects };
  }));

  for (const r of responses) {
    if (r.status === "fulfilled" && r.value.subjects.length > 0) {
      for (const s of r.value.subjects) {
        if (s && s.title && s.subjectId && !seen.has(s.subjectId)) {
          seen.add(s.subjectId);
          results.push(s);
        }
      }
    } else if (r.status === "rejected") {
      errors.push(r.reason.message);
    }
  }

  // Rank by relevance:
  //   1. Exact title match (case-insensitive)
  //   2. Starts-with match
  //   3. Contains match (query as substring of title)
  //   4. Partial / fuzzy match (every query token appears in title, in any order)
  // Within the same tier, keep IMDB rating as a secondary sort so the better
  // title wins ties.
  const qLower = q.toLowerCase();
  const qTokens = qLower.split(/\s+/).filter(Boolean);

  function rank(s) {
    const t = String(s.title || "").toLowerCase();
    if (t === qLower) return 0;                       // exact
    if (t.startsWith(qLower)) return 1;               // starts with
    if (t.includes(qLower)) return 2;                 // contains
    if (qTokens.length > 1 && qTokens.every(tok => t.includes(tok))) return 3; // partial
    return 4;                                         // fuzzy / other
  }
  results.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const ia = parseFloat(a.imdbRating) || 0;
    const ib = parseFloat(b.imdbRating) || 0;
    return ib - ia;
  });

  res.status(200).json({
    query: q,
    count: Math.min(results.length, limit),
    total: results.length,
    results: results.slice(0, limit),
    errors: errors.length ? errors : undefined,
  });
}
