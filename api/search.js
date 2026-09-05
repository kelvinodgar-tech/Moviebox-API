// GET /api/search?q=oppenheimer&limit=20&page=1
// Search movies and TV shows.
//
// Strategy (the backend's own /subject/search endpoint requires a non-anonymous
// token and rejects anonymous callers with "invalid token", so we cannot use it
// directly). Instead we combine two anonymous-friendly sources and de-duplicate:
//
//   1. /wefeed-h5api-bff/subject/search-suggest  (autocomplete suggestions,
//      works without a token). Used to populate `suggestions` in the response.
//   2. /wefeed-h5api-bff/home?host=netnaija.film (~376 subjects on the home page).
//   3. /wefeed-h5api-bff/subject/trending?perPage=100 (up to 100 trending titles).
//
// Titles from sources 2 and 3 are merged, de-duplicated by subjectId, filtered
// by the query (case-insensitive substring on the title), sorted by IMDB rating,
// and returned with rich fields (cover, rating, genre, country, description,
// releaseDate, etc).
//
// NOTE on /subject/filter: it accepts a `keyword` field but ignores it (the
// totalCount comes back as 1000000 and the items are unrelated to the keyword),
// so it is not useful for keyword search and is intentionally not used here.
//
// Example: /api/search?q=oppenheimer&limit=10
//          /api/search?q=oppenheimer&limit=20&page=1

const API = "https://h5-api.aoneroom.com";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function commonHeaders(referer) {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "X-Client-Info": '{"timezone":"Africa/Lagos"}',
    Origin: "https://netnaija.film",
    Referer: referer || "https://netnaija.film/",
  };
}

function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms || 15000);
  return fetch(url, { ...(opts || {}), signal: controller.signal }).finally(
    () => clearTimeout(timeout)
  );
}

// Normalize a raw subject object (from home or trending) into a clean shape.
function normalizeSubject(s) {
  if (!s) return null;
  const subjectId = String(s.subjectId || "");
  const detailPath = s.detailPath || "";
  if (!subjectId || !detailPath) return null;
  return {
    subjectId,
    subjectType: s.subjectType,
    type: s.subjectType === 1 ? "movie" : "tv",
    title: s.title || "",
    description: s.description || "",
    releaseDate: s.releaseDate || "",
    duration: s.duration || 0,
    genre: s.genre || "",
    cover: s.cover?.url || "",
    countryName: s.countryName || "",
    imdbRatingValue: s.imdbRatingValue || "",
    imdbRatingCount: s.imdbRatingCount || 0,
    subtitles: s.subtitles || "",
    hasResource: !!s.hasResource,
    detailPath,
  };
}

// Walk a home response and collect every subject, de-duplicated by subjectId.
function extractHomeSubjects(homeData) {
  const seen = new Map();
  function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    const norm = normalizeSubject(o);
    if (norm && !seen.has(norm.subjectId)) {
      seen.set(norm.subjectId, norm);
    }
    Object.values(o).forEach(walk);
  }
  walk(homeData);
  return [...seen.values()];
}

