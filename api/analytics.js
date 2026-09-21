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

    function sanitize(s, maxLen) {
      return String(s || "").replace(/[<>"'&]/g, "").slice(0, maxLen);
    }
    const screenVal = sanitize(body.screen, 20);
    const browserVal = sanitize(body.browser, 30);
    const platformVal = sanitize(body.platform, 30);
    const referrerVal = sanitize(body.referrer, 100);

    const visit = {
      vid,
      ts: Math.floor(now / 1000),
      country,
      city,
      region,
      lang: sanitize(body.lang, 10),
      screen: screenVal,
      viewport: sanitize(body.viewport, 20),
      platform: platformVal,
      browser: browserVal,
      referrer: referrerVal,
      touch: !!body.touch,
      tz: sanitize(body.tz, 40),
      connection: sanitize(body.connection, 10),
    };

    const pipeline = kv.pipeline();

    pipeline.zadd("visits", { score: Math.floor(now / 1000), member: JSON.stringify(visit) });
    pipeline.sadd("visitors:" + today, vid);
    pipeline.expire("visitors:" + today, 400 * 86400);
    pipeline.sadd("visitors:all", vid);
    pipeline.hincrby("visits:daily", today, 1);
    pipeline.hincrby("visits:hourly", hour, 1);

    if (country) pipeline.hincrby("geo:countries", country, 1);
    if (browserVal) pipeline.hincrby("analytics:browsers", browserVal, 1);
    if (platformVal) pipeline.hincrby("analytics:platforms", platformVal, 1);
    if (screenVal) pipeline.hincrby("analytics:screens", screenVal, 1);
    if (referrerVal) pipeline.hincrby("analytics:referrers", referrerVal, 1);

    const oneYearAgo = Math.floor(now / 1000) - 365 * 86400;
    pipeline.zremrangebyscore("visits", 0, oneYearAgo);

    await pipeline.exec();

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
