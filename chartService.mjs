/**
 * Apple chart → iTunes → MusicBrainz → Cover Art Archive (Node port of chart_album_art.py).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, "data");
export const STORE_PATH = path.join(DATA_DIR, "album-store.json");
export const CHART_CACHE_PATH = path.join(DATA_DIR, "chart-cache.json");

const APPLE_CHART_TMPL =
  "https://rss.marketingtools.apple.com/api/v2/{country}/music/most-played/{limit}/songs.json";
const ITUNES_LOOKUP = "https://itunes.apple.com/lookup";
const MB_RELEASE_SEARCH = "https://musicbrainz.org/ws/2/release";
const CAA_FRONT = (mbid) => `https://coverartarchive.org/release/${mbid}/front-500`;

const ALBUM_IN_URL = /\/album\/[^/]+\/(\d+)(?:\?|$)/i;
const ITUNES_SUFFIX =
  /\s+-\s+(Single|EP|Deluxe(?:\s+Edition)?|Remastered|Anniversary Edition)\s*$/i;

const DEFAULT_UA =
  process.env.MUSICBRAINZ_UA ||
  "chart_album_p5/1.0 (ADPM205 class demo; no commercial use)";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function httpOkFirstByte(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(6000)
          : undefined,
    });
    if (!res.ok) return false;
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export function extractAlbumId(appleSongUrl) {
  const m = ALBUM_IN_URL.exec(appleSongUrl || "");
  return m ? m[1] : null;
}

export function normalizeAlbumTitle(title) {
  const t = (title || "").replace(ITUNES_SUFFIX, "").trim();
  return t || (title || "").trim();
}

function luceneEscapePhrase(s) {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function itunesLookupAlbums(albumIds, country) {
  const out = new Map();
  const batchSize = 40;
  for (let i = 0; i < albumIds.length; i += batchSize) {
    const chunk = albumIds.slice(i, i + batchSize);
    const qs = new URLSearchParams({
      id: chunk.join(","),
      entity: "album",
      country,
    });
    const data = await httpJson(`${ITUNES_LOOKUP}?${qs}`);
    for (const row of data.results || []) {
      if (row.wrapperType === "collection" || row.collectionType === "Album") {
        const cid = String(row.collectionId ?? "");
        if (cid && !out.has(cid)) out.set(cid, row);
      }
    }
    await sleep(250);
  }
  return out;
}

async function musicbrainzFindRelease(artist, album, limit = 5) {
  const headers = {
    "User-Agent": DEFAULT_UA,
    Accept: "application/json",
  };
  const q1 = `release:"${luceneEscapePhrase(album)}" AND artist:"${luceneEscapePhrase(artist)}"`;
  const qs1 = new URLSearchParams({ query: q1, fmt: "json", limit: String(limit) });
  let data = await httpJson(`${MB_RELEASE_SEARCH}?${qs1}`, headers);
  let rels = data.releases || [];
  if (!rels.length) {
    const qs2 = new URLSearchParams({
      query: luceneEscapePhrase(album),
      fmt: "json",
      limit: String(limit),
    });
    data = await httpJson(`${MB_RELEASE_SEARCH}?${qs2}`, headers);
    rels = data.releases || [];
  }
  if (!rels.length) return null;
  const best = rels.reduce((a, b) =>
    (Number(a.score) || 0) >= (Number(b.score) || 0) ? a : b
  );
  return Number(best.score) >= 45 ? String(best.id) : null;
}

async function loadJson(p, fallback) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function saveJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

/** @typedef {{ albums: Record<string, object>, chartCache: Record<string, { at: number, payload: object }> }} Store */
export async function loadStore() {
  const raw = await loadJson(STORE_PATH, { version: 1, albums: {} });
  return {
    version: 1,
    albums: raw.albums || {},
  };
}

export async function saveStore(store) {
  await saveJson(STORE_PATH, { version: 1, albums: store.albums });
}

export async function loadChartCache() {
  return loadJson(CHART_CACHE_PATH, { entries: {} });
}

export async function saveChartCache(cache) {
  await saveJson(CHART_CACHE_PATH, cache);
}

/**
 * Refresh one album in store (MusicBrainz + CAA probe) if missing mb or force.
 */
