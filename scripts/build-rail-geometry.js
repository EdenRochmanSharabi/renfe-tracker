/* ===========================================================
 * build-rail-geometry.js — Genera geometría ferroviaria real
 * a partir de OpenStreetMap (Overpass API) para TODAS las rutas
 * del feed de Renfe.
 *
 * Uso:
 *   node scripts/build-rail-geometry.js [--refresh] [--refresh-routes] [--tolerance 0.0005]
 *
 * Pasos:
 *   1. Descarga todas las vías railway=rail de España vía Overpass
 *      (cacheado en scripts/.cache/ para poder re-ejecutar sin red).
 *   2. Descarga las rutas reales del feed de Renfe (también cacheado):
 *      cada tren trae una "secuencia" de waypoints con código de
 *      estación y coordenadas GPS. De ahí salen TODAS las estaciones
 *      (~1.4k) y todos los pares consecutivos que aparecen en rutas
 *      reales (~1.4k pares).
 *   3. Construye un grafo: cada nodo OSM es un vértice; cada vía
 *      conecta nodos adyacentes con peso = distancia haversine
 *      (las vías highspeed=yes reciben un factor 0.8 para preferir
 *      la línea de alta velocidad cuando hay alternativa clásica).
 *   4. Asocia cada estación del feed al nodo OSM más cercano
 *      (máx. 2 km; índice espacial de rejilla para no hacer fuerza
 *      bruta sobre ~270k nodos × ~1.4k estaciones).
 *   5. Dijkstra SOLO entre pares consecutivos (agrupado por origen
 *      para minimizar ejecuciones) → polilínea real por par.
 *   6. Simplifica (Douglas-Peucker) y escribe:
 *        data/rail-network.json   (segmentos por par consecutivo,
 *                                  estaciones y aliases)
 *        data/rail-spain.geojson  (red completa, para depuración)
 *
 * Espacios de códigos: el espacio CANÓNICO de salida es el del feed
 * de Renfe (es el que ve el cliente en tiempo real). El catálogo
 * estático (js/stations.js) usa otro espacio que COLISIONA con él
 * (p. ej. 10600 es Córdoba en el catálogo pero Valladolid en el
 * feed), así que:
 *   - aliases mapea cada código del feed a sí mismo (identidad), y
 *   - añade código-del-catálogo → código-del-feed resuelto por
 *     NOMBRE (con guardarraíl de distancia), solo cuando el código
 *     del catálogo no existe ya en el feed con otro significado.
 * =========================================================== */
"use strict";

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(ROOT, "scripts", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "overpass-es-pt-fr-rail.json");
const ROUTES_CACHE_FILE = path.join(CACHE_DIR, "renfe-routes.json");
const DATA_DIR = path.join(ROOT, "data");
const OUT_NETWORK = path.join(DATA_DIR, "rail-network.json");
const OUT_GEOJSON = path.join(DATA_DIR, "rail-spain.geojson");

const RENFE_ROUTES_URL =
  "https://tiempo-real.largorecorrido.renfe.com/renfe-visor/trenesConEstacionesLD.json";

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
const MIN_COMP_NODES = 50;      // tamaño mínimo de componente conexa para
                                // aceptar un snap (evita apartaderos y vías
                                // museo aisladas, pero admite redes grandes
                                // no conectadas a la gigante, p. ej. FEVE)
const GRID_CELL_DEG = 0.05;     // celda del índice espacial (~5.5 km en lat)
const OVERRIDE_GUARD_KM = 20;   // un SNAP_OVERRIDE solo aplica si está cerca
                                // de las coords del feed (los overrides están
                                // en el espacio de códigos del catálogo, que
                                // colisiona con el del feed)
const DIJKSTRA_CAP_SLACK = 4;   // tope de exploración: 4× la distancia en
                                // línea recta al destino más lejano + 50 km

