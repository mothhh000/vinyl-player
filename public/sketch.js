/* global p5 */

/** Chart query string (edit as needed). */
const CHART_QS = "country=us&limit=28";

let rows = [];
let images = [];
let placements = [];
let errs = 0;

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

function buildPlacements(p) {
  placements = [];
  const margin = 24;
  const topPad = 8;

  p.randomSeed(p.int(p.millis()) % 2147483647);

  for (let i = 0; i < rows.length; i++) {
    const img = images[i];
    if (!img || img.width <= 0) continue;

    const size = p.random(88, p.min(176, p.width * 0.22));
    let placed = false;

    for (let attempt = 0; attempt < 80; attempt++) {
      const x = p.random(margin + size * 0.5, p.width - margin - size * 0.5);
      const y = p.random(margin + size * 0.5 + topPad, p.height - margin - size * 0.5);

      let ok = true;
      for (const o of placements) {
        const minD = (size + o.size) * 0.48;
        if (p.dist(x, y, o.x, o.y) < minD) {
          ok = false;
          break;
        }
      }

      if (ok) {
        placements.push({
          x,
          y,
          angle: p.random(-0.65, 0.65),
          size,
          img,
          row: rows[i],
        });
        placed = true;
        break;
      }
    }

    if (!placed) {
      placements.push({
        x: p.random(margin + size, p.width - margin - size),
        y: p.random(margin + size + topPad, p.height - margin - size),
        angle: p.random(-0.65, 0.65),
        size,
        img,
        row: rows[i],
      });
    }
  }

  placements.sort((a, b) => a.size - b.size);
}

new p5((p) => {
  p.preload = function () {
    const url = chartUrl();
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
        errs = 0;
        rows = data.rows || [];
        const src = apiOrigin() === "" ? "same host" : apiOrigin();
        const baseStatus = `${data.fetchedAt} · ${rows.length} rows · API: ${src} · cache: ${data.cached ? "hit" : "miss"} · R → reshuffle`;

        const tasks = rows.map((row) => {
          const imgUrl = absApiUrl(row.cover_image);
          if (!imgUrl) return Promise.resolve(null);
          return loadCoverThroughFetch(p, imgUrl).then((im) => {
            if (!im || !im.width) errs += 1;
            return im;
          });
        });
        return Promise.all(tasks).then((imgs) => {
          images = imgs;
          const ok = imgs.filter((im) => im && im.width > 0).length;
          setStatus(`${baseStatus} · artwork ${ok}/${rows.length}${errs ? ` (${errs} failed)` : ""}`);
        });
      })
      .catch((e) => {
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
      });
  };

  p.setup = function () {
    p.createCanvas(
      p.min(1120, p.max(360, p.windowWidth - 24)),
      p.min(920, p.max(480, p.windowHeight - 120))
    );
    p.imageMode(p.CENTER);
    p.angleMode(p.RADIANS);
    p.noStroke();
    if (rows.length) buildPlacements(p);
  };

  p.draw = function () {
    p.background(13, 13, 15);

    if (!rows.length) {
      p.fill(180);
      p.textAlign(p.CENTER, p.CENTER);
      p.text("Waiting for data…", p.width / 2, p.height / 2);
      return;
    }

    if (!placements.length && rows.length) {
      p.fill(160);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(14);
      p.text("No artwork to draw (0 images decoded). See line above — try refreshing.", p.width / 2, p.height / 2);
      return;
    }

    for (const pl of placements) {
      p.push();
      p.translate(pl.x, pl.y);
      p.rotate(pl.angle);

      p.rectMode(p.CENTER);
      p.fill(0, 0, 0, 70);
      p.rect(6, 8, pl.size + 8, pl.size + 8, 4);
      p.rectMode(p.CORNER);

      try {
        p.image(pl.img, 0, 0, pl.size, pl.size);
      } catch {
        /* ignore */
      }

      p.pop();
    }

    if (errs) {
      p.fill(200, 120, 120);
      p.textAlign(p.RIGHT, p.TOP);
      p.textSize(11);
      p.text(errs + " images failed", p.width - 8, 8);
    }
  };

  p.keyPressed = function () {
    if (p.key === "r" || p.key === "R") {
      buildPlacements(p);
    }
  };

  p.windowResized = function () {
    p.resizeCanvas(
      p.min(1120, p.max(360, p.windowWidth - 24)),
      p.min(920, p.max(480, p.windowHeight - 120))
    );
    if (rows.length) buildPlacements(p);
  };
});
