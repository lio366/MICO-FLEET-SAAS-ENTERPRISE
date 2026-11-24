'use strict';
// Suite de integración REAL T14–T16 (se ejecuta después de T1–T13 sobre la misma BD).
//   T14 operaciones exactamente-una-vez sobre el esquema v7 (E-022): asignar, despachar,
//       facturar y cobrar con 10 procesos concurrentes, RLS por tenant y verdad final en índices.
//   T15 rotación de claves de checkpoint (E-016): llavero por firma_kid, gate DR con claves
//       antigua y nueva, rechazo de clave retirada y de kid manipulado.
//   T16 migraciones reversibles en PostgreSQL: orden inverso obligatorio, rollbacks con pérdida
//       bloqueados sobre la BD poblada y ciclo completo down→up sobre una BD nueva.
// Nunca sustituye PostgreSQL por mocks/SQLite.
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { aplicarEsquema } = require('../../db/esquema');
const migrador = require('../../db/migrador');
const ledger = require('../../42_audit_ledger');
const candado = require('../../46_distributed_lock');

const adminUrl = process.env.PG_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.error('FALTAN PG_ADMIN_URL y/o DATABASE_URL. La suite exige PostgreSQL real.');
  process.exit(process.env.REQUIRE_PG_TESTS === '1' ? 1 : 2);
}

const admin = new Pool({ connectionString: adminUrl, max: 5 });
const app = new Pool({ connectionString: appUrl, max: 20 });
const results = [];
const TOTAL = 3;

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
async function crearTenant(etiqueta) {
  const id = crypto.randomUUID();
  await admin.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [id, `Tenant ${etiqueta}`, `${etiqueta.toLowerCase()}-${id.slice(0, 8)}`]);
  return id;
}
async function comoTenant(tenantId, fn) {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
const diez = (fn) => Promise.all(Array.from({ length: 10 }, (_, i) => fn(i)));
const pemPublica = (privada) => crypto.createPublicKey(privada).export({ type: 'spki', format: 'pem' });
const nuevaPrivada = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });

