/* ===========================================================
 * build-rail-geometry.js — Genera geometría ferroviaria real
 * a partir de OpenStreetMap (Overpass API).
 *
 * Uso:
 *   node scripts/build-rail-geometry.js [--refresh] [--tolerance 0.0005]
 *
 * Pasos:
 *   1. Descarga todas las vías railway=rail de España vía Overpass
 *      (cacheado en scripts/.cache/ para poder re-ejecutar sin red).
 *   2. Construye un grafo: cada nodo OSM es un vértice; cada vía
 *      conecta nodos adyacentes con peso = distancia haversine
 *      (las vías highspeed=yes reciben un factor 0.8 para preferir
 *      la línea de alta velocidad cuando hay alternativa clásica).
 *   3. Asocia cada estación del catálogo (js/stations.js) al nodo
 *      OSM más cercano (máx. 2 km; si no, aviso).
 *   4. Dijkstra entre cada par de estaciones → polilínea real.
 *   5. Simplifica (Douglas-Peucker) y escribe:
 *        data/rail-network.json   (segmentos por par de estaciones)
 *        data/rail-spain.geojson  (red completa, para depuración)
 *
 * Espacios de códigos: el feed de Renfe usa códigos que no siempre
 * coinciden con el catálogo estático (p. ej. 10600 es Córdoba en el
 * catálogo pero Valladolid en el feed). El JSON de salida incluye un
 * mapa "aliases" código-del-feed → código-canónico resuelto por
 * NOMBRE de estación; los códigos ambiguos se omiten para que el
 * cliente haga fallback a la secuencia del API.
 * =========================================================== */
"use strict";

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, "scripts", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "overpass-es-rail.json");
const DATA_DIR = path.join(ROOT, "data");
const OUT_NETWORK = path.join(DATA_DIR, "rail-network.json");
const OUT_GEOJSON = path.join(DATA_DIR, "rail-spain.geojson");

const MAX_SNAP_KM = 2;          // distancia máxima estación → nodo OSM
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // objetivo < 2 MB
const HIGHSPEED_FACTOR = 0.8;   // preferencia por vías de alta velocidad
const SERVICE_FACTOR = 3.0;     // penaliza apartaderos/haces (service=*) sin
                                // desconectarlos: en varias estaciones son el
                                // único enlace entre tramos de vía general
const STATION_GLUE_KM = 0.5;    // radio de "pegado" en estaciones: une el nodo
                                // de la estación con todas las vías cercanas.
                                // Modela la parada física del tren y salva la
                                // separación ancho ibérico ↔ ancho estándar
                                // (en OSM las redes de distinto ancho no se
                                // tocan y Dijkstra se vería forzado a rodear
                                // por la línea convencional)
const STATION_GLUE_WEIGHT = 0.05; // coste simbólico de esos enlaces (km)
const COORD_DECIMALS = 5;       // ~1 m de precisión

const args = process.argv.slice(2);
const REFRESH = args.includes("--refresh");
const tolIdx = args.indexOf("--tolerance");
let BASE_TOLERANCE = tolIdx >= 0 ? Number(args[tolIdx + 1]) : 0.0005;
if (!isFinite(BASE_TOLERANCE) || BASE_TOLERANCE <= 0) BASE_TOLERANCE = 0.0005;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OVERPASS_QUERY = `
[out:json][timeout:300];
area["ISO3166-1"="ES"][admin_level=2]->.spain;
(
  way["railway"="rail"](area.spain);
);
out geom;
`;

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

/* ---------- 0. Catálogo de estaciones (js/stations.js) ---------- */

function loadStationCatalog() {
  const code = readFileSync(path.join(ROOT, "js", "stations.js"), "utf8");
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "stations.js" });
  const { AVE_STATIONS, FEED_STATION_NAMES } = sandbox.RENFE;
  if (!AVE_STATIONS || !FEED_STATION_NAMES) {
    throw new Error("No se pudieron extraer AVE_STATIONS/FEED_STATION_NAMES de js/stations.js");
  }
  return { AVE_STATIONS, FEED_STATION_NAMES };
}

