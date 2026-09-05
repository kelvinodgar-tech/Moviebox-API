/* =========================================================
   MovieBox Clone - Frontend application logic
   Base API: same origin /api/... (also works on Vercel)
   ========================================================= */

(function () {
  "use strict";

  // Resolve API base. On Vercel the site and API share the same origin,
  // so relative "/api/..." works. For local file:// testing, allow override.
  var API_BASE = window.MOVIEBOX_API_BASE || "";

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
  function fmtDuration(sec) {
    sec = parseInt(sec) || 0;
    if (!sec) return "";
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function api(path) {
    return fetch(API_BASE + path).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  // Build a proxied media URL. The CDN (bcdnxw.hakunaymatata.com) requires a
  // Referer header and returns 429 without it, so a browser <video> tag cannot
  // play the raw MP4. /api/stream adds the header server-side.
  function streamProxyUrl(mediaUrl) {
    if (!mediaUrl) return "";
    var base = API_BASE || "";
    return base + "/api/stream?url=" + encodeURIComponent(mediaUrl);
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

  // ---------- Card rendering ----------
  function posterFallback() {
    return '<div class="card-poster-fallback">No cover</div>';
  }
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
    var year = (item.releaseDate || "").slice(0, 4);
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
      +     (cover
          ? '<img loading="lazy" decoding="async" src="' + escapeHtml(cover) + '" alt="' + title + '" onerror="this.style.display=\'none\';this.parentElement.innerHTML+=\'' + posterFallback().replace(/'/g, "\\'") + '\'">'
          : posterFallback())
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
    container.innerHTML = items.map(cardHTML).join("");
  }

  // ---------- Header search wiring ----------
  function initHeaderSearch() {
    var input = $("#site-search");
    if (!input) return;
    var form = input.closest("form") || input.parentElement;

    // Autocomplete dropdown (debounced, calls /api/search-suggest via our API).
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
        // /api/search returns suggestions in its response; we use the small
        // ?limit=1 variant to keep the payload tiny.
        fetch(API_BASE + "/api/search?q=" + encodeURIComponent(q) + "&limit=1")
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (d && d.suggestions) showSuggestions(d.suggestions); })
          .catch(function () {});
      }, 220);
    });
    input.addEventListener("blur", function () {
      // Delay so a click on an item registers first.
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
    // Prefill on search page
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
      // Preload the first hero image so it paints immediately.
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
        var year = (it.releaseDate || "").slice(0, 4);
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
        return '<span class="hero-dot' + (i === 0 ? " active" : "") + '" data-i="' + i + '"></span>';
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

    function renderSections(sections) {
      var valid = sections.filter(function (s) { return s.items && s.items.length; });
      if (!valid.length) {
        sectionsWrap.innerHTML = '';
        return;
      }
      // Mobile performance: only render the first INITIAL_SECTIONS up front.
      // The rest are rendered lazily when a sentinel scrolls into view.
      var isMobile = window.matchMedia("(max-width: 767px)").matches;
      var INITIAL_SECTIONS = isMobile ? 5 : valid.length;
      var queued = valid.slice(INITIAL_SECTIONS);

      function sectionHTML(s, lazy) {
        return ''
          + '<section class="section' + (lazy ? " lazy-section" : "") + '">'
          +   '<div class="section-head"><h3 class="section-title">' + escapeHtml(s.title) + '</h3></div>'
          +   '<div class="grid">' + s.items.map(cardHTML).join("") + '</div>'
          + '</section>';
      }

      sectionsWrap.innerHTML = valid.slice(0, INITIAL_SECTIONS).map(function (s) {
        return sectionHTML(s, false);
      }).join("");

      // No queue -> done.
      if (!queued.length) return;

      // Add a sentinel + a "Load more" button (the button is a fallback for
      // browsers without IntersectionObserver, and for users who prefer to
      // control loading).
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
        // Defer to next frame so the spinner can paint.
        requestAnimationFrame(function () {
          var batch = queued.splice(0, 3);
          var frag = document.createDocumentFragment();
          batch.forEach(function (s) {
            var wrap = el("div", { html: sectionHTML(s, true) });
            while (wrap.firstChild) frag.appendChild(wrap.firstChild);
          });
          sectionsWrap.insertBefore(frag, sentinel);
          // Reveal lazily-rendered sections.
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

      // Auto-load when the sentinel scrolls into view.
      if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) loadNextBatch();
          });
        }, { rootMargin: "300px" });
        io.observe(sentinel);
      }
    }

    // Load trending
    trendingGrid.innerHTML = skeletonCards(10);
    api("/api/trending?limit=20").then(function (data) {
      renderGrid(trendingGrid, data.items || []);
    }).catch(function (e) {
      trendingGrid.innerHTML = '<div class="error-box" style="grid-column:1/-1">Failed to load trending: ' + escapeHtml(e.message) + '</div>';
    });

    // Load home content (banners + sections)
    api("/api/home").then(function (data) {
      renderHero(data.banners || []);
      renderSections(data.sections || []);
    }).catch(function (e) {
      sectionsWrap.innerHTML = '<div class="error-box">Failed to load home content: ' + escapeHtml(e.message) + '</div>';
    });
  }

  // ---------- Page: search ----------
  var searchState = { q: "", page: 1, limit: 20, total: 0, loading: false };

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
    searchState.page = 1;
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
    var suggestEl = $("#search-suggestions");
    var isFirst = searchState.page === 1;
    if (isFirst) grid.innerHTML = skeletonCards(12);

    var url = "/api/search?q=" + encodeURIComponent(searchState.q)
      + "&limit=" + searchState.limit + "&page=" + searchState.page;
    api(url).then(function (data) {
      searchState.total = data.total || 0;
      var results = data.results || [];
      var suggestions = data.suggestions || [];

      titleEl.innerHTML = 'Results for <span style="color:var(--accent)">' + escapeHtml(searchState.q) + '</span>'
        + ' <span class="text-muted">(' + searchState.total + ' found' + (data.sources ? '; home ' + (data.sources.home||0) + ' + trending ' + (data.sources.trending||0) : '') + ')</span>';

      // Suggestions (autocomplete from the backend).
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

      if (isFirst) {
        renderGrid(grid, results);
      } else {
        // Append to existing grid.
        if (results.length) grid.insertAdjacentHTML("beforeend", results.map(cardHTML).join(""));
      }

      // "Load more" button.
      var existing = $("#search-load-more");
      if (existing) existing.parentNode.removeChild(existing);
      if (data.hasMore && results.length) {
        var wrap = el("div", { id: "search-load-more", style: "grid-column:1/-1;display:flex;justify-content:center;padding:20px 0" });
        var btn = el("button", {
          class: "btn btn-ghost",
          text: "Load more (" + (searchState.total - (searchState.page * searchState.limit)) + " left)",
          onclick: function () {
            searchState.page++;
            loadSearchPage();
          }
        });
        wrap.appendChild(btn);
        grid.appendChild(wrap);
      }

      if (isFirst && results.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 21l-4.35-4.35M11 19a8 8 0 110-16 8 8 0 010 16z"/></svg><div>No titles found for " ' + escapeHtml(searchState.q) + ' ". Try a different keyword.</div></div>';
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
    qualities: null,
    selectedQuality: null,
  };

  function initDetail() {
    var params = new URLSearchParams(window.location.search);
    var path = params.get("path");
    if (!path) {
      $("#detail-root").innerHTML = '<div class="error-box">No title specified.</div>';
      return;
    }
    detailState.detailPath = path;
    loadDetail(path);
    initPlayerModal();
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
    var year = (info.releaseDate || "").slice(0, 4);

    var facts = [];
    if (year) facts.push(["Release", year]);
    if (info.durationText) facts.push(["Duration", info.durationText]);
    if (info.countryName) facts.push(["Country", info.countryName]);
    if (info.imdbRatingCount) facts.push(["IMDB Votes", Number(info.imdbRatingCount).toLocaleString()]);
    if (info.subtitles) facts.push(["Subtitles", info.subtitles.split(",").slice(0, 4).join(", ") + (info.subtitles.split(",").length > 4 ? "..." : "")]);
    if (info.castCount != null) facts.push(["Cast", info.castCount + " people"]);

    var html = ''
      + '<div class="detail-hero">'
      +   '<div class="detail-backdrop" style="background-image:url(\'' + escapeHtml(info.cover || "") + '\')"></div>'
      +   '<div class="container">'
      +     '<div class="detail-grid">'
      +       '<div class="detail-poster">'
      +         (info.cover ? '<img loading="lazy" decoding="async" src="' + escapeHtml(info.cover) + '" alt="' + escapeHtml(info.title) + '">' : posterFallback())
      +       '</div>'
      +       '<div class="detail-info">'
      +         '<h1>' + escapeHtml(info.title || "Untitled") + '</h1>'
      +         '<div class="detail-meta">'
      +           '<span class="type-badge">' + (type === "tv" ? "TV Series" : "Movie") + '</span>'
      +           '<span class="rating"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27l5.18 3.12-1.4-5.92 4.6-3.98-6.05-.52L12 4.5 9.67 9.97l-6.05.52 4.6 3.98-1.4 5.92z"/></svg>' + rating + '</span>'
      +           (year ? '<span class="pill">' + year + '</span>' : '')
      +           (info.durationText ? '<span class="pill">' + escapeHtml(info.durationText) + '</span>' : '')
      +           (info.countryName ? '<span class="pill">' + escapeHtml(info.countryName) + '</span>' : '')
      +         '</div>'
      +         (genres.length ? '<div class="detail-genres">' + genres.map(function (g) { return '<span class="genre-tag">' + escapeHtml(g) + '</span>'; }).join("") + '</div>' : '')
      +         '<p class="detail-synopsis">' + escapeHtml(info.description || "No synopsis available.") + '</p>'
      +         (facts.length ? '<div class="detail-facts">' + facts.map(function (f) {
              return '<div class="fact"><span class="fact-label">' + escapeHtml(f[0]) + '</span><span class="fact-value">' + escapeHtml(f[1]) + '</span></div>';
            }).join("") + '</div>' : '')
      +         '<div class="detail-actions" id="detail-actions"></div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>';

    // TV: seasons + episodes
    if (type === "tv" && detailState.seasons && detailState.seasons.seasons && detailState.seasons.seasons.length) {
      detailState.currentSeason = detailState.seasons.seasons[0].season;
      html += '<div class="container">'
        + '<section class="section">'
        +   '<div class="section-head"><h3 class="section-title">Episodes <span class="accent">- Season ' + detailState.currentSeason + '</span></h3></div>'
        +   '<div class="season-bar" id="season-bar"></div>'
        +   '<div class="episode-list" id="episode-list"></div>'
        + '</section>';
    } else if (type === "tv") {
      html += '<div class="container"><section class="section"><div class="empty-state">No season information available for this title.</div></section>';
    }

    // Cast
    if (info.cast && info.cast.length) {
      html += '<div class="container">'
        + '<section class="section">'
        +   '<div class="section-head"><h3 class="section-title">Cast &amp; Crew <span class="accent">(' + info.cast.length + ')</span></h3></div>'
        +   '<div class="cast-grid">' + info.cast.slice(0, 24).map(function (c) {
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
        + '</section>';
    }

    html += '</div>'; // close container
    root.innerHTML = html;

    // Wire up actions
    wireDetailActions();

    // Wire up season selector for TV
    if (type === "tv" && detailState.seasons && detailState.seasons.seasons) {
      wireSeasons();
      renderEpisodes(detailState.currentSeason);
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
        if (type === "movie") {
          openPlayerModal(info.title, info.detailPath, info.subjectId, 0, 0);
        } else {
          // scroll to episodes
          var ep = $("#episode-list");
          if (ep) ep.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
    var dlBtn = el("button", {
      class: "btn btn-secondary",
      html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg> Download',
      onclick: function () {
        if (type === "movie") {
          openDownloadModal(info.title, info.detailPath, info.subjectId, 0, 0);
        } else {
          var ep = $("#episode-list");
          if (ep) ep.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
    box.appendChild(watchBtn);
    box.appendChild(dlBtn);

    if (info.trailer && info.trailer.url) {
      var trailerBtn = el("button", {
        class: "btn btn-ghost",
        html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h10v2H4zm0 5h16v2H4zm14-9l4 4-4 4z"/></svg> Trailer',
        onclick: function () { openTrailerModal(info.title, info.trailer.url); }
      });
      box.appendChild(trailerBtn);
    }
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
        $all(".season-btn", bar).forEach(function (x) { x.classList.toggle("active", x === b); });
        renderEpisodes(detailState.currentSeason);
        // update section title
        var st = $(".section-title");
        if (st) st.innerHTML = 'Episodes <span class="accent">- Season ' + detailState.currentSeason + '</span>';
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
      return;
    }
    var html = "";
    for (var ep = 1; ep <= maxEp; ep++) {
      html += ''
        + '<div class="episode-card">'
        +   '<div class="episode-num">' + ep + '</div>'
        +   '<div class="episode-body">'
        +     '<div class="episode-title">Episode ' + ep + '</div>'
        +     '<div class="episode-sub">Season ' + season + ' - Episode ' + ep + '</div>'
        +   '</div>'
        +   '<div class="episode-actions">'
        +     '<button class="btn btn-ghost btn-sm ep-watch" data-se="' + season + '" data-ep="' + ep + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Watch</button>'
        +     '<button class="btn btn-ghost btn-sm ep-dl" data-se="' + season + '" data-ep="' + ep + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg></button>'
        +   '</div>'
        + '</div>';
    }
    list.innerHTML = html;
    $all(".ep-watch", list).forEach(function (b) {
      b.addEventListener("click", function () {
        openPlayerModal(detailState.info.title, detailState.info.detailPath, detailState.info.subjectId,
          parseInt(b.dataset.se), parseInt(b.dataset.ep));
      });
    });
    $all(".ep-dl", list).forEach(function (b) {
      b.addEventListener("click", function () {
        openDownloadModal(detailState.info.title + " S" + b.dataset.se + "E" + b.dataset.ep,
          detailState.info.detailPath, detailState.info.subjectId,
          parseInt(b.dataset.se), parseInt(b.dataset.ep));
      });
    });
  }

  // ---------- Player & Download modals ----------
  function initPlayerModal() {
    var modal = $("#player-modal");
    if (!modal) return;
    $all("[data-close-modal]", modal).forEach(function (b) {
      b.addEventListener("click", closePlayerModal);
    });
    modal.addEventListener("click", function (e) { if (e.target === modal) closePlayerModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closePlayerModal();
        closeDownloadModal();
        closeTrailerModal();
      }
    });
  }

  function openPlayerModal(title, detailPath, subjectId, season, episode) {
    var modal = $("#player-modal");
    $("#player-title").textContent = title + (season ? " S" + season + "E" + episode : "");
    var body = $("#player-body");
    body.innerHTML = '<div class="loading"><div class="spinner"></div>Fetching streams...</div>';
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
    // On mobile the modal is full-screen; scroll the content to the top so
    // the video is immediately visible.
    body.scrollTop = 0;
    if (body.scrollTo) body.scrollTo(0, 0);

    var url = "/api/" + (season ? "tv" : "movie") + "/" + encodeURIComponent(detailPath);
    if (season) url += "?season=" + season + "&episode=" + episode;

    api(url).then(function (data) {
      detailState.qualities = data.qualities || [];
      var best = data.best_free || (detailState.qualities.filter(function (q) { return q.url && !q.vipLocked; }).sort(function (a, b) { return b.resolution - a.resolution; })[0]);
      if (!best || !best.url) {
        body.innerHTML = '<div class="error-box">No playable stream found right now. The source may be rate-limited - wait 2-3 minutes and try again.</div>';
        return;
      }
      detailState.selectedQuality = best;
      renderPlayer(title, best, season, episode);
    }).catch(function (e) {
      body.innerHTML = '<div class="error-box">Failed to load stream: ' + escapeHtml(e.message) + '</div>';
    });
  }

  function renderPlayer(title, quality, season, episode) {
    var body = $("#player-body");
    var qualities = detailState.qualities || [];
    var qButtons = qualities.map(function (q) {
      var active = q.resolution === quality.resolution ? " active" : "";
      var vip = q.vipLocked ? " vip" : "";
      var disabled = (!q.url || q.vipLocked) ? " disabled" : "";
      return '<button class="quality-btn' + active + vip + '"' + disabled + ' data-res="' + q.resolution + '">' + q.resolution + 'P' + (q.vipLocked ? ' <span class="vip-tag">VIP</span>' : '') + '</button>';
    }).join("");

    // Route the MP4 through /api/stream so the browser can play it (the CDN
    // requires a Referer header and returns 429 without it).
    var playSrc = streamProxyUrl(quality.url);
    var directUrl = quality.url;
    body.innerHTML = ''
      + '<div class="player-video"><video id="player-video-el" src="' + escapeHtml(playSrc) + '" controls autoplay playsinline></video></div>'
      + '<div class="quality-bar">'
      +   '<span class="quality-label">Quality:</span>'
      +   qButtons
      + '</div>'
      + '<div class="text-muted mt-4" style="font-size:13px">Now playing: ' + escapeHtml(title) + (season ? ' S' + season + 'E' + episode : '') + ' at ' + quality.resolution + 'P' + (quality.size_mb ? ' (' + quality.size_mb + ' MB)' : '') + '</div>'
      + '<div id="player-fallback" class="error-box" style="display:none;margin-top:12px"></div>';

    // Detect proxy/CDN rejection (426/429) and show a helpful fallback.
    var vidEl = $("video", body);
    if (vidEl) {
      var fallbackShown = false;
      function showFallback(msg) {
        if (fallbackShown) return;
        fallbackShown = true;
        var fb = $("#player-fallback", body);
        if (fb) {
          fb.style.display = "";
          fb.innerHTML = '<div style="margin-bottom:8px">' + escapeHtml(msg) + '</div>'
            + '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">The video CDN (bcdnxw.hakunaymatata.com) rejects browser and cloud-IP requests without a Referer header. Run the Python scraper locally to download this file, or use curl:</div>'
            + '<code style="display:block;background:#000;padding:8px;border-radius:4px;font-size:11px;word-break:break-all">curl -H "Referer: https://netnaija.film/" -O "' + escapeHtml(directUrl) + '"</code>';
        }
      }
      vidEl.addEventListener("error", function () {
        // Check the proxy URL to see if it returned an error status.
        fetch(playSrc, { method: "HEAD" }).then(function (r) {
          if (r.status === 426 || r.status === 429 || r.status === 403) {
            showFallback("This video cannot be played in the browser (CDN returned " + r.status + ").");
          } else if (!r.ok) {
            showFallback("Playback failed (HTTP " + r.status + "). Try again in a moment.");
          }
        }).catch(function () {
          showFallback("Playback failed. The CDN may be rate-limiting this IP.");
        });
      });
    }

    $all(".quality-btn", body).forEach(function (b) {
      if (b.disabled) return;
      b.addEventListener("click", function () {
        var res = parseInt(b.dataset.res);
        var q = qualities.find(function (x) { return x.resolution === res; });
        if (!q || !q.url) return;
        var video = $("video", body);
        var t = video ? video.currentTime : 0;
        video.src = streamProxyUrl(q.url);
        video.play().then(function () { if (t) try { video.currentTime = t; } catch (e) {} }).catch(function () {});
        detailState.selectedQuality = q;
        $all(".quality-btn", body).forEach(function (x) { x.classList.toggle("active", x === b); });
      });
    });
  }

  function closePlayerModal() {
    var modal = $("#player-modal");
    if (!modal) return;
    modal.classList.remove("open");
    document.body.style.overflow = "";
    var body = $("#player-body");
    if (body) body.innerHTML = "";
  }

  // ---------- Download modal ----------
  function openDownloadModal(title, detailPath, subjectId, season, episode) {
    var modal = $("#download-modal");
    if (!modal) return;
    $("#download-title").textContent = "Download - " + title;
    var body = $("#download-body");
    body.innerHTML = '<div class="loading"><div class="spinner"></div>Fetching download links...</div>';
    modal.classList.add("open");
    document.body.style.overflow = "hidden";

    var closer = modal.querySelector("[data-close-modal]");
    if (closer) closer.onclick = closeDownloadModal;
    modal.addEventListener("click", function dlClose(e) {
      if (e.target === modal) { closeDownloadModal(); modal.removeEventListener("click", dlClose); }
    });

    var url = "/api/" + (season ? "tv" : "movie") + "/" + encodeURIComponent(detailPath);
    if (season) url += "?season=" + season + "&episode=" + episode;

    api(url).then(function (data) {
      var qualities = (data.qualities || []).filter(function (q) { return q.url; });
      if (qualities.length === 0) {
        body.innerHTML = '<div class="error-box">No downloadable streams found right now. Try again in 2-3 minutes.</div>';
        return;
      }
      qualities.sort(function (a, b) { return b.resolution - a.resolution; });
      body.innerHTML = '<div class="download-list">' + qualities.map(function (q) {
        var sizeTxt = q.size_mb ? q.size_mb + ' MB' : '';
        var codecTxt = q.codec ? q.codec.toUpperCase() : '';
        var metaParts = [q.resolution + 'P', sizeTxt, codecTxt].filter(Boolean).join(' - ');
        return ''
          + '<div class="download-row">'
          +   '<div class="download-info">'
          +     '<div class="download-res">' + q.resolution + 'P' + (q.vipLocked ? '<span class="vip-tag">VIP</span>' : '') + '</div>'
          +     '<div class="download-meta">' + escapeHtml(metaParts) + '</div>'
          +   '</div>'
          +   (q.url && !q.vipLocked
              ? '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
                  '<a class="btn btn-primary btn-sm" href="' + escapeHtml(streamProxyUrl(q.url)) + '" target="_blank" rel="noopener" download><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg> Download</a>' +
                  '<button class="btn btn-ghost btn-sm copy-url-btn" data-url="' + escapeHtml(q.url) + '" title="Copy direct MP4 URL (use with curl + Referer)">Copy URL</button>' +
                '</div>'
              : '<span class="btn btn-ghost btn-sm" style="cursor:not-allowed;opacity:.5">VIP only</span>')
          + '</div>';
      }).join("") + '</div>'
      + '<div class="text-muted mt-4" style="font-size:12px">Links expire in ~24 hours. Downloads route through the /api/stream proxy. If the proxy is blocked (426), use "Copy URL" and download with: <code style="background:#000;padding:2px 6px;border-radius:3px">curl -H "Referer: https://netnaija.film/" -O "&lt;url&gt;"</code></div>';

      // Wire copy-to-clipboard for direct URL buttons.
      $all(".copy-url-btn", body).forEach(function (b) {
        b.addEventListener("click", function () {
          var url = b.getAttribute("data-url") || "";
          if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(function () {
              b.textContent = "Copied!";
              setTimeout(function () { b.textContent = "Copy URL"; }, 1500);
            }).catch(function () {
              b.textContent = "Copy failed";
              setTimeout(function () { b.textContent = "Copy URL"; }, 1500);
            });
          } else {
            // Fallback for older browsers.
            var ta = document.createElement("textarea");
            ta.value = url; document.body.appendChild(ta); ta.select();
            try { document.execCommand("copy"); b.textContent = "Copied!"; } catch (e) { b.textContent = "Copy failed"; }
            setTimeout(function () { b.textContent = "Copy URL"; }, 1500);
            document.body.removeChild(ta);
          }
        });
      });
    }).catch(function (e) {
      body.innerHTML = '<div class="error-box">Failed to load download links: ' + escapeHtml(e.message) + '</div>';
    });
  }
  function closeDownloadModal() {
    var modal = $("#download-modal");
    if (!modal) return;
    modal.classList.remove("open");
    if (!$("#player-modal") || !$("#player-modal").classList.contains("open")) {
      document.body.style.overflow = "";
    }
    var body = $("#download-body");
    if (body) body.innerHTML = "";
  }

  // ---------- Trailer modal ----------
  function openTrailerModal(title, url) {
    var modal = $("#trailer-modal");
    if (!modal) return;
    $("#trailer-title").textContent = "Trailer - " + title;
    var body = $("#trailer-body");
    body.innerHTML = '<div class="player-video"><video src="' + escapeHtml(streamProxyUrl(url)) + '" controls autoplay playsinline></video></div>';
    modal.classList.add("open");
    document.body.style.overflow = "hidden";
    var closer = modal.querySelector("[data-close-modal]");
    if (closer) closer.onclick = closeTrailerModal;
    modal.addEventListener("click", function trClose(e) {
      if (e.target === modal) { closeTrailerModal(); modal.removeEventListener("click", trClose); }
    });
  }
  function closeTrailerModal() {
    var modal = $("#trailer-modal");
    if (!modal) return;
    modal.classList.remove("open");
    if (!$("#player-modal") || !$("#player-modal").classList.contains("open")) {
      document.body.style.overflow = "";
    }
    var body = $("#trailer-body");
    if (body) body.innerHTML = "";
  }

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", function () {
    initHeaderSearch();
    var page = document.body.dataset.page;
    if (page === "home") initHome();
    else if (page === "search") initSearch();
    else if (page === "detail") initDetail();
  });

  // Expose a tiny API for debugging
  window.MovieBox = { api: api, toast: toast };
})();

// === PERFORMANCE: Limit card rendering and add lazy loading ===
(function() {
  const MAX_CARDS_PER_SECTION = 20;
  const MAX_SECTIONS_MOBILE = 5;
  
  // Override renderHomeSections to limit cards
  if (typeof originalRenderHomeSections === 'undefined' && typeof renderHomeSections === 'function') {
    const originalRenderHomeSections = renderHomeSections;
    window.renderHomeSections = function(sections) {
      const isMobile = window.innerWidth < 768;
      const limitedSections = isMobile ? sections.slice(0, MAX_SECTIONS_MOBILE) : sections;
      originalRenderHomeSections(limitedSections);
    };
  }
  
  // Add lazy loading to images
  document.addEventListener('DOMContentLoaded', function() {
    // Use IntersectionObserver for lazy loading if available
    if ('IntersectionObserver' in window) {
      const imgObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const img = entry.target;
            if (img.dataset.src) {
              img.src = img.dataset.src;
              img.removeAttribute('data-src');
            }
            observer.unobserve(img);
          }
        });
      }, { rootMargin: '100px' });
      
      // Observe all images with data-src
      document.querySelectorAll('img[data-src]').forEach(img => imgObserver.observe(img));
    }
  });
})();
