"""Segment health index v0: how abnormal is the traffic in a 0.25 degree cell during one hour?

Trains act as sensors. For every (cell, hour of day) we learn from the normal days what is usual and score
a day with the mean of four robust z-scores (higher = worse than usual):
  slow    median speed of moving trains is lower
  delay   trains gain more delay while crossing the cell
  stops   larger share of captures with a train standing still
  vmax    median speed / maximum speed of the track (OSM high-speed ways, RINF as unambiguous fallback) is lower
Cercanias (cercanias/ captures, delay in seconds) is a separate network with its own baseline.
Needs `git fetch origin data`. Usage: python3 scripts/health_index.py [YYYY-MM-DD ...]   (days to score)
"""
import json, math, subprocess, sys, time
from collections import defaultdict
import numpy as np

REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
git = lambda *a: subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True).stdout
CELL = 0.25
MIN_N = 5        # samples needed to score a (cell, hour, day)
MIN_DAYS = 8     # baseline days needed for a (cell, hour)
SNAP_M = 300     # max distance to snap a sample to a way
ACC_DAYS = ("2026-10-28", "2026-10-29")

def hav(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))

def load():
    days = {}
    for d in ("gps", "gps-night"):
        for f in git("ls-tree", "-r", "--name-only", "origin/data", d + "/").split():
            try:
                j = json.loads(git("show", "origin/data:" + f))
            except Exception:
                continue
            if not isinstance(j, dict):
                continue  # legacy per-capture files are lists
            for k, v in j.get("p", {}).items():
                for i, e in enumerate(v):
                    if e:
                        days.setdefault(f.split("/")[-1][:10], {}).setdefault(k, {})[j["o"][i]] = (e[0] / 1e5, e[1] / 1e5, e[2])
    return days

def load_cercanias():
    days = {}
    for f in git("ls-tree", "-r", "--name-only", "origin/data", "cercanias/").split():  # ponytail: 1 git call per capture, use cat-file --batch when weeks accumulate
        try:
            j = json.loads(git("show", "origin/data:" + f))
        except Exception:
            continue
        for v in j.get("v", []):
            days.setdefault(f.split("/")[-2], {}).setdefault(f.split("/")[-1][:5], {})["C:" + v[0]] = (v[2] / 1e5, v[3] / 1e5, None if v[6] is None else v[6] / 60)
    return days

GRID = 0.005     # ~500 m, bigger than SNAP_M so the 3x3 neighbourhood is enough
SNAP_STATS = defaultdict(int)

def index(items):
    """items: (id, maxspeed km/h or None, [(lat, lon), ...]) -> grid of densified vertices (~100 m)"""
    g = defaultdict(list)
    for i, ms, pts in items:
        for a, b in zip(pts, pts[1:]):
            n = max(1, int(hav(a, b) / 0.1))
            for k in range(n + 1):
                la, lo = a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n
                g[(math.floor(la / GRID), math.floor(lo / GRID))].append((la, lo, ms, i))
    return g

def near(g, m):
    cx, cy = math.floor(m[0] / GRID), math.floor(m[1] / GRID)
    return [(hav(m, (e[0], e[1])), e[2], e[3]) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for e in g.get((cx + dx, cy + dy), ())]

def make_snap():
    def ints(x):
        try: return int(x)
        except (TypeError, ValueError): return None
    osm = [(w["id"], ints(w.get("maxspeed")), w["geom"]) for w in json.loads(git("show", "origin/data:static/osm_ways_highspeed.json"))]
    rinf = [(t["track"], t["vmax"], [(la, lo) for lo, la in t["geom"]]) for t in json.loads(git("show", "origin/data:static/rinf_tracks.json"))]
    go, gr = index([o for o in osm if o[1]]), index(rinf)
    def snap(m):
        c = [x for x in near(go, m) if x[0] <= SNAP_M / 1000]
        if c:
            SNAP_STATS["osm"] += 1
            return min(c)[1]
        t = {(x[2], x[1]) for x in near(gr, m) if x[0] <= SNAP_M / 1000}
        if not t: SNAP_STATS["sin_via"] += 1
        elif len(t) == 1 and next(iter(t))[1]:   # one single RINF track within reach and it has vmax
            SNAP_STATS["rinf"] += 1
            return next(iter(t))[1]
        else: SNAP_STATS["rinf_ambiguo"] += 1
        return None
    return snap

mins = lambda k: int(k[:2]) * 60 + int(k[3:5])

