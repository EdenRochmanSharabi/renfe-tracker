"use strict";

window.RENFE = window.RENFE || {};

RENFE.History = (function () {
  var TRAIN_SAMPLE_MS = 10 * 60 * 1000;
  var MAX_TRAIN_SAMPLES = 200;

  var serverSnapshots = [];
  var serverRoutes = null;
  var trainHist = {};

  function loadServerSnapshots(hours) {
    var h = Math.ceil(hours / 3600000);
    fetch("/api/history?type=stats&hours=" + h)
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.data && json.data.length) {
          serverSnapshots = json.data.map(function (e) {
            return {
              t: e.ts * 1000,
              total: e.total,
              delayed: e.delayed,
              avg: e.avgDelay,
              max: e.maxDelay,
            };
          });
        }
      })
      .catch(function () {});
  }

  function loadServerRoutes() {
    fetch("/api/history?type=worstroutes&top=20")
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (json.data && json.data.length) {
          serverRoutes = json.data.map(function (r) {
            var parts = r.route.split("-");
            var label = parts.length === 2
              ? RENFE.routeLabel(parts[0], parts[1])
              : r.route;
            return {
              key: r.route,
              label: label,
              avgDelay: r.avgDelay,
              pctDelayed: r.pctDelayed,
              maxDelay: 0,
              observations: r.n,
            };
          });
        }
      })
      .catch(function () {});
  }

  function recordCycle(stats, trains) {
    var now = Date.now();
    for (var i = 0; i < trains.length; i++) {
      var t = trains[i];
      var h = trainHist[t.id];
      if (!h) h = trainHist[t.id] = { route: t.origin + "-" + t.destination, samples: [] };
      h.route = t.origin + "-" + t.destination;
      var last = h.samples[h.samples.length - 1];
      if (!last || now - last.t >= TRAIN_SAMPLE_MS) {
        h.samples.push({ t: now, d: t.delay });
        if (h.samples.length > MAX_TRAIN_SAMPLES) h.samples.shift();
      }
    }
  }

  function getSnapshots(sinceMs) {
    var cutoff = Date.now() - sinceMs;
    return serverSnapshots.filter(function (s) { return s.t >= cutoff; });
  }

  function getWorstRoutes(topN) {
    if (serverRoutes && serverRoutes.length) {
      return serverRoutes.slice(0, topN || 8);
    }
    return [];
  }

  function getTrainHistory(id) {
    return (trainHist[id] && trainHist[id].samples) || [];
  }

  return {
    loadServerSnapshots: loadServerSnapshots,
    loadServerRoutes: loadServerRoutes,
    recordCycle: recordCycle,
    getSnapshots: getSnapshots,
    getWorstRoutes: getWorstRoutes,
    getTrainHistory: getTrainHistory,
  };
})();
