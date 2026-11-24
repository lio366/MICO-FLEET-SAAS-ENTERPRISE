// ============================================================================
// 34_ifta_report.js — REPORTE IFTA TRIMESTRAL (impuesto por millas por estado)
// Versión 5.1
//
// Por qué existe: TODO camionero que cruza estados debe declarar IFTA
// (International Fuel Tax Agreement). Se paga trimestral y se calcula con:
// millas recorridas en cada estado ÷ mpg del camión = galones imputados
// por estado × tasa de impuesto de ese estado.
// Los competidores (LogisticsX, AscendTMS) lo cobran como función premium.
// Aquí va incluido: el GPS de la app del chofer ya guarda la ruta en PostGIS.
// ============================================================================

const SQL = require('./db/sql').leerSql('34_ifta_report'); // DDL versionado en sql/34_ifta_report.sql (E-017)

// ---------------------------------------------------------------------------
// 1. Cargar las tasas del trimestre (una sola vez; fuente: ifta.org / cada
//    estado publica su tasa; hay CSV oficial descargable)
// ---------------------------------------------------------------------------
async function cargarTasas(db, anio, trimestre, tablaEstados) {
  // tablaEstados: [{ estado:'FL', tasa:0.4949 }, ...]
  for (const r of tablaEstados) {
    await db.query(
      `INSERT INTO ifta_tasas (estado, anio, trimestre, tasa_por_galon) VALUES ($1,$2,$3,$4)
       ON CONFLICT (estado) DO UPDATE SET anio=$2, trimestre=$3, tasa_por_galon=$4`,
      [r.estado, anio, trimestre, r.tasa]
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Millas por estado: cruza cada punto GPS con el polígono del estado
//    (PostGIS + tabla publica us_states de la extensión spatial). Suma la
//    distancia entre puntos consecutivos dentro del mismo estado.
// ---------------------------------------------------------------------------
async function millasPorEstado(db, tenantId, driverId, fechaDesde, fechaHasta) {
  const { rows } = await db.query(
    `WITH puntos AS (
       SELECT pos, grabado_en,
              ST_SetSRID(pos::geometry, 4326) AS geom
       FROM gps_points
       WHERE tenant_id=$1 AND driver_id=$2
         AND grabado_en BETWEEN $3 AND $4
       ORDER BY grabado_en
     ),
     con_estado AS (
       SELECT p.grabado_en, p.pos,
              (SELECT s.abbr FROM us_states s
               WHERE ST_Contains(s.geom, p.geom) LIMIT 1) AS estado
       FROM puntos p
     ),
     con_distancia AS (
       SELECT estado,
              ST_Distance(pos, LAG(pos) OVER (ORDER BY grabado_en)) / 1609.34 AS millas
       FROM con_estado
     )
     SELECT estado, ROUND(SUM(millas)::numeric, 1) AS millas
     FROM con_distancia
     WHERE estado IS NOT NULL AND millas IS NOT NULL AND millas < 3  -- descarta saltos GPS
     GROUP BY estado ORDER BY millas DESC`,
    [tenantId, driverId, fechaDesde, fechaHasta]
  );
  return rows; // [{ estado:'FL', millas: 1420.3 }, ...]
}

// ---------------------------------------------------------------------------
// 3. Generar el reporte del trimestre para UN camión o toda la flota
// ---------------------------------------------------------------------------
async function generarReporteIFTA(db, tenantId, { anio, trimestre, driverId = null, mpg = 6.5 }) {
  const trimestres = { 1: ['01-01','03-31'], 2: ['04-01','06-30'], 3: ['07-01','09-30'], 4: ['10-01','12-31'] };
  const [ini, fin] = trimestres[trimestre];
  const desde = `${anio}-${ini}T00:00:00Z`, hasta = `${anio}-${fin}T23:59:59Z`;

  const drivers = driverId
    ? [{ id: driverId }]
    : (await db.query(`SELECT id FROM drivers WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId])).rows;

  const reporte = [];
  for (const d of drivers) {
    const porEstado = await millasPorEstado(db, tenantId, d.id, desde, hasta);
    const detalle = [];
    for (const r of porEstado) {
      const tasa = await db.query(`SELECT tasa_por_galon FROM ifta_tasas WHERE estado=$1`, [r.estado]);
      const galones = r.millas / mpg;
      const impuesto = galones * (tasa.rows[0]?.tasa_por_galon || 0);
      detalle.push({ estado: r.estado, millas: r.millas, galones: +galones.toFixed(1),
                     tasa: tasa.rows[0]?.tasa_por_galon || 0, impuesto: +impuesto.toFixed(2) });
    }
    const total = detalle.reduce((s, x) => s + x.impuesto, 0);
    reporte.push({ driverId: d.id, detalle, impuestoTotal: +total.toFixed(2) });
  }
  return { anio, trimestre, mpg, reporte,
           nota: 'Entregar al contador con las facturas de diésel del trimestre.' };
}

module.exports = { SQL, cargarTasas, millasPorEstado, generarReporteIFTA };
