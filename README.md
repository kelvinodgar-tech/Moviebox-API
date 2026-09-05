# Moviebox API

A Python scraper for the MovieBox streaming backend (`h5-api.aoneroom.com`) that powers three sites:

- **netnaija.film**
- **movieboxonline.net**
- **officialmoviebox.com**

All three sites share the same backend. The scraper fetches direct MP4 URLs for movies and TV shows in all available qualities (360P, 480P, 720P, 1080P).

## Quick Start

```bash
# Download the scraper (single file, no dependencies)
curl -O https://moviebox-api.vercel.app/moviebox_scraper.py
# or just grab it from this repo

# Run it
python3 moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o
```

Requires Python 3.7+. No `pip install` needed — uses only the standard library.

## How It Works

The MovieBox backend exposes two endpoints that return video URLs:

### 1. `/wefeed-h5api-bff/subject/play` (direct on `h5-api.aoneroom.com`)

Returns all qualities (360P/480P/720P/1080P) including 1080P as free. This is what the "Watch Free" button calls inline.

- **Rate-limited:** 1 successful call per ~2-3 minutes per IP address. Subsequent calls return empty `streams: []`.
- **Best for:** Single movie/episode fetches where you want 1080P.

### 2. `/wefeed-h5api-bff/subject/download` (via site proxy)

Returns all qualities but marks 1080P as `vipLocked: true` with an empty URL. More reliable for bulk scraping.

- **Must be called via the site proxy** (e.g. `https://netnaija.film/wefeed-h5api-bff/subject/download?...`), NOT directly on `h5-api.aoneroom.com`. Direct calls return empty results.
- **Best for:** Bulk scraping multiple episodes (less aggressive rate-limiting).

### Strategy

The scraper tries `/play` first (gets 1080P free if fresh). If that returns empty (rate-limited), it falls back to `/download` via the site proxy (1080P will be VIP-locked but 360P/480P/720P are free).

## Usage

```bash
# Single movie by detailPath (gets all qualities incl 1080P free)
python3 moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o

# TV show, specific seasons, multiple episodes per season
python3 moviebox_scraper.py --tv lucifer-UQASHYbVPB2 --seasons 1,2,3 --max-episodes 5

# Top N trending movies/shows
python3 moviebox_scraper.py --trending --limit 10 --max-episodes 2

# Search the home page by title (the /search endpoint now requires a token)
python3 moviebox_scraper.py --search "all american" --limit 5

# Scrape from the full home page (~600 subjects)
python3 moviebox_scraper.py --home --limit 20

# Switch which site to impersonate (same backend, different Origin header)
python3 moviebox_scraper.py --site officialmoviebox --movie oppenheimer-Akh5Nrwl7o
python3 moviebox_scraper.py --site movieboxonline --tv lucifer-UQASHYbVPB2

# Increase delay between calls to avoid rate-limiting (default 3 seconds)
python3 moviebox_scraper.py --trending --limit 20 --delay 5

# Save to a custom output path
python3 moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o --out ~/Downloads/opp.json

# Suppress progress output (for cron jobs / pipelines)
python3 moviebox_scraper.py --trending --limit 10 --quiet --out results.json
```

## Output Format

The scraper outputs a JSON file with this structure:

```json
[
  {
    "title": "Oppenheimer",
    "subjectId": "326494254824573768",
    "subjectType": 1,
    "detailPath": "oppenheimer-Akh5Nrwl7o",
    "watch_url": "https://netnaija.film/videoPlayPage/oppenheimer-Akh5Nrwl7o?type=/movie/detail",
    "source": "play",
    "qualities": [
      {
        "resolution": 1080,
        "size_mb": 914.9,
        "duration_sec": 10822,
        "codec": "h264",
        "vipLocked": false,
        "url": "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=...",
        "video_id": "..."
      }
    ]
  }
]
```

For TV shows, the structure includes `seasons` and `episodes`:

```json
[
  {
    "title": "Lucifer",
    "subjectType": 2,
    "seasons": [
      {
        "season": 1,
        "maxEp": 13,
        "episodes": [
          {
            "season": 1,
            "episode": 1,
            "source": "play",
            "qualities": [
              {"resolution": 360, "size_mb": 117.21, "vipLocked": false, "url": "..."},
              {"resolution": 480, "size_mb": 159.62, "vipLocked": false, "url": "..."},
              {"resolution": 720, "size_mb": 356.80, "vipLocked": false, "url": "..."},
              {"resolution": 1080, "size_mb": 644.38, "vipLocked": false, "url": "..."}
            ]
          }
        ]
      }
    ]
  }
]
```

