// Local harness for api/episode-matrix.js - mirrors the Vercel function.
import mod from "../api/episode-matrix.js";
const handler = (mod && mod.handler) || mod;

const detailPath = process.argv[2] || "dandadan-cILcsymG0R1";
const season = process.argv[3] || "1";
const episode = process.argv[4] || "1";

const json = await new Promise((resolve) => {
  const res = {
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    json(body) { resolve({ code: this.statusCode, body }); },
    end() {},
  };
  handler({ method: "GET", url: `/api/episode-matrix?detailPath=${detailPath}&season=${season}&episode=${episode}`, query: { detailPath, season, episode } }, res);
});

console.log(`HTTP ${json.code}`);
const b = json.body;
console.log(`title: ${b.title} | langs: ${b.languageCount} | subs: ${b.subtitleCount} | seasonInfo:`, JSON.stringify(b.seasonInfo));
for (const lang of b.languages || []) {
  console.log(`  [${lang.kind}] ${lang.lanName} (${lang.lanCode}) -> ${lang.qualities.map((q) => q.resolution + "p/" + q.size_mb + "MB").join(", ")}`);
}
console.log("subtitles:", (b.subtitles || []).map((s) => s.lanName).join(", "));
// spot check first url playable
const q = b.languages?.[0]?.qualities?.[0];
if (q) console.log("top url:", q.url.slice(0, 90));
