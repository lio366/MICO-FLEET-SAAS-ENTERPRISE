/**
 * FACTURACIÓN AUTOMÁTICA CON STRIPE — El cobrador mensual
 * Versión 7.4 (E-040)
 *
 * Cómo funciona el dinero:
 *  1. El broker entra, prueba 14 días gratis
 *  2. Al elegir plan, registra su tarjeta en Stripe (nunca tocamos los números de tarjeta)
 *  3. Stripe cobra automáticamente cada mes
 *  4. Si el pago falla → PAST_DUE → 7 días de gracia → server/workers/cronWorker.js suspende
 *  5. El webhook (server/services/stripe_eventos.js) aplica cada evento UNA vez con aplicarEvento()
 *
 * Reglas del webhook (aplicarEvento):
 *  - La empresa se decide ANTES de llamar aquí, por tenants.stripe_customer_id. Este módulo nunca
 *    lee un tenant_id del evento (metadata): un dato del cuerpo no decide a quién se le aplica.
 *  - Todo ocurre sobre el cliente de la transacción del llamador (contexto de empresa ya fijado):
 *    suscripción, pago, estado de la empresa y asiento del ledger se confirman o se deshacen juntos.
 *  - Orden: el estado de una suscripción solo lo cambia un evento con event.created mayor que el del
 *    último evento aplicado (stripe_estado_en). Empate: solo gana una cancelación (estado terminal).
 *    El fin de periodo pagado solo avanza (GREATEST), sea cual sea el orden de llegada.
 *  - Pagos: como máximo un SUCCEEDED por factura (índice único parcial, migración 007), aunque la misma
 *    factura llegue como invoice.paid e invoice.payment_succeeded o se reentregue.
 */
// Stripe PEREZOSO: se instancia al primer uso real, no al cargar el módulo (E-013).
let _stripe = null;
function stripe() {
  if (!_stripe) {
    const clave = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET;
    if (!clave) throw new Error('Falta STRIPE_SECRET_KEY en el entorno (se necesita al cobrar, no para arrancar)');
    _stripe = require('stripe')(clave);
  }
  return _stripe;
}

const crypto = require('node:crypto');

// DDL de facturación versionado en sql/03_billing_stripe.sql (E-017). Columnas de Stripe: migración 007.
const SQL = require('./db/sql').leerSql('03_billing_stripe');

const PLANS = Object.freeze({
  STARTER:    Object.freeze({ price: 299,  trucks: 10,  users: 3,  name: 'Starter' }),
  PRO:        Object.freeze({ price: 799,  trucks: 50,  users: 10, name: 'Pro' }),
  ENTERPRISE: Object.freeze({ price: 1999, trucks: 200, users: 50, name: 'Enterprise' }),
});

// Estado de suscripción de Stripe → estado local (columna subscriptions.status).
const ESTADOS_STRIPE = Object.freeze({
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  unpaid: 'PAST_DUE',
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'CANCELLED',
  canceled: 'CANCELLED',
  paused: 'PAUSED',
});

const TIPOS_SUSCRIPCION = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed',
]);
const TIPOS_PAGO = new Set(['invoice.paid', 'invoice.payment_succeeded']);
const TIPOS_PAGO_FALLIDO = new Set(['invoice.payment_failed']);

const ACTOR = 'stripe:webhook';

// Un campo de Stripe puede venir como id ('cus_…') o expandido ({ id: 'cus_…' }).
function idDe(x) {
  if (typeof x === 'string') return x || null;
  if (x && typeof x === 'object' && typeof x.id === 'string') return x.id || null;
  return null;
}
const entero = (x) => (Number.isSafeInteger(x) ? x : null);

// Cliente de Stripe al que pertenece el objeto del evento (la única llave hacia la empresa).
function clienteDeEvento(evento) {
  const obj = evento && evento.data && evento.data.object;
  if (!obj || typeof obj !== 'object') return null;
  if (obj.object === 'customer') return idDe(obj.id);
  return idDe(obj.customer);
}

// Suscripción de una factura: API clásica (invoice.subscription) y API 2025+ (invoice.parent).
function suscripcionDeFactura(inv) {
  return idDe(inv.subscription)
    || idDe(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription)
    || null;
}

