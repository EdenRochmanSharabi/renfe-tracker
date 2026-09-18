/* ===========================================================
 * history.js — Persistencia histórica en localStorage
 * Instantáneas globales, retrasos por tren y agregados por ruta.
 * Retención: 7 días. Escritura tolerante a cuota llena.
 * =========================================================== */
"use strict";

window.RENFE = window.RENFE || {};

RENFE.History = (function () {
  const KEYS = {
    snapshots: "avetracker:v1:snapshots",
    trains: "avetracker:v1:trains",
    routes: "avetracker:v1:routes",
  };
  const WEEK_MS = 7 * 24 * 3600 * 1000;
  const SNAPSHOT_BUCKET_MS = 5 * 60 * 1000; // una instantánea cada 5 min
  const TRAIN_SAMPLE_MS = 10 * 60 * 1000;   // una muestra por tren cada 10 min
  const MAX_TRAIN_SAMPLES = 200;

  let available = true;
  try {
    localStorage.setItem("avetracker:test", "1");
    localStorage.removeItem("avetracker:test");
  } catch (e) {
    available = false;
  }

  function load(key, fallback) {
    if (!available) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    if (!available) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Cuota llena: poda agresiva y reintento único.
      try {
        pruneHard();
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e2) {
        /* sin espacio; seguimos en memoria */
      }
    }
  }

  // Estado en memoria (espejo de localStorage).
  let snapshots = load(KEYS.snapshots, []);   // [{t,total,delayed,avg,max}]
  let trainHist = load(KEYS.trains, {});      // {trainId: {route:"O-D", samples:[{t,d}]}}
  let routeHist = load(KEYS.routes, {});      // {"O-D": {label, days: {ymd: {n,sum,delayed,max}}}}

  function ymd(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function prune(now) {
    const cutoff = now - WEEK_MS;
    snapshots = snapshots.filter((s) => s.t >= cutoff);
    for (const id in trainHist) {
      const h = trainHist[id];
      h.samples = (h.samples || []).filter((s) => s.t >= cutoff);
      if (!h.samples.length) delete trainHist[id];
    }
    const cutoffDay = ymd(cutoff);
    for (const r in routeHist) {
      const days = routeHist[r].days || {};
      for (const day in days) {
        if (day < cutoffDay) delete days[day];
      }
      if (!Object.keys(days).length) delete routeHist[r];
    }
  }

  function pruneHard() {
    // Mantener solo la mitad más reciente de las instantáneas y 50 muestras/tren.
    snapshots = snapshots.slice(Math.floor(snapshots.length / 2));
    for (const id in trainHist) {
      trainHist[id].samples = trainHist[id].samples.slice(-50);
    }
    localStorage.setItem(KEYS.snapshots, JSON.stringify(snapshots));
    localStorage.setItem(KEYS.trains, JSON.stringify(trainHist));
  }

  /** Registra un ciclo completo: stats globales + trenes observados. */
  function recordCycle(stats, trains) {
    const now = Date.now();
    prune(now);

    // --- Instantánea global (bucket de 5 min: sustituye la del mismo bucket) ---
    const bucket = Math.floor(now / SNAPSHOT_BUCKET_MS) * SNAPSHOT_BUCKET_MS;
    const snap = {
      t: bucket,
      total: stats.total,
      delayed: stats.delayed,
      avg: Math.round(stats.avgDelay * 10) / 10,
      max: stats.maxDelay,
    };
    if (snapshots.length && snapshots[snapshots.length - 1].t === bucket) {
      snapshots[snapshots.length - 1] = snap;
    } else {
      snapshots.push(snap);
    }

    // --- Por tren y por ruta ---
    const day = ymd(now);
    for (const t of trains) {
      const routeKey = t.origin + "-" + t.destination;

      // Muestras por tren (máx. una cada 10 min)
      let h = trainHist[t.id];
      if (!h) h = trainHist[t.id] = { route: routeKey, type: t.type, samples: [] };
      h.route = routeKey;
      h.type = t.type;
      const last = h.samples[h.samples.length - 1];
      if (!last || now - last.t >= TRAIN_SAMPLE_MS || last.d !== t.delay) {
        if (!last || now - last.t >= TRAIN_SAMPLE_MS) {
          h.samples.push({ t: now, d: t.delay });
          if (h.samples.length > MAX_TRAIN_SAMPLES) h.samples.shift();
        } else {
          last.d = Math.max(last.d, t.delay);
        }
      }

      // Agregado por ruta y día
      let r = routeHist[routeKey];
      if (!r) r = routeHist[routeKey] = { label: RENFE.routeLabel(t.origin, t.destination), days: {} };
      let dstat = r.days[day];
      if (!dstat) dstat = r.days[day] = { n: 0, sum: 0, delayed: 0, max: 0 };
      dstat.n++;
      if (t.delay >= 1) {
        dstat.delayed++;
        dstat.sum += t.delay;
        if (t.delay > dstat.max) dstat.max = t.delay;
      }
    }

    save(KEYS.snapshots, snapshots);
    save(KEYS.trains, trainHist);
    save(KEYS.routes, routeHist);
  }

  /** Instantáneas desde hace `sinceMs` milisegundos, ordenadas por tiempo. */
  function getSnapshots(sinceMs) {
    const cutoff = Date.now() - sinceMs;
    return snapshots.filter((s) => s.t >= cutoff);
  }

  /**
   * Peores rutas por retraso medio (entre observaciones retrasadas),
   * con un mínimo de observaciones para evitar ruido.
   */
  function getWorstRoutes(topN, minObs) {
    minObs = minObs || 10;
    const rows = [];
    for (const key in routeHist) {
      const r = routeHist[key];
      let n = 0, sum = 0, delayed = 0, max = 0;
      for (const day in r.days) {
        const d = r.days[day];
        n += d.n;
        sum += d.sum;
        delayed += d.delayed;
        if (d.max > max) max = d.max;
      }
      if (n < minObs || !delayed) continue;
      rows.push({
        key,
        label: r.label,
        avgDelay: sum / delayed,
        pctDelayed: (100 * delayed) / n,
        maxDelay: max,
        observations: n,
      });
    }
    rows.sort((a, b) => b.avgDelay - a.avgDelay);
    return rows.slice(0, topN || 8);
  }

  /** Historial de muestras de un tren concreto. */
  function getTrainHistory(id) {
    return (trainHist[id] && trainHist[id].samples) || [];
  }

  /** Número de días con datos registrados. */
  function coverageDays() {
    if (!snapshots.length) return 0;
    return Math.max(1, Math.ceil((Date.now() - snapshots[0].t) / (24 * 3600 * 1000)));
  }

  return {
    available,
    recordCycle,
    getSnapshots,
    getWorstRoutes,
    getTrainHistory,
    coverageDays,
  };
})();
