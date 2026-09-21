const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";

export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const ghToken = process.env.GH_TOKEN;
  if (!ghToken) return res.status(500).json({ error: "GH_TOKEN not configured" });

  try {
    const resp = await fetch(
      "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json",
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) return res.status(resp.status).json({ error: "upstream " + resp.status });
    const data = await resp.json();

    const trains = [];
    for (const t of (data.trenes || [])) {
      const lat = Number(t.latitud);
      const lon = Number(t.longitud);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const delay = parseInt(t.ultRetraso, 10);
      trains.push({
        id: String(t.codComercial || t.codCirculacion || ""),
        lat: Math.round(lat * 100000),
        lon: Math.round(lon * 100000),
        d: isFinite(delay) ? delay : 0,
        o: String(t.codOrigen || ""),
        dst: String(t.codDestino || ""),
      });
    }

    if (!trains.length) return res.status(200).json({ ok: true, saved: 0 });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate());
    const timeStr = pad(now.getUTCHours()) + "-" + pad(now.getUTCMinutes());
    const folder = trains.length < 20 ? "gps-night" : "gps";
    const filePath = folder + "/" + dateStr + ".json";

    const ghHeaders = {
      Authorization: "Bearer " + ghToken,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };

    // Fetch existing daily file
    const getResp = await fetch(REPO + filePath + "?ref=data", {
      headers: ghHeaders,
      signal: AbortSignal.timeout(10000),
    });

    let daily, fileSha;
    if (getResp.ok) {
      const existing = await getResp.json();
      fileSha = existing.sha;
      daily = JSON.parse(Buffer.from(existing.content, "base64").toString());
    } else {
      daily = { s: [], r: [], o: [], p: {} };
    }

    // Update station dictionary
    const stationSet = new Set(daily.s);
    for (const t of trains) {
      if (t.o && !stationSet.has(t.o)) { stationSet.add(t.o); daily.s.push(t.o); }
      if (t.dst && !stationSet.has(t.dst)) { stationSet.add(t.dst); daily.s.push(t.dst); }
    }
    const sIdx = {};
    daily.s.forEach((c, i) => { sIdx[c] = i; });

    // Update train order and routes
    const trainSet = new Set(daily.o);
    for (const t of trains) {
      if (!trainSet.has(t.id)) {
        trainSet.add(t.id);
        daily.o.push(t.id);
        daily.r.push([sIdx[t.o] ?? -1, sIdx[t.dst] ?? -1]);
      }
    }
    const tIdx = {};
    daily.o.forEach((id, i) => { tIdx[id] = i; });

    // Build snapshot: array indexed by train order, null for absent trains
    const snap = new Array(daily.o.length).fill(null);
    for (const t of trains) {
      snap[tIdx[t.id]] = [t.lat, t.lon, t.d];
    }
    daily.p[timeStr] = snap;

    // Write back to GitHub
    const content = Buffer.from(JSON.stringify(daily)).toString("base64");
    const body = { message: "gps " + dateStr + " " + timeStr, content, branch: "data" };
    if (fileSha) body.sha = fileSha;

    const putResp = await fetch(REPO + filePath, {
      method: "PUT",
      headers: ghHeaders,
      body: JSON.stringify(body),
    });

    if (!putResp.ok) {
      const err = await putResp.text();
      return res.status(500).json({ error: "github " + putResp.status, detail: err });
    }

    const snapCount = Object.keys(daily.p).length;
    return res.status(200).json({
      ok: true,
      saved: trains.length,
      path: filePath,
      snapshots: snapCount,
      stations: daily.s.length,
      trainIds: daily.o.length,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
