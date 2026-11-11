"""Check one complete UTC day of the data branch.
usage: validate_data.py DATA_CHECKOUT YYYY-MM-DD   (exit 1 and print problems if anything is off)"""
import json, os, sys

# dir -> (first day recorded, expected captures per day, minimum accepted, required keys (any of), max gap minutes)
PER_CAPTURE = {
    "extra":     ("2026-10-31", 1440, 1300, ["tr"], 10),
    "cercanias": ("2026-10-31", 288, 250, ["v"], 30),
    "regional":  ("2026-10-31", 288, 250, ["mb", "fgc"], 30),
    "env":       ("2026-10-31", 96, 85, ["aemet", "kp", "ign", "ems"], 45),
}
HOURLY = {"schedule": (["tr"], 20), "weather": (["g", "w"], 24), "alerts": (["a"], 24)}  # dir -> (required keys, files per day; schedule saves nothing 00-03)
DAY = 1440  # minutes in a day
NIGHT = 300  # minutes: no trains run roughly 00:00-05:00 UTC, so recorders save nothing; that time is neither a gap nor expected
TAIL = 70  # minutes: service also ends before 24:00 UTC (last Cercanias capture 22:58), so the end of the day is no gap either
SCALE = 1 - (NIGHT + TAIL) / DAY
DAILY = {"gps": ["p"], "stats": ["snapshots"]}  # gps-night is optional (only when few trains run)

def load(path, keys, problems):
    try:
        with open(path) as f:
            j = json.load(f)
    except Exception as e:
        problems.append(f"{path}: invalid JSON ({e})"); return None
    if not isinstance(j, dict) or not j:
        problems.append(f"{path}: empty"); return None
    if keys and not any(k in j for k in keys):
        problems.append(f"{path}: none of the keys {keys}")
    return j

def check(root, day):
    problems = []
    for d, (start, expect, minimum, keys, gap) in PER_CAPTURE.items():
        if day < start: continue
        p = f"{root}/{d}/{day}"
        names = sorted(n for n in os.listdir(p) if len(n) == 10) if os.path.isdir(p) else []  # HH-MM.json
        if len(names) < minimum * SCALE:
            problems.append(f"{d}/{day}: {len(names)} captures, expected about {expect} (minimum {int(minimum * SCALE)})")
        mins = [int(n[:2]) * 60 + int(n[3:5]) for n in names]
        if mins: mins = [0, *mins, DAY]  # the day edges count too: a first capture well after 05:00 is a gap
        worst = max((b - a - max(0, min(b, NIGHT) - a) - max(0, b - max(a, DAY - TAIL)) for a, b in zip(mins, mins[1:])), default=0)
        if worst > gap: problems.append(f"{d}/{day}: gap of {worst} min (limit {gap})")
        for n in names: load(f"{p}/{n}", keys, problems)
    for d, (keys, expect) in HOURLY.items():
        p = f"{root}/{d}/{day}"
        names = [n for n in os.listdir(p) if len(n) == 7] if os.path.isdir(p) else []  # HH.json
        if len(names) < expect - 2: problems.append(f"{d}/{day}: {len(names)} hourly files, expected {expect} (minimum {expect - 2})")
        for n in names: load(f"{p}/{n}", keys, problems)
    for d, keys in DAILY.items():
        p = f"{root}/{d}/{day}.json"
        if not os.path.exists(p): problems.append(f"{d}/{day}.json missing")
        else: load(p, keys, problems)
    return problems

if __name__ == "__main__":
    probs = check(sys.argv[1], sys.argv[2])
    print("\n".join(probs[:60]) or f"{sys.argv[2]}: OK")
    sys.exit(1 if probs else 0)
