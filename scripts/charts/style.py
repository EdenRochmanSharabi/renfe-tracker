"""Shared chart style. apply(mode) sets the theme; finish(fig, name, out, dpi) strips the texts and saves."""
import matplotlib as mpl, matplotlib.pyplot as plt
from matplotlib.text import Annotation
SERIES = {"light": ["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#6250d6","#e34948"],
          "dark":  ["#3987e5","#d95926","#199e70","#c98500","#d55181","#008300","#9085e9","#e66767"]}
SURF = {"light": "#fcfcfb", "dark": "#1a1a19"}
INK  = {"light": ("#0b0b0b","#52514e","#8a8982"), "dark": ("#f0efec","#c3c2b7","#8f8e86")}  # primary, secondary, muted
C = {}
def apply(mode):
    global C
    p, s, m = INK[mode]
    C = dict(series=SERIES[mode], surf=SURF[mode], ink=p, ink2=s, muted=m, mode=mode)
    mpl.rcParams.update({"figure.facecolor": "none", "axes.facecolor": "none", "savefig.facecolor": "none", "savefig.transparent": True,
        "text.color": p, "axes.labelcolor": s, "xtick.color": s, "ytick.color": s, "axes.edgecolor": m,
        "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": m, "grid.alpha": .25,
        "grid.linewidth": .6, "font.family": "sans-serif", "font.size": 11, "axes.titlesize": 15, "axes.titleweight": "bold",
        "axes.titlelocation": "left", "lines.linewidth": 2, "legend.frameon": False, "figure.dpi": 100})
    return C
def strip(fig):
    """Hide title, subtitle and footnote (they go in the README as markdown) and return them as a dict.
    Only plain texts placed in axes/figure coordinates count; data labels and annotations always stay."""
    fig.canvas.draw(); r = fig.canvas.get_renderer(); ax = fig.axes[0]
    top, bot = ax.bbox.y1, ax.bbox.y0
    titles = [ax.title, ax._left_title, ax._right_title]  # their transform is axes + offset, so always header candidates
    plain = [t for t in list(fig.texts) + ([fig._suptitle] if fig._suptitle else []) + list(ax.texts)
             if not isinstance(t, Annotation) and any(t.get_transform() == f for f in (ax.transAxes, fig.transFigure, fig.transSubfigure))]
    ts = list(dict.fromkeys(titles + plain))
    head = [t for t in ts if t.get_text() and t.get_window_extent(r).y0 >= top - 1]
    foot = [t for t in ts if t.get_text() and t.get_window_extent(r).y1 <= bot and t not in head]
    head.sort(key=lambda t: -t.get_fontsize())
    for t in head + foot: t.set_visible(False)
    return {"title": head[0].get_text() if head else "", "sub": " ".join(t.get_text() for t in head[1:]),
            "foot": " ".join(t.get_text().replace("\n", " ") for t in foot)}
def finish(fig, name, out, dpi=320):
    texts = strip(fig)
    fig.savefig(f"{out}/{name}-{C['mode']}.png", dpi=dpi, bbox_inches="tight"); plt.close(fig)
    return texts
