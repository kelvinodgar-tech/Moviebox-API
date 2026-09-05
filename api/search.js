// GET /api/search?q=Bridgerton&limit=20
// Scrapes the actual search pages. Returns results in source order (no re-sorting).

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function resolveNuxt(nuxt, obj) {
  // NUXT_DATA stores objects with integer values that reference array indices.
  // This function resolves those references to get actual values.
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(v => resolveNuxt(nuxt, v));
  
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "number" && val >= 0 && val < nuxt.length) {
      // This is a reference to another array item
      const resolved = nuxt[val];
      if (typeof resolved === "object" && resolved !== null) {
        result[key] = resolveNuxt(nuxt, resolved);
      } else {
        result[key] = resolved;
      }
    } else if (typeof val === "object" && val !== null) {
      result[key] = resolveNuxt(nuxt, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function extractSubjectsFromNuxt(nuxt) {
  const results = [];
  const seen = new Set();
  
  // Walk the nuxt array looking for subject-like objects
  for (let i = 0; i < nuxt.length; i++) {
    const item = nuxt[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    
    // Check if this looks like a subject (has subjectId or detailPath)
    const hasSubjectId = "subjectId" in item || "subjectID" in item;
    const hasDetailPath = "detailPath" in item;
    const hasTitle = "title" in item;
    
    if ((hasSubjectId || hasDetailPath) && hasTitle) {
      // Resolve all references
      const resolved = resolveNuxt(nuxt, item);
      if (resolved.title && resolved.detailPath) {
        const sid = String(resolved.subjectId || resolved.id || resolved.detailPath);
        if (!seen.has(sid)) {
          seen.add(sid);
          results.push({
            title: String(resolved.title || ""),
            subjectId: String(resolved.subjectId || resolved.id || ""),
            subjectType: resolved.subjectType,
            detailPath: String(resolved.detailPath || ""),
            type: resolved.subjectType === 1 ? "movie" : (resolved.subjectType === 2 ? "tv" : "other"),
            genre: resolved.genre || "",
            imdbRating: resolved.imdbRatingValue || resolved.imdbRating || "",
            imdbRatingCount: resolved.imdbRatingCount || 0,
            country: resolved.countryName || "",
            description: resolved.description || "",
            releaseDate: resolved.releaseDate || "",
            duration: resolved.duration || 0,
            cover: resolved.cover?.url || (typeof resolved.cover === "string" ? resolved.cover : "") || "",
            hasResource: resolved.hasResource || false,
          });
        }
      }
    }
  }
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
      if (results.length > 0) break; // Use first site that returns results
    } catch {}
  }

  res.status(200).json({
    query: q,
    count: Math.min(results.length, limit),
    total: results.length,
    results: results.slice(0, limit),
  });
}
