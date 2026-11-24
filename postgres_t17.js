'use strict';
// Suite de integración REAL T17 (tras T1–T16, misma BD): webhooks de Twilio bajo RLS (E-025, E-026).
// Recorre el mismo camino que una petición HTTP desde la verificación de firma:
//   exigirFirmaTwilio → crearManejadoresTwilio().sms / .vozDecision → 17 / 38 → servicio de ofertas
//   → funciones SECURITY DEFINER (migración 004) → 46.responderOfertaUnaVez, con el rol runtime (mf_app).
// No ejecuta el parser de Express (no instalado en el entorno de validación): las peticiones llegan
// ya decodificadas, como las entrega express.urlencoded.
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { aplicarEsquema } = require('../../db/esquema');
const candado = require('../../46_distributed_lock');
const sms = require('../../17_sms_emergencia');
const { firmaEsperada, exigirFirmaTwilio } = require('../../server/api/twilio_firma');
const { crearManejadoresTwilio } = require('../../server/api/webhooks');

const adminUrl = process.env.PG_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.error('FALTAN PG_ADMIN_URL y/o DATABASE_URL. La suite exige PostgreSQL real.');
  process.exit(process.env.REQUIRE_PG_TESTS === '1' ? 1 : 2);
}
const admin = new Pool({ connectionString: adminUrl, max: 5 });
const app = new Pool({ connectionString: appUrl, max: 20 });
const results = [];
const TOTAL = 1;

const TOKEN = crypto.randomBytes(16).toString('hex');
const BASE = 'https://api.microfleet.test';

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

function respuesta() {
  return {
    codigo: 200, tipo: null, cuerpo: null,
    status(c) { this.codigo = c; return this; },
    type(t) { this.tipo = t; return this; },
    send(b) { this.cuerpo = b; return this; },
  };
}
// Ejecuta firma + manejador como lo haría Express para POST {ruta} con {params}.
async function peticion(manejador, ruta, params, { firmar = true, middleware = exigirFirmaTwilio({ authToken: TOKEN, baseUrl: BASE }) } = {}) {
  const req = { originalUrl: ruta, url: ruta, body: params, headers: {} };
  if (firmar) req.headers['x-twilio-signature'] = firmaEsperada(TOKEN, BASE + ruta, params);
  const res = respuesta();
  let paso = false;
  middleware(req, res, () => { paso = true; });
  if (paso) await manejador(req, res);
  return { ...res, paso };
}
async function crearTenant(etiqueta, status = 'ACTIVE') {
  const id = crypto.randomUUID();
  await admin.query('INSERT INTO tenants (id,name,slug,status) VALUES ($1,$2,$3,$4)', [id, `Tenant ${etiqueta}`, `${etiqueta.toLowerCase()}-${id.slice(0, 8)}`, status]);
  return id;
}
const chofer = async (tenantId, nombre, phone, activo = true) => (await admin.query(
  'INSERT INTO drivers (tenant_id, full_name, phone, is_active) VALUES ($1,$2,$3,$4) RETURNING id', [tenantId, nombre, phone, activo])).rows[0].id;
const carga = async (tenantId, origen, destino) => (await admin.query(
  `INSERT INTO loads (tenant_id, origin_city, dest_city, rate, status) VALUES ($1,$2,$3,1500,'AVAILABLE') RETURNING id`, [tenantId, origen, destino])).rows[0].id;
async function ofertar(loadId, driverId, tenantId) {
  const r = await candado.asignarCargaUnaVez(app, { loadId, driverId, tenantId });
  assert(r.resultado.asignada, `no se pudo ofertar la carga: ${JSON.stringify(r.resultado)}`);
  return r.resultado.bookingId;
}
const estadoReserva = async (id) => (await admin.query('SELECT status FROM bookings WHERE id=$1', [id])).rows[0].status;
const estadoCarga = async (id) => (await admin.query('SELECT status FROM loads WHERE id=$1', [id])).rows[0].status;

