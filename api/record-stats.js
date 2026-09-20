const GH_API = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const RENFE_URL = "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json";

function pad(n) { return String(n).padStart(2, "0"); }

async function ghGet(path, token) {
  const r = await fetch(GH_API + path + "?ref=data", {
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, "base64").toString()) };
}

async function ghPut(path, token, data, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify(data)).toString("base64"), branch: "data" };
  if (sha) body.sha = sha;
  const r = await fetch(GH_API + path, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return r.ok;
}

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const ghToken = process.env.GH_TOKEN;

  try {
    // Fetch fleet data and trigger Redis recording
    const [fleetResp, rawResp] = await Promise.all([
      fetch("https://renfe-tracker.vercel.app/api/fleet", { signal: AbortSignal.timeout(20000) }),
      fetch(RENFE_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }),
    ]);

    if (!fleetResp.ok) return res.status(fleetResp.status).json({ error: "fleet " + fleetResp.status });

    if (!rawResp.ok || !ghToken) {
      return res.status(200).json({ ok: true, redis: true, github: false });
    }

    const raw = await rawResp.json();
    const trains = [];
    for (const t of raw.trenes || []) {
      const delay = parseInt(t.ultRetraso, 10);
      if (!isFinite(delay)) continue;
      trains.push({
        id: String(t.codComercial || t.codCirculacion || ""),
        d: delay,
        o: String(t.codOrigen || ""),
        dst: String(t.codDestino || ""),
      });
    }

    if (!trains.length) return res.status(200).json({ ok: true, redis: true, github: false, reason: "no trains" });

    const now = new Date();
    const dateStr = now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate());
    const timeStr = pad(now.getUTCHours()) + "-" + pad(now.getUTCMinutes());
    const path = "stats/" + dateStr + ".json";

    const delayed = trains.filter(t => t.d >= 1);
    const snapshot = {
      total: trains.length,
      delayed: delayed.length,
      avg: delayed.length ? +(delayed.reduce((s, t) => s + t.d, 0) / delayed.length).toFixed(1) : 0,
      max: Math.max(...trains.map(t => t.d)),
      pct: +(delayed.length / trains.length * 100).toFixed(1),
    };

    // Per-route summary (only every hour to save space)
    const minute = now.getUTCMinutes();
    let routes = null;
    if (minute < 5) {
      const byRoute = {};
      for (const t of trains) {
        const key = t.o + "-" + t.dst;
        if (!byRoute[key]) byRoute[key] = { delays: [], o: t.o, d: t.dst };
        byRoute[key].delays.push(t.d);
      }
      routes = {};
      for (const key in byRoute) {
        const r = byRoute[key];
        const del = r.delays.filter(d => d >= 1);
        routes[key] = {
          n: r.delays.length,
          avg: del.length ? +(del.reduce((s, d) => s + d, 0) / del.length).toFixed(1) : 0,
          max: Math.max(...r.delays),
        };
      }
    }

    // Read existing daily file
    const existing = await ghGet(path, ghToken);
    let daily;
    if (existing) {
      daily = existing.data;
    } else {
      daily = { snapshots: {}, routes: {} };
    }

    daily.snapshots[timeStr] = snapshot;
    if (routes) daily.routes[timeStr] = routes;

    const ok = await ghPut(path, ghToken, daily, existing ? existing.sha : null, "stats " + dateStr + " " + timeStr);

    return res.status(200).json({
      ok: true,
      redis: true,
      github: ok,
      path,
      entries: Object.keys(daily.snapshots).length,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
