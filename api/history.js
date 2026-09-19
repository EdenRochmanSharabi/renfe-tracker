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

export default async function handler(req, res) {
  const kv = getRedis();
  if (!kv) {
    return res.status(503).json({ error: "storage not configured" });
  }

  const type = req.query.type || "stats";
  const hours = Math.min(parseInt(req.query.hours, 10) || 24, 8760);
  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;

  try {
    const key = type === "routes" ? "route_stats" : "delay_stats";
    const raw = await kv.zrange(key, from, now, { byScore: true });

    const data = raw.map(entry => {
      if (typeof entry === "string") return JSON.parse(entry);
      return entry;
    });

    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ type, hours, count: data.length, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
