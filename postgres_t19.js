'use strict';
// Suite de integración REAL T19 (tras T1–T18, misma BD): workers multiempresa bajo RLS (E-031).
//   - Bus de eventos (44): 3 réplicas concurrentes, cada evento una vez por suscriptor y en el contexto
//     de su empresa; reintentos con consumos idempotentes; cola de fallidos; suscriptores reales.
//   - Notificaciones (45): destinatario 'driver:<uuid>', alertas del sistema, historial por empresa.
//   - Cron (cronWorker): una ejecución por tarea y hora con 6 llamadas concurrentes; tareas reales.
//   - Agente de match (agentWorker): solo el líder, nunca entre empresas, una notificación por par.
// Todo con el rol runtime (mf_app); el administrador solo prepara datos y comprueba resultados.
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { aplicarEsquema } = require('../../db/esquema');
const { enTenant } = require('../../server/http/contexto_tenant');
const bus = require('../../44_event_bus');
const ledger = require('../../42_audit_ledger');
const { crearServicioNotificaciones } = require('../../45_notification_service');
const cron = require('../../server/workers/cronWorker');
const { crearAdaptadorAgentes } = require('../../server/workers/agentWorker');
const match = require('../../29_match_tiempo_real');

const adminUrl = process.env.PG_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.error('FALTAN PG_ADMIN_URL y/o DATABASE_URL. La suite exige PostgreSQL real.');
  process.exit(process.env.REQUIRE_PG_TESTS === '1' ? 1 : 2);
}
const admin = new Pool({ connectionString: adminUrl, max: 5 });
const app = new Pool({ connectionString: appUrl, max: 6 });
const replicas = [0, 1, 2].map(() => new Pool({ connectionString: appUrl, max: 3 }));
const results = [];
const TOTAL = 4;
const SUF = crypto.randomBytes(3).toString('hex');

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
async function crearTenant(etiqueta, status = 'ACTIVE') {
  const id = crypto.randomUUID();
  await admin.query('INSERT INTO tenants (id, name, slug, status) VALUES ($1,$2,$3,$4)', [id, `T19 ${etiqueta}`, `t19-${etiqueta.toLowerCase()}-${id.slice(0, 8)}`, status]);
  return id;
}
const chofer = async (t, n) => (await admin.query('INSERT INTO drivers (tenant_id, full_name, phone) VALUES ($1,$2,$3) RETURNING id', [t, n, '3055551000'])).rows[0].id;
const publicar = (tenantId, tipo, payload) => enTenant(app, tenantId, (c) => bus.publicar(null, c, { tenantId, tipo, payload }));
const idsEventos = async (tipo) => (await admin.query('SELECT id FROM outbox WHERE tipo=$1 ORDER BY id', [tipo])).rows.map(r => String(r.id));
const liberarLeases = (tipo) => admin.query('UPDATE outbox SET reclamado_hasta=NULL WHERE tipo=$1 AND publicado_en IS NULL AND fallido_en IS NULL', [tipo]);
async function rondas(pools, tipo, maxRondas = 20) {
  for (let i = 0; i < maxRondas; i++) {
    await Promise.all(pools.map(p => bus.procesarPendientes(p, 10)));
    const { rows: [r] } = await admin.query('SELECT count(*)::int AS n FROM outbox WHERE tipo=$1 AND publicado_en IS NULL AND fallido_en IS NULL', [tipo]);
    if (r.n === 0) return i + 1;
    await liberarLeases(tipo); // simula el paso del tiempo de espera entre reintentos
  }
  throw new Error(`eventos ${tipo} siguen pendientes tras ${maxRondas} rondas`);
}
function twilioFalso() {
  const enviados = [];
  return { enviados, messages: { create: async (m) => { enviados.push(m); return { sid: 'SM' + enviados.length }; } } };
}

