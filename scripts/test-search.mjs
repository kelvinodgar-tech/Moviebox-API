// Local harness: runs api/search.js exactly as the Vercel function would run,
// prints the result order so it can be compared with the movieboxonline.net
// majority-variant reference order.
import { readFileSync } from "node:fs";

const mod = await import("../api/search.js");
const handler = mod.default;

const q = process.argv[2] || "Odyssey";
const limit = process.argv[3] || "20";

const json = await new Promise((resolve) => {
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ code: this.statusCode, body }); },
  };
  handler({ query: { q, limit } }, res);
});

console.log(`HTTP ${json.code} | source=${json.body.source} count=${json.body.count} total=${json.body.total}`);
for (const [i, r] of (json.body.results || []).entries()) {
  console.log(String(i + 1).padStart(2, " ") + ". " + r.title + " | " + r.type);
}
if (json.body.suggestions?.length) console.log("suggestions:", json.body.suggestions.join(", "));
