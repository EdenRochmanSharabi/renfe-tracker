/* ===========================================================
 * narrative.js — Gráficos de la sección "La muerte del
 * ferrocarril español" con datos históricos hardcodeados.
 * =========================================================== */
"use strict";

(function () {
  var CRIT = "#ef4444";
  var WARN = "#f59e0b";
  var GOOD = "#10b981";
  var ACCENT = "#38bdf8";
  var MUTED = "#4a5568";
  var TEXT2 = "#7b8ba8";
  var GRID = "rgba(56, 189, 248, 0.06)";

  var baseOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: TEXT2, font: { size: 10, family: "system-ui" }, boxWidth: 12 },
      },
    },
    scales: {
      x: {
        ticks: { color: MUTED, font: { size: 9 } },
        grid: { color: GRID },
      },
      y: {
        ticks: { color: MUTED, font: { size: 9 } },
        grid: { color: GRID },
      },
    },
  };

  function merge(base, overrides) {
    var result = JSON.parse(JSON.stringify(base));
    for (var key in overrides) {
      if (typeof overrides[key] === "object" && !Array.isArray(overrides[key]) && result[key]) {
        result[key] = merge(result[key], overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  function init() {
    // 1. Puntualidad
    new Chart(document.getElementById("chart-punctuality"), {
      type: "line",
      data: {
        labels: ["2015", "2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"],
        datasets: [{
          label: "Puntualidad (%)",
          data: [89.5, 90.2, 90.8, 91.0, 91.0, 93.0, 92.0, 90.5, 88.0, 87.0, 68.2],
          borderColor: CRIT,
          backgroundColor: "rgba(239, 68, 68, 0.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: CRIT,
        }],
      },
      options: merge(baseOpts, {
        scales: {
          y: { min: 60, max: 100, ticks: { callback: function (v) { return v + "%"; } } },
        },
        plugins: { legend: { display: false } },
      }),
    });

    // 2. Inversión: mantenimiento por km, España vs UE
    new Chart(document.getElementById("chart-investment"), {
      type: "bar",
      data: {
        labels: ["2018", "2019", "2020", "2021", "2022"],
        datasets: [
          {
            label: "España (€/km)",
            data: [68000, 70500, 72000, 74000, 95900],
            backgroundColor: "rgba(239, 68, 68, 0.7)",
            borderColor: CRIT,
            borderWidth: 1,
          },
          {
            label: "Media UE (€/km)",
            data: [155000, 162000, 170000, 180000, 191100],
            backgroundColor: "rgba(56, 189, 248, 0.3)",
            borderColor: ACCENT,
            borderWidth: 1,
          },
        ],
      },
      options: merge(baseOpts, {
        scales: {
          y: {
            ticks: {
              callback: function (v) {
                return (v / 1000).toFixed(0) + "k€";
              },
            },
          },
        },
      }),
    });

    // 3. Red ferroviaria (km)
    new Chart(document.getElementById("chart-network"), {
      type: "line",
      data: {
        labels: ["1941", "1950", "1960", "1970", "1980", "1985", "1990", "2000", "2010", "2021"],
        datasets: [{
          label: "km de red",
          data: [12401, 13500, 16000, 17500, 18000, 17086, 16500, 15900, 15800, 15519],
          borderColor: WARN,
          backgroundColor: "rgba(245, 158, 11, 0.08)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: WARN,
        }],
      },
      options: merge(baseOpts, {
        scales: {
          y: {
            min: 10000,
            ticks: {
              callback: function (v) { return (v / 1000).toFixed(0) + "k"; },
            },
          },
        },
        plugins: { legend: { display: false } },
      }),
    });

    // 4. Pasajeros (millones)
    new Chart(document.getElementById("chart-passengers"), {
      type: "bar",
      data: {
        labels: ["2006", "2008", "2010", "2012", "2014", "2016", "2018", "2020", "2022", "2024"],
        datasets: [
          {
            label: "Cercanías",
            data: [430, 420, 400, 380, 390, 405, 420, 250, 390, 442],
            backgroundColor: "rgba(56, 189, 248, 0.6)",
            borderColor: ACCENT,
            borderWidth: 1,
          },
          {
            label: "Media Distancia",
            data: [35, 34, 32, 28, 27, 30, 33, 15, 30, 40],
            backgroundColor: "rgba(245, 158, 11, 0.6)",
            borderColor: WARN,
            borderWidth: 1,
          },
          {
            label: "Larga Distancia + AVE",
            data: [25, 26, 24, 22, 24, 28, 32, 12, 30, 42],
            backgroundColor: "rgba(16, 185, 129, 0.6)",
            borderColor: GOOD,
            borderWidth: 1,
          },
        ],
      },
      options: merge(baseOpts, {
        scales: {
          x: { stacked: true, ticks: { color: MUTED, font: { size: 9 } }, grid: { color: GRID } },
          y: {
            stacked: true,
            ticks: {
              color: MUTED,
              font: { size: 9 },
              callback: function (v) { return v + "M"; },
            },
            grid: { color: GRID },
          },
        },
      }),
    });

    // 5. Muertes ferroviarias
    new Chart(document.getElementById("chart-accidents"), {
      type: "bar",
      data: {
        labels: ["2015", "2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024"],
        datasets: [{
          label: "Muertes",
          data: [22, 19, 21, 23, 20, 15, 18, 24, 24, 18],
          backgroundColor: function (ctx) {
            return ctx.raw >= 22 ? "rgba(239, 68, 68, 0.7)" : "rgba(239, 68, 68, 0.4)";
          },
          borderColor: CRIT,
          borderWidth: 1,
        }],
      },
      options: merge(baseOpts, {
        scales: {
          y: { beginAtZero: true },
        },
        plugins: { legend: { display: false } },
      }),
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
