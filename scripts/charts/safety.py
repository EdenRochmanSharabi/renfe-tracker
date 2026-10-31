"""safety1-accidents, safety1b-victims, safety2-seed-timeline, safety3-health-urda."""
import datetime as dt, json, math, sys
from functools import cache
from pathlib import Path
import matplotlib.pyplot as plt, numpy as np
import style
from common import need
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import health_index as hx  # the same scoring the health-index script uses
NOTE = ("Significant accident (ERA/Eurostat): at least one moving rail vehicle, with a death, serious injury or damage of EUR 150k+ or serious traffic disruption.\n"
        "Victims are people killed or seriously injured in such accidents (suicides excluded). Rates divide by total train-km (freight + passenger).")
URDA_DAY = "2026-10-28"; URDA_CELL = (math.floor(39.25 / hx.CELL), math.floor(-4.0 / hx.CELL)); COLLISION = 7 + 54 / 60  # fixed historic event
@cache
def euro(D):
    R = json.loads(need(D, "static", "eurostat_es.json").read_text())["rows"]
    ac = {r["year"]: r["value"] for r in R if r["dataset"] == "tran_sf_railac" and r["accident"] == "TOTAL"}
    tk = {r["year"]: r["value"] / 1000 for r in R if r["dataset"] == "rail_tf_trainmv" and r["train"] == "TOTAL"}  # million train-km
    vic = lambda v: {r["year"]: r["value"] for r in R if r["dataset"] == "tran_sf_railvi" and r["accident"] == "TOTAL" and r["victim"] == v and r["pers_cat"] == "TOTAL"}
    kil, inj = vic("KIL"), vic("INJ_SRL")
    yrs = sorted(y for y in ac if y in tk and y in kil and y in inj)
    return dict(yrs=yrs, rate={y: ac[y] / tk[y] for y in yrs}, rk={y: kil[y] / tk[y] for y in yrs}, ri={y: inj[y] / tk[y] for y in yrs}, kil=kil, inj=inj)
def frame(fig, title, sub, foot):
    C = style.C
    fig.suptitle(title, x=0.125, y=0.99, ha="left", fontsize=15, fontweight="bold", color=C["ink"])
    fig.text(0.125, 0.915, sub, color=C["muted"], fontsize=9.5)
    fig.text(0.125, 0.005, foot, color=C["muted"], fontsize=8, va="top", ha="left")
    fig.subplots_adjust(top=0.83, bottom=0.12, left=0.125, right=0.95)
def line_chart(E, series, title, foot, label_pts):
    C = style.C; yrs = E["yrs"]; fig, ax = plt.subplots(figsize=(10, 5.5))
    for i, (lab, d) in enumerate(series):
        ax.plot(yrs, [d[y] for y in yrs], marker="o", ms=4, color=C["series"][i], label=lab)
        for y in label_pts:
            if i and y not in (yrs[0], yrs[-1]): continue  # a peak label of a second series would sit on the first line
            xy, ha = {yrs[0]: ((8, -15), "left"), yrs[-1]: ((9, -3), "left")}.get(y, ((0, 11), "center"))
            ax.annotate(f"{d[y]:.3g}", (y, d[y]), textcoords="offset points", xytext=xy, ha=ha, fontsize=9, color=C["ink2"])
    if len(series) > 1: ax.legend(loc="upper right")
    ax.set_ylabel("per million train-km"); ax.set_ylim(0); ax.set_xticks(yrs[::2]); ax.set_xlim(yrs[0] - .5, yrs[-1] + .5)
    frame(fig, title, f"Spain, Eurostat tran_sf_railac / tran_sf_railvi / rail_tf_trainmv, {yrs[0]}-{yrs[-1]}", foot); return fig
def safety1(D):
    E = euro(D); y0, y1, r = E["yrs"][0], E["yrs"][-1], E["rate"]
    return line_chart(E, [("significant accidents per million train-km", r)],
        f"Significant rail accidents per million train-km {'fell' if r[y1] < r[y0] else 'rose'} from {r[y0]:.2f} in {y0} to {r[y1]:.2f} in {y1}",
        NOTE, [y for y in (y0, y0 + 1, 2018, y1) if y in r])
