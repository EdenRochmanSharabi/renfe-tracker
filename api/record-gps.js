export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
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
    for (const t of data.trenes || []) {
      const lat = Number(t.latitud);
      const lon = Number(t.longitud);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      const delay = parseInt(t.ultRetraso, 10);
      trains.push({
        id: String(t.codComercial || t.codCirculacion || ""),
        lat: +lat.toFixed(5),
        lon: +lon.toFixed(5),
        d: isFinite(delay) ? delay : 0,
        o: String(t.codOrigen || ""),
        dst: String(t.codDestino || ""),
        prev: String(t.codEstPrev || ""),
        next: String(t.codEstNext || ""),
        depPrev: t.depPrev || null,
        arrNext: t.arrNext || null,
      });
    }

    if (trains.length < 5) return res.status(200).json({ ok: true, saved: 0, skipped: "too few trains" });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = now.getUTCFullYear() + "-" + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate());
    const timeStr = pad(now.getUTCHours()) + "-" + pad(now.getUTCMinutes());
    const path = "gps/" + dateStr + "/" + timeStr + ".json";

    const content = Buffer.from(JSON.stringify(trains)).toString("base64");

    const ghResp = await fetch(
      "https://api.github.com/repos/EdenRochmanSharabi/renfe-tracker/contents/" + path,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + ghToken,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: "gps " + dateStr + " " + timeStr,
          content: content,
          branch: "data",
        }),
      }
    );

    if (!ghResp.ok) {
      const err = await ghResp.text();
      return res.status(500).json({ error: "github " + ghResp.status, detail: err });
    }

    return res.status(200).json({ ok: true, saved: trains.length, path: path });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
