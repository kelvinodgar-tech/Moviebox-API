#!/usr/bin/env python3
"""
MovieBox / Netnaija / OfficialMovieBox - Full Quality Scraper
=============================================================

A single-file, dependency-free (stdlib only) scraper for the MovieBox streaming
backend (h5-api.aoneroom.com) which powers:
  - https://netnaija.film
  - https://movieboxonline.net
  - https://officialmoviebox.com

All 3 sites share the same backend; the --site flag just changes the Origin/Referer
headers used for CORS.

IMPORTANT: The MP4 URLs returned by the API require a Referer header
(Referer: https://netnaija.film/) to download. Without it, the CDN returns
HTTP 429. When using the hosted API at moviebox-api-eight.vercel.app,
use the /api/stream and /api/download proxy endpoints which inject the
Referer header server-side.

HOSTED API ENDPOINTS:
  GET /api/trending?limit=10          - trending movies/shows
  GET /api/search?q=query&limit=20    - search (combines suggest + trending + home)
  GET /api/home                       - full home page content
  GET /api/details/:detailPath        - full details (synopsis, cast, dubs, trailer)
  GET /api/seasons/:detailPath        - TV seasons info (episodes, resolutions)
  GET /api/movie/:detailPath          - movie quality URLs (360P/480P/720P/1080P)
  GET /api/tv/:detailPath?s=1&e=1     - TV episode quality URLs
  GET /api/captions/:detailPath?s=1&e=1 - subtitle URLs (13+ languages)
  GET /api/stream?url=<encoded>       - stream proxy (injects Referer, handles Range)
  GET /api/download?url=<enc>&f=name  - download proxy (injects Referer, sets attachment)

AUDIO/DUBS:
  The /api/details endpoint returns a "dubs" array with alternative audio tracks.
  Each dub has its own detailPath. To get video URLs for a dubbed version,
  call /api/movie or /api/tv with the dub's detailPath instead of the original.

SUBTITLES:
  The /api/captions endpoint returns signed subtitle URLs for 13+ languages.
  These URLs do NOT require a Referer header and can be used directly.

USAGE:
  # Single movie (gets all qualities incl 1080P free)
  python moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o

  # TV show, specific seasons
  python moviebox_scraper.py --tv lucifer-UQASHYbVPB2 --seasons 1,2,3 --max-episodes 5

  # Top N trending
  python moviebox_scraper.py --trending --limit 10 --max-episodes 2

  # Search home page by title
  python moviebox_scraper.py --search "all american" --limit 5

  # Switch site (same backend, different Origin)
  python moviebox_scraper.py --site officialmoviebox --movie oppenheimer-Akh5Nrwl7o

  # Increase delay to avoid rate-limit (default 3s)
  python moviebox_scraper.py --trending --limit 20 --delay 5
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

API = "https://h5-api.aoneroom.com"

SITES = {
    "netnaija":         "https://netnaija.film",
    "movieboxonline":   "https://movieboxonline.net",
    "officialmoviebox": "https://officialmoviebox.com",
}

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
)

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "moviebox_urls.json")

_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


def _build_headers(origin, referer=None, same_origin=False):
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
    }


def http_get_json(url, origin, referer=None):
    same_origin = (urllib.parse.urlparse(url).hostname == urllib.parse.urlparse(origin).hostname)
    headers = _build_headers(origin, referer, same_origin=same_origin)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20, context=_CTX) as resp:
        return json.loads(resp.read())


def get_trending(per_page=20, page=1, origin="https://netnaija.film"):
    url = f"{API}/wefeed-h5api-bff/subject/trending?page={page}&perPage={per_page}"
    r = http_get_json(url, origin=origin)
    return r.get("data", {}).get("subjectList", []) or r.get("data", [])


def get_home(origin="https://netnaija.film"):
    host = urllib.parse.urlparse(origin).hostname
    url = f"{API}/wefeed-h5api-bff/home?host={host}"
    r = http_get_json(url, origin=origin)
    return r.get("data", {})


def get_subject_detail(detail_path, origin="https://netnaija.film"):
    """Get full details including synopsis, cast, dubs, seasons, trailer."""
    url = f"{API}/wefeed-h5api-bff/detail?detailPath={urllib.parse.quote(detail_path)}"
    r = http_get_json(url, origin=origin)
    return r.get("data", {})


def get_play_qualities(subject_id, detail_path, se=0, ep=0, origin="https://netnaija.film"):
    """Get all quality URLs (incl 1080P free) from /subject/play.
    Note: IP-rate-limited (1 success per ~2-3 min).
    URLs require Referer: https://netnaija.film/ to download."""
    url = (f"{API}/wefeed-h5api-bff/subject/play"
           f"?subjectId={subject_id}&se={se}&ep={ep}&detailPath={urllib.parse.quote(detail_path)}")
    referer = f"{origin}/videoPlayPage/{detail_path}?type=/movie/detail"
    try:
        r = http_get_json(url, origin=origin, referer=referer)
    except urllib.error.HTTPError:
        return []
    streams = r.get("data", {}).get("streams", [])
    return [_normalize_stream(s) for s in streams]


