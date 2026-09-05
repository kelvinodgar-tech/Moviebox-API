// GET /api/search?q=Bridgerton&limit=20
// Scrapes the actual search pages on netnaija.film, movieboxonline.net, and officialmoviebox.com.
// No login/token needed. Returns full results with covers, ratings, genres.

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
  const errors = [];

  // Try all 3 sites in parallel
  const sites = [
    { name: "netnaija", url: `https://netnaija.film/search-result?keyword=${encoded}` },
    { name: "officialmoviebox", url: `https://officialmoviebox.com/newWeb/searchResult?keyword=${encoded}` },
    { name: "movieboxonline", url: `https://movieboxonline.net/search-result?keyword=${encoded}` },
  ];

  const responses = await Promise.allSettled(sites.map(async (site) => {
    const r = await fetch(site.url, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`${site.name}: HTTP ${r.status}`);
    const html = await r.text();
    
    // Parse __NUXT_DATA__ from the HTML
    const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`${site.name}: no NUXT_DATA`);
    
    const nuxt = JSON.parse(m[1]);
    const subjects = extractSubjectsFromNuxt(nuxt);
    return { site: site.name, subjects };
  }));

  for (const r of responses) {
    if (r.status === "fulfilled" && r.value.subjects.length > 0) {
      for (const s of r.value.subjects) {
        if (s && s.title && !seen.has(s.subjectId)) {
          seen.add(s.subjectId);
          results.push(s);
        }
      }
    } else if (r.status === "rejected") {
      errors.push(r.reason.message);
    }
  }

  // Sort by rating
  results.sort((a, b) => {
    const ra = parseFloat(a.imdbRating) || 0;
    const rb = parseFloat(b.imdbRating) || 0;
    return rb - ra;
  });

  res.status(200).json({
    query: q,
    count: Math.min(results.length, limit),
    total: results.length,
    results: results.slice(0, limit),
  });
}
