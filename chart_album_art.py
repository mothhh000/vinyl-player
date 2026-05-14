#!/usr/bin/env python3
"""
Apple Music chart → iTunes album metadata → MusicBrainz release match → Cover Art Archive.

Uses only the Python standard library. Pass --user-agent with your app name and contact
where required by MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

APPLE_CHART_TMPL = (
    "https://rss.marketingtools.apple.com/api/v2/{country}/music/most-played/{limit}/songs.json"
)
ITUNES_LOOKUP = "https://itunes.apple.com/lookup"
MB_RELEASE_SEARCH = "https://musicbrainz.org/ws/2/release"
CAA_FRONT = "https://coverartarchive.org/release/{mbid}/front-500"

# MusicBrainz policy: meaningful User-Agent. Override via env or edit for your class/app.
DEFAULT_UA = "chart_album_art/1.0 (ADPM205 class demo; no commercial use)"

_ALBUM_IN_URL = re.compile(r"/album/[^/]+/(\d+)(?:\?|$)", re.I)
_ITUNES_SUFFIX = re.compile(
    r"\s+-\s+(Single|EP|Deluxe(?:\s+Edition)?|Remastered|Anniversary Edition)\s*$", re.I
)


def _http_json(url: str, *, headers: dict[str, str] | None = None, timeout: float = 30) -> dict:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _http_get_ok(url: str, *, headers: dict[str, str] | None = None, timeout: float = 30) -> bool:
    """True if URL responds 2xx; reads one byte so redirects/body are exercised (HEAD is unreliable on some CDNs)."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if not (200 <= resp.status < 300):
                return False
            resp.read(1)
            return True
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 300
    except Exception:
        return False


def extract_album_id(apple_song_url: str) -> str | None:
    m = _ALBUM_IN_URL.search(apple_song_url)
    return m.group(1) if m else None


def normalize_album_title(title: str) -> str:
    t = _ITUNES_SUFFIX.sub("", title.strip())
    return t or title.strip()


def lucene_escape_phrase(s: str) -> str:
    """Escape double-quote and backslash for use inside a quoted Lucene phrase."""
    return s.replace("\\", r"\\").replace('"', r"\"")


def itunes_lookup_albums(album_ids: list[str], *, country: str) -> dict[str, dict]:
    """Return map collectionId (str) -> first album result dict."""
    out: dict[str, dict] = {}
    # iTunes allows up to ~200 ids per request; stay smaller for URL length.
    batch_size = 40
    for i in range(0, len(album_ids), batch_size):
        chunk = album_ids[i : i + batch_size]
        qs = urllib.parse.urlencode(
            {"id": ",".join(chunk), "entity": "album", "country": country}
        )
        url = f"{ITUNES_LOOKUP}?{qs}"
        data = _http_json(url)
        for row in data.get("results", []):
            if row.get("wrapperType") == "collection" or row.get("collectionType") == "Album":
                cid = str(row.get("collectionId", ""))
                if cid and cid not in out:
                    out[cid] = row
        time.sleep(0.25)
    return out


def musicbrainz_find_release(
    artist: str, album: str, *, user_agent: str, limit: int = 5
) -> str | None:
    artist_q = lucene_escape_phrase(artist)
    album_q = lucene_escape_phrase(album)
    query = f'release:"{album_q}" AND artist:"{artist_q}"'
    qs = urllib.parse.urlencode({"query": query, "fmt": "json", "limit": str(limit)})
    url = f"{MB_RELEASE_SEARCH}?{qs}"
    headers = {"User-Agent": user_agent, "Accept": "application/json"}
    data = _http_json(url, headers=headers)
    rels = data.get("releases") or []
    if not rels:
        # Retry with a softer query: primary artist only on release name.
        query2 = lucene_escape_phrase(album)
        qs2 = urllib.parse.urlencode({"query": query2, "fmt": "json", "limit": str(limit)})
        url2 = f"{MB_RELEASE_SEARCH}?{qs2}"
        data = _http_json(url2, headers=headers)
        rels = data.get("releases") or []
    if not rels:
        return None
    best = max(rels, key=lambda r: int(r.get("score") or 0))
    return str(best["id"]) if int(best.get("score") or 0) >= 45 else None


def caa_front_url(mbid: str) -> str:
    return CAA_FRONT.format(mbid=mbid)


def main() -> int:
    p = argparse.ArgumentParser(description="Chart → iTunes → MusicBrainz → Cover Art Archive")
    p.add_argument("--country", default="us", help="Store country (e.g. us, gb, jp)")
    p.add_argument("--limit", type=int, default=10, help="Chart depth (typically up to 100)")
    p.add_argument("--mb-delay", type=float, default=1.05, help="Seconds between MusicBrainz calls")
    p.add_argument("--user-agent", default=DEFAULT_UA, help="User-Agent for MusicBrainz")
    args = p.parse_args()

    chart_url = APPLE_CHART_TMPL.format(country=args.country.lower(), limit=args.limit)
    chart = _http_json(chart_url)
    songs = chart.get("feed", {}).get("results") or []

    rows: list[dict] = []
    album_ids_order: list[str] = []
    seen_album: set[str] = set()
    for song in songs:
        aid = extract_album_id(song.get("url") or "")
        if aid and aid not in seen_album:
            seen_album.add(aid)
            album_ids_order.append(aid)

    itunes_by_album = itunes_lookup_albums(album_ids_order, country=args.country.lower())

    mb_cache: dict[str, str | None] = {}
    for idx, song in enumerate(songs, start=1):
        aid = extract_album_id(song.get("url") or "")
        itunes_album = itunes_by_album.get(aid or "", {})
        coll_name = itunes_album.get("collectionName") or ""
        artist = itunes_album.get("artistName") or song.get("artistName") or ""
        album_for_mb = normalize_album_title(coll_name) if coll_name else ""

        mbid: str | None = None
        cover: str | None = None

        if aid and album_for_mb and artist:
            if aid not in mb_cache:
                mb_cache[aid] = musicbrainz_find_release(
                    artist, album_for_mb, user_agent=args.user_agent
                )
                time.sleep(args.mb_delay)
            mbid = mb_cache.get(aid)

            if mbid:
                u = caa_front_url(mbid)
                cover = u if _http_get_ok(u) else None

        rows.append(
            {
                "chart_position": idx,
                "track_name": song.get("name"),
                "track_apple_id": song.get("id"),
                "album_apple_id": aid,
                "album_title_apple": coll_name or None,
                "album_artist_apple": itunes_album.get("artistName") or song.get("artistName"),
                "album_title_mb_query": album_for_mb or None,
                "musicbrainz_release_id": mbid,
                "cover_art_archive_url": cover,
            }
        )

    json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
