/* ===========================================================
 * stations.js — Base de datos de estaciones AVE / Largo Recorrido
 *
 * Dos espacios de códigos conviven aquí:
 *  - AVE_STATIONS: catálogo estático (nombre + coordenadas) usado para
 *    pintar las estaciones principales en el mapa.
 *  - FEED_STATION_NAMES: mapeo código→nombre VERIFICADO contra el feed
 *    real de renfe-visor (cada código se cruzó con las coordenadas de
 *    las polilíneas "secuencia" y se asignó a la estación conocida a
 *    <2 km). El feed usa códigos Adif clásicos que no siempre coinciden
 *    con los del catálogo estático (p. ej. en el feed 10600 es
 *    Valladolid, no Córdoba), de ahí la verificación empírica y el
 *    guardarraíl por distancia en stationName().
 * =========================================================== */
"use strict";

window.RENFE = window.RENFE || {};

// Estaciones principales de alta velocidad (se pintan en el mapa).
RENFE.AVE_STATIONS = {
  "60000": { name: "Madrid-Puerta de Atocha", lat: 40.4065, lon: -3.6907 },
  "71801": { name: "Barcelona-Sants", lat: 41.3793, lon: 2.1404 },
  "51003": { name: "Sevilla-Santa Justa", lat: 37.3919, lon: -5.9775 },
  "54400": { name: "Málaga-María Zambrano", lat: 36.7125, lon: -4.4319 },
  "65000": { name: "Valencia-Joaquín Sorolla", lat: 39.4653, lon: -0.3773 },
  "20213": { name: "Zaragoza-Delicias", lat: 41.6592, lon: -0.9122 },
  "81002": { name: "Valladolid-Campo Grande", lat: 41.6417, lon: -4.7279 },
  "10600": { name: "Córdoba Central", lat: 37.8840, lon: -4.7585 },
  "31406": { name: "Alicante Terminal", lat: 38.3450, lon: -0.4942 },
  "15211": { name: "León", lat: 42.5972, lon: -5.5668 },
  "40700": { name: "Toledo", lat: 39.8628, lon: -4.0107 },
  "37400": { name: "Cuenca-Fernando Zóbel", lat: 40.0596, lon: -2.1178 },
  "50200": { name: "Ciudad Real Central", lat: 38.9848, lon: -3.9273 },
  "13200": { name: "Segovia-Guiomar", lat: 40.9429, lon: -4.1250 },
  "70200": { name: "Tarragona", lat: 41.1089, lon: 1.2422 },
  "70600": { name: "Lleida-Pirineus", lat: 41.6218, lon: 0.6298 },
  "74200": { name: "Girona", lat: 41.9792, lon: 2.8178 },
  "74500": { name: "Figueres-Vilafant", lat: 42.2656, lon: 2.9247 },
  "20600": { name: "Huesca", lat: 42.1281, lon: -0.4121 },
  "31202": { name: "Albacete-Los Llanos", lat: 38.9947, lon: -1.8560 },
  "80200": { name: "Zamora", lat: 41.5119, lon: -5.7450 },
  "87200": { name: "Ourense", lat: 42.3425, lon: -7.8639 },
  "82100": { name: "Palencia", lat: 42.0090, lon: -4.5269 },
  "81600": { name: "Burgos-Rosa de Lima", lat: 42.3525, lon: -3.6883 },
  "88200": { name: "Santiago de Compostela", lat: 42.8722, lon: -8.5422 },
  "11600": { name: "Puertollano", lat: 38.6869, lon: -4.1071 },
  "61200": { name: "Guadalajara-Yebes", lat: 40.5000, lon: -3.0833 },
  "40500": { name: "Puente Genil-Herrera", lat: 37.4003, lon: -4.7500 },
  "14004": { name: "Medina del Campo", lat: 41.3083, lon: -4.9139 },
  "36300": { name: "Requena-Utiel", lat: 39.4833, lon: -1.1000 },
  "60200": { name: "Chamartín-Clara Campoamor", lat: 40.4722, lon: -3.6828 },
  "71500": { name: "Camp de Tarragona", lat: 41.1500, lon: 1.2500 },
  "94004": { name: "Antequera-Santa Ana", lat: 37.0603, lon: -4.5592 },
};

