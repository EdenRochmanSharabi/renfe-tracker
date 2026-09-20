/* ===========================================================
 * map.js — Mapa MapLibre GL: teselas vectoriales renderizadas
 * en GPU (zoom continuo y fluido), tema oscuro de centro de
 * mando definido en el propio estilo, rutas con resplandor
 * (line-blur) y trenes como capas de círculos data-driven.
 *
 * API pública (idéntica a la versión Leaflet):
 *   init(containerId, clickHandler)
 *   updateTrains(trains, routes)
 *   selectTrain(id, train, route)
 * =========================================================== */
"use strict";

window.RENFE = window.RENFE || {};

RENFE.Map = (function () {
  let map = null;
  let onTrainClick = null;
  let selectedId = null;

  // Último estado recibido: permite repoblar las fuentes tras un
  // cambio de estilo (fallback) o al cambiar la selección.
  let lastTrains = [];
  let lastRoutes = {};
  // Ruta del tren seleccionado (puede venir de selectTrain aunque el
  // tren esté filtrado y no aparezca en lastRoutes).
  let selRoute = null;

  let overlaysReady = false;   // fuentes/capas superpuestas añadidas
  let handlersBound = false;   // eventos delegados registrados
  let usedFallback = false;    // ya se cambió al estilo raster
  let styleEverLoaded = false; // el estilo vectorial llegó a cargar

  /* ---------- Movimiento continuo de trenes ---------- */
  const prevPos = {};    // trainId → {lon, lat} (posición anterior del API)
  const targetPos = {};  // trainId → {lon, lat} (posición actual del API)
  const routePolylines = {}; // trainId → {coords, cumDist}
  const routeDisplayGeom = {}; // trainId → GeoJSON geometry (MultiLineString/LineString)
  const prevArc = {};        // trainId → arco (m) de la posición anterior
  const targetArc = {};      // trainId → arco (m) de la posición actual
  const MAX_SNAP_M = 10000;
  const MAX_ARC_JUMP_M = 4000;
  let animStart = 0;
  const POLL_MS = 15000;
  let animFrameId = null;
  let animRunning = false;

  /* ---------- Interpolación GPS (fallback) ---------- */
  const trainAnimStart = {}; // id → performance.now() del último cambio GPS
  const trainPollMs = {};    // id → intervalo adaptativo entre cambios GPS

  /* ---------- Posición por horario (schedule-based) ---------- */
  const trainSchedule = {}; // id → {dep, arr, prevCode, nextCode}
  const segPolyCache = {};  // "codeA-codeB" → {coords, cumDist} | null

  /* Máximo de puntos por ruta: por encima se muestrea uniformemente
   * conservando los extremos. */
  const MAX_ROUTE_POINTS = 200;

  /* Las polilíneas de vía real (OSM) vienen ya simplificadas offline;
   * se les permite mucho más detalle que a la secuencia del API. */
  const MAX_RAIL_POINTS = 2500;

  /* ---------- Geometría ferroviaria real (OSM, pre-calculada) ---------- */

  // rail-network.json generado por scripts/build-rail-geometry.js:
  //   segments: { "codigoA-codigoB" (ordenados) → [[lon,lat], …] }
  //   aliases:  { códigoDelFeed → códigoCanónico } resuelto por nombre
  let railSegments = null;
  let railAliases = null;
  let stationGraph = null; // canonicalCode → [adjacent canonical codes]

  /* Guardarraíl: un extremo del segmento pre-calculado debe caer cerca
   * de la estación real (coords aprendidas del feed). Protege frente a
   * colisiones entre espacios de códigos. */
  const RAIL_ENDPOINT_MAX_KM = 15;

  /** Carga (una vez) la geometría de vías pre-calculada. */
  function initRailGeometry() {
    RENFE.fetchJSON("/api/rail-geometry", 30000)
      .then(function (json) {
        if (!json || !json.segments) throw new Error("respuesta sin segmentos");
        railSegments = json.segments;
        railAliases = json.aliases || {};
        buildStationGraph();
        // Invalidar cache de polilíneas por tramo (pudo llenarse de
        // nulls antes de que la geometría estuviera lista).
        for (var k in segPolyCache) delete segPolyCache[k];
        if (json.stations) {
          for (var code in json.stations) {
            if (!RENFE.dynamicStationCoords[code]) {
              var s = json.stations[code];
              RENFE.dynamicStationCoords[code] = { lat: s.lat, lon: s.lon };
            }
          }
        }
        if (overlaysReady) setSourceData("network", networkFC());
        for (var i = 0; i < lastTrains.length; i++) {
          updateTrainArcs(lastTrains[i].id);
        }
        refreshAll();
      })
      .catch(function (err) {
        console.warn("Geometría ferroviaria no disponible (se usa la del API):", err.message);
      });
  }

  /**
   * Segmento de vía real entre dos códigos de estación del feed,
   * orientado de `codeA` a `codeB`. Devuelve null si no hay segmento
   * pre-calculado fiable.
   */
  function railSegmentBetween(codeA, codeB) {
    const ca = railAliases[codeA];
    const cb = railAliases[codeB];
    if (!ca || !cb || ca === cb) return null;
    const key = ca < cb ? ca + "-" + cb : cb + "-" + ca;
    const seg = railSegments[key];
    if (!seg || seg.length < 2) return null;

    const A = RENFE.stationCoords(codeA);
    const B = RENFE.stationCoords(codeB);
    if (!A || !B) return null;

    const first = seg[0];
    const last = seg[seg.length - 1];
    // Orientación: el extremo más cercano a A es el inicio.
    const dFirstA = RENFE._distKm(A.lat, A.lon, first[1], first[0]);
    const dLastA = RENFE._distKm(A.lat, A.lon, last[1], last[0]);
    const reversed = dLastA < dFirstA;
    const start = reversed ? last : first;
    const end = reversed ? first : last;

    // Guardarraíl de coherencia con la posición real de las estaciones.
    if (RENFE._distKm(A.lat, A.lon, start[1], start[0]) > RAIL_ENDPOINT_MAX_KM) return null;
    if (RENFE._distKm(B.lat, B.lon, end[1], end[0]) > RAIL_ENDPOINT_MAX_KM) return null;

    if (!reversed) return seg;
    const out = new Array(seg.length);
    for (let i = 0; i < seg.length; i++) out[i] = seg[seg.length - 1 - i];
    return out;
  }

  /** Construye grafo de adyacencia entre estaciones a partir de las
   *  claves de los segmentos pre-calculados. */
  function buildStationGraph() {
    stationGraph = {};
    for (var key in railSegments) {
      var dash = key.indexOf("-");
      var a = key.substring(0, dash);
      var b = key.substring(dash + 1);
      if (!stationGraph[a]) stationGraph[a] = [];
      if (!stationGraph[b]) stationGraph[b] = [];
      stationGraph[a].push(b);
      stationGraph[b].push(a);
    }
  }

  /** BFS por el grafo de estaciones para encontrar una cadena de
   *  segmentos existentes entre dos códigos canónicos. Máximo 8 saltos.
   *  Devuelve las coordenadas encadenadas [lon,lat][] o null. */
  function chainSegments(canonA, canonB) {
    if (!stationGraph || !stationGraph[canonA]) return null;
    var MAX_HOPS = 8;
    var parent = {};
    parent[canonA] = "";
    var queue = [canonA];
    var qi = 0;
    var depth = {};
    depth[canonA] = 0;

    while (qi < queue.length) {
      var node = queue[qi++];
      if (depth[node] >= MAX_HOPS) continue;
      var neighbors = stationGraph[node];
      if (!neighbors) continue;
      for (var ni = 0; ni < neighbors.length; ni++) {
        var next = neighbors[ni];
        if (next === canonB) {
          var path = [canonB];
          var cur = node;
          while (cur !== "") { path.push(cur); cur = parent[cur]; }
          path.reverse();
          return assembleChain(path);
        }
        if (parent.hasOwnProperty(next)) continue;
        parent[next] = node;
        depth[next] = depth[node] + 1;
        queue.push(next);
      }
    }
    return null;
  }

  /** Encadena los segmentos a lo largo de un camino de códigos canónicos,
   *  orientando cada tramo por proximidad con el anterior. */
  function assembleChain(pathCodes) {
    var result = [];
    for (var i = 0; i < pathCodes.length - 1; i++) {
      var a = pathCodes[i], b = pathCodes[i + 1];
      var key = a < b ? a + "-" + b : b + "-" + a;
      var seg = railSegments[key];
      if (!seg || seg.length < 2) return null;

      var first = seg[0], last = seg[seg.length - 1];
      var reversed = false;
      if (result.length > 0) {
        var prev = result[result.length - 1];
        var dFirst = Math.abs(prev[0] - first[0]) + Math.abs(prev[1] - first[1]);
        var dLast = Math.abs(prev[0] - last[0]) + Math.abs(prev[1] - last[1]);
        reversed = dLast < dFirst;
      } else {
        var coordsA = RENFE.dynamicStationCoords[a];
        if (coordsA) {
          var df = Math.abs(coordsA.lon - first[0]) + Math.abs(coordsA.lat - first[1]);
          var dl = Math.abs(coordsA.lon - last[0]) + Math.abs(coordsA.lat - last[1]);
          reversed = dl < df;
        }
      }

      var startJ = 0;
      if (result.length > 0) {
        var lastPt = result[result.length - 1];
        var firstPt = reversed ? last : first;
        if (Math.abs(lastPt[0] - firstPt[0]) < 1e-5 &&
            Math.abs(lastPt[1] - firstPt[1]) < 1e-5) startJ = 1;
      }
      if (reversed) {
        for (var j = seg.length - 1 - startJ; j >= 0; j--) result.push(seg[j]);
      } else {
        for (var j = startJ; j < seg.length; j++) result.push(seg[j]);
      }
    }
    return result.length > 1 ? result : null;
  }

  /**
   * Geometría de vía real (OSM) de una ruta completa. Devuelve un array
   * de segmentos continuos (cada uno es un array de [lon,lat]). Donde
   * falta un tramo OSM se corta en un nuevo segmento — nunca se une con
   * rectas fantasma. Devuelve null si no hay ningún segmento OSM.
   */
  function hybridPath(route) {
    if (!railSegments || !railAliases) return null;
    const stations = route.stations;
    if (!stations || stations.length < 2) return null;

    const segments = [];
    let current = [];
    let usedRail = false;

    for (let i = 0; i < stations.length - 1; i++) {
      const codeA = stations[i].code;
      const codeB = stations[i + 1].code;
      var seg = railSegmentBetween(codeA, codeB);
      if (!seg) {
        const ca = railAliases[codeA];
        const cb = railAliases[codeB];
        if (ca && cb && ca !== cb) seg = chainSegments(ca, cb);
      }
      if (seg) {
        usedRail = true;
        if (current.length === 0) {
          for (let j = 0; j < seg.length; j++) current.push(seg[j]);
        } else {
          const last = current[current.length - 1];
          const first = seg[0];
          if (Math.abs(last[0] - first[0]) < 1e-5 &&
              Math.abs(last[1] - first[1]) < 1e-5) {
            for (let j = 1; j < seg.length; j++) current.push(seg[j]);
          } else {
            segments.push(current);
            current = [];
            for (let j = 0; j < seg.length; j++) current.push(seg[j]);
          }
        }
      } else {
        if (current.length > 1) segments.push(current);
        current = [];
      }
    }
    if (current.length > 1) segments.push(current);

    return usedRail && segments.length > 0 ? segments : null;
  }

  /* Colores por estado de retraso. */
  const STATE_CORE = ["match", ["get", "state"],
    "ok", "#34d399", "warn", "#fbbf24", "late", "#f87171", "#34d399"];
  const STATE_GLOW = ["match", ["get", "state"],
    "ok", "rgba(16,185,129,0.9)", "warn", "rgba(245,158,11,0.9)",
    "late", "rgba(239,68,68,0.9)", "rgba(16,185,129,0.9)"];
  const STATE_DOT = ["match", ["get", "state"],
    "ok", "#10b981", "warn", "#f59e0b", "late", "#ef4444", "#10b981"];
  const STATE_DOT_GLOW = ["match", ["get", "state"],
    "ok", "rgba(16,185,129,0.45)", "warn", "rgba(245,158,11,0.45)",
    "late", "rgba(239,68,68,0.45)", "rgba(16,185,129,0.45)"];

  /* ---------- Estilos base ---------- */

  /** URL del estilo CARTO Dark Matter (vectorial, gratuito sin clave,
   *  CDN rápido): zoom continuo renderizado en GPU. */
  const VECTOR_STYLE_URL =
    "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

  /** Fallback: teselas raster OSM oscurecidas en la propia GPU
   *  (raster-* paint). Menos fluido que vector, pero sin dependencias. */
  const RASTER_STYLE = {
    version: 8,
    sources: {
      "osm-raster": {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [
      { id: "background", type: "background",
        paint: { "background-color": "#04080f" } },
      { id: "osm-tiles", type: "raster", source: "osm-raster",
        paint: {
          "raster-brightness-max": 0.3,
          "raster-brightness-min": 0.0,
          "raster-saturation": -0.7,
          "raster-contrast": 0.3,
          "raster-hue-rotate": 195,
        } },
    ],
  };

  /* ---------- Utilidades ---------- */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Muestreo uniforme conservando extremos. */
  function downsamplePts(pts, maxPts) {
    if (pts.length <= maxPts) return pts;
    const out = [];
    const step = (pts.length - 1) / (maxPts - 1);
    for (let i = 0; i < maxPts; i++) out.push(pts[Math.round(i * step)]);
    return out;
  }

  /** Geometría GeoJSON para dibujar una ruta en el mapa.
   *  Solo usa segmentos OSM reales — sin fallback a GPS ni rectas.
   *  Devuelve LineString o MultiLineString, o null si no hay datos. */
  function displayGeometry(route) {
    const segs = hybridPath(route);
    if (!segs || segs.length === 0) return null;
    const ds = segs.map(function (s) { return downsamplePts(s, MAX_RAIL_POINTS); });
    if (ds.length === 1) return { type: "LineString", coordinates: ds[0] };
    return { type: "MultiLineString", coordinates: ds };
  }

  /* ---------- Polilíneas de ruta con longitud de arco ---------- */

  const DEG_M = 111320; // metros por grado de latitud (aprox.)

  /**
   * Proyecta un punto sobre la polilínea: devuelve {arc, distM} con la
   * longitud de arco (m) del punto más cercano y la distancia (m) del
   * punto a la línea. Null si la polilínea es degenerada.
   */
  function snapToRoute(lon, lat, poly) {
    const coords = poly.coords;
    const cum = poly.cumDist;
    const cosLat = Math.cos(lat * Math.PI / 180);
    let bestD2 = Infinity;
    let bestArc = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = coords[i][0], ay = coords[i][1];
      // Coordenadas planas locales (grados de latitud equivalentes).
      const dx = (coords[i + 1][0] - ax) * cosLat;
      const dy = coords[i + 1][1] - ay;
      const px = (lon - ax) * cosLat;
      const py = lat - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = px - dx * t;
      const qy = py - dy * t;
      const d2 = qx * qx + qy * qy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestArc = cum[i] + (cum[i + 1] - cum[i]) * t;
      }
    }
    if (bestD2 === Infinity) return null;
    return { arc: bestArc, distM: Math.sqrt(bestD2) * DEG_M };
  }

  /** Punto [lon, lat] de la polilínea a una longitud de arco dada. */
  function samplePolyline(poly, arc) {
    const coords = poly.coords;
    const cum = poly.cumDist;
    const n = cum.length;
    if (arc <= 0) return [coords[0][0], coords[0][1]];
    if (arc >= cum[n - 1]) return [coords[n - 1][0], coords[n - 1][1]];
    // Búsqueda binaria del segmento que contiene `arc`.
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= arc) lo = mid; else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const t = span > 0 ? (arc - cum[lo]) / span : 0;
    return [
      lerp(coords[lo][0], coords[hi][0], t),
      lerp(coords[lo][1], coords[hi][1], t),
    ];
  }

  /** Polilínea con cumDist entre dos códigos de estación (cacheada). */
  function getSegmentPoly(codeA, codeB) {
    var key = codeA + "-" + codeB;
    if (segPolyCache.hasOwnProperty(key)) return segPolyCache[key];
    if (!railSegments || !railAliases) return null;

    var seg = railSegmentBetween(codeA, codeB);
    if (!seg) {
      var ca = railAliases[codeA], cb = railAliases[codeB];
      if (ca && cb && ca !== cb) seg = chainSegments(ca, cb);
    }
    if (!seg || seg.length < 2) { segPolyCache[key] = null; return null; }

    var cumDist = new Array(seg.length);
    cumDist[0] = 0;
    for (var i = 1; i < seg.length; i++) {
      var midLat = (seg[i][1] + seg[i - 1][1]) * 0.5;
      var dx = (seg[i][0] - seg[i - 1][0]) * DEG_M * Math.cos(midLat * Math.PI / 180);
      var dy = (seg[i][1] - seg[i - 1][1]) * DEG_M;
      cumDist[i] = cumDist[i - 1] + Math.sqrt(dx * dx + dy * dy);
    }
    var poly = { coords: seg, cumDist: cumDist };
    segPolyCache[key] = poly;
    return poly;
  }

  /** Posición basada en horario: depPrev/arrNext + polilínea OSM. */
  function schedulePos(id) {
    var sched = trainSchedule[id];
    if (!sched) return null;
    var dep = sched.dep, arr = sched.arr;
    if (!dep || !arr || arr <= dep) return null;

    var poly = getSegmentPoly(sched.prevCode, sched.nextCode);
    if (!poly) return null;

    var now = Date.now();
    var t = (now - dep) / (arr - dep);
    if (t < 0) t = 0;
    if (t > 1) t = 1;

    var totalLen = poly.cumDist[poly.cumDist.length - 1];
    if (totalLen < 1) return null;
    return samplePolyline(poly, t * totalLen);
  }

  /**
   * (Re)construye la polilínea y geometría de display de la ruta de un
   * tren. Para arc-length usa el segmento continuo más largo; para
   * display guarda todos los segmentos como MultiLineString (sin rectas
   * fantasma entre huecos). Si el tren cae demasiado lejos de la ruta,
   * se anula la proyección y se anima con la posición cruda.
   */
  function updateTrainArcs(id) {
    const route = lastRoutes[id];
    if (!route) {
      delete routePolylines[id];
      delete routeDisplayGeom[id];
      delete prevArc[id];
      delete targetArc[id];
      return;
    }

    const segs = hybridPath(route);
    if (!segs || segs.length === 0) {
      delete routePolylines[id];
      delete routeDisplayGeom[id];
      delete prevArc[id];
      delete targetArc[id];
      return;
    }

    // Geometría para dibujar: MultiLineString (sin rectas fantasma).
    const ds = segs.map(function (s) { return downsamplePts(s, MAX_RAIL_POINTS); });
    routeDisplayGeom[id] = ds.length === 1
      ? { type: "LineString", coordinates: ds[0] }
      : { type: "MultiLineString", coordinates: ds };

    // Para arc-length: el segmento continuo más largo.
    let longest = ds[0];
    for (let i = 1; i < ds.length; i++) {
      if (ds[i].length > longest.length) longest = ds[i];
    }
    if (longest.length < 2) {
      delete routePolylines[id];
      delete prevArc[id];
      delete targetArc[id];
      return;
    }

    const coords = longest;
    const cumDist = new Array(coords.length);
    cumDist[0] = 0;
    for (let i = 1; i < coords.length; i++) {
      const midLat = (coords[i][1] + coords[i - 1][1]) * 0.5;
      const dx = (coords[i][0] - coords[i - 1][0]) * DEG_M *
        Math.cos(midLat * Math.PI / 180);
      const dy = (coords[i][1] - coords[i - 1][1]) * DEG_M;
      cumDist[i] = cumDist[i - 1] + Math.sqrt(dx * dx + dy * dy);
    }
    const poly = { coords: coords, cumDist: cumDist };
    routePolylines[id] = poly;

    const tgt = targetPos[id];
    const prv = prevPos[id];
    const snapT = tgt ? snapToRoute(tgt.lon, tgt.lat, poly) : null;
    if (!snapT || snapT.distM > MAX_SNAP_M) {
      delete prevArc[id];
      delete targetArc[id];
      return;
    }
    targetArc[id] = snapT.arc;
    const snapP = prv ? snapToRoute(prv.lon, prv.lat, poly) : null;
    prevArc[id] = snapP && snapP.distM <= MAX_SNAP_M ? snapP.arc : snapT.arc;
  }

  function emptyFC() {
    return { type: "FeatureCollection", features: [] };
  }

  function setSourceData(id, data) {
    const src = map.getSource(id);
    if (src) src.setData(data);
  }

  /* ---------- GeoJSON de cada fuente ---------- */

  function networkFC() {
    if (!railSegments) return emptyFC();
    var features = [];
    for (var key in railSegments) {
      var coords = railSegments[key];
      if (!coords || coords.length < 2) continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {},
      });
    }
    return { type: "FeatureCollection", features: features };
  }

  function stationsFC() {
    const features = [];
    for (const code in RENFE.AVE_STATIONS) {
      const c = RENFE.stationCoords(code);
      if (!c) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: { name: RENFE.stationName(code) },
      });
    }
    return { type: "FeatureCollection", features };
  }

  function routesFC() {
    const features = [];
    for (const t of lastTrains) {
      const route = lastRoutes[t.id];
      if (!route) continue;
      const geom = routeDisplayGeom[t.id] || displayGeometry(route);
      if (!geom) continue;
      features.push({
        type: "Feature",
        geometry: geom,
        properties: {
          id: t.id,
          dimmed: !!(selectedId && t.id !== selectedId),
        },
      });
    }
    return { type: "FeatureCollection", features };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  /** Posición de un tren: primero intenta el horario (movimiento
   *  continuo basado en depPrev/arrNext + polilínea OSM). Si no hay
   *  datos de horario, cae al interpolador GPS anterior. */
  function livePos(id, now) {
    var sp = schedulePos(id);
    if (sp) return sp;

    var start = trainAnimStart[id] || animStart;
    var interval = trainPollMs[id] || POLL_MS;
    var elapsed = now - start;
    var t = elapsed / interval;
    if (t < 0) t = 0;

    var poly = routePolylines[id];
    var tArc = targetArc[id];
    if (poly && tArc !== undefined) {
      var pArc = prevArc[id];
      if (pArc === undefined) pArc = tArc;
      var jump = tArc - pArc;
      if (Math.abs(jump) > MAX_ARC_JUMP_M) return samplePolyline(poly, tArc);
      var arc;
      if (t <= 1) {
        arc = pArc + jump * t;
      } else if (jump !== 0) {
        var extra = (t - 1) * jump;
        var cap = Math.abs(jump) * 0.5;
        if (extra > cap) extra = cap;
        else if (extra < -cap) extra = -cap;
        arc = tArc + extra;
      } else {
        arc = tArc;
      }
      var total = poly.cumDist[poly.cumDist.length - 1];
      if (arc < 0) arc = 0;
      else if (arc > total) arc = total;
      return samplePolyline(poly, arc);
    }

    var tgt = targetPos[id];
    var prv = prevPos[id];
    if (!tgt) return null;
    if (!prv) return [tgt.lon, tgt.lat];
    if (t > 1.5) t = 1.5;
    return [lerp(prv.lon, tgt.lon, t), lerp(prv.lat, tgt.lat, t)];
  }

  function inServiceArea(lon, lat) {
    return lon >= -10 && lon <= 8 && lat >= 35 && lat <= 50;
  }

  function trainsFC() {
    var now = performance.now();
    const features = [];
    for (const t of lastTrains) {
      var coords = livePos(t.id, now) || [t.lon, t.lat];
      if (!inServiceArea(coords[0], coords[1])) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coords },
        properties: {
          id: t.id,
          state: RENFE.delayState(t.delay),
          selected: t.id === selectedId,
          type: t.type,
          number: t.number,
          route: RENFE.routeLabel(t.origin, t.destination),
          delayLabel: RENFE.delayLabel(t.delay),
        },
      });
    }
    return { type: "FeatureCollection", features };
  }

  function animTick() {
    animFrameId = null;
    if (!overlaysReady || !lastTrains.length) { animRunning = false; return; }
    setSourceData("trains", trainsFC());
    // Seguir animando siempre (extrapolación continua entre polls)
    animFrameId = requestAnimationFrame(animTick);
  }

  function ensureAnimRunning() {
    if (animRunning) return;
    animRunning = true;
    animFrameId = requestAnimationFrame(animTick);
  }

  function startAnim() {
    animStart = performance.now();
    ensureAnimRunning();
  }

  function selRouteFC() {
    if (!selectedId || !selRoute) return emptyFC();
    const geom = routeDisplayGeom[selectedId] || displayGeometry(selRoute);
    if (!geom) return emptyFC();
    const train = lastTrains.find((t) => t.id === selectedId);
    return {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: geom,
        properties: {},
      }],
    };
  }

  function selStopsFC() {
    if (!selectedId || !selRoute || !selRoute.stations) return emptyFC();
    const features = [];
    for (const st of selRoute.stations) {
      const c = RENFE.stationCoords(st.code);
      if (!c) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: { name: RENFE.stationName(st.code) },
      });
    }
    return { type: "FeatureCollection", features };
  }

  /** Vuelca el estado actual a todas las fuentes superpuestas. */
  function refreshAll() {
    if (!overlaysReady) return;
    if (railSegments) setSourceData("network", networkFC());
    setSourceData("routes", routesFC());
    setSourceData("selroute", selRouteFC());
    setSourceData("selstops", selStopsFC());
    setSourceData("trains", trainsFC());
    ensureAnimRunning();
  }

  /* ---------- Capas superpuestas ---------- */

  /** Añade fuentes y capas propias sobre el estilo base actual.
   *  Se invoca en cada style.load (también tras el fallback). */
  function addOverlays() {
    map.addSource("network", { type: "geojson", data: emptyFC() });
    map.addSource("routes", { type: "geojson", data: emptyFC() });
    map.addSource("selroute", { type: "geojson", data: emptyFC() });
    map.addSource("stations", { type: "geojson", data: stationsFC() });
    map.addSource("selstops", { type: "geojson", data: emptyFC() });
    map.addSource("trains", { type: "geojson", data: emptyFC() });

    map.addLayer({
      id: "network-glow", type: "line", source: "network",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(56, 189, 248, 0.6)",
        "line-width": 6,
        "line-blur": 3,
        "line-opacity": 0.18,
      },
    });
    map.addLayer({
      id: "network-core", type: "line", source: "network",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(56, 189, 248, 0.9)",
        "line-width": 2,
        "line-opacity": 0.65,
      },
    });

    // Rutas de todos los trenes: halo difuso + núcleo (color neutro fijo).
    map.addLayer({
      id: "routes-glow", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(56, 189, 248, 0.6)",
        "line-width": 6,
        "line-blur": 3,
        "line-opacity": ["case", ["get", "dimmed"], 0.03, 0.12],
      },
    });
    map.addLayer({
      id: "routes-core", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(56, 189, 248, 0.9)",
        "line-width": 2,
        "line-opacity": ["case", ["get", "dimmed"], 0.08, 0.45],
      },
    });

    // Ruta seleccionada: resplandor completo en 3 capas (cyan fijo).
    map.addLayer({
      id: "selroute-outer", type: "line", source: "selroute",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(56, 189, 248, 0.9)",
        "line-width": 13,
        "line-blur": 6,
        "line-opacity": 0.3,
      },
    });
    map.addLayer({
      id: "selroute-mid", type: "line", source: "selroute",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "rgba(56, 189, 248, 0.9)",
        "line-width": 6.5,
        "line-blur": 2,
        "line-opacity": 0.5,
      },
    });
    map.addLayer({
      id: "selroute-core", type: "line", source: "selroute",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#38bdf8",
        "line-width": 3,
        "line-opacity": 1.0,
      },
    });

    // Estaciones AVE: halo + punto + nombre.
    map.addLayer({
      id: "stations-glow", type: "circle", source: "stations",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 4, 8, 7, 12, 10],
        "circle-color": "rgba(56, 189, 248, 0.2)",
        "circle-blur": 0.8,
      },
    });
    map.addLayer({
      id: "stations-dot", type: "circle", source: "stations",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 8, 4, 12, 6],
        "circle-color": "#0f1f38",
        "circle-stroke-color": "rgba(56, 189, 248, 0.75)",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: "stations-label", type: "symbol", source: "stations",
      minzoom: 7,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 12, 13],
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-max-width": 8,
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "rgba(56, 189, 248, 0.9)",
        "text-halo-color": "#04080f",
        "text-halo-width": 1.5,
      },
    });

    // Paradas de la ruta seleccionada.
    map.addLayer({
      id: "selstops-dot", type: "circle", source: "selstops",
      paint: {
        "circle-radius": 4.5,
        "circle-color": "#04080f",
        "circle-stroke-color": "#38bdf8",
        "circle-stroke-width": 2,
      },
    });

    // Trenes: halo difuso + punto nítido, tamaño mayor si seleccionado.
    map.addLayer({
      id: "trains-glow", type: "circle", source: "trains",
      paint: {
        "circle-radius": ["case", ["get", "selected"], 12, 8],
        "circle-color": STATE_DOT_GLOW,
        "circle-blur": 0.6,
      },
    });
    map.addLayer({
      id: "trains-dot", type: "circle", source: "trains",
      paint: {
        "circle-radius": ["case", ["get", "selected"], 7, 5],
        "circle-color": STATE_DOT,
        "circle-stroke-color": ["case", ["get", "selected"],
          "#ffffff", "rgba(4,8,15,0.9)"],
        "circle-stroke-width": ["case", ["get", "selected"], 2, 1.5],
      },
    });

    overlaysReady = true;
  }

  /* ---------- Interacción ---------- */

  function trainPopupHtml(props) {
    return (
      '<div class="tip-title">' + escapeHtml(props.type) + " " +
      escapeHtml(props.number) + "</div>" +
      escapeHtml(props.route) + "<br>" +
      '<span class="tip-delay-' + escapeHtml(props.state) + '">' +
      escapeHtml(props.delayLabel) + "</span>"
    );
  }

  function bindHandlers() {
    if (handlersBound) return;
    handlersBound = true;

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "train-popup",
      offset: 12,
    });

    // Clic: tren bajo el cursor → seleccionar; fondo → deseleccionar.
    map.on("click", (e) => {
      if (!onTrainClick) return;
      let hit = null;
      if (map.getLayer("trains-dot")) {
        const feats = map.queryRenderedFeatures(e.point, {
          layers: ["trains-dot", "trains-glow"],
        });
        if (feats.length) hit = feats[0].properties.id;
      }
      onTrainClick(hit);
    });

    // Tooltip de tren al pasar el cursor.
    map.on("mouseenter", "trains-dot", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features && e.features[0];
      if (!f) return;
      popup
        .setLngLat(f.geometry.coordinates)
        .setHTML(trainPopupHtml(f.properties))
        .addTo(map);
    });
    map.on("mousemove", "trains-dot", (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      popup
        .setLngLat(f.geometry.coordinates)
        .setHTML(trainPopupHtml(f.properties));
    });
    map.on("mouseleave", "trains-dot", () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });

    // Tooltip de estación.
    map.on("mouseenter", "stations-dot", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features && e.features[0];
      if (!f) return;
      popup
        .setLngLat(f.geometry.coordinates)
        .setHTML('<div class="tip-title">' + escapeHtml(f.properties.name) + "</div>")
        .addTo(map);
    });
    map.on("mouseleave", "stations-dot", () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });
  }

  /* ---------- API pública ---------- */

  function init(containerId, clickHandler) {
    onTrainClick = clickHandler;

    map = new maplibregl.Map({
      container: containerId,
      style: VECTOR_STYLE_URL,
      center: [-3.7, 40.2],
      zoom: 5.5,
      minZoom: 2,
      maxZoom: 14,
      // Limitado a la España peninsular + Baleares: el sur queda en el
      // Estrecho (35.8°N) para no mostrar el norte de África, y el este
      // en 4.5°E (justo pasada Menorca).
      maxBounds: [[-15.0, 33.0], [10.0, 50.0]],
      attributionControl: { compact: true },
      cooperativeGestures: true,
      locale: {
        "CooperativeGesturesHandler.WindowsHelpText":
          "Usa Ctrl + rueda para hacer zoom en el mapa",
        "CooperativeGesturesHandler.MacHelpText":
          "Usa ⌘ + rueda para hacer zoom en el mapa",
        "CooperativeGesturesHandler.MobileHelpText":
          "Usa dos dedos para mover el mapa",
      },
    });

    // Ocultar el aviso de gestos cooperativos tras la primera vez.
    var gestureHidden = false;
    map.getContainer().addEventListener("wheel", function () {
      if (gestureHidden) return;
      gestureHidden = true;
      setTimeout(function () {
        var el = map.getContainer().querySelector(".maplibregl-cooperative-gesture-screen");
        if (el) el.classList.add("hint-dismissed");
      }, 3000);
    }, { passive: true });
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right"
    );

    // Cada carga de estilo (inicial o tras el fallback) reconstruye
    // las capas superpuestas y repuebla los datos.
    map.on("style.load", () => {
      overlaysReady = false;
      addOverlays();
      refreshAll();
    });
    map.on("load", () => {
      styleEverLoaded = true;
    });

    // Fallback: si las teselas vectoriales no cargan (CDN caído,
    // bloqueado…), cambiar una sola vez al estilo raster OSM.
    map.on("error", (e) => {
      if (usedFallback || styleEverLoaded) return;
      const err = e && e.error;
      const msg = (err && err.message) || "";
      if (msg.indexOf("carto") !== -1 || e.sourceId === "carto") {
        usedFallback = true;
        console.warn("Teselas vectoriales no disponibles; usando raster OSM:", msg);
        map.setStyle(RASTER_STYLE);
      }
    });

    bindHandlers();
    initRailGeometry();
    return map;
  }

  /**
   * Pinta/actualiza trenes visibles y sus rutas.
   * `routes` es el mapa idTren → {stations, path} de app.js.
   */
  function updateTrains(trains, routes) {
    var incoming = trains || [];
    lastRoutes = routes || {};
    if (selectedId && lastRoutes[selectedId]) {
      selRoute = lastRoutes[selectedId];
    }

    // Guardar posiciones anteriores para interpolar.
    var seen = {};
    for (var i = 0; i < incoming.length; i++) {
      var t = incoming[i];
      if (!inServiceArea(t.lon, t.lat)) continue;
      seen[t.id] = true;
      var prev = targetPos[t.id];
      var posChanged = prev && (prev.lon !== t.lon || prev.lat !== t.lat);
      prevPos[t.id] = prev
        ? { lon: prev.lon, lat: prev.lat }
        : { lon: t.lon, lat: t.lat };
      targetPos[t.id] = { lon: t.lon, lat: t.lat };
      if (posChanged) {
        var now = performance.now();
        var lastChange = trainAnimStart[t.id];
        trainPollMs[t.id] = lastChange ? Math.min(now - lastChange, 60000) : POLL_MS;
        trainAnimStart[t.id] = now;
      } else if (!prev) {
        trainAnimStart[t.id] = performance.now();
        trainPollMs[t.id] = POLL_MS;
      }
      // Horario para posición basada en schedule.
      if (t.depPrev && t.arrNext && t.prevStation && t.nextStation) {
        var dep = new Date(t.depPrev).getTime();
        var arr = new Date(t.arrNext).getTime();
        if (isFinite(dep) && isFinite(arr) && arr > dep) {
          trainSchedule[t.id] = {
            dep: dep, arr: arr,
            prevCode: t.prevStation, nextCode: t.nextStation,
          };
        }
      }
      // Proyectar posiciones sobre la polilínea de la ruta (arcos).
      updateTrainArcs(t.id);
    }
    // Limpiar trenes desaparecidos.
    for (var id in targetPos) {
      if (!seen[id]) {
        delete targetPos[id];
        delete prevPos[id];
        delete routePolylines[id];
        delete routeDisplayGeom[id];
        delete prevArc[id];
        delete targetArc[id];
        delete trainAnimStart[id];
        delete trainPollMs[id];
        delete trainSchedule[id];
      }
    }

    lastTrains = incoming;

    // Actualizar rutas, selección, etc. inmediatamente.
    if (overlaysReady) {
      setSourceData("routes", routesFC());
      setSourceData("selroute", selRouteFC());
      setSourceData("selstops", selStopsFC());
    }
    // Trenes con animación suave.
    startAnim();
  }

  /** Marca un tren como seleccionado: su ruta se realza, el resto se atenúa. */
  function selectTrain(id, train, route) {
    selectedId = id;
    selRoute = id ? (route || lastRoutes[id] || null) : null;
    refreshAll();

    if (id && train) {
      var zoom = map.getZoom();
      map.flyTo({
        center: [train.lon, train.lat],
        zoom: Math.max(zoom, 8),
        duration: 1000,
      });
    }
  }

  return { init, updateTrains, selectTrain };
})();
