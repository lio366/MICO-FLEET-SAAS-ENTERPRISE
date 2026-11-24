// ============================================================================
// 30_tarifas_inteligentes.js — NEGOCIAR CON DATOS REALES, NO A CIEGAS
// Versión 5.0
//
// PROBLEMA ANTERIOR: la IA negociaba el precio "sintiendo" el mercado. Un
// broker que sabe el precio real de la ruta gana $30-80 más por carga y
// nunca ofrece de más ni de menos.
//
// SOLUCIÓN:
//   1. Tabla tarifas_ruta: cada carga completada alimenta el histórico.
//   2. estimarTarifa(origen, destino) → rango bajo/medio/alto con datos de
//      los últimos 30 días + ajuste por diesel + estacionalidad.
//   3. El negociador (archivo 07) usa estimarTarifa como piso y techo:
//      nunca acepta menos que el piso, apunta al medio-alto.
// ============================================================================

// ---------------------------------------------------------------------------
// Base de datos (ejecutar en Postgres junto al archivo 01)
// ---------------------------------------------------------------------------
const SQL = require('./db/sql').leerSql('30_tarifas_inteligentes'); // DDL versionado en sql/30_tarifas_inteligentes.sql (E-017)

// ---------------------------------------------------------------------------
// Registrar cada carga completada → alimenta el cerebro de precios
// ---------------------------------------------------------------------------
async function registrarTarifa(db, tenantId, { origen, destino, millas, tarifa, pagadoChofer, dieselPrecio }) {
  await db.query(
    `INSERT INTO tarifas_ruta (tenant_id, origen, destino, millas, tarifa, pagado_chofer, fecha, diesel_precio)
     VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7)`,
    [tenantId, origen, destino, millas, tarifa, pagadoChofer, dieselPrecio]
  );
}

// ---------------------------------------------------------------------------
// Estimar tarifa de una ruta con los últimos 30 días de datos propios
// + diesel actual + ajuste estacional (diciembre = demanda alta)
// ---------------------------------------------------------------------------
async function estimarTarifa(db, tenantId, { origen, destino, millas }) {
  const { rows } = await db.query(
    `SELECT tarifa, fecha FROM tarifas_ruta
     WHERE tenant_id=$1 AND origen=$2 AND destino=$3 AND fecha >= CURRENT_DATE - 30
     ORDER BY fecha DESC LIMIT 20`,
    [tenantId, origen, destino]
  );

  const dieselHoy = await obtenerDieselHoy(); // del archivo 20 (alerta diesel)
  const estacional = factorEstacional(new Date().getMonth()); // 1.00-1.15

  // Sin datos propios: fallback a $2.10/milla (tu mínimo configurado)
  if (rows.length < 3) {
    const base = millas * 2.10 * estacional;
    return { piso: base * 0.95, objetivo: base, techo: base * 1.10, confianza: 'BAJA', datos: rows.length };
  }

  const tarifas = rows.map(r => r.tarifa).sort((a, b) => a - b);
  const media = tarifas.reduce((s, t) => s + t, 0) / tarifas.length;
  const ajustada = media * estacional + (dieselHoy.variacionSemanal || 0) * millas * 0.01;

  return {
    piso: ajustada * 0.97,              // nunca negociar por debajo
    objetivo: ajustada,                 // donde debe cerrar el trato
    techo: ajustada * 1.08,             // máximo que pagarías como broker
    rpm: ajustada / millas,             // $ por milla para validar contra mínimo
    confianza: rows.length >= 10 ? 'ALTA' : 'MEDIA',
    datos: rows.length
  };
}

// Estacionalidad del mercado de carga (patrón real del sector)
function factorEstacional(mes) {
  // 0=Ene ... 11=Dic. Dic-ene alto (festejo), feb-mar bajo, sep-oct alto
  return [1.08, 1.05, 0.98, 0.97, 1.00, 1.02, 1.01, 1.00, 1.03, 1.08, 1.06, 1.12][mes];
}

async function obtenerDieselHoy() {
  // Conecta con el módulo de alerta diesel (archivo 20); si falla, neutro
  try { return require('./20_alerta_diesel').obtenerPrecioActual(); }
  catch { return { variacionSemanal: 0 }; }
}

module.exports = { SQL, registrarTarifa, estimarTarifa, factorEstacional };
