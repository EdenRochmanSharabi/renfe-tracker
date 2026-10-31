"""map1-density, map2-cercanias, map3-urda."""
import json
from functools import cache
from pathlib import Path
import numpy as np, matplotlib.pyplot as plt
from scipy.spatial import cKDTree
from matplotlib.collections import LineCollection
from matplotlib.colors import LinearSegmentedColormap, LogNorm, to_rgb
import style
from common import *
RAIL_NETWORK = Path(__file__).resolve().parents[2] / "data" / "rail-network.json"  # lives on main, not on the data branch
K = np.cos(np.radians(40)); X = lambda lon: lon * K
KM = 111.2; PIECE = 1.0; TOL = .8  # km per piece; snap tolerance km (piece midpoint is up to 0.5 km along-track from a point)
URDA_DAY = "2026-10-28"  # fixed historic event of map3
def ramp(C):  # one hue: surface -> series[0], starts at 12% so thin low-count lines stay visible
    return LinearSegmentedColormap.from_list("r", [tuple(.88 * np.array(to_rgb(C["surf"])) + .12 * np.array(to_rgb(C["series"][0]))), C["series"][0]])
def km(p): return np.c_[p[:, 0] * K * KM, p[:, 1] * KM]
@cache
def network(D):  # track pieces of ~1 km: HS ways first, then rail-network lines not duplicating a HS way
    hs = [np.array(w["geom"])[:, ::-1] for w in json.loads(need(D, "static", "osm_ways_highspeed.json").read_text())]
    rn = [np.array(v) for v in json.loads(need(RAIL_NETWORK).read_text())["segments"].values()]
    def dens(pl):  # vertices every <=100 m for the dedupe test only
        o = []
        for g in pl:
            q = km(g); d = np.hypot(*np.diff(q, axis=0).T); n = np.maximum(1, np.ceil(d / .1)).astype(int)
            o += [q[i] + (q[i + 1] - q[i]) * np.linspace(0, 1, n[i], endpoint=False)[:, None] for i in range(len(d))]
        return np.vstack(o)
    T = cKDTree(dens(hs)); keep = []
    for g in rn:  # drop lines that duplicate a high-speed way (within 60 m for most vertices)
        if (T.query(dens([g]))[0] < .06).mean() < .5: keep.append(g)
    segs, mids = [], []
    for g in hs + keep:
        q = km(g); e = np.hypot(*np.diff(q, axis=0).T); c = np.r_[0, np.cumsum(e)]
        if c[-1] == 0: continue
        bi = np.minimum(((c[:-1] + c[1:]) / 2 / PIECE).astype(int), max(0, int(c[-1] / PIECE + .5) - 1))
        for b in np.unique(bi):
            i = np.where(bi == b)[0]; segs.append(g[i[0]:i[-1] + 2])
            cm = (c[i[0]] + c[i[-1] + 1]) / 2; mids.append(np.array([np.interp(cm, c, q[:, 0]), np.interp(cm, c, q[:, 1])]))
    return segs, cKDTree(np.array(mids))
def snap(D, lat, lon):
    segs, tree = network(D); d, i = tree.query(np.c_[X(lon) * KM, lat * KM], distance_upper_bound=TOL)
    ok = np.isfinite(d); return np.bincount(i[ok], minlength=len(segs)), ok
def inbox(lat, lon): return (lat > BOX[0]) & (lat < BOX[1]) & (lon > BOX[2]) & (lon < BOX[3])
def faint(D, ax, a=.45, lw=.35):
    ax.add_collection(LineCollection([np.c_[X(s[:, 0]), s[:, 1]] for s in network(D)[0]], colors=style.C["muted"], linewidths=lw, alpha=a, capstyle="round", joinstyle="round", zorder=1))
def base(title, sub, xl=(BOX[2], BOX[3]), yl=(BOX[0], BOX[1])):
    C = style.C; fig, ax = plt.subplots(figsize=(9, 8)); ax.set_aspect("equal"); ax.grid(False)
    ax.set_xlim(X(xl[0]), X(xl[1])); ax.set_ylim(*yl); ax.set_xticks([]); ax.set_yticks([])
    for s in ax.spines.values(): s.set_visible(False)
    fig.text(.125, .93, title, fontsize=15, fontweight="bold", color=C["ink"], ha="left"); fig.text(.125, .905, sub, fontsize=9.5, color=C["muted"], ha="left")
    return fig, ax
def cbar(fig, ax, mappable, label):
    cb = fig.colorbar(mappable, ax=ax, shrink=.4, pad=.01); cb.set_label(label, color=style.C["ink2"]); cb.outline.set_visible(False)
