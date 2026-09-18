/* ===========================================================
 * data.js — Obtención y normalización de datos en tiempo real
 * Endpoints Renfe Largo Recorrido + proxies CORS con fallback.
 * =========================================================== */
"use strict";

window.RENFE = window.RENFE || {};

RENFE.ENDPOINTS = {
  fleet: "/api/fleet",
  routes: "/api/routes",
};

/**
 * Mapa codProduct → nombre comercial.
 * Deducido del material rodante (campo "mat") observado en el feed:
 *   2  → S-100/102/103/106/112  = AVE
 *   3  → S-104/114 (servicios 08xxx/09xxx) = Avant
 *   10 → S-130 Madrid–Barcelona = Intercity
 *   11 → S-120/121/130          = Alvia
 *   13 → S-252 + Talgo BCN–VLC  = Euromed / Intercity
 *   28 → S-106/112 en servicios low-cost = Avlo
 *   16/18/19 → material 447/449/470/599… = Media Distancia
 */
RENFE.PRODUCT_TYPES = {
  2: "AVE",
  3: "Avant",
  10: "Intercity",
  11: "Alvia",
  13: "Euromed",
  16: "MD",
  18: "MD",
  19: "MD",
  28: "Avlo",
};

RENFE.trainTypeName = function (codProduct) {
  return RENFE.PRODUCT_TYPES[codProduct] || "LD";
};

RENFE.fetchJSON = async function (url, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data || typeof data !== "object") throw new Error("respuesta vacía");
    return data;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
};

/** Retraso en minutos a partir de "HH:MM" programada vs real (con salto de medianoche). */
RENFE.diffMinutes = function (sched, actual) {
  if (!sched || !actual) return null;
  const p = (s) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };
  const a = p(sched);
  const b = p(actual);
  if (a === null || b === null) return null;
  let d = b - a;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
};

/**
 * Normaliza el JSON de flota → lista de trenes.
 * Esquema real del feed: codComercial, codCirculacion, codEstAnt, codEstSig,
 * horaSalidaEstAnterior, horaLlegadaSigEst, codProduct, codOrigen,
 * codDestino, accesible, ultRetraso, latitud, longitud, mat, corr.
 */
RENFE.processFleet = function (json) {
  const updated = json.fechaActualizacion ? new Date(json.fechaActualizacion) : new Date();
  const trains = [];
  for (const t of json.trenes || []) {
    const lat = Number(t.latitud);
    const lon = Number(t.longitud);
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const delay = parseInt(t.ultRetraso, 10);
    trains.push({
      // idTren del endpoint de rutas coincide con codComercial (verificado
      // contra el feed real: 135/135 vs 88/135 con codCirculacion).
      id: String(t.codComercial || t.codCirculacion || ""),
      number: String(t.codComercial || t.codCirculacion || ""),
      typeCode: t.codProduct,
      type: RENFE.trainTypeName(t.codProduct),
      lat: lat,
      lon: lon,
      delay: isFinite(delay) ? delay : 0,
      origin: String(t.codOrigen || ""),
      destination: String(t.codDestino || ""),
      prevStation: String(t.codEstAnt || ""),
      nextStation: String(t.codEstSig || ""),
      depPrev: t.horaSalidaEstAnterior || null,
      arrNext: t.horaLlegadaSigEst || null,
      mat: t.mat || "",
      accessible: !!t.accesible,
      corridor: String(t.corr || ""),
    });
  }
  return { updated, trains };
};

/**
 * Normaliza el JSON de rutas → { idTren: {stations:[], path:[]} }.
 * Cada estación: {code, sched:"HH:MM", actual:"HH:MM", delay:min|null}.
 * path = polilínea real del recorrido (campo "secuencia").
 */
RENFE.processRoutes = function (json) {
  const byId = {};
  for (const t of json.trenes || []) {
    const id = String(t.idTren || "");
    if (!id) continue;
    const stations = (t.estaciones || []).map((e) => ({
      code: String(e.p || ""),
      sched: e.h || "",
      actual: e.hs || "",
      delay: RENFE.diffMinutes(e.h, e.hs),
    }));
    const path = (t.secuencia || [])
      .filter((pt) => isFinite(Number(pt.lat)) && isFinite(Number(pt.lon)))
      .map((pt) => ({ lat: Number(pt.lat), lon: Number(pt.lon), code: String(pt.c || "") }));
    byId[id] = { stations, path };
  }
  return byId;
};

/**
 * Combina flota + rutas y calcula estadísticas del ciclo.
 * Un tren se considera retrasado con delay >= 1 min; "grave" con > 5 min.
 */
RENFE.computeStats = function (trains) {
  const total = trains.length;
  let delayed = 0;
  let sum = 0;
  let max = 0;
  let maxTrain = null;
  for (const t of trains) {
    if (t.delay >= 1) {
      delayed++;
      sum += t.delay;
      if (t.delay > max) {
        max = t.delay;
        maxTrain = t;
      }
    }
  }
  return {
    total,
    delayed,
    onTime: total - delayed,
    avgDelay: delayed ? sum / delayed : 0,
    maxDelay: max,
    maxTrain,
  };
};

/** Clase de estado según retraso: ok (verde), warn (amarillo), late (rojo). */
RENFE.delayState = function (delay) {
  if (delay >= 6) return "late";
  if (delay >= 1) return "warn";
  return "ok";
};

RENFE.delayLabel = function (delay) {
  if (delay >= 1) return "+" + delay + " min";
  if (delay <= -1) return delay + " min";
  return "En hora";
};

/** Etiqueta legible de una ruta origen → destino. */
RENFE.routeLabel = function (origin, destination) {
  return RENFE.stationName(origin) + " → " + RENFE.stationName(destination);
};