def safety1b(D):
    E = euro(D); y1 = E["yrs"][-1]; rk = E["rk"]; pk = max(rk, key=rk.get)
    foot = NOTE + (f"\nThe {pk} peak is the Angrois derailment (Eurostat: {E['kil'][pk]} killed)." if pk == 2013 else f"\nThe {pk} peak: {E['kil'][pk]} killed.")
    if y1 < 2026: foot += f" Series ends {y1}: Adamuz and Urda (2026) are not in it."
    return line_chart(E, [("killed", rk), ("seriously injured", E["ri"])],
        f"Rail deaths per million train-km: {rk[y1]:.2f} in {y1} ({E['kil'][y1]} killed, {E['inj'][y1]} seriously injured)", foot, sorted({pk, y1}))
@cache
def road(D):
    R = json.loads(need(D, "static", "eurostat_road_es.json").read_text())["rows"]
    g = lambda ds, **k: {r["year"]: r["value"] for r in R if r["dataset"] == ds and all(r.get(a) == b for a, b in k.items())}
    rk, rail_pkm, sh = g("tran_sf_roadus", unit="NR"), g("rail_pa_total", unit="MIO_PKM"), {v: g("tran_hv_psmod", vehicle=v) for v in ("TRN", "CAR", "BUS_TOT")}
    rail = euro(D)["kil"]; yrs = sorted(y for y in rk if y in rail)
    rp = {y: rail_pkm[y] * (sh["CAR"][y] + sh["BUS_TOT"][y]) / sh["TRN"][y] for y in yrs if y in rail_pkm and all(y in s for s in sh.values())}  # car+bus pkm = rail pkm x (car+bus share)/rail share
    return dict(yrs=yrs, road=rk, rail=rail, ryrs=sorted(rp), rrisk={y: rail[y] / (rail_pkm[y] / 1e3) for y in rp}, drisk={y: rk[y] / (rp[y] / 1e3) for y in rp})
ROADNOTE = ("Road: persons killed within 30 days of an injury accident, all road users (Eurostat tran_sf_roadus, DG MOVE CARE; Spain's own 24-hour count is lower). "
            "Rail: persons killed in significant accidents on the rail network (tran_sf_railvi), suicides excluded, including level-crossing users, trespassers and staff.")
def railroad1(D):
    C = style.C; E = road(D); yrs = E["yrs"]; y0, y1 = yrs[0], yrs[-1]; fig, axs = plt.subplots(2, 1, figsize=(10, 6.5), sharex=True)
    for ax, k, lab, col in ((axs[0], "road", "Road", C["series"][0]), (axs[1], "rail", "Rail", C["series"][1])):
        d = E[k]; ax.plot(yrs, [d[y] for y in yrs], marker="o", ms=4, color=col); ax.set_ylim(0, max(d[y] for y in yrs) * 1.25); ax.set_ylabel("killed")
        ax.text(0.99, 0.93, f"{lab} (y axis 0 to {ax.get_ylim()[1]:.0f})", transform=ax.transAxes, va="top", ha="right", fontsize=10.5, fontweight="bold", color=C["ink"])
        for y in sorted({y0, y1, max(yrs, key=d.get)}):
            ax.annotate(f"{d[y]}", (y, d[y]), textcoords="offset points", xytext=(0, 8), ha="center", fontsize=9, color=C["ink2"])
    axs[1].set_xticks(yrs[::2]); axs[1].set_xlim(y0 - .5, y1 + .5)
    ratio = lambda y: E["road"][y] / E["rail"][y] if E["rail"][y] else float("nan")
    frame(fig, f"Spain: {E['road'][y1]} people died on the roads in {y1}, {E['rail'][y1]} in rail accidents",
        f"People killed per year, {y0}-{y1}: road {E['road'][y0]} to {E['road'][y1]}, rail {E['rail'][y0]} to {E['rail'][y1]}; road/rail ratio {ratio(y1):.0f}x in {y1} ({ratio(y0):.0f}x in {y0}). Separate y scales.",
        ROADNOTE + "\nThe two panels have different y axes (rail is far smaller); compare the shape over time, not the heights. Definitions differ: counts are not like for like.")
    fig.subplots_adjust(top=0.83, bottom=0.14, hspace=0.12); return fig