// Fetch /home and return its .data (or null on failure).
async function fetchHome() {
  try {
    const resp = await fetchWithTimeout(
      `${API}/wefeed-h5api-bff/home?host=netnaija.film`,
      { headers: commonHeaders("https://netnaija.film/") },
      15000
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.data || null;
  } catch {
    return null;
  }
}

// Fetch /subject/trending and return normalized subjects (or [] on failure).
async function fetchTrending(perPage) {
  try {
    const resp = await fetchWithTimeout(
      `${API}/wefeed-h5api-bff/subject/trending?page=1&perPage=${perPage}`,
      { headers: commonHeaders("https://netnaija.film/") },
      15000
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = data?.data?.subjectList || data?.data || [];
    return items.map(normalizeSubject).filter(Boolean);
  } catch {
    return [];
  }
}

// Fetch /subject/filter (browse). The `keyword` field is IGNORED upstream
// (totalCount comes back as 1000000 and items are unrelated to the keyword),
// so this is only useful as an extra browse pool to expand the searchable
// catalog beyond home + trending. perPage is capped at ~50 by the backend.
// We fetch `pages` pages in parallel and merge the results.
async function fetchFilterPages(pages, perPage) {
  const results = [];
  const promises = [];
  for (let p = 1; p <= pages; p++) {
    promises.push(
      (async () => {
        try {
          const resp = await fetchWithTimeout(
            `${API}/wefeed-h5api-bff/subject/filter`,
            {
              method: "POST",
              headers: {
                ...commonHeaders("https://netnaija.film/"),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ page: p, perPage: perPage || 50 }),
            },
            10000
          );
          if (!resp.ok) return [];
          const data = await resp.json();
          const items = data?.data?.items || [];
          return items.map(normalizeSubject).filter(Boolean);
        } catch {
          return [];
        }
      })()
    );
  }
  const settled = await Promise.all(promises);
  for (const arr of settled) {
    for (const s of arr) results.push(s);
  }
  return results;
}

// Fetch /subject/search-suggest for autocomplete. Returns string[] of words.
async function fetchSuggestions(keyword, perPage) {
  if (!keyword) return [];
  try {
    const resp = await fetchWithTimeout(
      `${API}/wefeed-h5api-bff/subject/search-suggest`,
      {
        method: "POST",
        headers: {
          ...commonHeaders("https://netnaija.film/"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ keyword, perPage: perPage || 10 }),
      },
      10000
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = data?.data?.items || [];
    // Each item has {type, word, subject}. We return the word strings.
    const words = [];
    const seen = new Set();
    for (const it of items) {
      const w = (it.word || "").trim();
      if (w && !seen.has(w.toLowerCase())) {
        seen.add(w.toLowerCase());
        words.push(w);
      }
    }
    return words;
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const q = (req.query.q || "").toLowerCase().trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const rawQuery = req.query.q || "";

  if (!q) {
    return res.status(400).json({
      error:
        "Missing q parameter. Example: /api/search?q=oppenheimer&limit=20&page=1",
    });
  }

  try {
    // Fire all three upstream calls in parallel. Each one degrades gracefully
    // (returns null/[] on failure) so a single upstream hiccup does not break
    // the whole search.
    const [homeData, trending, filterItems, suggestions] = await Promise.all([
      fetchHome(),
      fetchTrending(100),
      fetchFilterPages(2, 50),
      fetchSuggestions(rawQuery, 10),
    ]);

    // Merge home + trending + filter, de-duplicate by subjectId.
    const merged = new Map();
    const homeSubjects = homeData ? extractHomeSubjects(homeData) : [];
    for (const s of homeSubjects) merged.set(s.subjectId, s);
    for (const s of trending) {
      if (!merged.has(s.subjectId)) merged.set(s.subjectId, s);
    }
    for (const s of filterItems) {
      if (!merged.has(s.subjectId)) merged.set(s.subjectId, s);
    }

    // Filter by query (case-insensitive substring on title) and sort by rating.
    const all = [...merged.values()].filter((s) =>
      (s.title || "").toLowerCase().includes(q)
    );
    all.sort((a, b) => {
      const ra = parseFloat(a.imdbRatingValue) || 0;
      const rb = parseFloat(b.imdbRatingValue) || 0;
      if (rb !== ra) return rb - ra;
      // Tie-break: alphabetical by title.
      return (a.title || "").localeCompare(b.title || "");
    });

    const total = all.length;
    const start = (page - 1) * limit;
    const results = all.slice(start, start + limit);

    return res.status(200).json({
      query: rawQuery,
      page,
      limit,
      total,
      count: results.length,
      hasMore: start + limit < total,
      sources: {
        home: homeSubjects.length,
        trending: trending.length,
        filter: filterItems.length,
      },
      suggestions,
      results,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      return res
        .status(504)
        .json({ error: "Upstream fetch timed out. Try again.", q: rawQuery });
    }
    return res.status(500).json({ error: e.message, q: rawQuery });
  }
}
