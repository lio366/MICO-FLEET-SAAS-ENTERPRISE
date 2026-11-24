'use strict';
// Suite de integración REAL T20 (tras T1–T19, misma BD): webhook de Stripe (E-040).
// Ejecuta el manejador real (server/api/webhooks.js · crearManejadorStripe) con peticiones firmadas
// con el esquema v1 de Stripe, el rol runtime (mf_app) bajo RLS y varias réplicas concurrentes:
//   T20a firma sobre el cuerpo crudo y empresa atribuida SOLO por el cliente de Stripe
//   T20b reentregas concurrentes del mismo evento y dos eventos de la misma factura → un solo pago
//   T20c eventos fuera de orden (cancelación, pagos, fallos, empates)
//   T20d fallo a mitad → nada aplicado, FALLIDO registrado, 500; el reintento aplica una vez
//   T20e eventos no gestionados → IGNORADO, reentrega → 200 sin efectos
//   T20f mora → suspensión por el cron → reactivación por un pago posterior; ledger íntegro
// El administrador solo prepara datos y comprueba resultados. Nunca sustituye PostgreSQL por mocks.
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { aplicarEsquema } = require('../../db/esquema');
const ledger = require('../../42_audit_ledger');
const BillingService = require('../../03_billing_stripe');
const { crearManejadorStripe } = require('../../server/api/webhooks');
const { cabeceraDePrueba } = require('../../server/api/stripe_firma');
const cron = require('../../server/workers/cronWorker');

const adminUrl = process.env.PG_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.error('FALTAN PG_ADMIN_URL y/o DATABASE_URL. La suite exige PostgreSQL real.');
  process.exit(process.env.REQUIRE_PG_TESTS === '1' ? 1 : 2);
}
const admin = new Pool({ connectionString: adminUrl, max: 5 });
const replicas = [0, 1, 2].map(() => new Pool({ connectionString: appUrl, max: 4 }));
const app = replicas[0];
const results = [];
const TOTAL = 6;
const SUF = crypto.randomBytes(4).toString('hex');
const SECRETO = `whsec_t20_${crypto.randomBytes(16).toString('hex')}`;
const SECRETO_ANTERIOR = `whsec_t20_old_${crypto.randomBytes(16).toString('hex')}`;
const BASE = 1_800_000_000; // event.created ficticio y creciente (segundos unix)

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ test: name, status: 'PASS', ms: Date.now() - started, detail: detail || '' });
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (e) {
    results.push({ test: name, status: 'FAIL', ms: Date.now() - started, error: e.message });
    console.error(`FAIL ${name}: ${e.stack || e}`);
    throw e;
  }
}
function assert(ok, message) { if (!ok) throw new Error(message); }

let nEvento = 0;
const idEvento = () => `evt_t20${SUF}_${++nEvento}`;
const evento = (type, created, object, id = idEvento()) => ({
  id, object: 'event', type, created, livemode: false, api_version: '2024-06-20', data: { object } });
const factura = (id, cliente, sub, { pagado = 29900, debido = 29900, finPeriodo = null, extra = {} } = {}) => ({
  id, object: 'invoice', customer: cliente, subscription: sub, amount_paid: pagado, amount_due: debido, currency: 'usd',
  lines: { data: finPeriodo ? [{ period: { start: finPeriodo - 30 * 86400, end: finPeriodo } }] : [] },
  status_transitions: { paid_at: pagado > 0 ? BASE : null }, attempt_count: 1, metadata: {}, ...extra });
const suscripcion = (id, cliente, status, { inicio = BASE, fin = BASE + 30 * 86400, metadata = {} } = {}) => ({
  id, object: 'subscription', customer: cliente, status, current_period_start: inicio, current_period_end: fin,
  items: { data: [{ price: { unit_amount: 29900 } }] }, metadata: { plan: 'STARTER', ...metadata } });

