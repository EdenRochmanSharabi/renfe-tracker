"""Regenerate the Gallery section of README.md from texts.json. Usage: python3 scripts/charts/readme.py TEXTS_JSON README.md
Everything above `## Gallery` is kept; the section runs to the next `## ` heading or the end of the file."""
import hashlib, html, json, re, sys
BASE = "https://raw.githubusercontent.com/EdenRochmanSharabi/renfe-tracker/gallery/img"
ORDER = ["map1-density", "daily-rhythm", "delay-by-hour", "map2-cercanias", "cercanias-by-nucleus", "map3-urda",
         "safety3-health-urda", "safety1-accidents", "safety1b-victims", "rail-vs-road-deaths", "rail-vs-road-risk", "safety2-seed-timeline"]
INTRO = "Charts are generated from the `data` branch and follow the light and dark theme."
def gallery(texts):
    out = ["## Gallery", "", INTRO, ""]
    for name in [n for n in ORDER if n in texts] + sorted(set(texts) - set(ORDER)):
        t = texts[name]; v = hashlib.md5(json.dumps(t, sort_keys=True).encode()).hexdigest()[:8]  # changes with the text, which carries the data counts: busts the image cache
        out += [f"### {t['title']}", "", f"<sub>{t['sub']}</sub>", "", "<picture>",
                f'  <source media="(prefers-color-scheme: dark)" srcset="{BASE}/{name}-dark.png?v={v}">',
                f'  <img alt="{html.escape(t["title"])}" src="{BASE}/{name}-light.png?v={v}" width="100%">', "</picture>", ""]
        if t["foot"]: out += [f"<sub>{t['foot']}</sub>", ""]
    return "\n".join(out)
def main(texts_path, readme_path):
    texts = json.load(open(texts_path)); s = open(readme_path).read()
    m = re.search(r"^## Gallery\n.*?(?=^## |\Z)", s, re.S | re.M)
    if not m: sys.exit("no '## Gallery' heading in " + readme_path)
    new = s[:m.start()] + gallery(texts) + ("\n" if m.end() < len(s) else "") + s[m.end():]
    if new != s: open(readme_path, "w").write(new)
if __name__ == "__main__":
    if len(sys.argv) != 3: sys.exit(__doc__)
    main(*sys.argv[1:])
