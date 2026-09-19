import { Redis } from "@upstash/redis";

let redis = null;
function getRedis() {
  if (!redis && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return redis;
}

function computeStats(trains) {
  const delayed = trains.filter(t => t.delay >= 1);
  return {
    total: trains.length,
    delayed: delayed.length,
    avgDelay: delayed.length
      ? +(delayed.reduce((s, t) => s + t.delay, 0) / delayed.length).toFixed(1)
      : 0,
    maxDelay: trains.reduce((m, t) => Math.max(m, t.delay), 0),
    pctDelayed: trains.length
      ? +(delayed.length / trains.length * 100).toFixed(1)
      : 0,
  };
}

function computeRouteStats(trains) {
  const byRoute = {};
  for (const t of trains) {
    const key = t.origin + "-" + t.destination;
    if (!byRoute[key]) byRoute[key] = { delays: [], origin: t.origin, destination: t.destination };
    byRoute[key].delays.push(t.delay);
  }
  const routes = [];
  for (const key in byRoute) {
    const r = byRoute[key];
    if (r.delays.length < 1) continue;
    const del = r.delays.filter(d => d >= 1);
    routes.push({
      route: key,
      o: r.origin,
      d: r.destination,
      n: r.delays.length,
      avg: del.length ? +(del.reduce((s, d) => s + d, 0) / del.length).toFixed(1) : 0,
      max: Math.max(...r.delays),
      pct: +(del.length / r.delays.length * 100).toFixed(1),
    });
  }
  return routes;
}

function parseTrains(data) {
  const trains = [];
  for (const t of (data.trenes || [])) {
    const lat = Number(t.latitud);
    const lon = Number(t.longitud);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const delay = parseInt(t.ultRetraso, 10);
    trains.push({
      id: String(t.codComercial || t.codCirculacion || ""),
      delay: isFinite(delay) ? delay : 0,
      origin: String(t.codOrigen || ""),
      destination: String(t.codDestino || ""),
    });
  }
  return trains;
}

async function recordStats(kv, data) {
  try {
    const now = Date.now();
    const lastTs = await kv.get("last_stats_ts");
    if (lastTs && now - Number(lastTs) < 55000) return;

    const trains = parseTrains(data);
    if (!trains.length) return;
    const stats = computeStats(trains);
    const ts = Math.floor(now / 1000);

    const pipeline = kv.pipeline();
    pipeline.zadd("delay_stats", { score: ts, member: JSON.stringify({ ts, ...stats }) });
    pipeline.set("last_stats_ts", now);

    // Route summary every hour (when minute < 2)
    const minute = new Date(now).getMinutes();
    if (minute < 2) {
      const lastRouteTs = await kv.get("last_routes_ts");
      if (!lastRouteTs || now - Number(lastRouteTs) > 55 * 60 * 1000) {
        const routes = computeRouteStats(trains);
        pipeline.zadd("route_stats", { score: ts, member: JSON.stringify({ ts, routes }) });
        pipeline.set("last_routes_ts", now);
      }
    }

    // Prune data older than 1 year
    const oneYearAgo = ts - 365 * 86400;
    pipeline.zremrangebyscore("delay_stats", 0, oneYearAgo);
    pipeline.zremrangebyscore("route_stats", 0, oneYearAgo);

    await pipeline.exec();
  } catch (err) {
    console.warn("Stats recording failed:", err.message);
  }
}

export default async function handler(req, res) {
  try {
    const resp = await fetch(
      "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json",
      { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) return res.status(resp.status).json({ error: "upstream " + resp.status });
    const data = await resp.json();

    // Record stats in background (don't block the response)
    const kv = getRedis();
    if (kv) {
      recordStats(kv, data).catch(() => {});
    }

    res.setHeader("Cache-Control", "public, max-age=10");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
