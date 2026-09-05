// GET /api/trending?limit=20
// Returns the current trending list with rich fields (cover, rating, genre,
// country, description, releaseDate, etc).
// Example: /api/trending?limit=20

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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(
      `${API}/wefeed-h5api-bff/subject/trending?page=1&perPage=${limit}`,
      { headers: commonHeaders("https://netnaija.film/"), signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!resp.ok) {
      return res
        .status(resp.status)
        .json({ error: `Upstream returned ${resp.status}` });
    }
    const data = await resp.json();
    const items = data.data?.subjectList || data.data || [];

    res.status(200).json({
      count: items.length,
      items: items.map((m) => ({
        title: m.title || "",
        subjectId: String(m.subjectId || ""),
        subjectType: m.subjectType,
        detailPath: m.detailPath || "",
        type: m.subjectType === 1 ? "movie" : "tv",
        description: m.description || "",
        releaseDate: m.releaseDate || "",
        duration: m.duration || 0,
        genre: m.genre || "",
        cover: m.cover?.url || "",
        countryName: m.countryName || "",
        imdbRatingValue: m.imdbRatingValue || "",
        imdbRatingCount: m.imdbRatingCount || 0,
        subtitles: m.subtitles || "",
        hasResource: !!m.hasResource,
        // Back-compat: keep the old `imdbRating` alias.
        imdbRating: m.imdbRatingValue || "",
      })),
    });
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Trending fetch timed out." });
    }
    res.status(500).json({ error: e.message });
  }
}