const args = process.argv.slice(2);
const REFRESH = args.includes("--refresh");
const REFRESH_ROUTES = args.includes("--refresh-routes");
const tolIdx = args.indexOf("--tolerance");
let BASE_TOLERANCE = tolIdx >= 0 ? Number(args[tolIdx + 1]) : 0.0005;
if (!isFinite(BASE_TOLERANCE) || BASE_TOLERANCE <= 0) BASE_TOLERANCE = 0.0005;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OVERPASS_QUERY = `
[out:json][timeout:600];
(
  area["ISO3166-1"="ES"][admin_level=2]->.a;
  area["ISO3166-1"="PT"][admin_level=2]->.b;
  area["ISO3166-1"="FR"][admin_level=2]->.c;
);
(
  way["railway"="rail"](area.a);
  way["railway"="narrow_gauge"](area.a);
  way["railway"="rail"](area.b);
  way["railway"="narrow_gauge"](area.b);
  way["railway"="rail"]["highspeed"="yes"](area.c);
  way["railway"="rail"](42.0,-2.0,46.0,6.0);
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
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ---------- 1a. Descarga Overpass ---------- */

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
        log(`Descargando red ferroviaria de ES+PT+FR desde ${endpoint} …`);
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "renfe-tracker-rail-geometry/1.0",
          },
          body: "data=" + encodeURIComponent(OVERPASS_QUERY),
          signal: AbortSignal.timeout(900000),
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

/* ---------- 1b. Descarga rutas del feed de Renfe ---------- */

async function fetchRenfeRoutes() {
  if (!REFRESH_ROUTES && existsSync(ROUTES_CACHE_FILE)) {
    const st = statSync(ROUTES_CACHE_FILE);
    log(`Usando caché de rutas Renfe: ${ROUTES_CACHE_FILE} (${(st.size / 1e3).toFixed(0)} kB, ${st.mtime.toISOString()})`);
    return JSON.parse(readFileSync(ROUTES_CACHE_FILE, "utf8"));
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  let lastErr = null;
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      const waitS = 10 * round;
      log(`Reintento rutas ${round + 1}/3 en ${waitS} s …`);
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }
    try {
      log(`Descargando rutas del feed de Renfe: ${RENFE_ROUTES_URL} …`);
      const resp = await fetch(RENFE_ROUTES_URL, {
        headers: { "User-Agent": "renfe-tracker-rail-geometry/1.0" },
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const json = JSON.parse(text);
      if (!json.trenes || !json.trenes.length) throw new Error("respuesta sin trenes");
      writeFileSync(ROUTES_CACHE_FILE, text);
      log(`Descargados ${json.trenes.length} trenes (${(text.length / 1e3).toFixed(0)} kB); cacheado.`);
      return json;
    } catch (err) {
      lastErr = err;
      log(`Fallo descargando rutas: ${err.message}`);
    }
  }
  throw new Error("Feed de rutas Renfe no disponible: " + (lastErr && lastErr.message));
}

/**
 * Extrae del feed de rutas:
 *  - feedStations: Map código → {lat, lon} (coords GPS del propio feed;
 *    los waypoints de "secuencia" llevan código de estación).
 *  - pairs: Set de "a-b" (a<b) con todos los pares de paradas
 *    CONSECUTIVAS en "estaciones". Estos son los segmentos que
 *    railPathFor() en el cliente encadena (route.stations viene de
 *    "estaciones", no de "secuencia").
 */
function extractStationsAndPairs(routes) {
  const feedStations = new Map();
  const pairs = new Set();
  let trains = 0;
  for (const t of routes.trenes) {
    // Coordenadas: las aprendemos de "secuencia" (tiene GPS para cada waypoint).
    const seq = t.secuencia;
    if (Array.isArray(seq)) {
      for (const p of seq) {
        const c = p && p.c;
        if (c && isFinite(p.lat) && isFinite(p.lon) && !feedStations.has(c)) {
          feedStations.set(c, { lat: p.lat, lon: p.lon });
        }
      }
    }
    // Pares: de "estaciones" (paradas reales del tren, no waypoints intermedios).
    const est = t.estaciones;
    if (!Array.isArray(est) || est.length < 2) continue;
    trains++;
    for (let i = 0; i < est.length - 1; i++) {
      const a = est[i].p, b = est[i + 1].p;
      if (a && b && a !== b) {
        pairs.add(a < b ? `${a}-${b}` : `${b}-${a}`);
        // Asegurar que las estaciones de "estaciones" también tienen coordenadas.
        // Si no aparecen en secuencia, buscar su waypoint más cercano por código.
        for (const code of [a, b]) {
          if (!feedStations.has(code) && Array.isArray(seq)) {
            const wp = seq.find((p) => p && p.c === code);
            if (wp && isFinite(wp.lat) && isFinite(wp.lon)) {
              feedStations.set(code, { lat: wp.lat, lon: wp.lon });
            }
          }
        }
      }
    }
  }
  log(`Feed: ${trains} trenes → ${feedStations.size} estaciones únicas, ${pairs.size} pares consecutivos únicos (de "estaciones")`);
  return { feedStations, pairs };
}

/* ---------- 1c. Aliases y nombres ---------- */

/**
 * Nombres legibles por código del feed:
 *  1. FEED_STATION_NAMES (verificado empíricamente contra el feed).
 *  2. AVE_STATIONS solo si sus coords están a <20 km de las del feed
 *     (guardarraíl contra la colisión de espacios de códigos).
 */
function buildStationNames(feedStations, AVE_STATIONS, FEED_STATION_NAMES) {
  const names = {};
  let fromFeedMap = 0, fromCatalog = 0;
  for (const [code, pos] of feedStations) {
    if (FEED_STATION_NAMES[code]) {
      names[code] = FEED_STATION_NAMES[code];
      fromFeedMap++;
      continue;
    }
    const cat = AVE_STATIONS[code];
    if (cat && haversineKm(cat.lat, cat.lon, pos.lat, pos.lon) < OVERRIDE_GUARD_KM) {
      names[code] = cat.name;
      fromCatalog++;
    }
  }
  log(`Nombres: ${fromFeedMap} del mapeo verificado, ${fromCatalog} del catálogo, ${feedStations.size - fromFeedMap - fromCatalog} sin nombre (el cliente enseñará el código)`);
  return names;
}

/**
 * Aliases código-del-feed → código canónico. El espacio canónico ES el
 * del feed, así que cada código descubierto se mapea a sí mismo.
 * Además, los códigos del catálogo estático que NO existen en el feed
 * se resuelven por nombre hacia su código del feed (con guardarraíl de
 * distancia), para que un cliente que aún use códigos del catálogo
 * siga encontrando segmento.
 */
function buildAliases(feedStations, AVE_STATIONS, FEED_STATION_NAMES) {
  const aliases = {};
  for (const code of feedStations.keys()) aliases[code] = code;

  // nombre normalizado → código del feed (solo nombres sin ambigüedad)
  const feedByName = new Map();
  for (const feedCode in FEED_STATION_NAMES) {
    if (!feedStations.has(feedCode)) continue;
    const key = normName(FEED_STATION_NAMES[feedCode]);
    if (feedByName.has(key)) feedByName.set(key, null); // ambiguo
    else feedByName.set(key, feedCode);
  }

  let mapped = 0, skipped = 0;
  for (const catCode in AVE_STATIONS) {
    if (aliases[catCode]) continue; // el código ya existe en el feed: identidad
    const feedCode = feedByName.get(normName(AVE_STATIONS[catCode].name));
    if (!feedCode) { skipped++; continue; }
    const cat = AVE_STATIONS[catCode];
    const pos = feedStations.get(feedCode);
    if (haversineKm(cat.lat, cat.lon, pos.lat, pos.lon) < OVERRIDE_GUARD_KM) {
      aliases[catCode] = feedCode;
      mapped++;
    } else skipped++;
  }
  log(`Aliases: ${feedStations.size} identidades del feed, ${mapped} códigos del catálogo resueltos por nombre, ${skipped} no resolubles`);
  return aliases;
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
 * OJO: las claves están en el espacio de códigos del CATÁLOGO, que
 * colisiona con el del feed (p. ej. 13200 es Segovia-Guiomar en el
 * catálogo pero Bilbao-Abando en el feed). Por eso cada override solo
 * se aplica si está a <OVERRIDE_GUARD_KM de las coords del feed.
 */
/**
 * Coordenadas de estaciones extranjeras (francesas) que aparecen en rutas
 * del feed pero cuya "secuencia" no trae waypoints GPS. Sin estas coords
 * el script no puede asociarlas a nodos OSM y los segmentos
 * transfronterizos quedan sin trazar. Verificadas contra OSM/Nominatim.
 */
const FOREIGN_STATIONS = {
  "87004": { lat: 47.9265, lon: 1.9069 },  // Les Aubrais-Orleans
  "87011": { lat: 48.8418, lon: 2.3661 },  // Paris Austerlitz
  "87013": { lat: 48.8448, lon: 2.3735 },  // Paris Gare de Lyon
  "87078": { lat: 43.3363, lon: 3.2191 },  // Beziers
  "87079": { lat: 43.6114, lon: 1.4556 },  // Toulouse Matabiau
  "87081": { lat: 46.5822, lon: 0.3331 },  // Poitiers
  "87088": { lat: 43.1893, lon: 3.0053 },  // Narbonne
  "87089": { lat: 43.3023, lon: 5.3808 },  // Marseille St Charles
  "87173": { lat: 43.6037, lon: 3.8792 },  // Montpellier St Roch
  "87175": { lat: 43.4128, lon: 3.6986 },  // Sete
  "87176": { lat: 43.2181, lon: 2.3518 },  // Carcassonne
  "87287": { lat: 43.3173, lon: 3.4663 },  // Agde
  "87300": { lat: 43.6037, lon: 3.8792 },  // Montpellier Saint-Roch (alias)
  "87302": { lat: 43.8316, lon: 4.3676 },  // Nimes
  "87303": { lat: 45.7616, lon: 4.8593 },  // Lyon Part Dieu
  "87374": { lat: 42.6962, lon: 2.8797 },  // Perpignan
  "87402": { lat: 43.9228, lon: 4.7850 },  // Avignon TGV
  "87546": { lat: 47.5855, lon: 1.3234 },  // Blois-Chambord
  "87810": { lat: 44.9919, lon: 4.9784 },  // Valence TGV Rhone-Alpes Sud
  "87814": { lat: 43.9228, lon: 4.7850 },  // Avignon TGV (alias)
  "87896": { lat: 43.9228, lon: 4.7850 },  // Avignon TGV (alias)
  "87901": { lat: 43.4551, lon: 5.3173 },  // Aix-en-Provence TGV
  "87912": { lat: 43.4551, lon: 5.3173 },  // Aix-en-Provence TGV (alias)
  "87973": { lat: 43.5953, lon: 3.9243 },  // Montpellier Sud de France
  // Portugal (Celta Vigo-Porto + inland routes)
  "94021": { lat: 41.4547, lon: -8.5443 },  // Nine
  "94033": { lat: 41.6952, lon: -8.8316 },  // Viana do Castelo
  "94346": { lat: 41.1492, lon: -8.5847 },  // Porto-Campanha
  "94401": { lat: 38.7146, lon: -9.1220 },  // Lisboa-Santa Apolonia
  "94404": { lat: 38.7678, lon: -9.0991 },  // Lisboa-Oriente
  "94428": { lat: 39.4616, lon: -8.4737 },  // Entroncamento
  "94438": { lat: 39.9165, lon: -8.6302 },  // Pombal
  "94452": { lat: 40.2247, lon: -8.4405 },  // Coimbra-B
  "94563": { lat: 40.6061, lon: -6.8292 },  // Vilar Formoso
  "96122": { lat: 41.5368, lon: -8.6090 },  // Barcelos
  // Frontera vasca (Irun-Hendaye)
  "11511": { lat: 43.3177, lon: -1.9769 },  // San Sebastian-Donostia
  "11515": { lat: 43.3190, lon: -1.9171 },  // Pasaia
  "11516": { lat: 43.3160, lon: -1.8993 },  // Lezo-Renteria
  "11602": { lat: 43.3531, lon: -1.7819 },  // Hendaye
  // Frontera gallega (Tui)
  "22401": { lat: 42.0658, lon: -8.6226 },  // Tui (Guillarei)
};

const EXTRA_PAIRS = [
  // Francia: Lyon - Barcelona (AVE internacional)
  ["87303", "87810"],  // Lyon Part Dieu - Valence TGV
  ["87302", "87810"],  // Nimes - Valence TGV
  ["87173", "87302"],  // Montpellier St Roch - Nimes
  ["87088", "87173"],  // Narbonne - Montpellier St Roch
  ["87088", "87374"],  // Narbonne - Perpignan
  ["04307", "87374"],  // Figueres-Vilafant - Perpignan
  // Francia: ramales adicionales
  ["87078", "87088"],  // Beziers - Narbonne
  ["87176", "87088"],  // Carcassonne - Narbonne
  ["87079", "87176"],  // Toulouse - Carcassonne
  ["87175", "87173"],  // Sete - Montpellier
  ["87287", "87175"],  // Agde - Sete
  ["87078", "87287"],  // Beziers - Agde
  ["87302", "87402"],  // Nimes - Avignon TGV
  ["87089", "87402"],  // Marseille - Avignon TGV
  // Frontera vasca: San Sebastian - Hendaye
  ["11505", "11511"],  // Andoain - San Sebastian
  ["11511", "11515"],  // San Sebastian - Pasaia
  ["11515", "11516"],  // Pasaia - Lezo-Renteria
  ["11516", "11602"],  // Lezo-Renteria - Hendaye
  // Celta: Tui -> Porto
  ["22401", "94033"],  // Tui - Viana do Castelo
  ["94033", "96122"],  // Viana do Castelo - Barcelos
  ["96122", "94021"],  // Barcelos - Nine
  ["94021", "94346"],  // Nine - Porto-Campanha
  // Porto - Lisboa (linha do Norte)
  ["94346", "94452"],  // Porto-Campanha - Coimbra-B
  ["94452", "94428"],  // Coimbra-B - Entroncamento
  ["94428", "94404"],  // Entroncamento - Lisboa-Oriente
  ["94404", "94401"],  // Lisboa-Oriente - Lisboa-Santa Apolonia
];

const SNAP_OVERRIDES = {
  // Coordenadas verificadas contra nodos railway=station de OSM.
  // CUIDADO: las claves están en el espacio del CATÁLOGO estático y
  // colisionan con el del feed. OVERRIDE_GUARD_KM rechaza los que
  // están lejos de la posición real del feed, pero hay que evitar
  // meter códigos que en el feed apuntan a otra estación cercana.
  // Códigos que NO existen en el feed (sin riesgo de colisión):
  "11600": { lat: 38.6913, lon: -4.1119 },  // Puertollano
  "31202": { lat: 39.0001, lon: -1.8473 },  // Albacete-Los Llanos
  "36300": { lat: 39.5218, lon: -1.1347 },  // Requena-Utiel (AV)
  "74500": { lat: 42.2647, lon: 2.9427 },   // Figueres-Vilafant
  "81600": { lat: 42.3690, lon: -3.6700 },  // Burgos-Rosa de Lima
};

/**
 * Etiqueta las componentes conexas del grafo (BFS iterativa) y devuelve
 * { comp: Int32Array, sizes: Int32Array, giant }. Los snaps solo se
 * aceptan en componentes de ≥ MIN_COMP_NODES nodos: evita apartaderos
 * y vías museo aisladas, pero admite redes grandes no conectadas a la
 * gigante (ancho métrico del norte, etc.); los enlaces de estación las
 * "pegan" después al resto.
 */
function connectedComponents(csr) {
  const { n, offsets, targets } = csr;
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const sizesArr = [];
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
    sizesArr.push(size);
    if (size > giantSize) { giantSize = size; giant = nComp; }
    nComp++;
  }
  log(`Componentes conexas: ${nComp}; la mayor tiene ${giantSize} nodos (${((giantSize / n) * 100).toFixed(1)} %)`);
  return { comp, sizes: Int32Array.from(sizesArr), giant };
}

/**
 * Índice espacial de rejilla (celdas de GRID_CELL_DEG grados) sobre los
 * nodos del grafo. Sustituye la búsqueda O(n) por nodo: con ~270k nodos
 * y ~1.4k estaciones la fuerza bruta serían ~370M comparaciones.
 */
class NodeGrid {
  constructor(graph) {
    this.graph = graph;
    this.cells = new Map(); // "cx:cy" → array de índices de nodo
    const { n, lats, lons } = graph;
    for (let i = 0; i < n; i++) {
      const key = this._key(this._cx(lons[i]), this._cy(lats[i]));
      let arr = this.cells.get(key);
      if (!arr) { arr = []; this.cells.set(key, arr); }
      arr.push(i);
    }
  }
  _cx(lon) { return Math.floor(lon / GRID_CELL_DEG); }
  _cy(lat) { return Math.floor(lat / GRID_CELL_DEG); }
  _key(cx, cy) { return cx + ":" + cy; }

  /**
   * Nodo más cercano a (lat, lon) que cumpla `accept(i)`, a ≤ maxKm.
   * Explora anillos de celdas crecientes; para cuando el mejor
   * candidato es más cercano que el borde interior del siguiente anillo.
   */
  nearest(lat, lon, maxKm, accept) {
    const { lats, lons } = this.graph;
    const rad = Math.PI / 180;
    const cosLat = Math.cos(lat * rad);
    const cx0 = this._cx(lon), cy0 = this._cy(lat);
    const cellKmY = GRID_CELL_DEG * 111.32; // alto de celda en km
    const maxRing = Math.ceil(maxKm / Math.min(cellKmY, cellKmY * Math.max(cosLat, 0.1))) + 1;

    let best = -1, bestD2 = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      // si ya hay candidato más cercano que el borde interior del anillo, listo
      const innerKm = (ring - 1) * cellKmY * Math.min(1, cosLat);
      if (best >= 0 && innerKm > 0 && bestD2 <= innerKm * innerKm) break;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // solo el anillo
          const arr = this.cells.get(this._key(cx0 + dx, cy0 + dy));
          if (!arr) continue;
          for (const i of arr) {
            if (accept && !accept(i)) continue;
            const dLat = (lats[i] - lat) * 111.32;
            const dLon = (lons[i] - lon) * 111.32 * cosLat;
            const d2 = dLat * dLat + dLon * dLon;
            if (d2 < bestD2) { bestD2 = d2; best = i; }
          }
        }
      }
    }
    const dKm = Math.sqrt(bestD2);
    return dKm <= maxKm ? { idx: best, dKm } : { idx: -1, dKm };
  }

  /** Índices de nodo a ≤ radiusKm de (lat, lon). */
  within(lat, lon, radiusKm) {
    const { lats, lons } = this.graph;
    const rad = Math.PI / 180;
    const cosLat = Math.cos(lat * rad);
    const degLat = radiusKm / 111.32;
    const degLon = radiusKm / (111.32 * Math.max(cosLat, 0.1));
    const r2 = radiusKm * radiusKm;
    const out = [];
    const cxMin = this._cx(lon - degLon), cxMax = this._cx(lon + degLon);
    const cyMin = this._cy(lat - degLat), cyMax = this._cy(lat + degLat);
    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cy = cyMin; cy <= cyMax; cy++) {
        const arr = this.cells.get(this._key(cx, cy));
        if (!arr) continue;
        for (const i of arr) {
          const dLat = (lats[i] - lat) * 111.32;
          const dLon = (lons[i] - lon) * 111.32 * cosLat;
          if (dLat * dLat + dLon * dLon <= r2) out.push(i);
        }
      }
    }
    return out;
  }
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

/**
 * Dijkstra desde `source`; para cuando todos los `targetSet` están
 * fijados o cuando la distancia supera `maxDist` (evita explorar toda
 * la componente si algún destino es inalcanzable).
 */
function dijkstra(csr, source, targetSet, maxDist) {
  const { n, offsets, targets, weights } = csr;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  let remaining = targetSet.size;
  const cap = isFinite(maxDist) ? maxDist : Infinity;

  const heap = new MinHeap();
  dist[source] = 0;
  heap.push(0, source);

  while (heap.size && remaining > 0) {
    const [du, u] = heap.pop();
    if (done[u]) continue;
    if (du > cap) break;
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
  const routes = await fetchRenfeRoutes();
  const { feedStations, pairs } = extractStationsAndPairs(routes);

  // Inyectar estaciones extranjeras que no traen coords en la secuencia del feed.
  let injected = 0;
  for (const code in FOREIGN_STATIONS) {
    if (!feedStations.has(code)) {
      const fs = FOREIGN_STATIONS[code];
      feedStations.set(code, { lat: fs.lat, lon: fs.lon });
      injected++;
    }
  }
  if (injected) log(`Inyectadas ${injected} estaciones extranjeras sin coords en el feed`);

  let extraPairsAdded = 0;
  for (const [a, b] of EXTRA_PAIRS) {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (!pairs.has(key)) { pairs.add(key); extraPairsAdded++; }
  }
  if (extraPairsAdded) log(`Inyectados ${extraPairsAdded} pares transfronterizos manuales`);

  const stationNames = buildStationNames(feedStations, AVE_STATIONS, FEED_STATION_NAMES);
  const aliases = buildAliases(feedStations, AVE_STATIONS, FEED_STATION_NAMES);

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

  /* Estación → nodo OSM (componentes de ≥ MIN_COMP_NODES nodos). */
  let csr = buildCSR(graph);
  const { comp, sizes } = connectedComponents(csr);
  const grid = new NodeGrid(graph);
  const acceptNode = (i) => sizes[comp[i]] >= MIN_COMP_NODES;

  const codes = [...feedStations.keys()].sort();
  const stationNode = {}; // código del feed → índice de nodo
  let glueEdges = 0;
  let snapped = 0, overridden = 0, unsnapped = 0;
  const tSnap = Date.now();
  for (const code of codes) {
    const feedPos = feedStations.get(code);
    let s = feedPos;
    const ov = SNAP_OVERRIDES[code];
    if (ov && haversineKm(ov.lat, ov.lon, feedPos.lat, feedPos.lon) < OVERRIDE_GUARD_KM) {
      s = ov; // el override pertenece de verdad a esta estación
      overridden++;
    }
    const { idx, dKm } = grid.nearest(s.lat, s.lon, MAX_SNAP_KM, acceptNode);
    if (idx < 0) {
      console.warn(`AVISO: sin nodo OSM a <${MAX_SNAP_KM} km de ${stationNames[code] || "?"} (${code}); más cercano a ${isFinite(dKm) ? dKm.toFixed(2) : "∞"} km`);
      unsnapped++;
      continue;
    }
    stationNode[code] = idx;
    snapped++;

    // "Pegado" de estación: enlaza el nodo elegido con todos los nodos
    // ferroviarios cercanos (cualquier componente/ancho de vía).
    for (const i of grid.within(s.lat, s.lon, STATION_GLUE_KM)) {
      if (i === idx) continue;
      graph.eSrc.push(idx); graph.eDst.push(i); graph.eW.push(STATION_GLUE_WEIGHT);
      graph.eSrc.push(i); graph.eDst.push(idx); graph.eW.push(STATION_GLUE_WEIGHT);
      glueEdges++;
    }
  }
  log(`Snap: ${snapped}/${codes.length} estaciones asociadas a nodo OSM (${overridden} con coords corregidas, ${unsnapped} sin nodo cercano) en ${((Date.now() - tSnap) / 1000).toFixed(1)} s`);
  log(`Enlaces de estación añadidos: ${glueEdges}`);
  csr = buildCSR(graph); // recompactar con los enlaces de estación

  /* Dijkstra SOLO entre pares consecutivos. Cada par se asigna al
   * extremo con más vecinos (los nudos concentran pares) para
   * minimizar el número de ejecuciones. */
  const degree = new Map();
  const validPairs = [];
  let pairsUnsnapped = 0;
  for (const key of pairs) {
    const [a, b] = key.split("-");
    if (stationNode[a] === undefined || stationNode[b] === undefined) {
      pairsUnsnapped++;
      continue;
    }
    validPairs.push([a, b]);
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
  }
  if (pairsUnsnapped) console.warn(`AVISO: ${pairsUnsnapped} pares descartados por estación sin snap`);

  const bySource = new Map(); // código origen → array de códigos destino
  for (const [a, b] of validPairs) {
    const da = degree.get(a), db = degree.get(b);
    const src = da > db || (da === db && a < b) ? a : b;
    const dst = src === a ? b : a;
    let arr = bySource.get(src);
    if (!arr) { arr = []; bySource.set(src, arr); }
    arr.push(dst);
  }

  const rawPaths = {}; // "a-b" (a<b) → [[lon,lat],…] orientado a→b
  let unreachable = 0;
  let runs = 0;
  const tDij = Date.now();
  for (const [src, dsts] of bySource) {
    const sNode = stationNode[src];
    const targetSet = new Set(dsts.map((c) => stationNode[c]));
    // Tope de exploración proporcional al destino más lejano en línea recta.
    const sPos = feedStations.get(src);
    let maxStraight = 0;
    for (const c of dsts) {
      const p = feedStations.get(c);
      const d = haversineKm(sPos.lat, sPos.lon, p.lat, p.lon);
      if (d > maxStraight) maxStraight = d;
    }
    const cap = maxStraight * DIJKSTRA_CAP_SLACK + 50;
    const { dist, prev } = dijkstra(csr, sNode, targetSet, cap);
    runs++;
    for (const dst of dsts) {
      const tIdx = stationNode[dst];
      const key = src < dst ? `${src}-${dst}` : `${dst}-${src}`;
      if (!isFinite(dist[tIdx])) { unreachable++; continue; }
      const idxPath = reconstructPath(prev, sNode, tIdx);
      if (!idxPath || idxPath.length < 2) { unreachable++; continue; }
      if (src > dst) idxPath.reverse(); // clave "a-b" con a<b, orientada a→b
      rawPaths[key] = idxPath.map((k) => [graph.lons[k], graph.lats[k]]);
    }
  }
  log(`Dijkstra: ${runs} ejecuciones para ${validPairs.length} pares en ${((Date.now() - tDij) / 1000).toFixed(1)} s`);
  if (unreachable) console.warn(`AVISO: ${unreachable} pares sin camino en el grafo`);

  /* Simplificar; si el JSON supera el objetivo, subir la tolerancia. */
  const stationsOut = {};
  for (const code of codes) {
    const pos = feedStations.get(code);
    const entry = { lat: roundCoord(pos.lat), lon: roundCoord(pos.lon) };
    if (stationNames[code]) entry.name = stationNames[code];
    if (FOREIGN_STATIONS[code]) entry.foreign = true;
    stationsOut[code] = entry;
  }

  let tolerance = BASE_TOLERANCE;
  let payload = null;
  let body = "";
  for (let attempt = 0; attempt < 6; attempt++) {
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
      source: "OpenStreetMap (Overpass API), railway=rail|narrow_gauge, ES+PT+FR + feed Renfe LD",
      tolerance,
      stations: stationsOut,
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