// Petición HTTP equivalente a la que entrega Express tras el parser del gateway (req.rawBody = bytes).
function peticion(ev, { secreto = SECRETO, t = Math.floor(Date.now() / 1000), cuerpo = null, sinCrudo = false, cabecera = null } = {}) {
  const bytes = Buffer.from(cuerpo ?? JSON.stringify(ev), 'utf8');
  const firmado = Buffer.from(JSON.stringify(ev), 'utf8');
  return {
    headers: { 'stripe-signature': cabecera ?? cabeceraDePrueba(firmado, secreto, t) },
    rawBody: sinCrudo ? undefined : bytes,
    body: JSON.parse(bytes.toString('utf8')),
  };
}
function respuesta() {
  return { statusCode: 200, cuerpo: null, status(c) { this.statusCode = c; return this; }, json(b) { this.cuerpo = b; return this; } };
}
const registros = [];
const log = (nivel, ev, datos) => registros.push({ nivel, ev, datos });
const manejadores = replicas.map(p => crearManejadorStripe({ db: p, secretos: [SECRETO], log }));
async function entregar(ev, opciones = {}, manejador = manejadores[0]) {
  const res = respuesta();
  await manejador(peticion(ev, opciones), res);
  return res;
}

async function crearTenant(etiqueta, status = 'ACTIVE') {
  const id = crypto.randomUUID();
  const cliente = `cus_t20${SUF}${etiqueta}`;
  await admin.query('INSERT INTO tenants (id, name, slug, status, plan, stripe_customer_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, `T20 ${etiqueta}`, `t20-${etiqueta.toLowerCase()}-${id.slice(0, 8)}`, status, 'STARTER', cliente]);
  return { id, cliente };
}
const uno = async (sql, p) => (await admin.query(sql, p)).rows[0];
const pagos = (t, estado = 'SUCCEEDED') => uno('SELECT count(*)::int AS n FROM payments WHERE tenant_id=$1 AND status=$2', [t, estado]).then(r => r.n);
const asientos = (t, accion) => uno('SELECT count(*)::int AS n FROM audit_ledger WHERE tenant_id=$1 AND accion=$2', [t, accion]).then(r => r.n);
const sub = (id) => uno('SELECT status, stripe_estado_en::bigint AS en, extract(epoch FROM current_period_end)::bigint AS fin FROM subscriptions WHERE stripe_subscription_id=$1', [id]);
const estadoTenant = (t) => uno('SELECT status FROM tenants WHERE id=$1', [t]).then(r => r.status);
const registroEvento = (id) => uno('SELECT tenant_id, estado, intentos, resultado, ultimo_error FROM stripe_eventos WHERE id=$1', [id]);

(async () => {
  try {
    const { rows: v } = await admin.query('SHOW server_version');
    console.log(`PostgreSQL real detectado: ${v[0].server_version}`);
    const esquema = await aplicarEsquema(admin);
    console.log(`Esquema aplicado; migraciones nuevas: [${esquema.migraciones.aplicadas.join(',')}]`);
    const { rows: [rol] } = await app.query('SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass');
    assert(rol.bypass === false, 'el rol runtime no debe tener BYPASSRLS');

    const A = await crearTenant('A');
    const B = await crearTenant('B');

    await test('T20a_firma_cuerpo_crudo_y_empresa_por_cliente', async () => {
      const ev = evento('invoice.payment_succeeded', BASE + 10,
        factura(`in_t20${SUF}_a1`, A.cliente, `sub_t20${SUF}_a`, { finPeriodo: BASE + 30 * 86400, extra: { metadata: { tenant_id: B.id } } }));
      const rechazos = [];
      rechazos.push(await entregar(ev, { secreto: 'whsec_equivocado' }));
      rechazos.push(await entregar(ev, { cuerpo: JSON.stringify(ev).replace('"amount_paid":29900', '"amount_paid":1') }));
      rechazos.push(await entregar(ev, { t: Math.floor(Date.now() / 1000) - 600 }));
      rechazos.push(await entregar(ev, { sinCrudo: true }));
      rechazos.push(await entregar(ev, { cabecera: 't=abc,v1=zz' }));
      const reCuerpo = respuesta(); // cuerpo re-serializado con otro espaciado: la firma no coincide
      await manejadores[0](peticion(ev, { cuerpo: JSON.stringify(ev, null, 2) }), reCuerpo);
      rechazos.push(reCuerpo);
      assert(rechazos.every(r => r.statusCode === 400), `rechazos de firma: ${rechazos.map(r => r.statusCode).join(',')}`);
      const sinSecreto = respuesta();
      await crearManejadorStripe({ db: app, secretos: [], log })(peticion(ev), sinSecreto);
      assert(sinSecreto.statusCode === 503, `sin secreto: ${sinSecreto.statusCode}`);
      assert(!(await registroEvento(ev.id)), 'una petición rechazada tocó la base de datos');

      // Firma válida: el metadata dice empresa B, el cliente es de A → se aplica a A y solo a A.
      const ok = await entregar(ev);
      assert(ok.statusCode === 200 && ok.cuerpo.resultado === 'pago_registrado', `entrega válida: ${ok.statusCode} ${JSON.stringify(ok.cuerpo)}`);
      assert(await pagos(A.id) === 1 && await pagos(B.id) === 0, 'el pago no quedó solo en la empresa del cliente');
      const reg = await registroEvento(ev.id);
      assert(reg.tenant_id === A.id && reg.estado === 'PROCESADO' && reg.intentos === 1, `registro: ${JSON.stringify(reg)}`);
      assert((await sub(`sub_t20${SUF}_a`)).status === 'ACTIVE', 'la suscripción de A no quedó ACTIVE');

      // Rotación del secreto del endpoint: firma con el secreto anterior, ambos configurados.
      const rot = evento('invoice.payment_succeeded', BASE + 11, factura(`in_t20${SUF}_a2`, A.cliente, `sub_t20${SUF}_a`, { finPeriodo: BASE + 60 * 86400 }));
      const resRot = respuesta();
      await crearManejadorStripe({ db: app, secretos: [SECRETO, SECRETO_ANTERIOR], log })(peticion(rot, { secreto: SECRETO_ANTERIOR }), resRot);
      assert(resRot.statusCode === 200, `rotación de secreto: ${resRot.statusCode}`);

      // Cliente desconocido: tipo gestionado → 503 recuperable; tipo no gestionado → 200 sin efectos.
      const ajeno = await entregar(evento('invoice.payment_succeeded', BASE + 12, factura(`in_t20${SUF}_x`, `cus_t20${SUF}desconocido`, null)));
      assert(ajeno.statusCode === 503, `cliente desconocido (gestionado): ${ajeno.statusCode}`);
      const ajenoIgn = await entregar(evento('customer.updated', BASE + 12, { id: `cus_t20${SUF}desconocido`, object: 'customer' }));
      assert(ajenoIgn.statusCode === 200, `cliente desconocido (no gestionado): ${ajenoIgn.statusCode}`);
      return '7 rechazos sin tocar la BD (incluido cuerpo re-serializado); metadata.tenant_id ignorado; rotación de secreto; cliente desconocido 503/200';
    });

    await test('T20b_reentregas_concurrentes_un_solo_pago', async () => {
      const ev = evento('invoice.payment_succeeded', BASE + 20, factura(`in_t20${SUF}_b1`, A.cliente, `sub_t20${SUF}_a`, { finPeriodo: BASE + 90 * 86400 }));
      const antes = await pagos(A.id);
      const asientosAntes = await asientos(A.id, 'pago.registrado');
      const resp = await Promise.all(Array.from({ length: 9 }, (_, i) => entregar(ev, {}, manejadores[i % 3])));
      assert(resp.every(r => r.statusCode === 200), `códigos: ${resp.map(r => r.statusCode).join(',')}`);
      const nuevos = resp.filter(r => !r.cuerpo.duplicado).length;
      assert(nuevos === 1, `entregas que aplicaron el evento: ${nuevos} (se esperaba 1)`);
      assert(await pagos(A.id) === antes + 1, 'reentregas concurrentes duplicaron el pago');
      assert(await asientos(A.id, 'pago.registrado') === asientosAntes + 1, 'reentregas duplicaron el asiento del ledger');
      const reg = await registroEvento(ev.id);
      assert(reg.estado === 'PROCESADO' && reg.intentos === 1, `registro tras reentregas: ${JSON.stringify(reg)}`);
      // Misma factura, otro evento (invoice.paid): no hay segundo pago ni segundo asiento.
      const paid = evento('invoice.paid', BASE + 21, factura(`in_t20${SUF}_b1`, A.cliente, `sub_t20${SUF}_a`, { finPeriodo: BASE + 90 * 86400 }));
      const r2 = await entregar(paid);
      assert(r2.statusCode === 200 && r2.cuerpo.resultado === 'pago_ya_registrado', `invoice.paid: ${JSON.stringify(r2.cuerpo)}`);
      assert(await pagos(A.id) === antes + 1, 'invoice.paid de la misma factura creó otro pago');
      return '9 entregas en 3 réplicas → 1 aplicada, 8 duplicadas (200); invoice.paid + invoice.payment_succeeded → 1 pago, 1 asiento';
    });

    await test('T20c_eventos_fuera_de_orden', async () => {
      const C = await crearTenant('C');
      const sC = `sub_t20${SUF}_c`;
      const fin1 = BASE + 30 * 86400, fin2 = BASE + 60 * 86400;
      const creada = evento('customer.subscription.created', BASE + 100, suscripcion(sC, C.cliente, 'trialing', { fin: fin1, metadata: { tenant_id: B.id } }));
      const fallo = evento('invoice.payment_failed', BASE + 150, factura(`in_t20${SUF}_c1`, C.cliente, sC, { pagado: 0 }));
      const pago = evento('invoice.payment_succeeded', BASE + 200, factura(`in_t20${SUF}_c2`, C.cliente, sC, { finPeriodo: fin2 }));
      const baja = evento('customer.subscription.deleted', BASE + 300, suscripcion(sC, C.cliente, 'canceled', { fin: fin2 }));
      const empate = evento('customer.subscription.updated', BASE + 300, suscripcion(sC, C.cliente, 'active', { fin: fin2 }));
      // Llegan al revés: baja → pago → fallo → empate → creada.
      for (const ev of [baja, pago, fallo, empate, creada]) {
        const r = await entregar(ev);
        assert(r.statusCode === 200, `${ev.type}: ${r.statusCode} ${JSON.stringify(r.cuerpo)}`);
      }
      const s = await sub(sC);
      assert(s.status === 'CANCELLED' && Number(s.en) === BASE + 300, `suscripción tras desorden: ${JSON.stringify(s)}`);
      assert(Number(s.fin) === fin2, `fin de periodo no monótono: ${s.fin} (esperado ${fin2})`);
      assert(await estadoTenant(C.id) === 'CANCELLED', 'la empresa no quedó CANCELLED');
      assert(await pagos(C.id) === 1 && await pagos(C.id, 'FAILED') === 1, 'el dinero recibido o el intento fallido no quedaron registrados');
      assert(await asientos(C.id, 'suscripcion.estado') === 1, 'un evento antiguo cambió el estado');
      assert(await pagos(B.id) === 0 && await uno('SELECT count(*)::int AS n FROM subscriptions WHERE tenant_id=$1', [B.id]).then(r => r.n) === 0,
        'metadata.tenant_id de la suscripción afectó a otra empresa');

      // Orden inverso de pago/fallo: fallo(100) → pago(200) → fallo tardío(150) ⇒ ACTIVE.
      const D = await crearTenant('D', 'TRIAL');
      const sD = `sub_t20${SUF}_d`;
      const evs = [
        evento('invoice.payment_failed', BASE + 100, factura(`in_t20${SUF}_d1`, D.cliente, sD, { pagado: 0 })),
        evento('invoice.payment_succeeded', BASE + 200, factura(`in_t20${SUF}_d2`, D.cliente, sD, { finPeriodo: fin1 })),
        evento('invoice.payment_failed', BASE + 150, factura(`in_t20${SUF}_d3`, D.cliente, sD, { pagado: 0 })),
      ];
      for (const ev of evs) assert((await entregar(ev)).statusCode === 200, `${ev.type} D`);
      const sd = await sub(sD);
      assert(sd.status === 'ACTIVE' && Number(sd.en) === BASE + 200, `D tras fallo tardío: ${JSON.stringify(sd)}`);
      assert(await estadoTenant(D.id) === 'ACTIVE', 'D no pasó de TRIAL a ACTIVE con el pago');

      // Empate en el mismo segundo en el otro orden: active(500) y luego deleted(500) ⇒ gana la baja.
      const G = await crearTenant('G');
      const sG = `sub_t20${SUF}_g`;
      for (const ev of [evento('customer.subscription.updated', BASE + 500, suscripcion(sG, G.cliente, 'active')),
                        evento('customer.subscription.deleted', BASE + 500, suscripcion(sG, G.cliente, 'canceled'))]) {
        assert((await entregar(ev)).statusCode === 200, `${ev.type} G`);
      }
      assert((await sub(sG)).status === 'CANCELLED' && await estadoTenant(G.id) === 'CANCELLED', 'en empate la baja no prevaleció');
      return 'baja(300) gana a pago(200), fallo(150), empate active(300) y alta(100); empate inverso → baja; periodo monótono; fallo tardío no pisa un pago posterior';
    });

    await test('T20d_fallo_a_mitad_sin_efectos_y_reintento', async () => {
      const E = await crearTenant('E', 'TRIAL');
      const sE = `sub_t20${SUF}_e`;
      let fallar = true;
      const ledgerQueFalla = { ...ledger, asentar: async (c, a) => {
        if (fallar) { fallar = false; throw new Error('fallo inyectado al asentar'); }
        return ledger.asentar(c, a);
      } };
      const conFallo = crearManejadorStripe({ db: app, secretos: [SECRETO], log, billing: new BillingService(app, { ledger: ledgerQueFalla }) });
      const ev = evento('invoice.payment_succeeded', BASE + 400, factura(`in_t20${SUF}_e1`, E.cliente, sE, { finPeriodo: BASE + 30 * 86400 }));
      const r1 = await entregar(ev, {}, conFallo);
      assert(r1.statusCode === 500, `primer intento: ${r1.statusCode}`);
      assert(await pagos(E.id) === 0, 'quedó un pago de un procesamiento fallido');
      assert(!(await sub(sE)), 'quedó la suscripción creada por un procesamiento fallido');
      assert(await estadoTenant(E.id) === 'TRIAL', 'el estado de la empresa cambió en un procesamiento fallido');
      assert((await uno('SELECT count(*)::int AS n FROM audit_ledger WHERE tenant_id=$1', [E.id])).n === 0, 'quedó un asiento de un procesamiento fallido');
      const f = await registroEvento(ev.id);
      assert(f && f.estado === 'FALLIDO' && f.intentos === 1 && /fallo inyectado/.test(f.ultimo_error), `registro de fallo: ${JSON.stringify(f)}`);

      const r2 = await entregar(ev, {}, conFallo); // Stripe reintenta; ya no falla
      assert(r2.statusCode === 200 && !r2.cuerpo.duplicado, `reintento: ${r2.statusCode} ${JSON.stringify(r2.cuerpo)}`);
      const ok = await registroEvento(ev.id);
      assert(ok.estado === 'PROCESADO' && ok.intentos === 2 && ok.ultimo_error === null, `registro tras reintento: ${JSON.stringify(ok)}`);
      assert(await pagos(E.id) === 1 && await estadoTenant(E.id) === 'ACTIVE', 'el reintento no aplicó el evento');
      const r3 = await entregar(ev);
      assert(r3.statusCode === 200 && r3.cuerpo.duplicado === true && await pagos(E.id) === 1, 'la tercera entrega no fue un duplicado sin efectos');
      return '500 sin pago, suscripción, estado ni asiento; FALLIDO intentos=1; reintento → PROCESADO intentos=2; tercera entrega → 200 duplicado';
    });

    await test('T20e_eventos_no_gestionados', async () => {
      const antes = await uno('SELECT count(*)::int AS n FROM audit_ledger WHERE tenant_id=$1', [A.id]);
      const ev = evento('customer.updated', BASE + 500, { id: A.cliente, object: 'customer', metadata: { tenant_id: B.id } });
      const r1 = await entregar(ev);
      const r2 = await entregar(ev);
      assert(r1.statusCode === 200 && r2.statusCode === 200 && r2.cuerpo.duplicado === true, `ignorado: ${JSON.stringify([r1.cuerpo, r2.cuerpo])}`);
      const reg = await registroEvento(ev.id);
      assert(reg.estado === 'IGNORADO' && reg.tenant_id === A.id, `registro: ${JSON.stringify(reg)}`);
      const despues = await uno('SELECT count(*)::int AS n FROM audit_ledger WHERE tenant_id=$1', [A.id]);
      assert(despues.n === antes.n, 'un evento ignorado escribió en el ledger');
      return 'IGNORADO en la empresa del cliente; reentrega 200 duplicado; sin asientos';
    });

    await test('T20f_mora_suspension_reactivacion_y_ledger', async () => {
      const F = await crearTenant('F');
      const sF = `sub_t20${SUF}_f`;
      assert((await entregar(evento('invoice.payment_succeeded', BASE + 600,
        factura(`in_t20${SUF}_f1`, F.cliente, sF, { finPeriodo: BASE + 30 * 86400 })))).statusCode === 200, 'pago inicial F');
      assert((await entregar(evento('invoice.payment_failed', BASE + 700,
        factura(`in_t20${SUF}_f2`, F.cliente, sF, { pagado: 0 })))).statusCode === 200, 'fallo F');
      assert((await sub(sF)).status === 'PAST_DUE' && await estadoTenant(F.id) === 'ACTIVE', 'fallo: PAST_DUE con la empresa aún activa (gracia)');
      // El periodo pagado venció hace más de 7 días (BASE es futuro: se fija en el pasado para la prueba).
      await admin.query("UPDATE subscriptions SET current_period_end = now() - interval '8 days' WHERE stripe_subscription_id=$1", [sF]);
      const avisos = [];
      const tarea = cron.TAREAS.find(t => t.nombre === 'suspender_morosos');
      await cron.ejecutarTarea(app, tarea, { notificaciones: { alAdmin: async (t) => { avisos.push(t); } } }, new Date(Date.UTC(2031, 0, 1, 8)));
      assert(await estadoTenant(F.id) === 'SUSPENDED', 'el cron no suspendió a la empresa morosa');
      assert((await entregar(evento('invoice.payment_succeeded', BASE + 800,
        factura(`in_t20${SUF}_f3`, F.cliente, sF, { finPeriodo: BASE + 60 * 86400 })))).statusCode === 200, 'pago de regularización F');
      assert((await sub(sF)).status === 'ACTIVE' && await estadoTenant(F.id) === 'ACTIVE', 'el pago posterior no reactivó a la empresa');
      for (const t of [A.id, B.id, F.id]) {
        const r = await ledger.verificarIntegridad(app, t);
        assert(r.ok, `ledger de ${t} roto: ${JSON.stringify(r)}`);
      }
      return 'PAST_DUE (empresa activa) → cron SUSPENDED → pago posterior ACTIVE; cadenas del ledger íntegras';
    });
  } catch (e) {
    if (!results.length) console.error(`FAIL T20_preparacion: ${e.stack || e}`);
  } finally {
    console.log(JSON.stringify({ suite: 'T20', results }, null, 2));
    console.log(`TOTAL ${results.filter(x => x.status === 'PASS').length}/${TOTAL} PASS`);
    if (results.filter(x => x.status === 'PASS').length !== TOTAL) process.exitCode = 1;
    await Promise.allSettled([admin.end(), ...replicas.map(p => p.end())]);
  }
})();
