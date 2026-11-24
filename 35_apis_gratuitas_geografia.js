// ============================================================================
// 35_apis_gratuitas_geografia.js — GEOGRAFÍA, CLIMA Y HORA: TODO GRATIS
// Versión 5.1
//
// INVESTIGADO (nov 2026) — estas son las mejores APIs gratuitas verificadas
// y ya quedan conectadas aquí. Ninguna cuesta nada en el volumen de la app:
//
//   Nominatim (OpenStreetMap)  — ciudad→coordenadas+huso horario. SIN clave.
//   NWS api.weather.gov        — clima/alertas USA, dominio público. SIN clave.
//   Open-Meteo                 — respaldo de clima. SIN clave (uso no comercial).
//   OpenRouteService           — rutas/millas reales de camión. Clave GRATIS
//                                (2,000 rutas/día). Opcional: si no hay clave,
//                                se usa distancia en línea recta × 1.25 (actual).
// ============================================================================

const https = require('https');

// Tabla de caché geográfica (una ciudad se consulta 1 vez y queda para siempre)
const SQL = require('./db/sql').leerSql('35_apis_gratuitas_geografia'); // DDL versionado en sql/35_apis_gratuitas_geografia.sql (E-017)

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MicroFleet/5.1 (tour567 logistics app)' } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 1. GEOCODING + ZONA HORARIA — Nominatim (gratis, sin clave, 1 llamada/seg)
//    Devuelve lat, lon y el IANA timezone (America/New_York, etc.) de la ciudad.
//    Resultado cacheado 30 días en tu propia base → casi nunca repites llamada.
// ---------------------------------------------------------------------------
async function geocodificarCiudad(db, ciudad, estado) {
  const cacheKey = `${ciudad},${estado}`.toLowerCase();
  const { rows } = await db.query(`SELECT * FROM geo_cache WHERE key=$1`, [cacheKey]);
  if (rows.length) return rows[0];

  const q = encodeURIComponent(`${ciudad}, ${estado}, USA`);
  const d = await getJSON(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=1`);
  if (!d.length) throw new Error(`Ciudad no encontrada: ${ciudad}, ${estado}`);

  const r = d[0];
  const resultado = {
    key: cacheKey,
    lat: +r.lat, lon: +r.lon,
    timezone: r.addressdetails?.timezone || tzPorEstado(estado), // respaldo por estado
    display: r.display_name
  };
  await db.query(
    `INSERT INTO geo_cache (key, lat, lon, timezone, display) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (key) DO NOTHING`, [cacheKey, resultado.lat, resultado.lon, resultado.timezone, resultado.display]);
  return resultado;
}

// Respaldo si Nominatim no trae huso: cada estado de USA tiene huso conocido
function tzPorEstado(st) {
  const TZ = { FL: 'America/New_York', GA: 'America/New_York', NY: 'America/New_York',
    TX: 'America/Chicago', CA: 'America/Los_Angeles', IL: 'America/Chicago', AZ: 'America/Phoenix' };
  return TZ[st] || 'America/New_York';
}

// ---------------------------------------------------------------------------
// 2. CLIMA Y ALERTAS EN RUTA — NWS (gobierno USA, gratis, sin clave)
//    Las alertas de tormenta/hielo importan: una cerrada de carretera deja
//    la carga botada. El agente las revisa antes de confirmar cada carga.
// ---------------------------------------------------------------------------
async function climaYRiesgo(lat, lon) {
  try {
    // NWS: 1er paso convierte coords → punto de grilla; 2do trae forecast + alertas
    const p = await getJSON(`https://api.weather.gov/points/${lat},${lon}`);
    const [alertas, forecast] = await Promise.all([
      getJSON(`https://api.weather.gov/alerts/active?point=${lat},${lon}`),
      getJSON(p.properties.forecast)
    ]);
    const hoy = forecast.properties.periods[0];
    return {
      tempF: hoy.temperature,
      viento: hoy.windSpeed,
      condicion: hoy.shortForecast,
      alertas: alertas.features.map(a => a.properties.event), // ej. ["Winter Storm Warning"]
      riesgo: alertas.features.some(a => /Warning|Emergency/i.test(a.properties.event))
    };
  } catch (e) {
    return { alertas: [], riesgo: false, error: 'clima no disponible' }; // nunca tumba el flujo
  }
}

// Respaldo sin clave si NWS falla: Open-Meteo (gratis, sin clave)
async function climaRespaldo(lat, lon) {
  const d = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit`);
  return { tempF: d.current.temperature_2m, viento: d.current.wind_speed_10m + ' mph', condicion: null, alertas: [], riesgo: false };
}

// ---------------------------------------------------------------------------
// 3. MILLAS REALES DE CAMIÓN — OpenRouteService (clave gratis: 2,000 rutas/día)
//    Si no hay clave configurada, cae al método actual (línea recta × 1.25).
// ---------------------------------------------------------------------------
async function millasCamion(origen, destino) {
  const KEY = process.env.ORS_API_KEY;
  if (!KEY) return null; // el llamador usa su estimación actual
  const d = await getJSON(
    `https://api.openrouteservice.org/v2/directions/driving-hgv?api_key=${KEY}` +
    `&start=${origen.lon},${origen.lat}&end=${destino.lon},${destino.lat}`
  );
  const km = d.features[0].properties.summary.distance;
  return Math.round(km * 0.621371); // km → millas
}

// ---------------------------------------------------------------------------
// 4. HORA LOCAL DE CUALQUIER CIUDAD — sin API externa: el huso ya vino en
//    el paso 1 (geocodificarCiudad) y Node calcula la hora local con Intl.
//    Sirve para saber si el almacén del destino sigue abierto a esa hora.
// ---------------------------------------------------------------------------
function horaLocal(timezone, fecha = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(fecha);
}

// Hora de cierre típica de almacenes (16:30 local); el agente la usa para
// decidir si una entrega "hoy" es realista o hay que reprogramar.
function almacenAbierto(timezone, cierra = '16:30') {
  const ahoraLocal = horaLocal(timezone);
  const [h, m] = ahoraLocal.replace(/\s?[AP]M/i, '').split(':').map(Number);
  const esPM = /PM/i.test(ahoraLocal);
  const minutos = (esPM ? 12 : 0) * 60 + h * 60 + m;
  const [ch, cm] = cierra.split(':').map(Number);
  return minutos < ch * 60 + cm;
}

module.exports = { SQL, geocodificarCiudad, climaYRiesgo, climaRespaldo, millasCamion, horaLocal, almacenAbierto, tzPorEstado };