def railroad2(D):
    C = style.C; E = road(D); yrs = E["ryrs"]
    if len(yrs) < 3: raise ValueError("no passenger-km exposure data")
    y0, y1 = yrs[0], yrs[-1]; fig, ax = plt.subplots(figsize=(10, 5.5))
    for i, (lab, k) in enumerate((("road (cars and buses)", "drisk"), ("rail", "rrisk"))):
        d = E[k]; ax.plot(yrs, [d[y] for y in yrs], marker="o", ms=4, color=C["series"][i], label=lab)
        for y in (y0, y1): ax.annotate(f"{d[y]:.3g}", (y, d[y]), textcoords="offset points", xytext=(8, -3) if y == y1 else (-8, -3), ha="left" if y == y1 else "right", fontsize=9, color=C["ink2"])
    ax.set_yscale("log"); ax.set_ylabel("killed per billion passenger-km (log scale)"); ax.legend(loc="upper right"); ax.set_xticks(yrs[::2]); ax.set_xlim(y0 - 1.6, y1 + 1.6)
    d, r = E["drisk"], E["rrisk"]; hi, lo = ("rail", "road") if r[y1] > d[y1] else ("road", "rail")
    frame(fig, f"Per passenger-km, rail was {r[y1] / d[y1]:.1f} times the road death rate in {y1}" if r[y1] > d[y1] else f"Per passenger-km, road was {d[y1] / r[y1]:.1f} times the rail death rate in {y1}",
        f"Spain {y0}-{y1}: road {d[y0]:.1f} to {d[y1]:.1f}, rail {r[y0]:.2f} to {r[y1]:.2f} killed per billion passenger-km (log scale); rail peaks in 2013 (Angrois)",
        ROADNOTE + "\nDenominator: rail passenger-km (rail_pa_total); road = cars and buses, derived as rail passenger-km x (car + bus share) / rail share (tran_hv_psmod, rounded to 0.1 point). Motorcycles, bicycles and walking are not in the denominator, though their deaths are in the road numerator (overstates road risk). "
        "Rail deaths include trespassers and level-crossing users, not only passengers (overstates rail risk). Indicative only.")
    return fig
def safety2(D):
    C = style.C; seed = json.loads(need(D, "static", "accidents_seed.json").read_text())["accidents"]
    seed = [a for a in seed if a["deaths"] is not None]
    short = lambda a: a["place"].split(" (")[0].replace("Angrois, Santiago de Compostela", "Angrois")
    urda = max((a for a in seed if "Urda" in a["place"]), key=lambda a: a["deaths"], default=None)
    if urda is None: raise ValueError("no Urda entry in the accident seed list")
    above = sorted((a for a in seed if a["deaths"] > urda["deaths"]), key=lambda a: -a["deaths"])
    rank = {0: "the deadliest", 1: "the second deadliest", 2: "the third deadliest"}.get(len(above), f"number {len(above) + 1} by deaths")
    title = f"Urda {urda['date'][:4]} is {rank} rail accident in the seed list" + (", after " + ", ".join(f"{short(a)} {a['date'][:4]}" for a in above) if above else "")
    fig, ax = plt.subplots(figsize=(10, 5.5)); dates = []
    for a in seed:
        d = dt.date.fromisoformat(a["date"]); dates.append(d); u = a is urda or "Urda" in a["place"]
        col = C["series"][1] if u else C["series"][0]
        ax.vlines(d, 0, a["deaths"], color=col, lw=2.5 if u else 1.5)
        ax.plot(d, a["deaths"], "o", ms=10 if u else 6, color=col, mfc=col if a["deaths"] else "none")
        if a["deaths"] >= 40 or a["deaths"] == 12:
            ax.annotate(f"{short(a)} {d.year}: {a['deaths']}", (d, a["deaths"]), textcoords="offset points", xytext=(-8 if d.year > 2020 else 8, 4), ha="right" if d.year > 2020 else "left", fontsize=9.5, color=C["ink"], fontweight="bold" if u else "normal")
    ax.set_ylim(0, 90); ax.set_ylabel("deaths (as listed)"); ax.set_xlim(dt.date(min(dates).year, 1, 1), max(dt.date(2027, 3, 1), max(dates) + dt.timedelta(days=120)))
    frame(fig, title, f"Spain, {len(seed)} listed accidents since {min(dates).year} (Wikidata + Wikipedia seed, incomplete); hollow dots = 0 deaths",
        f"Casualty figures are UNVERIFIED and differ between sources; Urda ({dt.date.fromisoformat(urda['date']):%-d %b %Y}) is reported as 69-74 deaths, {urda['deaths']} plotted.\n"
        "The list is biased to media-covered events and is not a census (Eurostat counts ~50-100 significant accidents per year)."); return fig
