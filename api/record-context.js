// Hourly context for the model, two small files per run (no read before write, no race with the other recorders):
//   weather/YYYY-MM-DD/HH.json  weather on a 0.5 degree grid covering every cell trains have crossed (join to a train by nearest cell)
//   alerts/YYYY-MM-DD/HH.json   Renfe GTFS-RT service alerts and cancellations (all operators in the feed; dedupe by id offline)
//                               c = cancelled trip ids (all operators), cl = cancelled trip ids of the long-distance feed (trip_updates_LD.json)
// Hourly because Open-Meteo free tier is ~10k locations/day: 183 cells x 24 = 4.4k.
const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const BRANCH = process.env.DATA_BRANCH || "data";
const GRID = [[36.5,-6.5],[36.5,-6],[36.5,-4.5],[37,-6],[37,-5.5],[37,-5],[37,-4.5],[37,-4],[37,-3.5],[37,-3],[37,-2.5],[37.5,-7],[37.5,-6.5],[37.5,-6],[37.5,-5.5],[37.5,-5],[37.5,-4],[37.5,-3.5],[37.5,-3],[37.5,-1],[38,-7],[38,-6],[38,-5.5],[38,-5],[38,-4.5],[38,-1],[38,-0.5],[38.5,-6.5],[38.5,-6],[38.5,-5.5],[38.5,-5],[38.5,-4.5],[38.5,-4],[38.5,-3.5],[38.5,-1],[38.5,-0.5],[39,-7],[39,-6.5],[39,-6],[39,-5.5],[39,-4],[39,-3.5],[39,-3],[39,-2.5],[39,-2],[39,-1.5],[39,-1],[39,-0.5],[39.5,-7],[39.5,-6.5],[39.5,-4],[39.5,-3.5],[39.5,-3],[39.5,-2.5],[39.5,-2],[39.5,-1.5],[39.5,-1],[39.5,-0.5],[39.5,0],[40,-6.5],[40,-6],[40,-5.5],[40,-5],[40,-4.5],[40,-4],[40,-3.5],[40,-3],[40,-2.5],[40,-2],[40,0],[40.5,-5],[40.5,-4.5],[40.5,-4],[40.5,-3.5],[40.5,-3],[40.5,0],[40.5,0.5],[41,-5.5],[41,-5],[41,-4.5],[41,-4],[41,-3.5],[41,-3],[41,-2.5],[41,-2],[41,-0.5],[41,0],[41,0.5],[41,1],[41,1.5],[41,2],[41.5,-6],[41.5,-5.5],[41.5,-5],[41.5,-4.5],[41.5,-2],[41.5,-1.5],[41.5,-1],[41.5,-0.5],[41.5,0],[41.5,0.5],[41.5,1],[41.5,1.5],[41.5,2],[41.5,2.5],[41.5,3],[42,-8.5],[42,-8],[42,-7.5],[42,-7],[42,-6.5],[42,-6],[42,-5],[42,-4.5],[42,-4],[42,-2],[42,-1.5],[42,-1],[42,-0.5],[42,0],[42,0.5],[42,1.5],[42,2],[42,2.5],[42,3],[42.5,-9],[42.5,-8.5],[42.5,-8],[42.5,-7.5],[42.5,-7],[42.5,-6.5],[42.5,-6],[42.5,-5.5],[42.5,-5],[42.5,-4.5],[42.5,-4],[42.5,-3.5],[42.5,-3],[42.5,-2.5],[42.5,-2],[42.5,-1.5],[42.5,-0.5],[42.5,3],[43,-8.5],[43,-8],[43,-7.5],[43,-6],[43,-5.5],[43,-4.5],[43,-4],[43,-3.5],[43,-3],[43,-2.5],[43,-2],[43,-1.5],[43,-0.5],[43,3],[43.5,-8.5],[43.5,-8],[43.5,-7.5],[43.5,-7],[43.5,-6.5],[43.5,-6],[43.5,-5.5],[43.5,-5],[43.5,-4.5],[43.5,-4],[43.5,-3.5],[43.5,-3],[43.5,-2],[43.5,3],[43.5,3.5],[43.5,4],[43.5,4.5],[43.5,5],[43.5,5.5],[44,4.5],[44,5],[44.5,4.5],[44.5,5],[45,5],[45.5,5],[46,5]];
const LD_UPDATES_URL = "https://gtfsrt.renfe.com/trip_updates_LD.json";
const VARS = ["temperature_2m", "precipitation", "snowfall", "wind_speed_10m", "wind_gusts_10m", "visibility", "weather_code", "cloud_cover", "pressure_msl", "relative_humidity_2m", "soil_moisture_0_to_1cm", "is_day"];

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWeather() {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + GRID.map((p) => p[0]).join(",") +
    "&longitude=" + GRID.map((p) => p[1]).join(",") + "&current=" + VARS.join(",") + "&wind_speed_unit=kmh&timezone=UTC";
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("open-meteo " + r.status);
  const j = await r.json();
  return { t: j[0].current.time, g: GRID, v: VARS, w: j.map((p) => VARS.map((v) => p.current?.[v] ?? null)) };
}

