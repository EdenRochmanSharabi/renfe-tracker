"""Daily JSON summary of the data branch for the website (/datos). Usage: python3 scripts/charts/summary.py DATA_DIR OUT.json [TEXTS_JSON]
DATA_DIR = checkout of the data branch; a sparse one is fine: capture counts come from the git tree (every day, every source),
the delay figures from whatever is checked out (stats/ cercanias/ static/). TEXTS_JSON = texts.json of build.py, lists the gallery charts.
A section that cannot be built is null with a warning; the exit code is 1 only if no section at all was built."""
import datetime as dt, json, re, subprocess, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent)); sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import need, mad, cercanias, nucleus_masks
from readme import order
from validate_data import PER_CAPTURE, HOURLY, SCALE  # the same expectations the daily validation uses
MAX_BYTES = 400_000
SNAPS_PER_DAY = 288   # gps and stats: one snapshot every 5 min
MIN_TRAINS = 20       # same night cut as the trend chart of the site
LATE_S = 300          # Cercanias late = 5 min or more
EXPECTED = {**{s: round(v[1] * SCALE) for s, v in PER_CAPTURE.items()}, **{s: v[1] for s, v in HOURLY.items()}, "gps": round(SNAPS_PER_DAY * SCALE), "stats": round(SNAPS_PER_DAY * SCALE)}
FILE = re.compile(r"(\d{4}-\d\d-\d\d)(?:/(\d\d(?:-\d\d)?))?\.json$")  # YYYY-MM-DD.json, YYYY-MM-DD/HH.json or YYYY-MM-DD/HH-MM.json
def paths(D):
    """Every file of the data branch from the git tree (a sparse or blobless checkout still has the whole tree); the checkout itself as fallback."""
    r = subprocess.run(["git", "-C", str(D), "ls-tree", "-r", "--name-only", "HEAD"], capture_output=True, text=True)
    return r.stdout.split() if r.returncode == 0 else [str(p.relative_to(D)) for p in D.rglob("*.json")]
def captures(D):
    """Per source: captures per UTC day and the last capture, from file names (gps and stats: the snapshot keys inside the daily file, when checked out)."""
    out = {s: dict(expected_per_day=e, days={}, last_utc=None) for s, e in EXPECTED.items()}
    for p in paths(D):
        src, _, rest = p.partition("/"); src = "gps" if src == "gps-night" else src; m = FILE.fullmatch(rest)
        if src not in out or not m: continue
        o, (day, last) = out[src], m.groups(); n = 1
        if src in ("gps", "stats"):
            f = D / p
            if not f.exists(): continue
            j = json.loads(f.read_text()); keys = sorted(j.get("p") or j.get("snapshots") or {}); n = len(keys); last = keys[-1] if keys else None
        o["days"][day] = o["days"].get(day, 0) + n
        if last: o["last_utc"] = max(o["last_utc"] or "", f"{day}T{last.replace('-', ':')}" + (":00" if len(last) == 2 else ""))
    return out
def long_distance(D):
    """Per day from stats/: mean delay of the delayed trains (weighted by delayed count), max delay, share delayed, and the share delayed per Europe/Madrid hour."""
    out = {}
    for f in sorted(need(D, "stats").glob("*.json")):
        S = json.loads(f.read_text())["snapshots"]; tot = dl = w = mx = 0; h = [[0, 0] for _ in range(24)]
        for k, v in S.items():
            if v["total"] < MIN_TRAINS: continue
            tot += v["total"]; dl += v["delayed"]; w += v["avg"] * v["delayed"]; mx = max(mx, v["max"]); hh = mad(f.stem, k).hour
            h[hh][0] += v["total"]; h[hh][1] += v["delayed"]
        if tot: out[f.stem] = dict(mean_delay_of_delayed_min=round(w / dl, 1) if dl else 0, max_delay_min=mx, pct_delayed=round(100 * dl / tot, 1),
                                   trains_peak=max(v["total"] for v in S.values()), pct_delayed_by_hour=[round(100 * d / t, 1) if t else None for t, d in h])
    return out
def cercanias_by_day(D):
    """Per day and nucleus: mean delay and share of positions 5+ min late (delay unwrapped at midnight by common.cercanias)."""
    Z = cercanias(D); cday = np.array([f.parent.name for f in sorted((D / "cercanias").glob("*/*.json"))])[Z["cap"]]  # same file order as the loader
    M = nucleus_masks(Z["lat"], Z["lon"]); out = {}
    for day in Z["days"]:
        row = {}
        for n, m in M.items():
            d = Z["delay"][(cday == day) & m]
            if len(d): row[n] = dict(mean_delay_min=round(float(d.mean()) / 60, 1), pct_late_5min=round(100 * float((d >= LATE_S).mean()), 1), n=int(len(d)))
        if row: out[day] = row
    return out
def gallery(texts):
    """The charts of texts.json (build.py) in README order, with their title, sub and foot."""
    T = json.loads(Path(texts).read_text()) if texts else {}
    return [dict(name=n, **T[n]) for n in order(T)]
def main(D, out, texts=None):
    D = Path(D).resolve(); J = {"generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "days": None}
    parts = {"captures": lambda: captures(D), "long_distance_by_day": lambda: long_distance(D), "cercanias_by_day": lambda: cercanias_by_day(D),
             "rail_vs_road_2026": lambda: json.loads(need(D, "static", "spain_deaths_2026.json").read_text()), "gallery": lambda: gallery(texts)}
    for k, fn in parts.items():
        try: J[k] = fn()
        except Exception as e: print(f"::warning::summary {k} skipped: {type(e).__name__}: {e}", file=sys.stderr); J[k] = None
    days = sorted({d for s in (J["captures"] or {}).values() for d in s["days"]})
    if days: J["days"] = dict(first=days[0], last=days[-1], n=len(days))
    s = json.dumps(J, separators=(",", ":"), ensure_ascii=False)
    if len(s) > MAX_BYTES: raise SystemExit(f"summary.json is {len(s)} bytes, over the {MAX_BYTES} limit")
    Path(out).write_text(s + "\n"); print(f"summary: {len(s)} bytes, days {J['days']}")
    return 0 if any(J[k] for k in parts) else 1
if __name__ == "__main__":
    if len(sys.argv) not in (3, 4): sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))
