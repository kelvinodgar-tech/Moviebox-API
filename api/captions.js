// GET /api/captions/:detailPath?season=1&episode=1
// Returns subtitle URLs for a movie or episode.
// Internally fetches the video id from /subject/play (with /subject/download
// as a fallback), then calls /subject/caption.
// Example: /api/captions/lucifer-UQASHYbVPB2?season=1&episode=1
// Example: /api/captions/oppenheimer-Akh5Nrwl7o

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

async function fetchJsonWithTimeout(url, headers, ms = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const { detailPath } = req.query;
  const season = parseInt(req.query.season) || 0; // 0 for movies
  const episode = parseInt(req.query.episode) || 0; // 0 for movies

  if (!detailPath) {
    return res.status(400).json({
      error: "Missing detailPath parameter. Example: /api/captions/lucifer-UQASHYbVPB2?season=1&episode=1",
    });
  }

  try {
    // 1. Get the subject id from /detail
    const detailResp = await fetchJsonWithTimeout(
      `${API}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(detailPath)}`,
      commonHeaders("https://netnaija.film/")
    );

    if (!detailResp.ok || !detailResp.data) {
      return res.status(502).json({
        error: "Failed to fetch detail",
        detailPath,
        status: detailResp.status,
      });
    }

    const subject = detailResp.data?.data?.subject;
    if (!subject) {
      return res.status(404).json({ error: "Subject not found", detailPath });
    }
    const subjectId = String(subject.subjectId);
    const title = subject.title || "";
    const playReferer = `https://netnaija.film/videoPlayPage/${detailPath}?type=/movie/detail`;

    // 2. Get the video id from /subject/play (fallback to /subject/download)
    let videoId = "";
    let streamSource = "";

    const playResp = await fetchJsonWithTimeout(
      `${API}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${encodeURIComponent(detailPath)}`,
      commonHeaders(playReferer)
    );

    const playStreams = playResp.data?.data?.streams || [];
    if (playStreams.length > 0) {
      // Pick the highest-resolution, free stream
      const free = playStreams
        .filter((s) => s.url && !s.vipLocked)
        .sort((a, b) => (b.resolutions || 0) - (a.resolutions || 0));
      const chosen = free[0] || playStreams[0];
      videoId = String(chosen?.id || "");
      streamSource = "play";
    }

    if (!videoId) {
      // Fallback to /download via the netnaija site proxy
      const dlResp = await fetchJsonWithTimeout(
        `https://netnaija.film/wefeed-h5api-bff/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${encodeURIComponent(detailPath)}`,
        commonHeaders(playReferer)
      );
      const dlDownloads = dlResp.data?.data?.downloads || [];
      if (dlDownloads.length > 0) {
        const free = dlDownloads
          .filter((d) => d.url && !d.vipLocked)
          .sort((a, b) => (b.resolution || 0) - (a.resolution || 0));
        const chosen = free[0] || dlDownloads[0];
        videoId = String(chosen?.id || chosen?.videoId || "");
        streamSource = "download";
      }
    }

    if (!videoId) {
      return res.status(404).json({
        error: "No playable video id found. The play endpoint may be rate-limited; retry in 2-3 minutes.",
        detailPath,
        season,
        episode,
        title,
      });
    }

    // 3. Fetch captions using the video id
    const captionResp = await fetchJsonWithTimeout(
      `${API}/wefeed-h5api-bff/subject/caption?format=MP4&id=${videoId}&subjectId=${subjectId}&detailPath=${encodeURIComponent(detailPath)}`,
      commonHeaders(playReferer)
    );

    if (!captionResp.ok || !captionResp.data) {
      return res.status(502).json({
        error: "Failed to fetch captions",
        detailPath,
        status: captionResp.status,
      });
    }

    const rawCaptions = captionResp.data?.data?.captions || [];
    const captions = rawCaptions.map((c) => ({
      id: String(c.id || ""),
      lan: c.lan || "",
      lanName: c.lanName || "",
      url: c.url || "",
      size: parseInt(c.size || 0),
      delay: c.delay || 0,
    }));

    return res.status(200).json({
      detailPath,
      subjectId,
      title,
      season,
      episode,
      videoId,
      streamSource,
      captionCount: captions.length,
      captions,
    });
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Caption fetch timed out. Try again.", detailPath });
    }
    return res.status(500).json({ error: e.message, detailPath });
  }
}
