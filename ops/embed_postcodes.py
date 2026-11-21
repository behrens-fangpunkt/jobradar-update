#!/usr/bin/env python3
"""Embed the GeoNames German postal-code data for offline locality lookup.

Source: https://download.geonames.org/export/zip/DE.zip (CC BY 4.0).
Run with the downloaded ZIP and App/Web/index.html as arguments.
"""

import argparse
import base64
import csv
import gzip
import json
import re
import zipfile
from pathlib import Path


def encode_postcodes(path):
    with zipfile.ZipFile(path) as archive:
        records = csv.reader(archive.read("DE.txt").decode("utf-8").splitlines(), delimiter="\t")
        places = {
            (row[2], row[1], row[4], row[8], round(float(row[9]) * 1000), round(float(row[10]) * 1000))
            for row in records
            if len(row) >= 11 and row[0] == "DE" and row[2] and re.fullmatch(r"\d{5}", row[1]) and row[9] and row[10]
        }
    if len(places) < 10000:
        raise ValueError("The German postcode export is unexpectedly small")
    packed = json.dumps(sorted(places), ensure_ascii=False, separators=(",", ":")).encode()
    return base64.b64encode(gzip.compress(packed, compresslevel=9, mtime=0)).decode(), len(places)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    data, count = encode_postcodes(args.archive)
    app = args.app.read_text(encoding="utf-8")
    encoded = "\n".join(data[i:i + 120] for i in range(0, len(data), 120))
    start = '<script type="text/plain" id="germanPostcodes">'
    pattern = re.escape(start) + r"[^<]*</script>"
    payload = start + "\n" + encoded + "\n</script>"
    if re.search(pattern, app):
        app = re.sub(pattern, lambda _: payload, app, count=1)
    else:
        app = app.replace("</body>", payload + "\n</body>", 1)
    args.app.write_text(app, encoding="utf-8")
    print(f"Embedded {count:,} GeoNames place/postcode rows")
