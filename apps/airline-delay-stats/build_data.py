"""Build the static data files for the web app from the monthly BTS CSVs.

Usage: uv run webapp/build_data.py

Writes webapp/data/manifest.json plus one gzip'd shard per origin airport (data/origin/XXX.bin.gz) and
per destination airport (data/dest/XXX.bin.gz), so a query only downloads the airports it names.
This script is not deployed; only the data/ folder it produces is.

Shard layout (little endian), n = number of flights:
    uint32 n
    uint16[n] day         days since manifest "epoch"
    uint16[n] other       airport index of the other end (dest for origin shards, origin for dest shards)
    uint16[n] dep_min     scheduled departure, minutes since midnight (65535 = unknown)
    int16[n]  dep_delay   minutes (-32768 = missing, e.g. cancelled)
    int16[n]  arr_delay   minutes (-32768 = missing, e.g. cancelled or diverted)
    uint8[n]  carrier     carrier index into manifest "carriers"
    uint8[n]  cancelled   0 / 1
"""
import gzip
import json
import re
import shutil
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "data"
OUT = HERE / "data"
FILE_RE = re.compile(r"On_Time_Reporting_Carrier_On_Time_Performance_.*_(\d{4})_(\d{1,2})\.csv$")
COLS = ["FlightDate", "Reporting_Airline", "Origin", "Dest", "OriginCityName", "DestCityName",
        "CRSDepTime", "DepDelay", "ArrDelay", "Cancelled"]
MISSING, UNKNOWN_TIME = -32768, 65535
CARRIER_NAMES = {
    "AA": "American", "DL": "Delta", "UA": "United", "WN": "Southwest", "AS": "Alaska", "B6": "JetBlue",
    "NK": "Spirit", "F9": "Frontier", "G4": "Allegiant", "HA": "Hawaiian", "SY": "Sun Country",
    "MX": "Breeze", "OO": "SkyWest", "YX": "Republic", "MQ": "Envoy", "9E": "Endeavor", "OH": "PSA",
    "YV": "Mesa", "QX": "Horizon", "ZW": "Air Wisconsin", "C5": "CommuteAir", "CP": "Compass",
    "G7": "GoJet", "EV": "ExpressJet", "PT": "Piedmont", "AX": "Trans States", "VX": "Virgin America",
}


def monthly_files():
    found = {}
    for f in SRC.glob("*.csv"):
        m = FILE_RE.search(f.name)
        if m:
            found[(int(m[1]), int(m[2]))] = f
    if not found:
        raise SystemExit(f"No monthly On_Time_Reporting_* CSV files found in {SRC}")
    return [(ym, found[ym]) for ym in sorted(found)]


def to_int16(x):
    out = np.full(len(x), MISSING, dtype="<i2")
    ok = x.notna().to_numpy()
    vals = np.rint(x.to_numpy(dtype=float)[ok])
    assert vals.size == 0 or (vals.min() > MISSING and vals.max() < 32767), "delay out of int16 range"
    out[ok] = vals
    return out


