// GET /api/catalog?type=movie&page=1&limit=20
// GET /api/catalog?type=tv&page=1&limit=20
// GET /api/catalog?type=animation&page=1&limit=20
// Returns all items of a given type (no filter). Paginated.

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const TYPE_CONFIG = {
  movie: { subjectTypes: [1], sort: "Latest", genre: "" },
  tv: { subjectTypes: [2], sort: "ForYou", genre: "" },
  animation: { subjectTypes: [1, 2], sort: "Latest", genre: "Animation" },
};

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
  const type = (req.query.type || "movie").toLowerCase();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const config = TYPE_CONFIG[type];
  if (!config) {
    return res.status(400).json({ error: "Invalid type. Use: movie, tv, or animation" });
  }

  try {
    const results = [];
    const seen = new Set();
    let currentPage = page;
    const maxPages = page + 5;

    while (results.length < limit && currentPage <= maxPages) {
      const filterBody = { page: currentPage, perPage: 30, sort: config.sort };
      if (config.genre) filterBody.genre = config.genre;

      const r = await fetch(`${API}/wefeed-h5api-bff/subject/filter`, {
        method: "POST",
        headers: {
          "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json",
          "X-Client-Info": '{"timezone":"Africa/Lagos"}',
          "Origin": "https://netnaija.film", "Referer": "https://netnaija.film/",
        },
        body: JSON.stringify(filterBody),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) break;
      const data = await r.json();
      const items = data.data?.items || [];
      if (items.length === 0) break;

      for (const s of items) {
        if (!config.subjectTypes.includes(s.subjectType)) continue;
        if (type === "animation" && !(s.genre || "").toLowerCase().includes("animation")) continue;
        const n = norm(s);
        if (!n || !n.title || seen.has(n.subjectId)) continue;
        seen.add(n.subjectId);
        results.push(n);
        if (results.length >= limit) break;
      }
      currentPage++;
    }

    res.status(200).json({
      type,
      page,
      count: results.length,
      results: results.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
