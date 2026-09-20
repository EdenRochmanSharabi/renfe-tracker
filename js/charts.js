/* ===========================================================
 * charts.js — Gráficos del panel (Chart.js), estética neón
 * 1. Tendencia de retrasos (línea, min): medio + máximo
 * 2. Distribución actual de retrasos (barras por estado)
 * 3. Peores rutas históricas (barras horizontales)
 * Paleta sobre superficie oscura #0a1628; resplandor vía
 * shadowBlur de canvas (plugin propio, sin librerías extra).
 * =========================================================== */
"use strict";

window.RENFE = window.RENFE || {};

RENFE.Charts = (function () {
  // Tinta y cromo (tema centro de mando)
  const INK = "#e0e7ff";
  const INK_MUTED = "#7b8ba8";
  const GRID = "rgba(123, 139, 168, 0.12)";
  const SURFACE = "#0a1628";
  const MONO = '"JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, Menlo, monospace';

  // Series categóricas neón
  const SERIES_CYAN = "#38bdf8";
  const SERIES_CYAN_FILL = "rgba(56, 189, 248, 0.10)";
  const SERIES_RED = "#f87171";

  // Estados (siempre acompañados de etiqueta textual)
  const STATUS_GOOD = "#10b981";
  const STATUS_WARN = "#f59e0b";
  const STATUS_CRIT = "#ef4444";

  let trendChart = null;
  let distChart = null;
  let routesChart = null;

  /**
   * Plugin de resplandor: activa la sombra del canvas mientras se dibuja
   * cada dataset y la limpia después. Ligero y sin dependencias.
   */
  const glowPlugin = {
    id: "neonGlow",
    beforeDatasetDraw(chart, args) {
      const ds = chart.data.datasets[args.index];
      const raw = ds.borderColor || ds.backgroundColor;
      const color = typeof raw === "string" ? raw : "rgba(56, 189, 248, 0.9)";
      const ctx = chart.ctx;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
    },
    afterDatasetDraw(chart) {
      chart.ctx.restore();
    },
  };

  function baseDefaults() {
    Chart.defaults.color = INK_MUTED;
    Chart.defaults.borderColor = GRID;
    Chart.defaults.font.family = MONO;
    Chart.defaults.font.size = 10.5;
    Chart.defaults.plugins.tooltip.backgroundColor = "rgba(15, 31, 56, 0.96)";
    Chart.defaults.plugins.tooltip.titleColor = INK;
    Chart.defaults.plugins.tooltip.bodyColor = INK;
    Chart.defaults.plugins.tooltip.borderColor = "rgba(56, 189, 248, 0.25)";
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.cornerRadius = 6;
    Chart.defaults.plugins.tooltip.padding = 8;
    Chart.defaults.animation.duration = 300;
  }

  function init() {
    baseDefaults();

    // --- Tendencia (línea): dos series, ambas en minutos → un solo eje ---
    trendChart = new Chart(document.getElementById("chart-trend"), {
      type: "line",
      plugins: [glowPlugin],
      data: {
        labels: [],
        datasets: [
          {
            label: "Retraso medio (min)",
            data: [],
            borderColor: SERIES_CYAN,
            backgroundColor: SERIES_CYAN_FILL,
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: SERIES_CYAN,
            tension: 0.25,
            spanGaps: false,
          },
          {
            label: "Retraso máximo (min)",
            data: [],
            borderColor: SERIES_RED,
            backgroundColor: SERIES_RED,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: SERIES_RED,
            tension: 0.25,
            spanGaps: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "top",
            align: "end",
            labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "circle", color: INK_MUTED },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxTicksLimit: 6, maxRotation: 0, color: INK_MUTED },
          },
          y: {
            beginAtZero: true,
            grid: { color: GRID },
            border: { display: false },
            ticks: { maxTicksLimit: 5, color: INK_MUTED },
            title: { display: false },
          },
        },
      },
    });

    // --- Distribución actual (barras): color = estado, etiqueta en el eje ---
    distChart = new Chart(document.getElementById("chart-dist"), {
      type: "bar",
      plugins: [glowPlugin],
      data: {
        labels: ["En hora", "1-5 min", "5-15 min", "15-30 min", ">30 min"],
        datasets: [
          {
            label: "Trenes",
            data: [0, 0, 0, 0, 0],
            backgroundColor: [STATUS_GOOD, STATUS_WARN, STATUS_CRIT, STATUS_CRIT, STATUS_CRIT],
            maxBarThickness: 48,
            borderRadius: 4,
            borderSkipped: "start",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.parsed.y + (ctx.parsed.y === 1 ? " tren" : " trenes"),
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: INK_MUTED } },
          y: {
            beginAtZero: true,
            grid: { color: GRID },
            border: { display: false },
            ticks: { maxTicksLimit: 5, precision: 0, color: INK_MUTED },
          },
        },
      },
    });

    // --- Peores rutas (barras horizontales, una serie → sin leyenda) ---
    routesChart = new Chart(document.getElementById("chart-routes"), {
      type: "bar",
      plugins: [glowPlugin],
      data: {
        labels: [],
        datasets: [
          {
            label: "Retraso medio (min)",
            data: [],
            backgroundColor: SERIES_CYAN,
            maxBarThickness: 14,
            borderRadius: 4,
            borderSkipped: "start",
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const r = ctx.dataset._rows && ctx.dataset._rows[ctx.dataIndex];
                if (!r) return ctx.parsed.x + " min";
                return [
                  "Retraso medio: " + r.avgDelay.toFixed(1) + " min",
                  "Máximo: " + r.maxDelay + " min",
                  "Con retraso: " + r.pctDelayed.toFixed(0) + "% de " + r.observations + " obs.",
                ];
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: GRID },
            border: { display: false },
            ticks: { maxTicksLimit: 5, color: INK_MUTED },
          },
          y: {
            grid: { display: false },
            ticks: {
              color: INK,
              autoSkip: false,
              font: { size: 9.5 },
              callback: function (value) {
                const label = this.getLabelForValue(value);
                return label.length > 42 ? label.slice(0, 41) + "…" : label;
              },
            },
          },
        },
      },
    });
  }

  /** Reduce una serie de instantáneas a ≤ maxPoints por muestreo uniforme. */
  function downsample(rows, maxPoints) {
    if (rows.length <= maxPoints) return rows;
    const out = [];
    const step = rows.length / maxPoints;
    for (let i = 0; i < maxPoints; i++) out.push(rows[Math.floor(i * step)]);
    out[out.length - 1] = rows[rows.length - 1];
    return out;
  }

  function fmtLabel(ts, rangeMs) {
    const d = new Date(ts);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (rangeMs > 26 * 3600 * 1000) {
      const days = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
      return days[d.getDay()] + " " + hm;
    }
    return hm;
  }

  /** Actualiza la línea de tendencia con instantáneas del histórico. */
  function updateTrend(snapshots, rangeMs) {
    var day = snapshots.filter(function (s) { return s.total >= 20; });
    if (!day.length) { trendChart.data.labels = []; trendChart.data.datasets[0].data = []; trendChart.data.datasets[1].data = []; trendChart.update("none"); return; }
    var segments = [[]];
    for (var i = 0; i < day.length; i++) {
      if (i > 0 && day[i].t - day[i - 1].t > 3600000) segments.push([]);
      segments[segments.length - 1].push(day[i]);
    }
    var budget = Math.max(30, 150 - segments.length);
    var rows = [];
    for (var s = 0; s < segments.length; s++) {
      if (s > 0) rows.push({ gap: true });
      var share = Math.max(2, Math.round(budget * segments[s].length / day.length));
      var ds = downsample(segments[s], share);
      for (var j = 0; j < ds.length; j++) rows.push(ds[j]);
    }
    trendChart.data.labels = rows.map(function (r) { return r.gap ? "" : fmtLabel(r.t, rangeMs); });
    trendChart.data.datasets[0].data = rows.map(function (r) { return r.gap ? null : r.avg; });
    trendChart.data.datasets[1].data = rows.map(function (r) { return r.gap ? null : r.max; });
    trendChart.update("none");
  }

  const DIST_KEY = "avetracker:v1:dist";
  let distAccum = null;
  try {
    const raw = localStorage.getItem(DIST_KEY);
    distAccum = raw ? JSON.parse(raw) : [0, 0, 0, 0, 0];
  } catch (e) {
    distAccum = [0, 0, 0, 0, 0];
  }

  function updateDistribution(trains) {
    for (const t of trains) {
      const d = t.delay;
      if (d < 1) distAccum[0]++;
      else if (d <= 5) distAccum[1]++;
      else if (d <= 15) distAccum[2]++;
      else if (d <= 30) distAccum[3]++;
      else distAccum[4]++;
    }
    try { localStorage.setItem(DIST_KEY, JSON.stringify(distAccum)); } catch (e) {}
    distChart.data.datasets[0].data = distAccum.slice();
    distChart.update("none");
  }

  /** Actualiza el ranking de peores rutas históricas. */
  function updateWorstRoutes(rows) {
    routesChart.data.labels = rows.map((r) => r.label);
    routesChart.data.datasets[0].data = rows.map((r) => Math.round(r.avgDelay * 10) / 10);
    routesChart.data.datasets[0]._rows = rows;
    routesChart.update("none");
  }

  return { init, updateTrend, updateDistribution, updateWorstRoutes, SURFACE };
})();
