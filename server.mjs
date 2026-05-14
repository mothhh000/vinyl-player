/**
 * Serves p5 sketch + JSON API + cached cover images (bypasses browser CORS to IA/mzstatic).
 */

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, getChart, loadStore } from "./chartService.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVERS_DIR = path.join(DATA_DIR, "covers");
const PORT = Number(process.env.PORT || 4141);

const MZ_HOST = /^is[0-9]+-ssl\.mzstatic\.com$/;

/** Cover Art Archive redirects to archive.org; some networks block or stall those CDNs. */
const ARCHIVE_TIMEOUT_MS = Number(process.env.ARCHIVE_FETCH_TIMEOUT_MS || 35000);
const ARCHIVE_RETRIES = Number(process.env.ARCHIVE_FETCH_RETRIES || 2);
const MZ_TIMEOUT_MS = Number(process.env.MZ_FETCH_TIMEOUT_MS || 25000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchErrLabel(e) {
  const c = e?.cause;
  if (c?.code === "UND_ERR_CONNECT_TIMEOUT") return "connect timeout (archive.org unreachable?)";
  if (c?.code === "UND_ERR_HEADERS_TIMEOUT") return "headers timeout";
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout/aborted";
  return e?.message || String(e);
}

/**
 * @returns {{ ok: boolean, status: number, buf: Buffer | null, error?: Error }}
 */
async function fetchBuffer(url, { timeoutMs = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal:
          typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(timeoutMs)
            : undefined,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, buf };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  return { ok: false, status: 0, buf: null, error: lastErr };
}

const app = express();

/** Lets you serve `public/` from another port (e.g. Python) while API stays on this server. */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/chart", async (req, res) => {
  try {
    const country = String(req.query.country || "us").toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const force = req.query.refresh === "1" || req.query.refresh === "true";
    const data = await getChart(country, limit, { force });
    const rows = data.rows.map((r) => ({
      ...r,
      cover_image:
        r.musicbrainz_release_id != null
          ? `/api/cover/${r.musicbrainz_release_id}${r.album_apple_id ? `?appleId=${encodeURIComponent(r.album_apple_id)}` : ""}`
          : r.album_apple_id != null
            ? `/api/apple-artwork/${r.album_apple_id}`
            : null,
    }));
    res.json({ ...data, rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/** Shared: load or fetch iTunes artwork into a JPEG buffer (cached under data/covers/apple-{id}.jpg). */
async function loadAppleArtworkBuffer(albumId) {
  const id = String(albumId).replace(/\D/g, "");
  if (!id) return { ok: false, buf: null, error: "bad id" };
  const dest = path.join(COVERS_DIR, `apple-${id}.jpg`);
  try {
    const buf = await fs.readFile(dest);
    return { ok: true, buf };
  } catch {
    /* fetch */
  }
  try {
    const store = await loadStore();
    let u = store.albums[id]?.artworkUrl100;
    if (!u) {
      const qs = new URLSearchParams({ id, entity: "album", country: "us" });
      const lu = await fetchBuffer(`https://itunes.apple.com/lookup?${qs}`, {
        timeoutMs: MZ_TIMEOUT_MS,
        retries: 1,
      });
      if (!lu.ok || !lu.buf) {
        return { ok: false, buf: null, error: fetchErrLabel(lu.error) };
      }
      const d = JSON.parse(lu.buf.toString("utf8"));
      const row = (d.results || []).find(
        (x) => x.wrapperType === "collection" || x.collectionType === "Album"
      );
      u = row?.artworkUrl100?.replace("100x100", "500x500") || row?.artworkUrl100;
    }
    if (!u) return { ok: false, buf: null, error: "no artwork url" };
    const parsed = new URL(u);
    if (!MZ_HOST.test(parsed.hostname)) return { ok: false, buf: null, error: "host not allowed" };
    const img = await fetchBuffer(u, { timeoutMs: MZ_TIMEOUT_MS, retries: 1 });
    if (!img.buf || !img.ok) {
      return { ok: false, buf: null, error: fetchErrLabel(img.error) };
    }
    await ensureDir(COVERS_DIR);
    await fs.writeFile(dest, img.buf);
    return { ok: true, buf: img.buf };
  } catch (e) {
    return { ok: false, buf: null, error: e.message || String(e) };
  }
}
app.get("/api/cover/:mbid", async (req, res) => {
  const mbid = req.params.mbid.replace(/[^0-9a-f-]/gi, "");
  if (!mbid || mbid.length < 30) {
    return res.status(400).send("bad mbid");
  }
  const dest = path.join(COVERS_DIR, `${mbid}.jpg`);
  try {
    const buf = await fs.readFile(dest);
    res.type("jpeg").send(buf);
    return;
  } catch {
    /* fetch */
  }
  const url = `https://coverartarchive.org/release/${mbid}/front-500`;
  const out = await fetchBuffer(url, {
    timeoutMs: ARCHIVE_TIMEOUT_MS,
    retries: ARCHIVE_RETRIES,
  });
  if (!out.buf || !out.ok) {
    const appleId = String(req.query.appleId || "").replace(/\D/g, "");
    if (appleId) {
      const ap = await loadAppleArtworkBuffer(appleId);
      if (ap.ok && ap.buf) {
        res.type("jpeg").send(ap.buf);
        return;
      }
      console.warn(`[/api/cover ${mbid}] apple fallback: ${ap.error || "failed"}`);
      return res.status(502).send("fetch failed");
    }
    if (!out.buf) {
      console.warn(`[/api/cover ${mbid}] ${fetchErrLabel(out.error)}`);
      return res.status(502).send("fetch failed");
    }
    return res.status(404).send("no cover");
  }
  try {
    await ensureDir(COVERS_DIR);
    await fs.writeFile(dest, out.buf);
    res.type("jpeg").send(out.buf);
  } catch (e) {
    console.warn(`[/api/cover ${mbid}] cache write: ${e.message}`);
    res.type("jpeg").send(out.buf);
  }
});

app.get("/api/apple-artwork/:albumId", async (req, res) => {
  const id = String(req.params.albumId).replace(/\D/g, "");
  if (!id) return res.status(400).send("bad id");
  const ap = await loadAppleArtworkBuffer(id);
  if (!ap.ok || !ap.buf) {
    console.warn(`[/api/apple-artwork ${id}] ${ap.error || "failed"}`);
    return res.status(ap.error === "no artwork url" || ap.error === "host not allowed" ? 404 : 502).send(
      "no artwork"
    );
  }
  res.type("jpeg").send(ap.buf);
});

/** Optional: proxy arbitrary mzstatic URL (allowlisted). ?u=encodeURIComponent */
app.get("/api/mz", async (req, res) => {
  const u = String(req.query.u || "");
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return res.status(400).send("bad url");
  }
  if (!MZ_HOST.test(parsed.hostname)) return res.status(403).send("forbidden host");
  const out = await fetchBuffer(u, { timeoutMs: MZ_TIMEOUT_MS, retries: 1 });
  if (!out.ok || !out.buf) {
    return res.status(404).end();
  }
  res.type("image/jpeg");
  res.send(out.buf);
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (API /api/chart)`);
});