async function getAlerts() {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); };
  const [al, tu, ld] = await Promise.all([
    get("https://gtfsrt.renfe.com/alerts.json"), get("https://gtfsrt.renfe.com/trip_updates.json"),
    get(LD_UPDATES_URL).catch(() => null), // long-distance cancellations are best effort; alerts are still saved
  ]);
  const alerts = (al.entity || []).map((e) => {
    const a = e.alert || {};
    return [e.id, a.activePeriod?.[0]?.start || null, a.activePeriod?.[0]?.end || null, (a.informedEntity || []).length, a.descriptionText?.translation?.[0]?.text || ""];
  });
  const canc = (tu.entity || []).filter((e) => e.tripUpdate?.trip?.scheduleRelationship === "CANCELED").map((e) => e.tripUpdate.trip.tripId);
  // alerts.json (and alerts.pb) stopped updating on 2026-10-07: do not store the same frozen copy every hour
  const stale = Date.now() / 1000 - Number(al.header?.timestamp || 0) > 86400;
  const out = { ts: al.header?.timestamp || null, a: stale ? [] : alerts, c: canc };
  if (stale) out.stale = true;
  if (ld) out.cl = (ld.entity || []).filter((e) => e.tripUpdate?.trip?.scheduleRelationship === "CANCELED").map((e) => e.tripUpdate.trip.tripId);
  return out;
}

async function put(path, obj, headers) {
  const body = JSON.stringify({ message: path.replace(".json", ""), content: Buffer.from(JSON.stringify(obj)).toString("base64"), branch: BRANCH });
  let r, lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(400 + Math.random() * 1200);
    try {
      r = await fetch(REPO + path, { method: "PUT", headers, body, signal: AbortSignal.timeout(15000) });
      if (r.ok || r.status !== 409) break; // 409: another recorder moved the branch tip
    } catch (e) { lastErr = e; r = null; }
  }
  if (!r) throw lastErr;
  if (r.status === 422) return "duplicate"; // already saved this hour
  if (!r.ok) throw new Error("github " + r.status);
  return "saved";
}

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GH_TOKEN not configured" });

  const now = new Date();
  const tail = now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate()) + "/" + pad(now.getUTCHours()) + ".json";
  const headers = { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  // independent: one source failing must not lose the other
  const out = {};
  await Promise.all([["weather", getWeather], ["alerts", getAlerts]].map(async ([dir, fn]) => {
    try { out[dir] = await put(dir + "/" + tail, await fn(), headers); } catch (e) { out[dir] = "error: " + e.message; }
  }));
  const ok = Object.values(out).every((v) => v === "saved" || v === "duplicate");
  return res.status(ok ? 200 : 502).json({ ok, ...out });
}
