# Moviebox API

A Python scraper, a hosted JSON API, and a complete dark-themed streaming and
download website backed by the MovieBox streaming backend
(`h5-api.aoneroom.com`) that powers three sites:

- **netnaija.film**
- **movieboxonline.net**
- **officialmoviebox.com**

All three sites share the same backend. The scraper and API fetch direct MP4
URLs for movies and TV shows in all available qualities (360P, 480P, 720P,
1080P). The website is a full streaming app: hero banners, trending list,
search, detail pages with cast, season/episode selectors, an HTML5 video
player with quality switching, and direct download links.

## Hosted

- **Website:** https://moviebox-api-eight.vercel.app
- **API base:** https://moviebox-api-eight.vercel.app/api

The website is served from `/` (the static files in `public/`). The API is
served from `/api/*`. Both live on the same Vercel project, so the website
calls the API with relative paths and there are no CORS issues.

## Website

The website is a single-page-style static site built with vanilla HTML, CSS
and JavaScript (no framework, no build step). Pages:

| Page | URL | Description |
|------|-----|-------------|
| Home | `/` | Hero banner carousel, trending list, all home sections |
| Search | `/search.html?q=lucifer` | Grid of search results with covers, ratings, type |
| Detail | `/detail.html?path=lucifer-UQASHYbVPB2` | Cover, synopsis, cast grid, watch/download, seasons for TV |

### Features

- Dark theme (background `#0f0f0f`, MovieBox green `#10b84d` accent).
- Fully responsive grid (2 columns on mobile, up to 6 on wide screens).
- Sticky header with search box on every page.
- Hero banner carousel that auto-advances every 6 seconds.
- Movie/TV cards with cover, rating badge, type badge, hover play overlay.
- Detail page with backdrop blur, poster, genre tags, IMDB rating, facts.
- Cast and crew grid with photos and character names.
- For TV: season selector buttons and a full episode list, each with Watch
  and Download buttons.
- HTML5 `<video>` player in a modal with a quality selector (360P/480P/720P/
  1080P) and resume-position preservation when switching quality.
- Download modal listing every available quality with file size and codec,
  linking directly to the MP4 URL (opens in a new tab).
- Trailer modal that plays the trailer MP4 inline.
- Skeleton loaders and error boxes.
- Toast notifications for transient feedback.

## API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/home` | Full home page: banners, sections, all subjects |
| GET | `/api/trending?limit=20` | Trending movies and shows (rich fields) |
| GET | `/api/search?q=lucifer&limit=20&page=1` | Search by title (home + trending, de-duplicated, with autocomplete suggestions) |
| GET | `/api/details/:detailPath` | Full details, cast, dubs and trailer |
| GET | `/api/seasons/:detailPath` | Seasons with episode counts and resolutions |
| GET | `/api/movie/:detailPath` | Movie stream/download URLs |
| GET | `/api/tv/:detailPath?season=1&episode=1` | TV episode stream/download URLs |
| GET | `/api/captions/:detailPath?season=1&episode=1` | Subtitle URLs |
| GET | `/api/stream?url=<encoded-media-url>` | Media proxy: forwards a CDN URL with the required `Referer` header so the browser can play/download MP4s |
| GET | `/moviebox_scraper.py` | Download the Python scraper |

All endpoints:

- Accept `GET` (and `OPTIONS` for CORS preflight).
- Return JSON.
- Send `Access-Control-Allow-Origin: *` so they can be called from any
  browser.
- Use a 15-second timeout when calling the upstream backend.
- Return clean, documented JSON shapes (see below).

---

### GET /api/home

Returns the full home page content: banners, category sections, and every
subject found on the page (de-duplicated by `subjectId`).

```bash
curl https://moviebox-api-eight.vercel.app/api/home
```

Response (abbreviated):