// Fin del periodo cubierto por una factura: el mayor period.end de sus líneas.
function finPeriodoDeFactura(inv) {
  const lineas = inv.lines && Array.isArray(inv.lines.data) ? inv.lines.data : [];
  let fin = null;
  for (const l of lineas) {
    const e = entero(l && l.period && l.period.end);
    if (e !== null && (fin === null || e > fin)) fin = e;
  }
  return fin;
}

// Periodo de una suscripción: en la raíz (API clásica) o en el primer ítem (API 2025+).
function periodoDeSuscripcion(sub) {
  const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  return {
    inicio: entero(sub.current_period_start) ?? entero(item && item.current_period_start),
    fin: entero(sub.current_period_end) ?? entero(item && item.current_period_end),
  };
}

// dedup_key del ledger admite 80 caracteres: los ids de Stripe largos se resumen.
function claveDedup(prefijo, id) {
  const clave = `${prefijo}:${id}`;
  if (clave.length <= 80) return clave;
  return `${prefijo}:h:${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 80 - prefijo.length - 3)}`;
}

const recortar = (s, n) => (s == null ? null : String(s).slice(0, n));

class BillingService {
  /**
   * @param {object} db      Pool del rol runtime (para las operaciones iniciadas por la API).
   * @param {object} [deps]  { ledger } — por defecto 42_audit_ledger; inyectable en pruebas.
   */
  constructor(db, { ledger = null } = {}) {
    this.db = db;
    this.ledger = ledger || require('./42_audit_ledger');
    this.PLANS = PLANS;
  }

  /** ¿Este tipo de evento cambia datos? Los demás se registran como IGNORADO. */
  maneja(tipo) {
    return TIPOS_SUSCRIPCION.has(tipo) || TIPOS_PAGO.has(tipo) || TIPOS_PAGO_FALLIDO.has(tipo);
  }

  /**
   * Crear la suscripción cuando un broker elige plan por primera vez.
   * Idempotente frente a reintentos del cliente: las llamadas a Stripe llevan claves de idempotencia
   * derivadas de la empresa, y el enlace empresa ↔ cliente de Stripe se guarda antes de crear la
   * suscripción (los webhooks se atribuyen solo por ese enlace).
   */
  async createSubscription(tenantId, planKey, paymentMethodId) {
    const plan = PLANS[planKey];
    if (!plan) throw Object.assign(new Error('Plan inválido'), { status: 400 });

    const { rows: [t] } = await this.db.query(
      'SELECT id, name, stripe_customer_id FROM tenants WHERE id = $1', [tenantId]);
    if (!t) throw Object.assign(new Error('Empresa inexistente'), { status: 404 });

    // 1. Cliente en Stripe (uno por empresa) y enlace local ANTES de cualquier cobro.
    let customerId = t.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe().customers.create(
        { name: t.name, metadata: { tenant_id: tenantId } },
        { idempotencyKey: `mf-cliente-${tenantId}` });
      customerId = customer.id;
      const { rows } = await this.db.query(
        `UPDATE tenants SET stripe_customer_id = $1, updated_at = now()
         WHERE id = $2 AND (stripe_customer_id IS NULL OR stripe_customer_id = $1) RETURNING id`,
        [customerId, tenantId]);
      if (!rows.length) throw Object.assign(new Error('La empresa ya está enlazada a otro cliente de Stripe'), { status: 409 });
    }

