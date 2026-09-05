// GET /api/home
// Returns the full home page content: banners, categories, and all featured
// movies/shows with their detailPaths, titles, covers, ratings, genres.
// Example: /api/home

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

// Normalize a subject object into a clean card shape.
function normalizeSubject(s) {
  if (!s) return null;
  return {
    subjectId: String(s.subjectId || ""),
    subjectType: s.subjectType,
    type: s.subjectType === 1 ? "movie" : "tv",
    title: s.title || "",
    description: s.description || "",
    releaseDate: s.releaseDate || "",
    duration: s.duration || 0,
    genre: s.genre || "",
    cover: s.cover?.url || "",
    countryName: s.countryName || "",
    imdbRatingValue: s.imdbRatingValue || "",
    imdbRatingCount: s.imdbRatingCount || 0,
    subtitles: s.subtitles || "",
    hasResource: !!s.hasResource,
    detailPath: s.detailPath || "",
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(`${API}/wefeed-h5api-bff/home?host=netnaija.film`, {
      headers: commonHeaders("https://netnaija.film/"),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Upstream returned ${resp.status}` });
    }

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Failed to parse home response" });
    }

    const operatingList = data?.data?.operatingList || [];
    const platformList = data?.data?.platformList || [];

    const banners = [];
    const sections = [];
    const seenSubjectIds = new Set();
    const allSubjects = [];

    function addSubject(subject) {
      const norm = normalizeSubject(subject);
      if (!norm || !norm.subjectId || !norm.detailPath) return;
      if (seenSubjectIds.has(norm.subjectId)) return;
      seenSubjectIds.add(norm.subjectId);
      allSubjects.push(norm);
    }

    for (const op of operatingList) {
      const type = op.type;
      const title = op.title || "";

      // Banners
      if (type === "BANNER" && op.banner && Array.isArray(op.banner.items)) {
        for (const item of op.banner.items) {
          const subj = item.subject || {};
          const norm = normalizeSubject(subj);
          if (norm && norm.subjectId && norm.detailPath) {
            banners.push({
              ...norm,
              bannerImage: item.image?.url || "",
              bannerWidth: item.image?.width || 0,
              bannerHeight: item.image?.height || 0,
            });
            addSubject(subj);
          }
        }
      }

      // Subject list sections (movies / tv shows)
      if (type === "SUBJECTS_MOVIE" && Array.isArray(op.subjects) && op.subjects.length > 0) {
        const items = op.subjects.map(normalizeSubject).filter(Boolean);
        items.forEach(addSubject);
        sections.push({
          type: "subjects",
          title,
          position: op.position,
          count: items.length,
          items,
        });
      }

      // Appointment / coming soon sections
      if (
        type === "APPOINTMENT_LIST" &&
        Array.isArray(op.subjects) &&
        op.subjects.length > 0
      ) {
        const items = op.subjects.map(normalizeSubject).filter(Boolean);
        items.forEach(addSubject);
        sections.push({
          type: "appointment",
          title: title || "Coming Soon",
          position: op.position,
          count: items.length,
          items,
        });
      }
    }

    return res.status(200).json({
      bannerCount: banners.length,
      banners,
      sectionCount: sections.length,
      sections,
      platformCount: platformList.length,
      platforms: platformList,
      subjectCount: allSubjects.length,
      subjects: allSubjects,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Home fetch timed out. Try again." });
    }
    return res.status(500).json({ error: e.message });
  }
}
