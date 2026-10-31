"""Data loading shared by the chart modules. D is the root of a checkout of the data branch (a pathlib.Path)."""
import datetime as dt, json
from functools import cache
from zoneinfo import ZoneInfo
import numpy as np
MAD, UTC = ZoneInfo("Europe/Madrid"), ZoneInfo("UTC")
BOX = (35.8, 43.9, -9.6, 3.6)  # lat min, lat max, lon min, lon max: the Iberian map frame
def mad(day, hm):  # UTC "YYYY-MM-DD" + "HH-MM" -> Europe/Madrid datetime
    h, m = hm.split("-")
    return dt.datetime.fromisoformat(day).replace(hour=int(h), minute=int(m), tzinfo=UTC).astimezone(MAD)
def span(days):  # sorted ISO days -> "A to B" or "A"
    return days[0] if days[0] == days[-1] else f"{days[0]} to {days[-1]}"
def need(D, *parts):
    p = D.joinpath(*parts)
    if not p.exists(): raise FileNotFoundError(f"missing {p}")
    return p
@cache
def gps(D):
    """All long-distance GPS rows (gps + gps-night), in file order. Arrays: day (index into days), hm (UTC "HH-MM" -> minutes),
    mh (Europe/Madrid hour), tid, lat, lon, delay."""
    files = [(f.stem, f) for sub in ("gps", "gps-night") for f in sorted((D / sub).glob("*.json"))]
    if not files: raise FileNotFoundError(f"no files in {D}/gps")
    days = sorted({d for d, _ in files}); ids = {}; cols = {k: [] for k in ("day", "hm", "mh", "tid", "lat", "lon", "delay")}
    for day, f in files:
        d = json.loads(f.read_text()); R = {k: [] for k in cols}; o = [ids.setdefault(t, len(ids)) for t in d["o"]]
        for hm, row in d["p"].items():
            mh = mad(day, hm).hour; mm = int(hm[:2]) * 60 + int(hm[3:])
            for t, v in zip(o, row):
                if v:
                    for k, x in zip(R, (days.index(day), mm, mh, t, v[0] / 1e5, v[1] / 1e5, v[2])): R[k].append(x)
        for k in cols: cols[k].append(np.array(R[k], dtype=float if k in ("lat", "lon", "delay") else np.int64))
    out = {k: np.concatenate(v) for k, v in cols.items()}; out["days"] = days
    return out
@cache
def cercanias(D):
    """All Cercanias captures with a delay. Arrays: cap (capture index), lat, lon, delay (seconds); plus days and ncap."""
    files = sorted((D / "cercanias").glob("*/*.json"))
    if not files: raise FileNotFoundError(f"no captures in {D}/cercanias")
    cap, lat, lon, dl = [], [], [], []
    for i, f in enumerate(files):
        for v in json.loads(f.read_text())["v"]:
            if v[6] is not None: cap.append(i); lat.append(v[2] / 1e5); lon.append(v[3] / 1e5); dl.append(v[6])
    return dict(cap=np.array(cap), lat=np.array(lat), lon=np.array(lon), delay=np.array(dl, float), ncap=len(files), days=sorted({f.parent.name for f in files}))
# Cercanias nuclei as lat/lon boxes (lat0, lat1, lon0, lon1); a position outside all of them is left out of the nucleus charts
NUCLEI = {"Madrid": (40.0, 41.0, -4.6, -3.0), "Rodalies Catalunya": (40.9, 42.6, .4, 3.4),
          "Asturias": (43.0, 43.7, -6.5, -5.0), "Cantabria": (43.0, 43.6, -4.6, -3.3)}
def nucleus_masks(lat, lon):
    return {n: (lat > a) & (lat < b) & (lon > c) & (lon < e) for n, (a, b, c, e) in NUCLEI.items()}