def read_months(files, epoch):
    """Read each month into compact arrays; airport/carrier strings stay as per-month factor codes."""
    parts, cities, months = [], {}, []
    for (y, m), f in files:
        df = pd.read_csv(f, usecols=COLS, dtype={"CRSDepTime": str})
        flight_date = pd.to_datetime(df["FlightDate"])
        day = (flight_date - pd.Timestamp(epoch)).dt.days.to_numpy()
        nxt = date(y + (m == 12), m % 12 + 1, 1)
        months.append({"label": f"{y}-{m:02d}", "start": (date(y, m, 1) - epoch).days,
                       "end": (nxt - epoch).days})
        for code_col, city_col in (("Origin", "OriginCityName"), ("Dest", "DestCityName")):
            for code, city in df[[code_col, city_col]].drop_duplicates().itertuples(index=False):
                cities[code] = city
        t = pd.to_numeric(df["CRSDepTime"], errors="coerce")
        mins = ((t // 100) * 60 + t % 100).fillna(UNKNOWN_TIME)
        o_codes, o_names = pd.factorize(df["Origin"])
        d_codes, d_names = pd.factorize(df["Dest"])
        c_codes, c_names = pd.factorize(df["Reporting_Airline"])
        parts.append(dict(day=day.astype("<u2"), dep_min=mins.to_numpy().astype("<u2"),
                          dep=to_int16(df["DepDelay"]), arr=to_int16(df["ArrDelay"]),
                          canc=(df["Cancelled"].fillna(0) != 0).to_numpy().astype("u1"),
                          o=o_codes, o_names=list(o_names), d=d_codes, d_names=list(d_names),
                          c=c_codes, c_names=list(c_names)))
        print(f"read {f.name}: {len(df):,} flights")
    return parts, cities, months


def remap(parts, key, names_key, table):
    lookup = {name: i for i, name in enumerate(table)}
    return np.concatenate([np.array([lookup[n] for n in p[names_key]], dtype=np.int64)[p[key]]
                           for p in parts])


def write_shards(kind, group, other, order_keys, cols, n_groups, codes):
    """One file per airport in `group` (airport index per flight); `other` is the airport at the far end."""
    folder = OUT / kind
    folder.mkdir(parents=True)
    order = np.lexsort(order_keys)  # last key is the primary sort: group, then carrier, other, day, time
    bounds = np.concatenate([[0], np.cumsum(np.bincount(group, minlength=n_groups))])
    sizes = {}
    for a in range(n_groups):
        lo, hi = bounds[a], bounds[a + 1]
        if lo == hi:
            continue
        idx = order[lo:hi]
        blob = b"".join([np.uint32(len(idx)).astype("<u4").tobytes(),
                         cols["day"][idx].tobytes(), other[idx].astype("<u2").tobytes(),
                         cols["dep_min"][idx].tobytes(), cols["dep"][idx].tobytes(),
                         cols["arr"][idx].tobytes(), cols["carrier"][idx].astype("u1").tobytes(),
                         cols["canc"][idx].tobytes()])
        data = gzip.compress(blob, compresslevel=9, mtime=0)
        (folder / f"{codes[a]}.bin.gz").write_bytes(data)
        sizes[codes[a]] = len(data)
    return sizes, np.diff(bounds)


def check(kind, codes, counts, group_name):
    """Decode a few shards back from disk and compare with the in-memory counts."""
    n_ok = 0
    for a in np.flatnonzero(counts)[:: max(1, np.count_nonzero(counts) // 8)]:
        raw = gzip.decompress((OUT / kind / f"{codes[a]}.bin.gz").read_bytes())
        n = int(np.frombuffer(raw, "<u4", 1)[0])
        assert n == counts[a], f"{kind}/{codes[a]}: {n} != {counts[a]}"
        assert len(raw) == 4 + n * (5 * 2 + 2), f"{kind}/{codes[a]}: unexpected size"
        n_ok += 1
    print(f"check ok: {n_ok} {group_name} shards decode to the expected flight counts")


def main():
    files = monthly_files()
    first = files[0][0]
    epoch = date(first[0], first[1], 1)
    parts, cities, months = read_months(files, epoch)

    airports = sorted(cities)
    carriers = sorted({n for p in parts for n in p["c_names"]})
    assert len(carriers) < 256 and len(airports) < 65535
    origin = remap(parts, "o", "o_names", airports)
    dest = remap(parts, "d", "d_names", airports)
    carrier = remap(parts, "c", "c_names", carriers)
    cols = {k: np.concatenate([p[k] for p in parts]) for k in ("day", "dep_min", "dep", "arr", "canc")}
    cols["carrier"] = carrier
    print(f"{len(origin):,} flights, {len(airports)} airports, {len(carriers)} carriers")

    for kind in ("origin", "dest"):
        shutil.rmtree(OUT / kind, ignore_errors=True)
    out_sizes, out_counts = write_shards("origin", origin, dest, (cols["dep_min"], cols["day"], dest, carrier, origin),
                                         cols, len(airports), airports)
    in_sizes, in_counts = write_shards("dest", dest, origin, (cols["dep_min"], cols["day"], origin, carrier, dest),
                                       cols, len(airports), airports)
    check("origin", airports, out_counts, "origin")
    check("dest", airports, in_counts, "destination")

    manifest = {
        "version": 1,
        "epoch": epoch.isoformat(),
        "epoch_dow": epoch.weekday(),  # 0 = Monday
        "months": months,
        "airports": [{"code": c, "city": cities[c], "n_out": int(out_counts[i]), "n_in": int(in_counts[i])}
                     for i, c in enumerate(airports)],
        "carriers": [{"code": c, "name": CARRIER_NAMES.get(c, c),
                      "n": int((carrier == i).sum())} for i, c in enumerate(carriers)],
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    total = sum(out_sizes.values()) + sum(in_sizes.values())
    biggest = max(max(out_sizes.values()), max(in_sizes.values()))
    print(f"wrote {len(out_sizes) + len(in_sizes)} shards to {OUT}: {total / 1e6:.1f} MB gzipped, "
          f"largest {biggest / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
