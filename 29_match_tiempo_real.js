// ============================================================================
// 29_match_tiempo_real.js — MATCH EN TIEMPO REAL (segundos, no minutos)
// Versión 5.0
//
// PROBLEMA ANTERIOR: el agente revisaba el tablero cada 20 segundos y el
// camionero recibía la oferta minutos después. En el mundo real una carga
// buena dura 1-3 minutos en el tablero antes de que otro broker se la lleve.
//
// SOLUCIÓN (3 capas):
//   1. Bucle del agente cada 10 segundos (configurable).
//   2. Alerta INSTANTÁNEA al camionero en cuanto hay match:
//      - Notificación push en la app del chofer (websocket)
//      - SMS de respaldo ("NUEVA CARGA: Atlanta→Dallas $2,100. Responde 1 o 2")
//   3. Regla de rapidez: si la carga apareció hace más de X minutos en el
//      tablero, se descarta (ya está "quemada", la negoció otro).
// ============================================================================

const CONFIG = {
  INTERVALO_REVISION_SEG: 10,     // cada cuánto revisa el tablero
  CARGA_MAXIMA_ANTIGUEDAD_MIN: 3, // no ofrecer cargas con más de 3 min publicadas
  SMS_RESPALDO: true,             // mandar SMS además del push
  PUSH_TIMEOUT_SEG: 20            // si en 20s no responde por app, mandar SMS
};

// ---------------------------------------------------------------------------
// Paso 1: revisión rápida del tablero
// ---------------------------------------------------------------------------
function iniciarMatchTiempoReal({ buscarCargas, buscarCamiones, hacerMatch, notificarChofer, enviarSMS }) {
  let enEjecucion = false;

  const ciclo = async () => {
    if (enEjecucion) return;          // no encimar ciclos si el anterior tardó
    enEjecucion = true;
    try {
      const cargas = await buscarCargas();       // del tablero conectado
      const camiones = await buscarCamiones();   // camioneros disponibles en tu app

      for (const carga of cargas) {
        const antiguedadMin = (Date.now() - new Date(carga.publicadaEn)) / 60000;
        if (antiguedadMin > CONFIG.CARGA_MAXIMA_ANTIGUEDAD_MIN) continue; // ya está quemada

        for (const camion of camiones) {
          const match = await hacerMatch(carga, camion); // puede ser asíncrono (motor neural, deduplicación en BD)
          if (match && match.score > 0.75) {
            await notificarAlInstante(match, { notificarChofer, enviarSMS });
          }
        }
      }
    } catch (e) {
      console.error('[MATCH-TIEMPO-REAL]', e.message);
    } finally {
      enEjecucion = false;
    }
  };

  const timer = setInterval(ciclo, CONFIG.INTERVALO_REVISION_SEG * 1000);
  console.log(`[MATCH-TIEMPO-REAL] activo: revisando cada ${CONFIG.INTERVALO_REVISION_SEG}s`);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Paso 2: notificación instantánea (push + SMS de respaldo)
// ---------------------------------------------------------------------------
async function notificarAlInstante(match, { notificarChofer, enviarSMS }) {
  const { chofer, carga } = match;
  const texto = `NUEVA CARGA: ${carga.origen}→${carga.destino} $${carga.pago}. ` +
                `Responde 1 para ACEPTAR, 2 para rechazar.`;

  // A. Push a la app del chofer (websocket)
  const entregado = await notificarChofer(chofer.id, {
    tipo: 'NUEVA_CARGA',
    cargaId: carga.id,
    texto,
    sonido: 'alerta_alta',
    vibracion: [300, 100, 300]
  });

  // B. Si en 20 segundos no lo abrió en la app → SMS de emergencia (archivo 17).
  //    Solo si el canal de push sabe decir si el chofer la vio (checkVisto). El temporizador nunca
  //    deja escapar un rechazo: en Node un rechazo no capturado en un setTimeout tumba el proceso.
  if (CONFIG.SMS_RESPALDO && typeof notificarChofer.checkVisto === 'function') {
    const t = setTimeout(async () => {
      try {
        const vioLaNotificacion = await notificarChofer.checkVisto(chofer.id, carga.id);
        if (!vioLaNotificacion) await enviarSMS(chofer.telefono, texto, chofer);
      } catch (e) {
        console.error('[MATCH-TIEMPO-REAL] SMS de respaldo falló:', e.message);
      }
    }, CONFIG.PUSH_TIMEOUT_SEG * 1000);
    if (typeof t.unref === 'function') t.unref();
  }
  return entregado;
}

module.exports = { iniciarMatchTiempoReal, notificarAlInstante, CONFIG };
