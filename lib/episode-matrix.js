// Episode-matrix core: GET /api/episode-matrix?id=<detailPath>&season=1&episode=1
// The composite endpoint for multi-language clients: the FULL language matrix
// for one episode (or a whole movie) in a single call.
//   - one entry per dub variant (Original Audio + every language dub), each
//     with its own playable qualities (resolution/size/url)
//   - the AGGREGATED subtitle set: captions collected from every variant that
//     has streams, deduped per language (the Original Audio variant usually
//     carries the richest caption set while dub variants carry none; the
//     union is returned once so clients get every language in one call)
//   - ttlHint: seconds the returned CDN urls stay valid (video sign urls
//     live for hours, caption urls for days; a conservative 2h is advertised)
//
// For movies omit season/episode - the same language matrix is returned
// without episode routing.
//
// All dub variants of an entry share the BFF subject model: each variant is
// its own subject with its own subjectId/detailPath, and /subject/play is
// queried per variant with the variant's OWN play URL as referer (the BFF
// validates the referer's detailPath against the requested variant - using
// the base entry's referer returns 0 streams for dub variants). Calls run
// in parallel (typically 2-6 variants).

import { API, SITE, commonHeaders, fetchJson } from "./upstream.js";

/** Play streams for one variant; falls back to the download endpoint. */
async function variantStreams(subjectId, detailPath, season, episode) {
  const referer = `${SITE}/play/${detailPath}`;
  let res = await fetchJson(
    `${API}/wefeed-h5api-bff/subject/play?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${encodeURIComponent(detailPath)}`,
    commonHeaders(referer)
  );
  let streams = res.ok ? res.data?.data?.streams || [] : [];
  if (streams.length === 0) {
    res = await fetchJson(
      `${SITE}/wefeed-h5api-bff/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}&detailPath=${encodeURIComponent(detailPath)}`,
      commonHeaders(referer)
    );
    streams = res.ok ? res.data?.data?.downloads || [] : [];
  }
  return streams;
}

/** Captions for one variant, using its highest-res stream's videoId. */
async function variantCaptions(subjectId, detailPath, season, episode, videoId) {
  if (!videoId) return [];
  const referer = `${SITE}/play/${detailPath}`;
  const res = await fetchJson(
    `${API}/wefeed-h5api-bff/subject/caption?format=MP4&id=${videoId}&subjectId=${subjectId}&detailPath=${encodeURIComponent(detailPath)}`,
    commonHeaders(referer)
  );
  if (!res.ok) return [];
  return (res.data?.data?.captions || [])
    .map((c) => ({
      lanName: c.lanName || c.lan || "",
      lanCode: c.lan || "",
      url: c.url || "",
      size: parseInt(c.size || 0),
    }))
    .filter((c) => c.url);
}

function normQuality(s) {
  return {
    resolution: parseInt(s.resolutions || s.resolution || 0),
    size_mb: Math.round((parseInt(s.size || 0) / 1e6) * 100) / 100,
    duration_sec: s.duration || 0,
    codec: s.codecName || "h264",
    vipLocked: s.vipLocked || false,
    url: s.url || "",
    videoId: String(s.id || ""),
  };
}

/** Entry point. params: { id, season, episode } -> { status, body }. */
export async function run(params) {
  const detailPath = String(params.id || params.detailPath || "").trim();
  const season = parseInt(params.season) || 0; // 0 = movie
  const episode = parseInt(params.episode) || 0;

  if (!detailPath) {
    return {
      status: 400,
      body: {
        error: "Missing id parameter. Example: /api/episode-matrix?id=dandadan-cILcsymG0R1&season=1&episode=1",
      },
    };
  }

  const detail = await fetchJson(
    `${API}/wefeed-h5api-bff/detail?detailPath=${encodeURIComponent(detailPath)}`,
    commonHeaders()
  );
  if (!detail.ok || !detail.data) {
    return {
      status: detail.status || 502,
      body: { error: `Upstream returned ${detail.status || 0}`, detailPath },
    };
  }
  const subject = detail.data?.data?.subject;
  if (!subject) {
    return { status: 404, body: { error: "Subject not found", detailPath } };
  }

  // Language variants: raw BFF dub entries carry `type` (0 = dubbed audio,
  // 1 = subtitle-language variant) and `original` (true = Original Audio).
  // Only type 0 is kept - hardsubbed releases (type 1) are skipped; the
  // aggregated soft captions cover those languages.
  //
  // EMPTY-dubs fallback: some entries have NO dub variants while the streams
  // live on the MAIN subject (movies especially). The main subject is then
  // treated as one unnamed Original Audio variant - otherwise the matrix
  // would return zero languages and clients would show nothing playable.
  const dubsRaw = (subject.dubs || []).filter((d) => d.type === 0 && d.detailPath);
  const dubs = dubsRaw.length > 0
    ? dubsRaw
    : [
        {
          subjectId: String(subject.subjectId),
          lanName: "",
          lanCode: "",
          original: true,
          type: 0,
          detailPath,
        },
      ];

  const isTv = subject.subjectType === 2;
  const se = isTv ? Math.max(season, 1) : 0;
  const ep = isTv ? Math.max(episode, 1) : 0;
  const seasons = detail.data?.data?.resource?.seasons || [];
  const seasonInfo = isTv && seasons.length > 0 ? seasons.find((s) => s.se === se) || null : null;

  // Streams for every variant, in parallel (each with its OWN referer)
  const streamResults = await Promise.all(
    dubs.map((d) =>
      variantStreams(String(d.subjectId || subject.subjectId), d.detailPath, se, ep).then(
        (streams) => ({ dub: d, streams })
      )
    )
  );

  // Captions: query variants that HAVE streams. Original Audio first (it
  // carries the richest caption set), then any dub variant. Union per
  // language, first (richest) wins.
  const captionVariants = streamResults
    .filter((r) => r.streams.length > 0)
    .sort((a, b) => (b.dub.original ? 1 : 0) - (a.dub.original ? 1 : 0));
  const captionLists = await Promise.all(
    captionVariants.map((r) => {
      const free = r.streams
        .filter((s) => s.url && !s.vipLocked)
        .sort((a, b) => (b.resolutions || b.resolution || 0) - (a.resolutions || a.resolution || 0));
      const chosen = free[0] || r.streams[0];
      return variantCaptions(
        String(r.dub.subjectId || subject.subjectId),
        r.dub.detailPath,
        se,
        ep,
        String(chosen?.id || "")
      );
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

  // Assemble the language matrix (variants without streams are dropped)
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

  return {
    status: 200,
    body: {
      title: subject.title || "",
      detailPath,
      subjectType: subject.subjectType,
      type: isTv ? "tv" : "movie",
      season: isTv ? se : 0,
      episode: isTv ? ep : 0,
      seasonInfo: seasonInfo
        ? {
            season: seasonInfo.se,
            maxEp: seasonInfo.maxEp,
            resolutions: seasonInfo.resolutions?.map((r) => r.resolution) || [],
          }
        : null,
      languageCount: languages.length,
      languages,
      subtitleCount: subtitles.length,
      subtitles,
      fetchedAt: Math.floor(Date.now() / 1000),
      ttlHint: 7200,
    },
  };
}
