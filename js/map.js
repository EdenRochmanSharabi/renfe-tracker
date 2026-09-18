/* ===========================================================
 * map.js — Mapa Leaflet: teselas oscuras estilo radar,
 * estaciones con halo, rutas siempre visibles con efecto de
 * resplandor (3 polilíneas superpuestas) y trenes luminosos.
 * =========================================================== */
"use strict";

window.RENFE = window.RENFE || {};

RENFE.Map = (function () {
  let map = null;
  let trainLayer = null;
  let stationLayer = null;
  let routeLayer = null;     // rutas siempre visibles (todas)
  let selStopsLayer = null;  // paradas de la ruta seleccionada
  let routeRenderer = null;  // canvas compartido: cientos de trazos sin coste DOM

  const markers = {};    // trainId → L.Marker
  const routeLines = {}; // trainId → { layers:[outer,mid,core], state, geomKey }
  let onTrainClick = null;
  let selectedId = null;

  /* Colores de ruta por estado de retraso: halo ancho + núcleo brillante. */
  const ROUTE_COLORS = {
    ok:   { glow: "rgba(16, 185, 129, 1)",  core: "#34d399" },
    warn: { glow: "rgba(245, 158, 11, 1)",  core: "#fbbf24" },
    late: { glow: "rgba(239, 68, 68, 1)",   core: "#f87171" },
  };

  /* Máximo de puntos por polilínea: por encima se muestrea uniformemente
   * conservando los extremos. */
  const MAX_ROUTE_POINTS = 50;

  function init(containerId, clickHandler) {
    onTrainClick = clickHandler;

    map = L.map(containerId, {
      center: [40.2, -3.7],
      zoom: 6,
      minZoom: 5,
      maxZoom: 14,
      zoomControl: false,
      attributionControl: true,
      // Zoom continuo estilo Google Maps: cualquier nivel fraccionario,
      // pasos de rueda pequeños y animación nativa de Leaflet siempre activa.
      zoomSnap: 0,
      zoomDelta: 0.25,
      wheelDebounceTime: 40,
      wheelPxPerZoomLevel: 180,
      zoomAnimation: true,
      zoomAnimationThreshold: 4,
      fadeAnimation: true,
      markerZoomAnimation: true,
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    map.setMaxBounds([[34.0, -12.5], [45.5, 6.5]]);

    // Teselas OpenStreetMap oscurecidas vía filtro CSS (clase osm-dark-tiles):
    // sin claves de API y con estética de pantalla de radar.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
      maxNativeZoom: 19,
      className: "osm-dark-tiles",
      updateWhenZooming: false, // no recargar teselas en mitad del zoom
      updateWhenIdle: true,     // cargar solo al terminar la animación
      keepBuffer: 6,            // teselas extra alrededor para pan suave
    }).addTo(map);

    // Todas las rutas comparten un único renderer canvas: dibujar ~300
    // polilíneas como SVG individual arrastraría el DOM.
    routeRenderer = L.canvas({ padding: 0.5 });

    routeLayer = L.layerGroup().addTo(map);
    selStopsLayer = L.layerGroup().addTo(map);
    stationLayer = L.layerGroup().addTo(map);
    trainLayer = L.layerGroup().addTo(map);

    drawStations();

    map.on("click", () => {
      if (onTrainClick) onTrainClick(null);
    });

    // Clase "moving" en el contenedor mientras el mapa se desplaza o hace
    // zoom: el CSS la usa para desactivar transiciones de marcadores,
    // pausar pulsos y ocultar las capas de efecto (scanlines/rejilla).
    const container = map.getContainer();
    map.on("zoomstart movestart", () => container.classList.add("moving"));
    map.on("zoomend moveend", () => container.classList.remove("moving"));

    return map;
  }

  function drawStations() {
    const icon = L.divIcon({
      className: "station-icon-wrap",
      html: '<div class="station-icon"></div>',
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    });
    for (const code in RENFE.AVE_STATIONS) {
      const s = RENFE.AVE_STATIONS[code];
      const m = L.marker([s.lat, s.lon], { icon: icon, keyboard: false });
      m.bindTooltip(s.name, { direction: "top", offset: [0, -8], className: "station-tip" });
      m.addTo(stationLayer);
    }
  }

  /* ---------- Marcadores de tren ---------- */

  function iconFor(train, isSelected) {
    const state = RENFE.delayState(train.delay); // ok | warn | late
    const sel = isSelected ? " selected" : "";
    return L.divIcon({
      // train-move activa la transición CSS de transform → movimiento suave.
      className: "train-icon-wrap train-move",
      html: '<div class="train-icon s-' + state + sel + '"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  /** Reasigna el icono solo si el estado visual cambió: setIcon recrea el
   *  nodo DOM y cortaría la transición suave de posición. */
  function refreshIcon(m, train, isSelected) {
    const key = RENFE.delayState(train.delay) + (isSelected ? ":sel" : "");
    if (m._iconKey !== key) {
      m.setIcon(iconFor(train, isSelected));
      m._iconKey = key;
    }
  }

  function tooltipHtml(t) {
    const state = RENFE.delayState(t.delay);
    return (
      '<div class="tip-title">' + t.type + " " + t.number + "</div>" +
      RENFE.routeLabel(t.origin, t.destination) + "<br>" +
      '<span class="tip-delay-' + state + '">' + RENFE.delayLabel(t.delay) + "</span>"
    );
  }

  /* ---------- Rutas siempre visibles ---------- */

  /** Muestreo uniforme conservando extremos: rutas con cientos de puntos
   *  no aportan detalle visible y encarecen cada redibujado del canvas. */
  function downsamplePts(pts, maxPts) {
    if (pts.length <= maxPts) return pts;
    const out = [];
    const step = (pts.length - 1) / (maxPts - 1);
    for (let i = 0; i < maxPts; i++) out.push(pts[Math.round(i * step)]);
    return out;
  }

  function latlngsFor(route) {
    let pts;
    if (route.path && route.path.length > 1) {
      pts = route.path.map((p) => [p.lat, p.lon]);
    } else {
      pts = [];
      if (route.stations) {
        for (const st of route.stations) {
          const c = RENFE.stationCoords(st.code);
          if (c) pts.push([c.lat, c.lon]);
        }
      }
    }
    return downsamplePts(pts, MAX_ROUTE_POINTS);
  }

  /**
   * Especifica las capas de una ruta según estado y modo. Menos polilíneas
   * = zoom más fluido: los trenes en hora llevan una sola línea fina, los
   * retrasados halo + núcleo, y solo el seleccionado el resplandor
   * completo de 3 capas.
   */
  function layerSpecs(state, mode) {
    const colors = ROUTE_COLORS[state] || ROUTE_COLORS.ok;
    if (mode === "hi") {
      return [
        { color: colors.glow, weight: 13,  opacity: 0.22 },
        { color: colors.glow, weight: 6.5, opacity: 0.48 },
        { color: colors.core, weight: 3,   opacity: 1.0 },
      ];
    }
    const dim = mode === "dim";
    if (state === "ok") {
      return [{ color: colors.core, weight: 2, opacity: dim ? 0.10 : 0.55 }];
    }
    return [
      { color: colors.glow, weight: 4.5, opacity: dim ? 0.08 : 0.25 },
      { color: colors.core, weight: 2,   opacity: dim ? 0.20 : 0.85 },
    ];
  }

  function modeFor(id) {
    if (!selectedId) return "base";
    return id === selectedId ? "hi" : "dim";
  }

  /** (Re)construye las polilíneas de una ruta según su spec actual. */
  function buildLayers(rl) {
    const specs = layerSpecs(rl.state, rl.mode);
    for (const layer of rl.layers) routeLayer.removeLayer(layer);
    rl.layers = specs.map((s) =>
      L.polyline(rl.latlngs, {
        renderer: routeRenderer,
        interactive: false,
        lineCap: "round",
        lineJoin: "round",
        color: s.color,
        weight: s.weight,
        opacity: s.opacity,
      }).addTo(routeLayer)
    );
  }

  function applyRouteStyle(id) {
    const rl = routeLines[id];
    if (!rl) return;
    const mode = modeFor(id);
    const specs = layerSpecs(rl.state, mode);
    if (specs.length !== rl.layers.length) {
      rl.mode = mode;
      buildLayers(rl);
    } else {
      rl.mode = mode;
      for (let i = 0; i < specs.length; i++) rl.layers[i].setStyle(specs[i]);
    }
    if (mode === "hi") {
      for (const layer of rl.layers) layer.bringToFront();
    }
  }

  function restyleAllRoutes() {
    for (const id in routeLines) applyRouteStyle(id);
  }

  function removeRouteLine(id) {
    const rl = routeLines[id];
    if (!rl) return;
    for (const layer of rl.layers) routeLayer.removeLayer(layer);
    delete routeLines[id];
  }

  /** Crea o actualiza la ruta luminosa de un tren. Redibuja solo si cambió
   *  la geometría; un cambio de estado de retraso es solo re-estilo. */
  function ensureRouteLine(train, route) {
    const latlngs = latlngsFor(route);
    if (latlngs.length < 2) return;
    const state = RENFE.delayState(train.delay);
    const geomKey =
      latlngs.length + ":" +
      latlngs[0][0].toFixed(3) + ":" +
      latlngs[latlngs.length - 1][0].toFixed(3);

    let rl = routeLines[train.id];
    if (rl && rl.geomKey === geomKey) {
      if (rl.state !== state) {
        rl.state = state;
        applyRouteStyle(train.id);
      }
      return;
    }
    if (rl) removeRouteLine(train.id);

    rl = routeLines[train.id] = {
      layers: [],
      state: state,
      geomKey: geomKey,
      latlngs: latlngs,
      mode: modeFor(train.id),
    };
    buildLayers(rl);
    if (rl.mode === "hi") applyRouteStyle(train.id);
  }

  /* ---------- Ciclo de actualización ---------- */

  /**
   * Pinta/actualiza marcadores de trenes visibles y sus rutas.
   * `routes` es el mapa idTren → {stations, path} de app.js; las rutas de
   * trenes filtrados o ya inactivos se retiran del mapa.
   */
  function updateTrains(trains, routes) {
    routes = routes || {};
    const seen = new Set();
    for (const t of trains) {
      seen.add(t.id);
      const isSel = t.id === selectedId;
      let m = markers[t.id];
      if (m) {
        m.setLatLng([t.lat, t.lon]);
        refreshIcon(m, t, isSel);
        m._train = t;
      } else {
        m = L.marker([t.lat, t.lon], {
          icon: iconFor(t, isSel),
          keyboard: false,
          riseOnHover: true,
        });
        m._iconKey = RENFE.delayState(t.delay) + (isSel ? ":sel" : "");
        m._train = t;
        m.on("click", (ev) => {
          L.DomEvent.stopPropagation(ev);
          if (onTrainClick) onTrainClick(m._train.id);
        });
        m.bindTooltip("", { direction: "top", offset: [0, -12], className: "train-tip" });
        m.addTo(trainLayer);
        markers[t.id] = m;
      }
      m.setTooltipContent(tooltipHtml(t));

      const route = routes[t.id];
      if (route) ensureRouteLine(t, route);
    }

    // Eliminar marcadores y rutas de trenes fuera de servicio o filtrados.
    for (const id in markers) {
      if (!seen.has(id)) {
        trainLayer.removeLayer(markers[id]);
        delete markers[id];
      }
    }
    for (const id in routeLines) {
      if (!seen.has(id)) removeRouteLine(id);
    }
  }

  /* ---------- Selección ---------- */

  /** Marca un tren como seleccionado: su ruta se realza, el resto se atenúa. */
  function selectTrain(id, train, route) {
    const prev = selectedId;
    selectedId = id;

    if (prev && markers[prev] && markers[prev]._train) {
      refreshIcon(markers[prev], markers[prev]._train, false);
    }
    selStopsLayer.clearLayers();

    if (id && markers[id] && markers[id]._train) {
      refreshIcon(markers[id], markers[id]._train, true);
    }

    // Si aún no había línea para este tren (p. ej. filtrado antes), créala.
    if (id && train && route && !routeLines[id]) {
      ensureRouteLine(train, route);
    }
    restyleAllRoutes();

    if (!id) return;

    // Paradas de la ruta seleccionada.
    if (route && route.stations) {
      for (const st of route.stations) {
        const c = RENFE.stationCoords(st.code);
        if (!c) continue;
        L.circleMarker([c.lat, c.lon], {
          renderer: routeRenderer,
          radius: 4.5,
          color: "#38bdf8",
          weight: 2,
          fillColor: "#04080f",
          fillOpacity: 1,
          interactive: false,
        }).addTo(selStopsLayer);
      }
    }
    if (train) {
      map.panTo([train.lat, train.lon], { animate: true });
    }
  }

  return { init, updateTrains, selectTrain };
})();