```json
{
  "bannerCount": 11,
  "banners": [
    {
      "subjectId": "1611074008508777000",
      "subjectType": 2,
      "type": "tv",
      "title": "Ordinary People",
      "description": "...",
      "releaseDate": "2026-09-04",
      "genre": "Action",
      "cover": "https://pbcdnw.aoneroom.com/image/...",
      "countryName": "Nigeria",
      "imdbRatingValue": "6.7",
      "imdbRatingCount": 0,
      "detailPath": "ordinary-people-YmqiCnDJ0V1",
      "bannerImage": "https://pbcdnw.aoneroom.com/image/..."
    }
  ],
  "sectionCount": 18,
  "sections": [
    {
      "type": "subjects",
      "title": "Popular Series",
      "position": 3,
      "count": 16,
      "items": [ { "title": "Lucifer", "detailPath": "lucifer-UQASHYbVPB2", "..." : "..." } ]
    }
  ],
  "subjectCount": 312,
  "subjects": [ { "title": "...", "detailPath": "..." } ],
  "platformCount": 10,
  "platforms": [ { "name": "Netflix", "uploadBy": "Regina" } ]
}
```

---

### GET /api/trending?limit=20

```bash
curl "https://moviebox-api-eight.vercel.app/api/trending?limit=20"
```

Response:

```json
{
  "count": 20,
  "items": [
    {
      "title": "Lucifer",
      "subjectId": "2190807691784770592",
      "subjectType": 2,
      "detailPath": "lucifer-UQASHYbVPB2",
      "type": "tv",
      "genre": "Crime,Drama,Fantasy",
      "imdbRating": "8.0",
      "cover": "https://pbcdnw.aoneroom.com/image/..."
    }
  ]
}
```

---

### GET /api/search?q=...&limit=20&page=1

Searches movies and TV shows by title. The backend's own `/subject/search`
endpoint requires a non-anonymous token and rejects anonymous callers, so
this endpoint combines two anonymous-friendly sources and de-duplicates them:

1. `/subject/search-suggest` (autocomplete suggestions, returned in the
   `suggestions` field)
2. `/home` (~376 subjects on the home page)
3. `/subject/trending?perPage=100` (up to 100 trending titles)

Titles from sources 2 and 3 are merged by `subjectId`, filtered by the query
(case-insensitive substring on the title), sorted by IMDB rating, and returned
with rich fields (cover, rating, genre, country, description, releaseDate,
etc). Supports `page` + `limit` for pagination.

```bash
curl "https://moviebox-api-eight.vercel.app/api/search?q=oppenheimer&limit=10"
```

Response:

```json
{
  "query": "oppenheimer",
  "page": 1,
  "limit": 10,
  "total": 1,
  "count": 1,
  "hasMore": false,
  "sources": { "home": 376, "trending": 100 },
  "suggestions": ["Oppenheimer", "Oppenheimer: The Real Story", "Alan Oppenheimer"],
  "results": [
    {
      "title": "Oppenheimer",
      "subjectId": "326494254824573768",
      "subjectType": 1,
      "type": "movie",
      "detailPath": "oppenheimer-Akh5Nrwl7o",
      "description": "...",
      "releaseDate": "2023-07-19",
      "duration": 10800,
      "genre": "Drama,History",
      "cover": "https://pbcdnw.aoneroom.com/image/...",
      "countryName": "United States",
      "imdbRatingValue": "8.3",
      "imdbRatingCount": 780000,
      "subtitles": "English,...",
      "hasResource": true
    }
  ]
}
```

---

### GET /api/details/:detailPath

Returns full movie/show details including synopsis, genre, release date,
duration, IMDB rating, country, subtitles, cover, trailer, and the full
cast/stars list.

```bash
curl https://moviebox-api-eight.vercel.app/api/details/oppenheimer-Akh5Nrwl7o
```

Response:

```json
{
  "detailPath": "oppenheimer-Akh5Nrwl7o",
  "subjectId": "326494254824573768",
  "subjectType": 1,
  "type": "movie",
  "title": "Oppenheimer",
  "description": "The story of J. Robert Oppenheimer and his role...",
  "genre": "Drama,History",
  "releaseDate": "2023-07-19",
  "duration": 10800,
  "durationText": "3h 0m",
  "imdbRatingValue": "8.3",
  "imdbRatingCount": 780000,
  "countryName": "United States",
  "subtitles": "English,Espanol,...",
  "cover": "https://pbcdnw.aoneroom.com/image/...",
  "coverWidth": 500,
  "coverHeight": 750,
  "hasResource": true,
  "trailer": {
    "url": "https://macdn.aoneroom.com/media/.../trailer.mp4",
    "videoId": "...",
    "duration": 140,
    "width": 848,
    "height": 478,
    "cover": "https://pbcdnw.aoneroom.com/media/.../cover.jpg"
  },
  "cast": [
    {
      "staffId": "...",
      "staffType": 1,
      "role": "Cast",
      "name": "Cillian Murphy",
      "character": "J. Robert Oppenheimer",
      "avatarUrl": "https://pbcdnw.aoneroom.com/image/...",
      "detailPath": "cillian-murphy-..."
    }
  ],
  "castCount": 24
}
```

