/* ===========================================================
 * app.js — Orquestación: sondeo, filtros, panel y detalles
 * =========================================================== */
"use strict";

(function () {
  const FLEET_INTERVAL_MS = 15000;   // flota cada 15 s
  const ROUTES_EVERY_N_CYCLES = 8;   // rutas cada 120 s
  const STALE_MS = 45000;            // datos "antiguos" a partir de 45 s

  const state = {
    trains: [],
    routes: {},
    stats: null,
    lastUpdate: null,
    lastFetchOk: null,
    connected: false,
    cycle: 0,
    selectedId: null,
    trendRangeMs: 24 * 3600 * 1000,
    filters: { type: "all", onlyDelayed: false, search: "" },
  };

  const $ = (sel) => document.querySelector(sel);

  // ---------- Filtros ----------
  function applyFilters(trains) {
    const f = state.filters;
    const q = f.search.trim().toLowerCase();
    return trains.filter((t) => {
      if (f.type !== "all" && t.type !== f.type) return false;
      if (f.onlyDelayed && t.delay < 1) return false;
      if (q) {
        const hay =
          t.number.toLowerCase().includes(q) ||
          t.type.toLowerCase().includes(q) ||
          (t.type + " " + t.number).toLowerCase().includes(q) ||
          RENFE.stationName(t.origin).toLowerCase().includes(q) ||
          RENFE.stationName(t.destination).toLowerCase().includes(q);
        if (!hay) return false;
      }
      return true;
    });
  }

  // ---------- Sondeo ----------
  async function fetchCycle() {
    state.cycle++;
    const wantRoutes =
      state.cycle === 1 || state.cycle % ROUTES_EVERY_N_CYCLES === 0 ||
      !Object.keys(state.routes).length;
    try {
      const fleetPromise = RENFE.fetchJSON(RENFE.ENDPOINTS.fleet);
      // El catch inmediato evita un "unhandled rejection" si la flota falla
      // antes de que lleguemos a esperar las rutas.
      const routesPromise = wantRoutes
        ? RENFE.fetchJSON(RENFE.ENDPOINTS.routes).catch((e) => {
            console.warn("Rutas no disponibles:", e.message);
            return null;
          })
        : null;

      const fleetJson = await fleetPromise;
      const { updated, trains } = RENFE.processFleet(fleetJson);
      state.trains = trains;
      state.lastUpdate = updated;
      state.lastFetchOk = Date.now();
      state.connected = true;

      if (routesPromise) {
        const routesJson = await routesPromise;
        if (routesJson) {
          state.routes = RENFE.processRoutes(routesJson);
          RENFE.learnStationCoords(state.routes);
        }
      }

      state.stats = RENFE.computeStats(state.trains);
      RENFE.History.recordCycle(state.stats, state.trains);
      render();
    } catch (err) {
      console.warn("Fallo al obtener flota:", err.message);
      state.connected = false;
      renderStatus();
    }
  }

  // ---------- Render ----------
  function dismissBoot() {
    const boot = $("#boot-overlay");
    if (boot && !boot.classList.contains("done")) boot.classList.add("done");
  }

  function pulseTimestamp() {
    const el = $("#last-update");
    el.classList.remove("tick");
    void el.offsetWidth; // reinicia la animación
    el.classList.add("tick");
  }

  function render() {
    const visible = applyFilters(state.trains);
    RENFE.Map.updateTrains(visible, state.routes);
    dismissBoot();
    pulseTimestamp();
    renderStatus();
    renderStats(visible);
    renderWorstNow(visible);
    renderCharts();
    if (state.selectedId) {
      const t = state.trains.find((x) => x.id === state.selectedId);
      if (t) renderDetails(t);
      else closeDetails();
    }
    $("#visible-count").textContent =
      visible.length === state.trains.length
        ? state.trains.length + " trenes"
        : visible.length + " de " + state.trains.length + " trenes";
  }

  function renderStatus() {
    const dot = $("#status-dot");
    const txt = $("#status-text");
    // Un ciclo fallido aislado no es "sin conexión": solo avisamos cuando
    // los datos superan el umbral de antigüedad.
    const fresh = state.lastFetchOk && Date.now() - state.lastFetchOk <= STALE_MS;
    if (fresh) {
      dot.className = "status-dot on";
      txt.textContent = state.connected ? "Conectado" : "Conectado (reintentando…)";
    } else if (state.lastFetchOk) {
      dot.className = "status-dot warn";
      txt.textContent = "Sin conexión — mostrando datos antiguos";
    } else {
      dot.className = "status-dot off";
      txt.textContent = "Conectando…";
    }
    $("#last-update").textContent = state.lastUpdate
      ? "Actualizado " + state.lastUpdate.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "—";
  }

  function renderStats(visible) {
    const s = RENFE.computeStats(visible);
    $("#stat-total").textContent = s.total;
    $("#stat-delayed").textContent = s.delayed + "/" + s.total;
    $("#stat-avg").textContent = s.delayed ? s.avgDelay.toFixed(1) + "'" : "0'";
    $("#stat-max").textContent = s.maxDelay + "'";
    $("#stat-delayed").className = "stat-value " + (s.delayed ? "c-crit" : "c-good");
    $("#stat-max").className = "stat-value " + (s.maxDelay > 5 ? "c-crit" : s.maxDelay >= 1 ? "c-warn" : "c-good");
  }

  function renderWorstNow(visible) {
    const list = $("#worst-list");
    const worst = visible
      .filter((t) => t.delay >= 1)
      .sort((a, b) => b.delay - a.delay)
      .slice(0, 5);
    if (!worst.length) {
      list.innerHTML = '<li class="empty">Sin retrasos ahora mismo</li>';
      return;
    }
    list.innerHTML = worst
      .map((t) => {
        const st = RENFE.delayState(t.delay);
        return (
          '<li data-id="' + t.id + '" class="sev-' + st + '">' +
          '<span class="badge b-' + st + '">' + RENFE.delayLabel(t.delay) + "</span>" +
          '<span class="worst-train">' + t.type + " " + t.number + "</span>" +
          '<span class="worst-route">' + RENFE.routeLabel(t.origin, t.destination) + "</span>" +
          "</li>"
        );
      })
      .join("");
    list.querySelectorAll("li[data-id]").forEach((li) => {
      li.addEventListener("click", () => {
        selectTrain(li.getAttribute("data-id"));
        const mapWrap = document.getElementById("map-wrap");
        if (mapWrap) mapWrap.scrollIntoView({ behavior: "smooth", block: "start" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  function renderCharts() {
    RENFE.Charts.updateTrend(RENFE.History.getSnapshots(state.trendRangeMs), state.trendRangeMs);
    RENFE.Charts.updateDistribution(state.trains);
    const worst = RENFE.History.getWorstRoutes(8, 10);
    RENFE.Charts.updateWorstRoutes(worst);
    renderRoutesTable(worst);
    $("#coverage-note").textContent =
      RENFE.History.coverageDays() <= 1
        ? "Historico local: recopilando datos desde hoy."
        : "Historico local de " + RENFE.History.coverageDays() + " dias.";
  }

  function renderRoutesTable(rows) {
    const tbody = $("#routes-table tbody");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">Aún no hay suficientes observaciones</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) =>
          "<tr><td>" + r.label + "</td><td>" + r.avgDelay.toFixed(1) +
          "</td><td>" + r.maxDelay + "</td><td>" + r.pctDelayed.toFixed(0) + "%</td></tr>"
      )
      .join("");
  }

  // ---------- Selección y detalles ----------
  function selectTrain(id) {
    state.selectedId = id;
    const t = id ? state.trains.find((x) => x.id === id) : null;
    RENFE.Map.selectTrain(id, t, id ? state.routes[id] : null);
    if (t) renderDetails(t);
    else closeDetails();
  }

  function fmtIsoTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? "—" : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }

  function renderDetails(t) {
    const panel = $("#details");
    panel.classList.add("open");
    const st = RENFE.delayState(t.delay);
    $("#det-title").innerHTML =
      '<span class="badge b-' + st + '">' + RENFE.delayLabel(t.delay) + "</span> " +
      t.type + " " + t.number;
    $("#det-route").textContent = RENFE.routeLabel(t.origin, t.destination);
    $("#det-meta").innerHTML =
      "<div><span>Última parada</span><strong>" + RENFE.stationName(t.prevStation) + "</strong></div>" +
      "<div><span>Próxima parada</span><strong>" + RENFE.stationName(t.nextStation) +
      " (" + fmtIsoTime(t.arrNext) + ")</strong></div>" +
      "<div><span>Material</span><strong>" + (t.mat || "—") + "</strong></div>" +
      "<div><span>Accesible</span><strong>" + (t.accessible ? "Sí" : "No") + "</strong></div>";

    const route = state.routes[t.id];
    const listEl = $("#det-stops");
    if (!route || !route.stations.length) {
      listEl.innerHTML = '<li class="empty">Itinerario no disponible</li>';
    } else {
      const prevIdx = route.stations.findIndex((s) => s.code === t.prevStation);
      listEl.innerHTML = route.stations
        .map((s, i) => {
          const passed = prevIdx >= 0 && i <= prevIdx;
          const isNext = s.code === t.nextStation;
          const dState = s.delay === null ? "" : RENFE.delayState(Math.max(0, s.delay));
          const delayTxt =
            s.delay === null ? "" :
            s.delay >= 1 ? '<span class="stop-delay c-' + (s.delay > 5 ? "crit" : "warn") + '">+' + s.delay + "'</span>" :
            '<span class="stop-delay c-good">en hora</span>';
          return (
            '<li class="' + (passed ? "passed" : "") + (isNext ? " next" : "") + '">' +
            '<span class="stop-dot s-' + (dState || "ok") + '"></span>' +
            '<span class="stop-name">' + RENFE.stationName(s.code) + "</span>" +
            '<span class="stop-times">' + (s.sched || "—") +
            (s.actual && s.actual !== s.sched ? " → " + s.actual : "") + "</span>" +
            delayTxt +
            "</li>"
          );
        })
        .join("");
    }

    // Mini-histórico del tren (observaciones locales)
    const hist = RENFE.History.getTrainHistory(t.id);
    $("#det-history").textContent = hist.length > 1
      ? "Observado " + hist.length + " veces; retraso máximo registrado " +
        Math.max(...hist.map((h) => h.d)) + " min."
      : "Primera observación de este tren en tu histórico local.";
  }

  function closeDetails() {
    state.selectedId = null;
    $("#details").classList.remove("open");
    RENFE.Map.selectTrain(null, null, null);
  }

  // ---------- Modal historico ----------
  let delayChart = null;

  function closeDelayModal() {
    $("#delay-modal").hidden = true;
  }

  async function openDelayModal(hours) {
    $("#delay-modal").hidden = false;
    const canvas = $("#chart-delay-history");
    try {
      const resp = await fetch("/api/history?type=stats&hours=" + hours);
      const json = await resp.json();
      const entries = json.data || [];
      if (!entries.length) return;

      const byHour = {};
      for (const e of entries) {
        const d = new Date(e.ts * 1000);
        const key = d.getFullYear() + "-" +
          String(d.getMonth() + 1).padStart(2, "0") + "-" +
          String(d.getDate()).padStart(2, "0") + " " +
          String(d.getHours()).padStart(2, "0") + ":00";
        if (!byHour[key]) byHour[key] = { delayed: [], total: [] };
        byHour[key].delayed.push(e.delayed);
        byHour[key].total.push(e.total);
      }

      const allLabels = Object.keys(byHour).sort();
      const labels = allLabels.filter((k) => {
        const arr = byHour[k].total;
        var avg = arr.reduce((s, v) => s + v, 0) / arr.length;
        return avg >= 20;
      });
      const delayedData = labels.map((k) => {
        const arr = byHour[k].delayed;
        return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
      });
      const totalData = labels.map((k) => {
        const arr = byHour[k].total;
        return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
      });
      const shortLabels = labels.map((l) => {
        const parts = l.split(" ");
        return hours <= 24 ? parts[1] : parts[0].slice(5) + " " + parts[1];
      });

      if (delayChart) delayChart.destroy();
      delayChart = new Chart(canvas, {
        type: "bar",
        data: {
          labels: shortLabels,
          datasets: [
            {
              label: "Con retraso",
              data: delayedData,
              backgroundColor: "rgba(239, 68, 68, 0.7)",
              borderColor: "#ef4444",
              borderWidth: 1,
            },
            {
              label: "Total trenes",
              data: totalData,
              backgroundColor: "rgba(56, 189, 248, 0.25)",
              borderColor: "#38bdf8",
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: {
              labels: { color: "#7b8ba8", font: { size: 10, family: "system-ui" }, boxWidth: 12 },
            },
            tooltip: {
              callbacks: {
                afterBody: function (items) {
                  if (items.length >= 2) {
                    var del = items[0].raw;
                    var tot = items[1].raw;
                    return tot ? (del / tot * 100).toFixed(0) + "% con retraso" : "";
                  }
                  return "";
                },
              },
            },
          },
          scales: {
            x: {
              ticks: { color: "#4a5568", font: { size: 9 }, maxRotation: 45 },
              grid: { color: "rgba(56, 189, 248, 0.06)" },
            },
            y: {
              beginAtZero: true,
              ticks: { color: "#4a5568", font: { size: 9 } },
              grid: { color: "rgba(56, 189, 248, 0.06)" },
            },
          },
        },
      });
    } catch (err) {
      console.warn("Error loading delay history:", err);
    }
  }

  // ---------- Arranque ----------
  function bindUI() {
    $("#filter-type").addEventListener("change", (e) => {
      state.filters.type = e.target.value;
      render();
    });
    $("#filter-delayed").addEventListener("change", (e) => {
      state.filters.onlyDelayed = e.target.checked;
      render();
    });
    const searchInput = $("#filter-search");
    const searchResults = $("#search-results");
    let searchActiveIdx = -1;

    function showSearchResults() {
      const q = state.filters.search.trim().toLowerCase();
      if (!q || q.length < 2) {
        searchResults.hidden = true;
        searchActiveIdx = -1;
        return;
      }
      const matches = state.trains.filter((t) => {
        return (
          t.number.toLowerCase().includes(q) ||
          t.type.toLowerCase().includes(q) ||
          (t.type + " " + t.number).toLowerCase().includes(q) ||
          RENFE.stationName(t.origin).toLowerCase().includes(q) ||
          RENFE.stationName(t.destination).toLowerCase().includes(q)
        );
      }).slice(0, 8);

      if (!matches.length) {
        searchResults.innerHTML = '<li style="cursor:default;color:var(--muted)">Sin resultados</li>';
        searchResults.hidden = false;
        searchActiveIdx = -1;
        return;
      }

      searchResults.innerHTML = matches.map((t, i) => {
        const st = RENFE.delayState(t.delay);
        const delayColor = st === "ok" ? "var(--good)" : st === "warn" ? "var(--warn)" : "var(--crit)";
        return (
          '<li data-id="' + t.id + '"' + (i === searchActiveIdx ? ' class="active"' : '') + '>' +
          '<span class="sr-type">' + t.type + ' ' + t.number + '</span>' +
          '<span class="sr-route">' + RENFE.routeLabel(t.origin, t.destination) + '</span>' +
          '<span class="sr-delay" style="color:' + delayColor + '">' + RENFE.delayLabel(t.delay) + '</span>' +
          '</li>'
        );
      }).join("");

      searchResults.hidden = false;

      searchResults.querySelectorAll("li[data-id]").forEach((li) => {
        li.addEventListener("click", () => {
          const id = li.getAttribute("data-id");
          zoomToTrain(id);
        });
      });
    }

    function zoomToTrain(id) {
      searchResults.hidden = true;
      searchActiveIdx = -1;
      searchInput.value = "";
      state.filters.search = "";
      const t = state.trains.find((x) => x.id === id);
      if (!t) return;
      render();
      selectTrain(id);
      var mapWrap = document.getElementById("map-wrap");
      if (mapWrap) mapWrap.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    searchInput.addEventListener("input", (e) => {
      state.filters.search = e.target.value;
      searchActiveIdx = -1;
      showSearchResults();
      render();
    });

    searchInput.addEventListener("keydown", (e) => {
      const items = searchResults.querySelectorAll("li[data-id]");
      if (!items.length || searchResults.hidden) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        searchActiveIdx = Math.min(searchActiveIdx + 1, items.length - 1);
        items.forEach((li, i) => li.classList.toggle("active", i === searchActiveIdx));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        searchActiveIdx = Math.max(searchActiveIdx - 1, 0);
        items.forEach((li, i) => li.classList.toggle("active", i === searchActiveIdx));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const idx = searchActiveIdx >= 0 ? searchActiveIdx : 0;
        if (items[idx]) {
          zoomToTrain(items[idx].getAttribute("data-id"));
          searchInput.blur();
        }
      } else if (e.key === "Escape") {
        searchResults.hidden = true;
        searchActiveIdx = -1;
      }
    });

    searchInput.addEventListener("focus", () => {
      if (state.filters.search.trim().length >= 2) showSearchResults();
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrap")) {
        searchResults.hidden = true;
        searchActiveIdx = -1;
      }
    });
    $("#det-close").addEventListener("click", closeDetails);

    document.querySelectorAll("#trend-range button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#trend-range button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.trendRangeMs = parseInt(btn.getAttribute("data-ms"), 10);
        renderCharts();
      });
    });

    // Modal de retrasos historicos
    $("#stat-delayed-card").addEventListener("click", () => openDelayModal(24));
    $("#delay-modal-close").addEventListener("click", closeDelayModal);
    $("#delay-modal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeDelayModal();
    });
    document.querySelectorAll("#delay-modal .modal-range button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#delay-modal .modal-range button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        openDelayModal(parseInt(btn.getAttribute("data-hours"), 10));
      });
    });

    $("#routes-view-toggle").addEventListener("click", () => {
      const tableWrap = $("#routes-table-wrap");
      const canvasWrap = $("#routes-canvas-wrap");
      const showTable = tableWrap.hidden;
      tableWrap.hidden = !showTable;
      canvasWrap.hidden = showTable;
      $("#routes-view-toggle").textContent = showTable ? "Ver gráfico" : "Ver tabla";
    });
  }

  function start() {
    RENFE.Map.init("map", (id) => {
      if (id) selectTrain(id);
      else closeDetails();
    });
    RENFE.Charts.init();
    bindUI();

    if (!RENFE.History.available) {
      $("#coverage-note").textContent =
        "localStorage no disponible: el histórico no se guardará entre sesiones.";
    }

    fetchCycle();
    setInterval(fetchCycle, FLEET_INTERVAL_MS);
    setInterval(renderStatus, 5000); // refresca el aviso de datos antiguos

    // Red de seguridad: si el feed no responde, no dejar la pantalla de
    // arranque bloqueando la interfaz.
    setTimeout(dismissBoot, 12000);
  }

  document.addEventListener("DOMContentLoaded", start);
})();
