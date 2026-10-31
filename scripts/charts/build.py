"""Build the 10 gallery charts. Usage: python3 scripts/charts/build.py DATA_DIR OUT_DIR
DATA_DIR = checkout of the data branch (static/ gps/ gps-night/ stats/ cercanias/); OUT_DIR gets <name>-light.png, <name>-dark.png, texts.json.
A chart that cannot be built is skipped with a warning; the exit code is 1 only if no chart at all was built."""
import json, sys, traceback
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import matplotlib; matplotlib.use("Agg")
import style, eden, maps, safety
def main(D, out):
    D, out = Path(D).resolve(), Path(out); out.mkdir(parents=True, exist_ok=True); texts = {}
    for name, fn, dpi in [c for m in (maps, eden, safety) for c in m.CHARTS]:  # README order is set by readme.py
        try:
            t = {}
            for mode in ("light", "dark"):
                style.apply(mode); t = style.finish(fn(D), name, out, dpi)
            texts[name] = t; print("built", name)
        except Exception as e:
            print(f"::warning::chart {name} skipped: {type(e).__name__}: {e}", file=sys.stderr); traceback.print_exc(limit=-2)
            for mode in ("light", "dark"): (out / f"{name}-{mode}.png").unlink(missing_ok=True)
    (out / "texts.json").write_text(json.dumps(texts, indent=1, ensure_ascii=False) + "\n")
    return 0 if texts else 1
if __name__ == "__main__":
    if len(sys.argv) != 3: sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))
