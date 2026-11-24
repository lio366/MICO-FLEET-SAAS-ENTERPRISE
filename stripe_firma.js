'use strict';
// Verificación de la firma de los webhooks de Stripe (esquema v1), sin el SDK.
//
// Cabecera:  Stripe-Signature: t=<segundos unix>,v1=<hex>[,v1=<hex>…][,v0=…]
// Firmado:   HMAC-SHA256(secreto_del_endpoint, `${t}.${cuerpo_crudo}`) en hexadecimal.
// Reglas:    - se firma el cuerpo EXACTO recibido (bytes), nunca un JSON re-serializado;
//            - se acepta cualquier v1 que coincida (Stripe envía varias durante la rotación del
//              secreto del endpoint) y cualquier secreto configurado (rotación del lado propio);
//            - el resto de esquemas (v0, …) se ignora;
//            - t debe estar dentro de la tolerancia (300 s por defecto, como los SDK oficiales):
//              limita la reutilización de una petición capturada;
//            - comparación en tiempo constante.
// No toca la base de datos: el webhook la llama ANTES de cualquier consulta.
const crypto = require('node:crypto');

const TOLERANCIA_SEGUNDOS = 300;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function parsearCabecera(cabecera) {
  if (typeof cabecera !== 'string' || cabecera.length === 0 || cabecera.length > 4096) return null;
  let t = null;
  const v1 = [];
  for (const parte of cabecera.split(',')) {
    const i = parte.indexOf('=');
    if (i <= 0) continue;
    const clave = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (clave === 't') {
      if (!/^\d{1,12}$/.test(valor) || t !== null) return null; // un único t, entero
      t = Number(valor);
    } else if (clave === 'v1') {
      if (HEX_SHA256.test(valor)) v1.push(valor);
    }
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

// Lista de secretos: STRIPE_WEBHOOK_SECRET admite varios separados por coma (rotación).
function secretosDesdeEntorno(valor = process.env.STRIPE_WEBHOOK_SECRET) {
  return String(valor || '').split(',').map(s => s.trim()).filter(Boolean);
}

function firmar(cuerpo, secreto, t) {
  return crypto.createHmac('sha256', secreto).update(`${t}.`).update(cuerpo).digest('hex');
}

function igualHex(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{cuerpo: Buffer|string, cabecera: string, secretos: string[], tolerancia?: number, ahora?: number}} p
 *        ahora en segundos unix (inyectable para pruebas).
 * @returns {{ok: true, evento: object} | {ok: false, motivo: string}}
 */
function verificarFirmaStripe({ cuerpo, cabecera, secretos, tolerancia = TOLERANCIA_SEGUNDOS, ahora = Math.floor(Date.now() / 1000) }) {
  if (!Array.isArray(secretos) || secretos.length === 0) return { ok: false, motivo: 'sin_secreto' };
  if (!Buffer.isBuffer(cuerpo) && typeof cuerpo !== 'string') return { ok: false, motivo: 'sin_cuerpo_crudo' };
  const bytes = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'utf8');
  if (bytes.length === 0) return { ok: false, motivo: 'sin_cuerpo_crudo' };
  const c = parsearCabecera(cabecera);
  if (!c) return { ok: false, motivo: 'cabecera_invalida' };
  if (Math.abs(ahora - c.t) > tolerancia) return { ok: false, motivo: 'fuera_de_tolerancia' };
  let coincide = false;
  for (const secreto of secretos) {
    const esperado = firmar(bytes, secreto, c.t);
    for (const recibido of c.v1) if (igualHex(esperado, recibido)) coincide = true; // sin salida temprana
  }
  if (!coincide) return { ok: false, motivo: 'firma_no_coincide' };
  let evento;
  try { evento = JSON.parse(bytes.toString('utf8')); } catch (_) { return { ok: false, motivo: 'json_invalido' }; }
  if (!evento || typeof evento !== 'object' || evento.object !== 'event'
      || typeof evento.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,250}$/.test(evento.id)
      || typeof evento.type !== 'string' || !Number.isSafeInteger(evento.created)
      || !evento.data || typeof evento.data.object !== 'object' || evento.data.object === null) {
    return { ok: false, motivo: 'evento_malformado' };
  }
  return { ok: true, evento };
}

// Cabecera de prueba con el mismo formato que envía Stripe (solo para suites de integración).
function cabeceraDePrueba(cuerpo, secreto, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${firmar(Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'utf8'), secreto, t)}`;
}

module.exports = { verificarFirmaStripe, parsearCabecera, secretosDesdeEntorno, cabeceraDePrueba, TOLERANCIA_SEGUNDOS };