/** Normaliza un nombre de estación para compararlo (acentos, guiones…). */
function normName(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Mapa código-del-feed → código canónico del catálogo, resuelto por nombre.
 *  - Cada código del catálogo empieza mapeado a sí mismo.
 *  - Cada código del feed cuyo nombre coincide con una estación del
 *    catálogo se mapea a esa estación (sobrescribe la identidad).
 *  - Cada código del feed cuyo nombre NO existe en el catálogo se
 *    ELIMINA del mapa: el mismo código con otro significado en el
 *    catálogo sería una colisión (p. ej. 60200 = Aranjuez en el feed
 *    pero Chamartín en el catálogo).
 */
function buildAliases(AVE_STATIONS, FEED_STATION_NAMES) {
  const byName = {};
  for (const code in AVE_STATIONS) byName[normName(AVE_STATIONS[code].name)] = code;

  const aliases = {};
  for (const code in AVE_STATIONS) aliases[code] = code;

  let matched = 0, dropped = 0;
  for (const feedCode in FEED_STATION_NAMES) {
    const canonical = byName[normName(FEED_STATION_NAMES[feedCode])];
    if (canonical) {
      aliases[feedCode] = canonical;
      matched++;
    } else if (aliases[feedCode]) {
      delete aliases[feedCode]; // código ambiguo entre espacios
      dropped++;
    }
  }
  log(`Aliases: ${matched} códigos del feed resueltos por nombre, ${dropped} ambiguos descartados`);
  return aliases;
}

/* ---------- 1. Descarga Overpass ---------- */

async function fetchOverpass() {
  if (!REFRESH && existsSync(CACHE_FILE)) {
    const st = statSync(CACHE_FILE);
    log(`Usando caché Overpass: ${CACHE_FILE} (${(st.size / 1e6).toFixed(1)} MB, ${st.mtime.toISOString()})`);
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  let lastErr = null;
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      const waitS = 30 * round;
      log(`Reintento ${round + 1}/3 en ${waitS} s …`);
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        log(`Descargando red ferroviaria de España desde ${endpoint} …`);
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "renfe-tracker-rail-geometry/1.0",
          },
          body: "data=" + encodeURIComponent(OVERPASS_QUERY),
          signal: AbortSignal.timeout(600000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        const json = JSON.parse(text);
        if (!json.elements || !json.elements.length) throw new Error("respuesta sin elementos");
        writeFileSync(CACHE_FILE, text);
        log(`Descargados ${json.elements.length} ways (${(text.length / 1e6).toFixed(1)} MB); cacheado.`);
        return json;
      } catch (err) {
        lastErr = err;
        log(`Fallo con ${endpoint}: ${err.message}`);
      }
    }
  }
  throw new Error("Overpass no disponible: " + (lastErr && lastErr.message));
}

/* ---------- 2. Grafo ---------- */

const R_EARTH = 6371.0088;
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Extrae nodos y aristas de los ways de Overpass.
 * Devuelve { n, lats, lons, eSrc, eDst, eW } (aristas sin compactar:
 * permite añadir enlaces de estación antes de construir el CSR).
 */
function buildGraph(overpass) {
  const idIndex = new Map(); // id OSM → índice compacto
  const latsArr = [];
  const lonsArr = [];
  const eSrc = [];
  const eDst = [];
  const eW = [];

  let ways = 0;
  for (const el of overpass.elements) {
    if (el.type !== "way" || !el.nodes || !el.geometry) continue;
    if (el.nodes.length !== el.geometry.length) continue;
    ways++;
    const tags = el.tags || {};
    let factor = tags.highspeed === "yes" ? HIGHSPEED_FACTOR : 1.0;
    if (tags.service) factor *= SERVICE_FACTOR;

    let prevIdx = -1;
    for (let i = 0; i < el.nodes.length; i++) {
      const g = el.geometry[i];
      if (!g) { prevIdx = -1; continue; }
      const id = el.nodes[i];
      let idx = idIndex.get(id);
      if (idx === undefined) {
        idx = latsArr.length;
        idIndex.set(id, idx);
        latsArr.push(g.lat);
        lonsArr.push(g.lon);
      }
      if (prevIdx >= 0 && prevIdx !== idx) {
        const d = haversineKm(latsArr[prevIdx], lonsArr[prevIdx], g.lat, g.lon);
        const w = d * factor;
        eSrc.push(prevIdx); eDst.push(idx); eW.push(w);
        eSrc.push(idx); eDst.push(prevIdx); eW.push(w);
      }
      prevIdx = idx;
    }
  }

  const n = latsArr.length;
  log(`Grafo: ${ways} ways, ${n} nodos, ${eSrc.length / 2} aristas`);

  return {
    n,
    lats: Float64Array.from(latsArr),
    lons: Float64Array.from(lonsArr),
    eSrc,
    eDst,
    eW,
  };
}

