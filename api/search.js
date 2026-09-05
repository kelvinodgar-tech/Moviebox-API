// GET /api/search?q=Bridgerton&limit=20
// Scrapes the actual search pages on netnaija.film, officialmoviebox.com, movieboxonline.net.
// Returns results in the SAME ORDER as the source site (no re-sorting).

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

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

function extractSubjectsFromNuxt(nuxt) {
  const results = [];
  const seen = new Set();
  function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.subjectId && o.title && o.detailPath) {
      const sid = String(o.subjectId);
      if (!seen.has(sid)) {
        seen.add(sid);
        results.push(norm(o));
      }
    }
    Object.values(o).forEach(walk);
  }
  walk(nuxt);
  return results;
}

export default async function handler(req, res) {
  const q = (req.query.q || "").trim();
  const limit = parseInt(req.query.limit) || 20;

  if (!q) {
    return res.status(400).json({ error: "Missing q parameter. Example: /api/search?q=Bridgerton" });
  }

  const encoded = encodeURIComponent(q);
  const seen = new Set();
  const results = [];

  // Try netnaija first (primary source), then others as fallback
  const sites = [
    `https://netnaija.film/search-result?keyword=${encoded}`,
    `https://officialmoviebox.com/newWeb/searchResult?keyword=${encoded}`,
    `https://movieboxonline.net/search-result?keyword=${encoded}`,
  ];

  for (const siteUrl of sites) {
    try {
      const r = await fetch(siteUrl, {
        headers: { "User-Agent": UA, "Accept": "text/html" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const html = await r.text();
      const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) continue;
      const nuxt = JSON.parse(m[1]);
      const subjects = extractSubjectsFromNuxt(nuxt);
      for (const s of subjects) {
        if (s && s.title && !seen.has(s.subjectId)) {
          seen.add(s.subjectId);
          results.push(s);
        }
      }
      // If we got results from netnaija, use those (preserve their order)
      if (results.length > 0) break;
    } catch {}
  }

  // Return in source order (no re-sorting)
  res.status(200).json({
    query: q,
    count: Math.min(results.length, limit),
    total: results.length,
    results: results.slice(0, limit),
  });
}
