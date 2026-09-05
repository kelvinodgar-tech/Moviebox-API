// GET /api/search?q=oppenheimer&limit=5
// Searches the home page for matching titles. Returns the detailPath you need
// for the movie/tv/details endpoints, plus cover, rating, genre, country and
// other available fields for each result.
// Example: /api/search?q=all%20american&limit=10

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

  const q = (req.query.q || "").toLowerCase().trim();
  const limit = parseInt(req.query.limit) || 10;

  if (!q) {
    return res.status(400).json({
      error: "Missing q parameter. Example: /api/search?q=oppenheimer&limit=5",
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(`${API}/wefeed-h5api-bff/home?host=netnaija.film`, {
      headers: commonHeaders("https://netnaija.film/"),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Failed to parse home response", q });
    }

    // Walk the whole home response, collecting every subject object by subjectId.
    const seen = new Map(); // subjectId -> normalized subject
    function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) {
        o.forEach(walk);
        return;
      }
      const sid = o.subjectId;
      const title = o.title;
      const dp = o.detailPath;
      if (sid && title && dp && !seen.has(String(sid))) {
        seen.set(String(sid), {
          title,
          subjectId: String(sid),
          subjectType: o.subjectType,
          type: o.subjectType === 1 ? "movie" : "tv",
          detailPath: dp,
          description: o.description || "",
          releaseDate: o.releaseDate || "",
          duration: o.duration || 0,
          genre: o.genre || "",
          cover: o.cover?.url || "",
          countryName: o.countryName || "",
          imdbRatingValue: o.imdbRatingValue || "",
          imdbRatingCount: o.imdbRatingCount || 0,
          subtitles: o.subtitles || "",
          hasResource: !!o.hasResource,
        });
      }
      Object.values(o).forEach(walk);
    }
    walk(data.data);

    // Filter by query and sort by best rating.
    const results = [...seen.values()]
      .filter((s) => s.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const ra = parseFloat(a.imdbRatingValue) || 0;
        const rb = parseFloat(b.imdbRatingValue) || 0;
        return rb - ra;
      })
      .slice(0, limit);

    return res.status(200).json({
      query: req.query.q,
      count: results.length,
      results,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Home page fetch timed out. Try again.", q });
    }
    return res.status(500).json({ error: e.message, q });
  }
}