/** Compacta las aristas en formato CSR: { offsets, targets, weights }. */
function buildCSR(graph) {
  const { n, eSrc, eDst, eW } = graph;
  const m = eSrc.length;
  const offsets = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) offsets[eSrc[e] + 1]++;
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  const targets = new Int32Array(m);
  const weights = new Float64Array(m);
  const cursor = Int32Array.from(offsets.subarray(0, n));
  for (let e = 0; e < m; e++) {
    const s = eSrc[e];
    const pos = cursor[s]++;
    targets[pos] = eDst[e];
    weights[pos] = eW[e];
  }
  return { n, offsets, targets, weights };
}

/* ---------- 3. Estación → nodo OSM más cercano ---------- */

/**
 * Coordenadas REALES de andén para estaciones cuyo catálogo estático
 * (js/stations.js) tiene posiciones aproximadas (>1 km de error).
 * Solo se usan para asociar la estación a la vía OSM; el catálogo que
 * pinta el mapa no se toca.
 */
const SNAP_OVERRIDES = {
  // Verificadas contra los nodos railway=station de OSM.
  "10600": { lat: 37.8884, lon: -4.7906 },  // Córdoba Central
  "11600": { lat: 38.6913, lon: -4.1119 },  // Puertollano
  "13200": { lat: 40.9102, lon: -4.0948 },  // Segovia-Guiomar
  "15211": { lat: 42.5951, lon: -5.5819 },  // León
  "31202": { lat: 39.0001, lon: -1.8473 },  // Albacete-Los Llanos
  "36300": { lat: 39.5218, lon: -1.1347 },  // Requena-Utiel (AV)
  "37400": { lat: 40.0340, lon: -2.1437 },  // Cuenca-Fernando Zóbel
  "50200": { lat: 38.9849, lon: -3.9131 },  // Ciudad Real Central
  "61200": { lat: 40.5864, lon: -3.1264 },  // Guadalajara-Yebes
  "71500": { lat: 41.1922, lon: 1.2736 },   // Camp de Tarragona
  "74500": { lat: 42.2647, lon: 2.9427 },   // Figueres-Vilafant
  "81600": { lat: 42.3690, lon: -3.6700 },  // Burgos-Rosa de Lima
  "94004": { lat: 37.0702, lon: -4.7197 },  // Antequera-Santa Ana
};

/**
 * Etiqueta las componentes conexas del grafo (BFS iterativa) y devuelve
 * { comp: Int32Array, giant: idComponenteMayor }. Asociar las estaciones
 * solo a la componente gigante evita que caigan en tramos aislados
 * (apartaderos, vías museo…) desde los que Dijkstra no llega a ningún sitio.
 */
function connectedComponents(csr) {
  const { n, offsets, targets } = csr;
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let nComp = 0;
  let giant = -1;
  let giantSize = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = nComp;
    let size = 0;
    while (head < tail) {
      const u = queue[head++];
      size++;
      const end = offsets[u + 1];
      for (let e = offsets[u]; e < end; e++) {
        const v = targets[e];
        if (comp[v] === -1) { comp[v] = nComp; queue[tail++] = v; }
      }
    }
    if (size > giantSize) { giantSize = size; giant = nComp; }
    nComp++;
  }
  log(`Componentes conexas: ${nComp}; la mayor tiene ${giantSize} nodos (${((giantSize / n) * 100).toFixed(1)} %)`);
  return { comp, giant };
}

function nearestNode(graph, lat, lon, maxKm, comp, giant) {
  const rad = Math.PI / 180;
  const cosLat = Math.cos(lat * rad);
  let best = -1;
  let bestD2 = Infinity;
  const { n, lats, lons } = graph;
  for (let i = 0; i < n; i++) {
    if (comp[i] !== giant) continue;
    const dLat = (lats[i] - lat) * 111.32;
    const dLon = (lons[i] - lon) * 111.32 * cosLat;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  const dKm = Math.sqrt(bestD2);
  return dKm <= maxKm ? { idx: best, dKm } : { idx: -1, dKm };
}

/* ---------- 4. Dijkstra (montículo binario con arrays) ---------- */

class MinHeap {
  constructor() { this.d = []; this.v = []; }
  get size() { return this.d.length; }
  push(dist, node) {
    const d = this.d, v = this.v;
    let i = d.length;
    d.push(dist); v.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p] <= d[i]) break;
      [d[p], d[i]] = [d[i], d[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const d = this.d, v = this.v;
    const topD = d[0], topV = v[0];
    const lastD = d.pop(), lastV = v.pop();
    if (d.length) {
      d[0] = lastD; v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < d.length && d[l] < d[s]) s = l;
        if (r < d.length && d[r] < d[s]) s = r;
        if (s === i) break;
        [d[s], d[i]] = [d[i], d[s]];
        [v[s], v[i]] = [v[i], v[s]];
        i = s;
      }
    }
    return [topD, topV];
  }
}

