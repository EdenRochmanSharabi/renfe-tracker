// Planned timetable of the trains running now (schedule/YYYY-MM-DD/HH.json, one file per run):
// station code, planned arrival and planned departure. The route polylines ("secuencia") are
// dropped, they are static geometry. Comparing it with the live positions shows how far each
// train is from where it should be.
const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const BRANCH = process.env.DATA_BRANCH || "data";
const URL_ = "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/trenesConEstacionesLD.json";

const pad = (n) => String(n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GH_TOKEN not configured" });

  try {
    const get = () => fetch(URL_, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    let resp;
    try { resp = await get(); } catch { await sleep(1000); resp = await get(); } // transient network error
    if (!resp.ok) return res.status(resp.status).json({ error: "upstream " + resp.status });
    const data = await resp.json();

    const trains = (data.trenes || []).map((t) => [String(t.idTren), (t.estaciones || []).map((e) => [e.p, e.h, e.hs])]);
    if (!trains.length) return res.status(200).json({ ok: true, saved: 0 });

    const now = new Date();
    const dateStr = now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate());
    const hourStr = pad(now.getUTCHours());
    const filePath = "schedule/" + dateStr + "/" + hourStr + ".json";
    const body = JSON.stringify({
      message: "schedule " + dateStr + " " + hourStr,
      content: Buffer.from(JSON.stringify({ f: data.fechaActualizacion || "", tr: trains })).toString("base64"),
      branch: BRANCH,
    });
    const headers = { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
    let put, lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(400 + Math.random() * 1200);
      try {
        put = await fetch(REPO + filePath, { method: "PUT", headers, body, signal: AbortSignal.timeout(15000) });
        if (put.ok || put.status !== 409) break;
      } catch (e) { lastErr = e; put = null; }
    }
    if (!put) throw lastErr;
    if (put.status === 422) return res.status(200).json({ ok: true, duplicate: true, path: filePath });
    if (!put.ok) return res.status(500).json({ error: "github " + put.status, detail: await put.text() });
    return res.status(200).json({ ok: true, trains: trains.length, path: filePath });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