(async () => {
  try {
    const { rows: v } = await admin.query('SHOW server_version');
    console.log(`PostgreSQL real detectado: ${v[0].server_version}`);
    const { rows: pre } = await admin.query("SELECT to_regclass('public.audit_ledger') IS NOT NULL AS ok");
    if (!pre[0].ok) throw new Error('PRECONDICION: ejecutar T1–T13 antes sobre esta BD');

    // Secuencia única de esquema (la misma del bootstrap y del arranque) sobre la BD existente.
    const esquema = await aplicarEsquema(admin);
    const estado = await migrador.estado(admin);
    const pendientes = estado.filter(m => !m.aplicada);
    if (pendientes.length) throw new Error(`PRECONDICION: migraciones sin aplicar: ${pendientes.map(m => m.id).join(',')}`);
    console.log(`Esquema aplicado; migraciones nuevas: [${esquema.migraciones.aplicadas.join(',')}]; vigentes: [${estado.map(m => m.id).join(',')}]`);

    await test('T14_operaciones_exactamente_una_vez_v7', async () => {
      const tX = await crearTenant('OPX');
      const tY = await crearTenant('OPY');
      const { rows: [dX] } = await admin.query('INSERT INTO drivers (tenant_id, full_name) VALUES ($1,$2) RETURNING id', [tX, 'Chofer X']);
      const { rows: [dY] } = await admin.query('INSERT INTO drivers (tenant_id, full_name) VALUES ($1,$2) RETURNING id', [tY, 'Chofer Y']);
      const nuevaCarga = async (rate) => (await admin.query(
        `INSERT INTO loads (tenant_id, origin_city, dest_city, rate, status) VALUES ($1,'Miami','Atlanta',$2,'AVAILABLE') RETURNING id`, [tX, rate])).rows[0].id;
      const L1 = await nuevaCarga(2500);
      const L2 = await nuevaCarga(1800);

      // a) Aislamiento: chofer de otra empresa y carga de otra empresa.
      const ajeno = await candado.asignarCargaUnaVez(app, { loadId: L1, driverId: dY.id, tenantId: tX });
      assert(ajeno.resultado.asignada === false, 'se asignó un chofer de otra empresa');
      const cargaAjena = await candado.asignarCargaUnaVez(app, { loadId: L1, driverId: dY.id, tenantId: tY });
      assert(cargaAjena.resultado.asignada === false, 'un tenant asignó una carga de otro tenant');

      // b) Asignación: 10 procesos concurrentes → 1 reserva.
      const asignaciones = await diez(() => candado.asignarCargaUnaVez(app, { loadId: L1, driverId: dX.id, tenantId: tX }));
      const ganadas = asignaciones.filter(r => r.resultado.asignada);
      assert(ganadas.length === 1, `asignación: ${ganadas.length} ganadores (se esperaba 1)`);
      const B1 = ganadas[0].resultado.bookingId;
      const { rows: [estadoL1] } = await admin.query(
        `SELECT l.status, (SELECT count(*)::int FROM bookings WHERE load_id=l.id AND status NOT IN ('REJECTED','CANCELLED')) AS activas
         FROM loads l WHERE l.id=$1`, [L1]);
      assert(estadoL1.status === 'OFFERED' && estadoL1.activas === 1, `estado tras asignar: ${JSON.stringify(estadoL1)}`);

      // c) Verdad final: insertar otra reserva activa saltándose el candado → índice único.
      let bloqueada = false;
      try {
        await comoTenant(tX, c => c.query(`INSERT INTO bookings (tenant_id, load_id, driver_id, status) VALUES ($1,$2,$3,'CONFIRMED')`, [tX, L1, dX.id]));
      } catch (e) { bloqueada = e.code === '23505' && e.constraint === 'uq_bookings_carga_activa'; }
      assert(bloqueada, 'una segunda reserva activa para la misma carga no fue bloqueada por uq_bookings_carga_activa');

      // d) El chofer confirma (como 17_sms_emergencia) → 10 despachos → 1.
      await comoTenant(tX, c => c.query(`UPDATE bookings SET status='CONFIRMED' WHERE id=$1`, [B1]));
      const despachos = await diez(() => candado.despacharUnaVez(app, { bookingId: B1, tenantId: tX }));
      assert(despachos.filter(r => r.resultado.despachado).length === 1, 'despacho: no hubo exactamente 1');
      const facturaPrematura = await candado.facturarUnaVez(app, { bookingId: B1, tenantId: tX });
      assert(facturaPrematura.resultado.facturada === false, 'se facturó una carga no entregada');

      // e) Entrega → 10 facturaciones concurrentes → 1 factura, 1 llamada a QuickBooks.
      await comoTenant(tX, c => c.query(`UPDATE bookings SET status='DELIVERED', delivered_at=now() WHERE id=$1`, [B1]));
      const llamadasQb = [];
      const qb = { crearFactura: async (bookingId, numero) => { llamadasQb.push(numero); return { id: `QB-${numero}` }; } };
      const facturas = await diez(() => candado.facturarUnaVez(app, { bookingId: B1, tenantId: tX, quickbooks: qb }));
      const emitidas = facturas.filter(r => r.resultado.facturada);
      assert(emitidas.length === 1 && llamadasQb.length === 1, `facturación: ${emitidas.length} facturas y ${llamadasQb.length} llamadas a QuickBooks`);
      const { rows: [fac] } = await admin.query(
        `SELECT count(*)::int AS n, max(i.numero) AS numero, max(i.monto)::text AS monto, max(b.status) AS reserva, max(b.invoice_id) AS qb
         FROM invoices i JOIN bookings b ON b.id=i.booking_id WHERE i.booking_id=$1`, [B1]);
      assert(fac.n === 1 && fac.numero === emitidas[0].resultado.numero && fac.monto === '2500.00' && fac.reserva === 'INVOICED' && fac.qb === `QB-${fac.numero}`,
        `factura persistida incorrecta: ${JSON.stringify(fac)}`);

      // f) QuickBooks falla → no queda factura y la reserva sigue DELIVERED.
      const r2 = await candado.asignarCargaUnaVez(app, { loadId: L2, driverId: dX.id, tenantId: tX });
      const B2 = r2.resultado.bookingId;
      await comoTenant(tX, c => c.query(`UPDATE bookings SET status='DELIVERED' WHERE id=$1`, [B2]));
      let fallo = null;
      try { await candado.facturarUnaVez(app, { bookingId: B2, tenantId: tX, quickbooks: { crearFactura: async () => { throw new Error('QuickBooks caído'); } } }); }
      catch (e) { fallo = e; }
      assert(fallo && /QuickBooks caído/.test(fallo.message), 'el fallo de QuickBooks no se propagó');
      const { rows: [tras] } = await admin.query(
        `SELECT (SELECT count(*)::int FROM invoices WHERE booking_id=$1) AS n, (SELECT status FROM bookings WHERE id=$1) AS s`, [B2]);
      assert(tras.n === 0 && tras.s === 'DELIVERED', `fallo externo dejó estado parcial: ${JSON.stringify(tras)}`);

      // f2) Reserva que vuelve a DELIVERED (corrección manual) con factura vigente: respuesta
      //     controlada "ya tiene factura", sin segunda factura ni error del índice único.
      const okB2 = await candado.facturarUnaVez(app, { bookingId: B2, tenantId: tX });
      assert(okB2.resultado.facturada === true, 'B2 no se pudo facturar tras recuperarse QuickBooks');
      await comoTenant(tX, c => c.query(`UPDATE bookings SET status='DELIVERED' WHERE id=$1`, [B2]));
      const repetida = await candado.facturarUnaVez(app, { bookingId: B2, tenantId: tX });
      assert(repetida.resultado.facturada === false && /ya tiene factura/.test(repetida.resultado.motivo)
        && repetida.resultado.numero === okB2.resultado.numero, `refacturación no controlada: ${JSON.stringify(repetida.resultado)}`);
      const { rows: [unaB2] } = await admin.query('SELECT count(*)::int AS n FROM invoices WHERE booking_id=$1', [B2]);
      assert(unaB2.n === 1, `B2 tiene ${unaB2.n} facturas`);

      // g) Cobro: 10 eventos de pago distintos para la misma reserva → 1 pago; factura PAGADA.
      const pagos = await diez(i => candado.registrarPagoUnaVez(app, { paymentId: `pay-${i}`, bookingId: B1, monto: 2500, tenantId: tX }));
      assert(pagos.filter(r => r.resultado.pagado).length === 1, 'pago: no hubo exactamente 1');
      const { rows: [pago] } = await admin.query(
        `SELECT b.status, b.paid_amount::text AS monto, i.estado, i.pagada_en IS NOT NULL AS fechada
         FROM bookings b JOIN invoices i ON i.booking_id=b.id WHERE b.id=$1`, [B1]);
      assert(pago.status === 'PAID' && pago.monto === '2500.00' && pago.estado === 'PAGADA' && pago.fechada, `pago persistido incorrecto: ${JSON.stringify(pago)}`);
      let invalido = false;
      try { await candado.registrarPagoUnaVez(app, { paymentId: 'x', bookingId: B2, monto: -5, tenantId: tX }); }
      catch (e) { invalido = e.code === 'PARAMETRO_INVALIDO'; }
      assert(invalido, 'un monto negativo no fue rechazado');

      // h) RLS sobre invoices: otra empresa no ve las facturas.
      const vistas = await comoTenant(tY, c => c.query('SELECT count(*)::int AS n FROM invoices'));
      assert(vistas.rows[0].n === 0, `el tenant Y ve ${vistas.rows[0].n} facturas ajenas`);
      return 'aislamiento entre empresas; asignar/despachar/facturar/cobrar 10→1 cada uno; índice único como verdad final; fallo de QuickBooks sin estado parcial; RLS en invoices';
    });

    let pubRotada = null;
    await test('T15_rotacion_de_claves_de_checkpoint', async () => {
      const original = { priv: process.env.CHECKPOINT_PRIVATE_KEY, pub: process.env.CHECKPOINT_PUBLIC_KEY, pubs: process.env.CHECKPOINT_PUBLIC_KEYS };
      assert(original.priv && original.pub, 'PRECONDICION: CHECKPOINT_PRIVATE_KEY y CHECKPOINT_PUBLIC_KEY requeridas');
      const restaurarEnv = () => {
        process.env.CHECKPOINT_PRIVATE_KEY = original.priv;
        process.env.CHECKPOINT_PUBLIC_KEY = original.pub;
        if (original.pubs === undefined) delete process.env.CHECKPOINT_PUBLIC_KEYS; else process.env.CHECKPOINT_PUBLIC_KEYS = original.pubs;
      };
      const kid1 = ledger.kidDeClave(original.pub);
      const priv2 = nuevaPrivada();
      const pub2 = pemPublica(priv2);
      const kid2 = ledger.kidDeClave(pub2);
      pubRotada = pub2;
      try {
        // Checkpoint legacy (anterior a v6.1): firmado con la clave 1 y sin firma_kid.
        const tL = await crearTenant('LEG');
        await ledger.registrar(app, { tenantId: tL, actor: 'integration', accion: 'LEGACY.CP', entidad: 'ledger', entidadId: 't15-legacy', despues: { v: 1 }, dedupKey: 't15-legacy' });
        const { rows: [cab] } = await admin.query('SELECT seq, hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1', [tL]);
        const firmaLegacy = crypto.sign(null, Buffer.from(`${tL}:${cab.seq}:${cab.hash}`, 'utf8'), crypto.createPrivateKey(original.priv)).toString('hex');
        await admin.query(`INSERT INTO audit_checkpoints (tenant_id, seq, hash, firma, firma_alg, firma_kid) VALUES ($1,$2,$3,$4,'ed25519',NULL)`,
          [tL, cab.seq, cab.hash, firmaLegacy]);
        const { rows: [legado] } = await admin.query(
          "SELECT count(*)::int AS n FROM audit_checkpoints WHERE firma_alg='ed25519' AND firma_kid IS NULL");
        assert(legado.n >= 1, 'no se pudo preparar el checkpoint legacy');
        const vLegacy = await ledger.verificarCheckpoint(app, tL, Number(cab.seq));
        assert(vLegacy.ok, `checkpoint legacy sin kid no verifica: ${JSON.stringify(vLegacy)}`);

        const tR = await crearTenant('ROT');
        const asiento = (i) => ledger.registrar(app, { tenantId: tR, actor: 'integration', accion: 'KEY.ROTATION', entidad: 'ledger', entidadId: `t15-${i}`, despues: { i }, dedupKey: `t15-${i}` });
        await asiento(1); await asiento(2);
        const cp1 = await ledger.crearCheckpoint(app, tR, original.priv);
        assert(cp1.ok && cp1.kid === kid1, `checkpoint 1 sin kid correcto: ${cp1.kid}`);
        const { rows: [g1] } = await admin.query('SELECT firma_kid FROM audit_checkpoints WHERE tenant_id=$1 AND seq=$2', [tR, cp1.seq]);
        assert(g1.firma_kid === kid1, 'firma_kid no se persistió');

        // Rotación: la clave nueva firma; la antigua sigue en el llavero de confianza.
        process.env.CHECKPOINT_PRIVATE_KEY = priv2;
        process.env.CHECKPOINT_PUBLIC_KEY = pub2;
        process.env.CHECKPOINT_PUBLIC_KEYS = original.pub;
        await asiento(3);
        const cp2 = await ledger.crearCheckpoint(app, tR);
        assert(cp2.ok && cp2.kid === kid2 && String(cp2.seq) !== String(cp1.seq), 'checkpoint 2 no usa la clave rotada');
        const gate = await ledger.verificacionPostRestauracion(admin);
        assert(gate.ok, 'gate DR no pasa con llavero antigua+nueva');

        // Retirar la clave antigua: sus checkpoints quedan sin clave de confianza.
        delete process.env.CHECKPOINT_PUBLIC_KEYS;
        const v1 = await ledger.verificarCheckpoint(app, tR, Number(cp1.seq));
        assert(!v1.ok && /CLAVE DESCONOCIDA/.test(v1.motivo), `clave retirada no detectada: ${JSON.stringify(v1)}`);
        const v2 = await ledger.verificarCheckpoint(app, tR, Number(cp2.seq));
        assert(v2.ok, `checkpoint con la clave vigente no verifica: ${JSON.stringify(v2)}`);
        let gateRetirada = false;
        try { await ledger.verificacionPostRestauracion(admin); } catch (e) { gateRetirada = /DR_CHECKPOINT_INVALIDO/.test(e.message); }
        assert(gateRetirada, 'gate DR aceptó checkpoints firmados con una clave retirada');
        process.env.CHECKPOINT_PUBLIC_KEYS = original.pub;

        // kid manipulado: apuntar a otra clave de confianza no sirve (la firma no verifica).
        const fijarKid = (kid) => admin.query('UPDATE audit_checkpoints SET firma_kid=$3 WHERE tenant_id=$1 AND seq=$2', [tR, cp2.seq, kid]);
        await fijarKid(kid1);
        const vManip = await ledger.verificarCheckpoint(app, tR, Number(cp2.seq));
        assert(!vManip.ok && /FIRMA INVÁLIDA/.test(vManip.motivo), `kid manipulado aceptado: ${JSON.stringify(vManip)}`);
        await fijarKid('f'.repeat(64));
        const vDesconocido = await ledger.verificarCheckpoint(app, tR, Number(cp2.seq));
        assert(!vDesconocido.ok && /CLAVE DESCONOCIDA/.test(vDesconocido.motivo), 'kid desconocido aceptado');
        let formato = false;
        try { await fijarKid('no-es-hex'); } catch (e) { formato = e.code === '23514'; }
        assert(formato, 'firma_kid con formato inválido no fue rechazado por ck_checkpoint_kid');
        await fijarKid(kid2);
        const gateFinal = await ledger.verificacionPostRestauracion(admin);
        assert(gateFinal.ok, 'gate DR no vuelve a pasar tras restaurar el kid');
        return `kid persistido; rotación con llavero antigua+nueva ok; clave retirada → CLAVE DESCONOCIDA y gate DR rechaza; kid manipulado → FIRMA INVÁLIDA; ${legado.n} checkpoint(s) legacy sin kid verifican contra el llavero`;
      } finally { restaurarEnv(); }
    });

    await test('T16_migraciones_reversibles_en_postgres', async () => {
      const aplicadas = async (p) => (await migrador.estado(p)).filter(m => m.aplicada).map(m => m.id);
      const TODAS = migrador.cargarMigraciones().map(m => m.id);            // [1..N] desde los archivos
      const DESDE3 = TODAS.filter(id => id >= 3);
      const json = (x) => JSON.stringify(x);
      const inicial = await aplicadas(admin);
      assert(json(inicial) === json(TODAS), `estado inicial inesperado: ${json(inicial)}`);

      // BD poblada: orden inverso obligatorio y rollbacks con pérdida bloqueados.
      const desorden = await migrador.revertir(admin, 1);
      assert(!desorden.ok && /orden inverso/.test(desorden.motivo), 'se permitió revertir fuera de orden');
      for (const id of [...DESDE3].reverse()) {
        const r = await migrador.revertir(admin, id);
        assert(r.ok, `revertir ${id} falló: ${json(r)}`);
      }
      const { rows: [sinKid] } = await admin.query(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='audit_checkpoints' AND column_name='firma_kid'");
      assert(sinKid.n === 0, '003 down no eliminó firma_kid');
      let bloqueo2 = null;
      try { await migrador.revertir(admin, 2); } catch (e) { bloqueo2 = e; }
      assert(bloqueo2 && /ROLLBACK_BLOQUEADO/.test(bloqueo2.message), 'el rollback de 002 con facturas no se bloqueó');
      const { rows: [facturas] } = await admin.query('SELECT count(*)::int AS n FROM invoices');
      assert(facturas.n >= 1, 'el rollback bloqueado alteró las facturas');
      const tras = await aplicadas(admin);
      assert(JSON.stringify(tras) === '[1,2]', `estado tras rollback bloqueado: ${JSON.stringify(tras)}`);
      const re = await aplicarEsquema(admin);
      assert(json(re.migraciones.aplicadas) === json(DESDE3), `re-aplicar desde 003: ${json(re.migraciones.aplicadas)}`);
      // Tras 003 down→up los kid se pierden (documentado): verifican contra el llavero completo.
      process.env.CHECKPOINT_PUBLIC_KEYS = pubRotada;
      try {
        const gate = await ledger.verificacionPostRestauracion(admin);
        assert(gate.ok, 'gate DR no pasa tras 003 down→up con llavero completo');
      } finally { delete process.env.CHECKPOINT_PUBLIC_KEYS; }

      // 001 down con checkpoints Ed25519 se bloquea en lugar de corromper firma_alg.
      const baseUrl = new URL(adminUrl);
      const nombreLimpia = `${baseUrl.pathname.slice(1)}_t16_${crypto.randomBytes(4).toString('hex')}`;
      await admin.query(`CREATE DATABASE "${nombreLimpia}"`);
      const urlLimpia = new URL(adminUrl); urlLimpia.pathname = `/${nombreLimpia}`;
      const limpia = new Pool({ connectionString: urlLimpia.toString(), max: 2 });
      try {
        // BD nueva + 6 réplicas arrancando a la vez (E-023): base aplicada una sola vez, cada migración una vez.
        const replicas = Array.from({ length: 6 }, () => new Pool({ connectionString: urlLimpia.toString(), max: 2 }));
        try {
          const arranques = await Promise.all(replicas.map(p => aplicarEsquema(p)));
          const bases = arranques.filter(r => r.base).length;
          const migradas = arranques.flatMap(r => r.migraciones.aplicadas).sort((a, b) => a - b);
          assert(bases === 1, `arranque concurrente: el esquema base se aplicó ${bases} veces`);
          assert(json(migradas) === json(TODAS), `arranque concurrente: migraciones aplicadas ${json(migradas)}`);
        } finally { await Promise.allSettled(replicas.map(p => p.end())); }
        assert(json(await aplicadas(limpia)) === json(TODAS), 'BD nueva sin todas las migraciones tras arranque concurrente');
        // Ciclo completo down (N..1) → up, con el esquema intacto al final.
        for (const id of [...TODAS].reverse()) {
          const r = await migrador.revertir(limpia, id);
          assert(r.ok, `revertir ${id} en BD nueva: ${JSON.stringify(r)}`);
        }
        assert(JSON.stringify(await aplicadas(limpia)) === '[]', 'quedaron migraciones aplicadas tras revertir todo');
        const { rows: [v54] } = await limpia.query(
          `SELECT (SELECT data_type FROM information_schema.columns WHERE table_name='audit_ledger' AND column_name='hash') AS tipo_hash,
                  to_regclass('public.invoices') IS NULL AS sin_invoices`);
        assert(v54.tipo_hash === 'character' && v54.sin_invoices, `estado v5.4 incorrecto: ${JSON.stringify(v54)}`);
        const resubida = await aplicarEsquema(limpia);
        assert(json(resubida.migraciones.aplicadas) === json(TODAS), `re-subida: ${json(resubida.migraciones.aplicadas)}`);
        const { rows: [v7] } = await limpia.query(
          `SELECT (SELECT data_type FROM information_schema.columns WHERE table_name='audit_ledger' AND column_name='hash') AS tipo_hash,
                  to_regclass('public.invoices') IS NOT NULL AS con_invoices,
                  (SELECT count(*)::int FROM information_schema.columns WHERE table_name='audit_checkpoints' AND column_name='firma_kid') AS kid`);
        assert(v7.tipo_hash === 'character varying' && v7.con_invoices && v7.kid === 1, `estado v7 incorrecto: ${JSON.stringify(v7)}`);
      } finally {
        await limpia.end().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS "${nombreLimpia}" WITH (FORCE)`).catch(() => {});
      }
      let bloqueo1 = null;
      for (const id of [...DESDE3].reverse()) {
        const r = await migrador.revertir(admin, id);
        assert(r.ok, `revertir ${id} (segunda vez) falló: ${json(r)}`);
      }
      try {
        const c = await admin.connect();
        try {
          await c.query('BEGIN');
          await c.query("SET LOCAL micro_fleet.permitir_rollback_destructivo = 'on'");
          await c.query((await migrador.cargarMigraciones()).find(m => m.id === 2).down);
          await c.query((await migrador.cargarMigraciones()).find(m => m.id === 1).down);
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      } catch (e) { bloqueo1 = e; }
      assert(bloqueo1 && /ROLLBACK_BLOQUEADO: existen checkpoints no HMAC/.test(bloqueo1.message),
        'el rollback de 001 con checkpoints Ed25519 no se bloqueó');
      const { rows: [alg] } = await admin.query("SELECT count(*)::int AS n FROM audit_checkpoints WHERE firma_alg='ed25519'");
      assert(alg.n >= 1, 'el rollback bloqueado alteró firma_alg');
      const re2 = await aplicarEsquema(admin);
      assert(json(re2.migraciones.aplicadas) === json(DESDE3) && json(await aplicadas(admin)) === json(TODAS), 'el esquema no volvió a la versión completa');
      process.env.CHECKPOINT_PUBLIC_KEYS = pubRotada;
      try { assert((await ledger.verificacionPostRestauracion(admin)).ok, 'gate DR final no pasa'); }
      finally { delete process.env.CHECKPOINT_PUBLIC_KEYS; }
      return '6 arranques concurrentes en BD nueva: base y migraciones una sola vez; orden inverso exigido; 002 down con facturas y 001 down con Ed25519 bloqueados sin alterar datos; down(N..1)→up íntegro; gate DR ok';
    });

    console.log('\nRESULTADO PostgreSQL T14-T16');
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
