// GET /api/seasons/:detailPath
// Returns all seasons with episode counts and available resolutions for a TV show.
// Example: /api/seasons/lucifer-UQASHYbVPB2

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

  const { detailPath } = req.query;

  if (!detailPath) {
    return res.status(400).json({
      error: "Missing detailPath parameter. Example: /api/seasons/lucifer-UQASHYbVPB2",
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(
      `${API}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(detailPath)}`,
      {
        headers: commonHeaders("https://netnaija.film/"),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: `Upstream returned ${resp.status}`,
        detailPath,
      });
    }

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Failed to parse detail response", detailPath });
    }

    const subject = data?.data?.subject;
    if (!subject) {
      return res.status(404).json({ error: "Subject not found", detailPath });
    }

    const resource = data?.data?.resource || {};
    const rawSeasons = resource.seasons || [];

    const seasons = rawSeasons.map((s) => ({
      season: s.se,
      maxEp: s.maxEp || 0,
      resolutions: (s.resolutions || []).map((r) => ({
        resolution: r.resolution,
        epNum: r.epNum || 0,
      })),
      availableResolutions: (s.resolutions || []).map((r) => r.resolution),
    }));

    // Aggregate all resolutions across seasons
    const allRes = new Set();
    seasons.forEach((s) => s.availableResolutions.forEach((r) => allRes.add(r)));
    const globalResolutions = [...allRes].sort((a, b) => a - b);

    return res.status(200).json({
      detailPath,
      subjectId: String(subject.subjectId || ""),
      subjectType: subject.subjectType,
      type: subject.subjectType === 1 ? "movie" : "tv",
      title: subject.title || "",
      seasonCount: seasons.length,
      totalEpisodes: seasons.reduce((sum, s) => sum + (s.maxEp || 0), 0),
      globalResolutions,
      source: resource.source || "",
      uploadBy: resource.uploadBy || "",
      seasons,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Detail fetch timed out. Try again.", detailPath });
    }
    return res.status(500).json({ error: e.message, detailPath });
  }
}
