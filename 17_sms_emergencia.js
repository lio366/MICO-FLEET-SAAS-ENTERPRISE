/**
 * SMS DE EMERGENCIA — Aceptar cargas con UNA RAYITA de señal
 * Versión 7.1 (E-025)
 *
 * Cuando no hay datos móviles (ranchos, desierto, montaña), el SMS SÍ entra.
 * El webhook de Twilio (server/api/webhooks.js → POST /webhooks/sms, con firma
 * X-Twilio-Signature verificada antes de llegar aquí) llama a procesarRespuesta().
 *
 * FLUJO:
 *   1. App sin señal → el servidor detecta que no confirmó en 15 min
 *   2. Servidor manda SMS: "Carga #4521 Miami→Atlanta $1,950. Responde 1=aceptar 2=rechazar"
 *   3. Chofer responde "1" o "2" (funciona con señal mínima, aunque no abra la app)
 *   4. Se resuelve la empresa del chofer por su teléfono (función SECURITY DEFINER que solo
 *      devuelve ids) y TODO lo demás corre con app.current_tenant fijado: RLS normal.
 *   5. La respuesta se aplica exactamente una vez (46.responderOfertaUnaVez). Al rechazar,
 *      la carga vuelve a AVAILABLE en la misma transacción para poder reasignarla.
 *
 * Twilio reintenta los webhooks: una respuesta repetida no cambia nada (estado DUPLICADA).
 * A números desconocidos no se les revela nada (TwiML vacío).
 */
const ofertas = require('./server/services/ofertas');

const MENSAJES = {
  confirmada: (o) => `Carga ${ofertas.ruta(o)} CONFIRMADA. Buen viaje.`,
  rechazada: (o) => `Carga ${ofertas.ruta(o)} rechazada. Le avisaremos de otra.`,
  instruccion: 'Responda solo: 1 = aceptar, 2 = rechazar',
};

function escaparXml(texto) {
  return String(texto).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function twimlMensaje(texto) {
  return texto
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaparXml(texto)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function interpretar(cuerpo) {
  const t = String(cuerpo ?? '').trim().toLowerCase();
  if (t === '1' || t === 'si' || t === 'sí') return true;
  if (t === '2' || t === 'no') return false;
  return null;
}

async function avisar(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { await fn(...args); } catch (_) { /* las notificaciones no bloquean la respuesta al chofer */ }
}

/**
 * Procesa la respuesta SMS de un chofer.
 * @param {Pool} db       Pool del rol runtime (mf_app); nunca credenciales administrativas.
 * @param {{From:string, Body:string}} mensaje  Parámetros del webhook de Twilio.
 * @param {{notificar?:Function, autoDispatch?:object}} deps  Ganchos opcionales.
 * @returns {{estado:string, twiml:string, bookingId?:string, tenantId?:string}}
 *   estado ∈ DESCONOCIDO | SIN_OFERTA | NO_ENTENDIDA | CONFIRMADA | RECHAZADA | DUPLICADA
 */
async function procesarRespuesta(db, { From, Body } = {}, { notificar = null, autoDispatch = null } = {}) {
  const { chofer, oferta } = await ofertas.ofertaPendientePorTelefono(db, From);
  if (!chofer) return { estado: 'DESCONOCIDO', twiml: twimlMensaje(null) };
  if (!oferta) return { estado: 'SIN_OFERTA', twiml: twimlMensaje(null) };

  const acepta = interpretar(Body);
  if (acepta === null) {
    return { estado: 'NO_ENTENDIDA', twiml: twimlMensaje(MENSAJES.instruccion), bookingId: oferta.booking_id, tenantId: oferta.tenant_id };
  }

  const r = (await ofertas.responder(db, { bookingId: oferta.booking_id, tenantId: oferta.tenant_id, acepta })).resultado;
  if (!r.respondida) {
    return { estado: 'DUPLICADA', twiml: twimlMensaje(null), bookingId: oferta.booking_id, tenantId: oferta.tenant_id };
  }

  if (acepta) {
    await avisar(autoDispatch && autoDispatch.confirmarTrasSms && autoDispatch.confirmarTrasSms.bind(autoDispatch),
      { id: oferta.booking_id, tenant_id: oferta.tenant_id, load_id: oferta.load_id }, { id: oferta.driver_id, full_name: oferta.chofer_nombre });
    await avisar(notificar, oferta.tenant_id,
      `✅ ${oferta.chofer_nombre} confirmó la carga ${ofertas.ruta(oferta)} por SMS (zona sin datos).`);
    return { estado: 'CONFIRMADA', twiml: twimlMensaje(MENSAJES.confirmada(oferta)), bookingId: oferta.booking_id, tenantId: oferta.tenant_id };
  }

  await avisar(notificar, oferta.tenant_id,
    `❌ ${oferta.chofer_nombre} rechazó la carga ${ofertas.ruta(oferta)} por SMS. La carga vuelve a estar disponible.`);
  if (r.cargaLiberada) {
    await avisar(autoDispatch && autoDispatch.reasignar && autoDispatch.reasignar.bind(autoDispatch),
      { id: oferta.booking_id, tenant_id: oferta.tenant_id, load_id: oferta.load_id });
  }
  return { estado: 'RECHAZADA', twiml: twimlMensaje(MENSAJES.rechazada(oferta)), bookingId: oferta.booking_id, tenantId: oferta.tenant_id };
}

module.exports = { procesarRespuesta, interpretar, twimlMensaje, MENSAJES };
