// GET /api/movie/:detailPath
// Returns all quality URLs for a movie.
// Example: /api/movie/oppenheimer-Akh5Nrwl7o

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const { detailPath } = req.query;
  
  if (!detailPath) {
    return res.status(400).json({ error: "Missing detailPath parameter. Example: /api/movie/oppenheimer-Akh5Nrwl7o" });
  }

  try {
    // 1. Get subject detail to find subjectId
    const detailResp = await fetch(`${API}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(detailPath)}`, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "X-Client-Info": '{"timezone":"Africa/Lagos"}',
        "Origin": "https://netnaija.film",
        "Referer": "https://netnaija.film/",
      },
    });
    const detail = await detailResp.json();
    const subject = detail.data?.subject;
    
    if (!subject) {
      return res.status(404).json({ error: "Movie not found", detailPath });
    }

    // 2. Get play URLs (all qualities including 1080P free)
    const playResp = await fetch(`${API}/wefeed-h5api-bff/subject/play?subjectId=${subject.subjectId}&se=0&ep=0&detailPath=${encodeURIComponent(detailPath)}`, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "X-Client-Info": '{"timezone":"Africa/Lagos"}',
        "Origin": "https://netnaija.film",
        "Referer": `https://netnaija.film/videoPlayPage/${detailPath}?type=/movie/detail`,
      },
    });
    const play = await playResp.json();
    let streams = play.data?.streams || [];
    let source = "play";

    // 3. Fallback to download endpoint if play returns empty (rate-limited)
    if (streams.length === 0) {
      const dlResp = await fetch(`https://netnaija.film/wefeed-h5api-bff/subject/download?subjectId=${subject.subjectId}&se=0&ep=0&detailPath=${encodeURIComponent(detailPath)}`, {
        headers: {
          "User-Agent": UA,
          "Accept": "application/json",
          "X-Client-Info": '{"timezone":"Africa/Lagos"}',
          "Origin": "https://netnaija.film",
          "Referer": `https://netnaija.film/videoPlayPage/${detailPath}?type=/movie/detail`,
        },
      });
      const dl = await dlResp.json();
      streams = (dl.data?.downloads || []).map(d => ({
        ...d,
        resolutions: String(d.resolution),
      }));
      source = "download";
    }

    // 4. Normalize and return
    const qualities = streams.map(s => ({
      resolution: parseInt(s.resolutions || s.resolution || 0),
      size_mb: Math.round(parseInt(s.size || 0) / 1e6 * 100) / 100,
      duration_sec: s.duration || 0,
      codec: s.codecName || "h264",
      vipLocked: s.vipLocked || false,
      url: s.url || "",
    }));

    res.status(200).json({
      title: subject.title,
      subjectId: subject.subjectId,
      detailPath,
      watch_url: `https://netnaija.film/videoPlayPage/${detailPath}?type=/movie/detail`,
      source,
      qualities,
      best_free: qualities.filter(q => q.url && !q.vipLocked).sort((a, b) => b.resolution - a.resolution)[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, detailPath });
  }
}
