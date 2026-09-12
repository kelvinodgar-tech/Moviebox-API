// Final calibration:
// 1. Mint 6 fresh tokens, group by full page-1 order signature -> majority group
// 2. Output a majority-group token (long expiry) to pin in search.js
// 3. With the majority token, compare page2-perPage:0 vs page2-perPage:24
//    (the site's "load more" uses perPage:24 - verify our walk matches)
import crypto from "node:crypto";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const API = "https://h5-api.aoneroom.com";
const SITE = "https://movieboxonline.net";

function clientToken() {
  const e = Math.floor(Date.now() / 1000);
  const n = crypto.createHash("md5").update(String(e).split("").reverse().join("")).digest("hex");
  return `${e},${n}`;
}

function bffHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Client-Info": '{"timezone":"Africa/Lagos"}',
    "X-Request-Lang": "en",
    Origin: SITE,
    Referer: SITE + "/",
    ...extra,
  };
}

function metaOf(token) {
  const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(b64, "base64").toString("utf8");
  const uid = json.match(/"uid"\s*:\s*(\d+)/);
  const exp = json.match(/"exp"\s*:\s*(\d+)/);
  return { uid: uid?.[1], exp: exp ? parseInt(exp[1]) : 0 };
}

async function mintAnonymous() {
  const r = await fetch(`${API}/wefeed-h5api-bff/subject/search-suggest`, {
    method: "POST",
    headers: bffHeaders({ Authorization: "", "X-Client-Token": clientToken() }),
    body: JSON.stringify({ keyword: "movie", perPage: 10 }),
    signal: AbortSignal.timeout(10000),
  });
  const xuser = r.headers.get("x-user");
  return xuser ? JSON.parse(xuser).token : null;
}

async function searchPage(token, keyword, page, perPage = 0) {
  const r = await fetch(`${API}/wefeed-h5api-bff/subject/search`, {
    method: "POST",
    headers: bffHeaders({ Authorization: `Bearer ${token}` }),
    body: JSON.stringify({ keyword, page, perPage, subjectType: 0 }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) return { err: r.status };
  const data = await r.json();
  const items = data?.data?.items || [];
  return {
    ids: items.map((it) => String(it.subjectId)),
    titles: items.map((it) => it.title),
    hasMore: !!data?.data?.pager?.hasMore,
    nextPage: data?.data?.pager?.nextPage,
  };
}

const keyword = "Odyssey";

// --- 1. mint 6, group by signature ---
const tokens = [];
for (let i = 0; i < 6; i++) {
  const t = await mintAnonymous();
  if (t) tokens.push(t);
}
const sigs = new Map(); // sig -> {count, token, meta}
for (const t of tokens) {
  const r = await searchPage(t, keyword, 1);
  const sig = r.ids.join(",");
  if (!sigs.has(sig)) sigs.set(sig, { count: 0, token: t, meta: metaOf(t), ids: r.ids, titles: r.titles });
  sigs.get(sig).count++;
}
console.log("=== FRESH TOKEN SIGNATURE GROUPS (Odyssey page 1) ===");
let majority = null;
for (const [sig, g] of sigs) {
  console.log(`group x${g.count}: uid=${g.meta.uid} exp=${new Date(g.meta.exp * 1000).toISOString()}`);
  g.titles.slice(0, 12).forEach((t, i) => console.log("   " + String(i + 1).padStart(2, " ") + ". " + t));
  if (!majority || g.count > majority.count) majority = g;
}
console.log(`\nMAJORITY group has ${majority.count}/6 tokens`);
console.log("MAJORITY PIN TOKEN (uid=" + majority.meta.uid + ", exp=" + new Date(majority.meta.exp * 1000).toISOString() + "):");
console.log(majority.token);

// --- 2. pagination check with majority token ---
const t = majority.token;
console.log("\n=== PAGINATION CHECK (majority token) ===");
const p1 = await searchPage(t, keyword, 1, 0);
const p2a = await searchPage(t, keyword, 2, 0);
const p2b = await searchPage(t, keyword, 2, 24);
console.log("page1 perPage:0 ->", p1.ids.length, "items, hasMore:", p1.hasMore, "nextPage:", p1.nextPage);
console.log("page2 perPage:0 ->", p2a.ids.length, "items, first 3:", p2a.titles.slice(0, 3));
console.log("page2 perPage:24 ->", p2b.ids.length, "items, first 3:", p2b.titles.slice(0, 3));
console.log("page2(per0) == page2(per24)?", p2a.ids.join(",") === p2b.ids.join(","));
if (p2a.ids.join(",") !== p2b.ids.join(",")) {
  console.log("overlap page2 variants:", p2a.ids.filter((id) => p2b.ids.includes(id)).length, "/", p2a.ids.length);
}
// Does perPage:24 on page 2 continue the ranking list (items 11+) or skip?
console.log("page1 last item == page2(per24) first item?", p1.ids[p1.ids.length - 1] === p2b.ids[0]);
console.log("page2(per0) starts where page1 ended (no gap)?", p1.ids[p1.ids.length - 1] !== p2a.ids[0] ? "check:" + p2a.titles[0] : "adjacent-dup?");
