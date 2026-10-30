"""Segment health index v0: how abnormal is the traffic in a 0.25 degree cell during one hour?

Trains act as sensors. For every (cell, hour of day) we learn from the normal days what is usual and score
a day with the mean of three robust z-scores (higher = worse than usual):
  slow    median speed of moving trains is lower
  delay   trains gain more delay while crossing the cell
  stops   larger share of captures with a train standing still
Needs `git fetch origin data`. Usage: python3 scripts/health_index.py [YYYY-MM-DD ...]   (days to score)
"""
import json, math, subprocess, sys
from collections import defaultdict
import numpy as np

REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
git = lambda *a: subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True).stdout
CELL = 0.25
MIN_N = 5        # samples needed to score a (cell, hour, day)
MIN_DAYS = 8     # baseline days needed for a (cell, hour)
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

mins = lambda k: int(k[:2]) * 60 + int(k[3:5])

def samples(days):
    """(day, hour, cell) -> list of (speed km/h, delay gain min, minute of the later capture)"""
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
                    out[(day, mins(b) // 60, cell)].append((hav(p, q) / (dt / 60), q[2] - p[2], mins(b)))
    return out

def unit_stats(s):
    sp = [x[0] for x in s if x[0] > 60]
    return (np.median(sp) if len(sp) >= 2 else None, np.mean([x[1] for x in s]), np.mean([x[0] < 3 for x in s]))

def robust(vals):
    v = np.array(vals, float)
    m = np.median(v)
    return m, 1.4826 * np.median(np.abs(v - m)) + 1e-6

def build(S, base_days):
    ref = defaultdict(lambda: [[], [], []])
    for (day, h, c), s in S.items():
        if day in base_days and len(s) >= MIN_N:
            st = unit_stats(s)
            for i in range(3):
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
    return float(np.mean(np.clip(z, -3, 6))) if len(z) >= 2 else None

if __name__ == "__main__":
    days = load()
    S = samples(days)
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
