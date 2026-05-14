/* global p5 */

/** Chart query string (edit as needed). */
const CHART_QS = "country=us&limit=28";

let rows = [];
let images = [];
let placements = [];
/** #1 chart cover: drawn centered under the vinyl hole, rotating. */
let heroCover = null;
let errs = 0;

const FADE_MS = 480;

/** Hard-coded hero rotation pivot (normalized to canvas / vinyl layer). */
const HERO_PIVOT_U = 0.4527;
const HERO_PIVOT_V = 0.4791;

/** Hard-coded hero rotation speed (matches HUD for reference). */
const HERO_SPIN_DEG_PER_SEC = 220;

/**
 * Where the Express API lives when HTML is served from somewhere else (e.g. python -m http.server 8181).
 * Resolution: URL ?api= → window.API_ORIGIN → localhost:8181 → default http://localhost:4141
 */
/** Default API port when HTML is not served by Express (e.g. python -m http.server). */
const DEFAULT_API_PORT = "4141";

function apiOrigin() {
  const qs = new URLSearchParams(window.location.search);
  const fromQ = qs.get("api");
  if (fromQ) return fromQ.replace(/\/$/, "");
  const fromPort = qs.get("apiPort");
  if (fromPort) {
    const p = String(fromPort).replace(/[^\d]/g, "");
    if (p) return `http://127.0.0.1:${p}`;
  }
  if (typeof window.API_ORIGIN === "string" && window.API_ORIGIN.trim())
    return window.API_ORIGIN.trim().replace(/\/$/, "");

  const { port, protocol, hostname } = window.location;

  // file:///… → fetch("/api/…") is invalid; always hit a real HTTP server.
  if (protocol === "file:") {
    return `http://127.0.0.1:${DEFAULT_API_PORT}`;
  }

  // Static dev server on another port: talk to Node on 127.0.0.1 (avoids localhost→IPv6 vs IPv4 mismatches).
  if (
    port === "8181" ||
    port === "8080" ||
    port === "5500" ||
    port === "5173" ||
    port === "3000"
  ) {
    return `http://127.0.0.1:${DEFAULT_API_PORT}`;
  }

  if (hostname === "[::1]" && port === "4141") {
    return "";
  }

  return "";
}

function absApiUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const o = apiOrigin();
  return o ? o + path : path;
}

function chartUrl() {
  return absApiUrl("/api/chart?" + CHART_QS);
}

/** Resolved relative to the HTML URL so Express, Live Server, and subpaths all work. */
function vinylGifUrl() {
  if (typeof window === "undefined") return "/assets/video/vinyl.gif";
  if (window.location.protocol === "file:") {
    return absApiUrl("/assets/video/vinyl.gif");
  }
  return new URL("assets/video/vinyl.gif", window.location.href).href;
}

const LS_CHART_KEY = "chartAlbum.chartPayload.v1:" + CHART_QS;

function readChartLocalCache() {
  try {
    const raw = localStorage.getItem(LS_CHART_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !Array.isArray(o.rows) || !o.fetchedAt) return null;
    return o;
  } catch {
    return null;
  }
}

function writeChartLocalCache(data) {
  try {
    localStorage.setItem(
      LS_CHART_KEY,
      JSON.stringify({
        fetchedAt: data.fetchedAt,
        rows: data.rows || [],
      })
    );
  } catch (e) {
    console.warn("localStorage chart cache", e);
  }
}

/**
 * Fetch JPEG from our API, decode without p.loadImage(blob:) — instance-mode preload
 * often breaks loadImage when called from async .then(); createImageBitmap + createImage is reliable.
 */