def get_download_qualities(subject_id, detail_path, se=0, ep=0, origin="https://netnaija.film"):
    """Get quality URLs from /subject/download (via site proxy).
    1080P is vipLocked. More reliable for bulk scraping.
    URLs require Referer: https://netnaija.film/ to download."""
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


def get_captions(video_id, subject_id, detail_path, origin="https://netnaija.film"):
    """Get subtitle URLs (13+ languages). These URLs do NOT need Referer."""
    url = (f"{API}/wefeed-h5api-bff/subject/caption"
           f"?format=MP4&id={video_id}&subjectId={subject_id}&detailPath={urllib.parse.quote(detail_path)}")
    try:
        r = http_get_json(url, origin=origin)
        return r.get("data", {}).get("captions", [])
    except urllib.error.HTTPError:
        return []


def get_dubs(detail_path, origin="https://netnaija.film"):
    """Get alternative audio tracks (dubs). Each dub has its own detailPath."""
    detail = get_subject_detail(detail_path, origin=origin)
    dubs = detail.get("subject", {}).get("dubs", [])
    return [{"lanName": d.get("lanName"), "lanCode": d.get("lanCode"),
             "type": "dub" if d.get("type") == 0 else "sub",
             "original": d.get("original", False),
             "detailPath": d.get("detailPath")} for d in dubs]


def _normalize_stream(s):
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


def extract_all_subjects(home_data):
    seen = set()
    out = []
    def walk(o):
        if isinstance(o, dict):
            sid = o.get("subjectId")
            title = o.get("title")
            if sid and title and str(sid) not in seen:
                seen.add(str(sid))
                out.append({"subjectId": str(sid), "title": str(title),
                            "subjectType": o.get("subjectType"), "detailPath": o.get("detailPath")})
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(home_data)
    return out


def fetch_all_qualities(subject_id, detail_path, se=0, ep=0, origin="https://netnaija.film"):
    qualities = get_play_qualities(subject_id, detail_path, se=se, ep=ep, origin=origin)
    if qualities:
        return qualities, "play"
    qualities = get_download_qualities(subject_id, detail_path, se=se, ep=ep, origin=origin)
    if qualities:
        return qualities, "download"
    return [], None


def best_free_quality(qualities):
    free = [q for q in qualities if q["url"] and not q["vipLocked"]]
    if not free:
        return None
    return max(free, key=lambda q: q["resolution"])


def scrape_movie(subject, origin="https://netnaija.film", verbose=True):
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
        summary = ", ".join(f'{q["resolution"]}P({"VIP" if q["vipLocked"] else "free"})' for q in qualities)
        print(f"       OK [{source}] {len(qualities)} qualities: {summary}")
    return {"title": title, "subjectId": sid, "subjectType": 1, "detailPath": dp,
            "watch_url": f"{origin}/videoPlayPage/{dp}?type=/movie/detail",
            "source": source, "qualities": qualities}


