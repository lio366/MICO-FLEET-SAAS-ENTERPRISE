// ============================================================================
// server/workers/cronWorker.js — TAREAS PROGRAMADAS (reemplaza al archivo 04)
// Versión 7.3 (E-031)
//
// EXACTAMENTE UNA VEZ POR HORA EN TODO EL CLÚSTER: cada réplica revisa cada minuto, pero solo la
// que inserta primero la clave '<tarea>:<YYYY-MM-DDTHH>' en cron_ejecuciones ejecuta la tarea.
// (Antes la clave se calculaba y no se usaba: cada tarea corría ~60 veces en su hora y en cada réplica.)
// Si una tarea falla a mitad, el error queda registrado y no se reintenta en esa hora.
//
// MULTIEMPRESA BAJO RLS: las empresas con trabajo se descubren con funciones SECURITY DEFINER que
// devuelven solo ids (migración 006); el trabajo de cada empresa corre con su contexto (enTenant).
// ============================================================================

const metricas = require('../../43_metrics_observability');
const { enTenant } = require('../http/contexto_tenant');

const DIAS_GRACIA_MORA = 7;
const DIAS_RETENCION_NOTIFICACIONES = 90;

async function empresasActivas(db) {
  const { rows } = await db.query(`SELECT id FROM tenants WHERE status IN ('TRIAL','ACTIVE','PAST_DUE') ORDER BY id`);
  return rows.map(r => r.id);
}

const TAREAS = [
  // Regla de negocio (02/04): PAST_DUE con 7 días de gracia tras el fin del periodo → la EMPRESA queda
  // SUSPENDED (tenants.status es lo que verifica el gateway). E-030: columnas reales de subscriptions.
  { hora: 8, nombre: 'suspender_morosos', fn: async (db, deps) => {
      const { rows } = await db.query('SELECT t AS tenant_id FROM mf_tenants_morosos($1) AS t', [DIAS_GRACIA_MORA]);
      const suspendidas = [];
      for (const { tenant_id: tenantId } of rows) {
        const r = await db.query(
          `UPDATE tenants SET status='SUSPENDED', updated_at=now()
           WHERE id=$1 AND status IN ('ACTIVE','TRIAL','PAST_DUE') RETURNING id`, [tenantId]);
        if (!r.rows.length) continue;
        suspendidas.push(tenantId);
        await deps.notificaciones.alAdmin(tenantId, { tipo: 'ALERTA_SISTEMA',
          datos: { texto: 'Suscripción suspendida por mora. Los agentes quedaron en pausa.' } });
      }
      return { suspendidas: suspendidas.length };
    } },

  // La verificación del ledger fija el contexto de cada empresa por sí misma (42.verificarIntegridad).
  { hora: 9, nombre: 'verificar_integridad_ledger', fn: async (db) => {
      const ledger = require('../../42_audit_ledger');
      const { rows } = await db.query(`SELECT id FROM tenants ORDER BY id`);
      const rotas = [];
      for (const t of rows) {
        const r = await ledger.verificarIntegridad(db, t.id);
        if (!r.ok) {
          rotas.push({ tenant: t.id, seq: r.rotoEn ?? null, motivo: r.motivo });
          metricas.log('error', 'ledger.cadena_rota', { tenant: t.id, seq: r.rotoEn, motivo: r.motivo });
        }
      }
      return { empresas: rows.length, rotas };
    } },

  // Lunes 07h: resumen de la semana para el administrador de cada empresa activa.
  { hora: 7, dia: 1, nombre: 'reporte_semanal', fn: async (db, deps) => {
      let enviados = 0;
      for (const tenantId of await empresasActivas(db)) {
        const { rows: [r] } = await enTenant(db, tenantId, (c) => c.query(
          `SELECT (SELECT count(*)::int FROM bookings
                   WHERE assigned_at >= now() - interval '7 days' AND status NOT IN ('REJECTED','CANCELLED')) AS cargas,
                  (SELECT count(*)::int FROM bookings WHERE status = 'PAID' AND paid_at >= now() - interval '7 days') AS cobradas,
                  (SELECT coalesce(sum(monto), 0)::text FROM invoices
                   WHERE creada_en >= now() - interval '7 days' AND estado <> 'ANULADA') AS facturado`), { soloLectura: true });
        await deps.notificaciones.alAdmin(tenantId, { tipo: 'ALERTA_SISTEMA', datos: { texto:
          `Resumen semanal: ${r.cargas} cargas asignadas, ${r.cobradas} cobradas, $${r.facturado} facturado.` } });
        enviados++;
      }
      return { enviados };
    } },

  // Lunes 00h: retención del historial de notificaciones (90 días), por empresa y del sistema.
  { hora: 0, dia: 1, nombre: 'limpieza_semanal', fn: async (db) => {
      let borradas = 0;
      const { rows } = await db.query(`SELECT id FROM tenants ORDER BY id`);
      for (const t of rows) {
        const r = await enTenant(db, t.id, (c) => c.query(
          `DELETE FROM notificaciones_enviadas WHERE creado_en < now() - make_interval(days => $1)`, [DIAS_RETENCION_NOTIFICACIONES]));
        borradas += r.rowCount;
      }
      const { rows: [s] } = await db.query('SELECT mf_limpiar_notificaciones_sistema($1)::int AS n', [DIAS_RETENCION_NOTIFICACIONES]);
      return { borradas_empresas: borradas, borradas_sistema: s.n };
    } },
];

// Ejecuta una tarea como máximo una vez por hora (UTC) en todo el clúster.
async function ejecutarTarea(db, tarea, deps, ahora = new Date()) {
  const clave = `${tarea.nombre}:${ahora.toISOString().slice(0, 13)}`;
  const { rows } = await db.query(
    `INSERT INTO cron_ejecuciones (clave, tarea) VALUES ($1,$2) ON CONFLICT (clave) DO NOTHING RETURNING clave`,
    [clave, tarea.nombre]);
  if (!rows.length) return { ejecutada: false, clave };
  try {
    const resultado = await tarea.fn(db, deps);
    await db.query(`UPDATE cron_ejecuciones SET terminada_en=now(), resultado=$2 WHERE clave=$1`,
      [clave, JSON.stringify(resultado ?? null)]);
    metricas.contador('cron_ejecutadas', { tarea: tarea.nombre });
    return { ejecutada: true, clave, resultado };
  } catch (e) {
    await db.query(`UPDATE cron_ejecuciones SET terminada_en=now(), error=$2 WHERE clave=$1`, [clave, e.message.slice(0, 2000)])
      .catch(() => {});
    metricas.log('error', 'cron.fallo', { tarea: tarea.nombre, error: e.message });
    return { ejecutada: true, clave, error: e.message };
  }
}

function tareasDeAhora(ahora) {
  return TAREAS.filter(t => t.hora === ahora.getHours() && (t.dia === undefined || t.dia === ahora.getDay()));
}

function iniciar(db, deps) {
  const timer = setInterval(async () => {
    const ahora = new Date();
    for (const t of tareasDeAhora(ahora)) {
      try { await ejecutarTarea(db, t, deps, ahora); }
      catch (e) { metricas.log('error', 'cron.registro_fallo', { tarea: t.nombre, error: e.message }); }
    }
  }, 60 * 1000); // revisa cada minuto; cron_ejecuciones garantiza una sola ejecución por hora
  metricas.log('info', 'worker.cron.activo');
  return () => clearInterval(timer);
}

module.exports = { iniciar, TAREAS, ejecutarTarea, tareasDeAhora };
