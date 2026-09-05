// GET /api/details/:detailPath
// Returns full movie/show details: title, synopsis, genre, release date,
// duration, imdb rating, country, subtitles, cover, hasResource, trailer,
// and the full cast/stars list (name, character, avatarUrl, detailPath).
// Example: /api/details/oppenheimer-Akh5Nrwl7o

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

function fmtDuration(sec) {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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
      error: "Missing detailPath parameter. Example: /api/details/oppenheimer-Akh5Nrwl7o",
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

    const stars = data?.data?.stars || [];
    const cast = stars.map((s) => ({
      staffId: String(s.staffId || ""),
      staffType: s.staffType,
      role: s.staffType === 1 ? "Cast" : s.staffType === 2 ? "Director" : "Staff",
      name: s.name || "",
      character: s.character || "",
      avatarUrl: s.avatarUrl || "",
      detailPath: s.detailPath || "",
    }));

    const trailer = subject.trailer || {};
    const trailerVideo = trailer.videoAddress || {};

    const result = {
      detailPath,
      subjectId: String(subject.subjectId || ""),
      subjectType: subject.subjectType,
      type: subject.subjectType === 1 ? "movie" : "tv",
      title: subject.title || "",
      description: subject.description || data?.data?.metadata?.description || "",
      genre: subject.genre || "",
      releaseDate: subject.releaseDate || "",
      duration: subject.duration || 0,
      durationText: fmtDuration(subject.duration || 0),
      imdbRatingValue: subject.imdbRatingValue || "",
      imdbRatingCount: subject.imdbRatingCount || 0,
      countryName: subject.countryName || "",
      subtitles: subject.subtitles || "",
      cover: subject.cover?.url || "",
      coverWidth: subject.cover?.width || 0,
      coverHeight: subject.cover?.height || 0,
      hasResource: !!subject.hasResource,
      trailer: {
        url: trailerVideo.url || "",
        videoId: String(trailerVideo.videoId || ""),
        duration: trailerVideo.duration || 0,
        width: trailerVideo.width || 0,
        height: trailerVideo.height || 0,
        cover: trailer.cover?.url || "",
      },
      cast,
      castCount: cast.length,
    };

    return res.status(200).json(result);
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Detail fetch timed out. Try again.", detailPath });
    }
    return res.status(500).json({ error: e.message, detailPath });
  }
}
