#!/usr/bin/env python3
"""
MovieBox / Netnaija / OfficialMovieBox — Full Quality Scraper
=============================================================

A single-file, dependency-free (stdlib only) scraper for the MovieBox streaming
backend (h5-api.aoneroom.com) which powers:
  - https://netnaija.film
  - https://movieboxonline.net
  - https://officialmoviebox.com

All 3 sites share the same backend; the --site flag just changes the Origin/Referer
headers used for CORS.

ENDPOINTS:
  1. /wefeed-h5api-bff/subject/play (direct on h5-api.aoneroom.com)
     - Returns ALL qualities (360P/480P/720P/1080P) when called FRESH
     - 1080P is FREE here (URL is returned, not VIP-locked)
     - IP-rate-limited: 1 successful call per ~2-3 minutes per IP
     - This is what the "Watch Free" button calls inline

  2. /wefeed-h5api-bff/subject/download (MUST be called via site proxy)
     - Returns ALL qualities but 1080P is marked vipLocked=true with empty URL
     - More reliable for bulk scraping
     - This is what the "Download This Video" panel calls

STRATEGY:
  - For single movies/episodes: try /play first (gets 1080P free)
  - For bulk scraping: use /download via site proxy (more reliable)
  - Add delay between calls to avoid IP rate-limiting

OUTPUT: JSON file with all quality URLs for each movie/episode.

USAGE:
  # Single movie (gets all qualities incl 1080P free)
  python moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o

  # TV show, specific seasons
  python moviebox_scraper.py --tv lucifer-UQASHYbVPB2 --seasons 1,2,3 --max-episodes 5

  # Top N trending
  python moviebox_scraper.py --trending --limit 10 --max-episodes 2

  # Search home page (since /subject/search needs a token now)
  python moviebox_scraper.py --search "all american" --limit 5

  # Switch site (same backend, different Origin)
  python moviebox_scraper.py --site officialmoviebox --movie oppenheimer-Akh5Nrwl7o

  # Increase delay to avoid rate-limit (default 3s)
  python moviebox_scraper.py --trending --limit 20 --delay 5

  # Custom output path
  python moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o --out ~/Downloads/opp.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# ==================== CONFIG ====================

# Backend API (shared by all 3 sites)
API = "https://h5-api.aoneroom.com"

# The 3 known frontend sites (all proxy the same backend)
SITES: dict[str, str] = {
    "netnaija":         "https://netnaija.film",
    "movieboxonline":   "https://movieboxonline.net",
    "officialmoviebox": "https://officialmoviebox.com",
}

# Browser-like UA (the API checks Sec-Fetch-* headers and tolerates desktop Chrome)
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
)

# Default output directory
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "moviebox_urls.json")

# SSL context (skip cert verification — some CDN nodes have weird certs)
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


# ==================== HTTP LAYER ====================

def _build_headers(origin: str, referer: str | None = None, same_origin: bool = False) -> dict[str, str]:
    """Build browser-like request headers. Same-origin matters for the site-proxy calls."""
    host = urllib.parse.urlparse(origin).hostname or ""
    return {
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": origin,
        "Referer": referer or f"{origin}/",
        "X-Client-Info": '{"timezone":"Africa/Lagos"}',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin" if same_origin else "cross-site",
        "Sec-Ch-Ua": '"Not?A_Brand";v="24", "Chromium";v="152"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Linux"',
    }


def http_get_json(url: str, origin: str, referer: str | None = None) -> dict[str, Any]:
    """GET a URL and return parsed JSON. Raises urllib.error.HTTPError on failure."""
    # If the URL is on the same host as origin, mark same-origin (needed for site-proxy calls)
    same_origin = (urllib.parse.urlparse(url).hostname == urllib.parse.urlparse(origin).hostname)
    headers = _build_headers(origin, referer, same_origin=same_origin)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20, context=_CTX) as resp:
        return json.loads(resp.read())


# ==================== API ENDPOINTS ====================

def get_trending(per_page: int = 20, page: int = 1, origin: str = "https://netnaija.film") -> list[dict]:
    """GET /wefeed-h5api-bff/subject/trending — top trending movies/shows."""
    url = f"{API}/wefeed-h5api-bff/subject/trending?page={page}&perPage={per_page}"
    r = http_get_json(url, origin=origin)
    return r.get("data", {}).get("subjectList", []) or r.get("data", [])


def get_home(origin: str = "https://netnaija.film") -> dict[str, Any]:
    """GET /wefeed-h5api-bff/home — full home page with ~600 subjects across categories."""
    host = urllib.parse.urlparse(origin).hostname
    url = f"{API}/wefeed-h5api-bff/home?host={host}"
    r = http_get_json(url, origin=origin)
    return r.get("data", {})


def get_subject_detail(detail_path: str, origin: str = "https://netnaija.film") -> dict[str, Any]:
    """GET /wefeed-h5api-bff/detail?detailPath=... — full subject info incl. seasons/resolutions."""
    url = f"{API}/wefeed-h5api-bff/detail?detailPath={urllib.parse.quote(detail_path)}"
    r = http_get_json(url, origin=origin)
    return r.get("data", {})


def get_play_qualities(subject_id: str, detail_path: str, se: int = 0, ep: int = 0,
                       origin: str = "https://netnaija.film") -> list[dict]:
    """
    GET /wefeed-h5api-bff/subject/play (direct on h5-api.aoneroom.com)

    Returns ALL qualities (360/480/720/1080) when called FRESH.
    1080P is FREE here (URL is included).
    IP-rate-limited: 1 successful call per ~2-3 min per IP.

    Returns list of: {resolution, size_mb, duration_sec, codec, vipLocked, url, video_id}
    """
    url = (f"{API}/wefeed-h5api-bff/subject/play"
           f"?subjectId={subject_id}&se={se}&ep={ep}&detailPath={urllib.parse.quote(detail_path)}")
    referer = f"{origin}/videoPlayPage/{detail_path}?type=/movie/detail"
    try:
        r = http_get_json(url, origin=origin, referer=referer)
    except urllib.error.HTTPError:
        return []
    streams = r.get("data", {}).get("streams", [])
    return [_normalize_stream(s) for s in streams]


def get_download_qualities(subject_id: str, detail_path: str, se: int = 0, ep: int = 0,
                           origin: str = "https://netnaija.film") -> list[dict]:
    """
    GET /wefeed-h5api-bff/subject/download (MUST be called via site proxy, e.g. netnaija.film)

    Returns ALL qualities but 1080P is marked vipLocked=true with empty URL.
    More reliable for bulk scraping (less aggressive rate-limiting than /play).

    Returns list of: {resolution, size_mb, duration_sec, codec, vipLocked, url, video_id}
    """
    path = (f"/wefeed-h5api-bff/subject/download"
            f"?subjectId={subject_id}&se={se}&ep={ep}&detailPath={urllib.parse.quote(detail_path)}")
    url = f"{origin}{path}"
    referer = f"{origin}/videoPlayPage/{detail_path}?type=/movie/detail"
    try:
        r = http_get_json(url, origin=origin, referer=referer)
    except urllib.error.HTTPError:
        return []
    downloads = r.get("data", {}).get("downloads", [])
    return [_normalize_stream(d) for d in downloads]


def get_captions(video_id: str, subject_id: str, detail_path: str,
                 origin: str = "https://netnaija.film") -> list[dict]:
    """GET /wefeed-h5api-bff/subject/caption — list of subtitle URLs (signed CloudFront URLs)."""
    url = (f"{API}/wefeed-h5api-bff/subject/caption"
           f"?format=MP4&id={video_id}&subjectId={subject_id}&detailPath={urllib.parse.quote(detail_path)}")
    try:
        r = http_get_json(url, origin=origin)
        return r.get("data", {}).get("captions", [])
    except urllib.error.HTTPError:
        return []


def _normalize_stream(s: dict) -> dict:
    """Normalize a stream/download object to a common shape."""
    # /play uses "resolutions" (string), /download uses "resolution" (int)
    resolution = s.get("resolution")
    if resolution is None:
        try:
            resolution = int(s.get("resolutions", 0))
        except (TypeError, ValueError):
            resolution = 0
    try:
        size_mb = round(int(s.get("size", 0)) / 1e6, 2)
    except (TypeError, ValueError):
        size_mb = 0.0
    try:
        duration_sec = int(s.get("duration", 0))
    except (TypeError, ValueError):
        duration_sec = 0
    return {
        "resolution": int(resolution) if resolution else 0,
        "size_mb": size_mb,
        "duration_sec": duration_sec,
        "codec": s.get("codecName", ""),
        "vipLocked": bool(s.get("vipLocked", False)),
        "url": s.get("url", "") or "",
        "video_id": str(s.get("id", "")),
    }


# ==================== HELPERS ====================

def extract_all_subjects(home_data: dict[str, Any]) -> list[dict]:
    """Walk the home response and extract all unique subjects."""
    seen: set[str] = set()
    out: list[dict] = []

    def walk(o: Any) -> None:
        if isinstance(o, dict):
            sid = o.get("subjectId")
            title = o.get("title")
            if sid and title and str(sid) not in seen:
                seen.add(str(sid))
                out.append({
                    "subjectId": str(sid),
                    "title": str(title),
                    "subjectType": o.get("subjectType"),
                    "detailPath": o.get("detailPath"),
                })
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(home_data)
    return out


def fetch_all_qualities(subject_id: str, detail_path: str, se: int = 0, ep: int = 0,
                        origin: str = "https://netnaija.film") -> tuple[list[dict], str | None]:
    """
    Try /play first (gets 1080P free if fresh). Fall back to /download (1080P vipLocked).

    Returns (qualities, source_endpoint) where source is "play" or "download".
    """
    # Try /play first — it returns 1080P free
    qualities = get_play_qualities(subject_id, detail_path, se=se, ep=ep, origin=origin)
    if qualities:
        return qualities, "play"

    # Fallback: /download via site proxy (1080P will be vipLocked but 360/480/720 free)
    qualities = get_download_qualities(subject_id, detail_path, se=se, ep=ep, origin=origin)
    if qualities:
        return qualities, "download"

    return [], None


def best_free_quality(qualities: list[dict]) -> dict | None:
    """Return the highest-resolution free (non-VIP) quality, or None."""
    free = [q for q in qualities if q["url"] and not q["vipLocked"]]
    if not free:
        return None
    return max(free, key=lambda q: q["resolution"])


# ==================== SCRAPERS ====================

def scrape_movie(subject: dict, origin: str = "https://netnaija.film", verbose: bool = True) -> dict | None:
    """
    Scrape a single movie (subjectType=1). One /play call with se=0,ep=0 returns all qualities.

    `subject` must have: subjectId, detailPath, title
    """
    sid = subject["subjectId"]
    dp = subject["detailPath"]
    title = subject.get("title", "?")
    if verbose:
        print(f"  [...] {title}  (sid={sid})")
    try:
        qualities, source = fetch_all_qualities(sid, dp, se=0, ep=0, origin=origin)
    except Exception as e:
        if verbose:
            print(f"       ERROR: {e}")
        return None
    if not qualities:
        if verbose:
            print(f"       no streams (rate-limited?)")
        return None
    best = best_free_quality(qualities)
    if verbose:
        summary = ", ".join(
            f'{q["resolution"]}P({"VIP" if q["vipLocked"] else "free"})'
            for q in qualities
        )
        print(f"       OK [{source}] {len(qualities)} qualities: {summary}")
        if best:
            print(f"       best free: {best['resolution']}P {best['size_mb']}MB")
    return {
        "title": title,
        "subjectId": sid,
        "subjectType": 1,
        "detailPath": dp,
        "watch_url": f"{origin}/videoPlayPage/{dp}?type=/movie/detail",
        "source": source,
        "qualities": qualities,
    }


def scrape_tv(subject: dict, origin: str = "https://netnaija.film",
              season_filter: set[int] | None = None,
              max_episodes_per_season: int = 2,
              delay: float = 3.0,
              verbose: bool = True) -> dict | None:
    """
    Scrape a TV show (subjectType=2). Iterates seasons and episodes.

    `subject` must have: subjectId, detailPath, title
    """
    sid = subject["subjectId"]
    dp = subject["detailPath"]
    title = subject.get("title", "?")
    if verbose:
        print(f"  [...] {title} (TV)  (sid={sid})")
    try:
        detail = get_subject_detail(dp, origin=origin)
    except Exception as e:
        if verbose:
            print(f"       detail ERROR: {e}")
        return None

    seasons = detail.get("resource", {}).get("seasons", [])
    if not seasons:
        if verbose:
            print(f"       no seasons info")
        return None

    result: dict[str, Any] = {
        "title": title,
        "subjectId": sid,
        "subjectType": 2,
        "detailPath": dp,
        "watch_url": f"{origin}/videoPlayPage/{dp}?type=/movie/detail",
        "seasons": [],
    }

    for season in seasons:
        se = season.get("se", 0)
        max_ep = season.get("maxEp", 0)
        if season_filter and se not in season_filter:
            continue
        avail_res = [r.get("resolution") for r in season.get("resolutions", [])]
        if verbose:
            print(f"       Season {se} ({max_ep} ep, qualities: {avail_res})")

        ep_results: list[dict] = []
        ep_limit = min(max_ep, max_episodes_per_season) if max_episodes_per_season else max_ep
        for ep in range(1, ep_limit + 1):
            try:
                qualities, source = fetch_all_qualities(sid, dp, se=se, ep=ep, origin=origin)
                if qualities:
                    best = best_free_quality(qualities)
                    summary = ", ".join(
                        f'{q["resolution"]}P({"VIP" if q["vipLocked"] else "free"})'
                        for q in qualities
                    )
                    if verbose:
                        if best:
                            print(f"         S{se}E{ep} [{source}] {summary}  "
                                  f"best: {best['resolution']}P {best['size_mb']}MB")
                        else:
                            print(f"         S{se}E{ep} [{source}] {summary}  (all VIP)")
                    ep_results.append({
                        "season": se,
                        "episode": ep,
                        "source": source,
                        "qualities": qualities,
                    })
                else:
                    if verbose:
                        print(f"         S{se}E{ep}: rate-limited, skipping")
                time.sleep(delay)
            except Exception as e:
                if verbose:
                    print(f"         S{se}E{ep}: ERROR {e}")
        if ep_results:
            result["seasons"].append({
                "season": se,
                "maxEp": max_ep,
                "episodes": ep_results,
            })

    if result["seasons"]:
        total_eps = sum(len(s["episodes"]) for s in result["seasons"])
        if verbose:
            print(f"       Total: {len(result['seasons'])} seasons, {total_eps} episodes")
    return result if result["seasons"] else None


# ==================== CLI ====================

def main() -> int:
    p = argparse.ArgumentParser(
        description="MovieBox / Netnaija / OfficialMovieBox full-quality scraper",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--trending", action="store_true", help="scrape from trending list")
    p.add_argument("--home", action="store_true", help="scrape from home page (~600 subjects)")
    p.add_argument("--search", help="filter home results by title (case-insensitive)")
    p.add_argument("--movie", help="scrape single movie by detailPath (e.g. oppenheimer-Akh5Nrwl7o)")
    p.add_argument("--tv", help="scrape TV show by detailPath (e.g. lucifer-UQASHYbVPB2)")
    p.add_argument("--seasons", help="comma-separated season numbers for TV (e.g. 1,2,3)")
    p.add_argument("--limit", type=int, default=10, help="max subjects to scrape (default: 10)")
    p.add_argument("--max-episodes", type=int, default=2,
                   help="max episodes per TV season (default: 2, use 0 for all)")
    p.add_argument("--delay", type=float, default=3.0,
                   help="delay between calls in seconds (default: 3.0, increase if rate-limited)")
    p.add_argument("--site", choices=list(SITES.keys()), default="netnaija",
                   help="which site to impersonate (default: netnaija)")
    p.add_argument("--out", default=DEFAULT_OUT, help=f"output JSON path (default: {DEFAULT_OUT})")
    p.add_argument("--quiet", action="store_true", help="suppress progress output")
    args = p.parse_args()

    if args.site not in SITES:
        print(f"ERROR: unknown site '{args.site}'. Choose from: {list(SITES.keys())}", file=sys.stderr)
        return 2
    origin = SITES[args.site]
    verbose = not args.quiet

    if verbose:
        print(f"[*] Site: {origin}")
        print(f"[*] Delay between calls: {args.delay}s")

    results: list[dict] = []

    if args.movie:
        # Single movie by detailPath
        try:
            d = get_subject_detail(args.movie, origin=origin)
            sid = d.get("subject", {}).get("subjectId", "?")
            title = d.get("subject", {}).get("title", args.movie)
        except Exception as e:
            print(f"ERROR fetching detail for {args.movie}: {e}", file=sys.stderr)
            return 1
        r = scrape_movie({"subjectId": sid, "detailPath": args.movie, "title": title},
                         origin=origin, verbose=verbose)
        if r:
            results.append(r)

    elif args.tv:
        # Single TV show by detailPath
        try:
            d = get_subject_detail(args.tv, origin=origin)
            sid = d.get("subject", {}).get("subjectId", "?")
            title = d.get("subject", {}).get("title", args.tv)
        except Exception as e:
            print(f"ERROR fetching detail for {args.tv}: {e}", file=sys.stderr)
            return 1
        sf = set(int(x) for x in args.seasons.split(",")) if args.seasons else None
        max_eps = args.max_episodes if args.max_episodes > 0 else 999
        r = scrape_tv({"subjectId": sid, "detailPath": args.tv, "title": title},
                      origin=origin, season_filter=sf,
                      max_episodes_per_season=max_eps, delay=args.delay, verbose=verbose)
        if r:
            results.append(r)

    else:
        # Bulk: trending or home
        if args.home or args.search:
            if verbose:
                print("[*] Fetching home page...")
            try:
                home = get_home(origin=origin)
            except Exception as e:
                print(f"ERROR fetching home: {e}", file=sys.stderr)
                return 1
            subjects = extract_all_subjects(home)
            if args.search:
                q = args.search.lower()
                subjects = [s for s in subjects if q in s["title"].lower()]
            subjects = subjects[:args.limit]
        else:
            if verbose:
                print("[*] Fetching trending...")
            try:
                subjects = get_trending(per_page=max(args.limit, 20), origin=origin)[:args.limit]
            except Exception as e:
                print(f"ERROR fetching trending: {e}", file=sys.stderr)
                return 1
        if verbose:
            print(f"[*] Got {len(subjects)} subjects")

        for s in subjects:
            if s.get("subjectType") == 2:
                r = scrape_tv(s, origin=origin,
                              max_episodes_per_season=args.max_episodes,
                              delay=args.delay, verbose=verbose)
            else:
                r = scrape_movie(s, origin=origin, verbose=verbose)
            if r:
                results.append(r)
            time.sleep(args.delay)

    # Save
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    if verbose:
        print(f"\n[*] Saved {len(results)} entries -> {args.out}")

    # Summary
    if verbose:
        print("\n=== Summary ===")
        for r in results:
            if r.get("subjectType") == 2:
                n_eps = sum(len(s["episodes"]) for s in r.get("seasons", []))
                # Count free qualities
                free_1080 = sum(
                    1 for s in r.get("seasons", [])
                    for ep in s.get("episodes", [])
                    for q in ep["qualities"]
                    if q["resolution"] == 1080 and not q["vipLocked"] and q["url"]
                )
                print(f"  [TV]  {r['title']:32s}  "
                      f"{len(r.get('seasons', []))} seasons, {n_eps} episodes  "
                      f"(1080P free: {free_1080})")
                # Show first episode's best quality URL
                for s in r.get("seasons", [])[:1]:
                    for ep in s.get("episodes", [])[:1]:
                        best = best_free_quality(ep["qualities"])
                        if best:
                            url_preview = best["url"][:80] + ("..." if len(best["url"]) > 80 else "")
                            print(f"        S{s['season']}E{ep['episode']} best free: "
                                  f"{best['resolution']}P {best['size_mb']}MB  {url_preview}")
            else:
                best = best_free_quality(r.get("qualities", []))
                if best:
                    url_preview = best["url"][:80] + ("..." if len(best["url"]) > 80 else "")
                    print(f"  [MOV] {r['title']:32s}  best free: "
                          f"{best['resolution']}P {best['size_mb']}MB  {url_preview}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