def scrape_tv(subject, origin="https://netnaija.film", season_filter=None,
              max_episodes_per_season=2, delay=3.0, verbose=True):
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
    result = {"title": title, "subjectId": sid, "subjectType": 2, "detailPath": dp,
              "watch_url": f"{origin}/videoPlayPage/{dp}?type=/movie/detail", "seasons": []}
    for season in seasons:
        se = season.get("se", 0)
        max_ep = season.get("maxEp", 0)
        if season_filter and se not in season_filter:
            continue
        if verbose:
            avail_res = [r.get("resolution") for r in season.get("resolutions", [])]
            print(f"       Season {se} ({max_ep} ep, qualities: {avail_res})")
        ep_results = []
        ep_limit = min(max_ep, max_episodes_per_season) if max_episodes_per_season else max_ep
        for ep in range(1, ep_limit + 1):
            try:
                qualities, source = fetch_all_qualities(sid, dp, se=se, ep=ep, origin=origin)
                if qualities:
                    best = best_free_quality(qualities)
                    summary = ", ".join(f'{q["resolution"]}P({"VIP" if q["vipLocked"] else "free"})' for q in qualities)
                    if verbose:
                        if best:
                            print(f"         S{se}E{ep} [{source}] {summary}  best: {best['resolution']}P {best['size_mb']}MB")
                        else:
                            print(f"         S{se}E{ep} [{source}] {summary}  (all VIP)")
                    ep_results.append({"season": se, "episode": ep, "source": source, "qualities": qualities})
                else:
                    if verbose:
                        print(f"         S{se}E{ep}: rate-limited, skipping")
                time.sleep(delay)
            except Exception as e:
                if verbose:
                    print(f"         S{se}E{ep}: ERROR {e}")
        if ep_results:
            result["seasons"].append({"season": se, "maxEp": max_ep, "episodes": ep_results})
    if result["seasons"]:
        total_eps = sum(len(s["episodes"]) for s in result["seasons"])
        if verbose:
            print(f"       Total: {len(result['seasons'])} seasons, {total_eps} episodes")
    return result if result["seasons"] else None


def main():
    p = argparse.ArgumentParser(description="MovieBox / Netnaija / OfficialMovieBox scraper")
    p.add_argument("--trending", action="store_true")
    p.add_argument("--home", action="store_true")
    p.add_argument("--search", help="filter home results by title")
    p.add_argument("--movie", help="scrape single movie by detailPath")
    p.add_argument("--tv", help="scrape TV show by detailPath")
    p.add_argument("--seasons", help="comma-separated season numbers for TV")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--max-episodes", type=int, default=2)
    p.add_argument("--delay", type=float, default=3.0)
    p.add_argument("--site", choices=list(SITES.keys()), default="netnaija")
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()
    origin = SITES[args.site]
    verbose = not args.quiet
    if verbose:
        print(f"[*] Site: {origin}")
        print(f"[*] Delay: {args.delay}s")
    results = []
    if args.movie:
        d = get_subject_detail(args.movie, origin=origin)
        sid = d.get("subject", {}).get("subjectId", "?")
        title = d.get("subject", {}).get("title", args.movie)
        r = scrape_movie({"subjectId": sid, "detailPath": args.movie, "title": title}, origin=origin, verbose=verbose)
        if r: results.append(r)
    elif args.tv:
        d = get_subject_detail(args.tv, origin=origin)
        sid = d.get("subject", {}).get("subjectId", "?")
        title = d.get("subject", {}).get("title", args.tv)
        sf = set(int(x) for x in args.seasons.split(",")) if args.seasons else None
        max_eps = args.max_episodes if args.max_episodes > 0 else 999
        r = scrape_tv({"subjectId": sid, "detailPath": args.tv, "title": title}, origin=origin,
                      season_filter=sf, max_episodes_per_season=max_eps, delay=args.delay, verbose=verbose)
        if r: results.append(r)
    else:
        if args.home or args.search:
            if verbose: print("[*] Fetching home page...")
            home = get_home(origin=origin)
            subjects = extract_all_subjects(home)
            if args.search:
                q = args.search.lower()
                subjects = [s for s in subjects if q in s["title"].lower()]
            subjects = subjects[:args.limit]
        else:
            if verbose: print("[*] Fetching trending...")
            subjects = get_trending(per_page=max(args.limit, 20), origin=origin)[:args.limit]
        if verbose: print(f"[*] Got {len(subjects)} subjects")
        for s in subjects:
            if s.get("subjectType") == 2:
                r = scrape_tv(s, origin=origin, max_episodes_per_season=args.max_episodes, delay=args.delay, verbose=verbose)
            else:
                r = scrape_movie(s, origin=origin, verbose=verbose)
            if r: results.append(r)
            time.sleep(args.delay)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    if verbose:
        print(f"\n[*] Saved {len(results)} entries -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
