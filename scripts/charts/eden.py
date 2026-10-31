"""daily-rhythm, delay-by-hour, cercanias-by-nucleus."""
import json
import matplotlib.pyplot as plt, numpy as np
import style
from common import *
def head(ax, title, sub):
    ax.set_title(title, loc="left", pad=26, color=style.C["ink"]); ax.text(0, 1.02, sub, transform=ax.transAxes, color=style.C["muted"], fontsize=10)
def daily_rhythm(D):
    C = style.C; S = C["series"]
    files = sorted(need(D, "stats").glob("*.json"))
    if not files: raise FileNotFoundError(f"no files in {D}/stats")
    tot = {}
    for f in files:
        for k, v in json.loads(f.read_text())["snapshots"].items():
            t = mad(f.stem, k); tot.setdefault((t.weekday() >= 5, t.hour), []).append(v["total"])
    fig, ax = plt.subplots(figsize=(10, 5.5)); res = {}
    for we, lab, col in ((False, "Weekdays", S[0]), (True, "Weekends", S[1])):
        res[lab] = np.array([np.mean(tot[(we, h)]) if (we, h) in tot else np.nan for h in range(24)]); ax.plot(range(24), res[lab], color=col, label=lab)
    wd, we_ = res["Weekdays"], res["Weekends"]; pk = int(np.nanargmax(wd))
    head(ax, f"Weekdays peak at {wd[pk]:.0f} trains in service at {pk}:00; weekends reach {np.nanmax(we_):.0f}",
         f"Mean trains in service per 5-min snapshot, Europe/Madrid hours. Source: Renfe live feed via renfe-tracker stats, {span([f.stem for f in files])}")
    ax.set_xlabel("Hour of day (Europe/Madrid)"); ax.set_ylabel("Trains in service"); ax.set_xticks(range(0, 24, 3)); ax.set_ylim(0)
    ax.legend(loc="upper left", labelcolor=C["ink"]); return fig
def delay_by_hour(D):
    C = style.C; S = C["series"]; G = gps(D); hs = range(5, 24)
    dl = {h: G["delay"][G["mh"] == h] for h in hs}
    q = np.array([np.percentile(dl[h], [25, 50, 90]) for h in hs]); n = sum(len(v) for v in dl.values())
    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.plot(hs, q[:, 1], color=S[0], label="Median"); ax.plot(hs, q[:, 2], color=S[1], label="90th percentile")
    ax.fill_between(hs, q[:, 0], q[:, 1], color=S[0], alpha=.15, lw=0, label="25th to median")
    imax = int(np.argmax(q[:, 2])); med = np.median(np.concatenate(list(dl.values())))
    head(ax, f"Typical delay is {med:.0f} min, but the slowest tenth runs {q[imax, 2]:.0f}+ min late at {imax + 5}:00",
         f"Delay of positioned trains, GPS samples every 5 min (n={n:,}), 05:00-23:59 Europe/Madrid. Source: renfe-tracker gps, {span(G['days'])}")
    ax.set_xlabel("Hour of day (Europe/Madrid)"); ax.set_ylabel("Delay (minutes)"); ax.set_xticks(range(6, 24, 3)); ax.set_ylim(0)
    ax.legend(loc="upper left", labelcolor=C["ink"]); return fig
def cercanias_by_nucleus(D):
    C = style.C; Z = cercanias(D); M = nucleus_masks(Z["lat"], Z["lon"])
    cd = {n: Z["delay"][m] / 60 for n, m in M.items() if m.any()}
    ns = sorted(cd, key=lambda n: -np.mean(cd[n])); m = [np.mean(cd[n]) for n in ns]
    lab = [f"{n}\n{np.mean(np.bincount(Z['cap'][M[n]])[np.bincount(Z['cap'][M[n]]) > 0]):.0f} trains per capture" for n in ns]
    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.barh(range(len(ns)), m, height=.4, color=C["series"][0]); ax.set_yticks(range(len(ns)), lab, color=C["ink2"]); ax.invert_yaxis()
    for i, v in enumerate(m): ax.text(v + .05, i, f"{v:.1f} min", va="center", color=C["ink"])
    ax.set_xlabel("Mean delay (minutes)"); ax.grid(axis="y", visible=False)
    head(ax, f"{ns[0]} Cercanias trains ran {m[0]:.1f} min late on average, the most of {len(ns)} nuclei",
         f"Mean delay of observed vehicles, 5-min captures, {Z['ncap']} captures, {span(Z['days'])}. Source: Renfe GTFS-RT")
    return fig
CHARTS = [("daily-rhythm", daily_rhythm, 320), ("delay-by-hour", delay_by_hour, 320), ("cercanias-by-nucleus", cercanias_by_nucleus, 320)]
