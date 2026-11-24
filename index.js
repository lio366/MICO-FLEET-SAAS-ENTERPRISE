// ============================================================================
// server/index.js — ARRANQUE DE LA PLATAFORMA (un solo comando)
//   node server/index.js
//
// Orquesta: base de datos → gateway (40) → autenticación (41) → métricas (43)
// → bus de eventos (44) → notificaciones (45) → workers (agentes + cron).
// ============================================================================

require('dotenv').config();
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL, // rol mf_login/mf_app: tráfico runtime
  max: 20,
  idleTimeoutMillis: 30000,
});
// DDL y migraciones usan credenciales separadas. No conceder CREATE/OWNER al runtime.
const migrationDb = process.env.MIGRATION_DATABASE_URL
  ? new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 3 })
  : db;

const metricas = require('../43_metrics_observability');
const bus = require('../44_event_bus');
const auth = require('../41_auth_rbac');
const ledger = require('../42_audit_ledger');
const notif = require('../45_notification_service');
const TenantMiddleware = require('../02_tenant_middleware');

async function main() {
  metricas.log('info', 'servidor.iniciando');

  // 1. Esquema completo y migraciones versionadas: misma secuencia que el bootstrap
  //    (db/esquema.js). Serializado entre réplicas por candado de migraciones.
  await require('../db/esquema').aplicarEsquema(migrationDb, {
    log: (evento, datos) => metricas.log('info', evento, datos || {}),
  });
  // Fallar cerrado si el ledger restaurado presenta una cadena rota o un
  // checkpoint inválido. Las claves públicas Ed25519 deben venir de entorno.
  await ledger.verificacionPostRestauracion(migrationDb);

  // 2. Servicios
  // Twilio perezoso: el server ARRANCA sin credenciales; el SDK solo se
  // instancia cuando algo envía SMS/WhatsApp de verdad (E-013).
  const twilioPerezoso = new Proxy({}, { get(_, prop) {
    const cliente = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
    return cliente[prop];
  } });
  const notificaciones = notif.crearServicioNotificaciones({
    db,
    twilio: twilioPerezoso,
    pushSender: async (token, texto) => { /* expo push */ },
    emailSender: async (para, texto) => { /* SMTP */ },
  });
  const autoDispatch = require('../08_auto_dispatch_agent');
  bus.registrarSuscripciones({ db, notificaciones, ledger, autoDispatch });

  // Ganchos del módulo de voz (38): enrutador de IA (25) + notificaciones (45)
  require('../38_modo_voz_auricular').configurar({
    agenteIA: require('../25_enrutador_modelos'),
    enviarPushYSMS: async (chofer, carga) => notificaciones.alChofer(chofer.tenant_id ?? null, chofer.id,
      { tipo: 'NUEVA_CARGA', datos: carga }),
  });

  // 3. Gateway HTTP
  const app = require('../40_api_gateway').crearGateway({
    tenantMiddleware: new TenantMiddleware(db, { dominioBase: process.env.APP_BASE_DOMAIN }),
    db,
    notificar: (tenantId, texto) => notificaciones.alAdmin(tenantId, { tipo: 'ALERTA_SISTEMA', datos: { texto } }),
    autoDispatch,
    log: (nivel, evento, datos) => metricas.log(nivel, evento, datos || {}),
  });
  app.use(metricas.middlewareMetricas());
  app.get('/metrics', metricas.endpointMetrics());
  app.get('/healthz', metricas.endpointHealth({ db }));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => metricas.log('info', 'servidor.listo', { puerto: PORT }));

  // 4. Workers en segundo plano
  require('./workers/eventWorker').iniciar(db, bus);
  // Liderazgo (47): solo el líder ejecuta el agente de match. Bus y cron son seguros en todas las
  // réplicas (lease del outbox y cron_ejecuciones), así que corren en todas.
  const cluster = require('../47_scheduler_cluster');
  const nodoId = `${require('os').hostname()}-${process.pid}`.slice(0, 60);
  cluster.iniciarCluster(db, nodoId, async () => metricas.log('info', 'cluster.lider', { nodoId }));
  require('./workers/agentWorker').iniciar(db, { notificaciones, esLider: cluster.esLider });
  require('./workers/cronWorker').iniciar(db, { notificaciones });

  // 5. Alertas de salud cada 5 minutos
  setInterval(() => metricas.revisarAlertas((rol, msg) => notificaciones.alAdmin(null, { ...msg, destinatario: {} })), 5 * 60000);
}

main().catch(e => { metricas.log('error', 'servidor.caido', { error: e.message, stack: e.stack }); process.exit(1); });
process.on('SIGTERM', async () => { await Promise.allSettled([db.end(), migrationDb === db ? Promise.resolve() : migrationDb.end()]); process.exit(0); });
