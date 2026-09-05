# Moviebox API

A Python scraper and hosted API for the MovieBox streaming backend (`h5-api.aoneroom.com`) that powers three sites:

- **netnaija.film**
- **movieboxonline.net**
- **officialmoviebox.com**

All three sites share the same backend. The scraper fetches direct MP4 URLs for movies and TV shows in all available qualities (360P, 480P, 720P, 1080P).

## Hosted API

The API is deployed on Vercel. You can use it without running the scraper locally.

**Base URL:** `https://moviebox-api-eight.vercel.app`

### Endpoints

#### Get movie URLs

```
GET /api/movie/:detailPath
```

Returns all quality URLs for a movie.

**Example:**

```bash
curl https://moviebox-api-eight.vercel.app/api/movie/oppenheimer-Akh5Nrwl7o
```

**Response:**

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

#### Get TV episode URLs

```
GET /api/tv/:detailPath?season=1&episode=1
```

Returns all quality URLs for a specific episode of a TV show.

**Example:**

```bash
curl "https://moviebox-api-eight.vercel.app/api/tv/lucifer-UQASHYbVPB2?season=1&episode=1"
```

**Response:**

```json
{
  "title": "Lucifer",
  "subjectId": "2190807691784770592",
  "detailPath": "lucifer-UQASHYbVPB2",
  "season": 1,
  "episode": 1,
  "available_seasons": [
    { "season": 1, "maxEp": 13, "resolutions": [360, 480, 720, 1080] },
    { "season": 2, "maxEp": 18, "resolutions": [360, 480, 720, 1080] }
  ],
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

#### Get trending list

```
GET /api/trending?limit=10
```

Returns the current trending movies and TV shows.

**Example:**

```bash
curl "https://moviebox-api-eight.vercel.app/api/trending?limit=20"
```

**Response:**

```json
{
  "count": 10,
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

#### Search

```
GET /api/search?q=oppenheimer&limit=5
```

Searches the home page for matching titles. Returns the detailPath you need for the movie/tv endpoints.

**Example:**

```bash
curl "https://moviebox-api-eight.vercel.app/api/search?q=all%20american&limit=5"
```

**Response:**

```json
{
  "query": "all american",
  "count": 1,
  "results": [
    {
      "title": "All American",
      "subjectId": "1167223938976469784",
      "subjectType": 2,
      "detailPath": "all-american-qHnle0GTdo1",
      "type": "tv"
    }
  ]
}
```

#### Download the scraper

```
GET /moviebox_scraper.py
```

Downloads the Python scraper script.

```bash
curl -O https://moviebox-api-eight.vercel.app/moviebox_scraper.py
```

### Full workflow example

```bash
# 1. Search for a movie
curl "https://moviebox-api-eight.vercel.app/api/search?q=oppenheimer&limit=1"
# -> detailPath: "oppenheimer-Akh5Nrwl7o"

# 2. Get all quality URLs
curl "https://moviebox-api-eight.vercel.app/api/movie/oppenheimer-Akh5Nrwl7o"
# -> qualities[0].url is your direct MP4 link

# 3. Download the MP4
curl -O "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=..."
```

For TV shows:

```bash
# 1. Search
curl "https://moviebox-api-eight.vercel.app/api/search?q=lucifer&limit=1"
# -> detailPath: "lucifer-UQASHYbVPB2"

# 2. Get episode URLs
curl "https://moviebox-api-eight.vercel.app/api/tv/lucifer-UQASHYbVPB2?season=1&episode=1"
# -> qualities[3].url is the 1080P link

# 3. Download
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

Returns all qualities (360P/480P/720P/1080P) including 1080P as free. This is what the "Watch Free" button calls inline.

- Rate-limited: 1 successful call per ~2-3 minutes per IP address.
- Best for: single movie/episode fetches where you want 1080P.

**2. `/wefeed-h5api-bff/subject/download`** (via site proxy)

Returns all qualities but marks 1080P as `vipLocked: true` with an empty URL. More reliable for bulk scraping.

- Must be called via the site proxy (e.g. `https://netnaija.film/wefeed-h5api-bff/subject/download?...`), NOT directly on `h5-api.aoneroom.com`.
- Best for: bulk scraping multiple episodes.

**Strategy:** The scraper tries `/play` first (gets 1080P free if fresh). If that returns empty (rate-limited), it falls back to `/download` via the site proxy.

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

3. **Browse the site manually:** go to `netnaija.film`, find a movie, copy the last part of the URL:
   - `https://netnaija.film/movieDetail/oppenheimer-Akh5Nrwl7o` -> `detailPath = oppenheimer-Akh5Nrwl7o`

## Important Notes

### Rate Limiting

- The `/play` endpoint allows 1 successful call per ~2-3 minutes per IP. After that, it returns empty `streams: []`.
- The `/download` endpoint (via site proxy) is more lenient but still rate-limited.
- Use the `--delay` flag (default 3 seconds) to space out calls. For bulk scraping 20+ items, use `--delay 5` or higher.
- If you get empty results, wait 2-3 minutes and retry.
- The hosted API shares a single IP (Vercel), so it is also rate-limited. For heavy use, run the scraper locally.

### URL Expiry

The signed MP4 URLs (e.g. `https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=...&t=...`) expire after approximately 24 hours. Re-run the scraper or call the API again to get fresh URLs.

### Quality Availability

Not all titles have all qualities. The `available_seasons` field in the TV response shows what is available per season. For example:

- Oppenheimer (movie): only 480P
- Lucifer S1: 360P, 480P, 720P, 1080P
- All American S1: 360P, 480P, 1080P (no 720P)

### 1080P VIP-Lock Discrepancy

The two endpoints disagree on 1080P:

- `/play` returns 1080P as free (URL included)
- `/download` marks 1080P as `vipLocked: true` (empty URL)

The scraper and API try `/play` first for 1080P. If that is rate-limited, they fall back to `/download` (1080P will be VIP-locked).

### CDN Hosts

Video files are served from `bcdnxw.hakunaymatata.com`. Subtitles from `cacdn.hakunaymatata.com`. Both use signed CloudFront/Aliyun OSS URLs with ~24h TTL.

## What NOT to Do

- Do not hammer the API. The rate limit is real. If you get empty results, wait. Do not retry immediately.
- Do not call `/subject/download` directly on `h5-api.aoneroom.com`. It only works via the site proxy. The scraper handles this automatically.
- Do not expect 1080P from `/subject/download`. Use `/subject/play` for 1080P (the scraper tries this first).
- Do not store the signed URLs long-term. They expire in ~24 hours. Store the `detailPath` and re-fetch URLs when needed.
- Do not ignore the `--delay` flag. For bulk scraping, set it to 5+ seconds.
- Do not assume all titles have all qualities. Check the `qualities` array in the output.

## What TO Do

- Use `--delay 5` for bulk scraping (10+ items) to avoid rate-limiting.
- Store `detailPath` values for re-use. They are stable identifiers.
- Try `/play` first for 1080P. The scraper does this automatically.
- Use `--quiet` for cron jobs to suppress progress output.
- Check the `source` field in the output. It tells you whether URLs came from `play` (1080P free) or `download` (1080P VIP-locked).
- Use the hosted API for quick lookups. Use the local scraper for bulk operations.

## Sites Supported

| Site | Origin | Route prefix |
|------|--------|--------------|
| netnaija.film | `https://netnaija.film` | `/movieDetail/<detailPath>` |
| movieboxonline.net | `https://movieboxonline.net` | `/detail/<detailPath>` |
| officialmoviebox.com | `https://officialmoviebox.com` | `/moviesDetail/<detailPath>` |

All three share the same backend (`h5-api.aoneroom.com`). The `--site` flag just changes the `Origin` and `Referer` headers.

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

4. The API will be available at `https://<your-project>.vercel.app/api/...`

### Deploy to other platforms

The API routes in `api/` are standard serverless functions (Vercel format). They use the Web `fetch` API and work on:

- Vercel (default, no config needed)
- Cloudflare Workers (wrap in `export default { fetch() }`)
- Netlify Functions (rename to `api/movie.js` -> `netlify/functions/movie.js`)
- Any Node.js server (use an adapter)

The Python scraper (`moviebox_scraper.py`) runs anywhere Python 3.7+ is available. No dependencies needed.

### Project structure

```
Moviebox-API/
|-- moviebox_scraper.py    # Python scraper (single file, stdlib only)
|-- api/
|   |-- movie.js           # GET /api/movie/:detailPath
|   |-- tv.js              # GET /api/tv/:detailPath?season=1&episode=1
|   |-- trending.js        # GET /api/trending?limit=10
|   `-- search.js          # GET /api/search?q=oppenheimer&limit=5
|-- vercel.json            # Vercel config (static file serving + headers)
|-- README.md              # This file
`-- .gitignore
```

## License

MIT. Use it however you want.
