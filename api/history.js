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

async function getStats(kv, hours) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;
  const raw = await kv.zrange("delay_stats", from, now, { byScore: true });
  return raw.map(entry => typeof entry === "string" ? JSON.parse(entry) : entry);
}

async function getRouteSnapshots(kv, hours) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;
  const raw = await kv.zrange("route_stats", from, now, { byScore: true });
  return raw.map(entry => typeof entry === "string" ? JSON.parse(entry) : entry);
}

async function getDistribution(kv) {
  const raw = await kv.hgetall("dist:all");
  if (!raw) return [0, 0, 0, 0, 0];
  return [
    Number(raw.ontime) || 0,
    Number(raw.low) || 0,
    Number(raw.med) || 0,
    Number(raw.high) || 0,
    Number(raw.extreme) || 0,
  ];
}

async function getRouteAggregates(kv, topN) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await kv.scan(cursor, { match: "ragg:*", count: 200 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");

  if (!keys.length) return [];

  const pipeline = kv.pipeline();
  for (const k of keys) pipeline.hgetall(k);
  const results = await pipeline.exec();

  const rows = [];
  for (let i = 0; i < keys.length; i++) {
    const raw = results[i];
    if (!raw) continue;
    const route = keys[i].replace("ragg:", "");
    const n = Number(raw.n) || 0;
    const delayed = Number(raw.delayed) || 0;
    const sum = Number(raw.sum) || 0;
    if (n < 10 || !delayed) continue;
    rows.push({
      route,
      n,
      delayed,
      avgDelay: sum / delayed,
      pctDelayed: (100 * delayed) / n,
    });
  }
  rows.sort((a, b) => b.avgDelay - a.avgDelay);
  return rows.slice(0, topN || 20);
}

async function getAnalyticsSummary(kv) {
  const pipeline = kv.pipeline();
  pipeline.hgetall("visits:daily");
  pipeline.hgetall("geo:countries");
  pipeline.hgetall("analytics:browsers");
  pipeline.hgetall("analytics:platforms");
  pipeline.hgetall("analytics:screens");
  pipeline.hgetall("analytics:referrers");
  const [daily, countries, browsers, platforms, screens, referrers] = await pipeline.exec();

  const today = new Date().toISOString().slice(0, 10);
  const p2 = kv.pipeline();
  p2.scard("visitors:" + today);
  p2.scard("visitors:all");
  p2.zcard("visits");
  const [uniqueToday, uniqueAll, totalVisits] = await p2.exec();

  const dailyObj = daily || {};
  const totalFromDaily = Object.values(dailyObj).reduce((s, v) => s + Number(v), 0);

  return {
    daily: dailyObj,
    uniqueToday: uniqueToday || 0,
    uniqueAll: uniqueAll || 0,
    totalVisits: totalFromDaily || totalVisits || 0,
    countries: countries || {},
    browsers: browsers || {},
    platforms: platforms || {},
    screens: screens || {},
    referrers: referrers || {},
  };
}

export default async function handler(req, res) {
  const kv = getRedis();
  if (!kv) {
    return res.status(503).json({ error: "storage not configured" });
  }

  const type = req.query.type || "stats";
  const hours = Math.min(parseInt(req.query.hours, 10) || 24, 8760);

  try {
    let result;

    if (type === "stats") {
      const data = await getStats(kv, hours);
      result = { type, hours, count: data.length, data };
    } else if (type === "routes") {
      const data = await getRouteSnapshots(kv, hours);
      result = { type, hours, count: data.length, data };
    } else if (type === "dist") {
      const data = await getDistribution(kv);
      result = { type, data };
    } else if (type === "worstroutes") {
      const topN = Math.min(parseInt(req.query.top, 10) || 20, 50);
      const data = await getRouteAggregates(kv, topN);
      result = { type, count: data.length, data };
    } else if (type === "analytics") {
      const data = await getAnalyticsSummary(kv);
      result = { type, data };
    } else {
      return res.status(400).json({ error: "unknown type: " + type });
    }

    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
