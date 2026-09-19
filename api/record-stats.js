export default async function handler(req, res) {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const resp = await fetch(
      "https://renfe-tracker.vercel.app/api/fleet",
      { signal: AbortSignal.timeout(20000) }
    );
    if (!resp.ok) return res.status(resp.status).json({ error: "fleet " + resp.status });

    return res.status(200).json({ ok: true, triggered: true });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
