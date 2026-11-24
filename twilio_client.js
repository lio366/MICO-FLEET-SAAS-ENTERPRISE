// ============================================================================
// services/twilio_client.js — ADAPTADOR DE TWILIO (único punto que habla con Twilio)
// Lo usan: 17 (SMS emergencia), 38 (voz auricular), 45 (notificaciones).
// Cambiar de proveedor o rotar credenciales = tocar SOLO este archivo.
// ============================================================================

let cliente = null;
function obtenerCliente() {
  if (!cliente) {
    if (!process.env.TWILIO_SID || !process.env.TWILIO_TOKEN) {
      throw new Error('Faltan TWILIO_SID / TWILIO_TOKEN en el entorno');
    }
    cliente = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
  }
  return cliente;
}

async function enviarSMS(a, texto) {
  const r = await obtenerCliente().messages.create({
    to: a, from: process.env.TWILIO_NUMERO, body: texto.slice(0, 320) });
  return { sid: r.sid, estado: r.status };
}

async function enviarWhatsApp(a, texto) {
  const r = await obtenerCliente().messages.create({
    to: 'whatsapp:' + a, from: 'whatsapp:' + process.env.TWILIO_WA, body: texto.slice(0, 1000) });
  return { sid: r.sid, estado: r.status };
}

async function llamarConTwiML(a, twiml) {
  const r = await obtenerCliente().calls.create({
    to: a, from: process.env.TWILIO_NUMERO_VOZ || process.env.TWILIO_NUMERO,
    twiml, timeout: 10 });
  return { sid: r.sid, estado: r.status };
}

// Verificación de firma de webhooks entrantes (SMS/voz de Twilio)
function verificarFirma(url, params, firma) {
  return require('twilio').validateRequest(process.env.TWILIO_TOKEN, firma, url, params);
}

module.exports = { enviarSMS, enviarWhatsApp, llamarConTwiML, verificarFirma };