/** Dijkstra desde `source`; para cuando todos los `targetSet` están fijados. */
function dijkstra(csr, source, targetSet) {
  const { n, offsets, targets, weights } = csr;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  let remaining = targetSet.size;

  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(0, source);

  while (heap.size && remaining > 0) {
    const [du, u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (targetSet.has(u)) remaining--;
    const end = offsets[u + 1];
    for (let e = offsets[u]; e < end; e++) {
      const v = targets[e];
      if (done[v]) continue;
      const nd = du + weights[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  return { dist, prev };
}

/** Reconstruye el camino target→source como lista de índices source→target. */
function reconstructPath(prev, source, target) {
  const out = [];
  let cur = target;
  while (cur !== -1) {
    out.push(cur);
    if (cur === source) { out.reverse(); return out; }
    cur = prev[cur];
  }
  return null;
}

/* ---------- 5. Douglas-Peucker ---------- */

/** Simplifica una polilínea [[lon,lat],…]; tolerancia en grados de latitud. */
function simplifyDP(pts, tolerance) {
  const npts = pts.length;
  if (npts <= 2) return pts.slice();
  const midLat = pts[(npts / 2) | 0][1];
  const lonScale = Math.cos((midLat * Math.PI) / 180);
  const tol2 = tolerance * tolerance;

  const keep = new Uint8Array(npts);
  keep[0] = keep[npts - 1] = 1;
  const stack = [[0, npts - 1]];

  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0] * lonScale, ay = pts[a][1];
    const bx = pts[b][0] * lonScale, by = pts[b][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD2 = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * lonScale, py = pts[i][1];
      let d2;
      if (len2 === 0) {
        const ex = px - ax, ey = py - ay;
        d2 = ex * ex + ey * ey;
      } else {
        // distancia perpendicular al segmento (proyección acotada)
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
        d2 = ex * ex + ey * ey;
      }
      if (d2 > maxD2) { maxD2 = d2; maxI = i; }
    }
    if (maxD2 > tol2) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }

  const out = [];
  for (let i = 0; i < npts; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function roundCoord(x) {
  const f = 10 ** COORD_DECIMALS;
  return Math.round(x * f) / f;
}

/* ---------- Main ---------- */

async function main() {
  const t0 = Date.now();
  mkdirSync(DATA_DIR, { recursive: true });

  const { AVE_STATIONS, FEED_STATION_NAMES } = loadStationCatalog();
  const aliases = buildAliases(AVE_STATIONS, FEED_STATION_NAMES);

  const overpass = await fetchOverpass();
  const graph = buildGraph(overpass);

  /* GeoJSON de depuración con toda la red (simplificada por way). */
  const gjFeatures = [];
  for (const el of overpass.elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const coords = el.geometry
      .filter(Boolean)
      .map((g) => [g.lon, g.lat]);
    if (coords.length < 2) continue;
    const simple = simplifyDP(coords, BASE_TOLERANCE).map((c) => [
      roundCoord(c[0]),
      roundCoord(c[1]),
    ]);
    gjFeatures.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: simple },
      properties: {
        id: el.id,
        highspeed: (el.tags && el.tags.highspeed) === "yes" ? 1 : 0,
      },
    });
  }
  writeFileSync(
    OUT_GEOJSON,
    JSON.stringify({ type: "FeatureCollection", features: gjFeatures })
  );
  log(`Escrito ${OUT_GEOJSON} (${gjFeatures.length} ways, ${(statSync(OUT_GEOJSON).size / 1e6).toFixed(1)} MB)`);

  // Liberar la respuesta cruda antes de los Dijkstra.
  overpass.elements = null;

  /* Estación → nodo OSM (solo en la componente conexa principal). */
  let csr = buildCSR(graph);
  const { comp, giant } = connectedComponents(csr);
  const codes = Object.keys(AVE_STATIONS).sort();
  const stationNode = {}; // código → índice de nodo
  let glueEdges = 0;
  for (const code of codes) {
    const s = SNAP_OVERRIDES[code] || AVE_STATIONS[code];
    const { idx, dKm } = nearestNode(graph, s.lat, s.lon, MAX_SNAP_KM, comp, giant);
    if (idx < 0) {
      console.warn(`AVISO: sin nodo OSM a <${MAX_SNAP_KM} km de ${AVE_STATIONS[code].name} (${code}); más cercano a ${dKm.toFixed(2)} km`);
      continue;
    }
    stationNode[code] = idx;

    // "Pegado" de estación: enlaza el nodo elegido con todos los nodos
    // ferroviarios cercanos (cualquier componente/ancho de vía).
    const rad = Math.PI / 180;
    const cosLat = Math.cos(s.lat * rad);
    for (let i = 0; i < graph.n; i++) {
      if (i === idx) continue;
      const dLat = (graph.lats[i] - s.lat) * 111.32;
      const dLon = (graph.lons[i] - s.lon) * 111.32 * cosLat;
      if (dLat * dLat + dLon * dLon <= STATION_GLUE_KM * STATION_GLUE_KM) {
        graph.eSrc.push(idx); graph.eDst.push(i); graph.eW.push(STATION_GLUE_WEIGHT);
        graph.eSrc.push(i); graph.eDst.push(idx); graph.eW.push(STATION_GLUE_WEIGHT);
        glueEdges++;
      }
    }
    log(`  ${code} ${AVE_STATIONS[code].name} → nodo a ${(dKm * 1000).toFixed(0)} m${SNAP_OVERRIDES[code] ? " (coords corregidas)" : ""}`);
  }
  log(`Enlaces de estación añadidos: ${glueEdges}`);
  csr = buildCSR(graph); // recompactar con los enlaces de estación

  /* Dijkstra desde cada estación; extraer caminos hacia códigos mayores. */
  const snapped = codes.filter((c) => stationNode[c] !== undefined);
  const rawPaths = {}; // "a-b" (a<b) → [[lon,lat],…] orientado a→b
  let unreachable = 0;

  for (let i = 0; i < snapped.length - 1; i++) {
    const a = snapped[i];
    const targetsCodes = snapped.slice(i + 1);
    const targetSet = new Set(targetsCodes.map((c) => stationNode[c]));
    const { dist, prev } = dijkstra(csr, stationNode[a], targetSet);
    let found = 0;
    for (const b of targetsCodes) {
      const tIdx = stationNode[b];
      if (!isFinite(dist[tIdx])) { unreachable++; continue; }
      const idxPath = reconstructPath(prev, stationNode[a], tIdx);
      if (!idxPath || idxPath.length < 2) { unreachable++; continue; }
      rawPaths[`${a}-${b}`] = idxPath.map((k) => [graph.lons[k], graph.lats[k]]);
      found++;
    }
    log(`Dijkstra desde ${a} (${AVE_STATIONS[a].name}): ${found}/${targetsCodes.length} destinos`);
  }
  if (unreachable) console.warn(`AVISO: ${unreachable} pares sin camino en el grafo`);

  /* Simplificar; si el JSON supera el objetivo, subir la tolerancia. */
  let tolerance = BASE_TOLERANCE;
  let payload = null;
  let body = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const segments = {};
    let totalPts = 0;
    for (const key in rawPaths) {
      const simple = simplifyDP(rawPaths[key], tolerance).map((c) => [
        roundCoord(c[0]),
        roundCoord(c[1]),
      ]);
      segments[key] = simple;
      totalPts += simple.length;
    }
    payload = {
      generated: new Date().toISOString(),
      source: "OpenStreetMap (Overpass API), railway=rail, España",
      tolerance,
      stations: Object.fromEntries(
        snapped.map((c) => {
          const pos = SNAP_OVERRIDES[c] || AVE_STATIONS[c];
          return [c, { name: AVE_STATIONS[c].name, lat: pos.lat, lon: pos.lon }];
        })
      ),
      aliases,
      segments,
    };
    body = JSON.stringify(payload);
    log(`Tolerancia ${tolerance}: ${Object.keys(segments).length} segmentos, ${totalPts} puntos, ${(body.length / 1e6).toFixed(2)} MB`);
    if (body.length <= MAX_OUTPUT_BYTES) break;
    tolerance *= 2;
    log(`Supera ${(MAX_OUTPUT_BYTES / 1e6).toFixed(1)} MB; reintentando con tolerancia ${tolerance}`);
  }

  writeFileSync(OUT_NETWORK, body);
  log(`Escrito ${OUT_NETWORK} (${(body.length / 1e6).toFixed(2)} MB)`);
  log(`Completado en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
