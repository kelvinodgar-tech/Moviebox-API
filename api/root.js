// GET / -> a small self-contained landing page.
//
// The deployment serves ONLY the API functions (the project's static output
// directory is not configured on the Vercel side, so every static path 404s)
// and the root URL used to fall through to Vercel's default 404 page. This
// handler gives the root a clean branded page instead - fully inline (no
// external CSS/JS dependencies), so it renders no matter what the static
// configuration is. It deliberately documents NOTHING about the API surface.
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MovieBox</title>
<meta name="description" content="MovieBox - movies and TV shows.">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%2310b84d'/><path d='M12 9v14l11-7z' fill='white'/></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b0f0d;
    color: #e8f5ee;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    text-align: center;
    padding: 48px 32px;
    max-width: 420px;
  }
  .mark {
    width: 64px; height: 64px;
    margin: 0 auto 22px;
    border-radius: 16px;
    background: #10b84d;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 8px 32px rgba(16, 184, 77, .35);
  }
  .mark svg { width: 30px; height: 30px; }
  h1 { font-size: 26px; letter-spacing: -.02em; font-weight: 700; }
  h1 span { color: #10b84d; }
  p.tag { margin-top: 10px; font-size: 14px; color: #9db8aa; line-height: 1.6; }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 26px;
    padding: 7px 14px;
    border-radius: 999px;
    border: 1px solid rgba(16, 184, 77, .4);
    background: rgba(16, 184, 77, .12);
    font-size: 12px;
    font-weight: 600;
    color: #4ed47f;
  }
  .status i {
    width: 8px; height: 8px; border-radius: 50%;
    background: #10b84d;
    box-shadow: 0 0 0 0 rgba(16,184,77,.6);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(16,184,77,.5); }
    70% { box-shadow: 0 0 0 8px rgba(16,184,77,0); }
    100% { box-shadow: 0 0 0 0 rgba(16,184,77,0); }
  }
  footer { margin-top: 44px; font-size: 11px; color: #5c6f64; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">
      <svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
    </div>
    <h1>Movie<span>Box</span></h1>
    <p class="tag">Movies &amp; TV shows, streaming and downloads.</p>
    <div class="status"><i></i>Service operational</div>
    <footer>&copy; MovieBox &middot; For educational purposes only.</footer>
  </main>
</body>
</html>`;

export default function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    return res.status(204).end();
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).end(PAGE);
}