(async () => {
  try {
    const { rows: v } = await admin.query('SHOW server_version');
    console.log(`PostgreSQL real detectado: ${v[0].server_version}`);
    const esquema = await aplicarEsquema(admin);
    console.log(`Esquema aplicado; migraciones nuevas: [${esquema.migraciones.aplicadas.join(',')}]`);
    const A = await crearTenant('A');
    const B = await crearTenant('B');
    const dA1 = await chofer(A, 'A uno');
    const dB1 = await chofer(B, 'B uno');
    await chofer(B, 'B dos');

    await test('T19a_bus_exactamente_una_vez_por_empresa_con_3_replicas', async () => {
      const tipo = `t19.base.${SUF}`;
      const vistos = new Map(); // evento → [{tenant, choferesVisibles}]
      bus.suscribir(tipo, 'registro', async (ev, ctx) => {
        const { rows: [r] } = await ctx.db.query('SELECT count(*)::int AS n FROM drivers');
        const lista = vistos.get(String(ev.id)) || [];
        lista.push({ tenant: ev.tenant_id, ctxTenant: ctx.tenantId, choferes: r.n });
        vistos.set(String(ev.id), lista);
      });
      for (let i = 0; i < 15; i++) { await publicar(A, tipo, { i }); await publicar(B, tipo, { i }); }
      const ids = await idsEventos(tipo);
      const n = await rondas(replicas, tipo);
      assert(ids.length === 30, `se esperaban 30 eventos, hay ${ids.length}`);
      for (const id of ids) {
        const l = vistos.get(id) || [];
        assert(l.length === 1, `evento ${id} procesado ${l.length} veces`);
        const esperado = l[0].tenant === A ? 1 : 2;
        assert(l[0].ctxTenant === l[0].tenant && l[0].choferes === esperado, `evento ${id}: contexto ${JSON.stringify(l[0])}`);
      }
      const { rows: [p] } = await admin.query('SELECT count(*)::int AS n FROM outbox WHERE tipo=$1 AND publicado_en IS NOT NULL', [tipo]);
      assert(p.n === 30, `publicados ${p.n}/30`);
      // Carrera determinista: una réplica tiene bloqueados los eventos pendientes (a mitad de reclamar);
      // otra réplica debe SALTÁRSELOS al instante (SKIP LOCKED), no esperar ni reclamarlos después.
      const tipoL = `t19.lock.${SUF}`;
      for (let i = 0; i < 3; i++) await publicar(A, tipoL, { i });
      const ocupada = await app.connect();
      try {
        await ocupada.query('BEGIN');
        await ocupada.query("SELECT set_config('app.current_tenant', $1, true)", [A]);
        await ocupada.query('SELECT id FROM outbox WHERE tipo=$1 AND publicado_en IS NULL FOR UPDATE', [tipoL]);
        const inicio = Date.now();
        const tomados = await Promise.race([
          bus.reclamarEventos(replicas[0], A, 50),
          new Promise((_, rej) => setTimeout(() => rej(new Error('la reclamación esperó un candado ajeno (sin SKIP LOCKED)')), 2000)),
        ]);
        const propios = tomados.filter(e => e.tipo === tipoL);
        assert(propios.length === 0, `otra réplica reclamó ${propios.length} eventos bloqueados por una reclamación en curso`);
        assert(Date.now() - inicio < 2000, 'la reclamación no fue inmediata');
        // Los eventos ajenos reclamados en esa llamada se devuelven a la cola para no alterar el resto.
        if (tomados.length) await admin.query('UPDATE outbox SET reclamado_hasta=NULL, intentos=intentos-1 WHERE id = ANY($1)', [tomados.map(e => e.id)]);
      } finally {
        await ocupada.query('ROLLBACK').catch(() => {});
        ocupada.release();
      }
      await rondas(replicas, tipoL);
      return `30 eventos de 2 empresas, 3 réplicas concurrentes, ${n} ronda(s): 1 ejecución por evento, contexto RLS correcto en cada manejador; eventos bloqueados por otra réplica se saltan al instante`;
    });

    await test('T19b_reintentos_idempotentes_y_cola_de_fallidos', async () => {
      const tipoR = `t19.reintento.${SUF}`;
      let ok = 0; let flaky = 0;
      bus.suscribir(tipoR, 'siempre_ok', async () => { ok++; });
      bus.suscribir(tipoR, 'inestable', async () => { flaky++; if (flaky < 3) throw new Error(`fallo transitorio ${flaky}`); });
      await publicar(A, tipoR, { x: 1 });
      await rondas([app], tipoR);
      const { rows: [e] } = await admin.query('SELECT intentos, publicado_en IS NOT NULL AS pub, ultimo_error, fallido_en FROM outbox WHERE tipo=$1', [tipoR]);
      assert(ok === 1 && flaky === 3, `suscriptor estable ${ok} veces, inestable ${flaky} veces`);
      assert(e.pub && e.intentos === 3 && e.ultimo_error === null && e.fallido_en === null, `evento tras reintentos: ${JSON.stringify(e)}`);

      const tipoF = `t19.fallido.${SUF}`;
      let llamadas = 0;
      bus.suscribir(tipoF, 'roto', async () => { llamadas++; throw new Error('dependencia caída'); });
      await publicar(B, tipoF, { x: 2 });
      for (let i = 0; i < bus.MAX_INTENTOS + 3; i++) { await bus.procesarPendientes(app, 10); await liberarLeases(tipoF); }
      const { rows: [f] } = await admin.query('SELECT intentos, publicado_en, fallido_en IS NOT NULL AS fallido, ultimo_error FROM outbox WHERE tipo=$1', [tipoF]);
      assert(f.fallido && f.publicado_en === null && f.intentos === bus.MAX_INTENTOS && llamadas === bus.MAX_INTENTOS && /dependencia caída/.test(f.ultimo_error),
        `cola de fallidos: ${JSON.stringify(f)}; llamadas=${llamadas}`);
      return `fallo transitorio: reintento sin repetir el suscriptor que ya funcionó; fallo permanente: ${bus.MAX_INTENTOS} intentos → cola de fallidos`;
    });

    await test('T19c_suscriptores_reales_y_notificaciones_multiempresa', async () => {
      const tw = twilioFalso(); const push = [];
      const notificaciones = crearServicioNotificaciones({ db: app, twilio: tw, pushSender: async (token, texto) => { push.push({ token, texto }); }, emailSender: async () => {} });
      bus.registrarSuscripciones({ db: app, notificaciones, ledger, autoDispatch: {} });
      // Reserva CONFIRMED en A para el despachador; evento de seguro vencido; pago registrado.
      const { rows: [L] } = await admin.query(`INSERT INTO loads (tenant_id, origin_city, dest_city, rate, status) VALUES ($1,'Miami','Tampa',900,'OFFERED') RETURNING id`, [A]);
      const { rows: [bk] } = await admin.query(`INSERT INTO bookings (tenant_id, load_id, driver_id, status) VALUES ($1,$2,$3,'CONFIRMED') RETURNING id`, [A, L.id, dA1]);
      await publicar(A, 'carga.aceptada', { bookingId: bk.id, actor: 'chofer' });
      await publicar(A, 'seguro.vencido', { driverId: dA1, nombre: 'A uno' });
      const pagoId = crypto.randomUUID();
      await publicar(A, 'pago.registrado', { paymentId: pagoId, monto: 900, driverId: dA1 });
      for (let i = 0; i < 6; i++) { await bus.procesarPendientes(app, 50); await admin.query("UPDATE outbox SET reclamado_hasta=NULL WHERE publicado_en IS NULL AND fallido_en IS NULL"); }
      const { rows: pend } = await admin.query(
        `SELECT tipo, intentos, fallido_en IS NOT NULL AS fallido, ultimo_error FROM outbox
         WHERE tenant_id=$1 AND tipo IN ('carga.aceptada','seguro.vencido','pago.registrado') AND publicado_en IS NULL`, [A]);
      assert(pend.length === 0, `eventos reales sin publicar: ${JSON.stringify(pend)}`);
      const { rows: [st] } = await admin.query(
        `SELECT (SELECT status FROM bookings WHERE id=$1) AS reserva,
                (SELECT status FROM drivers WHERE id=$2) AS chofer_a, (SELECT notes FROM drivers WHERE id=$2) AS notas,
                (SELECT count(*)::int FROM drivers WHERE tenant_id=$3 AND status='PAUSED') AS pausados_b,
                (SELECT count(*)::int FROM audit_ledger WHERE tenant_id=$4 AND accion='carga.aceptada' AND entidad_id=$1::text) AS asiento_aceptada,
                (SELECT count(*)::int FROM audit_ledger WHERE tenant_id=$4 AND accion='pago.registrado' AND entidad_id=$5) AS asiento_pago`,
        [bk.id, dA1, B, A, pagoId]);
      assert(st.reserva === 'EN_CURSO', `despachador: reserva ${st.reserva}`);
      assert(st.chofer_a === 'PAUSED' && /Seguro vencido/.test(st.notas) && st.pausados_b === 0, `seguridad: ${JSON.stringify(st)}`);
      assert(st.asiento_aceptada === 1 && st.asiento_pago === 1, `auditor (ledger): ${JSON.stringify(st)}`);
      const { rows: notif } = await admin.query(
        `SELECT tenant_id, destinatario, canal, tipo FROM notificaciones_enviadas WHERE tenant_id=$1 ORDER BY id`, [A]);
      assert(notif.some(n => n.destinatario === `driver:${dA1}` && n.tipo === 'PAGO_DEPOSITADO'), `notificación al chofer no registrada: ${JSON.stringify(notif)}`);
      assert(notif.some(n => n.destinatario === 'admin' && n.tipo === 'ALERTA_SEGURIDAD'), 'alerta de seguridad al admin no registrada');
      const envios = push.length + tw.enviados.length;
      assert(envios === 2, `se esperaban 2 envíos (pago al chofer + alerta al admin), hubo ${envios}`);
      // Alerta del sistema (sin empresa): se registra pero el rol runtime no puede leerla.
      await notificaciones.alAdmin(null, { tipo: 'ALERTA_SISTEMA', datos: { texto: `sistema ${SUF}` } });
      const { rows: [sis] } = await admin.query(`SELECT count(*)::int AS n FROM notificaciones_enviadas WHERE tenant_id IS NULL AND texto LIKE $1`, [`%sistema ${SUF}%`]);
      const { rows: [vis] } = await app.query('SELECT count(*)::int AS n FROM notificaciones_enviadas WHERE tenant_id IS NULL');
      assert(sis.n === 1 && vis.n === 0, `alerta del sistema: registrada=${sis.n}, visible al runtime=${vis.n}`);
      const hist = await notificaciones.historial(B, 'admin');
      assert(hist.every(h => h.tenant_id === B), 'historial de B incluye notificaciones de otra empresa');
      return 'despachador EN_CURSO, seguridad pausa solo en A, auditor escribe 2 asientos en el ledger, notificaciones "driver:<uuid>" y admin registradas, 2 envíos; alerta del sistema sin empresa no legible por el runtime';
    });

    await test('T19d_cron_una_vez_por_hora_y_agente_sin_cruces', async () => {
      // Cron: 6 llamadas concurrentes (3 réplicas) en la misma hora → 1 ejecución; otra hora → otra.
      let corridas = 0;
      const tarea = { nombre: `t19_${SUF}`, fn: async () => { corridas++; return { ok: true }; } };
      const ahora = new Date();
      const r1 = await Promise.all(Array.from({ length: 6 }, (_, i) => cron.ejecutarTarea(replicas[i % 3], tarea, {}, ahora)));
      assert(corridas === 1 && r1.filter(r => r.ejecutada).length === 1, `misma hora: ${corridas} ejecuciones`);
      await cron.ejecutarTarea(app, tarea, {}, new Date(ahora.getTime() + 3600000));
      assert(corridas === 2, 'la hora siguiente no ejecutó la tarea');
      const falla = { nombre: `t19_falla_${SUF}`, fn: async () => { throw new Error('tarea rota'); } };
      const rf = await cron.ejecutarTarea(app, falla, {}, ahora);
      const rf2 = await cron.ejecutarTarea(app, falla, {}, ahora);
      const { rows: [ce] } = await admin.query('SELECT error FROM cron_ejecuciones WHERE tarea=$1', [falla.nombre]);
      assert(rf.error === 'tarea rota' && !rf2.ejecutada && ce.error === 'tarea rota', 'error de tarea no registrado o repetido');

      // Tareas reales.
      const tw = twilioFalso();
      const notificaciones = crearServicioNotificaciones({ db: app, twilio: tw, pushSender: async () => {}, emailSender: async () => {} });
      const deps = { notificaciones };
      const porNombre = (n) => cron.TAREAS.find(t => t.nombre === n);
      const M = await crearTenant('MOROSO'); const N = await crearTenant('GRACIA'); const O = await crearTenant('ALDIA');
      for (const [t, st, dias] of [[M, 'PAST_DUE', 10], [N, 'PAST_DUE', 2], [O, 'ACTIVE', -20]]) {
        await admin.query(`INSERT INTO subscriptions (tenant_id, plan, amount_monthly, status, current_period_end) VALUES ($1,'PRO',799,$2, now() - make_interval(days => $3))`, [t, st, dias]);
      }
      const rs = await cron.ejecutarTarea(app, porNombre('suspender_morosos'), deps, ahora);
      const { rows: estados } = await admin.query('SELECT id, status FROM tenants WHERE id = ANY($1)', [[M, N, O]]);
      const est = Object.fromEntries(estados.map(e => [e.id, e.status]));
      assert(rs.resultado.suspendidas === 1 && est[M] === 'SUSPENDED' && est[N] === 'ACTIVE' && est[O] === 'ACTIVE', `morosos: ${JSON.stringify(est)}`);
      const { rows: [aviso] } = await admin.query(`SELECT count(*)::int AS n FROM notificaciones_enviadas WHERE tenant_id=$1 AND texto LIKE '%suspendida por mora%'`, [M]);
      assert(aviso.n >= 1, 'el administrador de la empresa suspendida no recibió aviso');

      for (const t of [A, B, null]) {
        await admin.query(`INSERT INTO notificaciones_enviadas (tenant_id, destinatario, canal, tipo, texto, creado_en) VALUES
          ($1,'admin','sms','ALERTA_SISTEMA','vieja', now() - interval '100 days'), ($1,'admin','sms','ALERTA_SISTEMA','reciente', now())`, [t]);
      }
      const rl = await cron.ejecutarTarea(app, porNombre('limpieza_semanal'), deps, ahora);
      const { rows: [quedan] } = await admin.query(`SELECT count(*) FILTER (WHERE texto='vieja')::int AS viejas, count(*) FILTER (WHERE texto='reciente')::int AS recientes FROM notificaciones_enviadas`);
      assert(quedan.viejas === 0 && quedan.recientes === 3 && rl.resultado.borradas_sistema >= 1 && rl.resultado.borradas_empresas >= 2,
        `limpieza: ${JSON.stringify({ quedan, resultado: rl.resultado })}`);

      const rv = await cron.ejecutarTarea(app, porNombre('verificar_integridad_ledger'), deps, ahora);
      const { rows: [nt] } = await admin.query('SELECT count(*)::int AS n FROM tenants');
      assert(rv.resultado.empresas === nt.n && rv.resultado.rotas.length === 0, `integridad: ${JSON.stringify(rv.resultado)}`);
      const rr = await cron.ejecutarTarea(app, porNombre('reporte_semanal'), deps, ahora);
      const { rows: [resumenA] } = await admin.query(`SELECT count(*)::int AS n FROM notificaciones_enviadas WHERE tenant_id=$1 AND texto LIKE 'Resumen semanal:%'`, [A]);
      assert(rr.resultado.enviados >= 2 && resumenA.n === 1, `reporte semanal: ${JSON.stringify(rr.resultado)}`);

      // Agente: cargas recientes y choferes disponibles en A y B.
      const cargaA = (await admin.query(`INSERT INTO loads (tenant_id, origin_city, dest_city, rate, status) VALUES ($1,'Orlando','Miami',1200,'AVAILABLE') RETURNING id`, [A])).rows[0].id;
      const cargaB = (await admin.query(`INSERT INTO loads (tenant_id, origin_city, dest_city, rate, status) VALUES ($1,'Dallas','Austin',800,'AVAILABLE') RETURNING id`, [B])).rows[0].id;
      await admin.query("UPDATE drivers SET status='AVAILABLE', notes=NULL WHERE id=$1", [dA1]);
      const avisos = [];
      const notifFalsa = { alChofer: async (tenantId, driverId, msg) => { avisos.push({ tenantId, driverId, msg }); return { entregado: true }; } };
      let lider = false;
      const ag = crearAdaptadorAgentes(app, { notificaciones: notifFalsa, esLider: () => lider, puntuar: async (c) => (c.pago >= 1000 ? 0.9 : 0.5) });
      assert((await ag.buscarCargas()).length === 0, 'un nodo que no es líder buscó cargas');
      lider = true;
      const ciclo = async () => {
        const todas = await ag.buscarCargas();
        const empresasConCargas = new Set(todas.map(c => c.tenant_id));
        const cargas = todas.filter(c => [cargaA, cargaB].includes(c.id));
        const camiones = await ag.buscarCamiones();
        assert(camiones.length > 0 && camiones.every(t => empresasConCargas.has(t.tenant_id)),
          'buscarCamiones devolvió choferes de empresas sin cargas en el ciclo');
        for (const c of cargas) for (const t of camiones) {
          const m = await ag.hacerMatch(c, t);
          if (m) await match.notificarAlInstante(m, ag);
        }
        return { cargas, camiones };
      };
      const { cargas, camiones } = await ciclo();
      assert(cargas.length === 2, 'cargas recientes no encontradas');
      const cargaDeA = cargas.find(c => c.id === cargaA); const camionDeB = camiones.find(t => t.tenant_id === B);
      assert((await ag.hacerMatch(cargaDeA, camionDeB)) === null, 'match entre empresas');
      assert(avisos.length >= 1 && avisos.every(a => a.tenantId === A), `avisos: ${JSON.stringify(avisos.map(a => a.tenantId === A ? 'A' : 'B'))}`);
      const antes = avisos.length;
      await ciclo();
      assert(avisos.length === antes, 'el segundo ciclo volvió a notificar los mismos pares');
      const { rows: [mn] } = await admin.query('SELECT count(*)::int AS n FROM match_notificaciones WHERE load_id=$1', [cargaA]);
      assert(mn.n === antes, `match_notificaciones=${mn.n}, avisos=${antes}`);
      const agDefecto = crearAdaptadorAgentes(app, { notificaciones: notifFalsa, esLider: () => true });
      assert((await agDefecto.hacerMatch(cargaDeA, camiones.find(t => t.tenant_id === A))) === null, 'sin motor neural disponible hubo match');

      // Higiene: ninguna conexión conserva contexto.
      const cs = await Promise.all(Array.from({ length: 6 }, () => app.connect()));
      try { for (const c of cs) { const { rows: [x] } = await c.query("SELECT coalesce(current_setting('app.current_tenant', true), '') AS t"); assert(x.t === '', 'contexto residual'); } }
      finally { cs.forEach(c => c.release()); }
      return `cron 6→1 por hora y error registrado; morosos con gracia de 7 días; limpieza 90 días (empresas y sistema); ledger ${nt.n} empresas sin roturas; reporte semanal; agente: solo líder, sin cruces, ${antes} aviso(s) sin repetición, puntuador ausente → sin ofertas`;
    });

    console.log('\nRESULTADO PostgreSQL T19');
    console.table(results);
    console.log(`TOTAL ${results.filter(x => x.status === 'PASS').length}/${TOTAL} PASS`);
    if (results.filter(x => x.status === 'PASS').length !== TOTAL) process.exitCode = 1;
  } catch (e) {
    if (!results.some(r => r.status === 'FAIL')) console.error(`ERROR FUERA DE PRUEBA: ${e.message}`);
    console.error('\nSUITE ABORTADA: no se considera aprobada.');
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([admin.end(), app.end(), ...replicas.map(p => p.end())]);
  }
})();
