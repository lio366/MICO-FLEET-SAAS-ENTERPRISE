// ============================================================================
// 45_notification_service.js — UN SOLO LUGAR PARA AVISAR A TODO EL MUNDO
// Versión 5.3
//
// Antes: cada módulo avisaba como podía (WhatsApp aquí, SMS allá, push acá).
// Ahora: TODO pasa por este servicio. Canales: push (app), SMS (Twilio),
// WhatsApp (Twilio), voz/llamada (archivo 38), email (SMTP barato).
//
// REGLAS:
//   - Cada destinatario tiene preferencias de canal; si el primario falla,
//     se cae al SMS por defecto (siempre entra).
//   - Plantillas en español/inglés según el idioma del destinatario.
//   - Todo envío queda registrado (qué, a quién, cuándo, si llegó).
// ============================================================================

const SQL = require('./db/sql').leerSql('45_notification_service'); // DDL versionado en sql/45_notification_service.sql (E-017)

const PLANTILLAS = {
  es: {
    NUEVA_CARGA: (c) => `🔔 NUEVA CARGA: ${c.origen}→${c.destino} $${c.pago}. Responde 1=aceptar 2=rechazar.`,
    CARGA_CONFIRMADA: (c) => `✅ Confirmada: ${c.origen}→${c.destino}. Recoge ${c.recogida}.`,
    PAGO_DEPOSITADO: (c) => `💰 Te depositaron $${c.monto}.`,
    ALERTA_SEGURIDAD: (c) => `🛡 ${c.texto}`,
    ALERTA_SISTEMA: (c) => `⚠️ ${c.texto}`,
  },
  en: {
    NUEVA_CARGA: (c) => `🔔 NEW LOAD: ${c.origin}→${c.dest} $${c.rate}. Reply 1=accept 2=reject.`,
    CARGA_CONFIRMADA: (c) => `✅ Confirmed: ${c.origin}→${c.dest}. Pick up ${c.pickup}.`,
    PAGO_DEPOSITADO: (c) => `💰 $${c.monto} deposited.`,
    ALERTA_SEGURIDAD: (c) => `🛡 ${c.texto}`,
    ALERTA_SISTEMA: (c) => `⚠️ ${c.texto}`,
  }
};

// v7.3 (E-031): bajo RLS, el historial y la búsqueda del chofer necesitan el contexto de su empresa.
// Las alertas del sistema (tenantId null) se registran sin empresa (política de solo inserción).
// El registro del historial NUNCA hace fallar una notificación ya enviada: si fallara, el bus
// reintentaría el evento y el chofer recibiría el mismo SMS otra vez.
function crearServicioNotificaciones({ db, twilio, pushSender, emailSender }) {
  const { enTenant } = require('./server/http/contexto_tenant');
  const metricas = () => require('./43_metrics_observability');

  async function guardar(tenantId, destinatario, canal, tipo, texto, entregado, error = null) {
    const sql = `INSERT INTO notificaciones_enviadas (tenant_id, destinatario, canal, tipo, texto, entregado, error)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`;
    const params = [tenantId || null, String(destinatario).slice(0, 64), canal, tipo, texto, entregado, error];
    try {
      if (tenantId) await enTenant(db, tenantId, (c) => c.query(sql, params));
      else await db.query(sql, params);
    } catch (e) {
      metricas().log('error', 'notificacion.historial_fallo', { tenantId, canal, tipo, error: e.message });
    }
  }

  // Envía por un canal concreto y reporta si llegó
  async function enviarCanal(canal, destino, texto) {
    try {
      if (canal === 'sms') await twilio.messages.create({ to: destino.telefono, from: process.env.TWILIO_NUMERO, body: texto.slice(0, 320) });
      else if (canal === 'whatsapp') await twilio.messages.create({ to: 'whatsapp:' + destino.telefono, from: 'whatsapp:' + process.env.TWILIO_WA, body: texto });
      else if (canal === 'push') await pushSender(destino.pushToken, texto);
      else if (canal === 'voz') return 'voz'; // la voz la orquesta el módulo 38 (llamada)
      else if (canal === 'email') await emailSender(destino.email, texto);
      return true;
    } catch (e) {
      return e.message;
    }
  }

  // NÚCLEO: elegir canal según preferencia, con cadena de respaldo al SMS
  async function notificar(tenantId, destinatario, { tipo, datos, preferencia = null }) {
    const prefs = preferencia || destinatario.preferencias?.canales || ['push', 'sms'];
    const lang = destinatario.idioma || 'es';
    const plantilla = PLANTILLAS[lang][tipo] || PLANTILLAS.es[tipo];
    const texto = datos.texto || plantilla(datos);

    for (const canal of prefs) {
      if (canal === 'voz') {
        await require('./38_modo_voz_auricular').llamarConOferta(twilio, destinatario, datos);
        await guardar(tenantId, destinatario.id, 'voz', tipo, texto, true);
        return { entregado: true, canal: 'voz' };
      }
      const r = await enviarCanal(canal, destinatario, texto);
      await guardar(tenantId, destinatario.id, canal, tipo, texto, r === true, r === true ? null : String(r));
      if (r === true) return { entregado: true, canal };
    }
    // Todo falló → SMS final (el que nunca falla)
    const r = await enviarCanal('sms', destinatario, texto);
    await guardar(tenantId, destinatario.id, 'sms', tipo, texto, r === true, r === true ? null : String(r));
    return { entregado: r === true, canal: 'sms' };
  }

  // Busca el contacto real del chofer en la BD (columnas que SÍ existen en 01:
  // phone/email; idioma y preferencias viven en la app del chofer — AsyncStorage —
  // y se pasan como override en msg.destinatario cuando haga falta).
  async function contactoChofer(tenantId, driverId, override = {}) {
    if (!tenantId) throw new Error('alChofer requiere la empresa del chofer');
    const { rows } = await enTenant(db, tenantId, (c) => c.query(
      `SELECT id, phone AS telefono, email FROM drivers WHERE id=$1 AND tenant_id=$2`,
      [driverId, tenantId]), { soloLectura: true });
    if (!rows.length) throw new Error('Chofer no encontrado: ' + driverId);
    // La etiqueta va DESPUÉS de la fila: rows[0] trae su propia columna id y la pisaba
    // (el historial guardaba el uuid suelto en lugar de 'driver:<uuid>').
    const { id: _idFila, ...contacto } = rows[0];
    return { idioma: 'es', ...contacto, ...override, id: 'driver:' + driverId };
  }

  return {
    alChofer: async (tenantId, driverId, msg) => notificar(tenantId, await contactoChofer(tenantId, driverId, msg.destinatario), msg),
    alAdmin: (tenantId, msg) => notificar(tenantId, { id: 'admin', idioma: 'es', telefono: process.env.ADMIN_PHONE }, msg),
    alShipper: (tenantId, mc, msg) => notificar(tenantId, { id: 'shipper:' + mc, idioma: 'en', telefono: msg.telefono }, msg),
    // Historial de un destinatario DENTRO de su empresa (antes leía de todas las empresas).
    historial: async (tenantId, destinatario, limite = 50) =>
      (await enTenant(db, tenantId, (c) => c.query(
        `SELECT * FROM notificaciones_enviadas WHERE destinatario=$1 ORDER BY id DESC LIMIT $2`,
        [destinatario, Math.min(Math.max(1, Number(limite) || 50), 500)]), { soloLectura: true })).rows,
  };
}

module.exports = { SQL, PLANTILLAS, crearServicioNotificaciones };
