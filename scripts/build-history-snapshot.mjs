// Builds data/history-snapshot.json (fallback for /api/history when Redis is down)
// from the `data` branch: stats/*.json -> stats, gps/*.json -> dist + worstroutes.
// Run: git fetch origin data && node scripts/build-history-snapshot.mjs
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (a) => execSync(`git ${a}`, { maxBuffer: 1 << 29 }).toString();
const files = (dir) => git(`ls-tree -r --name-only origin/data ${dir}/`).trim().split("\n").filter(Boolean);
const read = (f) => JSON.parse(git(`show origin/data:${f}`));

const stats = [];
for (const f of files("stats")) {
  const day = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
  for (const [k, v] of Object.entries(read(f).snapshots || {})) {
    const [h, m] = k.split("-");
    stats.push({ ts: Date.parse(`${day}T${h}:${m}:00Z`) / 1000, total: v.total, delayed: v.delayed, avgDelay: v.avg, maxDelay: v.max });
  }
}
stats.sort((a, b) => a.ts - b.ts);

const dist = [0, 0, 0, 0, 0];
const agg = {};
for (const f of files("gps")) {
  const d = read(f);
  if (!d.p) continue;
  for (const snap of Object.values(d.p)) {
    snap.forEach((e, i) => {
      if (!e) return;
      const dl = e[2];
      dist[dl < 1 ? 0 : dl <= 5 ? 1 : dl <= 15 ? 2 : dl <= 30 ? 3 : 4]++;
      const [o, dst] = d.r[i];
      const key = d.s[o] + "-" + d.s[dst];
      const r = agg[key] || (agg[key] = { n: 0, delayed: 0, sum: 0 });
      r.n++;
      if (dl >= 1) { r.delayed++; r.sum += dl; }
    });
  }
}
const worstroutes = Object.entries(agg)
  .filter(([, r]) => r.n >= 10 && r.delayed)
  .map(([route, r]) => ({ route, n: r.n, delayed: r.delayed, avgDelay: r.sum / r.delayed, pctDelayed: (100 * r.delayed) / r.n }))
  .sort((a, b) => b.avgDelay - a.avgDelay)
  .slice(0, 50);

writeFileSync("data/history-snapshot.json", JSON.stringify({ generated: new Date().toISOString(), stats, dist, worstroutes }));
console.log({ stats: stats.length, dist, routes: worstroutes.length });
