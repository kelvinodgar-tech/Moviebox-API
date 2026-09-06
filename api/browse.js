// GET /api/browse?type=movie&genre=Action&country=United+States&year=2024&sort=Latest&page=1&limit=20
// Browse/filter movies, TV shows, and animation with genre, country, year, sort filters.
// Uses the backend /subject/filter endpoint and filters by subjectType on our side.

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// subjectType mapping: 1=movie, 2=TV, 6=music/other
// For "animation" we filter by genre containing "Animation"
const TYPE_MAP = {
  movie: [1],
  tv: [2],
  animation: [1, 2], // animation can be either, filtered by genre
  all: [1, 2, 6],
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
  const sort = req.query.sort || "Latest";
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  const allowedTypes = TYPE_MAP[type] || TYPE_MAP.all;
  const isAnimation = type === "animation";

  try {
    // Build the filter request body
    const filterBody = { page, perPage: limit * 3, sort }; // fetch 3x to have enough after filtering
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
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: `Backend returned ${r.status}` });
    }

    const data = await r.json();
    let items = (data.data?.items || []).map(norm);

    // Filter by subjectType
    items = items.filter(s => s && allowedTypes.includes(s.subjectType));

    // For animation, also filter by genre containing "Animation"
    if (isAnimation) {
      items = items.filter(s => (s.genre || "").toLowerCase().includes("animation"));
    }

    // If we don't have enough items after filtering, try fetching more pages
    let currentPage = page;
    while (items.length < limit && currentPage < 5) {
      currentPage++;
      filterBody.page = currentPage;
      const r2 = await fetch(`${API}/wefeed-h5api-bff/subject/filter`, {
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
      if (!r2.ok) break;
      const data2 = await r2.json();
      const moreItems = (data2.data?.items || []).map(norm);
      const filtered = moreItems.filter(s => s && allowedTypes.includes(s.subjectType));
      if (isAnimation) {
        filtered.filter(s => (s.genre || "").toLowerCase().includes("animation"));
      }
      items = items.concat(filtered);
      if (moreItems.length === 0) break;
    }

    items = items.slice(0, limit);

    res.status(200).json({
      type,
      genre: genre || "All",
      country: country || "All",
      year: year || "All",
      sort,
      page,
      count: items.length,
      results: items,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
