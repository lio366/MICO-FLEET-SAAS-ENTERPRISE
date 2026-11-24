// ============================================================================
// 32_score_confianza.js — NO TRABAJES CON QUIEN NO PAGA
// Versión 5.0
//
// PROBLEMA ANTERIOR: la app aceptaba cargas de cualquier shipper y ofertas a
// cualquier camionero sin mirar historial. Un shipper que no paga te come el
// margen de 10 cargas buenas.
//
// SOLUCIÓN: cada shipper y cada camionero tiene un SCORE A-E calculado
// automáticamente por los agentes:
//   A (90-100) = de confianza total, crédito ampliado
//   B (75-89)  = confiable, crédito normal (30 días)
//   C (55-74)  = precaución, crédito corto (7-14 días) o factoring obligatorio
//   D (30-54)  = solo contra pago, nunca crédito
//   E (0-29)   = BLOQUEADO automáticamente — agente rechaza tratos con él
// ============================================================================

const SQL = require('./db/sql').leerSql('32_score_confianza'); // DDL versionado en sql/32_score_confianza.sql (E-017)

// ---------------------------------------------------------------------------
// REGLAS AUTOMÁTICAS — el agente aplica esto sin intervención humana
// ---------------------------------------------------------------------------
const REGLAS = {
  // Aceptar trato según nota
  aceptarTrato: { A: true, B: true, C: 'CONDICIONAL', D: 'SOLO_PAGO_ANTICIPADO', E: false },

  // Días de crédito que le das
  creditoDias: { A: 45, B: 30, C: 14, D: 0, E: 0 },

  // Límite de dinero expuesto (facturas pendientes) por nota
  exposicionMaximaUsd: { A: 50000, B: 20000, C: 8000, D: 2500, E: 0 },
};

// ---------------------------------------------------------------------------
// El cerebro recalcula el score después de cada evento
// ---------------------------------------------------------------------------
async function registrarEvento(db, tenantId, { tipo, terceroId, nombre, evento, datos = {} }) {
  // evento: 'CARGA_COMPLETADA' | 'PAGO_PUNTUAL' | 'PAGO_TARDE' | 'NO_PAGO' |
  //         'CANCELACION_TARDE' | 'CANCELACION_ULTIMA_HORA' | 'CHOFER_RECHAZO_FRECUENTE'

  const CAMBIOS = {
    CARGA_COMPLETADA: +2,
    PAGO_PUNTUAL: +3,          // pagó dentro del crédito acordado
    PAGO_TARDE: -5,
    NO_PAGO: -25,
    CANCELACION_TARDE: -8,     // canceló con carga ya asignada
    CANCELACION_ULTIMA_HORA: -4,
    CHOFER_RECHAZO_FRECUENTE: -2,
  };
  const delta = CAMBIOS[evento] || 0;

  const { rows } = await db.query(
    `INSERT INTO scores_confianza (tenant_id, tipo, tercero_id, nombre, puntos, cargas_completadas, incumplimientos)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, tipo, tercero_id)
     DO UPDATE SET puntos = GREATEST(0, LEAST(100, scores_confianza.puntos + $8)),
                   nombre = EXCLUDED.nombre,
                   cargas_completadas = scores_confianza.cargas_completadas + $6,
                   incumplimientos = scores_confianza.incumplimientos + $7,
                   actualizado_en = now()
     RETURNING puntos, nota`,
    [tenantId, tipo, terceroId, nombre || terceroId,
     70 + delta,
     evento === 'CARGA_COMPLETADA' ? 1 : 0,
     ['PAGO_TARDE', 'NO_PAGO', 'CANCELACION_TARDE', 'CANCELACION_ULTIMA_HORA'].includes(evento) ? 1 : 0,
     delta]
  );
  return rows[0]; // { puntos, nota }
}

// ---------------------------------------------------------------------------
// VEREDICTO automático antes de cerrar cualquier trato — lo llama el agente
// ---------------------------------------------------------------------------
async function veredictoTrato(db, tenantId, { tipo, terceroId, montoExpuesto }) {
  const { rows } = await db.query(
    `SELECT nota, puntos FROM scores_confianza
     WHERE tenant_id=$1 AND tipo=$2 AND tercero_id=$3`,
    [tenantId, tipo, terceroId]
  );
  const nota = rows[0]?.nota || 'B'; // desconocido = tratar como B, prudente

  if (REGLAS.aceptarTrato[nota] === false) {
    return { aceptar: false, motivo: `NOTA ${nota}: bloqueado por historial. Ver con humano.` };
  }
  if (REGLAS.aceptarTrato[nota] === 'SOLO_PAGO_ANTICIPADO' && montoExpuesto > 0) {
    return { aceptar: 'CONDICIONAL', condicion: 'Exigir pago antes de entregar documentos (POD/BOL).', nota };
  }
  if (montoExpuesto > REGLAS.exposicionMaximaUsd[nota]) {
    return { aceptar: 'CONDICIONAL', condicion: `Exposición ${montoExpuesto} excede límite de nota ${nota} ($${REGLAS.exposicionMaximaUsd[nota]}). Factoring obligatorio.`, nota };
  }
  return { aceptar: true, creditoDias: REGLAS.creditoDias[nota], nota };
}

module.exports = { SQL, REGLAS, registrarEvento, veredictoTrato };