export async function ensureAlbumEnriched(store, albumId, itunesRow, { mbDelayMs, force }) {
  const key = albumId;
  let rec = store.albums[key] || {
    album_apple_id: key,
    updatedAt: 0,
  };

  rec.album_title_apple = itunesRow.collectionName ?? rec.album_title_apple;
  rec.album_artist_apple = itunesRow.artistName ?? rec.album_artist_apple;
  rec.artworkUrl100 = itunesRow.artworkUrl100 ?? rec.artworkUrl100;
  rec.itunes_kind = itunesRow.collectionType ?? rec.itunes_kind;

  const albumMb = normalizeAlbumTitle(rec.album_title_apple || "");
  const artist = rec.album_artist_apple || "";

  const needsMb =
    force ||
    !rec.musicbrainz_release_id ||
    rec.musicbrainz_release_id === "null";

  if (needsMb && albumMb && artist) {
    rec.musicbrainz_release_id = await musicbrainzFindRelease(artist, albumMb);
    await sleep(mbDelayMs);
    if (rec.musicbrainz_release_id) {
      const u = CAA_FRONT(rec.musicbrainz_release_id);
      rec.cover_art_archive_url = (await httpOkFirstByte(u)) ? u : null;
    } else {
      rec.cover_art_archive_url = null;
    }
  } else if (rec.musicbrainz_release_id && !rec.cover_art_archive_url) {
    const u = CAA_FRONT(rec.musicbrainz_release_id);
    rec.cover_art_archive_url = (await httpOkFirstByte(u)) ? u : null;
  }

  rec.updatedAt = Date.now();
  store.albums[key] = rec;
  return rec;
}

/**
 * Build chart rows + update store.
 */
export async function buildChartData(country, limit, { mbDelayMs = 1050, forceRefreshAlbums = false } = {}) {
  const chartUrl = APPLE_CHART_TMPL.replace("{country}", country).replace("{limit}", String(limit));
  const chart = await httpJson(chartUrl);
  const songs = chart.feed?.results || [];

  const orderIds = [];
  const seen = new Set();
  for (const song of songs) {
    const aid = extractAlbumId(song.url || "");
    if (aid && !seen.has(aid)) {
      seen.add(aid);
      orderIds.push(aid);
    }
  }

  const itunesMap = await itunesLookupAlbums(orderIds, country);
  const store = await loadStore();

  for (const aid of orderIds) {
    const row = itunesMap.get(aid);
    if (row) {
      await ensureAlbumEnriched(store, aid, row, { mbDelayMs, force: forceRefreshAlbums });
    }
  }

  await saveStore(store);

  const rows = [];
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const aid = extractAlbumId(song.url || "");
    const itunesAlbum = aid ? itunesMap.get(aid) : null;
    const rec = aid ? store.albums[aid] : null;

    const albumForMb = rec ? normalizeAlbumTitle(rec.album_title_apple || "") : "";

    rows.push({
      chart_position: i + 1,
      track_name: song.name,
      track_apple_id: song.id,
      album_apple_id: aid,
      album_title_apple: rec?.album_title_apple ?? itunesAlbum?.collectionName ?? null,
      album_artist_apple: rec?.album_artist_apple ?? itunesAlbum?.artistName ?? song.artistName,
      album_title_mb_query: albumForMb || null,
      musicbrainz_release_id: rec?.musicbrainz_release_id ?? null,
      cover_art_archive_url: rec?.cover_art_archive_url ?? null,
      artworkUrl100: rec?.artworkUrl100 ?? itunesAlbum?.artworkUrl100 ?? song.artworkUrl100 ?? null,
    });
  }

  return {
    country,
    limit,
    fetchedAt: new Date().toISOString(),
    rows,
  };
}

const CHART_TTL_MS = Number(process.env.CHART_CACHE_MS || 15 * 60 * 1000);

export async function getChart(country, limit, opts = {}) {
  const force = opts.force || false;
  const cache = await loadChartCache();
  cache.entries = cache.entries || {};
  const k = `${country}:${limit}`;
  const ent = cache.entries[k];
  const fresh = ent && Date.now() - ent.at < CHART_TTL_MS;

  if (fresh && !force) {
    return { ...ent.payload, cached: true };
  }

  const payload = await buildChartData(country, limit, {
    mbDelayMs: opts.mbDelayMs ?? 1050,
    forceRefreshAlbums: opts.forceRefreshAlbums ?? false,
  });

  cache.entries[k] = { at: Date.now(), payload };
  await saveChartCache(cache);

  return { ...payload, cached: false };
}
