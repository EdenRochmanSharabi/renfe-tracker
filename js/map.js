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
  let animStart = 0;     // timestamp del último update
  let lastUpdateTime = 0;
  const LERP_MS = 2500;  // transición suave al recibir datos nuevos
  const POLL_MS = 30000;  // intervalo de polling (debe coincidir con app.js)
  let animFrameId = null;
  let animRunning = false;

  /* Máximo de puntos por ruta: por encima se muestrea uniformemente
   * conservando los extremos. */
  const MAX_ROUTE_POINTS = 200;

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

  /** Coordenadas [lon, lat] de una ruta (path real o estaciones). */
  function coordsFor(route) {
    let pts;
    if (route.path && route.path.length > 1) {
      pts = route.path.map((p) => [p.lon, p.lat]);
    } else {
      pts = [];
      if (route.stations) {
        for (const st of route.stations) {
          const c = RENFE.stationCoords(st.code);
          if (c) pts.push([c.lon, c.lat]);
        }
      }
    }
    return downsamplePts(pts, MAX_ROUTE_POINTS);
  }

  function emptyFC() {
    return { type: "FeatureCollection", features: [] };
  }

  function setSourceData(id, data) {
    const src = map.getSource(id);
    if (src) src.setData(data);
  }

  /* ---------- GeoJSON de cada fuente ---------- */

  function stationsFC() {
    const features = [];
    for (const code in RENFE.AVE_STATIONS) {
      const s = RENFE.AVE_STATIONS[code];
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { name: s.name },
      });
    }
    return { type: "FeatureCollection", features };
  }

  function routesFC() {
    const features = [];
    for (const t of lastTrains) {
      const route = lastRoutes[t.id];
      if (!route) continue;
      const coords = coordsFor(route);
      if (coords.length < 2) continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {
          id: t.id,
          state: RENFE.delayState(t.delay),
          dimmed: !!(selectedId && t.id !== selectedId),
        },
      });
    }
    return { type: "FeatureCollection", features };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  /** Calcula la posición interpolada/extrapolada de un tren.
   *  - Los primeros LERP_MS tras un update: lerp suave de prev → target.
   *  - Después: extrapola la velocidad (target - prev) para que el punto
   *    siga avanzando hasta el siguiente update. */
  function livePos(id, now) {
    var tgt = targetPos[id];
    var prv = prevPos[id];
    if (!tgt) return null;
    if (!prv) return [tgt.lon, tgt.lat];

    var elapsed = now - animStart;
    var dLon = tgt.lon - prv.lon;
    var dLat = tgt.lat - prv.lat;

    if (elapsed < LERP_MS) {
      // Fase 1: transición suave prev → target
      var t = elapsed / LERP_MS;
      t = t * (2 - t); // easeOutQuad
      return [lerp(prv.lon, tgt.lon, t), lerp(prv.lat, tgt.lat, t)];
    }
    // Fase 2: extrapolar suavemente — velocidad constante pero limitada
    // a 0.5x la distancia del último salto para no alejar el tren de su ruta.
    if (dLon === 0 && dLat === 0) return [tgt.lon, tgt.lat];
    var extraMs = elapsed - LERP_MS;
    var speed = 1 / POLL_MS;
    var extra = Math.min(extraMs * speed, 0.5);
    return [tgt.lon + dLon * extra, tgt.lat + dLat * extra];
  }

  function trainsFC() {
    var now = performance.now();
    const features = [];
    for (const t of lastTrains) {
      var coords = livePos(t.id, now) || [t.lon, t.lat];
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
    const coords = coordsFor(selRoute);
    if (coords.length < 2) return emptyFC();
    const train = lastTrains.find((t) => t.id === selectedId);
    return {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: { state: train ? RENFE.delayState(train.delay) : "ok" },
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
    map.addSource("routes", { type: "geojson", data: emptyFC() });
    map.addSource("selroute", { type: "geojson", data: emptyFC() });
    map.addSource("stations", { type: "geojson", data: stationsFC() });
    map.addSource("selstops", { type: "geojson", data: emptyFC() });
    map.addSource("trains", { type: "geojson", data: emptyFC() });

    // Rutas de todos los trenes: halo difuso + núcleo.
    map.addLayer({
      id: "routes-glow", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": STATE_GLOW,
        "line-width": 6,
        "line-blur": 3,
        "line-opacity": ["case", ["get", "dimmed"], 0.03,
          ["match", ["get", "state"], "ok", 0.10, "warn", 0.28, "late", 0.30, 0.10]],
      },
    });
    map.addLayer({
      id: "routes-core", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": STATE_CORE,
        "line-width": 2,
        "line-opacity": ["case", ["get", "dimmed"], 0.12,
          ["match", ["get", "state"], "ok", 0.55, "warn", 0.85, "late", 0.9, 0.55]],
      },
    });

    // Ruta seleccionada: resplandor completo en 3 capas.
    map.addLayer({
      id: "selroute-outer", type: "line", source: "selroute",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": STATE_GLOW,
        "line-width": 13,
        "line-blur": 6,
        "line-opacity": 0.3,
      },
    });
    map.addLayer({
      id: "selroute-mid", type: "line", source: "selroute",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": STATE_GLOW,
        "line-width": 6.5,
        "line-blur": 2,
        "line-opacity": 0.5,
      },
    });
    map.addLayer({
      id: "selroute-core", type: "line", source: "selroute",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": STATE_CORE,
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
      minZoom: 4,
      maxZoom: 14,
      // Limitado a la España peninsular + Baleares: el sur queda en el
      // Estrecho (35.8°N) para no mostrar el norte de África, y el este
      // en 4.5°E (justo pasada Menorca).
      maxBounds: [[-10.0, 35.8], [4.5, 44.0]],
      attributionControl: { compact: true },
      // Gestos cooperativos: la rueda sola hace scroll de la página
      // (Ctrl/⌘ + rueda para zoom) y en móvil un dedo desplaza la
      // página mientras que dos dedos mueven el mapa.
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
      seen[t.id] = true;
      var prev = targetPos[t.id];
      if (prev && (prev.lon !== t.lon || prev.lat !== t.lat)) {
        prevPos[t.id] = { lon: prev.lon, lat: prev.lat };
      } else if (!prev) {
        prevPos[t.id] = { lon: t.lon, lat: t.lat };
      }
      targetPos[t.id] = { lon: t.lon, lat: t.lat };
    }
    // Limpiar trenes desaparecidos.
    for (var id in targetPos) {
      if (!seen[id]) { delete targetPos[id]; delete prevPos[id]; }
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
      map.easeTo({ center: [train.lon, train.lat], duration: 600 });
    }
  }

  return { init, updateTrains, selectTrain };
})();
