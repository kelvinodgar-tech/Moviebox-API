// GET /api/animation?page=1&limit=20
// Returns ALL animation (no filter). Paginated.
// Uses the backend /subject/filter with genre="Animation" and filters to subjectType 1 or 2.

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function norm(s) {
  if (!s) return null;
  return {
    title: s.title || "",
    subjectId: String(s.subjectId || s.id || ""),
    subjectType: s.subjectType,
    detailPath: s.detailPath || "",
    type: s.subjectType === 1 ? "movie" : "tv",
    genre: s.genre || "",
    imdbRating: s.imdbRatingValue || s.imdbRating || "",
    imdbRatingCount: s.imdbRatingCount || 0,
    country: s.countryName || "",
    description: s.description || "",
    releaseDate: s.releaseDate || "",
    duration: s.duration || 0,
    cover: s.cover?.url || (typeof s.cover === "string" ? s.cover : "") || "",
    hasResource: s.hasResource || false,
  };
}

export default async function handler(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const results = [];
    const seen = new Set();
    let currentPage = page;
    const maxPages = page + 5;

    while (results.length < limit && currentPage <= maxPages) {
      const r = await fetch(`${API}/wefeed-h5api-bff/subject/filter`, {
        method: "POST",
        headers: {
          "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json",
          "X-Client-Info": '{"timezone":"Africa/Lagos"}',
          "Origin": "https://netnaija.film", "Referer": "https://netnaija.film/",
        },
        body: JSON.stringify({ page: currentPage, perPage: 30, genre: "Animation", sort: "Latest" }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) break;
      const data = await r.json();
      const items = data.data?.items || [];
      if (items.length === 0) break;

      for (const s of items) {
        if (s.subjectType !== 1 && s.subjectType !== 2) continue; // movies or TV only
        if (!(s.genre || "").toLowerCase().includes("animation")) continue;
        const n = norm(s);
        if (!n || !n.title || seen.has(n.subjectId)) continue;
        seen.add(n.subjectId);
        results.push(n);
        if (results.length >= limit) break;
      }
      currentPage++;
    }

    res.status(200).json({
      type: "animation",
      page,
      count: results.length,
      results: results.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
