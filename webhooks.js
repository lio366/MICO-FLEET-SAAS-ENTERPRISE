// ============================================================================
// server/api/webhooks.js — ENTRADAS EXTERNAS (Stripe, Twilio)
// Van ANTES del middleware de tenant y NO pasan por el rate limit estricto
// (Stripe y Twilio reintentan si tarda). Cada proveedor verifica su firma
// ANTES de tocar la base de datos:
//   Stripe → Stripe-Signature sobre el cuerpo crudo (req.rawBody, ver 40_api_gateway) con
//            server/api/stripe_firma.js; procesamiento exactamente-una-vez en
//            server/services/stripe_eventos.js (E-040)
//   Twilio → X-Twilio-Signature sobre URL pública + parámetros (server/api/twilio_firma.js)
// La lógica de los webhooks de Twilio vive en crearManejadoresTwilio(), sin Express,
// para poder probarla con PostgreSQL real (tests/integration/postgres_t17.js).
// ============================================================================

const { exigirFirmaTwilio } = require('./twilio_firma');
const { verificarFirmaStripe, secretosDesdeEntorno } = require('./stripe_firma');

// Stripe sin Express (probado en tests/integration/postgres_t20.js):
//   - firma inválida, cuerpo crudo ausente o evento malformado → 400, sin tocar la base de datos;
//   - sin secreto configurado → 503 (error de despliegue; Stripe reintenta cuando se corrija);
//   - el resto lo decide el procesador (200 procesado/duplicado/ajeno, 503 empresa no resuelta,
//     500 procesamiento incompleto). BillingService se instancia UNA vez por servidor.
function crearManejadorStripe({ db, billing = null, secretos = secretosDesdeEntorno(), log = () => {} }) {
  const BillingService = require('../../03_billing_stripe');
  const { crearProcesadorStripe } = require('../services/stripe_eventos');
  const servicio = billing || new BillingService(db);
  const procesador = crearProcesadorStripe({ db, billing: servicio, log });
  return async function stripe(req, res) {
    if (!secretos.length) {
      log('error', 'stripe.sin_secreto_webhook', {});
      return res.status(503).json({ error: 'webhook_no_configurado' });
    }
    const verificacion = verificarFirmaStripe({ cuerpo: req.rawBody, cabecera: req.headers['stripe-signature'], secretos });
    if (!verificacion.ok) {
      log('warn', 'stripe.firma_rechazada', { motivo: verificacion.motivo });
      return res.status(400).json({ error: 'firma_invalida' });
    }
    const r = await procesador.procesar(verificacion.evento);
    return res.status(r.http).json(r.cuerpo);
  };
}

function crearManejadoresTwilio({ db, notificar = null, autoDispatch = null }) {
  const sms = require('../../17_sms_emergencia');
  const voz = require('../../38_modo_voz_auricular');
  const ofertas = require('../services/ofertas');
  const adaptadorVoz = ofertas.crearAdaptadorVoz(db, {
    alRechazar: autoDispatch && typeof autoDispatch.reasignar === 'function'
      ? ({ bookingId, tenantId, loadId }) => autoDispatch.reasignar({ id: bookingId, tenant_id: tenantId, load_id: loadId })
      : null,
  });
  return {
    // Twilio: SMS del chofer ("1"/"2") → archivo 17
    async sms(req, res) {
      const { From, Body } = req.body || {};
      const r = await sms.procesarRespuesta(db, { From, Body }, { notificar, autoDispatch });
      res.type('text/xml').send(r.twiml);
    },
    // Twilio: decisión por voz en la llamada del auricular → archivo 38
    async vozDecision(req, res) {
      const bookingId = new URL(req.originalUrl || req.url, 'http://x').searchParams.get('booking');
      const xml = await voz.webhookDecision(adaptadorVoz, {
        bookingId, SpeechResult: (req.body || {}).SpeechResult, Digits: (req.body || {}).Digits });
      res.type('text/xml').send(xml);
    },
  };
}

// Envuelve un manejador async: un error responde 500 sin filtrar detalles (Twilio reintentará).
const seguro = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function crearWebhooks({ db, notificar = null, autoDispatch = null, log = () => {} }) {
  const r = require('express').Router();

  // Stripe: pagos, fallos, cancelaciones → archivo 03 (vía server/services/stripe_eventos.js).
  // La firma se calcula sobre los BYTES recibidos: req.rawBody lo guarda el parser del gateway.
  r.post('/stripe', seguro(crearManejadorStripe({ db, log })));

  const twilio = crearManejadoresTwilio({ db, notificar, autoDispatch });
  // log del gateway: (nivel, evento, datos); el verificador de Twilio registra (evento, datos).
  const firmaTwilio = exigirFirmaTwilio({ log: (evento, datos) => log('warn', evento, datos || {}) });
  r.post('/sms', firmaTwilio, seguro(twilio.sms));
  r.post('/voz/decision', firmaTwilio, seguro(twilio.vozDecision));

  return r;
};

module.exports.crearManejadoresTwilio = crearManejadoresTwilio;
module.exports.crearManejadorStripe = crearManejadorStripe;