// Código del feed → nombre. Verificado contra coordenadas reales del feed.
RENFE.FEED_STATION_NAMES = {
  "01005": "Marchena",
  "01007": "Osuna",
  "02030": "Antequera-Ciudad",
  "03216": "Valencia-Joaquín Sorolla",
  "04007": "Guadalajara-Yebes",
  "04040": "Zaragoza-Delicias",
  "04307": "Figueres-Vilafant",
  "05000": "Granada",
  "05012": "Loja",
  "05193": "Ribadeo",
  "05300": "Oviedo",
  "05301": "Oviedo",
  "05451": "Bilbao-Abando",
  "05602": "Santander",
  "05621": "Torrelavega",
  "08223": "Vigo-Guixar",
  "08224": "Redondela",
  "08251": "A Gudiña-Porta de Galicia",
  "10000": "Madrid-Príncipe Pío",
  "10400": "Ávila",
  "10500": "Medina del Campo",
  "10600": "Valladolid-Campo Grande",
  "11014": "Burgos-Rosa de Lima",
  "11200": "Miranda de Ebro",
  "11208": "Vitoria-Gasteiz",
  "11511": "San Sebastián-Donostia",
  "11600": "Irun",
  "13200": "Bilbao-Abando",
  "13206": "Bilbao-Abando",
  "14100": "Palencia",
  "14202": "Reinosa",
  "14223": "Santander",
  "15100": "León",
  "15211": "Oviedo",
  "15410": "Gijón-Sanz Crespo",
  "17000": "Chamartín-Clara Campoamor",
  "18000": "Madrid-Atocha Cercanías",
  "20100": "Astorga",
  "20200": "Ponferrada",
  "20300": "Monforte de Lemos",
  "20309": "Lugo",
  "20400": "Betanzos-Infesta",
  "20410": "A Coruña",
  "21001": "Betanzos-Infesta",
  "21010": "Ferrol",
  "22100": "Ourense",
  "22300": "Redondela",
  "22308": "Vigo-Guixar",
  "23000": "Redondela",
  "23004": "Pontevedra",
  "23008": "Vilagarcía de Arousa",
  "23018": "Pontevedra",
  "30002": "Plasencia",
  "30100": "Salamanca",
  "30110": "Salamanca",
  "30200": "Zamora",
  "31400": "Santiago de Compostela",
  "31412": "A Coruña",
  "35200": "Talavera de la Reina",
  "35206": "Navalmoral de la Mata",
  "35400": "Cáceres",
  "37200": "Ciudad Real Central",
  "37406": "Villanueva de la Serena",
  "37407": "Don Benito",
  "37500": "Mérida",
  "37606": "Badajoz",
  "37700": "Puertollano",
  "40008": "Zafra",
  "40100": "Zafra",
  "43019": "Huelva",
  "51003": "Sevilla-Santa Justa",
  "51100": "Sevilla-San Bernardo",
  "51200": "Utrera",
  "51203": "Lebrija",
  "51300": "Jerez de la Frontera",
  "51400": "El Puerto de Santa María",
  "51405": "Cádiz",
  "51406": "San Fernando-Bahía Sur",
  "54400": "Bobadilla",
  "54413": "Málaga-María Zambrano",
  "56200": "Guadix",
  "56310": "Almería",
  "60000": "Madrid-Puerta de Atocha",
  "60200": "Aranjuez",
  "60400": "Alcázar de San Juan",
  "60600": "Albacete-Los Llanos",
  "60902": "Villena AV",
  "60911": "Alicante Terminal",
  "61200": "Murcia del Carmen",
  "61307": "Cartagena",
  "62002": "Orihuela",
  "62109": "Alicante Terminal",
  "64100": "Xàtiva",
  "65000": "Valencia-Joaquín Sorolla",
  "65200": "Sagunt",
  "65300": "Castelló de la Plana",
  "65311": "Benicarló",
  "65312": "Vinaròs",
  "65400": "Tortosa",
  "65402": "L'Aldea-Amposta",
  "70600": "Calatayud",
  "70806": "Zaragoza-Delicias",
  "71500": "Tarragona",
  "71801": "Barcelona-Sants",
  "78400": "Lleida-Pirineus",
  "79300": "Girona",
  "79315": "Portbou",
  "79316": "Cerbère",
  "80100": "Pamplona",
  "80108": "Tafalla",
  "81100": "Logroño",
  "81200": "Castejón de Ebro",
  "81202": "Tudela de Navarra",
  "92102": "Toledo",
};

/**
 * Índice dinámico código → {lat, lon} alimentado con las polilíneas
 * ("secuencia") del endpoint de rutas. Refleja la verdad del feed.
 */
RENFE.dynamicStationCoords = {};

RENFE.learnStationCoords = function (routesById) {
  for (const id in routesById) {
    const seq = routesById[id].path || [];
    for (const pt of seq) {
      if (pt.code && !RENFE.dynamicStationCoords[pt.code]) {
        RENFE.dynamicStationCoords[pt.code] = { lat: pt.lat, lon: pt.lon };
      }
    }
  }
};

/** Distancia aproximada en km entre dos puntos (suficiente para el guardarraíl). */
RENFE._distKm = function (lat1, lon1, lat2, lon2) {
  const dx = (lat1 - lat2) * 111.0;
  const dy = (lon1 - lon2) * 111.0 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Nombre legible de una estación por código.
 * Prioridad: mapeo verificado contra el feed → catálogo estático (solo si
 * no contradice las coordenadas aprendidas del feed) → código en bruto.
 */
RENFE.stationName = function (code) {
  if (!code) return "—";
  const feedName = RENFE.FEED_STATION_NAMES[code];
  if (feedName) return feedName;
  const s = RENFE.AVE_STATIONS[code];
  if (s) {
    // Guardarraíl: si el feed sitúa este código lejos de la entrada
    // estática, el catálogo no aplica a este espacio de códigos.
    const learned = RENFE.dynamicStationCoords[code];
    if (!learned || RENFE._distKm(s.lat, s.lon, learned.lat, learned.lon) < 20) {
      return s.name;
    }
  }
  return "Estación " + code;
};

/** Coordenadas de una estación: primero las aprendidas del feed, luego catálogo. */
RENFE.stationCoords = function (code) {
  const learned = RENFE.dynamicStationCoords[code];
  if (learned) return learned;
  const s = RENFE.AVE_STATIONS[code];
  if (s) return { lat: s.lat, lon: s.lon };
  return null;
};
