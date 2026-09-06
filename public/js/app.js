/* =========================================================
   MovieBox Clone - Frontend application logic
   Base API: same origin /api/... (also works on Vercel)
   ========================================================= */

(function () {
  "use strict";

  var API_BASE = window.MOVIEBOX_API_BASE || "";
  var MAX_CARDS_PER_SECTION = 20;
  var EPISODES_PER_PAGE = 24;

  // ---------- Small utilities ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") n.className = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "dataset") {
          Object.keys(attrs.dataset).forEach(function (d) { n.dataset[d] = attrs.dataset[d]; });
        } else if (k.startsWith("on") && typeof attrs[k] === "function") {
          n.addEventListener(k.slice(2), attrs[k]);
        } else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function api(path) {
    return fetch(API_BASE + path).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function streamProxyUrl(mediaUrl) {
    if (!mediaUrl) return "";
    var base = API_BASE || "";
    return base + "/api/stream?url=" + encodeURIComponent(mediaUrl);
  }
  function downloadProxyUrl(mediaUrl, filename) {
    if (!mediaUrl) return "";
    var base = API_BASE || "";
    var u = base + "/api/download?url=" + encodeURIComponent(mediaUrl);
    if (filename) u += "&filename=" + encodeURIComponent(filename);
    return u;
  }
  function toast(msg, kind) {
    var wrap = $(".toast-wrap");
    if (!wrap) {
      wrap = el("div", { class: "toast-wrap" });
      document.body.appendChild(wrap);
    }
    var t = el("div", { class: "toast" + (kind ? " " + kind : ""), text: msg });
    wrap.appendChild(t);
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transition = "opacity .3s";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 3500);
  }

  // Sanitize a movie/show title into a filename-safe token.
  function safeName(s) {
    return String(s || "").replace(/[^\w.\- ]/g, "").replace(/\s+/g, "_").substring(0, 80) || "movie";
  }

  // Format a season+episode tag as S{season}E{episode} (no zero padding).
  function seTag(season, episode) {
    return "S" + (season || 1) + "E" + (episode || 0);
  }

  // Build a download filename for the website download links.
  // Movies: {title}_{quality}.mp4
  // Series: {title}_S{season}E{episode}_{quality}.mp4
  function buildDownloadFilename(title, resolution, season, episode) {
    var q = (resolution || "video") + "P";
    if (season) {
      return safeName(title) + "_" + seTag(season, episode) + "_" + q + ".mp4";
    }
    return safeName(title) + "_" + q + ".mp4";
  }

  // Format a file size in bytes into a human-readable string.
  // MB for sizes under 1 GB, GB for sizes 1 GB and above.
  function formatFileSize(bytes) {
    var b = parseInt(bytes, 10) || 0;
    if (b <= 0) return "";
    var mb = b / (1024 * 1024);
    if (mb >= 1024) {
      return (mb / 1024).toFixed(1) + " GB";
    }
    return Math.round(mb) + " MB";
  }

  // ---------- SRT parser (for subtitle overlay) ----------
  function srtTimeToSeconds(t) {
    var m = t.replace(",", ".").match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  }
  function parseSRT(text) {
    if (!text) return [];
    var blocks = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n{2,}/);
    var cues = [];
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split("\n");
      var idx = 0;
      if (/^\d+$/.test(lines[idx].trim())) idx++; // skip numeric index
      var timeLine = lines[idx] || "";
      var m = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
      if (!m) continue;
      idx++;
      var start = srtTimeToSeconds(m[1]);
      var end = srtTimeToSeconds(m[2]);
      var textLines = lines.slice(idx);
      // Strip basic HTML/<i> tags for display
      var cueText = textLines.join("\n").replace(/<[^>]+>/g, "").trim();
      if (!cueText) continue;
      cues.push({ start: start, end: end, text: cueText });
    }
    return cues;
  }

  function findCueAt(cues, t) {
    // cues are sorted by start time. Find the active cue.
    for (var i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t <= cues[i].end) return cues[i];
      if (t < cues[i].start) break;
    }
    return null;
  }

  // ---------- Card rendering ----------
  function ratingStar(rating) {
    if (!rating) return "";
    return '<span class="card-rating"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27l5.18 3.12-1.4-5.92 4.6-3.98-6.05-.52L12 4.5 9.67 9.97l-6.05.52 4.6 3.98-1.4 5.92z"/></svg>'
      + escapeHtml(String(rating)) + '</span>';
  }
  function typeBadge(type) {
    var cls = type === "tv" ? "card-type tv" : "card-type movie";
    return '<span class="' + cls + '">' + (type === "tv" ? "TV" : "Movie") + "</span>";
  }
  function cardHTML(item) {
    var cover = item.cover || "";
    var title = escapeHtml(item.title || "Untitled");
    var rating = item.imdbRatingValue ? parseFloat(item.imdbRatingValue).toFixed(1) : "";
    var year = String(item.releaseDate || "").slice(0, 4);
    var genre = escapeHtml((item.genre || "").split(",")[0] || "");
    var type = item.type || (item.subjectType === 1 ? "movie" : "tv");
    var dp = escapeHtml(item.detailPath || "");
    var metaParts = [];
    if (year) metaParts.push('<span>' + year + '</span>');
    if (genre) metaParts.push('<span class="dot"></span><span>' + genre + '</span>');
    var meta = metaParts.length
      ? '<div class="card-meta">' + metaParts.join("") + '</div>'
      : '<div class="card-meta"></div>';

    return ''
      + '<a class="card" href="detail.html?path=' + dp + '">'
      +   '<div class="card-poster">'
      +     '<div class="card-poster-fallback">No cover</div>'
      +     (cover
          ? '<img loading="lazy" decoding="async" src="' + escapeHtml(cover) + '" alt="' + title + '" onerror="this.style.display=\'none\'">'
          : '')
      +     ratingStar(rating)
      +     typeBadge(type)
      +     '<div class="card-play"><div class="card-play-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div></div>'
      +   '</div>'
      +   '<div class="card-body">'
      +     '<div class="card-title">' + title + '</div>'
      +     meta
      +   '</div>'
      + '</a>';
  }
  function skeletonCards(n) {
    var out = "";
    for (var i = 0; i < (n || 8); i++) {
      out += '<div class="skeleton-card"><div class="skeleton-poster"></div>'
        + '<div class="skeleton-line" style="width:70%"></div>'
        + '<div class="skeleton-line" style="width:40%"></div></div>';
    }
    return out;
  }
  function renderGrid(container, items) {
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-state" style="grid-column:1/-1">'
        + '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 21l-4.35-4.35M11 19a8 8 0 110-16 8 8 0 010 16z"/></svg>'
        + '<div>No titles found.</div></div>';
      return;
    }
    container.innerHTML = items.slice(0, MAX_CARDS_PER_SECTION).map(cardHTML).join("");
  }
  function renderRow(container, items) {
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-state">No titles found.</div>';
      return;
    }
    container.innerHTML = items.slice(0, MAX_CARDS_PER_SECTION).map(cardHTML).join("");
  }

  // ---------- Header search wiring ----------
  function initHeaderSearch() {
    var input = $("#site-search");
    if (!input) return;
    var form = input.closest("form") || input.parentElement;

    var dropdown = el("div", { class: "suggest-dropdown", style: "display:none" });
    input.parentNode.appendChild(dropdown);
    var suggestTimer = null;
    var lastQ = "";
    function showSuggestions(items) {
      if (!items || !items.length) { dropdown.style.display = "none"; dropdown.innerHTML = ""; return; }
      dropdown.innerHTML = items.slice(0, 8).map(function (w) {
        return '<a class="suggest-item" href="search.html?q=' + encodeURIComponent(w) + '">' + escapeHtml(w) + '</a>';
      }).join("");
      dropdown.style.display = "block";
    }
    input.addEventListener("input", function () {
      var q = (input.value || "").trim();
      if (q.length < 2) { dropdown.style.display = "none"; return; }
      if (q === lastQ) return;
      lastQ = q;
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(function () {
        fetch(API_BASE + "/api/search?q=" + encodeURIComponent(q) + "&limit=1")
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (d && d.suggestions) showSuggestions(d.suggestions); })
          .catch(function () {});
      }, 220);
    });
    input.addEventListener("blur", function () {
      setTimeout(function () { dropdown.style.display = "none"; }, 150);
    });
    input.addEventListener("focus", function () {
      if (dropdown.children.length) dropdown.style.display = "block";
    });

    function submit(e) {
      e.preventDefault();
      var q = (input.value || "").trim();
      if (q) window.location.href = "search.html?q=" + encodeURIComponent(q);
    }
    if (form && form.tagName === "FORM") {
      form.addEventListener("submit", submit);
    } else {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") submit(e);
      });
    }
    var params = new URLSearchParams(window.location.search);
    var q = params.get("q");
    if (q && document.body.dataset.page === "search") input.value = q;
  }

  // ---------- Page: home ----------
  function initHome() {
    var heroTrack = $("#hero-track");
    var heroDots = $("#hero-dots");
    var trendingGrid = $("#trending-grid");
    var sectionsWrap = $("#home-sections");
    var heroIdx = 0;
    var heroTimer = null;
    var heroItems = [];

    function renderHero(items) {
      heroItems = items.slice(0, 6);
      if (heroItems.length === 0) {
        $("#hero").style.display = "none";
        return;
      }
      (function () {
        var first = heroItems[0];
        var img = (first && (first.bannerImage || first.cover)) || "";
        if (img) {
          var l = document.createElement("link");
          l.rel = "preload";
          l.as = "image";
          l.href = img;
          document.head.appendChild(l);
        }
      })();
      heroTrack.innerHTML = heroItems.map(function (it, i) {
        var img = it.bannerImage || it.cover || "";
        var rating = it.imdbRatingValue ? parseFloat(it.imdbRatingValue).toFixed(1) : "";
        var genre = escapeHtml((it.genre || "").split(",").slice(0, 2).join(", "));
        var year = String(it.releaseDate || "").slice(0, 4);
        var meta = [];
        if (rating) meta.push('<span class="rating"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27l5.18 3.12-1.4-5.92 4.6-3.98-6.05-.52L12 4.5 9.67 9.97l-6.05.52 4.6 3.98-1.4 5.92z"/></svg>' + rating + '</span>');
        if (year) meta.push('<span>' + year + '</span>');
        if (genre) meta.push('<span>' + genre + '</span>');
        meta.push('<span class="badge">' + (it.type === "tv" ? "TV" : "Movie") + '</span>');
        return ''
          + '<div class="hero-slide' + (i === 0 ? " active" : "") + '" data-i="' + i + '" style="background-image:url(\'' + escapeHtml(img) + '\')">'
          +   '<div class="hero-content container">'
          +     '<h2 class="hero-title">' + escapeHtml(it.title || "") + '</h2>'
          +     '<div class="hero-meta">' + meta.join("") + '</div>'
          +     '<p class="hero-desc">' + escapeHtml(it.description || "") + '</p>'
          +     '<div class="hero-actions">'
          +       '<a class="btn btn-primary" href="detail.html?path=' + escapeHtml(it.detailPath) + '"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Watch Now</a>'
          +       '<a class="btn btn-secondary" href="detail.html?path=' + escapeHtml(it.detailPath) + '">Details</a>'
          +     '</div>'
          +   '</div>'
          + '</div>';
      }).join("");
      heroDots.innerHTML = heroItems.map(function (_, i) {
        return '<button type="button" class="hero-dot' + (i === 0 ? " active" : "") + '" data-i="' + i + '" aria-label="Slide ' + (i + 1) + '"></button>';
      }).join("");
      $all(".hero-dot", heroDots).forEach(function (d) {
        d.addEventListener("click", function () { goHero(parseInt(d.dataset.i)); });
      });
      startHeroTimer();
    }
    function goHero(i) {
      if (!heroItems.length) return;
      heroIdx = (i + heroItems.length) % heroItems.length;
      $all(".hero-slide", heroTrack).forEach(function (s) {
        s.classList.toggle("active", parseInt(s.dataset.i) === heroIdx);
      });
      $all(".hero-dot", heroDots).forEach(function (d) {
        d.classList.toggle("active", parseInt(d.dataset.i) === heroIdx);
      });
    }
    function startHeroTimer() {
      clearInterval(heroTimer);
      heroTimer = setInterval(function () { goHero(heroIdx + 1); }, 6000);
    }

    function sectionHTML(s, lazy) {
      var items = (s.items || []).slice(0, MAX_CARDS_PER_SECTION);
      return ''
        + '<section class="section row-section' + (lazy ? " lazy-section" : "") + '">'
        +   '<div class="section-head">'
        +     '<h3 class="section-title">' + escapeHtml(s.title) + '</h3>'
        +     '<span class="row-hint">Swipe &rarr;</span>'
        +   '</div>'
        +   '<div class="row-scroll">' + items.map(cardHTML).join("") + '</div>'
        + '</section>';
    }

    function renderSections(sections) {
      var valid = sections.filter(function (s) { return s.items && s.items.length; });
      if (!valid.length) {
        sectionsWrap.innerHTML = '';
        return;
      }
      var isMobile = window.matchMedia("(max-width: 767px)").matches;
      var INITIAL_SECTIONS = isMobile ? 5 : valid.length;
      var queued = valid.slice(INITIAL_SECTIONS);

      sectionsWrap.innerHTML = valid.slice(0, INITIAL_SECTIONS).map(function (s) {
        return sectionHTML(s, false);
      }).join("");

      if (!queued.length) return;

      var sentinel = el("div", { class: "load-more-sentinel", id: "sections-sentinel" });
      var btn = el("button", {
        class: "btn btn-ghost btn-sm",
        text: "Load more sections (" + queued.length + ")",
        onclick: function () { loadNextBatch(); }
      });
      sentinel.appendChild(btn);
      sectionsWrap.appendChild(sentinel);

      var loading = false;
      function loadNextBatch() {
        if (loading || !queued.length) return;
        loading = true;
        btn.textContent = "Loading...";
        requestAnimationFrame(function () {
          var batch = queued.splice(0, 3);
          var frag = document.createDocumentFragment();
          batch.forEach(function (s) {
            var wrap = el("div", { html: sectionHTML(s, true) });
            while (wrap.firstChild) frag.appendChild(wrap.firstChild);
          });
          sectionsWrap.insertBefore(frag, sentinel);
          requestAnimationFrame(function () {
            $all(".lazy-section", sectionsWrap).forEach(function (node) {
              node.classList.add("shown");
            });
          });
          if (queued.length) {
            btn.textContent = "Load more sections (" + queued.length + ")";
            loading = false;
          } else {
            sentinel.parentNode && sentinel.parentNode.removeChild(sentinel);
          }
          loading = false;
        });
      }

      if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) loadNextBatch();
          });
        }, { rootMargin: "300px" });
        io.observe(sentinel);
      }
    }

    trendingGrid.innerHTML = skeletonCards(8);
    api("/api/trending?limit=20").then(function (data) {
      renderRow(trendingGrid, data.items || []);
    }).catch(function (e) {
      trendingGrid.innerHTML = '<div class="error-box">Failed to load trending: ' + escapeHtml(e.message) + '</div>';
    });

    api("/api/home").then(function (data) {
      renderHero(data.banners || []);
      renderSections(data.sections || []);
    }).catch(function (e) {
      sectionsWrap.innerHTML = '<div class="error-box">Failed to load home content: ' + escapeHtml(e.message) + '</div>';
    });
  }

  // ---------- Page: search ----------
  var searchState = { q: "", limit: 50, total: 0, loading: false };

  function initSearch() {
    var grid = $("#results-grid");
    var titleEl = $("#results-title");
    var suggestEl = $("#search-suggestions");
    var params = new URLSearchParams(window.location.search);
    var q = (params.get("q") || "").trim();
    if (!q) {
      titleEl.textContent = "Search";
      grid.innerHTML = '<div class="empty-state"><div>Use the search bar above to find movies and TV shows.</div></div>';
      return;
    }
    searchState.q = q;
    searchState.total = 0;
    titleEl.innerHTML = 'Results for <span style="color:var(--accent)">' + escapeHtml(q) + '</span>';
    grid.innerHTML = skeletonCards(12);
    loadSearchPage();
  }

  function loadSearchPage() {
    if (searchState.loading) return;
    searchState.loading = true;
    var grid = $("#results-grid");
    var titleEl = $("#results-title");

    var url = "/api/search?q=" + encodeURIComponent(searchState.q)
      + "&limit=" + searchState.limit;
    api(url).then(function (data) {
      searchState.total = data.total || 0;
      var results = data.results || [];
      var suggestions = data.suggestions || [];

      titleEl.innerHTML = 'Results for <span style="color:var(--accent)">' + escapeHtml(searchState.q) + '</span>'
        + ' <span class="text-muted">(' + searchState.total + ' found)</span>';

      var suggestEl = $("#search-suggestions");
      if (suggestEl) {
        if (suggestions.length) {
          suggestEl.style.display = "";
          suggestEl.innerHTML = '<span class="text-muted" style="font-size:13px;margin-right:8px">Try also:</span>'
            + suggestions.slice(0, 8).map(function (w) {
                return '<a class="genre-tag" href="search.html?q=' + encodeURIComponent(w) + '">' + escapeHtml(w) + '</a>';
              }).join("");
        } else {
          suggestEl.style.display = "none";
          suggestEl.innerHTML = "";
        }
      }

      renderGrid(grid, results);

      if (results.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 21l-4.35-4.35M11 19a8 8 0 110-16 8 8 0 010 16z"/></svg><div>No titles found for "' + escapeHtml(searchState.q) + '". Try a different keyword.</div></div>';
      }
      searchState.loading = false;
    }).catch(function (e) {
      grid.innerHTML = '<div class="error-box">Search failed: ' + escapeHtml(e.message) + '</div>';
      searchState.loading = false;
    });
  }

  // ---------- Page: detail ----------
  var detailState = {
    detailPath: null,
    info: null,
    seasons: null,
    currentSeason: 1,
    currentEpisode: 0,
    currentQuality: null,
    currentDubPath: null,  // detailPath of the currently-playing dub
    qualities: null,
    captions: null,        // captions list for the current episode/movie
    activeCaption: null,   // currently-selected caption object
    subtitleCues: null,    // parsed SRT cues for the active caption
    playerInstance: null,  // the custom player instance
  };

  function initDetail() {
    var params = new URLSearchParams(window.location.search);
    var path = params.get("path");
    if (!path) {
      $("#detail-root").innerHTML = '<div class="error-box">No title specified.</div>';
      return;
    }
    detailState.detailPath = path;
    detailState.currentDubPath = path;
    initDownloadModal();
    loadDetail(path);
  }

  function loadDetail(path) {
    var root = $("#detail-root");
    root.innerHTML = '<div class="loading"><div class="spinner"></div>Loading details...</div>';

    Promise.all([
      api("/api/details/" + encodeURIComponent(path)).catch(function (e) { return { __error: e.message }; }),
      api("/api/seasons/" + encodeURIComponent(path)).catch(function (e) { return { __error: e.message }; }),
    ]).then(function (results) {
      var info = results[0];
      var seasons = results[1];
      if (info && info.__error && (!info.title)) {
        root.innerHTML = '<div class="error-box">Failed to load details: ' + escapeHtml(info.__error) + '</div>';
        return;
      }
      detailState.info = info;
      detailState.seasons = (seasons && !seasons.__error) ? seasons : null;
      renderDetail();
    });
  }

  function renderDetail() {
    var info = detailState.info;
    var root = $("#detail-root");
    var type = info.type || (info.subjectType === 1 ? "movie" : "tv");
    var genres = (info.genre || "").split(",").map(function (g) { return g.trim(); }).filter(Boolean);
    var rating = info.imdbRatingValue ? parseFloat(info.imdbRatingValue).toFixed(1) : "N/A";
    var year = String(info.releaseDate || "").slice(0, 4);

    var dubs = (info.dubs || []).filter(function (d) { return d.kind === "dub"; });
    var subTracks = (info.dubs || []).filter(function (d) { return d.kind === "subtitle"; });
    var subtitleList = (info.subtitles || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);

    var facts = [];
    if (year) facts.push(["Release", year]);
    if (info.durationText) facts.push(["Duration", info.durationText]);
    if (info.countryName) facts.push(["Country", info.countryName]);
    if (info.imdbRatingCount) facts.push(["IMDB Votes", Number(info.imdbRatingCount).toLocaleString()]);
    if (info.castCount != null) facts.push(["Cast", info.castCount + " people"]);

    // 1. Poster + title + metadata + synopsis (poster-first layout).
    var html = ''
      + '<div class="detail-poster-section"' + (info.cover ? ' style="--bg:url(\'' + escapeHtml(info.cover) + '\')"' : '') + '>'
      +   '<div class="container detail-poster-inner">'
      +     (info.cover ? '<img class="detail-poster-img" src="' + escapeHtml(info.cover) + '" alt="' + escapeHtml(info.title || "") + '" loading="lazy">' : '')
      +     '<div class="detail-info-block">'
      +       '<h1 class="detail-title">' + escapeHtml(info.title || "Untitled") + '</h1>'
      +       '<div class="detail-meta">'
      +         '<span class="type-badge">' + (type === "tv" ? "TV Series" : "Movie") + '</span>'
      +         '<span class="rating"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27l5.18 3.12-1.4-5.92 4.6-3.98-6.05-.52L12 4.5 9.67 9.97l-6.05.52 4.6 3.98-1.4 5.92z"/></svg>' + rating + '</span>'
      +         (year ? '<span class="pill">' + year + '</span>' : '')
      +         (info.durationText ? '<span class="pill">' + escapeHtml(info.durationText) + '</span>' : '')
      +         (info.countryName ? '<span class="pill">' + escapeHtml(info.countryName) + '</span>' : '')
      +       '</div>'
      +       (genres.length ? '<div class="detail-genres">' + genres.map(function (g) { return '<span class="genre-tag">' + escapeHtml(g) + '</span>'; }).join("") + '</div>' : '')
      +       '<p class="detail-synopsis">' + escapeHtml(info.description || "No synopsis available.") + '</p>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '<div class="container"><div class="detail-actions" id="detail-actions"></div></div>';

    // 3. Trailer (inline player, just above Languages and Details).
    if (info.trailer && info.trailer.url) {
      html += '<div class="container"><section class="section detail-block trailer-block">'
        + '<div class="section-head"><h3 class="section-title">Trailer</h3></div>'
        + '<div class="trailer-video" id="trailer-container"></div>'
        + '</section></div>';
    }

    // 4. Languages section (info-only display).
    if (dubs.length || subTracks.length || subtitleList.length) {
      html += '<div class="container"><section class="section detail-block">'
        + '<div class="section-head"><h3 class="section-title">Languages</h3></div>'
        + '<div class="lang-section">';
      if (dubs.length) {
        html += '<div class="lang-group"><span class="lang-label">Audio (Dubs):</span>'
          + '<div class="lang-chips">' + dubs.map(function (d) {
              var cls = d.original ? 'lang-chip active' : 'lang-chip';
              var tag = d.original ? ' <span class="lang-orig">Original</span>' : '';
              return '<a class="' + cls + '"' + (d.detailPath ? ' href="detail.html?path=' + escapeHtml(d.detailPath) + '"' : '') + '>' + escapeHtml(d.lanName || d.lanCode) + tag + '</a>';
            }).join("") + '</div></div>';
      }
      var subs = subTracks.length
        ? subTracks.map(function (d) { return escapeHtml(d.lanName || d.lanCode); })
        : subtitleList;
      if (subs.length) {
        html += '<div class="lang-group"><span class="lang-label">Subtitles:</span>'
          + '<div class="lang-chips">' + subs.map(function (s) {
              return '<span class="lang-chip">' + escapeHtml(s) + '</span>';
            }).join("") + '</div></div>';
      }
      html += '</div></section></div>';
    }

    // 5. Facts section.
    if (facts.length) {
      html += '<div class="container"><section class="section detail-block">'
        + '<div class="section-head"><h3 class="section-title">Details</h3></div>'
        + '<div class="detail-facts">' + facts.map(function (f) {
            return '<div class="fact"><span class="fact-label">' + escapeHtml(f[0]) + '</span><span class="fact-value">' + escapeHtml(f[1]) + '</span></div>';
          }).join("") + '</div>'
        + '</section></div>';
    }

    // 6. TV: seasons + episodes (with pagination for >24 episodes).
    //    Comes BEFORE the cast section.
    if (type === "tv" && detailState.seasons && detailState.seasons.seasons && detailState.seasons.seasons.length) {
      detailState.currentSeason = detailState.seasons.seasons[0].season;
      detailState.currentEpisode = 0; // no episode auto-selected
      html += '<div class="container"><section class="section detail-block" id="episodes-section">'
        +   '<div class="section-head"><h3 class="section-title">Episodes <span class="accent" id="episodes-season-label">- Season ' + detailState.currentSeason + '</span></h3></div>'
        +   '<div class="season-bar" id="season-bar"></div>'
        +   '<div class="ep-toolbar" id="ep-toolbar"></div>'
        +   '<div class="episode-list" id="episode-list"></div>'
        + '</section></div>';
    } else if (type === "tv") {
      html += '<div class="container"><section class="section detail-block"><div class="empty-state">No season information available for this title.</div></section></div>';
    }

    // 7. Cast section (last).
    if (info.cast && info.cast.length) {
      html += '<div class="container"><section class="section detail-block">'
        + '<div class="section-head"><h3 class="section-title">Cast &amp; Crew <span class="accent">(' + info.cast.length + ')</span></h3></div>'
        + '<div class="cast-grid">' + info.cast.slice(0, 24).map(function (c) {
            var initial = (c.name || "?").charAt(0).toUpperCase();
            return ''
              + '<div class="cast-card">'
              +   '<div class="cast-photo">' + (c.avatarUrl ? '<img loading="lazy" decoding="async" src="' + escapeHtml(c.avatarUrl) + '" alt="' + escapeHtml(c.name) + '" onerror="this.style.display=\'none\'">' : escapeHtml(initial)) + '</div>'
              +   '<div class="cast-info">'
              +     '<div class="cast-name">' + escapeHtml(c.name || "") + '</div>'
              +     '<div class="cast-char">' + escapeHtml(c.character || c.role || "") + '</div>'
              +   '</div>'
              + '</div>';
          }).join("") + '</div>'
        + '</section></div>';
    }

    root.innerHTML = html;

    wireDetailActions();

    if (type === "tv" && detailState.seasons && detailState.seasons.seasons) {
      wireSeasons();
      renderEpisodes(detailState.currentSeason);
    }

    // Lazy-render the trailer only when the trailer section scrolls into view.
    if (info.trailer && info.trailer.url) {
      renderTrailerWhenVisible(info.trailer.url);
    }
  }

  function wireDetailActions() {
    var box = $("#detail-actions");
    if (!box) return;
    var info = detailState.info;
    var type = info.type || (info.subjectType === 1 ? "movie" : "tv");

    var watchBtn = el("button", {
      class: "btn btn-primary",
      html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Watch Now',
      onclick: function () {
        // Open the player as a separate full-page view.
        var url = "player.html?path=" + encodeURIComponent(detailState.detailPath);
        if (type === "tv") {
          var se = detailState.currentSeason || 1;
          var ep = detailState.currentEpisode || 1;
          url += "&season=" + se + "&episode=" + ep;
        }
        window.location.href = url;
      }
    });
    var dlBtn = el("button", {
      class: "btn btn-secondary",
      html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg> Download',
      onclick: function () {
        if (type === "movie") {
          openDownloadModal(info.title, detailState.detailPath, info.subjectId, 0, 0);
        } else {
          var ep = $("#episodes-section");
          if (ep) ep.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
    box.appendChild(watchBtn);
    box.appendChild(dlBtn);
  }

  function wireSeasons() {
    var bar = $("#season-bar");
    if (!bar) return;
    bar.innerHTML = detailState.seasons.seasons.map(function (s) {
      return '<button class="season-btn' + (s.season === detailState.currentSeason ? " active" : "") + '" data-se="' + s.season + '">Season ' + s.season + '</button>';
    }).join("");
    $all(".season-btn", bar).forEach(function (b) {
      b.addEventListener("click", function () {
        detailState.currentSeason = parseInt(b.dataset.se);
        detailState.currentEpisode = 0;
        $all(".season-btn", bar).forEach(function (x) { x.classList.toggle("active", x === b); });
        renderEpisodes(detailState.currentSeason);
        var label = $("#episodes-season-label");
        if (label) label.textContent = "- Season " + detailState.currentSeason;
      });
    });
  }

  function renderEpisodes(season) {
    var list = $("#episode-list");
    if (!list) return;
    var seasonInfo = (detailState.seasons.seasons || []).find(function (s) { return s.season === season; });
    var maxEp = (seasonInfo && seasonInfo.maxEp) || 0;
    if (!maxEp) {
      list.innerHTML = '<div class="empty-state">No episodes listed for this season.</div>';
      $("#ep-toolbar").innerHTML = "";
      return;
    }

    // Pagination: groups of EPISODES_PER_PAGE.
    var totalPages = Math.ceil(maxEp / EPISODES_PER_PAGE);
    var needsPaging = totalPages > 1;
    var needsSearch = maxEp > 20;

    var toolbar = $("#ep-toolbar");
    toolbar.innerHTML = "";

    var stateKey = "epState_" + season;
    if (!detailState[stateKey]) detailState[stateKey] = { page: 1, search: "" };
    var st = detailState[stateKey];

    // If a search query is active and matches an episode number, jump straight to it.
    if (st.search) {
      var n = parseInt(st.search, 10);
      if (!isNaN(n) && n >= 1 && n <= maxEp) {
        st.page = Math.ceil(n / EPISODES_PER_PAGE);
      }
    }

    if (needsPaging) {
      var sel = el("select", { class: "ep-select", "aria-label": "Episode range" });
      for (var p = 1; p <= totalPages; p++) {
        var startEp = (p - 1) * EPISODES_PER_PAGE + 1;
        var endEp = Math.min(p * EPISODES_PER_PAGE, maxEp);
        var opt = el("option", { value: String(p), text: "Episodes " + startEp + "-" + endEp });
        if (p === st.page) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", function () {
        st.page = parseInt(sel.value, 10);
        st.search = "";
        renderEpisodes(season);
      });
      toolbar.appendChild(sel);
    }

    if (needsSearch) {
      var form = el("form", { class: "ep-search", onsubmit: function (e) { e.preventDefault(); var v = input.value.trim(); st.search = v; renderEpisodes(season); } });
      var input = el("input", { type: "search", placeholder: "Jump to episode (1-" + maxEp + ")", "aria-label": "Search episode by number", value: st.search || "" });
      var goBtn = el("button", { class: "ep-search-btn", type: "submit", text: "Go" });
      form.appendChild(input);
      form.appendChild(goBtn);
      toolbar.appendChild(form);
    }

    var startEp = (st.page - 1) * EPISODES_PER_PAGE + 1;
    var endEp = Math.min(st.page * EPISODES_PER_PAGE, maxEp);
    var html = "";
    for (var ep = startEp; ep <= endEp; ep++) {
      html += ''
        + '<div class="episode-card">'
        +   '<div class="episode-num">' + ep + '</div>'
        +   '<div class="episode-body">'
        +     '<div class="episode-title">Episode ' + ep + '</div>'
        +     '<div class="episode-sub">Season ' + season + ' - Episode ' + ep + '</div>'
        +   '</div>'
        +   '<div class="episode-actions">'
        +     '<button class="btn btn-ghost btn-sm ep-watch" data-se="' + season + '" data-ep="' + ep + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Watch</button>'
        +     '<button class="btn btn-ghost btn-sm ep-dl" data-se="' + season + '" data-ep="' + ep + '" title="Download"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg></button>'
        +   '</div>'
        + '</div>';
    }
    list.innerHTML = html;
    $all(".ep-watch", list).forEach(function (b) {
      b.addEventListener("click", function () {
        var se = parseInt(b.dataset.se, 10);
        var ep = parseInt(b.dataset.ep, 10);
        detailState.currentSeason = se;
        detailState.currentEpisode = ep;
        // Open the player as a separate full-page view.
        var url = "player.html?path=" + encodeURIComponent(detailState.currentDubPath || detailState.detailPath)
          + "&season=" + se + "&episode=" + ep;
        window.location.href = url;
      });
    });
    $all(".ep-dl", list).forEach(function (b) {
      b.addEventListener("click", function () {
        var se = parseInt(b.dataset.se, 10);
        var ep = parseInt(b.dataset.ep, 10);
        openDownloadModal(detailState.info.title, detailState.currentDubPath || detailState.detailPath, detailState.info.subjectId, se, ep);
      });
    });
  }

  // ---------- Player page (separate full-page view) ----------
  function initPlayer() {
    var params = new URLSearchParams(window.location.search);
    var path = params.get("path");
    if (!path) {
      $("#player-root").innerHTML = '<div class="container" style="padding:40px 12px"><div class="error-box">No title specified.</div></div>';
      return;
    }
    var season = parseInt(params.get("season"), 10) || 0;
    var episode = parseInt(params.get("episode"), 10) || 0;
    // For TV shows without an episode, default to S1E1.
    if (season && !episode) episode = 1;

    detailState.detailPath = path;
    detailState.currentDubPath = path;
    detailState.currentSeason = season;
    detailState.currentEpisode = episode;
    initDownloadModal();
    loadPlayerPage(path, season, episode);
  }

  function loadPlayerPage(path, season, episode) {
    var root = $("#player-root");
    root.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';

    Promise.all([
      api("/api/details/" + encodeURIComponent(path)).catch(function (e) { return { __error: e.message }; }),
      api("/api/seasons/" + encodeURIComponent(path)).catch(function (e) { return { __error: e.message }; }),
    ]).then(function (results) {
      var info = results[0];
      var seasons = results[1];
      if (info && info.__error && !info.title) {
        root.innerHTML = '<div class="container" style="padding:40px 12px"><div class="error-box">Failed to load: ' + escapeHtml(info.__error) + '</div></div>';
        return;
      }
      detailState.info = info;
      detailState.seasons = (seasons && !seasons.__error) ? seasons : null;
      renderPlayerPage(info, season, episode);
    });
  }

  function renderPlayerPage(info, season, episode) {
    var root = $("#player-root");
    var type = info.type || (info.subjectType === 1 ? "movie" : "tv");
    var genres = (info.genre || "").split(",").map(function (g) { return g.trim(); }).filter(Boolean);
    var rating = info.imdbRatingValue ? parseFloat(info.imdbRatingValue).toFixed(1) : "N/A";
    var year = String(info.releaseDate || "").slice(0, 4);

    var html = ''
      + '<div class="player-page">'
      +   '<div class="player-video-wrap" id="player-video-wrap">'
      +     '<div class="loading"><div class="spinner"></div>Fetching streams...</div>'
      +   '</div>'
      +   '<div class="container player-info-block" style="padding-top:28px">'
      +     '<h1 class="player-page-title">' + escapeHtml(info.title || "Untitled") + '</h1>'
      +     '<div class="detail-meta">'
      +       '<span class="type-badge">' + (type === "tv" ? "TV Series" : "Movie") + '</span>'
      +       (season ? '<span class="pill" data-role="se-pill">S' + season + ' E' + episode + '</span>' : '')
      +       '<span class="rating"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27l5.18 3.12-1.4-5.92 4.6-3.98-6.05-.52L12 4.5 9.67 9.97l-6.05.52 4.6 3.98-1.4 5.92z"/></svg>' + rating + '</span>'
      +       (year ? '<span class="pill">' + year + '</span>' : '')
      +       (info.durationText ? '<span class="pill">' + escapeHtml(info.durationText) + '</span>' : '')
      +       (info.countryName ? '<span class="pill">' + escapeHtml(info.countryName) + '</span>' : '')
      +     '</div>'
      +     (genres.length ? '<div class="detail-genres">' + genres.map(function (g) { return '<span class="genre-tag">' + escapeHtml(g) + '</span>'; }).join("") + '</div>' : '')
      +     '<p class="detail-synopsis">' + escapeHtml(info.description || "No synopsis available.") + '</p>'
      +     '<div class="detail-actions" id="player-actions"></div>'
      +     (type === "tv" && detailState.seasons && detailState.seasons.seasons ? '<div class="player-seasons-wrap" id="player-seasons-wrap"><div class="player-season-bar" id="player-season-bar"></div><div class="episode-list" id="player-episode-list"></div></div>' : '')
      +   '</div>'
      + '</div>';

    root.innerHTML = html;

    // Wire up the Download / Back buttons.
    var actions = $("#player-actions");
    if (actions) {
      var dlBtn = el("button", {
        class: "btn btn-secondary",
        html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg> Download',
        onclick: function () {
          openDownloadModal(info.title, detailState.currentDubPath || detailState.detailPath, info.subjectId, season, episode);
        }
      });
      var backBtn = el("a", {
        class: "btn btn-ghost",
        href: "detail.html?path=" + encodeURIComponent(detailState.detailPath),
        html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg> Back to details'
      });
      actions.appendChild(dlBtn);
      actions.appendChild(backBtn);
    }

    // Wire up season/episode selectors on the player page for TV shows.
    if (type === "tv" && detailState.seasons && detailState.seasons.seasons) {
      wirePlayerSeasons(season, episode);
    }

    // Load the stream into the player wrapper.
    loadPlayerStream($("#player-video-wrap"), detailState.currentDubPath || detailState.detailPath, season, episode);
  }


  function wirePlayerSeasons(currentSeason, currentEpisode) {
    var bar = $("#player-season-bar");
    if (!bar) return;
    var seasons = detailState.seasons.seasons || [];
    bar.innerHTML = seasons.map(function(s) {
      return '<button class="season-btn' + (s.season === currentSeason ? " active" : "") + '" data-se="' + s.season + '">S' + s.season + '</button>';
    }).join("");

    $all(".season-btn", bar).forEach(function(b) {
      b.addEventListener("click", function() {
        var se = parseInt(b.dataset.se, 10);
        $all(".season-btn", bar).forEach(function(x) { x.classList.toggle("active", x === b); });
        renderPlayerEpisodes(se, 1);
        // Update the header pill so it reflects the newly-selected season/episode
        // instead of staying stuck on the initial S1 E1.
        detailState.currentSeason = se;
        detailState.currentEpisode = 1;
        updatePlayerHeaderEpisode(se, 1);
        loadPlayerStream($("#player-video-wrap"), detailState.currentDubPath || detailState.detailPath, se, 1);
      });
    });

    renderPlayerEpisodes(currentSeason, currentEpisode);
  }

  function renderPlayerEpisodes(season, selectedEp) {
    var list = $("#player-episode-list");
    if (!list) return;
    var seasonInfo = (detailState.seasons.seasons || []).find(function(s) { return s.season === season; });
    var maxEp = (seasonInfo && seasonInfo.maxEp) || 0;
    if (!maxEp) { list.innerHTML = ""; return; }

    var html = "";
    for (var ep = 1; ep <= Math.min(maxEp, 24); ep++) {
      html += '<button class="player-ep-btn' + (ep === selectedEp ? " active" : "") + '" data-se="' + season + '" data-ep="' + ep + '">E' + ep + '</button>';
    }
    if (maxEp > 24) {
      html += '<span class="player-ep-more">+' + (maxEp - 24) + ' more</span>';
    }
    list.innerHTML = html;

    $all(".player-ep-btn", list).forEach(function(b) {
      b.addEventListener("click", function() {
        var se = parseInt(b.dataset.se, 10);
        var ep = parseInt(b.dataset.ep, 10);
        $all(".player-ep-btn", list).forEach(function(x) { x.classList.toggle("active", x === b); });
        // Keep the header pill in sync with the actually-playing episode.
        detailState.currentSeason = se;
        detailState.currentEpisode = ep;
        updatePlayerHeaderEpisode(se, ep);
        loadPlayerStream($("#player-video-wrap"), detailState.currentDubPath || detailState.detailPath, se, ep);
      });
    });
  }

  // Update the "S{season} E{episode}" pill in the player header. Called
  // whenever the user picks a different season or episode from the picker
  // so the header stops showing the initial S1 E1 forever.
  function updatePlayerHeaderEpisode(season, episode) {
    var meta = document.querySelector('.player-info-block .detail-meta');
    if (!meta) return;
    var existing = meta.querySelector('[data-role="se-pill"]');
    if (season && episode) {
      var label = 'S' + season + ' E' + episode;
      if (existing) {
        existing.textContent = label;
      } else {
        var pill = document.createElement('span');
        pill.className = 'pill';
        pill.setAttribute('data-role', 'se-pill');
        pill.textContent = label;
        // Insert right after the type-badge so the order matches the initial render.
        var typeBadge = meta.querySelector('.type-badge');
        if (typeBadge && typeBadge.nextSibling) {
          meta.insertBefore(pill, typeBadge.nextSibling);
        } else {
          meta.insertBefore(pill, meta.firstChild);
        }
      }
    } else if (existing) {
      existing.remove();
    }
  }

  function loadPlayerStream(wrap, detailPath, season, episode, opts) {
    if (!wrap) return;
    detailState.currentDubPath = detailPath;
    // Capture the current playback position + playing state BEFORE we wipe the
    // wrap's innerHTML. Used when switching audio dubs so the new stream can
    // resume from exactly the same timestamp.
    var preserveTime = null;
    var wasPlaying = false;
    if (opts && opts.preserveTime) {
      var existingVideo = wrap.querySelector('video');
      if (existingVideo && existingVideo.currentTime > 0 && isFinite(existingVideo.currentTime)) {
        preserveTime = existingVideo.currentTime;
        wasPlaying = !existingVideo.paused;
      }
    }
    wrap.innerHTML = '<div class="loading"><div class="spinner"></div>Fetching streams...</div>';

    var url = "/api/" + (season ? "tv" : "movie") + "/" + encodeURIComponent(detailPath);
    if (season) url += "?season=" + season + "&episode=" + episode;

    api(url).then(function (data) {
      detailState.qualities = data.qualities || [];
      var best = data.best_free || (detailState.qualities.filter(function (q) { return q.url && !q.vipLocked; }).sort(function (a, b) { return b.resolution - a.resolution; })[0]);
      if (!best || !best.url) {
        wrap.innerHTML = '<div class="error-box">No playable stream found right now. The source may be rate-limited. Please try again in a moment.</div>';
        return;
      }
      detailState.currentQuality = best;
      buildPlayer(wrap, best, season, episode, { preserveTime: preserveTime, wasPlaying: wasPlaying });
      // Pre-fetch captions in the background so the CC menu shows languages quickly.
      fetchCaptions(detailPath, season, episode).then(function () {
        // captions are loaded inside buildPlayer
      }).catch(function () {});
    }).catch(function (e) {
      wrap.innerHTML = '<div class="error-box">Failed to load stream: ' + escapeHtml(e.message) + '</div>';
    });
  }

  function fetchCaptions(detailPath, season, episode) {
    var url = "/api/captions/" + encodeURIComponent(detailPath);
    if (season) url += "?season=" + season + "&episode=" + episode;
    return api(url).then(function (data) {
      detailState.captions = data.captions || [];
      return detailState.captions;
    }).catch(function () {
      detailState.captions = [];
      return [];
    });
  }

  function buildPlayer(wrap, quality, season, episode, opts) {
    var info = detailState.info || {};
    var playSrc = streamProxyUrl(quality.url);
    var qualities = detailState.qualities || [];
    // When switching audio dubs, the parent (loadPlayerStream) captures the
    // currentTime + playing state of the previous video before wiping the wrap.
    // We pick it up here so the new stream can resume at the same timestamp.
    var preserveTime = (opts && opts.preserveTime) ? opts.preserveTime : null;
    var wasPlayingBeforeSwitch = !!(opts && opts.wasPlaying);

    var dubs = (info.dubs || []).filter(function (d) { return d.kind === "dub"; });
    var audioOptions = [];
    if (dubs.length === 0 || !dubs.some(function (d) { return d.original; })) {
      audioOptions.push({ label: "Original", detailPath: detailState.detailPath, original: true });
    }
    dubs.forEach(function (d) {
      audioOptions.push({ label: d.lanName || d.lanCode || "Audio", detailPath: d.detailPath, original: !!d.original });
    });

    var freeQualities = qualities.filter(function(q) { return q.url && !q.vipLocked; });

    // Build the player HTML (wrap IS the .player-video-wrap, so put content directly inside)
    var html = ''
      +     '<video id="plyr-video" playsinline crossorigin preload="metadata"></video>'
      +     '<div class="player-overlay" id="player-overlay"></div>'
      +     '<div class="player-controls" id="player-controls">'
      +       '<div class="player-progress-wrap" id="player-progress-wrap">'
      +         '<div class="player-progress-bar" id="player-progress-bar">'
      +           '<div class="player-progress-buffered" id="pc-progress-buffered"></div>'
      +           '<div class="player-progress-filled" id="pc-progress-filled"></div>'
      +         '</div>'
      +       '</div>'
      +       '<div class="player-controls-row">'
      +         '<button class="pc-btn" id="pc-play" aria-label="Play/Pause"><svg id="pc-play-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>'
      +         '<button class="pc-btn" id="pc-rewind" aria-label="Rewind 10s"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z"/></svg></button>'
      +         '<button class="pc-btn" id="pc-forward" aria-label="Forward 10s"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg></button>'
      +         '<span class="pc-time" id="pc-time">0:00 / 0:00</span>'
      +         '<div class="pc-spacer"></div>'
      +         '<button class="pc-btn" id="pc-volume" aria-label="Volume"><svg id="pc-volume-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/></svg></button>'
      +         '<button class="pc-btn" id="pc-subtitles" aria-label="Subtitles"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zM4 18V6h16v12H4zm2-4h6v-1H6v1zm9 0h5v-1h-5v1z"/></svg></button>'
      +         '<button class="pc-btn" id="pc-settings" aria-label="Settings"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94a7.07 7.07 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.03 7.03 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 00-.6.22L2.74 8.84a.5.5 0 00.12.64l2.03 1.58a7.07 7.07 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.6.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54a.5.5 0 00.5.42h3.84a.5.5 0 00.5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96a.5.5 0 00.6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg></button>'
      +         '<button class="pc-btn" id="pc-fullscreen" aria-label="Fullscreen"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>'
      +       '</div>'
      +     '</div>'
      // Root settings menu: top-level categories. Tapping one opens a sub-panel.
      +     '<div class="pc-menu pc-menu-root" id="pc-menu-settings">'
      +       '<button class="pc-menu-item pc-menu-cat" data-panel="quality"><span>Quality</span><span class="pc-val" id="pc-val-quality">Auto</span><svg class="pc-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M9 6l6 6-6 6"/></svg></button>'
      +       '<button class="pc-menu-item pc-menu-cat" data-panel="audio"><span>Audio</span><span class="pc-val" id="pc-val-audio">Original</span><svg class="pc-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M9 6l6 6-6 6"/></svg></button>'
      +       '<button class="pc-menu-item pc-menu-cat" data-panel="subs"><span>Subtitles</span><span class="pc-val" id="pc-val-subs">Off</span><svg class="pc-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M9 6l6 6-6 6"/></svg></button>'
      +       '<button class="pc-menu-item pc-menu-cat" data-panel="playback"><span>Playback</span><span class="pc-val" id="pc-val-playback">1x</span><svg class="pc-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M9 6l6 6-6 6"/></svg></button>'
      +     '</div>'
      // Sub-panel: Quality
      +     '<div class="pc-menu pc-menu-sub" id="pc-panel-quality">'
      +       '<button class="pc-menu-back" data-back="root"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6l-6 6 6 6"/></svg><span>Quality</span></button>'
      +       '<div class="pc-menu-section"><div class="pc-menu-list" id="pc-list-quality"></div></div>'
      +     '</div>'
      // Sub-panel: Audio
      +     '<div class="pc-menu pc-menu-sub" id="pc-panel-audio">'
      +       '<button class="pc-menu-back" data-back="root"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6l-6 6 6 6"/></svg><span>Audio</span></button>'
      +       '<div class="pc-menu-section"><div class="pc-menu-list" id="pc-list-audio"></div></div>'
      +     '</div>'
      // Sub-panel: Subtitles
      +     '<div class="pc-menu pc-menu-sub" id="pc-panel-subs">'
      +       '<button class="pc-menu-back" data-back="root"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6l-6 6 6 6"/></svg><span>Subtitles</span></button>'
      +       '<div class="pc-menu-section"><div class="pc-menu-list" id="pc-list-subs"></div></div>'
      +     '</div>'
      // Sub-panel: Playback speed
      +     '<div class="pc-menu pc-menu-sub" id="pc-panel-playback">'
      +       '<button class="pc-menu-back" data-back="root"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6l-6 6 6 6"/></svg><span>Playback speed</span></button>'
      +       '<div class="pc-menu-section"><div class="pc-menu-list" id="pc-list-playback"></div></div>'
      +     '</div>'
      + '</div>';

    wrap.innerHTML = html;

    var video = wrap.querySelector('video');
    if (!video) return;
    video.src = playSrc;

    // ─── Build quality list (inside the Quality sub-panel) ──────────────
    var qualityList = wrap.querySelector('#pc-list-quality');
    freeQualities.forEach(function(q) {
      var btn = document.createElement('button');
      btn.className = 'pc-menu-item' + (q.resolution === quality.resolution ? ' active' : '');
      btn.setAttribute('data-res', q.resolution);
      btn.innerHTML = '<span>' + q.resolution + 'P</span><svg class="pc-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      qualityList.appendChild(btn);
    });
    // Initial root value label for Quality
    var qVal = wrap.querySelector('#pc-val-quality');
    if (qVal) qVal.textContent = quality.resolution ? (quality.resolution + 'P') : 'Auto';

    // ─── Build audio list (inside the Audio sub-panel) ──────────────────
    var audioList = wrap.querySelector('#pc-list-audio');
    // Default: original audio is active (currentDubPath is unset → matches the
    // entry whose detailPath equals detailState.detailPath or whose original=true).
    var activeDubPath = detailState.currentDubPath || detailState.detailPath;
    audioOptions.forEach(function(a) {
      var btn = document.createElement('button');
      var isActive = (a.detailPath === activeDubPath) || (!detailState.currentDubPath && a.original);
      btn.className = 'pc-menu-item' + (isActive ? ' active' : '');
      btn.setAttribute('data-dub', a.detailPath || '');
      btn.innerHTML = '<span>' + escapeHtml(a.label) + (a.original ? ' <span class="pc-tag">ORIG</span>' : '') + '</span><svg class="pc-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      audioList.appendChild(btn);
    });
    var aVal = wrap.querySelector('#pc-val-audio');
    if (aVal) {
      var activeAudio = audioOptions.find(function(a) { return (a.detailPath === activeDubPath) || (!detailState.currentDubPath && a.original); });
      aVal.textContent = activeAudio ? (activeAudio.original ? 'Original' : activeAudio.label) : 'Original';
    }

    // ─── Build playback speed list ──────────────────────────────────────
    var playbackList = wrap.querySelector('#pc-list-playback');
    var playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    var currentPlaybackRate = 1;
    playbackSpeeds.forEach(function(r) {
      var btn = document.createElement('button');
      btn.className = 'pc-menu-item' + (r === 1 ? ' active' : '');
      btn.setAttribute('data-rate', String(r));
      btn.innerHTML = '<span>' + (r === 1 ? 'Normal' : (r + 'x')) + '</span><svg class="pc-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      playbackList.appendChild(btn);
    });

    // State
    var isPlaying = false;
    var currentTime = 0;
    var duration = 0;
    var volume = 1;
    var muted = false;
    var controlsVisible = true;
    var idleTimer = null;
    var activeCaptionUrl = null;
    var captionsData = [];

    var playIcon = '<path d="M8 5v14l11-7z"/>';
    var pauseIcon = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    var volFull = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/>';
    // Muted speaker: same horn + waves outline, but with an X drawn INSIDE the
    // 24x24 viewBox (older version used x=19/24 which overflowed the viewBox
    // and made the icon look broken).
    var volMute = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';

    function formatTime(s) {
      if (!s || isNaN(s)) return '0:00';
      var m = Math.floor(s / 60);
      var sec = Math.floor(s % 60);
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function setPlaying(playing) {
      isPlaying = playing;
      wrap.querySelector('#pc-play-icon').innerHTML = playing ? pauseIcon : playIcon;
    }

    function updateProgress() {
      currentTime = video.currentTime || 0;
      duration = video.duration || 0;
      var pct = duration ? (currentTime / duration * 100) : 0;
      wrap.querySelector('#pc-progress-filled').style.width = pct + '%';
      wrap.querySelector('#pc-time').textContent = formatTime(currentTime) + ' / ' + formatTime(duration);
    }

    function updateBuffered() {
      if (video.buffered && video.buffered.length > 0) {
        var end = video.buffered.end(video.buffered.length - 1);
        var pct = duration ? (end / duration * 100) : 0;
        wrap.querySelector('#pc-progress-buffered').style.width = pct + '%';
      }
    }

    function togglePlay() {
      if (video.paused) video.play().catch(function(){});
      else video.pause();
    }

    function setControlsVisible(visible) {
      controlsVisible = visible;
      wrap.querySelector('#player-controls').style.opacity = visible ? '1' : '0';
      wrap.querySelector('#player-controls').style.pointerEvents = visible ? 'auto' : 'none';
    }

    function showControls() {
      setControlsVisible(true);
      clearTimeout(idleTimer);
      if (isPlaying) {
        idleTimer = setTimeout(function() { setControlsVisible(false); }, 3000);
      }
    }

    function closeAllMenus() {
      wrap.querySelectorAll('.pc-menu').forEach(function(m) { m.classList.remove('open'); });
    }

    // Open the settings root menu (shows the category list).
    function openSettingsRoot() {
      closeAllMenus();
      var root = wrap.querySelector('#pc-menu-settings');
      if (root) root.classList.add('open');
    }

    // Open a specific sub-panel (Quality / Audio / Subtitles / Playback).
    // Hides the root menu and shows only the requested sub-panel.
    function openSubPanel(name) {
      closeAllMenus();
      var panel = wrap.querySelector('#pc-panel-' + name);
      if (panel) panel.classList.add('open');
    }

    // Backwards-compatible toggle used by the dedicated subtitles button
    // and the gear icon. If the menu is already open and the user taps the
    // gear again, close everything.
    function toggleMenu(menu) {
      if (menu === 'settings') {
        var root = wrap.querySelector('#pc-menu-settings');
        if (root.classList.contains('open')) closeAllMenus();
        else openSettingsRoot();
      } else if (menu === 'subs') {
        // Dedicated subtitles button: jump straight to the subs sub-panel.
        var subsPanel = wrap.querySelector('#pc-panel-subs');
        if (subsPanel.classList.contains('open')) closeAllMenus();
        else openSubPanel('subs');
      } else {
        closeAllMenus();
      }
    }

    // Video events
    video.addEventListener('play', function() { setPlaying(true); showControls(); });
    video.addEventListener('pause', function() { setPlaying(false); setControlsVisible(true); clearTimeout(idleTimer); });
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('progress', updateBuffered);
    video.addEventListener('loadedmetadata', updateProgress);
    video.addEventListener('volumechange', function() {
      wrap.querySelector('#pc-volume-icon').innerHTML = (video.muted || video.volume === 0) ? volMute : volFull;
    });

    // Controls
    wrap.querySelector('#pc-play').addEventListener('click', function(e) { e.stopPropagation(); togglePlay(); });
    wrap.querySelector('#pc-rewind').addEventListener('click', function(e) { e.stopPropagation(); video.currentTime = Math.max(0, video.currentTime - 10); });
    wrap.querySelector('#pc-forward').addEventListener('click', function(e) { e.stopPropagation(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); });
    wrap.querySelector('#pc-volume').addEventListener('click', function(e) {
      e.stopPropagation();
      if (video.muted || video.volume === 0) { video.muted = false; video.volume = 1; }
      else { video.muted = true; }
    });
    wrap.querySelector('#pc-subtitles').addEventListener('click', function(e) { e.stopPropagation(); toggleMenu('subs'); });
    wrap.querySelector('#pc-settings').addEventListener('click', function(e) { e.stopPropagation(); toggleMenu('settings'); });
    wrap.querySelector('#pc-fullscreen').addEventListener('click', function(e) {
      e.stopPropagation();
      var wrap = document.querySelector('.player-video-wrap');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (wrap.requestFullscreen) wrap.requestFullscreen();
    });

    // Progress bar seek + drag.
    // Pointer events give us unified mouse + touch handling. We capture
    // the pointer so the user can drag past the bar's edges without losing
    // the drag. While dragging we update a "scrub preview" so the bar
    // follows the user's finger/cursor in real time, and the time readout
    // shows the scrubbed position. On release we actually seek the video.
    var progressWrap = wrap.querySelector('#player-progress-wrap');
    var progressBar = wrap.querySelector('#player-progress-bar');
    var progressFilled = wrap.querySelector('#pc-progress-filled');
    var pcTime = wrap.querySelector('#pc-time');
    var scrubbing = false;
    var scrubPct = 0;

    function pctFromEvent(e) {
      var rect = progressWrap.getBoundingClientRect();
      var x = (e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0));
      return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    }

    function applyScrubPreview(pct) {
      scrubPct = pct;
      if (progressFilled) progressFilled.style.width = (pct * 100) + '%';
      if (pcTime && duration) {
        var t = pct * duration;
        pcTime.textContent = formatTime(t) + ' / ' + formatTime(duration);
      }
      progressBar.classList.add('scrubbing');
    }

    function clearScrubPreview() {
      progressBar.classList.remove('scrubbing');
      // The normal timeupdate handler will reset the filled width + time text
      // on the next tick (it runs ~4x/sec).
    }

    progressWrap.addEventListener('pointerdown', function(e) {
      e.stopPropagation();
      e.preventDefault();
      scrubbing = true;
      try { progressWrap.setPointerCapture(e.pointerId); } catch (err) {}
      applyScrubPreview(pctFromEvent(e));
    });
    progressWrap.addEventListener('pointermove', function(e) {
      if (!scrubbing) return;
      e.stopPropagation();
      applyScrubPreview(pctFromEvent(e));
    });
    var finishScrub = function(e) {
      if (!scrubbing) return;
      scrubbing = false;
      try { progressWrap.releasePointerCapture(e.pointerId); } catch (err) {}
      var pct = pctFromEvent(e);
      if (duration) video.currentTime = pct * duration;
      clearScrubPreview();
    };
    progressWrap.addEventListener('pointerup', finishScrub);
    progressWrap.addEventListener('pointercancel', finishScrub);
    // Click handler kept as a fallback for browsers without pointer events
    // (very rare) - just seeks to the clicked position.
    progressWrap.addEventListener('click', function(e) {
      if (scrubbing) return;
      e.stopPropagation();
      var pct = pctFromEvent(e);
      if (duration) video.currentTime = pct * duration;
    });

    // Tap video to toggle controls
    var videoWrap = document.querySelector('.player-video-wrap');
    videoWrap.addEventListener('click', function(e) {
      if (e.target.closest('.player-controls') || e.target.closest('.pc-menu')) return;
      if (controlsVisible) { setControlsVisible(false); toggleMenu('close'); }
      else showControls();
    });

    // Root menu: tapping a category opens its sub-panel
    var settingsRoot = wrap.querySelector('#pc-menu-settings');
    settingsRoot.addEventListener('click', function(e) {
      e.stopPropagation();
      var cat = e.target.closest('.pc-menu-cat');
      if (!cat) return;
      var panel = cat.getAttribute('data-panel');
      if (panel) openSubPanel(panel);
    });

    // Back button on any sub-panel → returns to the root menu
    wrap.querySelectorAll('.pc-menu-back').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        openSettingsRoot();
      });
    });

    // Quality selection (inside the Quality sub-panel)
    var qualityPanel = wrap.querySelector('#pc-panel-quality');
    qualityPanel.addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = e.target.closest('[data-res]');
      if (!btn) return;
      var res = parseInt(btn.getAttribute('data-res'));
      var q = freeQualities.find(function(x) { return x.resolution === res; });
      if (!q) return;
      var t = video.currentTime;
      var wasPlaying = !video.paused;
      video.src = streamProxyUrl(q.url);
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        video.currentTime = t;
        if (wasPlaying) video.play().catch(function(){});
      });
      qualityPanel.querySelectorAll('[data-res]').forEach(function(b) { b.classList.toggle('active', b === btn); });
      // Update the root menu's Quality value label
      var qVal = wrap.querySelector('#pc-val-quality');
      if (qVal) qVal.textContent = q.resolution + 'P';
      closeAllMenus();
    });

    // Audio selection (inside the Audio sub-panel)
    var audioPanel = wrap.querySelector('#pc-panel-audio');
    audioPanel.addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = e.target.closest('[data-dub]');
      if (!btn) return;
      var dubPath = btn.getAttribute('data-dub');
      if (!dubPath || dubPath === (detailState.currentDubPath || detailState.detailPath)) { closeAllMenus(); return; }
      // Update active state on audio buttons + root value label BEFORE reload
      audioPanel.querySelectorAll('[data-dub]').forEach(function(b) { b.classList.toggle('active', b === btn); });
      var aVal = wrap.querySelector('#pc-val-audio');
      if (aVal) {
        var lbl = btn.querySelector('span');
        // Strip the ORIG tag if present
        if (lbl) {
          var clone = lbl.cloneNode(true);
          var tag = clone.querySelector('.pc-tag');
          if (tag) tag.remove();
          aVal.textContent = (clone.textContent || '').trim() || 'Original';
        }
      }
      closeAllMenus();
      detailState.currentDubPath = dubPath;
      // Preserve currentTime + playing state across the dub switch so the
      // user doesn't lose their place in the video.
      loadPlayerStream(wrap, dubPath, season, episode, { preserveTime: true });
    });

    // Playback speed selection (inside the Playback sub-panel)
    var playbackPanel = wrap.querySelector('#pc-panel-playback');
    playbackPanel.addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = e.target.closest('[data-rate]');
      if (!btn) return;
      var rate = parseFloat(btn.getAttribute('data-rate'));
      if (!isFinite(rate)) return;
      video.playbackRate = rate;
      currentPlaybackRate = rate;
      playbackPanel.querySelectorAll('[data-rate]').forEach(function(b) { b.classList.toggle('active', b === btn); });
      var pVal = wrap.querySelector('#pc-val-playback');
      if (pVal) pVal.textContent = rate === 1 ? '1x' : (rate + 'x');
      closeAllMenus();
    });

    // Click outside menus closes them
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.pc-menu') && !e.target.closest('#pc-settings') && !e.target.closest('#pc-subtitles')) {
        closeAllMenus();
      }
    });

    // Load captions into the Subtitles sub-panel
    fetchCaptions(detailState.currentDubPath || detailState.detailPath, season, episode).then(function(caps) {
      captionsData = caps || [];
      var subsList = wrap.querySelector('#pc-list-subs');
      if (!subsList) return;
      subsList.innerHTML = '';
      var offBtn = document.createElement('button');
      offBtn.className = 'pc-menu-item active';
      offBtn.setAttribute('data-cap', '');
      offBtn.innerHTML = '<span>Off</span><svg class="pc-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      subsList.appendChild(offBtn);
      captionsData.forEach(function(cap) {
        var btn = document.createElement('button');
        btn.className = 'pc-menu-item';
        btn.setAttribute('data-cap', cap.url);
        btn.setAttribute('data-lan', cap.lanName || cap.lanCode || '');
        btn.innerHTML = '<span>' + escapeHtml(cap.lanName || cap.lanCode || 'Unknown') + '</span><svg class="pc-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        subsList.appendChild(btn);
      });

      // Subtitle selection (inside the Subtitles sub-panel)
      subsList.addEventListener('click', function(e) {
        e.stopPropagation();
        var btn = e.target.closest('[data-cap]');
        if (!btn) return;
        var capUrl = btn.getAttribute('data-cap');
        subsList.querySelectorAll('[data-cap]').forEach(function(b) { b.classList.toggle('active', b === btn); });
        // Update the root menu's Subtitles value label
        var sVal = wrap.querySelector('#pc-val-subs');
        if (sVal) sVal.textContent = capUrl ? (btn.getAttribute('data-lan') || 'On') : 'Off';
        closeAllMenus();
        if (!capUrl) {
          activeCaptionUrl = null;
          wrap.querySelector('#player-overlay').innerHTML = '';
          return;
        }
        activeCaptionUrl = capUrl;
        loadSubtitle(capUrl);
      });
    }).catch(function() {});

    // Single timeupdate listener for subtitle rendering. Set up ONCE so
    // switching subtitles doesn't keep stacking new listeners on the video
    // element. The listener reads from detailState.subtitleCues + activeCaptionUrl
    // so subtitle switches just update those and the existing listener picks
    // up the new cues on the next timeupdate tick.
    video.addEventListener('timeupdate', function() {
      var overlay = wrap.querySelector('#player-overlay');
      if (!overlay) return;
      if (!activeCaptionUrl || !detailState.subtitleCues || !detailState.subtitleCues.length) {
        if (overlay.innerHTML) overlay.innerHTML = '';
        return;
      }
      var t = video.currentTime;
      var cue = null;
      for (var i = 0; i < detailState.subtitleCues.length; i++) {
        if (t >= detailState.subtitleCues[i].start && t <= detailState.subtitleCues[i].end) {
          cue = detailState.subtitleCues[i];
          break;
        }
      }
      // Use textContent for the inner span to avoid HTML injection AND to
      // make sure multi-line cues render as <br> properly.
      if (cue) {
        // Preserve line breaks from the SRT (lines separated by \n).
        var lines = cue.text.split('\n');
        var html = '';
        for (var j = 0; j < lines.length; j++) {
          if (j > 0) html += '<br>';
          html += '<span class="sub-text">' + escapeHtml(lines[j]) + '</span>';
        }
        overlay.innerHTML = html;
      } else {
        if (overlay.innerHTML) overlay.innerHTML = '';
      }
    });

    function loadSubtitle(url) {
      fetch('/api/stream?url=' + encodeURIComponent(url))
        .then(function(r) { return r.text(); })
        .then(function(srt) {
          detailState.subtitleCues = parseSRT(srt);
          // activeCaptionUrl is already set by the click handler before calling
          // loadSubtitle, so the timeupdate listener will start rendering cues
          // from the next tick.
        })
        .catch(function() {
          // On fetch error, clear cues so we don't render stale data.
          detailState.subtitleCues = [];
        });
    }

    function parseSRT(srt) {
      var cues = [];
      var blocks = srt.replace(/\r/g, '').split('\n\n');
      for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].split('\n');
        if (lines.length < 2) continue;
        var times = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
        if (!times) continue;
        var start = parseInt(times[1])*3600 + parseInt(times[2])*60 + parseInt(times[3]) + parseInt(times[4])/1000;
        var end = parseInt(times[5])*3600 + parseInt(times[6])*60 + parseInt(times[7]) + parseInt(times[8])/1000;
        var text = lines.slice(2).join('\n').trim();
        if (text) cues.push({ start: start, end: end, text: text });
      }
      return cues;
    }

    // Initial state
    wrap.querySelector('#pc-volume-icon').innerHTML = volFull;
    setPlaying(false);
    updateProgress();

    // Autoplay / resume-after-switch.
    // When switching audio dubs we captured the previous currentTime so the
    // new stream can jump to the exact same spot. For a fresh load (no
    // preserveTime), we just autoplay from 0.
    video.addEventListener('canplay', function onCanPlay() {
      video.removeEventListener('canplay', onCanPlay);
      if (preserveTime && isFinite(preserveTime) && preserveTime > 0) {
        // Wait for metadata so duration is known, then seek.
        var applySeek = function() {
          try { video.currentTime = preserveTime; } catch (e) {}
          if (wasPlayingBeforeSwitch) video.play().catch(function() {});
        };
        if (video.readyState >= 1) applySeek();
        else video.addEventListener('loadedmetadata', applySeek, { once: true });
      } else {
        video.play().catch(function() {});
      }
    });

    // ─── Media Session API ─────────────────────────────────────────────
    // Shows the title (and S/E for series) in the browser's media notification
    // (lock screen, media controls, etc.) instead of a generic "MovieBox" label.
    // We also wire up play/pause action handlers so the notification buttons work.
    if ('mediaSession' in navigator) {
      var infoObj = detailState.info || {};
      var baseTitle = infoObj.title || 'MovieBox';
      // For TV series, append "S1 E5" so the notification shows exactly which
      // episode is playing. Movies just show the title.
      var sessionTitle = season ? (baseTitle + ' - S' + season + ' E' + episode) : baseTitle;
      var sessionArtist = season ? ('Season ' + season + ' Episode ' + episode) : 'Movie';
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: sessionTitle,
          artist: sessionArtist,
          album: 'MovieBox',
          artwork: infoObj.cover ? [
            { src: infoObj.cover, sizes: '512x512', type: 'image/jpeg' }
          ] : []
        });
        navigator.mediaSession.setActionHandler('play', function() { video.play().catch(function(){}); });
        navigator.mediaSession.setActionHandler('pause', function() { video.pause(); });
        // Report position state so the notification scrubber works.
        var reportPosition = function() {
          try {
            navigator.mediaSession.setPositionState({
              duration: video.duration || 0,
              playbackRate: video.playbackRate || 1,
              position: Math.min(video.currentTime || 0, video.duration || 0)
            });
          } catch (e) {}
        };
        video.addEventListener('play', reportPosition);
        video.addEventListener('timeupdate', reportPosition);
        video.addEventListener('durationchange', reportPosition);
        if (video.duration) reportPosition();
      } catch (e) {}
    }
  }

  function renderTrailerWhenVisible(trailerUrl) {
    var container = $("#trailer-container");
    if (!container) return;
    function render() {
      container.innerHTML = '<video src="' + escapeHtml(streamProxyUrl(trailerUrl)) + '" controls preload="metadata" playsinline style="width:100%;height:100%"></video>';
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            render();
            io.disconnect();
          }
        });
      }, { rootMargin: "200px" });
      io.observe(container);
    } else {
      render();
    }
  }

  // ---------- Download modal ----------
  function initDownloadModal() {
    var modal = $("#download-modal");
    if (!modal) return;
    $all("[data-close-modal]", modal).forEach(function (b) {
      b.addEventListener("click", closeDownloadModal);
    });
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeDownloadModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDownloadModal();
    });
  }

  function openDownloadModal(title, detailPath, subjectId, season, episode) {
    var modal = $("#download-modal");
    if (!modal) return;
    var displayTitle = season ? (title + " " + seTag(season, episode)) : title;
    $("#download-title").textContent = "Download - " + displayTitle;
    var body = $("#download-body");
    body.innerHTML = '<div class="loading"><div class="spinner"></div>Fetching download links...</div>';
    modal.classList.add("open");
    document.body.style.overflow = "hidden";

    var streamUrl = "/api/" + (season ? "tv" : "movie") + "/" + encodeURIComponent(detailPath);
    if (season) streamUrl += "?season=" + season + "&episode=" + episode;

    // Fetch stream qualities and captions in parallel so we can show both
    // the quality list and the subtitle download section.
    var captionsPromise = api("/api/captions/" + encodeURIComponent(detailPath) + (season ? "?season=" + season + "&episode=" + episode : ""))
      .then(function (d) { return d.captions || []; })
      .catch(function () { return []; });

    Promise.all([
      api(streamUrl),
      captionsPromise,
    ]).then(function (results) {
      var data = results[0];
      var captions = results[1];
      var qualities = (data.qualities || []).filter(function (q) { return q.url; });
      if (qualities.length === 0) {
        body.innerHTML = '<div class="error-box">No downloadable streams found right now. Please try again in a moment.</div>';
        return;
      }
      qualities.sort(function (a, b) { return b.resolution - a.resolution; });

      // Build a poster backdrop header for the modal.
      var cover = (detailState.info && detailState.info.cover) || "";
      var html = ''
        + '<div class="dl-modal-poster" style="background-image:url(\'' + escapeHtml(cover) + '\')">'
        +   '<div class="dl-modal-poster-overlay"></div>'
        +   '<div class="dl-modal-poster-title">' + escapeHtml(displayTitle) + '</div>'
        + '</div>'
        + '<div class="dl-modal-body">';

      // Quality list with file sizes and generous spacing.
      html += '<div class="dl-section-label">Video Quality</div>';
      html += '<div class="download-list">';
      qualities.forEach(function (q, idx) {
        var sizeText = formatFileSize((q.size_mb || 0) * 1024 * 1024);
        if (q.vipLocked) {
          html += ''
            + '<div class="download-row">'
            +   '<div class="download-info">'
            +     '<div class="download-res">' + q.resolution + 'P <span class="vip-tag">VIP</span></div>'
            +     '<div class="download-meta">VIP only</div>'
            +   '</div>'
            +   '<span class="btn btn-ghost btn-sm" style="cursor:not-allowed;opacity:.5">VIP</span>'
            + '</div>';
          return;
        }
        var filename = buildDownloadFilename(title, q.resolution, season, episode);
        var dlUrl = downloadProxyUrl(q.url, filename);
        html += ''
          + '<div class="download-row">'
          +   '<div class="download-info">'
          +     '<div class="download-res">' + q.resolution + 'P</div>'
          +     '<div class="download-meta">' + (sizeText ? escapeHtml(sizeText) : "Download") + '</div>'
          +   '</div>'
          // Use a button with onclick (not an <a href>) so the URL cannot be
          // long-pressed or right-clicked to reveal the download link.
          +   '<button class="btn btn-primary btn-sm dl-trigger" data-url="' + escapeHtml(dlUrl) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg> Download</button>'
          + '</div>';
      });
      html += '</div>';

      // Subtitles section (if any caption URLs are available).
      if (captions && captions.length) {
        html += '<div class="dl-section-label" style="margin-top:24px">Subtitles</div>';
        html += '<div class="download-list">';
        captions.forEach(function (c) {
          var lanName = c.lanName || c.lan || "Subtitle";
          var subUrl = streamProxyUrl(c.url);
          var subFilename = safeName(title) + (season ? "_" + seTag(season, episode) : "") + "_" + safeName(lanName) + ".srt";
          var dlUrl = downloadProxyUrl(c.url, subFilename);
          html += ''
            + '<div class="download-row">'
            +   '<div class="download-info">'
            +     '<div class="download-res">' + escapeHtml(lanName) + '</div>'
            +     '<div class="download-meta">.srt subtitle file</div>'
            +   '</div>'
            +   '<button class="btn btn-secondary btn-sm dl-trigger" data-url="' + escapeHtml(dlUrl) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg> Download</button>'
            + '</div>';
        });
        html += '</div>';
      }

      html += '</div>'; // close dl-modal-body
      body.innerHTML = html;

      // Wire up download triggers. Using window.location.href triggers the
      // browser download (Content-Disposition: attachment) without exposing
      // the URL via a long-pressable <a href> element.
      $all(".dl-trigger", body).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var u = btn.getAttribute("data-url");
          if (!u) return;
          window.location.href = u;
          toast("Download started", "success");
        });
        // Prevent context menu (right-click) on download buttons.
        btn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
      });
    }).catch(function (e) {
      body.innerHTML = '<div class="error-box">Failed to load download links: ' + escapeHtml(e.message) + '</div>';
    });
  }
  function closeDownloadModal() {
    var modal = $("#download-modal");
    if (!modal) return;
    modal.classList.remove("open");
    document.body.style.overflow = "";
    var body = $("#download-body");
    if (body) body.innerHTML = "";
  }

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", function () {
    initHeaderSearch();
    var page = document.body.dataset.page;
    if (page === "home") initHome();
    else if (page === "search") initSearch();
    else if (page === "detail") initDetail();
    else if (page === "player") initPlayer();
  });

  window.MovieBox = { api: api, toast: toast };
})();