`staffType` meaning: `1` = cast (actor), `2` = director, others = staff.

---

### GET /api/seasons/:detailPath

Returns all seasons of a TV show with episode counts and the available
resolutions per season.

```bash
curl https://moviebox-api-eight.vercel.app/api/seasons/lucifer-UQASHYbVPB2
```

Response:

```json
{
  "detailPath": "lucifer-UQASHYbVPB2",
  "subjectId": "2190807691784770592",
  "subjectType": 2,
  "type": "tv",
  "title": "Lucifer S1-S6",
  "seasonCount": 6,
  "totalEpisodes": 93,
  "globalResolutions": [360, 480, 720, 1080],
  "source": "ailok.pe",
  "uploadBy": "variyava7860",
  "seasons": [
    {
      "season": 1,
      "maxEp": 13,
      "resolutions": [
        { "resolution": 360, "epNum": 12 },
        { "resolution": 480, "epNum": 13 },
        { "resolution": 720, "epNum": 11 },
        { "resolution": 1080, "epNum": 13 }
      ],
      "availableResolutions": [360, 480, 720, 1080]
    }
  ]
}
```

---

### GET /api/movie/:detailPath

Returns all quality URLs for a movie.

```bash
curl https://moviebox-api-eight.vercel.app/api/movie/oppenheimer-Akh5Nrwl7o
```

Response:

```json
{
  "title": "Oppenheimer",
  "subjectId": "326494254824573768",
  "detailPath": "oppenheimer-Akh5Nrwl7o",
  "watch_url": "https://netnaija.film/videoPlayPage/oppenheimer-Akh5Nrwl7o?type=/movie/detail",
  "source": "play",
  "qualities": [
    {
      "resolution": 480,
      "size_mb": 729.03,
      "duration_sec": 10822,
      "codec": "h264",
      "vipLocked": false,
      "url": "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=..."
    }
  ],
  "best_free": {
    "resolution": 480,
    "size_mb": 729.03,
    "url": "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=..."
  }
}
```

---

### GET /api/tv/:detailPath?season=1&episode=1

Returns all quality URLs for a specific episode of a TV show.

```bash
curl "https://moviebox-api-eight.vercel.app/api/tv/lucifer-UQASHYbVPB2?season=1&episode=1"
```

Response:

```json
{
  "title": "Lucifer",
  "subjectId": "2190807691784770592",
  "detailPath": "lucifer-UQASHYbVPB2",
  "season": 1,
  "episode": 1,
  "available_seasons": [
    { "season": 1, "maxEp": 13, "resolutions": [360, 480, 720, 1080] }
  ],
  "watch_url": "https://netnaija.film/videoPlayPage/...",
  "source": "play",
  "qualities": [
    { "resolution": 360, "size_mb": 117.21, "vipLocked": false, "url": "..." },
    { "resolution": 480, "size_mb": 159.62, "vipLocked": false, "url": "..." },
    { "resolution": 720, "size_mb": 356.80, "vipLocked": false, "url": "..." },
    { "resolution": 1080, "size_mb": 644.38, "vipLocked": false, "url": "..." }
  ],
  "best_free": {
    "resolution": 1080,
    "size_mb": 644.38,
    "url": "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=..."
  }
}
```

---

### GET /api/captions/:detailPath?season=1&episode=1

Returns subtitle URLs for a movie or episode. For movies, omit `season` and
`episode` (or pass `0`). The endpoint first resolves a playable video id from
`/subject/play` (with `/subject/download` as a fallback), then calls
`/subject/caption` to get the subtitle list.

```bash
# Movie
curl https://moviebox-api-eight.vercel.app/api/captions/oppenheimer-Akh5Nrwl7o

# TV episode
curl "https://moviebox-api-eight.vercel.app/api/captions/lucifer-UQASHYbVPB2?season=1&episode=1"
```

Response:

