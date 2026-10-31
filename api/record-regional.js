// Regional rail operators with open real-time feeds, one file per capture: regional/YYYY-MM-DD/HH-MM.json
//   mb  Metro Bilbao GTFS-RT {vp, tu}: gzip+base64 of the raw protobuf (CTB, CC BY 4.0)
//   et  Euskotren GTFS-RT trip updates, same encoding, only at minutes %15===3 (220 KB raw; it has no positions)
//   fgc FGC Geotren (CC BY 4.0): [[unit, line, lat*1e5, lon*1e5, dir, from, to, onTime, occupancy % of first car]]
// Protobuf is stored raw so the server needs no decoder; decode offline with gtfs-realtime-bindings.
// Cron every 5 min. Each source is independent; a missing key in the file means that source failed this time.
// Attribution: Euskotren data under the NAP licence ("Powered by MITRAMS"), CTB, FGC.
import { gzipSync } from "node:zlib";
const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const BRANCH = process.env.DATA_BRANCH || "data";
const CTB = "https://ctb-gtfs-rt.s3.eu-south-2.amazonaws.com/metro-bilbao-";
const EUSKOTREN = "https://opendata.euskadi.eus/transport/moveuskadi/euskotren/gtfsrt_euskotren_trip_updates.pb";
const FGC = "https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100";
const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r;
}
const pb = async (url) => gzipSync(Buffer.from(await (await get(url)).arrayBuffer())).toString("base64");

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: "unauthorized" });
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GH_TOKEN not configured" });
  const now = new Date();
  const out = {}, errors = [];
  const run = async (key, fn) => { try { out[key] = await fn(); } catch (e) { errors.push(key + ": " + e.message); } };
  await Promise.all([
    run("mb", async () => { const [vp, tu] = await Promise.all([pb(CTB + "vehicle-positions.pb"), pb(CTB + "trip-updates.pb")]); return { vp, tu }; }),
    now.getUTCMinutes() % 15 === 3 ? run("et", () => pb(EUSKOTREN)) : null,
    run("fgc", async () => (await (await get(FGC)).json()).results.map((x) => [x.ut, x.lin, Math.round(x.geo_point_2d.lat * 1e5), Math.round(x.geo_point_2d.lon * 1e5),
      x.dir, x.origen, x.desti, x.en_hora, x.ocupacio_mi_percent])),
  ]);
  if (!Object.keys(out).length) return res.status(502).json({ ok: false, errors });
  const path = "regional/" + now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate()) + "/" + pad(now.getUTCHours()) + "-" + pad(now.getUTCMinutes()) + ".json";
  const body = JSON.stringify({ message: path.replace(".json", ""), content: Buffer.from(JSON.stringify(out)).toString("base64"), branch: BRANCH });
  const headers = { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  let r;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(400 + Math.random() * 1200);
      r = await fetch(REPO + path, { method: "PUT", headers, body, signal: AbortSignal.timeout(15000) });
      if (r.ok || r.status !== 409) break;
    }
  } catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  if (r.status === 422) return res.status(200).json({ ok: true, saved: "duplicate" });
  if (!r.ok) return res.status(502).json({ ok: false, error: "github " + r.status });
  return res.status(200).json({ ok: true, saved: Object.keys(out), errors });
}
