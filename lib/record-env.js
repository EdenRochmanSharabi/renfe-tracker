// Environmental context for incidents, one file per capture: env/YYYY-MM-DD/HH-MM.json
//   aemet [[level, phenomenon, zone, validity text, CAP file name]] from the AEMET warnings RSS (all active items, ~46).
//         Title is "Aviso. Nivel X. Fenomeno. Zona", description holds the validity ("... de 19:00 31-10-2026 CET (UTC+1) a ...").
//         CAP file name = link minus .../avisos/cap/ (the RSS has no per-item pubDate worth keeping, all equal).
//   ign   [[evid, magnitude, place, lat, lon, "dd/mm/yyyy h:mm:ss" UTC]] earthquakes with origin time in the last 30 min
//         (the IGN RSS has no pubDate, only the origin time in title/description). Omitted if none.
//   kp    {k: {time_tag, kp_index, estimated_kp} last 1-min point, a: [{product_id, issue_datetime, message}] alerts issued in the last 30 min}
//         "a" omitted if none.
//   ems   [{code, name, eventTime, lastUpdate, countries}] last 5 Copernicus EMS activations, only when UTC minute < 15 (hourly).
// Cron every 15 min. Each source is independent; a missing key in the file means that source failed or had nothing new.
// Attribution: AEMET (reuse with attribution, https://www.aemet.es/es/nota_legal), Instituto Geografico Nacional CC BY 4.0,
// NOAA SWPC public domain, Copernicus Emergency Management Service (Rapid Mapping).
const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const BRANCH = process.env.DATA_BRANCH || "data";
const AEMET = "https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_wah_RSS.xml";
const IGN = "https://www.ign.es/ign/RssTools/sismologia.xml";
const KP = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const ALERTS = "https://services.swpc.noaa.gov/products/alerts.json";
const EMS = "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?limit=5&ordering=-eventTime";
const WINDOW = 30 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r;
}
const items = (xml) => xml.split("<item>").slice(1).map((s) => s.split("</item>")[0]);
const tag = (s, t) => ((s.match(new RegExp("<" + t + ">([\\s\\S]*?)</" + t + ">")) || [])[1] || "").trim();

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return res.status(401).json({ error: "unauthorized" });
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GH_TOKEN not configured" });
  const now = new Date();
  const out = {}, errors = [];
  const run = async (key, fn) => { try { const v = await fn(); if (v !== undefined) out[key] = v; } catch (e) { errors.push(key + ": " + e.message); } };
  await Promise.all([
    run("aemet", async () => items(await (await get(AEMET)).text()).map((it) => {
      const [level = "", phen = "", ...zone] = tag(it, "title").replace(/^Aviso\.\s*/, "").split(/\.\s+/);
      const valid = tag(it, "description").replace(/^.*? de nivel \w+ /, "");
      return [level.replace(/^Nivel /, ""), phen, zone.join(". "), valid, tag(it, "link").split("/").pop()];
    })),
    run("ign", async () => {
      const rows = items(await (await get(IGN)).text()).map((it) => {
        const t = tag(it, "title").match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/);
        const d = tag(it, "description").match(/magnitud ([\d.]+) en (.*?) en la fecha/);
        if (!t || !d) return null;
        const ms = Date.UTC(+t[3], +t[2] - 1, +t[1], +t[4], +t[5], +t[6]); // IGN times are UTC
        return ms > now - WINDOW ? [tag(it, "guid").split("evid=")[1], +d[1], d[2], +tag(it, "geo:lat"), +tag(it, "geo:long"), t[0]] : null;
      }).filter(Boolean);
      return rows.length ? rows : undefined;
    }),
    run("kp", async () => {
      const [k, al] = await Promise.all([get(KP).then((r) => r.json()), get(ALERTS).then((r) => r.json())]);
      const p = k[k.length - 1];
      const a = al.filter((x) => Date.parse(x.issue_datetime.replace(" ", "T") + "Z") > now - WINDOW)
        .map((x) => ({ product_id: x.product_id, issue_datetime: x.issue_datetime, message: x.message }));
      const k1 = { time_tag: p.time_tag, kp_index: p.kp_index, estimated_kp: p.estimated_kp };
      return a.length ? { k: k1, a } : { k: k1 };
    }),
    now.getUTCMinutes() < 15 ? run("ems", async () => (await (await get(EMS)).json()).results.map((x) => ({
      code: x.code, name: x.name, eventTime: x.eventTime, lastUpdate: x.lastUpdate, countries: x.countries }))) : null,
  ]);
  if (!Object.keys(out).length) return res.status(502).json({ ok: false, errors });
  const path = "env/" + now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate()) + "/" + pad(now.getUTCHours()) + "-" + pad(now.getUTCMinutes()) + ".json";
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