```json
{
  "detailPath": "lucifer-UQASHYbVPB2",
  "subjectId": "2190807691784770592",
  "title": "Lucifer S1-S6",
  "season": 1,
  "episode": 1,
  "videoId": "7643229021845030664",
  "streamSource": "play",
  "captionCount": 10,
  "captions": [
    {
      "id": "8919092513600849552",
      "lan": "en",
      "lanName": "English",
      "url": "https://cacdn.hakunaymatata.com/subtitle/...srt?Policy=...",
      "size": 66895,
      "delay": 0
    }
  ]
}
```

If the play endpoint is rate-limited and no video id can be resolved, the
endpoint returns a 404 with a message telling the caller to retry in 2-3
minutes.

---

### GET /api/stream?url=<encoded-media-url>

Media proxy. The video CDN (`bcdnxw.hakunaymatata.com`) requires a
`Referer: https://netnaija.film/` header on every request and returns HTTP 429
without it. A browser `<video>` tag or a plain `curl -O` cannot set that
header for a cross-origin resource, so the in-page player and the download
buttons route MP4 URLs through this proxy. It streams the response body (it
does not buffer the whole file) and forwards `Range` requests so the browser
can seek.

Only the known media CDN hosts are allowed (`bcdnxw.hakunaymatata.com`,
`cacdn.hakunaymatata.com`, `macdn.aoneroom.com`, `pbcdnw.aoneroom.com`).

```bash
# Play an MP4 in a browser
open "https://moviebox-api-eight.vercel.app/api/stream?url=https%3A%2F%2Fbcdnxw.hakunaymatata.com%2Fresource%2F...mp4"

# Download via curl
curl -O "https://moviebox-api-eight.vercel.app/api/stream?url=https%3A%2F%2Fbcdnxw.hakunaymatata.com%2Fresource%2F...mp4"
```

The `/api/details` response now also includes a `dubs` array (alternative
audio + subtitle language tracks). Each entry:

```json
{
  "subjectId": "2955180061147678728",
  "lanName": "Arabic sub",
  "lanCode": "ar",
  "original": false,
  "type": 1,
  "kind": "subtitle",
  "detailPath": "lucifer-uDYzEbSKiw3"
}
```

- `type=0, kind="dub"` -> a dubbed audio track
- `type=1, kind="subtitle"` -> a subtitle-language variant
- `original=true` -> the original-language track

---

### Full workflow example

```bash
# 1. Search for a movie
curl "https://moviebox-api-eight.vercel.app/api/search?q=oppenheimer&limit=1"
# -> detailPath: "oppenheimer-Akh5Nrwl7o"

# 2. Get full details (synopsis, cast, trailer)
curl "https://moviebox-api-eight.vercel.app/api/details/oppenheimer-Akh5Nrwl7o"

# 3. Get all quality URLs
curl "https://moviebox-api-eight.vercel.app/api/movie/oppenheimer-Akh5Nrwl7o"
# -> qualities[0].url is your direct MP4 link

# 4. Get subtitles
curl "https://moviebox-api-eight.vercel.app/api/captions/oppenheimer-Akh5Nrwl7o"

# 5. Download the MP4
curl -O "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=..."
```

For TV shows:

```bash
# 1. Search
curl "https://moviebox-api-eight.vercel.app/api/search?q=lucifer&limit=1"
# -> detailPath: "lucifer-UQASHYbVPB2"

# 2. List seasons and resolutions
curl "https://moviebox-api-eight.vercel.app/api/seasons/lucifer-UQASHYbVPB2"

# 3. Get episode URLs
curl "https://moviebox-api-eight.vercel.app/api/tv/lucifer-UQASHYbVPB2?season=1&episode=1"
# -> qualities[3].url is the 1080P link

# 4. Get episode subtitles
curl "https://moviebox-api-eight.vercel.app/api/captions/lucifer-UQASHYbVPB2?season=1&episode=1"

# 5. Download
curl -O "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=..."
```

## Python Scraper (Local)

You can also run the scraper locally for bulk operations.

### Quick Start

```bash
# Download the scraper
curl -O https://moviebox-api-eight.vercel.app/moviebox_scraper.py

# Run it
python3 moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o
```

Requires Python 3.7+. No pip install needed. Uses only the standard library.

### How It Works

The MovieBox backend exposes two endpoints that return video URLs:

**1. `/wefeed-h5api-bff/subject/play`** (direct on `h5-api.aoneroom.com`)

