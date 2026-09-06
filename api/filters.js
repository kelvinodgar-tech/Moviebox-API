// GET /api/filters
// Returns available filter values (genres, countries, years, sort options).

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

export default async function handler(req, res) {
  try {
    // Fetch the movies page to extract filter values from NUXT data
    const r = await fetch("https://netnaija.film/movies", {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `Failed to fetch movies page: ${r.status}` });
    }
    const html = await r.text();
    
    const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      return res.status(500).json({ error: "Could not find NUXT_DATA on movies page" });
    }
    
    const nuxt = JSON.parse(m[1]);
    
    // Extract filter values
    const filters = {};
    
    for (let i = 0; i < nuxt.length; i++) {
      const item = nuxt[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      if (!("filterType" in item) || !("filterVals" in item)) continue;
      
      const ftRef = item.filterType;
      const ft = typeof ftRef === "number" && ftRef < nuxt.length ? nuxt[ftRef] : ftRef;
      
      const fvRef = item.filterVals;
      const fvList = typeof fvRef === "number" && fvRef < nuxt.length ? nuxt[fvRef] : fvRef;
      if (!Array.isArray(fvList)) continue;
      
      const values = [];
      for (const vRef of fvList) {
        const v = typeof vRef === "number" && vRef < nuxt.length ? nuxt[vRef] : vRef;
        if (typeof v === "object" && v !== null) {
          const name = typeof v.name === "number" ? nuxt[v.name] : v.name;
          const id = typeof v.id === "number" ? nuxt[v.id] : v.id;
          if (name && name !== "All") {
            values.push(name);
          }
        } else if (typeof v === "string" && v !== "All") {
          values.push(v);
        }
      }
      
      if (values.length > 0 && !filters[ft]) {
        filters[ft] = values;
      }
    }
    
    res.status(200).json({
      genres: filters.genre || [],
      countries: filters.country || [],
      years: filters.year || [],
      sortOptions: filters.sort || ["Latest", "Hottest", "ForYou", "Rating"],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
