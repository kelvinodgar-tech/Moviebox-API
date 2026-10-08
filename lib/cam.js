// CAM-marker helpers shared by every endpoint.
//
// Upstream catalog titles sometimes carry an inline camcorder-quality
// marker, e.g. "Forgotten Island[CAM]" - a cinema-screen recording rather
// than a proper studio release. The marker is part of the title (upstream
// returns it verbatim) and it matters to users: a CAM copy looks and
// sounds worse than a normal release, so dropping it would be misleading.
//
// These helpers make the marker explicit and machine-readable:
//   - every list/detail response item gets `isCam: true|false`
//   - /api/movie and /api/tv add a ready-to-use download `filename` per
//     quality that keeps the marker ("Forgotten Island[CAM] 1080P.mp4"),
//     so an instant download saves the file with the marker intact.

/** Bracketed camcorder-quality markers: [CAM], [CAMRIP], [TS], [HDTS],
 *  [TC], [TELESYNC], [TELECINE], [SCREENER]... The whole bracket content
 *  must be the marker, so language tags like "[English]" never match. */
const CAM_MARKER_RE =
  /\[\s*(?:cam(?:rip|coder)?|hd\s*ts|ts|telesync|hd\s*tc|tc|telecine|screener|dvd\s*scr(?:eener)?|scr)\s*\]/i;

/** True when the title carries a camcorder-quality marker such as "[CAM]". */
export function isCam(title) {
  return CAM_MARKER_RE.test(String(title || ""));
}

/** The matched marker as it appears in the title (e.g. "[CAM]"), or null. */
export function camMarker(title) {
  const m = String(title || "").match(CAM_MARKER_RE);
  return m ? m[0] : null;
}

/** Ready-to-use download filename that keeps the title (and its CAM marker)
 *  verbatim: "Forgotten Island[CAM] 1080P.mp4". TV entries get an SxxExx
 *  block appended when season/episode are given. */
export function downloadFilename(title, resolution, opts = {}) {
  let base = String(title || "").replace(/[\\/:*?"<>|]+/g, "").trim();
  if (!base) base = "download";
  if (opts.season != null && opts.episode != null) {
    base += ` S${String(opts.season).padStart(2, "0")}E${String(opts.episode).padStart(2, "0")}`;
  }
  const res = resolution ? ` ${parseInt(resolution, 10) || resolution}P` : "";
  return `${base}${res}.mp4`;
}