Returns all qualities (360P/480P/720P/1080P) including 1080P as free. This is
what the "Watch Free" button calls inline.

- Rate-limited: 1 successful call per ~2-3 minutes per IP address.
- Best for: single movie/episode fetches where you want 1080P.

**2. `/wefeed-h5api-bff/subject/download`** (via site proxy)

Returns all qualities but marks 1080P as `vipLocked: true` with an empty URL.
More reliable for bulk scraping.

- Must be called via the site proxy (e.g.
  `https://netnaija.film/wefeed-h5api-bff/subject/download?...`), NOT directly
  on `h5-api.aoneroom.com`.
- Best for: bulk scraping multiple episodes.

**Strategy:** The scraper tries `/play` first (gets 1080P free if fresh). If
that returns empty (rate-limited), it falls back to `/download` via the site
proxy.

### CLI Usage

```bash
# Single movie by detailPath (gets all qualities incl 1080P free)
python3 moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o

# TV show, specific seasons, multiple episodes per season
python3 moviebox_scraper.py --tv lucifer-UQASHYbVPB2 --seasons 1,2,3 --max-episodes 5

# Top N trending movies/shows
python3 moviebox_scraper.py --trending --limit 10 --max-episodes 2

# Search the home page by title
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

### Output Format

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

## Finding a Movie's detailPath

The `detailPath` is a URL-safe slug used by the sites. You can find it by:

1. **Use the search API:**
   ```bash
   curl "https://moviebox-api-eight.vercel.app/api/search?q=oppenheimer&limit=5"
   ```

2. **Use the trending API:**
   ```bash
   curl "https://moviebox-api-eight.vercel.app/api/trending?limit=10"
   ```

3. **Use the home API:**
   ```bash
   curl "https://moviebox-api-eight.vercel.app/api/home" | jq '.subjects[].detailPath'
   ```

4. **Browse the site manually:** go to `netnaija.film`, find a movie, copy the
   last part of the URL:
   - `https://netnaija.film/movieDetail/oppenheimer-Akh5Nrwl7o`
   - `detailPath = oppenheimer-Akh5Nrwl7o`

## Important Notes

### Rate Limiting

- The `/play` endpoint allows 1 successful call per ~2-3 minutes per IP. After
  that, it returns empty `streams: []`.
- The `/download` endpoint (via site proxy) is more lenient but still
  rate-limited.
- Use the `--delay` flag (default 3 seconds) to space out calls. For bulk
  scraping 20+ items, use `--delay 5` or higher.
- If you get empty results, wait 2-3 minutes and retry.
- The hosted API shares a single IP (Vercel), so it is also rate-limited. For
  heavy use, run the scraper locally.

### URL Expiry

The signed MP4 URLs (e.g.
`https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=...&t=...`) expire after
approximately 24 hours. Re-run the scraper or call the API again to get fresh
URLs.

### Quality Availability

Not all titles have all qualities. The `available_seasons` field in the TV
response (and the `availableResolutions` field in the `/api/seasons` response)
shows what is available per season. For example:

- Oppenheimer (movie): only 480P
- Lucifer S1: 360P, 480P, 720P, 1080P
- All American S1: 360P, 480P, 1080P (no 720P)

### 1080P VIP-Lock Discrepancy

The two endpoints disagree on 1080P:

- `/play` returns 1080P as free (URL included)
- `/download` marks 1080P as `vipLocked: true` (empty URL)

The scraper, the `/api/movie`, `/api/tv` and `/api/captions` endpoints all try
`/play` first for 1080P. If that is rate-limited, they fall back to `/download`
(1080P will be VIP-locked).

### CDN Hosts

Video files are served from `bcdnxw.hakunaymatata.com`. Subtitles from
`cacdn.hakunaymatata.com`. Both use signed CloudFront/Aliyun OSS URLs with
~24h TTL.

## What NOT to Do

- Do not hammer the API. The rate limit is real. If you get empty results,
  wait. Do not retry immediately.
- Do not call `/subject/download` directly on `h5-api.aoneroom.com`. It only
  works via the site proxy. The scraper handles this automatically.
- Do not expect 1080P from `/subject/download`. Use `/subject/play` for 1080P
  (the scraper does this first).
- Do not store the signed URLs long-term. They expire in ~24 hours. Store the
  `detailPath` and re-fetch URLs when needed.
