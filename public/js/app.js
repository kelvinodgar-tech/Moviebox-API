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

    // 1. Cover + title + rating + genre + synopsis + action buttons.
    var html = ''
      + '<div class="detail-backdrop-wrap">'
      +   '<div class="detail-backdrop" style="background-image:url(\'' + escapeHtml(info.cover || "") + '\')"></div>'
      +   '<div class="container">'
      +     '<div class="detail-title-block">'
      +       (info.cover ? '<img class="detail-cover-img" src="' + escapeHtml(info.cover) + '" alt="' + escapeHtml(info.title || "") + '" loading="lazy">' : '')
+       '<h1>' + escapeHtml(info.title || "Untitled") + '</h1>'
      +       '<div class="detail-meta">'
      +         '<span class="type-badge">' + (type === "tv" ? "TV Series" : "Movie") + '</span>'
      +         '<span class="rating"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27l5.18 3.12-1.4-5.92 4.6-3.98-6.05-.52L12 4.5 9.67 9.97l-6.05.52 4.6 3.98-1.4 5.92z"/></svg>' + rating + '</span>'
      +         (year ? '<span class="pill">' + year + '</span>' : '')
      +         (info.durationText ? '<span class="pill">' + escapeHtml(info.durationText) + '</span>' : '')
      +         (info.countryName ? '<span class="pill">' + escapeHtml(info.countryName) + '</span>' : '')
      +       '</div>'
      +       (genres.length ? '<div class="detail-genres">' + genres.map(function (g) { return '<span class="genre-tag">' + escapeHtml(g) + '</span>'; }).join("") + '</div>' : '')
      +       '<p class="detail-synopsis">' + escapeHtml(info.description || "No synopsis available.") + '</p>'
      +       '<div class="detail-actions" id="detail-actions"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';

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
      +   '<div class="container player-info-block">'
      +     '<h1 class="player-page-title">' + escapeHtml(info.title || "Untitled") + '</h1>'
      +     '<div class="detail-meta">'
      +       '<span class="type-badge">' + (type === "tv" ? "TV Series" : "Movie") + '</span>'
      +       (season ? '<span class="pill">S' + season + ' E' + episode + '</span>' : '')
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
        loadPlayerStream($("#player-video-wrap"), detailState.currentDubPath || detailState.detailPath, se, ep);
      });
    });
  }

  function loadPlayerStream(wrap, detailPath, season, episode) {
    if (!wrap) return;
    detailState.currentDubPath = detailPath;
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
      buildPlayer(wrap, best, season, episode);
      // Pre-fetch captions in the background so the CC menu shows languages quickly.
      fetchCaptions(detailPath, season, episode).then(function () {
        if (detailState.playerInstance) detailState.playerInstance.refreshCaptions();
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

  function buildPlayer(wrap, quality, season, episode) {
    var info = detailState.info || {};
    var playSrc = streamProxyUrl(quality.url);
    var qualities = detailState.qualities || [];

    var dubs = (info.dubs || []).filter(function (d) { return d.kind === "dub"; });
    // The "Original" dub = the current detailPath (which is the original detailPath unless user picked a different dub).
    // Build the audio menu: include the original track + all dubs.
    var audioOptions = [];
    if (dubs.length === 0 || !dubs.some(function (d) { return d.original; })) {
      audioOptions.push({
        label: "Original",
        detailPath: detailState.detailPath,
        original: true,
        active: detailState.currentDubPath === detailState.detailPath,
      });
    }
    dubs.forEach(function (d) {
      audioOptions.push({
        label: d.lanName || d.lanCode || "Audio",
        detailPath: d.detailPath,
        original: !!d.original,
        active: detailState.currentDubPath === d.detailPath,
      });
    });

    // Player structure:
    //   - video element
    //   - subtitle overlay
    //   - big center play button (visible when paused)
    //   - loading spinner
    //   - play/pause FAB (ALWAYS visible, bottom-left)
    //   - hideable controls bar (progress, volume, time, CC, settings, fullscreen)
    //   - settings menu (quality + audio) and CC menu (subtitles)
    wrap.innerHTML = ''
      + '<div class="vp" id="vp-root">'
      +   '<video id="vp-video" playsinline preload="metadata" src="' + escapeHtml(playSrc) + '"></video>'
      +   '<div class="vp-subs" id="vp-subs"></div>'
      +   '<button class="vp-big-play" id="vp-big-play" aria-label="Play"><svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>'
      +   '<div class="vp-loading" id="vp-loading"></div>'
      // Always-visible play/pause button (separate from the hideable controls).
      +   '<button class="vp-play-fab" id="vp-play-fab" aria-label="Play/Pause"><svg id="vp-fab-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>'
      // Hideable controls bar. Tapping the video toggles this bar.
      +   '<div class="vp-controls" id="vp-controls">'
      +     '<div class="vp-progress" id="vp-progress">'
      +       '<div class="vp-progress-track">'
      +         '<div class="vp-progress-buffered" id="vp-buffered"></div>'
      +         '<div class="vp-progress-filled" id="vp-filled"></div>'
      +       '</div>'
      +       '<div class="vp-progress-thumb" id="vp-thumb"></div>'
      +       '<input type="range" class="vp-progress-input" id="vp-progress-input" min="0" max="1000" value="0" step="1" aria-label="Seek">'
      +     '</div>'
      +     '<div class="vp-controls-row">'
      +       '<div class="vp-volume-wrap">'
      +         '<button class="vp-btn" id="vp-mute" aria-label="Mute"><svg id="vp-mute-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/></svg></button>'
      +         '<div class="vp-volume-bar" id="vp-volume-bar"><div class="vp-volume-bar-fill" id="vp-volume-fill"></div></div>'
      +       '</div>'
      +       '<span class="vp-time" id="vp-time">0:00 / 0:00</span>'
      +       '<div class="vp-spacer"></div>'
      +       '<button class="vp-btn" id="vp-cc" aria-label="Subtitles"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 4H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zM4 18V6h16v12H4zm2-4h6v-1H6v1zm9 0h5v-1h-5v1z"/></svg></button>'
      +       '<button class="vp-btn" id="vp-settings" aria-label="Settings"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94a7.07 7.07 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.03 7.03 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 00-.6.22L2.74 8.84a.5.5 0 00.12.64l2.03 1.58a7.07 7.07 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.6.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54a.5.5 0 00.5.42h3.84a.5.5 0 00.5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96a.5.5 0 00.6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg></button>'
      +       '<button class="vp-btn" id="vp-fs" aria-label="Fullscreen"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>'
      +     '</div>'
      +   '</div>'
      // Settings menu (Quality + Audio language).
      +   '<div class="vp-menu" id="vp-menu-settings">'
      +     '<div class="vp-menu-group">'
      +       '<div class="vp-menu-label">Quality</div>'
      +       qualities.map(function (q) {
                var active = q.resolution === quality.resolution;
                var vip = q.vipLocked;
                var disabled = (!q.url || q.vipLocked);
                return '<button class="vp-menu-item' + (active ? " active" : "") + '"' + (disabled ? " disabled" : "") + ' data-res="' + q.resolution + '">'
                  + '<span class="vp-item-label">' + q.resolution + 'P' + (vip ? ' <span class="vp-tag vip">VIP</span>' : '') + '</span>'
                  + '<svg class="vp-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
                  + '</button>';
              }).join("")
      +     '</div>'
      +     (audioOptions.length > 1
            ? '<div class="vp-menu-group">'
              + '<div class="vp-menu-label">Audio</div>'
              + audioOptions.map(function (a) {
                  return '<button class="vp-menu-item' + (a.active ? " active" : "") + '" data-dub="' + escapeHtml(a.detailPath || "") + '">'
                    + '<span class="vp-item-label">' + escapeHtml(a.label) + (a.original ? ' <span class="vp-tag">ORIG</span>' : '') + '</span>'
                    + '<svg class="vp-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
                    + '</button>';
                }).join("")
              + '</div>'
            : '')
      +   '</div>'
      // CC menu (subtitle languages).
      +   '<div class="vp-menu" id="vp-menu-cc">'
      +     '<div class="vp-menu-group">'
      +       '<div class="vp-menu-label">Subtitles</div>'
      +       '<button class="vp-menu-item active" data-cap=""><span class="vp-item-label">Off</span><svg class="vp-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button>'
      +       '<div id="vp-cc-list"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    detailState.playerInstance = createPlayerInstance(wrap, {
      quality: quality,
      season: season,
      episode: episode,
      audioOptions: audioOptions,
    });
  }

  function createPlayerInstance(wrap, opts) {
    var root = $("#vp-root", wrap);
    var video = $("#vp-video", wrap);
    var bigPlay = $("#vp-big-play", wrap);
    var playFab = $("#vp-play-fab", wrap);
    var playFabIcon = $("#vp-fab-icon", wrap);
    var muteBtn = $("#vp-mute", wrap);
    var muteIcon = $("#vp-mute-icon", wrap);
    var volumeBar = $("#vp-volume-bar", wrap);
    var volumeFill = $("#vp-volume-fill", wrap);
    var timeEl = $("#vp-time", wrap);
    var progress = $("#vp-progress", wrap);
    var progressInput = $("#vp-progress-input", wrap);
    var filled = $("#vp-filled", wrap);
    var buffered = $("#vp-buffered", wrap);
    var thumb = $("#vp-thumb", wrap);
    var subsEl = $("#vp-subs", wrap);
    var ccBtn = $("#vp-cc", wrap);
    var settingsBtn = $("#vp-settings", wrap);
    var fsBtn = $("#vp-fs", wrap);
    var menuSettings = $("#vp-menu-settings", wrap);
    var menuCC = $("#vp-menu-cc", wrap);
    var ccList = $("#vp-cc-list", wrap);

    var PLAY_SVG = '<path d="M8 5v14l11-7z"/>';
    var PAUSE_SVG = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    var VOL_FULL_SVG = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/>';
    var VOL_MUTE_SVG = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.03zM4 18h4l5 5V9.18l-5 5H4V18zM14 3.23v2.06a7 7 0 010 13.42v2.06A9 9 0 0014 3.23z"/>';

    var idleTimer = null;
    var seeking = false;

    function setIdle(isIdle) {
      if (isIdle) root.classList.add("idle");
      else root.classList.remove("idle");
      clearTimeout(idleTimer);
      if (!isIdle && !video.paused) {
        idleTimer = setTimeout(function () { setIdle(true); }, 2800);
      }
    }
    function setPlaying(isPlaying) {
      if (isPlaying) root.classList.add("vp-playing");
      else root.classList.remove("vp-playing");
      playFabIcon.innerHTML = isPlaying ? PAUSE_SVG : PLAY_SVG;
      bigPlay.classList.toggle("hidden", isPlaying);
    }
    function formatTime(s) {
      if (!isFinite(s) || s < 0) s = 0;
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = Math.floor(s % 60);
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      if (h > 0) return h + ":" + pad(m) + ":" + pad(sec);
      return m + ":" + pad(sec);
    }
    function updateProgress() {
      var dur = video.duration || 0;
      var cur = video.currentTime || 0;
      var pct = dur > 0 ? (cur / dur) * 100 : 0;
      filled.style.width = pct + "%";
      thumb.style.left = pct + "%";
      timeEl.textContent = formatTime(cur) + " / " + formatTime(dur);
      if (!seeking) progressInput.value = Math.round(pct * 10);
    }
    function updateBuffered() {
      var dur = video.duration || 0;
      if (!dur || !video.buffered || !video.buffered.length) return;
      var end = video.buffered.end(video.buffered.length - 1);
      var pct = (end / dur) * 100;
      buffered.style.width = pct + "%";
    }
    function setVolume(v) {
      v = Math.max(0, Math.min(1, v));
      video.volume = v;
      video.muted = v === 0;
      volumeFill.style.width = (v * 100) + "%";
      muteIcon.innerHTML = v === 0 ? VOL_MUTE_SVG : VOL_FULL_SVG;
    }
    function play() {
      if (video.paused) video.play().catch(function () {});
    }
    function togglePlay() {
      if (video.paused) video.play().catch(function () {});
      else video.pause();
    }
    function toggleFullscreen() {
      var d = document;
      var isFs = d.fullscreenElement || d.webkitFullscreenElement;
      if (!isFs) {
        if (root.requestFullscreen) root.requestFullscreen();
        else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      } else {
        if (d.exitFullscreen) d.exitFullscreen();
        else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
      }
    }

    function closeAllMenus() {
      menuSettings.classList.remove("open");
      menuCC.classList.remove("open");
    }
    function toggleMenu(menu) {
      var willOpen = !menu.classList.contains("open");
      closeAllMenus();
      if (willOpen) menu.classList.add("open");
    }

    // --- Render the CC list (called whenever captions change ---
    function refreshCaptions() {
      if (!ccList) return;
      var caps = detailState.captions || [];
      ccList.innerHTML = caps.map(function (c) {
        var active = detailState.activeCaption && detailState.activeCaption.url === c.url;
        return '<button class="vp-menu-item' + (active ? " active" : "") + '" data-cap="' + escapeHtml(c.url || "") + '" data-lan="' + escapeHtml(c.lan || c.lanName || "") + '">'
          + '<span class="vp-item-label">' + escapeHtml(c.lanName || c.lan || "Subtitle") + '</span>'
          + '<svg class="vp-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
          + '</button>';
      }).join("");
      // Wire click handlers.
      $all(".vp-menu-item[data-cap]", ccList).forEach(function (b) {
        b.addEventListener("click", function () {
          var url = b.getAttribute("data-cap");
          var lan = b.getAttribute("data-lan");
          selectCaption(url, lan);
          closeAllMenus();
        });
      });
      // Update the "Off" item active state.
      var offItem = menuCC.querySelector('.vp-menu-item[data-cap=""]');
      if (offItem) offItem.classList.toggle("active", !detailState.activeCaption);
    }

    function selectCaption(url, lan) {
      // "Off" clicked
      if (!url) {
        detailState.activeCaption = null;
        detailState.subtitleCues = null;
        subsEl.innerHTML = "";
        ccBtn.classList.remove("active");
        refreshCaptions();
        return;
      }
      var cap = (detailState.captions || []).find(function (c) { return c.url === url; });
      if (!cap) return;
      detailState.activeCaption = cap;
      ccBtn.classList.add("active");
      subsEl.innerHTML = "";
      // Fetch the .srt file via the stream proxy and parse it.
      fetch(streamProxyUrl(cap.url))
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
        .then(function (txt) {
          var cues = parseSRT(txt);
          detailState.subtitleCues = cues;
          refreshCaptions();
          toast("Subtitles on: " + (cap.lanName || lan || ""), "success");
        })
        .catch(function (e) {
          detailState.subtitleCues = null;
          toast("Failed to load subtitle: " + e.message, "error");
        });
    }

    function updateSubtitle() {
      if (!detailState.subtitleCues || !detailState.subtitleCues.length) {
        subsEl.innerHTML = "";
        return;
      }
      var cue = findCueAt(detailState.subtitleCues, video.currentTime);
      if (!cue) { subsEl.innerHTML = ""; return; }
      // Render each line as a separate span for readability.
      var lines = cue.text.split("\n");
      subsEl.innerHTML = lines.map(function (l) {
        return '<span class="vp-sub-line">' + escapeHtml(l) + '</span>';
      }).join("");
    }

    // --- Wire up events ---
    video.addEventListener("play", function () { setPlaying(true); setIdle(false); });
    video.addEventListener("pause", function () { setPlaying(false); setIdle(false); });
    video.addEventListener("ended", function () { setPlaying(false); setIdle(false); });
    video.addEventListener("loadedmetadata", updateProgress);
    video.addEventListener("timeupdate", function () { updateProgress(); updateSubtitle(); });
    video.addEventListener("progress", updateBuffered);
    video.addEventListener("waiting", function () { root.classList.add("loading"); });
    video.addEventListener("playing", function () { root.classList.remove("loading"); });
    video.addEventListener("canplay", function () { root.classList.remove("loading"); });
    video.addEventListener("volumechange", function () {
      volumeFill.style.width = (video.muted ? 0 : video.volume * 100) + "%";
      muteIcon.innerHTML = (video.muted || video.volume === 0) ? VOL_MUTE_SVG : VOL_FULL_SVG;
    });

    bigPlay.addEventListener("click", function (e) { e.stopPropagation(); togglePlay(); });
    playFab.addEventListener("click", function (e) { e.stopPropagation(); togglePlay(); });
    fsBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleFullscreen(); });
    ccBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleMenu(menuCC); });
    settingsBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleMenu(menuSettings); });

    // Click outside menus closes them.
    document.addEventListener("click", function (e) {
      var onSettings = settingsBtn.contains(e.target) || menuSettings.contains(e.target);
      var onCC = ccBtn.contains(e.target) || menuCC.contains(e.target);
      if (!onSettings) menuSettings.classList.remove("open");
      if (!onCC) menuCC.classList.remove("open");
    });

    // Quality selection inside settings menu.
    $all(".vp-menu-item[data-res]", menuSettings).forEach(function (b) {
      if (b.disabled) return;
      b.addEventListener("click", function () {
        var res = parseInt(b.getAttribute("data-res"), 10);
        var q = (detailState.qualities || []).find(function (x) { return x.resolution === res; });
        if (!q || !q.url) return;
        switchQuality(q);
        closeAllMenus();
      });
    });

    // Audio (dub) selection inside settings menu.
    $all(".vp-menu-item[data-dub]", menuSettings).forEach(function (b) {
      b.addEventListener("click", function () {
        var dubPath = b.getAttribute("data-dub");
        if (!dubPath || dubPath === detailState.currentDubPath) { closeAllMenus(); return; }
        closeAllMenus();
        switchDub(dubPath);
      });
    });

    function switchQuality(q) {
      var t = video.currentTime;
      var wasPlaying = !video.paused;
      video.src = streamProxyUrl(q.url);
      video.load();
      video.addEventListener("loadedmetadata", function onMeta() {
        video.removeEventListener("loadedmetadata", onMeta);
        try { video.currentTime = t; } catch (e) {}
        if (wasPlaying) video.play().catch(function () {});
      });
      detailState.currentQuality = q;
      // Update active markers.
      $all(".vp-menu-item[data-res]", menuSettings).forEach(function (b) {
        b.classList.toggle("active", parseInt(b.getAttribute("data-res"), 10) === q.resolution);
      });
      toast("Quality: " + q.resolution + "P", "success");
    }

    function switchDub(dubPath) {
      // Re-fetch the stream URLs for the new dub's detailPath.
      var season = opts.season;
      var episode = opts.episode;
      var url = "/api/" + (season ? "tv" : "movie") + "/" + encodeURIComponent(dubPath);
      if (season) url += "?season=" + season + "&episode=" + episode;
      root.classList.add("loading");
      api(url).then(function (data) {
        var qualities = data.qualities || [];
        var best = data.best_free || qualities.filter(function (q) { return q.url && !q.vipLocked; }).sort(function (a, b) { return b.resolution - a.resolution; })[0];
        if (!best || !best.url) {
          root.classList.remove("loading");
          toast("No stream for that audio language.", "error");
          return;
        }
        detailState.qualities = qualities;
        detailState.currentDubPath = dubPath;
        // Reset captions since they belong to the previous dub.
        detailState.captions = null;
        detailState.activeCaption = null;
        detailState.subtitleCues = null;
        subsEl.innerHTML = "";
        ccBtn.classList.remove("active");
        // Rebuild the settings menu (quality + audio) so the new dub is marked active.
        rebuildSettingsMenu();
        switchQuality(best);
        // Pre-fetch captions for the new dub.
        fetchCaptions(dubPath, season, episode).then(function () {
          refreshCaptions();
        });
      }).catch(function (e) {
        root.classList.remove("loading");
        toast("Failed to switch audio: " + e.message, "error");
      });
    }

    function rebuildSettingsMenu() {
      var info = detailState.info || {};
      var dubs = (info.dubs || []).filter(function (d) { return d.kind === "dub"; });
      var audioOptions = [];
      if (dubs.length === 0 || !dubs.some(function (d) { return d.original; })) {
        audioOptions.push({
          label: "Original",
          detailPath: detailState.detailPath,
          original: true,
          active: detailState.currentDubPath === detailState.detailPath,
        });
      }
      dubs.forEach(function (d) {
        audioOptions.push({
          label: d.lanName || d.lanCode || "Audio",
          detailPath: d.detailPath,
          original: !!d.original,
          active: detailState.currentDubPath === d.detailPath,
        });
      });

      // Rebuild quality items.
      var qGroup = menuSettings.querySelector(".vp-menu-group");
      // The quality group is the first one.
      var groups = menuSettings.querySelectorAll(".vp-menu-group");
      var firstGroup = groups[0];
      var qualityHTML = '<div class="vp-menu-label">Quality</div>';
      (detailState.qualities || []).forEach(function (q) {
        var active = detailState.currentQuality && q.resolution === detailState.currentQuality.resolution;
        var vip = q.vipLocked;
        var disabled = (!q.url || q.vipLocked);
        qualityHTML += '<button class="vp-menu-item' + (active ? " active" : "") + '"' + (disabled ? " disabled" : "") + ' data-res="' + q.resolution + '">'
          + '<span class="vp-item-label">' + q.resolution + 'P' + (vip ? ' <span class="vp-tag vip">VIP</span>' : '') + '</span>'
          + '<svg class="vp-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
          + '</button>';
      });
      firstGroup.innerHTML = qualityHTML;
      // Re-wire quality click handlers.
      $all(".vp-menu-item[data-res]", firstGroup).forEach(function (b) {
        if (b.disabled) return;
        b.addEventListener("click", function () {
          var res = parseInt(b.getAttribute("data-res"), 10);
          var q = (detailState.qualities || []).find(function (x) { return x.resolution === res; });
          if (!q || !q.url) return;
          switchQuality(q);
          closeAllMenus();
        });
      });

      // Rebuild audio group (second group).
      if (groups.length > 1) {
        var audioGroup = groups[1];
        var audioHTML = '<div class="vp-menu-label">Audio</div>';
        audioOptions.forEach(function (a) {
          audioHTML += '<button class="vp-menu-item' + (a.active ? " active" : "") + '" data-dub="' + escapeHtml(a.detailPath || "") + '">'
            + '<span class="vp-item-label">' + escapeHtml(a.label) + (a.original ? ' <span class="vp-tag">ORIG</span>' : '') + '</span>'
            + '<svg class="vp-check" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            + '</button>';
        });
        audioGroup.innerHTML = audioHTML;
        $all(".vp-menu-item[data-dub]", audioGroup).forEach(function (b) {
          b.addEventListener("click", function () {
            var dubPath = b.getAttribute("data-dub");
            if (!dubPath || dubPath === detailState.currentDubPath) { closeAllMenus(); return; }
            closeAllMenus();
            switchDub(dubPath);
          });
        });
      }
    }

    // Progress bar seeking.
    function seekFromEvent(e) {
      var rect = progress.getBoundingClientRect();
      var x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      var pct = Math.max(0, Math.min(1, x / rect.width));
      if (video.duration) video.currentTime = pct * video.duration;
    }
    progressInput.addEventListener("input", function () {
      seeking = true;
      // progressInput is a 0-1000 range, so divide by 10 to get a 0-100 percent.
      var pct = parseFloat(progressInput.value) / 10;
      filled.style.width = pct + "%";
      thumb.style.left = pct + "%";
      if (video.duration) {
        timeEl.textContent = formatTime((pct / 100) * video.duration) + " / " + formatTime(video.duration);
      }
    });
    progressInput.addEventListener("change", function () {
      var pct = parseFloat(progressInput.value) / 10;
      if (video.duration) video.currentTime = (pct / 100) * video.duration;
      seeking = false;
    });

    // Volume bar.
    volumeBar.addEventListener("click", function (e) {
      var rect = volumeBar.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var v = Math.max(0, Math.min(1, x / rect.width));
      setVolume(v);
    });
    muteBtn.addEventListener("click", function () {
      if (video.muted || video.volume === 0) setVolume(1);
      else setVolume(0);
    });

    // Idle / show controls on mouse move.
    root.addEventListener("mousemove", function () { setIdle(false); });
    root.addEventListener("click", onVideoTap);

    // TAP behavior: tapping the video toggles the control bar visibility
    // (show/hide). It does NOT toggle play/pause. The play/pause FAB is
    // always visible so the user can pause/resume at any time.
    function onVideoTap(e) {
      // Ignore taps that originate from controls, menus, or buttons.
      var target = e.target;
      // Accept taps on the video, the vp-root, the subs overlay, the loading spinner, or the big-play area.
      // But NOT on the controls bar, menus, or any buttons.
      if (target === video || target === root || target.id === "vp-subs" || target.id === "vp-loading" || target.classList.contains("vp-subs")) {
        e.preventDefault();
        // Toggle the idle state (which shows/hides the hideable controls bar).
        var willHide = !root.classList.contains("idle") && !video.paused;
        setIdle(willHide);
      }
    }
    video.addEventListener("click", onVideoTap);
    // On touch devices, a touchend without movement triggers the tap.
    var touchStartX = 0, touchStartY = 0, touchMoved = false;
    video.addEventListener("touchstart", function (e) {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchMoved = false;
      }
    }, { passive: true });
    video.addEventListener("touchmove", function (e) {
      if (e.touches.length === 1) {
        var dx = Math.abs(e.touches[0].clientX - touchStartX);
        var dy = Math.abs(e.touches[0].clientY - touchStartY);
        if (dx > 8 || dy > 8) touchMoved = true;
      }
    }, { passive: true });
    video.addEventListener("touchend", function (e) {
      if (!touchMoved) {
        onVideoTap(e);
      }
    }, { passive: false });

    // Keyboard shortcuts (when player is in viewport).
    root.tabIndex = 0;
    root.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight") { video.currentTime = Math.min((video.currentTime || 0) + 10, video.duration || 0); }
      else if (e.key === "ArrowLeft") { video.currentTime = Math.max((video.currentTime || 0) - 10, 0); }
      else if (e.key === "f") { toggleFullscreen(); }
      else if (e.key === "m") { if (video.muted || video.volume === 0) setVolume(1); else setVolume(0); }
      else if (e.key === "c") { toggleMenu(menuCC); }
    });

    // Initial state.
    setVolume(1);
    setPlaying(false);
    updateProgress();

    // Autoplay (muted first to satisfy browsers, then try with sound).
    video.muted = false;
    var playPromise = video.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(function () {
        // Autoplay with sound blocked. Try muted.
        video.muted = true;
        video.play().catch(function () {}).then(function () {
          // Show a hint that we're muted.
          if (video.muted) toast("Tap to unmute", "success");
        });
      });
    }

    return {
      play: play,
      pause: function () { video.pause(); },
      refreshCaptions: refreshCaptions,
      destroy: function () {
        video.pause();
        video.src = "";
      },
    };
  }

  // ---------- Inline trailer (lazy) ----------
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
