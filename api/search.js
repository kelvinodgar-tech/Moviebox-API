// GET /api/search?q=oppenheimer&limit=20
// Searches across multiple data sources: search-suggest, trending (5 pages), and home page.
// Returns combined, deduplicated results with full metadata.

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function hdr() {
  return {
    "User-Agent": UA,
    "Accept": "application/json",
    "X-Client-Info": '{"timezone":"Africa/Lagos"}',
    "Origin": "https://netnaija.film",
    "Referer": "https://netnaija.film/",
  };
}

function norm(s) {
  if (!s || !s.title) return null;
  return {
    title: s.title,
    subjectId: String(s.subjectId || s.id || ""),
    subjectType: s.subjectType,
    detailPath: s.detailPath,
    type: s.subjectType === 1 ? "movie" : (s.subjectType === 2 ? "tv" : "other"),
    genre: s.genre || "",
    imdbRating: s.imdbRatingValue || s.imdbRating || "",
    imdbRatingCount: s.imdbRatingCount || 0,
    country: s.countryName || "",
    description: s.description || "",
    releaseDate: s.releaseDate || "",
    duration: s.duration || 0,
    cover: s.cover?.url || "",
    hasResource: s.hasResource || false,
  };
}

export default async function handler(req, res) {
  const q = (req.query.q || "").toLowerCase().trim();
  const limit = parseInt(req.query.limit) || 20;

  if (!q) {
    return res.status(400).json({ error: "Missing q parameter. Example: /api/search?q=oppenheimer&limit=20" });
  }

  const seen = new Set();
  const results = [];
  const suggestions = [];
  const errors = [];

  // 1. Search suggestions (autocomplete)
  try {
    const r = await fetch(`${API}/wefeed-h5api-bff/subject/search-suggest`, {
      method: "POST",
      headers: { ...hdr(), "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: q, perPage: 10 }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const d = await r.json();
      for (const item of (d.data?.items || [])) {
        if (item.word) suggestions.push(item.word);
        if (item.subject) {
          const n = norm(item.subject);
          if (n && !seen.has(n.subjectId)) {
            seen.add(n.subjectId);
            results.push(n);
          }
        }
      }
    }
  } catch (e) { errors.push("suggest: " + e.message); }

  // 2. Search trending (5 pages x 100 = 500 items)
  try {
    const pages = await Promise.all([1, 2, 3, 4, 5].map(async (page) => {
      try {
        const r = await fetch(`${API}/wefeed-h5api-bff/subject/trending?page=${page}&perPage=100`, {
          headers: hdr(),
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return [];
        const d = await r.json();
        return d.data?.subjectList || d.data || [];
      } catch { return []; }
    }));
    for (const items of pages) {
      for (const m of items) {
        const n = norm(m);
        if (n && !seen.has(n.subjectId)) {
          seen.add(n.subjectId);
          if (n.title.toLowerCase().includes(q)) {
            results.push(n);
          }
        }
      }
    }
  } catch (e) { errors.push("trending: " + e.message); }

  // 3. Search home page (~600 subjects)
  try {
    const r = await fetch(`${API}/wefeed-h5api-bff/home?host=netnaija.film`, {
      headers: hdr(),
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) {
      const text = await r.text();
      try {
        const homeData = JSON.parse(text);
        function walk(o) {
          if (!o || typeof o !== "object") return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (o.subjectId && o.title && !seen.has(String(o.subjectId))) {
            const n = norm(o);
            if (n && n.title.toLowerCase().includes(q)) {
              seen.add(n.subjectId);
              results.push(n);
            }
          }
          Object.values(o).forEach(walk);
        }
        walk(homeData.data);
      } catch {}
    }
  } catch (e) { errors.push("home: " + e.message); }

  // Sort by rating
  results.sort((a, b) => {
    const ra = parseFloat(a.imdbRating) || 0;
    const rb = parseFloat(b.imdbRating) || 0;
    return rb - ra;
  });

  res.status(200).json({
    query: q,
    count: Math.min(results.length, limit),
    total: results.length,
    suggestions: suggestions.slice(0, 10),
    results: results.slice(0, limit),
  });
}