    // 2. Tarjeta por defecto
    await stripe().paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });

    // 3. Suscripción con prueba de 14 días
    const subscription = await stripe().subscriptions.create({
      customer: customerId,
      items: [{ price_data: {
        currency: 'usd',
        unit_amount: plan.price * 100, // Stripe usa centavos
        recurring: { interval: 'month' },
        product_data: { name: `Micro-Fleet ${plan.name}` },
      } }],
      trial_period_days: 14,
      metadata: { tenant_id: tenantId, plan: planKey },
    }, { idempotencyKey: `mf-suscripcion-${tenantId}-${planKey}-${paymentMethodId}` });

    // 4. Registro local enlazado por stripe_subscription_id. Si el webhook llegó antes y creó la fila,
    //    no se duplica: el estado lo gobiernan los eventos (orden por event.created).
    await this.db.query(
      `INSERT INTO subscriptions (tenant_id, plan, amount_monthly, status, current_period_start, current_period_end, stripe_subscription_id)
       VALUES ($1, $2, $3, 'TRIALING', NOW(), NOW() + INTERVAL '14 days', $4)
       ON CONFLICT (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL DO NOTHING`,
      [tenantId, planKey, plan.price, subscription.id]);
    await this.db.query(
      `UPDATE tenants SET plan = $1, status = CASE WHEN status = 'ACTIVE' THEN status ELSE 'TRIAL' END,
              max_trucks = $2, max_users = $3, trial_ends_at = NOW() + INTERVAL '14 days', updated_at = now()
       WHERE id = $4`,
      [planKey, plan.trucks, plan.users, tenantId]);

    return { subscriptionId: subscription.id, trialEnds: subscription.trial_end };
  }

  /** Suscripción vigente de la empresa en Stripe (la más reciente no cancelada). */
  async getStripeSubscriptionId(tenantId) {
    const { rows } = await this.db.query(
      `SELECT stripe_subscription_id FROM subscriptions
       WHERE tenant_id = $1 AND stripe_subscription_id IS NOT NULL AND status IN ('ACTIVE','TRIALING','PAST_DUE')
       ORDER BY created_at DESC LIMIT 1`, [tenantId]);
    if (!rows.length) throw Object.assign(new Error('Sin suscripción de Stripe vigente'), { status: 404 });
    return rows[0].stripe_subscription_id;
  }

  /**
   * Cambiar de plan a mitad de mes (upgrade/downgrade).
   * Stripe prorratea automáticamente: solo cobra (o acredita) la diferencia.
   */
  async changePlan(tenantId, newPlanKey) {
    const plan = PLANS[newPlanKey];
    if (!plan) throw Object.assign(new Error('Plan inválido'), { status: 400 });
    const stripeSub = await stripe().subscriptions.retrieve(await this.getStripeSubscriptionId(tenantId));
    await stripe().subscriptions.update(stripeSub.id, {
      items: [{ id: stripeSub.items.data[0].id, price_data: {
        currency: 'usd', unit_amount: plan.price * 100,
        recurring: { interval: 'month' },
        product_data: { name: `Micro-Fleet ${plan.name}` },
      } }],
      proration_behavior: 'create_prorations',
      metadata: { plan: newPlanKey },
    });
    await this.db.query(
      `UPDATE subscriptions SET plan = $1, amount_monthly = $2 WHERE tenant_id = $3 AND stripe_subscription_id = $4`,
      [newPlanKey, plan.price, tenantId, stripeSub.id]);
    await this.db.query(
      `UPDATE tenants SET plan = $1, max_trucks = $2, max_users = $3, updated_at = now() WHERE id = $4`,
      [newPlanKey, plan.trucks, plan.users, tenantId]);
    return { plan: newPlanKey, price: plan.price };
  }

  /**
   * WEBHOOK: aplica un evento YA VERIFICADO y YA ATRIBUIDO a una empresa, dentro de la transacción del
   * llamador (client con app.current_tenant = tenantId). Lanza si algo no cuadra: el llamador deshace
   * TODO y responde con error recuperable para que Stripe reintente.
   * @returns {Promise<{ignorado: boolean, resultado: string}>}
   */
  async aplicarEvento(client, tenantId, evento) {
    const obj = evento.data.object;
    if (TIPOS_SUSCRIPCION.has(evento.type)) return this._eventoSuscripcion(client, tenantId, evento, obj);
    if (TIPOS_PAGO.has(evento.type)) return this._eventoPago(client, tenantId, evento, obj);
    if (TIPOS_PAGO_FALLIDO.has(evento.type)) return this._eventoPagoFallido(client, tenantId, evento, obj);
    return { ignorado: true, resultado: 'tipo_no_gestionado' };
  }

  // ── suscripciones ─────────────────────────────────────────────────────────
  async _eventoSuscripcion(client, tenantId, evento, sub) {
    const subId = idDe(sub.id);
    if (!subId) throw new Error('evento de suscripción sin id de suscripción');
    const estado = evento.type === 'customer.subscription.deleted' ? 'CANCELLED' : ESTADOS_STRIPE[sub.status];
    if (!estado) throw new Error(`estado de suscripción de Stripe desconocido: ${recortar(sub.status, 40)}`);
    const planMeta = sub.metadata && typeof sub.metadata.plan === 'string' && PLANS[sub.metadata.plan] ? sub.metadata.plan : null;
    const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
    const centavos = entero(item && item.price && item.price.unit_amount);
    const fila = await this._asegurarSuscripcion(client, tenantId, subId, { plan: planMeta, centavos });
    const periodo = periodoDeSuscripcion(sub);
    const r = await this._aplicarEstado(client, tenantId, fila, evento, estado, periodo);
    return { ignorado: false, resultado: r.aplicado ? `suscripcion_${estado.toLowerCase()}` : 'suscripcion_evento_anterior' };
  }

  // ── facturas cobradas ─────────────────────────────────────────────────────
  async _eventoPago(client, tenantId, evento, inv) {
    const facturaId = idDe(inv.id);
    if (!facturaId) throw new Error('evento de factura sin id de factura');
    const centavos = entero(inv.amount_paid);
    if (centavos === null || centavos < 0) throw new Error('factura sin amount_paid válido');
    const subId = suscripcionDeFactura(inv);
    const fila = subId ? await this._asegurarSuscripcion(client, tenantId, subId, { plan: null, centavos: null }) : null;

    let resultado = 'factura_sin_importe';
    if (centavos > 0) {
      const pagadoEn = entero(inv.status_transitions && inv.status_transitions.paid_at) ?? evento.created;
      const { rows } = await client.query(
        `INSERT INTO payments (tenant_id, subscription_id, amount, currency, status, stripe_invoice_id, stripe_evento_id, paid_at)
         VALUES ($1, $2, $3::numeric / 100, upper($4), 'SUCCEEDED', $5, $6, to_timestamp($7))
         ON CONFLICT (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL AND status = 'SUCCEEDED'
         DO NOTHING RETURNING id`,
        [tenantId, fila ? fila.id : null, centavos, recortar(inv.currency || 'usd', 3), facturaId, evento.id, pagadoEn]);
      if (rows.length) {
        await this.ledger.asentar(client, {
          tenantId, actor: ACTOR, accion: 'pago.registrado', entidad: 'payment', entidadId: rows[0].id,
          despues: { factura: facturaId, centavos, moneda: String(inv.currency || 'usd').toUpperCase(), suscripcion: subId },
          dedupKey: claveDedup('stripe.pago', facturaId),
        });
        resultado = 'pago_registrado';
      } else {
        resultado = 'pago_ya_registrado';
      }
    }
    // Una factura cobrada con importe deja la suscripción al día; una de 0 (prueba) solo mueve el periodo.
    if (fila) {
      const periodo = { inicio: null, fin: finPeriodoDeFactura(inv) };
      await this._aplicarEstado(client, tenantId, fila, evento, centavos > 0 ? 'ACTIVE' : null, periodo);
    }
    return { ignorado: false, resultado };
  }

  // ── cobros fallidos ───────────────────────────────────────────────────────
  async _eventoPagoFallido(client, tenantId, evento, inv) {
    const facturaId = idDe(inv.id);
    if (!facturaId) throw new Error('evento de factura sin id de factura');
    const centavos = entero(inv.amount_due) ?? 0;
    const subId = suscripcionDeFactura(inv);
    const fila = subId ? await this._asegurarSuscripcion(client, tenantId, subId, { plan: null, centavos: null }) : null;
    // Cada intento fallido es un hecho distinto (event.id distinto); la reentrega del MISMO evento ya
    // la descarta stripe_eventos antes de llegar aquí.
    const { rows } = await client.query(
      `INSERT INTO payments (tenant_id, subscription_id, amount, currency, status, stripe_invoice_id, stripe_evento_id, paid_at)
       VALUES ($1, $2, $3::numeric / 100, upper($4), 'FAILED', $5, $6, NULL) RETURNING id`,
      [tenantId, fila ? fila.id : null, centavos, recortar(inv.currency || 'usd', 3), facturaId, evento.id]);
    await this.ledger.asentar(client, {
      tenantId, actor: ACTOR, accion: 'pago.fallido', entidad: 'payment', entidadId: rows[0].id,
      despues: { factura: facturaId, centavos, intento: entero(inv.attempt_count), suscripcion: subId },
      dedupKey: claveDedup('stripe.evento', evento.id),
    });
    if (fila) await this._aplicarEstado(client, tenantId, fila, evento, 'PAST_DUE', { inicio: null, fin: null });
    return { ignorado: false, resultado: 'pago_fallido_registrado' };
  }

  // Fila local de la suscripción de Stripe, creada si aún no existe, y BLOQUEADA hasta el fin de la
  // transacción (dos eventos de la misma suscripción se aplican uno detrás de otro).
  async _asegurarSuscripcion(client, tenantId, subId, { plan, centavos }) {
    let planFinal = plan;
    if (!planFinal) {
      const { rows: [t] } = await client.query('SELECT plan FROM tenants WHERE id = $1', [tenantId]);
      planFinal = t && PLANS[t.plan] ? t.plan : 'STARTER';
    }
    const importe = centavos !== null && centavos !== undefined ? centavos : PLANS[planFinal].price * 100;
    await client.query(
      `INSERT INTO subscriptions (tenant_id, plan, amount_monthly, status, stripe_subscription_id)
       VALUES ($1, $2, $3::numeric / 100, 'INCOMPLETE', $4)
       ON CONFLICT (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL DO NOTHING`,
      [tenantId, planFinal, importe, subId]);
    const { rows } = await client.query(
      `SELECT id, status, stripe_estado_en FROM subscriptions WHERE stripe_subscription_id = $1 FOR UPDATE`, [subId]);
    // Bajo RLS solo se ven filas de esta empresa: si no aparece, la suscripción es de OTRA empresa.
    if (!rows.length) throw Object.assign(new Error('la suscripción de Stripe pertenece a otra empresa'), { code: 'SUSCRIPCION_DE_OTRA_EMPRESA' });
    return { id: rows[0].id, status: rows[0].status, estadoEn: rows[0].stripe_estado_en === null ? null : Number(rows[0].stripe_estado_en) };
  }

  // Aplica estado (si el evento es posterior al último aplicado) y periodo (siempre hacia adelante).
  async _aplicarEstado(client, tenantId, fila, evento, estado, periodo) {
    const creado = evento.created;
    const posterior = fila.estadoEn === null || creado > fila.estadoEn
      || (creado === fila.estadoEn && estado === 'CANCELLED' && fila.status !== 'CANCELLED');
    const aplica = estado !== null && posterior;
    await client.query(
      `UPDATE subscriptions SET
          status = CASE WHEN $2 THEN $3 ELSE status END,
          stripe_estado_en = CASE WHEN $2 THEN $4::bigint ELSE stripe_estado_en END,
          current_period_start = CASE WHEN $2 AND $5::bigint IS NOT NULL THEN to_timestamp($5) ELSE current_period_start END,
          current_period_end = GREATEST(current_period_end, to_timestamp($6))
       WHERE id = $1`,
      [fila.id, aplica, estado || fila.status, creado, periodo.inicio, periodo.fin]);
    if (!aplica) return { aplicado: false };

    await this.ledger.asentar(client, {
      tenantId, actor: ACTOR, accion: 'suscripcion.estado', entidad: 'subscription', entidadId: fila.id,
      antes: { status: fila.status }, despues: { status: estado, evento: evento.id, creado },
      dedupKey: claveDedup('stripe.estado', evento.id),
    });
    fila.status = estado; fila.estadoEn = creado;

    // Estado de la empresa (lo que mira el gateway). PAST_DUE no lo toca: la gracia la gestiona el cron.
    if (estado === 'ACTIVE') {
      await client.query(
        `UPDATE tenants SET status = 'ACTIVE', updated_at = now()
         WHERE id = $1 AND status IN ('TRIAL', 'SUSPENDED', 'CANCELLED', 'PAST_DUE')`, [tenantId]);
    } else if (estado === 'TRIALING') {
      await client.query(
        `UPDATE tenants SET status = 'TRIAL', updated_at = now()
         WHERE id = $1 AND status IN ('SUSPENDED', 'CANCELLED')`, [tenantId]);
    } else if (estado === 'CANCELLED') {
      await client.query(
        `UPDATE tenants SET status = 'CANCELLED', updated_at = now()
         WHERE id = $1 AND status <> 'CANCELLED'
           AND NOT EXISTS (SELECT 1 FROM subscriptions s
                           WHERE s.tenant_id = $1 AND s.id <> $2 AND s.status IN ('ACTIVE', 'TRIALING', 'PAST_DUE'))`,
        [tenantId, fila.id]);
    }
    return { aplicado: true };
  }

  /** Ingresos mensuales recurrentes (MRR) por plan. */
  async getMRR() {
    const result = await this.db.query(
      `SELECT plan, COUNT(*) AS tenants, SUM(amount_monthly) AS monthly_revenue
       FROM subscriptions WHERE status = 'ACTIVE' GROUP BY plan`);
    return result.rows;
  }
}

BillingService.SQL = SQL;
BillingService.PLANS = PLANS;
BillingService.clienteDeEvento = clienteDeEvento;
BillingService.claveDedup = claveDedup;
module.exports = BillingService;
