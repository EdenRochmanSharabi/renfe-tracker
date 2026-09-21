import { Redis } from "@upstash/redis";
import crypto from "crypto";

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

function hashVisitor(ip, ua) {
  return crypto.createHash("sha256").update((ip || "") + "|" + (ua || "")).digest("hex").slice(0, 16);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const kv = getRedis();
  if (!kv) return res.status(503).json({ error: "storage not configured" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
    const firstIp = ip.split(",")[0].trim();
    const ua = req.headers["user-agent"] || "";
    const vid = hashVisitor(firstIp, ua);
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const hour = new Date(now).toISOString().slice(0, 13);

    const country = req.headers["x-vercel-ip-country"] || "";
    const city = req.headers["x-vercel-ip-city"] || "";
    const region = req.headers["x-vercel-ip-country-region"] || "";

    const visit = {
      vid,
      ts: Math.floor(now / 1000),
      country,
      city,
      region,
      lang: String(body.lang || "").slice(0, 10),
      screen: String(body.screen || "").slice(0, 20),
      viewport: String(body.viewport || "").slice(0, 20),
      platform: String(body.platform || "").slice(0, 30),
      browser: String(body.browser || "").slice(0, 30),
      referrer: String(body.referrer || "").slice(0, 200),
      touch: !!body.touch,
      tz: String(body.tz || "").slice(0, 40),
      connection: String(body.connection || "").slice(0, 10),
    };

    const pipeline = kv.pipeline();

    pipeline.zadd("visits", { score: Math.floor(now / 1000), member: JSON.stringify(visit) });
    pipeline.sadd("visitors:" + today, vid);
    pipeline.expire("visitors:" + today, 400 * 86400);
    pipeline.hincrby("visits:daily", today, 1);
    pipeline.hincrby("visits:hourly", hour, 1);

    if (country) pipeline.hincrby("geo:countries", country, 1);
    if (body.browser) pipeline.hincrby("analytics:browsers", String(body.browser).slice(0, 30), 1);
    if (body.platform) pipeline.hincrby("analytics:platforms", String(body.platform).slice(0, 30), 1);
    if (body.screen) pipeline.hincrby("analytics:screens", String(body.screen).slice(0, 20), 1);
    if (body.referrer) pipeline.hincrby("analytics:referrers", String(body.referrer).slice(0, 100), 1);

    const oneYearAgo = Math.floor(now / 1000) - 365 * 86400;
    pipeline.zremrangebyscore("visits", 0, oneYearAgo);

    await pipeline.exec();

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