## Finding a Movie's `detailPath`

The `detailPath` is a URL-safe slug used by the sites. You can find it by:

1. **Browse the site** — go to `netnaija.film`, find a movie, and copy the last part of the URL:
   - `https://netnaija.film/movieDetail/oppenheimer-Akh5Nrwl7o` → `detailPath = oppenheimer-Akh5Nrwl7o`

2. **Use `--search`** — the scraper will search the home page for matching titles and return their detailPaths:
   ```bash
   python3 moviebox_scraper.py --search "spider" --limit 5
   ```

3. **Use `--trending`** — returns the current trending list with detailPaths included.

## Important Notes

### Rate Limiting

- The `/play` endpoint allows **1 successful call per ~2-3 minutes per IP**. After that, it returns empty `streams: []`.
- The `/download` endpoint (via site proxy) is more lenient but still rate-limited.
- Use the `--delay` flag (default 3 seconds) to space out calls. For bulk scraping 20+ items, use `--delay 5` or higher.
- If you get empty results, wait 2-3 minutes and retry.

### URL Expiry

The signed MP4 URLs (e.g. `https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=...&t=...`) expire after approximately 24 hours. Re-run the scraper to get fresh URLs.

### Quality Availability

Not all titles have all qualities. The `resource.seasons[].resolutions` field in the `/detail` response shows what's available per season. For example:
- Oppenheimer (movie): only 480P
- Lucifer S1: 360P, 480P, 720P, 1080P
- Lucifer S7: 360P, 480P, 720P, 1080P
- All American S1: 360P, 480P, 1080P (no 720P)

### 1080P VIP-Lock Discrepancy

The two endpoints disagree on 1080P:
- `/play` returns 1080P as **free** (URL included)
- `/download` marks 1080P as `vipLocked: true` (empty URL)

If you want 1080P, use `/play` (the scraper does this automatically as the first attempt).

### CDN Hosts

Video files are served from `bcdnxw.hakunaymatata.com`. Subtitles from `cacdn.hakunaymatata.com`. Both use signed CloudFront/Aliyun OSS URLs with ~24h TTL.

## What NOT to Do

- **Don't hammer the API.** The rate limit is real. If you get empty results, wait — don't retry immediately.
- **Don't call `/subject/download` directly on `h5-api.aoneroom.com`.** It only works via the site proxy (`netnaija.film/wefeed-h5api-bff/...`). The scraper handles this automatically.
- **Don't expect 1080P from `/subject/download`.** Use `/subject/play` for 1080P (the scraper tries this first).
- **Don't store the signed URLs long-term.** They expire in ~24 hours. Store the `detailPath` and re-fetch URLs when needed.
- **Don't ignore the `--delay` flag.** For bulk scraping, set it to 5+ seconds to avoid getting rate-limited.
- **Don't assume all titles have all qualities.** Check the `qualities` array in the output — some titles only have 480P.

## What TO Do

- **Use `--delay 5` for bulk scraping** (10+ items) to avoid rate-limiting.
- **Store `detailPath` values** for re-use. They're stable identifiers — you can re-fetch URLs anytime with `--movie <detailPath>` or `--tv <detailPath>`.
- **Try `/play` first for 1080P.** The scraper does this automatically, but if you're building your own tool, remember this.
- **Use `--quiet` for cron jobs** to suppress progress output and just get the JSON file.
- **Check the `source` field in the output** — it tells you whether the URLs came from `play` (1080P free) or `download` (1080P VIP-locked).

## Sites Supported

| Site | Origin | Route prefix |
|------|--------|--------------|
| netnaija.film | `https://netnaija.film` | `/movieDetail/<detailPath>` |
| movieboxonline.net | `https://movieboxonline.net` | `/detail/<detailPath>` |
| officialmoviebox.com | `https://officialmoviebox.com` | `/moviesDetail/<detailPath>` |

All three share the same backend (`h5-api.aoneroom.com`). The `--site` flag just changes the `Origin` and `Referer` headers.

## File Structure

```
Moviebox-API/
├── moviebox_scraper.py    # The scraper (single file, stdlib only)
├── README.md              # This file
└── vercel.json            # Vercel config (serves the scraper as a static file)
```

## License

MIT — use it however you want.
