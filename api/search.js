// GET /api/search?q=oppenheimer&limit=5
// Searches the home page for matching titles.
// Example: /api/search?q=all%20american&limit=10

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

export default async function handler(req, res) {
  const q = (req.query.q || "").toLowerCase();
  const limit = parseInt(req.query.limit) || 10;

  if (!q) {
    return res.status(400).json({ error: "Missing q parameter. Example: /api/search?q=oppenheimer&limit=5" });
  }

  try {
    const resp = await fetch(`${API}/wefeed-h5api-bff/home?host=netnaija.film`, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "X-Client-Info": '{"timezone":"Africa/Lagos"}',
        "Origin": "https://netnaija.film",
        "Referer": "https://netnaija.film/",
      },
    });
    const data = await resp.json();

    // Walk the home response and find all unique subjects
    const seen = new Set();
    const results = [];
    function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const sid = o.subjectId;
      const title = o.title;
      if (sid && title && !seen.has(String(sid))) {
        seen.add(String(sid));
        if (title.toLowerCase().includes(q)) {
          results.push({
            title,
            subjectId: String(sid),
            subjectType: o.subjectType,
            detailPath: o.detailPath,
            type: o.subjectType === 1 ? "movie" : "tv",
          });
        }
      }
      Object.values(o).forEach(walk);
    }
    walk(data.data);
    
    res.status(200).json({
      query: q,
      count: Math.min(results.length, limit),
      results: results.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