def samples(days, snap=None):
    """(day, hour, cell) -> list of (speed km/h, delay gain min, minute of the later capture, track vmax or None)"""
    out = defaultdict(list)
    for day, caps in days.items():
        ks = sorted(caps)
        for a, b in zip(ks, ks[1:]):
            dt = mins(b) - mins(a)
            if not 3 <= dt <= 6:
                continue
            for tid, q in caps[b].items():
                p = caps[a].get(tid)
                if p:
                    cell = (math.floor((p[0] + q[0]) / 2 / CELL), math.floor((p[1] + q[1]) / 2 / CELL))
                    v = hav(p, q) / (dt / 60)
                    ms = snap(((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) if snap and v > 60 else None
                    out[(day, mins(b) // 60, cell)].append((v, q[2] - p[2], mins(b), ms))
    return out

def unit_stats(s):
    sp = [x[0] for x in s if x[0] > 60]
    rt = [x[0] / x[3] for x in s if x[0] > 60 and x[3]]
    return (np.median(sp) if len(sp) >= 2 else None, np.mean([x[1] for x in s]), np.mean([x[0] < 3 for x in s]), np.median(rt) if len(rt) >= MIN_N else None)

def robust(vals):
    v = np.array(vals, float)
    m = np.median(v)
    return m, 1.4826 * np.median(np.abs(v - m)) + 1e-6

def build(S, base_days):
    ref = defaultdict(lambda: [[], [], [], []])
    for (day, h, c), s in S.items():
        if day in base_days and len(s) >= MIN_N:
            st = unit_stats(s)
            for i in range(4):
                if st[i] is not None:
                    ref[(h, c)][i].append(st[i])
    return {k: [robust(v) if len(v) >= MIN_DAYS else None for v in vs] for k, vs in ref.items()}

def score(ref, h, c, s):
    r = ref.get((h, c))
    if not r or len(s) < MIN_N:
        return None
    st = unit_stats(s)
    z = []
    if st[0] is not None and r[0]: z.append(-(st[0] - r[0][0]) / r[0][1])   # slower than usual
    if r[1]: z.append((st[1] - r[1][0]) / r[1][1])                            # gains more delay
    if r[2]: z.append((st[2] - r[2][0]) / max(r[2][1], 0.15))                 # stands still more often
    if st[3] is not None and r[3]: z.append(-(st[3] - r[3][0]) / r[3][1])   # slower than the track allows
    return float(np.mean(np.clip(z, -3, 6))) if len(z) >= 2 else None

if __name__ == "__main__":
    days = load()
    t0 = time.time()
    S = samples(days, make_snap())
    sn = dict(SNAP_STATS); tot = sum(sn.values())
    print("muestras en movimiento (>60 km/h): %d | con via OSM %.1f%% | RINF unico con vmax %.1f%% | RINF ambiguo/sin vmax %.1f%% | sin via a 300 m %.1f%%" % (
        tot, *(100 * sn.get(k, 0) / tot for k in ("osm", "rinf", "rinf_ambiguo", "sin_via"))))
    nv = {(d, h, c) for (d, h, c), s in S.items() if len(s) >= MIN_N and unit_stats(s)[3] is not None}
    print("unidades (dia, hora, celda) con feature vmax:", len(nv), "| celdas distintas:", len({c for _, _, c in nv}))
    base = {d for d in days if d not in ACC_DAYS}
    ref = build(S, base)
    print("dias:", len(days), "| dias base:", len(base), "| (hora, celda) con referencia:", len(ref))
    sc = {}
    for (day, h, c), s in S.items():
        v = score(ref, h, c, s)
        if v is not None:
            sc[(day, h, c)] = v
    bs = np.array([v for (d, h, c), v in sc.items() if d in base])
    print("unidades puntuadas en dias base:", len(bs), "| indice mediana %.2f p90 %.2f p99 %.2f max %.2f" % (np.median(bs), *np.percentile(bs, [90, 99]), bs.max()))
    mx = defaultdict(float)
    for (d, h, c), v in sc.items():
        if d in base: mx[d] = max(mx[d], v)
    print("dias base con el indice mas alto:", ", ".join("%s %.1f" % x for x in sorted(mx.items(), key=lambda x: -x[1])[:5]))
    show = sys.argv[1:] or list(ACC_DAYS)
    for day in show:
        rows = sorted(((v, h, c) for (d, h, c), v in sc.items() if d == day), reverse=True)[:8]
        print("\n%s: 8 unidades con el indice mas alto" % day)
        for v, h, c in rows:
            pct = 100 * (bs < v).mean()
            print("  %5.1f (percentil %5.1f%% vs base) hora %02d UTC celda lat %.2f..%.2f lon %.2f..%.2f" % (v, pct, h, c[0] * CELL, (c[0] + 1) * CELL, c[1] * CELL, (c[1] + 1) * CELL))

    # zone of the crash (Urda is at 39.42, -3.72): cells in 39.0..40.0 N, -4.25..-3.5 E, by hour on the 28th.
    # Hour 07 is scored only with captures up to 07:50 so the crash (07:54) is not in it.
    print("\n28 oct, celdas de la zona de Urda por hora (indice; percentil vs base). Hora 07 solo hasta 07:50")
    for h in (5, 6, 7, 8, 9):
        out = []
        for (d, hh, c), s in S.items():
            if d != "2026-10-28" or hh != h or not (39.0 <= c[0] * CELL < 40.0 and -4.25 <= c[1] * CELL < -3.5):
                continue
            if h == 7: s = [x for x in s if x[2] <= 470]
            v = score(ref, h, c, s)
            if v is not None: out.append((v, c, len(s)))
        out.sort(reverse=True)
        print("  hora %02d UTC: celdas puntuadas %d | maximo %s | por encima de 3 en la base: %.1f%% de las unidades" % (
            h, len(out), ("%.1f (percentil %.1f%%, n=%d, celda %.2f,%.2f)" % (out[0][0], 100 * (bs < out[0][0]).mean(), out[0][2], out[0][1][0] * CELL, out[0][1][1] * CELL)) if out else "-", 100 * (bs > 3).mean()))

    # Cercanias: its own network and baseline. Not mixed with long distance.
    dc = load_cercanias()
    print("\ncercanias: %d dias de historia, hacen falta >= %d para puntuar" % (len(dc), MIN_DAYS))
    if len(dc) >= MIN_DAYS:  # ponytail: baseline = all cercanias days (no accident days yet); refine when there is an incident to exclude
        Sc = samples(dc)
        refc = build(Sc, set(dc))
        scc = {k: v for k, s in Sc.items() if (v := score(refc, k[1], k[2], s)) is not None}
        print("cercanias: unidades puntuadas:", len(scc), "| indice max %.2f" % max(scc.values(), default=0))
    print("\ntiempo total: %.0f s" % (time.time() - t0))