@cache
def health(D):
    """Hourly health index of the Urda cell on the event day, and the same cell's index on every normal day (baseline)."""
    root = D.resolve()
    def git(*a):  # health_index reads the data branch through git; serve the same paths from the checkout
        if a[0] == "ls-tree": return "\n".join(str(p.relative_to(root)) for p in sorted((root / a[-1]).glob("*.json")))
        return (root / a[1].split(":", 1)[1]).read_text()
    hx.git = git
    days = hx.load()
    if URDA_DAY not in days: raise FileNotFoundError(f"no gps data for {URDA_DAY}")
    S = hx.samples(days, hx.make_snap()); base = {d for d in days if d not in hx.ACC_DAYS}; ref = hx.build(S, base)
    hours, urda = {}, {}
    for (d, hh, c), s in S.items():
        if c != URDA_CELL: continue
        if d in base:
            v = hx.score(ref, hh, c, s)
            if v is not None: hours.setdefault(hh, []).append(v)
        elif d == URDA_DAY:
            if hh == 7: s = [x for x in s if x[2] <= 470]  # up to 07:50, so the 07:54 collision is not in the score
            urda[hh] = hx.score(ref, hh, c, s)
    return dict(ndays=len(base), hours=hours, urda={h: v for h, v in urda.items() if v is not None})
def safety3(D):
    C = style.C; hi = health(D); H = {h: np.array(v) for h, v in sorted(hi["hours"].items())}; hrs = list(H); uh = sorted(hi["urda"].items())
    after = [(h, v) for h, v in uh if h >= 8]
    if not hrs or not after: raise ValueError("no baseline or no post-collision score for the Urda cell")
    pk_h, pk = max(after, key=lambda x: x[1]); p99 = np.percentile(H[pk_h], 99) if pk_h in H else None
    verdict = "above the baseline p99 for that hour" if p99 is not None and pk > p99 else "not above the baseline p99 for that hour" if p99 is not None else "with no baseline for that hour"
    n = [len(v) for v in H.values()]; xs = np.array(hrs); q = lambda p: [np.percentile(H[h], p) for h in hrs]
    fig, ax = plt.subplots(figsize=(10, 5.5))
    ax.fill_between(xs, q(50), q(99), color=C["muted"], alpha=.2, lw=0, label="baseline p50 to p99 (normal days)")
    ax.plot(xs, q(50), color=C["muted"], lw=1.5, ls="--", label="baseline median"); ax.plot(xs, q(90), color=C["muted"], lw=1.2, ls=":", label="baseline p90")
    ax.plot(*zip(*uh), "o", color=C["series"][1], label="28 Oct 2026 (Urda day)", zorder=5)
    run = [after[0]]  # joined line: the consecutive post-collision hours starting at the first one
    for h, v in after[1:]:
        if h != run[-1][0] + 1: break
        run.append((h, v))
    if len(run) > 1: ax.plot(*zip(*run), "-", color=C["series"][1], zorder=4)
    ax.set_ylim(-0.5, 5.3)
    for h, v in uh: ax.annotate(f"{v:.1f}", (h, v), textcoords="offset points", xytext=(0, 11), ha="center", fontsize=9.5, color=C["ink2"])
    ax.axvline(COLLISION, color=C["ink"], lw=1.2); ax.text(COLLISION - .1, 5.0, "collision 07:54 UTC", fontsize=9.5, color=C["ink"], va="top", ha="right")
    ax.set_xlabel("hour of day (UTC)"); ax.set_ylabel("health index (higher = worse than usual)"); ax.set_xticks(range(5, 20)); ax.set_xlim(5.5, 19.5); ax.legend(loc="upper right")
    miss = [h for h in range(uh[0][0], uh[-1][0] + 1) if h not in dict(uh)]
    nomiss = "No score for " + " and ".join(f"hour {h:02d}" + (" (too few captures before 07:50)" if h == 7 else "") for h in miss) + "; " if miss else ""
    frame(fig, f"After the Urda collision the index in the cell reached {pk:.1f}, {verdict}",
        f"Health index, cell 39.25-39.50N / 4.00-3.75W, hourly, UTC, 28 Oct 2026; baseline = {hi['ndays']} normal days ({min(n)}-{max(n)} scored days per hour)",
        "One labelled event, no validated predictive claim: the index is a descriptive anomaly score, not tested as a warning.\n"
        f"{nomiss}hours {run[0][0]}-{run[-1][0]} are after the collision.\n"
        "Baseline lines are drawn straight across hours without baseline. Cell = the highest-scoring cell of the Urda zone; the exact collision coordinates are not in the dataset."); return fig
CHARTS = [("safety1-accidents", safety1, 320), ("safety1b-victims", safety1b, 320), ("rail-vs-road-deaths", railroad1, 320), ("rail-vs-road-risk", railroad2, 320), ("safety2-seed-timeline", safety2, 320), ("safety3-health-urda", safety3, 320)]