function loadCoverThroughFetch(p, imgUrl) {
  return fetch(imgUrl, { mode: "cors", credentials: "omit", cache: "default" })
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText || ""}`.trim());
      return res.blob();
    })
    .then(async (blob) => {
      if (!blob || blob.size === 0) return null;

      if (typeof createImageBitmap === "function") {
        try {
          const bitmap = await createImageBitmap(blob);
          const w = bitmap.width;
          const h = bitmap.height;
          if (w < 1 || h < 1) {
            if (typeof bitmap.close === "function") bitmap.close();
            return null;
          }
          const img = p.createImage(w, h);
          img.drawingContext.drawImage(bitmap, 0, 0);
          if (typeof bitmap.close === "function") bitmap.close();
          img.loadPixels();
          return img;
        } catch (e) {
          console.warn("createImageBitmap failed", imgUrl, e);
        }
      }

      return new Promise((resolve) => {
        const u = URL.createObjectURL(blob);
        const dom = new Image();
        dom.onload = () => {
          URL.revokeObjectURL(u);
          try {
            const w = dom.naturalWidth || dom.width;
            const h = dom.naturalHeight || dom.height;
            if (w < 1 || h < 1) {
              resolve(null);
              return;
            }
            const img = p.createImage(w, h);
            img.drawingContext.drawImage(dom, 0, 0);
            img.loadPixels();
            resolve(img);
          } catch (err) {
            console.warn("DOM Image → p5.Image", imgUrl, err);
            resolve(null);
          }
        };
        dom.onerror = () => {
          URL.revokeObjectURL(u);
          resolve(null);
        };
        dom.src = u;
      });
    })
    .catch((e) => {
      console.warn("cover fetch", imgUrl, e.message || e);
      return null;
    });
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

function smoothstep01(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Same chart often lists several tracks from one album — one visual per cover. */
function coverDedupeKey(row) {
  if (row.cover_image) return String(row.cover_image);
  if (row.album_apple_id != null) return `apple:${row.album_apple_id}`;
  if (row.musicbrainz_release_id) return `mb:${row.musicbrainz_release_id}`;
  return `fallback:${row.chart_position}:${row.track_apple_id ?? ""}`;
}

/** Row index with best (lowest) chart_position — “most popular” on the chart. */
function heroRowIndex(rowsIn) {
  if (!rowsIn || !rowsIn.length) return 0;
  let bestI = 0;
  let bestP = Infinity;
  for (let i = 0; i < rowsIn.length; i++) {
    const raw = rowsIn[i]?.chart_position;
    const pos = typeof raw === "number" && Number.isFinite(raw) ? raw : i + 1;
    if (pos < bestP) {
      bestP = pos;
      bestI = i;
    }
  }
  return bestI;
}

function buildPlacements(p) {
  placements = [];
  const margin = 8;
  const topPad = 2;
  const shortSide = p.min(p.width, p.height);

  const hi = heroRowIndex(rows);
  const hRow = rows[hi];
  const hImg = images[hi];
  const heroKey = hRow && hImg && hImg.width > 0 ? coverDedupeKey(hRow) : null;
  if (hImg && hImg.width > 0) {
    heroCover = {
      img: hImg,
      row: hRow,
      size: shortSide * 0.42,
    };
  } else {
    heroCover = null;
  }

  const seen = new Set();
  const valid = [];
  for (let i = 0; i < rows.length; i++) {
    const img = images[i];
    if (!img || img.width <= 0) continue;
    const row = rows[i];
    const key = coverDedupeKey(row);
    if (heroKey != null && key === heroKey) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ img, row });
  }
  const n = valid.length;
  if (!n) return;

  p.randomSeed(p.int(p.millis()) % 2147483647);

  /** Grid so every quadrant gets artwork (fills empty regions). */
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * (p.width / p.height))));
  const rowsG = Math.max(1, Math.ceil(n / cols));
  const cellW = (p.width - 2 * margin) / cols;
  const cellH = (p.height - 2 * margin - topPad) / rowsG;

  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = p.floor(p.random(i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }

  for (let k = 0; k < n; k++) {
    const v = valid[order[k]];
    const col = k % cols;
    const row = p.floor(k / cols);
    const jitterX = cellW * p.random(0.18, 0.82);
    const jitterY = cellH * p.random(0.18, 0.82);
    const x = margin + col * cellW + jitterX;
    const y = margin + topPad + row * cellH + jitterY;
    const size = p.random(shortSide * 0.24, shortSide * 0.52);
    placements.push({
      x,
      y,
      angle: p.random(-0.55, 0.55),
      size,
      img: v.img,
      row: v.row,
    });
  }

  placements.sort((a, b) => a.size - b.size);
}

function loadRowImages(p, rowList) {
  let loadErrs = 0;
  const tasks = (rowList || []).map((row) => {
    const imgUrl = absApiUrl(row.cover_image);
    if (!imgUrl) return Promise.resolve(null);
    return loadCoverThroughFetch(p, imgUrl).then((im) => {
      if (!im || !im.width) loadErrs += 1;
      return im;
    });
  });
  return Promise.all(tasks).then((imgs) => ({ images: imgs, errs: loadErrs }));
}

function chartStatusLine(data, staleLocal, errCount, imgs) {
  const src = apiOrigin() === "" ? "same host" : apiOrigin();
  const apiCache = data.cached ? "hit" : "miss";
  const localNote = staleLocal ? " · browser cache (loading fresh…)" : "";
  const r = data.rows || [];
  const ok = imgs.filter((im) => im && im.width > 0).length;
  return `${data.fetchedAt} · ${r.length} rows · API: ${src} · cache: ${apiCache}${localNote} · R → reshuffle · artwork ${ok}/${r.length}${
    errCount ? ` (${errCount} failed)` : ""
  }`;
}

/** Full-canvas animated GIF above the p5 canvas (covers stay underneath). */
function attachVinylGifOverlay(p) {
  const cv = p.canvas;
  if (!cv || cv.dataset.vinylOverlayAttached === "1") return;
  cv.dataset.vinylOverlayAttached = "1";
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:relative;display:inline-block;vertical-align:top;line-height:0;";
  const parent = cv.parentNode;
  if (!parent) return;
  parent.insertBefore(wrap, cv);
  wrap.appendChild(cv);
  cv.style.display = "block";
  cv.style.position = "relative";
  cv.style.zIndex = "0";
  const vinyl = document.createElement("img");
  vinyl.src = vinylGifUrl();
  vinyl.alt = "";
  vinyl.draggable = false;
  vinyl.style.cssText =
    "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;pointer-events:none;z-index:1;";
  wrap.appendChild(vinyl);

  const spinHud = document.createElement("div");
  spinHud.id = "spin-readout";
  spinHud.style.cssText =
    "position:absolute;left:8px;bottom:8px;z-index:2;pointer-events:none;" +
    "font:12px/1.35 system-ui,sans-serif;color:#f0ece8;text-shadow:0 1px 2px #000;" +
    "background:rgba(10,10,14,0.72);padding:6px 10px;border-radius:6px;max-width:min(420px,calc(100% - 16px));";
  spinHud.textContent = "Debug (D)";
  spinHud.style.display = "none";
  wrap.appendChild(spinHud);
}

function syncDebugHud(debugOn, pivotU, pivotV, canvasW, canvasH) {
  const el = document.getElementById("spin-readout");
  if (!el) return;
  if (!debugOn) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const radPerSec = (HERO_SPIN_DEG_PER_SEC * Math.PI) / 180;
  const px = Math.round(pivotU * canvasW);
  const py = Math.round(pivotV * canvasH);
  el.textContent = `Debug · spin: ${HERO_SPIN_DEG_PER_SEC} °/s (${radPerSec.toFixed(
    5
  )} rad/s) · pivot: (${pivotU.toFixed(4)}, ${pivotV.toFixed(4)}) · ${px}×${py}px · D hide`;
}

function drawHeroCover(p, alpha01, angleRad, pivotX, pivotY) {
  if (!heroCover || !heroCover.img || heroCover.img.width <= 0) return;
  const a = p.constrain(alpha01, 0, 1);
  const ai = Math.round(a * 255);
  if (ai <= 0) return;
  const s = heroCover.size;
  p.push();
  p.translate(pivotX, pivotY);
  p.rotate(angleRad);
  p.rectMode(p.CENTER);
  p.fill(0, 0, 0, Math.round(65 * a));
  p.rect(4, 6, s + 8, s + 8, 4);
  p.rectMode(p.CORNER);
  p.tint(255, ai);
  try {
    p.image(heroCover.img, 0, 0, s, s);
  } catch {
    /* ignore */
  }
  p.pop();
  p.noTint();
}

function drawCoverPlacements(p, alpha01) {
  const a = p.constrain(alpha01, 0, 1);
  const ai = Math.round(a * 255);
  if (ai <= 0) return;
  for (const pl of placements) {
    p.push();
    p.translate(pl.x, pl.y);
    p.rotate(pl.angle);
    p.rectMode(p.CENTER);
    p.fill(0, 0, 0, Math.round(70 * a));
    p.rect(6, 8, pl.size + 8, pl.size + 8, 4);
    p.rectMode(p.CORNER);
    p.tint(255, ai);
    try {
      p.image(pl.img, 0, 0, pl.size, pl.size);
    } catch {
      /* ignore */
    }
    p.pop();
  }
  p.noTint();
}

new p5((p) => {
  let surfaceReady = false;
  /** After first post-setup layout build (avoids “no artwork” flash while p.Images become valid). */
  let layoutBuiltOnce = false;
  /** @type {{ data: object, images: unknown[], errs: number } | null} */
  let deferredFreshApply = null;
  /** @type {'none'|'out'|'in'} */
  let fadePhase = "none";
  let fadeStartMs = 0;
  /** @type {{ data: object, images: unknown[], errs: number, statusLine: string } | null} */
  let pendingSwap = null;

  /** Spin/pivot debug HUD (toggle with D). */
  let debugOverlay = false;

  let heroAngle = 0;
  let prevDrawMs = 0;

  function tryApplyDeferredFresh() {
    if (!surfaceReady || !deferredFreshApply) return;
    if (!layoutBuiltOnce) return;

    const pack = deferredFreshApply;
    deferredFreshApply = null;
    const statusLine = chartStatusLine(pack.data, false, pack.errs, pack.images);
    if (!placements.length && !heroCover) {
      rows = pack.data.rows || [];
      images = pack.images;
      errs = pack.errs;
      setStatus(statusLine);
      buildPlacements(p);
      fadePhase = "in";
      fadeStartMs = p.millis();
      return;
    }
    pendingSwap = { data: pack.data, images: pack.images, errs: pack.errs, statusLine };
    fadePhase = "out";
    fadeStartMs = p.millis();
  }

  p.preload = function () {
    const url = chartUrl();
    const localCached = readChartLocalCache();

    function applyPayload(data, { staleLocal } = {}) {
      errs = 0;
      rows = data.rows || [];
      const src = apiOrigin() === "" ? "same host" : apiOrigin();
      const apiCache = data.cached ? "hit" : "miss";
      const localNote = staleLocal ? " · browser cache (loading fresh…)" : "";
      const baseStatus = `${data.fetchedAt} · ${rows.length} rows · API: ${src} · cache: ${apiCache}${localNote} · R → reshuffle`;

      return loadRowImages(p, rows).then(({ images: imgs, errs: e }) => {
        images = imgs;
        errs = e;
        const ok = imgs.filter((im) => im && im.width > 0).length;
        setStatus(`${baseStatus} · artwork ${ok}/${rows.length}${errs ? ` (${errs} failed)` : ""}`);
      });
    }

    function showChartErr(e) {
      const tried = chartUrl();
      console.error("Chart fetch failed, URL was:", tried, e);
      let msg = e.message || String(e);
      if (msg === "Failed to fetch" || msg === "NetworkError when attempting to fetch resource.") {
        msg +=
          " — Run `PORT=4141 npm start`, then open http://127.0.0.1:4141/ in Chrome/Firefox/Safari (embedded/HTTPS previews often block http://127.0.0.1). From file:// or another port add ?api=http://127.0.0.1:4141";
        if (window.location.protocol === "https:") {
          msg +=
            " — This page is HTTPS; browsers block http API calls (mixed content). Use a non-HTTPS preview or open the sketch via http:// only.";
        }
      }
      setStatus("Error: " + msg + " · tried: " + tried);
    }

    function fetchAndApplyFresh({ rebuildLayout } = {}) {
      return fetch(url)
        .then((res) => {
          if (!res.ok) {
            let hint = "";
            if (res.status === 404) {
              hint =
                " — Static server has no /api/chart. Keep `npm start` (PORT=4141) running, open http://localhost:4141/, or add ?api=http://localhost:4141 to this page’s URL.";
            }
            throw new Error((res.statusText || res.status) + hint);
          }
          return res.json();
        })
        .then((data) => {
          writeChartLocalCache(data);
          if (rebuildLayout) {
            return loadRowImages(p, data.rows || []).then(({ images: imgs, errs: e }) => {
              deferredFreshApply = { data, images: imgs, errs: e };
              tryApplyDeferredFresh();
            });
          }
          return applyPayload(data, { staleLocal: false });
        });
    }

    if (localCached) {
      fetchAndApplyFresh({ rebuildLayout: true }).catch((e) => {
        console.warn("Fresh chart fetch failed; keeping browser cache", e);
        const src = apiOrigin() === "" ? "same host" : apiOrigin();
        setStatus(
          `${localCached.fetchedAt} · ${rows.length} rows · API: ${src} · offline/stale (refresh failed) · R → reshuffle · see console`
        );
      });
      return applyPayload({ ...localCached, cached: false }, { staleLocal: true });
    }

    return fetchAndApplyFresh().catch(showChartErr);
  };

  p.setup = function () {
    p.createCanvas(
      p.min(1120, p.max(360, p.windowWidth - 24)),
      p.min(920, p.max(480, p.windowHeight - 120))
    );
    attachVinylGifOverlay(p);
    p.imageMode(p.CENTER);
    p.angleMode(p.RADIANS);
    p.noStroke();
    surfaceReady = true;
    requestAnimationFrame(() => {
      if (rows.length) buildPlacements(p);
      layoutBuiltOnce = true;
      tryApplyDeferredFresh();
    });
  };

  p.draw = function () {
    p.background(13, 13, 15);

    if (!rows.length) {
      prevDrawMs = 0;
      p.fill(180);
      p.textAlign(p.CENTER, p.CENTER);
      p.text("Waiting for data…", p.width / 2, p.height / 2);
      return;
    }

    if (
      layoutBuiltOnce &&
      rows.length &&
      placements.length === 0 &&
      !heroCover &&
      images.some((im) => im && im.width > 0)
    ) {
      buildPlacements(p);
    }

    if (!placements.length && rows.length && layoutBuiltOnce && !heroCover) {
      p.fill(160);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(14);
      p.text("No artwork to draw (0 images decoded). See line above — try refreshing.", p.width / 2, p.height / 2);
      return;
    }
    if (!placements.length && rows.length && !layoutBuiltOnce) {
      p.fill(140);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(13);
      p.text("Loading artwork…", p.width / 2, p.height / 2);
      return;
    }

    const nowMs = p.millis();
    const dtSec = prevDrawMs > 0 ? (nowMs - prevDrawMs) / 1000 : 0;
    prevDrawMs = nowMs;
    const pivotX = HERO_PIVOT_U * p.width;
    const pivotY = HERO_PIVOT_V * p.height;
    heroAngle += ((HERO_SPIN_DEG_PER_SEC * Math.PI) / 180) * dtSec;
    syncDebugHud(debugOverlay, HERO_PIVOT_U, HERO_PIVOT_V, p.width, p.height);

    if (fadePhase === "out") {
      const t = (p.millis() - fadeStartMs) / FADE_MS;
      if (t < 1) {
        const al = 1 - smoothstep01(t);
        drawCoverPlacements(p, al);
        drawHeroCover(p, al, heroAngle, pivotX, pivotY);
      } else {
        const swap = pendingSwap;
        pendingSwap = null;
        if (swap) {
          rows = swap.data.rows || [];
          images = swap.images;
          errs = swap.errs;
          setStatus(swap.statusLine);
          buildPlacements(p);
        }
        fadePhase = "in";
        fadeStartMs = p.millis();
        drawCoverPlacements(p, 0);
        drawHeroCover(p, 0, heroAngle, HERO_PIVOT_U * p.width, HERO_PIVOT_V * p.height);
      }
      if (errs) {
        p.fill(200, 120, 120);
        p.textAlign(p.RIGHT, p.TOP);
        p.textSize(11);
        p.text(errs + " images failed", p.width - 8, 8);
      }
      return;
    }

    if (fadePhase === "in") {
      const t = (p.millis() - fadeStartMs) / FADE_MS;
      const u = smoothstep01(t);
      drawCoverPlacements(p, u);
      drawHeroCover(p, u, heroAngle, HERO_PIVOT_U * p.width, HERO_PIVOT_V * p.height);
      if (t >= 1) fadePhase = "none";
      if (errs) {
        p.fill(200, 120, 120);
        p.textAlign(p.RIGHT, p.TOP);
        p.textSize(11);
        p.text(errs + " images failed", p.width - 8, 8);
      }
      return;
    }

    drawCoverPlacements(p, 1);
    drawHeroCover(p, 1, heroAngle, HERO_PIVOT_U * p.width, HERO_PIVOT_V * p.height);

    if (errs) {
      p.fill(200, 120, 120);
      p.textAlign(p.RIGHT, p.TOP);
      p.textSize(11);
      p.text(errs + " images failed", p.width - 8, 8);
    }
  };

  p.keyPressed = function () {
    if (p.key === "d" || p.key === "D") {
      debugOverlay = !debugOverlay;
      syncDebugHud(debugOverlay, HERO_PIVOT_U, HERO_PIVOT_V, p.width, p.height);
    } else if (p.key === "r" || p.key === "R") {
      buildPlacements(p);
    }
  };

  p.windowResized = function () {
    p.resizeCanvas(
      p.min(1120, p.max(360, p.windowWidth - 24)),
      p.min(920, p.max(480, p.windowHeight - 120))
    );
    if (rows.length) {
      buildPlacements(p);
      layoutBuiltOnce = true;
    }
  };
});
