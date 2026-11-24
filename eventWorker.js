// ============================================================================
// server/workers/eventWorker.js — REPARTE LOS EVENTOS DEL BUS (cada 2 seg)
// Sin esto, los eventos publicados en el outbox nunca llegan a suscriptores.
// ============================================================================

const metricas = require('../../43_metrics_observability');

function iniciar(db, bus) {
  setInterval(async () => {
    try {
      const n = await bus.procesarPendientes(db);
      if (n > 0) metricas.contador('eventos_procesados', {}, n);
    } catch (e) {
      metricas.log('error', 'eventWorker.fallo', { error: e.message });
    }
  }, 2000);
  metricas.log('info', 'worker.eventos.activo');
}

module.exports = { iniciar };
