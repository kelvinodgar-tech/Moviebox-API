# Moviebox API

A small JSON API over the MovieBox streaming backend (`h5-api.aoneroom.com`)
that powers movieboxonline.net, netnaija.film and officialmoviebox.com (all
three share the same backend). It searches titles, returns metadata, and
resolves direct MP4 URLs (360P–1080P) and subtitle files.

There is no shared public instance — clone the repo and run your own:

```bash
git clone https://github.com/kelvinodgar-tech/Moviebox-API.git
cd Moviebox-API
node server.js          # http://localhost:3000
```

`server.js` is a plain Node HTTP server with zero npm dependencies (Node 18+).
The same endpoints also run as Vercel serverless functions from `api/` — see
[Deploying](#deploying).

## Endpoints

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/search?q=one+piece&limit=20` | titles matching a query |
| GET | `/api/trending?limit=20` | current trending movies and shows |
| GET | `/api/details?id=<detailPath>` | full metadata: synopsis, cast, dubs, seasons |
| GET | `/api/movie?id=<detailPath>` | MP4 URLs per quality for a movie |
| GET | `/api/tv?id=<detailPath>&season=1&episode=1` | MP4 URLs per quality for an episode |
| GET | `/api/subtitles?id=<detailPath>&season=1&episode=1` | subtitle files per language |
| GET | `/api/episode-matrix?id=<detailPath>&season=1&episode=1` | every audio language + every subtitle in one call |

Every endpoint answers `GET` (plus `OPTIONS` for CORS preflight), returns
JSON, and sends `Access-Control-Allow-Origin: *`.

`<detailPath>` is the slug the MovieBox sites use to identify a title (e.g.
`oppenheimer-Akh5Nrwl7o`). Get one from `/api/search` or `/api/trending`, then
use it with the other endpoints. For movies, omit `season`/`episode`.

### GET /api/search?q=...&limit=20&page=1

Searches movies and TV shows by title. Results come from movieboxonline.net's
own search backend, in the site's own relevance order. The response also
carries `total` (full hit count), `hasMore`, and `suggestions` ("try also"
words). A page-scrape fallback kicks in if the search backend is unreachable.

```bash
curl "http://localhost:3000/api/search?q=one+piece&limit=3"
```

```json
{
  "query": "one piece",
  "count": 3,
  "total": 99,
  "hasMore": true,
  "results": [
    {
      "title": "One Piece",
      "subjectId": "2190807691784770592",
      "type": "tv",
      "detailPath": "one-piece-...",
      "genre": "Animation,Adventure",
      "releaseDate": "2023-08-31",
      "cover": "https://pbcdnw.aoneroom.com/image/...",
      "imdbRating": "8.7"
    }
  ]
}
```

### GET /api/trending?limit=20

The current trending list with rich fields (cover, rating, genre, country,
description, release date). `limit` is capped at 100.

### GET /api/details?id=...

Full details for one title: synopsis, genre, release date, duration, IMDB
rating, country, cover, trailer, the cast list, and the `dubs` array.
For TV shows it also returns the `seasons` list with episode counts and
available resolutions.

Each entry in `dubs` is one of:

- `kind: "dub"` — a dubbed audio track; get its files by calling `/api/movie`
  or `/api/tv` with the dub's own `detailPath`.
- `kind: "subtitle"` — a subtitle-language variant of the same title.
- `original: true` — the original-language track.

```bash
curl "http://localhost:3000/api/details?id=lucifer-UQASHYbVPB2"
```

```json
{
  "detailPath": "lucifer-UQASHYbVPB2",
  "type": "tv",
  "title": "Lucifer S1-S6",
  "imdbRatingValue": "8.1",
  "seasonCount": 6,
  "totalEpisodes": 93,
  "seasons": [{ "season": 1, "maxEp": 13, "resolutions": [360, 480, 720, 1080] }],
  "cast": [{ "name": "Tom Ellis", "character": "Lucifer Morningstar" }],
  "dubs": [{ "lanName": "English", "lanCode": "en", "original": true, "kind": "dub" }]
}
```

### GET /api/movie?id=...

Direct MP4 URLs for every available quality of a movie. Calling it on a TV
subject returns a `400` pointing at `/api/tv`.

The endpoint tries the backend's `/play` source first (1080P included, free
but rate-limited to roughly one successful call per 2–3 minutes per IP) and
falls back to `/download` (where 1080P comes back VIP-locked). The `source`
field tells you which one answered.

```bash
curl "http://localhost:3000/api/movie?id=oppenheimer-Akh5Nrwl7o"
```

```json
{
  "title": "Oppenheimer",
  "type": "movie",
  "source": "play",
  "qualities": [
    { "resolution": 1080, "size_mb": 914.9, "codec": "h264", "vipLocked": false,
      "url": "https://bcdnxw.hakunaymatata.com/resource/...mp4?sign=..." }
  ],
  "best_free": { "resolution": 1080, "size_mb": 914.9, "url": "..." }
}
```

### GET /api/tv?id=...&season=1&episode=1

Direct MP4 URLs for one episode of a TV show. `season` and `episode` default
to 1; the response also carries `available_seasons` (season number, episode
count, resolutions) so you can walk a whole show. Calling it on a movie
subject returns a `400` pointing at `/api/movie`.

```bash
curl "http://localhost:3000/api/tv?id=lucifer-UQASHYbVPB2&season=1&episode=1"
```

### GET /api/subtitles?id=...&season=1&episode=1

Subtitle files for a movie or episode, one per language. Each `url` points at
a `.srt` file on `cacdn.hakunaymatata.com` — a plain signed link that works
from any HTTP client without special headers.

```bash
curl "http://localhost:3000/api/subtitles?id=lucifer-UQASHYbVPB2&season=1&episode=1"
```

```json
{
  "title": "Lucifer S1-S6",
  "season": 1,
  "episode": 1,
  "captionCount": 10,
  "captions": [
    { "lan": "en", "lanName": "English",
      "url": "https://cacdn.hakunaymatata.com/subtitle/...srt?Policy=...",
      "size": 66895 }
  ]
}
```

### GET /api/episode-matrix?id=...&season=1&episode=1

The composite endpoint for multi-language clients: the FULL language matrix
for one episode (or a whole movie, omitting `season`/`episode`) in a single
call - no fan-out over `dubs` needed.

```bash
curl "http://localhost:3000/api/episode-matrix?id=demon-slayer-kimetsu-no-yaiba-english-cK8E2dUTaC8&season=1&episode=1"
```

```json
{
  "title": "Demon Slayer: Kimetsu no Yaiba [English] S1-S5",
  "type": "tv",
  "season": 1,
  "episode": 1,
  "languageCount": 8,
  "languages": [
    { "lanName": "Original Audio", "lanCode": "ja", "original": true, "kind": "original",
      "detailPath": "demon-slayer-...-OpOlWPwnoj4",
      "qualities": [
        { "resolution": 1080, "size_mb": 486.2, "url": "https://bcdnxw.hakunaymatata.com/...mp4?sign=..." }
      ] },
    { "lanName": "English", "lanCode": "en", "original": false, "kind": "dub",
      "detailPath": "demon-slayer-...-cK8E2dUTaC8",
      "qualities": [ { "resolution": 1080, "size_mb": 486.2, "url": "..." } ] }
  ],
  "subtitleCount": 13,
  "subtitles": [
    { "lanName": "English", "lanCode": "en",
      "url": "https://cacdn.hakunaymatata.com/subtitle/...srt?Policy=...",
      "size": 21312 }
  ],
  "fetchedAt": 1761600000,
  "ttlHint": 7200
}
```

Each entry in `languages` is one dub variant with its own playable
`qualities`. `subtitles` is the AGGREGATED set: captions collected from every
variant that has streams, deduped per language (the Original Audio variant
usually carries the richest caption set while dub variants carry none). The
CDN urls stay valid for hours - `ttlHint` advertises a conservative 7200
seconds; re-resolve after that instead of storing them.

## Typical workflow

```bash
# 1. Find the title
curl "http://localhost:3000/api/search?q=oppenheimer&limit=1"
#    -> detailPath: "oppenheimer-Akh5Nrwl7o"

# 2. Metadata + cast + dubs (seasons for TV)
curl "http://localhost:3000/api/details?id=oppenheimer-Akh5Nrwl7o"

# 3. Direct MP4 URLs (movie or episode)
curl "http://localhost:3000/api/movie?id=oppenheimer-Akh5Nrwl7o"
curl "http://localhost:3000/api/tv?id=lucifer-UQASHYbVPB2&season=1&episode=1"

# 4. Subtitles
curl "http://localhost:3000/api/subtitles?id=oppenheimer-Akh5Nrwl7o"

# Or get everything in ONE call (every audio language + every subtitle)
curl "http://localhost:3000/api/episode-matrix?id=oppenheimer-Akh5Nrwl7o"
```

## Things to know

- **Video URLs need a Referer.** The MP4 links on
  `bcdnxw.hakunaymatata.com` are signed, but the CDN also checks the referer:
  send `Referer: https://movieboxonline.net/` when fetching them or you get
  429. Subtitle URLs have no such check.
- **Rate limits are real.** The `/play` backend allows ~1 successful call per
  2–3 minutes per IP; hammering returns empty results. Wait and retry. On a
  shared host everyone shares one egress IP.
- **Signed URLs expire.** Video links live for a few hours, subtitle links
  for days. Store `detailPath` values (they are stable) and re-resolve when
  needed.
- **Not every title has every quality.** Check the `qualities` array — and
  `resolutions` per season in `/api/details`.
- **1080P**: free via the `play` source, VIP-locked via the `download`
  fallback. The `vipLocked` flag marks the difference.

## Python scraper

`tools/moviebox_scraper.py` is a standalone, dependency-free (stdlib only)
CLI scraper for the same backend — useful for bulk jobs where the request
pattern of an HTTP API gets in the way:

```bash
python3 tools/moviebox_scraper.py --movie oppenheimer-Akh5Nrwl7o
python3 tools/moviebox_scraper.py --tv lucifer-UQASHYbVPB2 --seasons 1,2 --max-episodes 5
python3 tools/moviebox_scraper.py --trending --limit 10 --delay 5
```

Use `--delay 5` (seconds between calls) for bulk scraping to stay clear of
the rate limit. Run it with `--help` for the full list of options.

## Media proxy (optional)

`proxy.js` is a standalone companion server for the referer problem: browsers
fetching the MP4 links directly get 403/429 because they cannot send the
required Referer. The proxy relays the bytes with the right headers, Range
passthrough and clean download filenames:

```bash
node proxy.js            # PORT + PROXY_PATH env or config.json

# then
curl -OJ "http://localhost:3000/dl?url=<signed-mp4-url>&name=Movie_1080P.mp4"
```

Set `PROXY_PATH` (or `config.json`'s `pathPrefix`) to a random string to move
all routes under `/<prefix>/` so scanners cannot find the proxy. `url` must
point at an allowlisted CDN host; `dp` optionally rebuilds the Referer as the
matching play page.

Deploy it on any small Node host and keep the API itself on a serverless
platform - the API only ever moves JSON, the proxy only moves media bytes.

## Project layout

```
Moviebox-API/
|-- server.js              # standalone Node server (node server.js)
|-- proxy.js               # optional standalone media proxy (node proxy.js)
|-- api/                   # Vercel serverless entry points (thin wrappers)
|-- lib/                   # endpoint logic shared by server.js and api/
|-- tools/
|   `-- moviebox_scraper.py
|-- vercel.json
`-- package.json           # no dependencies, "type": "module"
```

## Deploying

**Anywhere Node runs** (a VPS, a container host, your laptop):

```bash
node server.js             # listens on $PORT, default 3000
```

**Vercel** — the `api/` directory is already in Vercel's serverless format:

```bash
npm i -g vercel
vercel                     # follow the prompts, framework preset: Other
```

Or import the GitHub repo at <https://vercel.com/new> and click Deploy. The
API then lives at `https://<your-project>.vercel.app/api/...`.

## License

MIT. Use it however you want.
