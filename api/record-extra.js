// One small file per capture (extra/YYYY-MM-DD/HH-MM.json): nothing is read before writing, so
// there is no growing daily file and no read-modify-write race with record-gps / record-stats.
// Per train: position, delay, station before/next, expected arrival, position timestamp, rolling
// stock and product. Weather at a few points of the network every 15 minutes.
// Official GTFS-RT long-distance feeds (best effort, never block the train data):
//   v  every minute: per vehicle [vehicleId, status, stopId], status 0=STOPPED_AT 1=INCOMING_AT 2=IN_TRANSIT_TO
//   u  every 5 minutes: SCHEDULED trips only (the rest are mostly CANCELED), [tripId, delay, stopId, arrivalTime] of the first stopTimeUpdate
const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const BRANCH = process.env.DATA_BRANCH || "data";
const RENFE_URL = "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json";

// [name, lat, lon]: Madrid-Andalucia corridor first, then the other main hubs
const POINTS = [
  ["Madrid", 40.40, -3.69], ["Urda", 39.42, -3.72], ["Ciudad Real", 38.98, -3.93],
  ["Cordoba", 37.89, -4.79], ["Sevilla", 37.39, -5.97], ["Malaga", 36.72, -4.43],
  ["Barcelona", 41.38, 2.14], ["Valencia", 39.47, -0.38], ["Zaragoza", 41.66, -0.91],
  ["Valladolid", 41.65, -4.72], ["Alicante", 38.35, -0.49],
];
const VEHICLES_URL = "https://gtfsrt.renfe.com/vehicle_positions_LD.json";
const UPDATES_URL = "https://gtfsrt.renfe.com/trip_updates_LD.json";
const STATUS = { STOPPED_AT: 0, INCOMING_AT: 1, IN_TRANSIT_TO: 2 };
const WEATHER_VARS = ["temperature_2m", "precipitation", "wind_speed_10m", "wind_gusts_10m", "visibility", "weather_code"];

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWeather() {
  try {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + POINTS.map((p) => p[1]).join(",") +
      "&longitude=" + POINTS.map((p) => p[2]).join(",") + "&current=" + WEATHER_VARS.join(",") +
      "&wind_speed_unit=kmh&timezone=UTC";
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.map((p) => WEATHER_VARS.map((v) => p.current?.[v] ?? null));
  } catch {
    return null; // weather is best effort; train data is still saved
  }
}

async function getVehicles() {
  try {
    const r = await fetch(VEHICLES_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.entity || []).map((e) => [
      String(e.vehicle?.vehicle?.id ?? ""), STATUS[e.vehicle?.currentStatus] ?? null, String(e.vehicle?.stopId ?? ""),
    ]);
  } catch {
    return null; // best effort; train data is still saved
  }
}

async function getUpdates() {
  try {
    const r = await fetch(UPDATES_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.entity || []).filter((e) => e.tripUpdate?.trip?.scheduleRelationship === "SCHEDULED").map((e) => {
      const u = e.tripUpdate, s = u.stopTimeUpdate?.[0];
      return [String(u.trip.tripId ?? ""), u.delay ?? null, String(s?.stopId ?? ""), s?.arrival?.time ?? null];
    });
  } catch {
    return null; // best effort; train data is still saved
  }
}

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GH_TOKEN not configured" });

  try {
    const now = new Date();
    const feed = () => fetch(RENFE_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    const weatherP = now.getUTCMinutes() % 15 === 0 ? getWeather() : Promise.resolve(null);
    const vehiclesP = getVehicles();
    const updatesP = now.getUTCMinutes() % 5 === 0 ? getUpdates() : Promise.resolve(null);
    let resp;
    try { resp = await feed(); } catch { await sleep(1000); resp = await feed(); } // transient network error
    if (!resp.ok) return res.status(resp.status).json({ error: "upstream " + resp.status });
    const data = await resp.json();

    const trains = [];
    for (const t of data.trenes || []) {
      const lat = Number(t.latitud), lon = Number(t.longitud);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const delay = parseInt(t.ultRetraso, 10);
      trains.push([
        String(t.codComercial || t.codCirculacion || ""),
        Math.round(lat * 100000),
        Math.round(lon * 100000),
        isFinite(delay) ? delay : 0,
        String(t.codEstAnt || ""),
        String(t.codEstSig || ""),
        String(t.horaLlegadaSigEst || ""),
        Number(t.time) || 0,
        String(t.mat || ""),
        Number(t.codProduct) || 0,
      ]);
    }
    if (!trains.length) return res.status(200).json({ ok: true, saved: 0 });

    const [weather, vehicles, updates] = await Promise.all([weatherP, vehiclesP, updatesP]);
    const dateStr = now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate());
    const timeStr = pad(now.getUTCHours()) + "-" + pad(now.getUTCMinutes());
    const filePath = "extra/" + dateStr + "/" + timeStr + ".json";
    const capture = { f: data.fechaActualizacion || "", np: (data.trenesNoPosicionados || []).length, tr: trains };
    if (weather) { capture.wp = POINTS; capture.wv = WEATHER_VARS; capture.w = weather; }

    if (vehicles) capture.v = vehicles;
    if (updates) capture.u = updates;

    const body = JSON.stringify({
      message: "extra " + dateStr + " " + timeStr,
      content: Buffer.from(JSON.stringify(capture)).toString("base64"),
      branch: BRANCH,
    });
    const headers = { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
    let put, lastErr;
    // a new file needs no sha; 409 only means another job moved the branch tip meanwhile
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(400 + Math.random() * 1200);
      try {
        put = await fetch(REPO + filePath, { method: "PUT", headers, body, signal: AbortSignal.timeout(15000) });
        if (put.ok || put.status !== 409) break;
      } catch (e) { lastErr = e; put = null; }
    }
    if (!put) throw lastErr;
    if (put.status === 422) return res.status(200).json({ ok: true, duplicate: true, path: filePath }); // already saved this minute
    if (!put.ok) return res.status(500).json({ error: "github " + put.status, detail: await put.text() });

    return res.status(200).json({ ok: true, saved: trains.length, weather: !!weather, path: filePath });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
