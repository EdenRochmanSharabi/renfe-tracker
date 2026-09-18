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

  /* Máximo de puntos por ruta: por encima se muestrea uniformemente
   * conservando los extremos. */
  const MAX_ROUTE_POINTS = 50;

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

  /** Estilo vectorial oscuro sobre OpenFreeMap (gratuito, sin clave):
   *  teselas vectoriales → zoom continuo renderizado en GPU. */
  const VECTOR_STYLE = {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      openmaptiles: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; OpenMapTiles',
      },
    },
    layers: [
      { id: "background", type: "background",
        paint: { "background-color": "#04080f" } },
      { id: "water", type: "fill", source: "openmaptiles",
        "source-layer": "water",
        paint: { "fill-color": "#0a1628" } },
      { id: "waterway", type: "line", source: "openmaptiles",
        "source-layer": "waterway",
        paint: { "line-color": "rgba(10, 22, 40, 0.9)", "line-width": 1 } },
      { id: "boundary", type: "line", source: "openmaptiles",
        "source-layer": "boundary",
        filter: ["<=", ["get", "admin_level"], 4],
        paint: {
          "line-color": "rgba(56, 189, 248, 0.16)",
          "line-width": 1,
        } },
      { id: "rail", type: "line", source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "rail"],
        paint: {
          "line-color": "rgba(56, 189, 248, 0.10)",
          "line-width": 0.6,
        } },
      { id: "roads", type: "line", source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]],
        paint: {
          "line-color": "rgba(56, 189, 248, 0.06)",
          "line-width": 0.5,
        } },
      { id: "places", type: "symbol", source: "openmaptiles",
        "source-layer": "place",
        filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
        layout: {
          "text-field": "{name}",
          "text-font": ["Noto Sans Regular"],
          "text-size": ["step", ["zoom"], 11, 8, 12],
          "text-max-width": 8,
        },
        paint: {
          "text-color": "rgba(123, 139, 168, 0.85)",
          "text-halo-color": "#04080f",
          "text-halo-width": 1.2,
        } },
    ],
  };

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

  function trainsFC() {
    const features = [];
    for (const t of lastTrains) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [t.lon, t.lat] },
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

    // Estaciones AVE: halo + punto.
    map.addLayer({
      id: "stations-glow", type: "circle", source: "stations",
      paint: {
        "circle-radius": 6,
        "circle-color": "rgba(56, 189, 248, 0.2)",
        "circle-blur": 0.8,
      },
    });
    map.addLayer({
      id: "stations-dot", type: "circle", source: "stations",
      paint: {
        "circle-radius": 3,
        "circle-color": "#0f1f38",
        "circle-stroke-color": "rgba(56, 189, 248, 0.75)",
        "circle-stroke-width": 1.5,
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
      style: VECTOR_STYLE,
      center: [-3.7, 40.2],
      zoom: 5.5,
      minZoom: 4,
      maxZoom: 14,
      maxBounds: [[-12.5, 34.0], [6.5, 45.5]],
      attributionControl: { compact: true },
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
      const fromVector =
        e.sourceId === "openmaptiles" || msg.indexOf("openfreemap") !== -1;
      if (fromVector) {
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
    lastTrains = trains || [];
    lastRoutes = routes || {};
    // Refrescar la ruta seleccionada si llega una versión más nueva.
    if (selectedId && lastRoutes[selectedId]) {
      selRoute = lastRoutes[selectedId];
    }
    refreshAll();
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