(async () => {
  try {
    const { rows: v } = await admin.query('SHOW server_version');
    console.log(`PostgreSQL real detectado: ${v[0].server_version}`);
    const esquema = await aplicarEsquema(admin);
    console.log(`Esquema aplicado; migraciones nuevas: [${esquema.migraciones.aplicadas.join(',')}]`);

    await test('T17_webhooks_twilio_bajo_RLS', async () => {
      const notificaciones = [];
      const reasignaciones = [];
      const h = crearManejadoresTwilio({
        db: app,
        notificar: async (tenantId, texto) => { notificaciones.push({ tenantId, texto }); },
        autoDispatch: { reasignar: async (b) => { reasignaciones.push(b); }, confirmarTrasSms: async () => {} },
      });
      const tA = await crearTenant('SMSA');
      const tB = await crearTenant('SMSB');
      const tC = await crearTenant('SMSC', 'SUSPENDED');
      const dA1 = await chofer(tA, 'Ana Flota A', '(305) 555-0101');
      const dB1 = await chofer(tB, 'Ana Flota B', '3055550101');      // mismo teléfono en otra empresa
      const dA2 = await chofer(tA, 'Beto', '+1 305 555 0202');
      const dC = await chofer(tC, 'Carla Suspendida', '3055550303');
      await chofer(tA, 'Dario Inactivo', '3055550404', false);

      // a) Precondición de seguridad: sin el resolvedor, el rol runtime no ve choferes (RLS).
      const { rows: [sinCtx] } = await app.query("SELECT count(*)::int AS n FROM drivers WHERE phone LIKE '%555%01%'");
      assert(sinCtx.n === 0, `el rol runtime ve ${sinCtx.n} choferes sin contexto de tenant`);

      // b) Firma: sin firma → 403; firma de otra URL → 403; sin configuración → 503. Nada cambia en la BD.
      const LA1 = await carga(tA, 'Miami', 'Tampa');
      const bA1 = await ofertar(LA1, dA1, tA);
      const sinFirma = await peticion(h.sms, '/webhooks/sms', { From: '+13055550101', Body: '1' }, { firmar: false });
      assert(sinFirma.codigo === 403 && !sinFirma.paso, `sin firma: ${sinFirma.codigo}`);
      const req = { originalUrl: '/webhooks/sms', url: '/webhooks/sms', body: { From: '+13055550101', Body: '1' },
        headers: { 'x-twilio-signature': firmaEsperada(TOKEN, BASE + '/webhooks/otra', { From: '+13055550101', Body: '1' }) } };
      const resOtra = respuesta(); let pasoOtra = false;
      exigirFirmaTwilio({ authToken: TOKEN, baseUrl: BASE })(req, resOtra, () => { pasoOtra = true; });
      assert(resOtra.codigo === 403 && !pasoOtra, 'firma calculada para otra URL fue aceptada');
      const sinConfig = await peticion(h.sms, '/webhooks/sms', { From: '+13055550101', Body: '1' },
        { middleware: exigirFirmaTwilio({ authToken: '', baseUrl: BASE }) });
      assert(sinConfig.codigo === 503 && !sinConfig.paso, `sin token: ${sinConfig.codigo}`);
      assert(await estadoReserva(bA1) === 'OFFERED', 'una petición rechazada modificó la reserva');

      // c) Aceptar por SMS firmado (teléfono en otro formato) → CONFIRMED; reintento de Twilio → sin cambios.
      const ok1 = await peticion(h.sms, '/webhooks/sms', { From: '+13055550101', Body: '1' });
      assert(ok1.codigo === 200 && ok1.tipo === 'text/xml' && /CONFIRMADA/.test(ok1.cuerpo), `aceptar: ${ok1.codigo} ${ok1.cuerpo}`);
      assert(await estadoReserva(bA1) === 'CONFIRMED', 'la reserva no quedó CONFIRMED');
      const reintento = await sms.procesarRespuesta(app, { From: '+13055550101', Body: '1' });
      assert(reintento.estado === 'SIN_OFERTA', `reintento: ${reintento.estado}`);

      // d) 5 entregas simultáneas del mismo SMS → exactamente una confirmación.
      const LA2 = await carga(tA, 'Orlando', 'Jacksonville');
      const bA2 = await ofertar(LA2, dA2, tA);
      const rafaga = await Promise.all(Array.from({ length: 5 }, () => sms.procesarRespuesta(app, { From: '+13055550202', Body: '1' })));
      const confirmadas = rafaga.filter(r => r.estado === 'CONFIRMADA').length;
      assert(confirmadas === 1 && rafaga.every(r => ['CONFIRMADA', 'DUPLICADA', 'SIN_OFERTA'].includes(r.estado)),
        `ráfaga: ${rafaga.map(r => r.estado).join(',')}`);
      assert(await estadoReserva(bA2) === 'CONFIRMED', 'ráfaga: estado final incorrecto');

      // e) Rechazo en la empresa B con el mismo teléfono: libera la carga y se puede reasignar.
      const LB1 = await carga(tB, 'Atlanta', 'Savannah');
      const bB1 = await ofertar(LB1, dB1, tB);
      const rech = await peticion(h.sms, '/webhooks/sms', { From: '+13055550101', Body: '2' });
      assert(/rechazada/.test(rech.cuerpo), `rechazo: ${rech.cuerpo}`);
      assert(await estadoReserva(bB1) === 'REJECTED' && await estadoCarga(LB1) === 'AVAILABLE', 'el rechazo no liberó la carga');
      assert(await estadoReserva(bA1) === 'CONFIRMED', 'el rechazo en B tocó la reserva de A');
      assert(reasignaciones.some(b => b.id === bB1), 'no se pidió reasignar la carga liberada');
      const bB1bis = await ofertar(LB1, dB1, tB);
      assert(bB1bis && bB1bis !== bB1, 'la carga liberada no se pudo volver a ofertar');

      // f) Ofertas pendientes en dos empresas para el mismo teléfono: se responde la más reciente.
      //    Determinista: la oferta ANTIGUA va en la empresa que el resolvedor devuelve primero
      //    (ORDER BY tenant_id), para que «quedarse con la primera» no pase por azar.
      const LA3 = await carga(tA, 'Miami', 'Naples');
      const bA3 = await ofertar(LA3, dA1, tA);
      const { rows: [orden] } = await admin.query('SELECT $1::uuid < $2::uuid AS a_primero', [tA, tB]);
      const [antigua, reciente_] = orden.a_primero ? [bA3, bB1bis] : [bB1bis, bA3];
      await admin.query("UPDATE bookings SET assigned_at = now() - interval '10 minutes' WHERE id=$1", [antigua]);
      await admin.query("UPDATE bookings SET assigned_at = now() WHERE id=$1", [reciente_]);
      const reciente = await sms.procesarRespuesta(app, { From: '3055550101', Body: 'si' });
      assert(reciente.estado === 'CONFIRMADA' && reciente.bookingId === reciente_, `más reciente: ${JSON.stringify(reciente)}`);
      assert(await estadoReserva(antigua) === 'OFFERED', 'se respondió también la oferta antigua');
      const siguiente = await sms.procesarRespuesta(app, { From: '3055550101', Body: '1' });
      assert(siguiente.estado === 'CONFIRMADA' && siguiente.bookingId === antigua, 'la segunda oferta pendiente no se respondió después');

      // g) Respuesta no entendida: instrucción, sin cambios.
      const LA4 = await carga(tA, 'Tampa', 'Ocala');
      const bA4 = await ofertar(LA4, dA2, tA);
      const raro = await sms.procesarRespuesta(app, { From: '+13055550202', Body: 'hola jefe' });
      assert(raro.estado === 'NO_ENTENDIDA' && /1 = aceptar/.test(raro.twiml) && await estadoReserva(bA4) === 'OFFERED', 'respuesta no entendida alteró el estado');

      // h) Empresa suspendida, chofer inactivo, número desconocido e intento de inyección → nada.
      const LC1 = await carga(tC, 'Key West', 'Miami');
      await admin.query(`INSERT INTO bookings (tenant_id, load_id, driver_id, status, assigned_at) VALUES ($1,$2,$3,'OFFERED',now())`, [tC, LC1, dC]);
      for (const From of ['+13055550303', '+13055550404', '+19995550000', "'; DROP TABLE bookings; --"]) {
        const r = await sms.procesarRespuesta(app, { From, Body: '1' });
        assert(r.estado === 'DESCONOCIDO' && !/<Message>/.test(r.twiml), `${From}: ${r.estado}`);
      }

      // i) Voz: rechazo firmado libera la carga; repetición y reserva desconocida → "no disponible".
      const urlVoz = `/webhooks/voz/decision?booking=${bA4}`;
      const voz1 = await peticion(h.vozDecision, urlVoz, { Digits: '2', SpeechResult: '' });
      assert(/Buscando otra carga/.test(voz1.cuerpo), `voz rechazo: ${voz1.cuerpo}`);
      assert(await estadoReserva(bA4) === 'REJECTED' && await estadoCarga(LA4) === 'AVAILABLE', 'voz: el rechazo no liberó la carga');
      const voz2 = await peticion(h.vozDecision, urlVoz, { Digits: '1', SpeechResult: '' });
      assert(/ya no está disponible/.test(voz2.cuerpo) && await estadoReserva(bA4) === 'REJECTED', `voz repetida: ${voz2.cuerpo}`);
      for (const id of [crypto.randomUUID(), 'abc']) {
        const r = await peticion(h.vozDecision, `/webhooks/voz/decision?booking=${id}`, { Digits: '1', SpeechResult: '' });
        assert(/ya no está disponible/.test(r.cuerpo), `voz con reserva ${id}: ${r.cuerpo}`);
      }
      const vozSinFirma = await peticion(h.vozDecision, urlVoz, { Digits: '1' }, { firmar: false });
      assert(vozSinFirma.codigo === 403, 'voz sin firma aceptada');

      // j) Mínimo privilegio del resolvedor.
      const { rows: [p] } = await admin.query(`
        SELECT has_function_privilege('mf_app', 'mf_resolver_chofer_por_telefono(text[])', 'EXECUTE') AS app_tel,
               has_function_privilege('mf_readonly', 'mf_resolver_chofer_por_telefono(text[])', 'EXECUTE') AS ro_tel,
               has_function_privilege('mf_readonly', 'mf_resolver_reserva(uuid)', 'EXECUTE') AS ro_res,
               (SELECT bool_and(prosecdef) FROM pg_proc WHERE proname IN ('mf_resolver_chofer_por_telefono','mf_resolver_reserva')) AS definer,
               (SELECT bool_and(pg_get_userbyid(proowner) = 'mf_resolver') FROM pg_proc WHERE proname IN ('mf_resolver_chofer_por_telefono','mf_resolver_reserva')) AS dueno,
               (SELECT rolbypassrls OR rolsuper OR rolcanlogin FROM pg_roles WHERE rolname='mf_resolver') AS rol_amplio,
               has_table_privilege('mf_resolver', 'drivers', 'UPDATE') AS resolver_update,
               has_column_privilege('mf_resolver', 'drivers', 'email', 'SELECT') AS resolver_email`);
      assert(p.app_tel && !p.ro_tel && !p.ro_res && p.definer && p.dueno && !p.rol_amplio && !p.resolver_update && !p.resolver_email,
        `privilegios del resolvedor: ${JSON.stringify(p)}`);
      const { rows: cols } = await app.query('SELECT * FROM mf_resolver_chofer_por_telefono($1::text[])', [['3055550101']]);
      assert(cols.length === 2 && Object.keys(cols[0]).sort().join(',') === 'driver_id,tenant_id', `el resolvedor expone ${Object.keys(cols[0] || {}).join(',')}`);
      // Solo las peticiones que pasan por el manejador llevan el gancho: aceptación en A (c) y rechazo en B (e).
      assert(notificaciones.length === 2 && notificaciones[0].tenantId === tA && /confirmó/.test(notificaciones[0].texto)
        && notificaciones[1].tenantId === tB && /rechazó/.test(notificaciones[1].texto),
        `notificaciones inesperadas: ${JSON.stringify(notificaciones.map(n => [n.tenantId === tA ? 'A' : n.tenantId === tB ? 'B' : '?', n.texto]))}`);
      return 'firma exigida (403/503, sin efectos); SMS aceptar/rechazar bajo RLS con resolvedor; ráfaga 5→1; rechazo libera y reasigna; mismo teléfono en 2 empresas → la más reciente; suspendida/inactivo/desconocido/inyección ignorados; voz firmada exactamente-una-vez; resolvedor de mínimo privilegio';
    });

    console.log('\nRESULTADO PostgreSQL T17');
    console.table(results);
    console.log(`TOTAL ${results.filter(x => x.status === 'PASS').length}/${TOTAL} PASS`);
    if (results.filter(x => x.status === 'PASS').length !== TOTAL) process.exitCode = 1;
  } catch (e) {
    if (!results.some(r => r.status === 'FAIL')) console.error(`ERROR FUERA DE PRUEBA: ${e.message}`);
    console.error('\nSUITE ABORTADA: no se considera aprobada.');
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([admin.end(), app.end()]);
  }
})();
