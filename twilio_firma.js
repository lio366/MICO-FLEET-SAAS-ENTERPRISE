'use strict';
// Validación de X-Twilio-Signature para webhooks de formulario (SMS y voz), según el
// algoritmo documentado por Twilio (https://www.twilio.com/docs/usage/security):
//   1. Partir de la URL completa que Twilio invocó (esquema, host, puerto, ruta y query tal cual).
//   2. Añadir cada parámetro POST ordenado por nombre (orden binario, sensible a mayúsculas):
//      nombre + valor, sin separadores.
//   3. HMAC-SHA1 con el Auth Token como clave; codificar en Base64.
//   4. Comparar en tiempo constante con la cabecera X-Twilio-Signature.
// Sin dependencias (no requiere el SDK de Twilio). Falla CERRADO si falta configuración (E-026).
const crypto = require('node:crypto');

function cadenaAFirmar(url, params = {}) {
  const nombres = Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let texto = url;
  for (const nombre of nombres) {
    const valor = params[nombre];
    if (Array.isArray(valor)) {
      // Parámetros repetidos: Twilio concatena cada aparición en el orden recibido.
      for (const v of valor) texto += nombre + (v ?? '');
    } else {
      texto += nombre + (valor ?? '');
    }
  }
  return texto;
}

function firmaEsperada(authToken, url, params) {
  return crypto.createHmac('sha1', authToken).update(Buffer.from(cadenaAFirmar(url, params), 'utf8')).digest('base64');
}

function validarFirmaTwilio({ authToken, url, params, firma }) {
  if (typeof authToken !== 'string' || !authToken) return false;
  if (typeof url !== 'string' || !url) return false;
  if (typeof firma !== 'string' || !firma) return false;
  const esperado = Buffer.from(firmaEsperada(authToken, url, params || {}), 'utf8');
  const recibido = Buffer.from(firma, 'utf8');
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}

// URL pública con la que Twilio llamó: base configurada (sin barra final) + ruta original con query.
// No se reconstruye desde cabeceras Host/X-Forwarded-*: un atacante las controla.
function urlPublica(base, rutaOriginal) {
  return base.replace(/\/+$/, '') + rutaOriginal;
}

// Middleware: exige firma válida antes de tocar la base de datos.
//   503 si falta TWILIO_TOKEN o TWILIO_WEBHOOK_BASE_URL (configuración incompleta: nunca aceptar sin verificar)
//   403 si la firma falta o no coincide
function exigirFirmaTwilio({ authToken = process.env.TWILIO_TOKEN, baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL, log = () => {} } = {}) {
  return function verificarFirmaTwilio(req, res, next) {
    if (!authToken || !baseUrl) {
      log('twilio.firma_sin_configuracion');
      return res.status(503).send('webhook no configurado');
    }
    const firma = req.headers && (req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature']);
    const url = urlPublica(baseUrl, req.originalUrl || req.url || '');
    if (!validarFirmaTwilio({ authToken, url, params: req.body || {}, firma })) {
      log('twilio.firma_invalida', { ruta: req.originalUrl || req.url });
      return res.status(403).send('firma inválida');
    }
    return next();
  };
}

module.exports = { cadenaAFirmar, firmaEsperada, validarFirmaTwilio, urlPublica, exigirFirmaTwilio };
