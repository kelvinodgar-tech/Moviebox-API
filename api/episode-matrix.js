// GET /api/episode-matrix?detailPath=X&season=1&episode=1
// (or /api/episode-matrix/:detailPath?season=1&episode=1)
//
// The composite endpoint AniDen consumes: returns the FULL language matrix
// for one episode in a single call.
//   - one entry per dub variant (Original Audio + every language dub),
//     each with its own playable qualities (resolution/size/url)
//   - the AGGREGATED subtitle set for the episode: captions are collected
//     from every variant that has streams, deduped per language (the
//     richest set wins - e.g. the Original Audio variant usually carries
//     4-18 caption languages while dub variants carry none; the union is
//     attached to every language so any server the user picks has them)
//   - ttlHint: seconds the returned CDN urls stay valid (measured: video
//     sign urls live for hours, caption CloudFront urls for 7 days; we
//     advertise a conservative 2h)
//
// Movies: omit season/episode (or pass 0) - the same languages matrix is
// returned without episode routing.
//
// All dub variants of an entry share the BFF subject model: each variant is
// its own subject with its own subjectId/detailPath, and /subject/play is
// queried per variant. Calls run in parallel (typically 2-6 variants).

const API = "https://h5-api.aoneroom.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function commonHeaders(referer) {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "X-Client-Info": '{"timezone":"Africa/Lagos"}',
    Origin: "https://movieboxonline.net",
    Referer: referer || "https://movieboxonline.net/",
  };
}

async function fetchJson(url, headers, ms = 15000) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

function normQuality(s) {
  return {
    resolution: parseInt(s.resolutions || s.resolution || 0),
    size_mb: Math.round(parseInt(s.size || 0) / 1e6 * 100) / 100,
    duration_sec: s.duration || 0,
    codec: s.codecName || "h264",
    vipLocked: s.vipLocked || false,
    url: s.url || "",
    videoId: String(s.id || ""),
  };
}

/** Play streams for one variant. Falls back to the download endpoint.
 *  NOTE: the BFF validates the Referer's detailPath against the requested
 *  variant - each variant MUST be queried with its OWN play URL as referer
 *  (using the base entry's referer returns 0 streams for dub variants). */
async function variantStreams(subjectId, detailPath, season, episode) {
  const referer = `https://movieboxonline.net/play/${detailPath}`;
  let res = await fetchJson(
    `${API}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${encodeURIComponent(detailPath)}`,
    commonHeaders(referer)
  );
  let streams = res.ok ? res.data?.data?.streams || [] : [];
  if (streams.length === 0) {
    res = await fetchJson(
      `https://movieboxonline.net/wefeed-h5api-bff/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${encodeURIComponent(detailPath)}`,
      commonHeaders(referer)
    );
    streams = res.ok ? res.data?.data?.downloads || [] : [];
  }
  return streams;
}

/** Captions for one variant, using its highest-res stream's videoId. */
async function variantCaptions(subjectId, detailPath, season, episode, videoId) {
  if (!videoId) return [];
  const referer = `https://movieboxonline.net/play/${detailPath}`;
  const res = await fetchJson(
    `${API}/wefeed-h5api-bff/subject/caption?format=MP4&id=${videoId}&subjectId=${subjectId}&detailPath=${encodeURIComponent(detailPath)}`,
    commonHeaders(referer)
  );
  if (!res.ok) return [];
  const caps = res.data?.data?.captions || [];
  return caps.map((c) => ({
    lanName: c.lanName || c.lan || "",
    lanCode: c.lan || "",
    url: c.url || "",
    size: parseInt(c.size || 0),
  })).filter((c) => c.url);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const detailPath = req.query.detailPath || (req.url || "").split("?")[0].replace(/^\/api\/episode-matrix\/?/, "");
  const season = parseInt(req.query.season) || 0; // 0 = movie
  const episode = parseInt(req.query.episode) || 0;

  if (!detailPath) {
    return res.status(400).json({ error: "Missing detailPath. Example: /api/episode-matrix?detailPath=dandadan-cILcsymG0R1&season=1&episode=1" });
  }

  const detail = await fetchJson(
    `${API}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(detailPath)}`,
    commonHeaders("https://movieboxonline.net/")
  );
  const subject = detail.ok ? detail.data?.data?.subject : null;
  if (!subject) {
    return res.status(404).json({ error: "Subject not found", detailPath });
  }

  // Language variants: raw BFF dub entries carry `type` (0 = dubbed audio,
  // 1 = subtitle-language variant) and `original` (true = Original Audio).
  // We keep type 0 only - hardsubbed releases (type 1) are skipped; the
  // aggregated soft captions cover those languages.
  const dubs = (subject.dubs || []).filter((d) => d.type === 0 && d.detailPath);
  const seasons = detail.data?.data?.resource?.seasons || [];
  const seasonInfo = seasons.length > 0
    ? seasons.find((s) => s.se === season) || null
    : null;

  // 2. Streams for every variant, in parallel (each with its OWN referer)
  const streamResults = await Promise.all(
    dubs.map((d) =>
      variantStreams(String(d.subjectId || subject.subjectId), d.detailPath, season, episode)
        .then((streams) => ({ dub: d, streams }))
    )
  );

  // 3. Captions: query variants that HAVE streams. Original Audio first
  // (it carries the richest caption set), then any dub variant (rare but
  // some carry their own). Union per language, first (richest) wins.
  const captionVariants = streamResults
    .filter((r) => r.streams.length > 0)
    .sort((a, b) => (b.dub.original ? 1 : 0) - (a.dub.original ? 1 : 0));
  const captionLists = await Promise.all(
    captionVariants.map((r) => {
      const free = r.streams
        .filter((s) => s.url && !s.vipLocked)
        .sort((a, b) => (b.resolutions || b.resolution || 0) - (a.resolutions || a.resolution || 0));
      const chosen = free[0] || r.streams[0];
      return variantCaptions(String(r.dub.subjectId || subject.subjectId), r.dub.detailPath, season, episode, String(chosen?.id || ""));
    })
  );
  const seenLan = new Set();
  const subtitles = [];
  for (const list of captionLists) {
    for (const cap of list) {
      const key = (cap.lanName || cap.lanCode || "").toLowerCase();
      if (!key || seenLan.has(key)) continue;
      seenLan.add(key);
      subtitles.push(cap);
    }
  }

  // 4. Assemble the language matrix (variants without streams are dropped)
  const languages = streamResults
    .filter((r) => r.streams.length > 0)
    .map((r) => ({
      lanName: r.dub.lanName || "",
      lanCode: r.dub.lanCode || "",
      original: !!r.dub.original,
      kind: r.dub.original ? "original" : "dub",
      detailPath: r.dub.detailPath,
      subjectId: String(r.dub.subjectId || ""),
      qualities: r.streams
        .map(normQuality)
        .filter((q) => q.url && !q.vipLocked)
        .sort((a, b) => b.resolution - a.resolution),
    }))
    .filter((l) => l.qualities.length > 0);

  res.status(200).json({
    title: subject.title,
    detailPath,
    subjectType: subject.subjectType,
    season,
    episode,
    seasonInfo: seasonInfo
      ? { season: seasonInfo.se, maxEp: seasonInfo.maxEp, resolutions: seasonInfo.resolutions?.map((r) => r.resolution) || [] }
      : null,
    languageCount: languages.length,
    languages,
    subtitleCount: subtitles.length,
    subtitles,
    fetchedAt: Math.floor(Date.now() / 1000),
    ttlHint: 7200,
  });
}
