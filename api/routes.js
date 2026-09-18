export default async function handler(req, res) {
  try {
    const resp = await fetch(
      "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/trenesConEstacionesLD.json",
      { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) return res.status(resp.status).json({ error: "upstream " + resp.status });
    const data = await resp.json();
    res.setHeader("Cache-Control", "public, max-age=30");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
