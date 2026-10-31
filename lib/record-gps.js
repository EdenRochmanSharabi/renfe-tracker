const REPO = "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/";
const BRANCH = process.env.DATA_BRANCH || "data";

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

    // Read-modify-write the daily file. A concurrent commit to the branch (e.g. record-stats)
    // makes GitHub answer 409/422, so re-read and retry instead of dropping the snapshot.
    let daily, putResp, lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
      try {
        const getResp = await fetch(REPO + filePath + "?ref=" + BRANCH, {
          headers: ghHeaders,
          signal: AbortSignal.timeout(10000),
        });

        let fileSha;
        if (getResp.ok) {
          const existing = await getResp.json();
          fileSha = existing.sha;
          let text;
          if (existing.encoding === "none") {
            // over 1 MB the contents API omits the body: read it with the raw media type
            const raw = await fetch(REPO + filePath + "?ref=" + BRANCH, {
              headers: { ...ghHeaders, Accept: "application/vnd.github.raw+json" },
              signal: AbortSignal.timeout(20000),
            });
            if (!raw.ok) throw new Error("raw read " + raw.status);
            text = await raw.text();
          } else {
            text = Buffer.from(existing.content, "base64").toString();
          }
          daily = JSON.parse(text);
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
        const body = { message: "gps " + dateStr + " " + timeStr, content, branch: BRANCH };
        if (fileSha) body.sha = fileSha;

        putResp = await fetch(REPO + filePath, {
          method: "PUT",
          headers: ghHeaders,
          body: JSON.stringify(body),
        });
        if (putResp.ok || ![409, 422].includes(putResp.status)) break;
      } catch (e) { lastErr = e; putResp = null; }
    }
    if (!putResp) throw lastErr;

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
