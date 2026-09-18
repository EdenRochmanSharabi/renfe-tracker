/* Sirve la geometría ferroviaria pre-calculada (data/rail-network.json).
 * Datos estáticos generados por scripts/build-rail-geometry.js:
 * se cachean 24 h en cliente y CDN. */
import { readFileSync } from "node:fs";

let cachedBody = null;

function loadBody() {
  if (cachedBody) return cachedBody;
  // new URL(…, import.meta.url) es analizable estáticamente: Vercel
  // incluye el fichero en el bundle de la función.
  const dataUrl = new URL("../data/rail-network.json", import.meta.url);
  cachedBody = readFileSync(dataUrl, "utf8");
  return cachedBody;
}

export default function handler(req, res) {
  try {
    const body = loadBody();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800"
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).send(body);
  } catch (err) {
    return res.status(500).json({
      error: "rail network data unavailable: " + err.message,
    });
  }
}
