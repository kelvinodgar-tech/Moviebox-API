// GET /api/search?q=oppenheimer&limit=20
// Searches using multiple sources: search-suggest (autocomplete), home page, and trending.
// Returns combined, deduplicated results with full metadata.

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function headers() {
  return {
    "User-Agent": UA,
    "Accept": "application/json",
    "X-Client-Info": '{"timezone":"Africa/Lagos"}',
    "Origin": "https://netnaija.film",
    "Referer": "https://netnaija.film/",
  };
}

function normalizeSubject(s) {
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
    cover: s.cover?.url || s.cover || "",
    subtitles: s.subtitles || "",
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

  try {
    // 1. Get search suggestions (autocomplete) from the backend
    const suggestResp = await fetch(`${API}/wefeed-h5api-bff/subject/search-suggest`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: q, perPage: limit }),
      signal: AbortSignal.timeout(8000),
    });
    if (suggestResp.ok) {
      const suggestData = await suggestResp.json();
      for (const item of (suggestData.data?.items || [])) {
        if (item.word) suggestions.push(item.word);
        if (item.subject && item.subject.title) {
          const norm = normalizeSubject(item.subject);
          if (norm && !seen.has(norm.subjectId)) {
            seen.add(norm.subjectId);
            if (norm.title.toLowerCase().includes(q) || q.includes(norm.title.toLowerCase().slice(0, 4))) {
              results.push(norm);
            }
          }
        }
      }
    }
  } catch {}

  try {
    // 2. Get trending (up to 99 items)
    const trendingResp = await fetch(`${API}/wefeed-h5api-bff/subject/trending?page=1&perPage=100`, {
      headers: headers(),
      signal: AbortSignal.timeout(10000),
    });
    if (trendingResp.ok) {
      const trendingData = await trendingResp.json();
      const items = trendingData.data?.subjectList || trendingData.data || [];
      for (const m of items) {
        const norm = normalizeSubject(m);
        if (norm && !seen.has(norm.subjectId)) {
          seen.add(norm.subjectId);
          if (norm.title.toLowerCase().includes(q)) {
            results.push(norm);
          }
        }
      }
    }
  } catch {}

  try {
    // 3. Get home page content (up to ~376 subjects)
    const homeResp = await fetch(`${API}/wefeed-h5api-bff/home?host=netnaija.film`, {
      headers: headers(),
      signal: AbortSignal.timeout(12000),
    });
    if (homeResp.ok) {
      const text = await homeResp.text();
      try {
        const homeData = JSON.parse(text);
        function walk(o) {
          if (!o || typeof o !== "object") return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (o.subjectId && o.title && !seen.has(String(o.subjectId))) {
            const norm = normalizeSubject(o);
            if (norm && norm.title.toLowerCase().includes(q)) {
              seen.add(norm.subjectId);
              results.push(norm);
            }
          }
          Object.values(o).forEach(walk);
        }
        walk(homeData.data);
      } catch {}
    }
  } catch {}

  // Sort by rating (highest first), then by title
  results.sort((a, b) => {
    const ra = parseFloat(a.imdbRating) || 0;
    const rb = parseFloat(b.imdbRating) || 0;
    if (rb !== ra) return rb - ra;
    return a.title.localeCompare(b.title);
  });

  res.status(200).json({
    query: q,
    count: Math.min(results.length, limit),
    total: results.length,
    suggestions: suggestions.slice(0, 10),
    results: results.slice(0, limit),
  });
}
