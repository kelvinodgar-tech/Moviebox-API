// GET /api/trending?limit=10
// Returns the current trending list.
// Example: /api/trending?limit=20

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const limit = parseInt(req.query.limit) || 10;

  try {
    const resp = await fetch(`${API}/wefeed-h5api-bff/subject/trending?page=1&perPage=${limit}`, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "X-Client-Info": '{"timezone":"Africa/Lagos"}',
        "Origin": "https://netnaija.film",
        "Referer": "https://netnaija.film/",
      },
    });
    const data = await resp.json();
    const items = data.data?.subjectList || data.data || [];

    res.status(200).json({
      count: items.length,
      items: items.map(m => ({
        title: m.title,
        subjectId: m.subjectId,
        subjectType: m.subjectType,
        detailPath: m.detailPath,
        type: m.subjectType === 1 ? "movie" : "tv",
        genre: m.genre,
        imdbRating: m.imdbRatingValue,
        cover: m.cover?.url,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