- Do not ignore the `--delay` flag. For bulk scraping, set it to 5+ seconds.
- Do not assume all titles have all qualities. Check the `qualities` array in
  the output.

## What TO Do

- Use `--delay 5` for bulk scraping (10+ items) to avoid rate-limiting.
- Store `detailPath` values for re-use. They are stable identifiers.
- Try `/play` first for 1080P. The scraper and API do this automatically.
- Use `--quiet` for cron jobs to suppress progress output.
- Check the `source` field in the output. It tells you whether URLs came from
  `play` (1080P free) or `download` (1080P VIP-locked).
- Use the hosted API for quick lookups. Use the local scraper for bulk
  operations.

## Sites Supported

| Site | Origin | Route prefix |
|------|--------|--------------|
| netnaija.film | `https://netnaija.film` | `/movieDetail/<detailPath>` |
| movieboxonline.net | `https://movieboxonline.net` | `/detail/<detailPath>` |
| officialmoviebox.com | `https://officialmoviebox.com` | `/moviesDetail/<detailPath>` |

All three share the same backend (`h5-api.aoneroom.com`). The `--site` flag
just changes the `Origin` and `Referer` headers.

## Deployment

### Deploy to Vercel (recommended)

1. Fork or clone this repo:
   ```bash
   git clone https://github.com/kelvinodgar-tech/Moviebox-API.git
   cd Moviebox-API
   ```

2. Install the Vercel CLI (optional, for local dev):
   ```bash
   npm i -g vercel
   vercel  # follow the prompts
   ```

3. Or deploy via the Vercel dashboard:
   - Go to https://vercel.com/new
   - Import the GitHub repo `kelvinodgar-tech/Moviebox-API`
   - Framework preset: Other (no framework)
   - Click Deploy

4. The site will be available at `https://<your-project>.vercel.app/` and the
   API at `https://<your-project>.vercel.app/api/...`

### Project structure

```
Moviebox-API/
|-- api/
|   |-- home.js                # GET /api/home
|   |-- trending.js            # GET /api/trending?limit=20
|   |-- search.js              # GET /api/search?q=...&limit=10
|   |-- details.js             # GET /api/details/:detailPath
|   |-- seasons.js             # GET /api/seasons/:detailPath
|   |-- movie.js               # GET /api/movie/:detailPath
|   |-- tv.js                  # GET /api/tv/:detailPath?season=1&episode=1
|   `-- captions.js            # GET /api/captions/:detailPath?season=1&episode=1
|-- public/
|   |-- index.html             # Homepage (hero, trending, sections)
|   |-- detail.html            # Movie/TV detail page
|   |-- search.html            # Search results page
|   |-- moviebox_scraper.py   # Python scraper (also served at /moviebox_scraper.py)
|   |-- css/
|   |   `-- style.css          # Dark theme stylesheet
|   `-- js/
|       `-- app.js             # All frontend logic
|-- vercel.json                # Vercel config (rewrites + headers)
|-- README.md                  # This file
`-- .gitignore
```

### Local development

The site is plain static HTML/CSS/JS. To preview it locally:

```bash
# Python's built-in server
cd Moviebox-API
python3 -m http.server 8080
# then open http://localhost:8080/public/index.html
```

The API runs on Vercel. To run the API locally, use the Vercel CLI:

```bash
npm i -g vercel
vercel dev
```

To point the local website at the hosted API instead of relative paths, set
`window.MOVIEBOX_API_BASE` before loading `app.js`, for example by adding
this snippet to the `<head>` of each page:

```html
<script>window.MOVIEBOX_API_BASE = "https://moviebox-api-eight.vercel.app";</script>
```

### Deploy to other platforms

The API routes in `api/` are standard serverless functions (Vercel format).
They use the Web `fetch` API and work on:

- Vercel (default, no config needed)
- Cloudflare Workers (wrap in `export default { fetch() }`)
- Netlify Functions (rename to `api/movie.js` -> `netlify/functions/movie.js`)
- Any Node.js server (use an adapter)

The static website in `public/` works on any static host (GitHub Pages,
Netlify, S3, Cloudflare Pages, etc.). Just point it at the hosted API URL by
setting `window.MOVIEBOX_API_BASE`.

The Python scraper (`moviebox_scraper.py`) runs anywhere Python 3.7+ is
available. No dependencies needed.

## License

MIT. Use it however you want.
