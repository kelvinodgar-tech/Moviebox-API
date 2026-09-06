// GET /api/browse?type=movie&genre=Action&country=United+States&year=2024&sort=Latest&page=1&limit=20
// Browse/filter movies, TV shows, and animation.
// GET /api/browse?filters=true - Returns available filter values.

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const TYPE_MAP = {
  movie: [1], tv: [2], animation: [1, 2], all: [1, 2, 5, 6, 7, 9],
};
const SORT_HINT = { movie: "Latest", tv: "ForYou", animation: "Latest", all: "Latest" };

function norm(s) {
  if (!s) return null;
  return {
    title: s.title || "", subjectId: String(s.subjectId || s.id || ""),
    subjectType: s.subjectType, detailPath: s.detailPath || "",
    type: s.subjectType === 1 ? "movie" : (s.subjectType === 2 ? "tv" : "other"),
    genre: s.genre || "", imdbRating: s.imdbRatingValue || s.imdbRating || "",
    imdbRatingCount: s.imdbRatingCount || 0, country: s.countryName || "",
    description: s.description || "", releaseDate: s.releaseDate || "",
    duration: s.duration || 0,
    cover: s.cover?.url || (typeof s.cover === "string" ? s.cover : "") || "",
    hasResource: s.hasResource || false,
  };
}

export default async function handler(req, res) {
  // If ?filters=true, return available filter values
  if (req.query.filters === "true") {
    try {
      const r = await fetch("https://netnaija.film/movies", {
        headers: { "User-Agent": UA, "Accept": "text/html" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) return res.status(r.status).json({ error: "Failed to fetch movies page" });
      const html = await r.text();
      const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return res.status(500).json({ error: "No NUXT_DATA found" });
      const nuxt = JSON.parse(m[1]);
      
      const filters = {};
      for (let i = 0; i < nuxt.length; i++) {
        const item = nuxt[i];
        if (typeof item !== "object" || !item || Array.isArray(item)) continue;
        if (!("filterType" in item) || !("filterVals" in item)) continue;
        const ft = typeof item.filterType === "number" ? nuxt[item.filterType] : item.filterType;
        const fvRef = item.filterVals;
        const fvList = typeof fvRef === "number" ? nuxt[fvRef] : fvRef;
        if (!Array.isArray(fvList)) continue;
        const values = [];
        for (const vRef of fvList) {
          const v = typeof vRef === "number" ? nuxt[vRef] : vRef;
          if (typeof v === "object" && v) {
            const name = typeof v.name === "number" ? nuxt[v.name] : v.name;
            if (name && name !== "All") values.push(name);
          } else if (typeof v === "string" && v !== "All") values.push(v);
        }
        if (values.length > 0 && !filters[ft]) filters[ft] = values;
      }
      
      return res.status(200).json({
        genres: filters.genre || [],
        countries: filters.country || [],
        years: filters.year || [],
        sortOptions: filters.sort || ["Latest", "Hottest", "ForYou", "Rating"],
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Normal browse mode
  const type = (req.query.type || "all").toLowerCase();
  const genre = req.query.genre || "";
  const country = req.query.country || "";
  const year = req.query.year || "";
  let sort = req.query.sort || "";
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;

  if (!sort) sort = SORT_HINT[type] || "Latest";
  const allowedTypes = TYPE_MAP[type] || TYPE_MAP.all;
  const isAnimation = type === "animation";

  try {
    const results = [];
    const seen = new Set();
    let currentPage = page;
    const maxPages = page + 5;

    while (results.length < limit && currentPage <= maxPages) {
      const filterBody = { page: currentPage, perPage: 30, sort };
      if (genre) filterBody.genre = genre;
      if (country) filterBody.country = country;
      if (year) filterBody.year = year;

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
      type, genre: genre || "All", country: country || "All",
      year: year || "All", sort, page,
      count: results.length, results: results.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
