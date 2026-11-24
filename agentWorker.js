// ============================================================================
// server/workers/agentWorker.js — LOS AGENTES TRABAJANDO 24/7
// Versión 7.3 (E-031)
//
// Bucle maestro cada 10 segundos (archivo 29): revisa cargas recientes, hace matches y notifica.
//   - SOLO EL LÍDER DEL CLÚSTER busca cargas (47): con varias réplicas, cada una notificaría lo mismo.
//   - Multiempresa bajo RLS: mf_tenants_con_cargas_recientes() devuelve solo ids; cargas y camiones se
//     leen dentro del contexto de cada empresa.
//   - NUNCA se cruza una carga de una empresa con un camión de otra (antes buscarCamiones devolvía los
//     choferes de todas las empresas y el match no lo comprobaba).
//   - Una sola notificación por (carga, chofer): match_notificaciones (antes, el ciclo de 10 s avisaba
//     al mismo chofer ~18 veces por carga). Es "como máximo una vez": si el envío falla, no se repite.
//   - La puntuación es inyectable. Por defecto usa el motor neural (15); si no está disponible
//     (TensorFlow no instalado, modelo no cargable: E-036) no se ofrece nada y se registra, en vez de
//     fallar en cada ciclo.
// ============================================================================

const metricas = require('../../43_metrics_observability');
const match = require('../../29_match_tiempo_real');
const { enTenant } = require('../http/contexto_tenant');

const UMBRAL = 0.75;

function puntuadorNeuralPorDefecto(db) {
  let motor = null;
  let deshabilitado = null;
  return async (carga, camion) => {
    if (deshabilitado) return null;
    try {
      if (!motor) {
        const Motor = require('../../15_neural_matching_engine');
        motor = new Motor(db);
      }
      const p = await motor.predecirAceptacion(carga.fila, camion, {});
      return typeof p === 'number' && Number.isFinite(p) ? p : null;
    } catch (e) {
      deshabilitado = e.message;
      metricas.log('error', 'agentes.puntuador_no_disponible', { error: e.message });
      return null;
    }
  };
}

function crearAdaptadorAgentes(db, { notificaciones, esLider = () => true, puntuar = null } = {}) {
  const puntuarFn = puntuar || puntuadorNeuralPorDefecto(db);
  let empresasDelCiclo = [];
  const empresaDeChofer = new Map();
  const minutos = match.CONFIG.CARGA_MAXIMA_ANTIGUEDAD_MIN;

  return {
    buscarCargas: async () => {
      empresasDelCiclo = [];
      empresaDeChofer.clear();
      if (!esLider()) return [];
      const { rows } = await db.query('SELECT t AS tenant_id FROM mf_tenants_con_cargas_recientes($1) AS t', [minutos]);
      empresasDelCiclo = rows.map(r => r.tenant_id);
      const cargas = [];
      for (const tenantId of empresasDelCiclo) {
        const { rows: filas } = await enTenant(db, tenantId, (c) => c.query(
          `SELECT id, tenant_id, origin_city, dest_city, miles, rate, equipment, pickup_at, created_at
           FROM loads WHERE status='AVAILABLE' AND created_at > now() - make_interval(mins => $1)`, [minutos]), { soloLectura: true });
        for (const f of filas) {
          cargas.push({ id: f.id, tenant_id: f.tenant_id, origen: f.origin_city, destino: f.dest_city, pago: f.rate,
            publicadaEn: f.created_at, fila: f });
        }
      }
      return cargas;
    },

    buscarCamiones: async () => {
      const camiones = [];
      for (const tenantId of empresasDelCiclo) {
        const { rows } = await enTenant(db, tenantId, (c) => c.query(
          `SELECT id, tenant_id, full_name, phone AS telefono, truck_number, hos_status
           FROM drivers WHERE status='AVAILABLE' AND is_active IS TRUE`), { soloLectura: true });
        for (const r of rows) { empresaDeChofer.set(r.id, r.tenant_id); camiones.push(r); }
      }
      return camiones;
    },

    hacerMatch: async (carga, camion) => {
      if (!carga || !camion || carga.tenant_id !== camion.tenant_id) return null; // jamás entre empresas
      const score = await puntuarFn(carga, camion);
      if (score === null || score <= UMBRAL) return null;
      const nuevo = await enTenant(db, carga.tenant_id, (c) => c.query(
        `INSERT INTO match_notificaciones (tenant_id, load_id, driver_id, score) VALUES ($1,$2,$3,$4)
         ON CONFLICT (load_id, driver_id) DO NOTHING RETURNING load_id`,
        [carga.tenant_id, carga.id, camion.id, score.toFixed(4)]));
      if (!nuevo.rows.length) return null; // ya se le ofreció esta carga a este chofer
      return { chofer: camion, carga, score };
    },

    notificarChofer: async (driverId, msg) => {
      const tenantId = empresaDeChofer.get(driverId);
      if (!tenantId) return false;
      try {
        const r = await notificaciones.alChofer(tenantId, driverId, { tipo: 'NUEVA_CARGA', datos: { texto: msg.texto } });
        return !!(r && r.entregado);
      } catch (e) {
        metricas.log('error', 'agentes.notificacion_fallo', { tenantId, driverId, error: e.message });
        return false;
      }
    },

    enviarSMS: async (telefono, texto, chofer) => {
      if (!chofer || !chofer.tenant_id) return false;
      const r = await notificaciones.alChofer(chofer.tenant_id, chofer.id, { tipo: 'NUEVA_CARGA', datos: { texto }, preferencia: ['sms'] });
      return !!(r && r.entregado);
    },
  };
}

function iniciar(db, deps) {
  const detener = match.iniciarMatchTiempoReal(crearAdaptadorAgentes(db, deps));
  metricas.log('info', 'worker.agentes.activo');
  return detener;
}

module.exports = { iniciar, crearAdaptadorAgentes, UMBRAL };
