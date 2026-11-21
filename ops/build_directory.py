#!/usr/bin/env python3
"""Build the website-backed Overture Places index read by JobRadar."""

import argparse
import base64
import gzip
import json
import math
import re
from itertools import groupby
from pathlib import Path
from urllib.parse import urlsplit

import duckdb


GERMANY = (47.25, 5.86, 55.10, 15.05)
GRID = 4  # Four tiles per degree.
ROWS_PER_CHUNK = 4000
MAX_PAYLOAD = 1_200_000  # The app caps each download at 1.5 MB.
PROVIDERS = {
    "alltheplaces", "birdeye", "brightquery", "dac", "krick", "meta",
    "microsoft", "opentravel", "overture", "pinmeto", "renderseo", "uberall",
}
SOCIAL = {
    "business.google.com", "facebook.com", "google.com", "instagram.com",
    "linkedin.com", "linktr.ee", "maps.app.goo.gl", "maps.google.com",
    "threads.net", "tiktok.com", "twitter.com", "wa.me", "x.com", "youtube.com",
}
QUERY = """
    SELECT floor(bbox.ymin * 4)::INTEGER AS y,
           floor(bbox.xmin * 4)::INTEGER AS x, id, names.primary,
           round(bbox.ymin,5), round(bbox.xmin,5), websites, basic_category,
           taxonomy.primary, taxonomy.alternates,
           list_extract(list_filter(addresses, a -> a.country = 'DE'), 1),
           sources
    FROM read_parquet(?)
    WHERE bbox.ymin BETWEEN ? AND ? AND bbox.xmin BETWEEN ? AND ?
      AND names.primary IS NOT NULL AND len(websites) > 0
      AND len(list_filter(addresses, a -> a.country = 'DE')) > 0
      AND coalesce(operating_status, 'open') = 'open'
    ORDER BY y, x, id
"""


def public_website(values):
    for value in values:
        if not value or len(value) > 500:
            continue
        try:
            url = urlsplit(value.strip())
            if url.scheme not in {"http", "https"} or url.username or url.password or not url.hostname:
                continue
            host = url.hostname.lower().removeprefix("www.")
            if "." not in host or any(host == excluded or host.endswith("." + excluded) for excluded in SOCIAL):
                continue
            return url._replace(fragment="").geturl()
        except ValueError:
            continue
    return ""


def packed_row(row):
    _, _, uid, name, lat, lon, websites, category, primary, alternates, address, provenance = row
    website = public_website(websites)
    providers = {(source.get("provider") or "").lower() for source in provenance or []}
    if not website or not providers or not providers.issubset(PROVIDERS):
        return None
    name = (name or "").strip()[:180]
    if not name:
        return None
    types = ",".join(dict.fromkeys(t for t in [category, primary, *(alternates or [])] if t))
    area = " ".join(filter(None, (address.get("postcode"), address.get("locality"))))
    label = ", ".join(dict.fromkeys(filter(None, (address.get("freeform"), area))))[:240]
    return [uid, name, lat, lon, website, types, label]


def rows_from(cursor):
    while batch := cursor.fetchmany(8192):
        yield from batch


def write_chunk(rows, directory, key, part):
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()
    payload = base64.b64encode(gzip.compress(encoded, compresslevel=6, mtime=0))
    if len(payload) > MAX_PAYLOAD:
        middle = len(rows) // 2
        if not middle:
            raise ValueError(f"One business exceeds the mobile download limit in tile {key}")
        next_part = write_chunk(rows[:middle], directory, key, part)
        return write_chunk(rows[middle:], directory, key, next_part)
    (directory / f"{key}-{part}.b64").write_bytes(payload)
    return part + 1


def build(release, output, bounds, threads=4):
    if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}\.\d+", release):
        raise ValueError("Use an Overture release such as 2026-11-18.0")
    south, west, north, east = bounds
    if not GERMANY[0] <= south < north <= GERMANY[2] or not GERMANY[1] <= west < east <= GERMANY[3]:
        raise ValueError("The bounding box must be inside the configured German coverage")
    data = output / release
    data.mkdir(parents=True, exist_ok=True)
    source = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*.parquet"
    with duckdb.connect(config={"threads": threads, "memory_limit": "850MB"}) as conn:
        conn.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET http_timeout=30; SET http_retries=2")
        cursor = conn.execute(QUERY, [source, south, north, west, east])
        count, tiles = 0, {}
        for (y, x), group in groupby(rows_from(cursor), key=lambda row: row[:2]):
            key, rows, part = f"{y}-{x}", [], 0
            for row in group:
                record = packed_row(row)
                if record is None:
                    continue
                rows.append(record)
                count += 1
                if len(rows) == ROWS_PER_CHUNK:
                    part = write_chunk(rows, data, key, part)
                    rows.clear()
            if rows:
                part = write_chunk(rows, data, key, part)
            if part:
                tiles[key] = part
    if not count:
        raise ValueError("Refusing to publish an empty directory")
    manifest = {"schema": 1, "release": release, "grid": GRID, "bounds": list(bounds), "count": count, "tiles": tiles}
    (output / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{count:,} businesses in {len(tiles)} tiles ({sum(tiles.values())} files)", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default="2026-11-18.0")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bounds", type=float, nargs=4, default=GERMANY)
    args = parser.parse_args()
    build(args.release, args.out, args.bounds)
