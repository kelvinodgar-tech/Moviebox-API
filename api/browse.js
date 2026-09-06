// GET /api/browse?type=movie&genre=Action&country=United+States&year=2024&sort=Latest&page=1&limit=20
// Browse/filter movies, TV shows, and animation.
// Uses the backend /subject/filter endpoint, auto-paginating to find enough items of the requested type.

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const TYPE_MAP = {
  movie: [1],
  tv: [2],
  animation: [1, 2],
  all: [1, 2, 5, 6, 7, 9],
};

// Best sort option per type (based on what the backend returns)
const SORT_HINT = {
  movie: "Latest",
  tv: "ForYou",
  animation: "Latest",
  all: "Latest",
};

function norm(s) {
  if (!s) return null;
  return {
    title: s.title || "",
    subjectId: String(s.subjectId || s.id || ""),
    subjectType: s.subjectType,
    detailPath: s.detailPath || "",
    type: s.subjectType === 1 ? "movie" : (s.subjectType === 2 ? "tv" : "other"),
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
  const type = (req.query.type || "all").toLowerCase();
  const genre = req.query.genre || "";
  const country = req.query.country || "";
  const year = req.query.year || "";
  let sort = req.query.sort || "";
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  // Use the best sort for the requested type if user didn't specify
  if (!sort) sort = SORT_HINT[type] || "Latest";

  const allowedTypes = TYPE_MAP[type] || TYPE_MAP.all;
  const isAnimation = type === "animation";

  try {
    const results = [];
    const seen = new Set();
    let currentPage = page;
    const maxPages = page + 5; // search up to 5 pages

    while (results.length < limit && currentPage <= maxPages) {
      const filterBody = { page: currentPage, perPage: 30, sort };
      if (genre) filterBody.genre = genre;
      if (country) filterBody.country = country;
      if (year) filterBody.year = year;

      const r = await fetch(`${API}/wefeed-h5api-bff/subject/filter`, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-Client-Info": '{"timezone":"Africa/Lagos"}',
          "Origin": "https://netnaija.film",
          "Referer": "https://netnaija.film/",
        },
        body: JSON.stringify(filterBody),
        signal: AbortSignal.timeout(10000),
      });

      if (!r.ok) break;
      const data = await r.json();
      const items = data.data?.items || [];
      if (items.length === 0) break;

      for (const s of items) {
        const n = norm(s);
        if (!n || !n.title || seen.has(n.subjectId)) continue;
        if (!allowedTypes.includes(n.subjectType)) continue;
        if (isAnimation && !(n.genre || "").toLowerCase().includes("animation")) continue;
        seen.add(n.subjectId);
        results.push(n);
        if (results.length >= limit) break;
      }

      currentPage++;
    }

    res.status(200).json({
      type,
      genre: genre || "All",
      country: country || "All",
      year: year || "All",
      sort,
      page,
      count: results.length,
      results: results.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
