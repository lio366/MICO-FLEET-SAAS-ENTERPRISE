'use strict';
// server/services/stripe_eventos.js — procesamiento EXACTAMENTE-UNA-VEZ de eventos de Stripe (E-040).
// Sin Express: lo usa server/api/webhooks.js y lo ejerce tests/integration/postgres_t20.js.
//
// Recibe un evento YA verificado por firma (server/api/stripe_firma.js) y decide la respuesta HTTP:
//
//   1. Empresa: SOLO por tenants.stripe_customer_id del cliente del objeto del evento. Un tenant_id
//      en el cuerpo (metadata) se ignora siempre.
//        - sin cliente / cliente desconocido y tipo no gestionado → 200 (nada que aplicar)
//        - cliente desconocido y tipo gestionado                 → 503 (recuperable: el enlace puede
//          estar confirmándose; Stripe reintenta durante días)
//   2. Una transacción con app.current_tenant LOCAL (RLS):
//        INSERT stripe_eventos (id = event.id, clave primaria) … ON CONFLICT DO NOTHING
//        SELECT … FOR UPDATE: PROCESADO/IGNORADO → duplicado → 200 sin tocar nada
//                             EN_CURSO/FALLIDO    → se aplica (BillingService.aplicarEvento):
//                             suscripción + pago + empresa + asiento del ledger
//        UPDATE stripe_eventos → PROCESADO | IGNORADO
//      Dos entregas simultáneas del mismo evento: la segunda espera el candado de la clave primaria
//      y, al confirmarse la primera, la ve PROCESADO → 200 duplicado.
//   3. Si algo falla: ROLLBACK de TODO (ningún efecto parcial), registro FALLIDO (intentos, error) en
//      una transacción aparte, y 500 → Stripe reintenta. Si el COMMIT fue ambiguo y en realidad se
//      confirmó, el registro de fallo no pisa el PROCESADO y la reentrega responde 200 duplicado.
const { enTenant } = require('../http/contexto_tenant');

const ESTADOS_FINALES = new Set(['PROCESADO', 'IGNORADO']);

function crearProcesadorStripe({ db, billing, log = () => {} }) {
  if (!db || typeof db.connect !== 'function') throw new Error('crearProcesadorStripe requiere un pool (db.connect)');
  if (!billing || typeof billing.aplicarEvento !== 'function' || typeof billing.maneja !== 'function') {
    throw new Error('crearProcesadorStripe requiere una INSTANCIA de BillingService (new BillingService(db))');
  }
  const BillingService = require('../../03_billing_stripe');

  async function empresaDelCliente(clienteId) {
    // tenants no tiene RLS (se resuelve antes de conocer la empresa); solo se lee el id.
    const { rows } = await db.query('SELECT id FROM tenants WHERE stripe_customer_id = $1', [clienteId]);
    return rows.length ? rows[0].id : null;
  }

  async function registrarFallo(tenantId, evento, error) {
    const mensaje = String((error && (error.code ? `${error.code}: ` : '') + (error.message || error)) || 'error').slice(0, 500);
    try {
      await enTenant(db, tenantId, (c) => c.query(
        `INSERT INTO stripe_eventos (id, tenant_id, tipo, objeto_id, creado_stripe, estado, intentos, ultimo_error)
         VALUES ($1, $2, $3, $4, $5, 'FALLIDO', 1, $6)
         ON CONFLICT (id) DO UPDATE SET estado = 'FALLIDO', intentos = stripe_eventos.intentos + 1,
                                        ultimo_error = EXCLUDED.ultimo_error
         WHERE stripe_eventos.estado NOT IN ('PROCESADO', 'IGNORADO')`,
        [evento.id, tenantId, evento.type.slice(0, 100), objetoId(evento), evento.created, mensaje]));
    } catch (e) {
      log('error', 'stripe.fallo_no_registrado', { evento: evento.id, error: e.message });
    }
  }

  async function procesar(evento) {
    const clienteId = BillingService.clienteDeEvento(evento);
    const gestionado = billing.maneja(evento.type);
    if (!clienteId) {
      if (gestionado) {
        log('error', 'stripe.evento_sin_cliente', { evento: evento.id, tipo: evento.type });
        return { http: 503, cuerpo: { error: 'evento_sin_cliente' } };
      }
      return { http: 200, cuerpo: { recibido: true, resultado: 'sin_cliente' } };
    }
    const tenantId = await empresaDelCliente(clienteId);
    if (!tenantId) {
      if (gestionado) {
        log('warn', 'stripe.cliente_sin_empresa', { evento: evento.id, tipo: evento.type, cliente: clienteId });
        return { http: 503, cuerpo: { error: 'empresa_no_resuelta' } };
      }
      return { http: 200, cuerpo: { recibido: true, resultado: 'cliente_ajeno' } };
    }

    try {
      const r = await enTenant(db, tenantId, async (c) => {
        await c.query(
          `INSERT INTO stripe_eventos (id, tenant_id, tipo, objeto_id, creado_stripe, estado, intentos)
           VALUES ($1, $2, $3, $4, $5, 'EN_CURSO', 0)
           ON CONFLICT (id) DO NOTHING`,
          [evento.id, tenantId, evento.type.slice(0, 100), objetoId(evento), evento.created]);
        const { rows } = await c.query('SELECT estado, resultado FROM stripe_eventos WHERE id = $1 FOR UPDATE', [evento.id]);
        // Bajo RLS: si el id existe pero no se ve, lo registró otra empresa (no debería ocurrir nunca).
        if (!rows.length) throw Object.assign(new Error('event.id registrado por otra empresa'), { code: 'EVENTO_DE_OTRA_EMPRESA' });
        if (ESTADOS_FINALES.has(rows[0].estado)) return { duplicado: true, resultado: rows[0].resultado };

        const aplicado = await billing.aplicarEvento(c, tenantId, evento);
        await c.query(
          `UPDATE stripe_eventos SET estado = $2, resultado = $3, intentos = intentos + 1,
                  ultimo_error = NULL, procesado_en = now()
           WHERE id = $1`,
          [evento.id, aplicado.ignorado ? 'IGNORADO' : 'PROCESADO', String(aplicado.resultado).slice(0, 200)]);
        return { duplicado: false, resultado: aplicado.resultado };
      });
      if (r.duplicado) {
        log('info', 'stripe.evento_duplicado', { evento: evento.id, tenant: tenantId });
        return { http: 200, cuerpo: { recibido: true, duplicado: true, resultado: r.resultado } };
      }
      log('info', 'stripe.evento_procesado', { evento: evento.id, tipo: evento.type, tenant: tenantId, resultado: r.resultado });
      return { http: 200, cuerpo: { recibido: true, resultado: r.resultado } };
    } catch (e) {
      log('error', 'stripe.evento_fallido', { evento: evento.id, tipo: evento.type, tenant: tenantId, error: e.message, code: e.code || null });
      await registrarFallo(tenantId, evento, e);
      return { http: 500, cuerpo: { error: 'procesamiento_incompleto' } };
    }
  }

  return { procesar };
}

function objetoId(evento) {
  const o = evento.data && evento.data.object;
  const id = o && (typeof o.id === 'string' ? o.id : null);
  return id ? id.slice(0, 255) : null;
}

module.exports = { crearProcesadorStripe };
