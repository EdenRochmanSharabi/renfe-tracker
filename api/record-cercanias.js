// Cercanias/regional trains (conventional lines, ~360 trains) from the official Renfe GTFS-RT, one file per capture:
//   cercanias/YYYY-MM-DD/HH-MM.json  {f: feed timestamp, v: [[vehicleId, line, lat*1e5, lon*1e5, status(0 STOPPED_AT,1 INCOMING_AT,2 IN_TRANSIT_TO), stopId, delay s]]}
// Cron every 5 min. Same write pattern as record-context (no read before write, 409 retry, 422 = already saved).
const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const BRANCH = process.env.DATA_BRANCH || "data";
const BASE = "https://gtfsrt.renfe.com/";
const STATUS = { STOPPED_AT: 0, INCOMING_AT: 1, IN_TRANSIT_TO: 2 };
const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(name) {
  const r = await fetch(BASE + name, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(name + " " + r.status);
  return r.json();
}

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: "unauthorized" });
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GH_TOKEN not configured" });
  try {
    const [vp, tu] = await Promise.all([get("vehicle_positions.json"), get("trip_updates.json").catch(() => null)]);
    const delay = {};
    for (const e of tu?.entity || []) if (e.tripUpdate) delay[e.tripUpdate.trip?.tripId] = e.tripUpdate.delay ?? null;
    const v = (vp.entity || []).filter((e) => e.vehicle?.position).map((e) => {
      const x = e.vehicle;
      return [x.vehicle?.id || e.id, (x.vehicle?.label || "").split("-")[0], Math.round(x.position.latitude * 1e5), Math.round(x.position.longitude * 1e5),
        STATUS[x.currentStatus] ?? null, x.stopId || "", delay[x.trip?.tripId] ?? null];
    });
    if (!v.length) return res.status(200).json({ ok: true, saved: 0 });
    const now = new Date();
    const path = "cercanias/" + now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate()) + "/" + pad(now.getUTCHours()) + "-" + pad(now.getUTCMinutes()) + ".json";
    const body = JSON.stringify({ message: path.replace(".json", ""), content: Buffer.from(JSON.stringify({ f: vp.header?.timestamp || null, v })).toString("base64"), branch: BRANCH });
    const headers = { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(400 + Math.random() * 1200);
      r = await fetch(REPO + path, { method: "PUT", headers, body, signal: AbortSignal.timeout(15000) });
      if (r.ok || r.status !== 409) break;
    }
    if (r.status === 422) return res.status(200).json({ ok: true, saved: "duplicate" });
    if (!r.ok) return res.status(502).json({ ok: false, error: "github " + r.status });
    return res.status(200).json({ ok: true, saved: v.length });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}