@cache
def density(D):
    G = gps(D); m = inbox(G["lat"], G["lon"])
    return snap(D, G["lat"][m], G["lon"][m])[0]
def map1(D):
    C = style.C; cm = ramp(C); G = gps(D); cnt = density(D); segs = network(D)[0]
    fig, ax = base("Long-distance trains trace the high-speed corridors", f"{len(G['lat']):,} train positions, 5-minute samples, {span(G['days'])}. Source: Renfe GPS feed; lines: OSM high-speed")
    nz = np.where(cnt > 0)[0]; nz = nz[np.argsort(cnt[nz])]
    nm = LogNorm(max(1, np.percentile(cnt[nz], 5)), cnt.max(), clip=True)  # scale starts at the 5th percentile so the corridors stand out
    faint(D, ax, .3, .3); n = nm(cnt[nz])
    ax.add_collection(LineCollection([np.c_[X(segs[i][:, 0]), segs[i][:, 1]] for i in nz], colors=cm(n), linewidths=.4 + 1.4 * n, capstyle="round", joinstyle="round", zorder=2))
    ax.set_xlim(X(BOX[2]), X(BOX[3])); ax.set_ylim(BOX[0], BOX[1])
    cbar(fig, ax, plt.cm.ScalarMappable(norm=nm, cmap=cm), "positions per ~1 km of track (log)"); return fig
def map2(D):
    C = style.C; Z = cercanias(D); m = inbox(Z["lat"], Z["lon"]); lat, lon, dl = Z["lat"][m], Z["lon"][m], Z["delay"][m]
    late = dl >= 300; M = nucleus_masks(lat, lon)
    top = sorted(M, key=lambda n: -(M[n] & late).sum())[:2]; nm = {"Rodalies Catalunya": "Barcelona"}
    fig, ax = base(f"Cercanias: {late.mean():.0%} of positions are 5+ min late, led by {nm.get(top[0], top[0])} and {nm.get(top[1], top[1])}",
                   f"{len(dl):,} vehicle positions from {Z['ncap']} captures, {span(Z['days'])}, coloured by delay (min). Grey: OSM rail network")
    faint(D, ax, .5, .35); d = np.clip(dl / 60, 0, 15); o = np.argsort(d)
    sc = ax.scatter(X(lon[o]), lat[o], c=d[o], s=1.6, cmap=LinearSegmentedColormap.from_list("d", [C["muted"], C["series"][0]]), vmin=0, vmax=15, lw=0)
    ax.set_xlim(X(BOX[2]), X(BOX[3])); ax.set_ylim(BOX[0], BOX[1]); cbar(fig, ax, sc, "delay, minutes (capped at 15)"); return fig
def map3(D):
    C = style.C; G = gps(D); lat0, lon0, w = 39.3, -4.0, 1.1
    if URDA_DAY not in G["days"]: raise FileNotFoundError(f"no gps data for {URDA_DAY}")
    hh = G["hm"] // 60
    s = (G["day"] == G["days"].index(URDA_DAY)) & (abs(G["lat"] - lat0) < .9 * w) & (abs(G["lon"] - lon0) < 1.2 * w) & (hh >= 6) & (hh < 10)
    lat, lon, tid, tm = G["lat"][s], G["lon"][s], G["tid"][s], G["hm"][s] / 60
    fig, ax = base("28 Oct 2026: long-distance traffic around Urda, 06:00 to 10:00 UTC", "Long-distance train positions, 5-minute samples (no per-minute data for 28 Oct). Collision about 07:54 UTC. Source: Renfe GPS feed; lines: OSM high-speed",
                   (lon0 - w * 1.2, lon0 + w * 1.2), (lat0 - w * .9, lat0 + w * .9))
    faint(D, ax, .6, .6)
    sc = ax.scatter(X(lon), lat, c=tm, s=14, cmap=LinearSegmentedColormap.from_list("t", [C["muted"], C["series"][0]]), lw=0)
    ids = {}
    for i, t in enumerate(tid): ids.setdefault(t, []).append((tm[i], lon[i], lat[i]))
    for v in ids.values():  # one thin line per train, broken when two samples are > 10 min apart
        v.sort(); a = np.array(v)
        for seg in np.split(np.arange(len(a)), np.where(np.diff(a[:, 0]) > .17)[0] + 1): ax.plot(X(a[seg, 1]), a[seg, 2], color=C["series"][0], lw=.5, alpha=.6)
    ax.plot(X(-3.9), 39.43, "o", ms=0); cbar(fig, ax, sc, "time UTC, 06:00 to 10:00"); return fig
CHARTS = [("map1-density", map1, 620), ("map2-cercanias", map2, 620), ("map3-urda", map3, 620)]
