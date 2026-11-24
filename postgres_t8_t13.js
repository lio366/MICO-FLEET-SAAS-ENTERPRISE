'use strict';
// Suite de integración REAL T8–T13: escenarios de recuperación, concurrencia y clúster que T1–T7 no cubre.
//   T8  alteración de contenido del ledger → detección + gate DR + restauración
//   T9  borrado de asiento intermedio → detección + restore del asiento + DELETE denegado al runtime
//   T10 COMMIT ambiguo (conexión cortada antes y después de que el COMMIT llegue al servidor)
//   T11 backup/restore con pg_dump/pg_restore + gate DR sobre la copia restaurada
//   T12 elección de líder con 3 nodos (sesiones independientes) + failover
//   T13 candado distribuido ejecutarUnaVez: exclusión mutua real y modo no bloqueante
//
// Precondiciones: T1–T7 ejecutado en esta misma BD (esquema, roles, migración v6),
// CHECKPOINT_PUBLIC_KEY con la clave que firmó los checkpoints existentes, y binarios
// pg_dump/pg_restore (PG_BIN o PATH). Nunca sustituye PostgreSQL por mocks/SQLite.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const ledger = require('../../42_audit_ledger');
const cluster = require('../../47_scheduler_cluster');
const candado = require('../../46_distributed_lock');

const adminUrl = process.env.PG_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.error('FALTAN PG_ADMIN_URL y/o DATABASE_URL. La suite exige PostgreSQL real.');
  process.exit(process.env.REQUIRE_PG_TESTS === '1' ? 1 : 2);
}

const root = path.resolve(__dirname, '../..');
const admin = new Pool({ connectionString: adminUrl, max: 5 });
const app = new Pool({ connectionString: appUrl, max: 20 });
const results = [];
const extraPools = new Set();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
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
function conTimeout(promise, ms, etiqueta) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`TIMEOUT ${ms}ms: ${etiqueta}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
function nuevoPool(connectionString, opciones = {}) {
  const p = new Pool({ connectionString, ...opciones });
  p.on('error', () => {}); // errores de clientes inactivos o cortados a propósito: se manejan en cada prueba
  extraPools.add(p);
  return p;
}
async function cerrarPool(p) {
  extraPools.delete(p);
  await conTimeout(p.end(), 10000, 'cierre de pool').catch(() => {});
}
function urlConBase(url, base) { const u = new URL(url); u.pathname = `/${base}`; return u.toString(); }
function urlConHostPuerto(url, host, port) { const u = new URL(url); u.hostname = host; u.port = String(port); return u.toString(); }
function binPg(nombre) {
  const dir = process.env.PG_BIN;
  if (dir) {
    const p = path.join(dir, nombre);
    if (!fs.existsSync(p)) throw new Error(`BLOCKED: no existe ${p}`);
    return p;
  }
  return nombre;
}
function ejecutarBinario(nombre, args, url) {
  const u = new URL(url);
  const r = spawnSync(binPg(nombre), args, {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.error) throw new Error(`${nombre} no ejecutable: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${nombre} exit=${r.status}: ${r.stderr.trim()}`);
  return r;
}
function argsConexion(url) {
  const u = new URL(url);
  return ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', decodeURIComponent(u.pathname.slice(1))];
}
async function crearTenant(etiqueta) {
  const id = crypto.randomUUID();
  await admin.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)', [id, `Tenant ${etiqueta}`, `${etiqueta.toLowerCase()}-${id.slice(0, 8)}`]);
  return id;
}
// Ejecuta fn dentro de una transacción de administración con triggers de usuario desactivados
// (session_replication_role=replica). Simula a un atacante con acceso de superusuario a la BD.
async function comoAtacante(fn) {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
async function esperarRechazo(promise, patron, etiqueta) {
  try { await promise; } catch (e) {
    assert(patron.test(e.message) || patron.test(e.code || ''), `${etiqueta}: error inesperado: ${e.message}`);
    return e;
  }
  throw new Error(`${etiqueta}: se esperaba rechazo y la operación se completó`);
}

// ---------------------------------------------------------------------------
// Proxy TCP de corte para COMMIT ambiguo.
//   modo 'antes'   → el COMMIT NO llega al servidor; se cortan ambas conexiones (el servidor revierte).
//   modo 'despues' → el COMMIT llega y se confirma; se corta antes de devolver la respuesta al cliente.
// Se arma para UN solo corte y se desarma solo.
// ---------------------------------------------------------------------------
function crearProxyCorte(destHost, destPort) {
  const estado = { modo: null, cortes: 0 };
  const sockets = new Set();
  const server = net.createServer(cliente => {
    const servidor = net.createConnection({ host: destHost, port: destPort });
    sockets.add(cliente); sockets.add(servidor);
    let pendiente = Buffer.alloc(0);
    let arrancado = false;
    let esperandoRespuestaCommit = false;
    const cortar = () => {
      estado.cortes += 1;
      estado.modo = null;
      cliente.destroy();
      servidor.destroy();
    };
    cliente.on('data', chunk => {
      pendiente = pendiente.length ? Buffer.concat([pendiente, chunk]) : chunk;
      const salida = [];
      for (;;) {
        if (!arrancado) {
          if (pendiente.length < 4) break;
          const len = pendiente.readInt32BE(0);
          if (pendiente.length < len) break;
          salida.push(pendiente.subarray(0, len));
          pendiente = pendiente.subarray(len);
          arrancado = true;
          continue;
        }
        if (pendiente.length < 5) break;
        const len = pendiente.readInt32BE(1);
        if (pendiente.length < len + 1) break;
        const msg = pendiente.subarray(0, len + 1);
        pendiente = pendiente.subarray(len + 1);
        const esCommit = msg[0] === 0x51 && msg.toString('utf8', 5, msg.length - 1).trim().toUpperCase() === 'COMMIT';
        if (esCommit && estado.modo === 'antes') {
          if (salida.length) servidor.write(Buffer.concat(salida));
          cortar();
          return;
        }
        if (esCommit && estado.modo === 'despues') esperandoRespuestaCommit = true;
        salida.push(msg);
      }
      if (salida.length) servidor.write(Buffer.concat(salida));
    });
    servidor.on('data', chunk => {
      if (esperandoRespuestaCommit) { cortar(); return; }
      cliente.write(chunk);
    });
    const cerrarAmbos = () => { cliente.destroy(); servidor.destroy(); sockets.delete(cliente); sockets.delete(servidor); };
    cliente.on('error', cerrarAmbos); servidor.on('error', cerrarAmbos);
    cliente.on('close', cerrarAmbos); servidor.on('close', cerrarAmbos);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      estado,
      armar(modo) { estado.modo = modo; },
      cerrar: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
(async () => {
  try {
    const { rows: v } = await admin.query('SHOW server_version');
    console.log(`PostgreSQL real detectado: ${v[0].server_version}`);
    const { rows: pre } = await admin.query(
      `SELECT to_regclass('public.audit_ledger') IS NOT NULL AS ledger,
              to_regclass('public.schema_migrations') IS NOT NULL AS mig`);
    if (!pre[0].ledger || !pre[0].mig) throw new Error('PRECONDICION: ejecutar T1–T7 antes sobre esta BD (esquema/migración ausentes)');
    if (!process.env.CHECKPOINT_PUBLIC_KEY) throw new Error('PRECONDICION: CHECKPOINT_PUBLIC_KEY requerida para el gate DR');
    const gateInicial = await ledger.verificacionPostRestauracion(admin);
    assert(gateInicial.ok, 'PRECONDICION: el gate DR no pasa antes de empezar');

    const tenantC = await crearTenant('TC');
    const tenantD = await crearTenant('TD');
    const tenantE = await crearTenant('TE');

    await test('T8_alteracion_de_contenido_detectada_y_restaurada', async () => {
      for (let i = 1; i <= 3; i++) {
        await ledger.registrar(app, { tenantId: tenantC, actor: 'integration', accion: 'LOAD.RATED', entidad: 'load', entidadId: `t8-${i}`, despues: { rate: 1000 + i }, dedupKey: `t8-${i}` });
      }
      const sano = await ledger.verificarIntegridad(app, tenantC);
      assert(sano.ok && sano.registros === 3, `cadena inicial incorrecta: ${JSON.stringify(sano)}`);
      const { rows: [objetivo] } = await admin.query(
        'SELECT seq, despues::text AS original FROM audit_ledger WHERE tenant_id=$1 ORDER BY seq OFFSET 1 LIMIT 1', [tenantC]);

      const alterado = await comoAtacante(c => c.query(
        `UPDATE audit_ledger SET despues = '{"rate": 1}'::jsonb WHERE tenant_id=$1 AND seq=$2`, [tenantC, objetivo.seq]));
      assert(alterado.rowCount === 1, 'la alteración simulada no modificó la fila');

      const roto = await ledger.verificarIntegridad(app, tenantC);
      assert(!roto.ok && /HASH NO COINCIDE/.test(roto.motivo), `alteración no detectada: ${JSON.stringify(roto)}`);
      assert(String(roto.rotoEn) === String(objetivo.seq), `rotura localizada en seq=${roto.rotoEn}, esperado ${objetivo.seq}`);
      await esperarRechazo(ledger.verificacionPostRestauracion(admin), /DR_LEDGER_INVALIDO/, 'gate DR con contenido alterado');

      await comoAtacante(c => c.query(
        'UPDATE audit_ledger SET despues = $3::jsonb WHERE tenant_id=$1 AND seq=$2', [tenantC, objetivo.seq, objetivo.original]));
      const restaurado = await ledger.verificarIntegridad(app, tenantC);
      assert(restaurado.ok && restaurado.registros === 3, `tras restaurar el contenido la cadena no verifica: ${JSON.stringify(restaurado)}`);
      const gate = await ledger.verificacionPostRestauracion(admin);
      assert(gate.ok, 'gate DR no vuelve a pasar tras restaurar');
      return `alteración en seq=${objetivo.seq} detectada (HASH NO COINCIDE) y rechazada por gate DR; contenido restaurado verifica`;
    });

    await test('T9_borrado_de_asiento_detectado_y_restore', async () => {
      await esperarRechazo(
        app.query('DELETE FROM audit_ledger WHERE tenant_id=$1', [tenantC]),
        /permission denied|42501|AUDIT_LEDGER_INMUTABLE|P0001/, 'DELETE como rol runtime');

      const c = await admin.connect();
      try {
        const { rows: [objetivo] } = await c.query(
          'SELECT seq FROM audit_ledger WHERE tenant_id=$1 ORDER BY seq OFFSET 1 LIMIT 1', [tenantC]);
        const { rows: [siguiente] } = await c.query(
          'SELECT seq FROM audit_ledger WHERE tenant_id=$1 AND seq > $2 ORDER BY seq LIMIT 1', [tenantC, objetivo.seq]);
        await c.query('CREATE TEMP TABLE t9_respaldo AS SELECT * FROM audit_ledger WITH NO DATA');
        await c.query('INSERT INTO t9_respaldo SELECT * FROM audit_ledger WHERE tenant_id=$1 AND seq=$2', [tenantC, objetivo.seq]);
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        const borrado = await c.query('DELETE FROM audit_ledger WHERE tenant_id=$1 AND seq=$2', [tenantC, objetivo.seq]);
        await c.query('COMMIT');
        assert(borrado.rowCount === 1, 'el borrado simulado no eliminó la fila');

        const roto = await ledger.verificarIntegridad(app, tenantC);
        assert(!roto.ok && /no encadena/.test(roto.motivo), `borrado no detectado: ${JSON.stringify(roto)}`);
        assert(String(roto.rotoEn) === String(siguiente.seq), `rotura localizada en seq=${roto.rotoEn}, esperado ${siguiente.seq}`);
        await esperarRechazo(ledger.verificacionPostRestauracion(admin), /DR_LEDGER_INVALIDO/, 'gate DR con asiento borrado');

        const repuesto = await c.query('INSERT INTO audit_ledger SELECT * FROM t9_respaldo');
        assert(repuesto.rowCount === 1, 'el restore del asiento no insertó la fila');
        await c.query('DROP TABLE t9_respaldo');
        const restaurado = await ledger.verificarIntegridad(app, tenantC);
        assert(restaurado.ok && restaurado.registros === 3, `tras restore la cadena no verifica: ${JSON.stringify(restaurado)}`);
        const gate = await ledger.verificacionPostRestauracion(admin);
        assert(gate.ok, 'gate DR no vuelve a pasar tras restore');
        return `DELETE runtime denegado; borrado de seq=${objetivo.seq} detectado en seq=${siguiente.seq}; restore verifica`;
      } finally { c.release(); }
    });

    await test('T10_commit_ambiguo_resuelto_sin_duplicar_ni_perder', async () => {
      const destino = new URL(appUrl);
      const proxy = await crearProxyCorte(destino.hostname, Number(destino.port || 5432));
      const viaProxy = nuevoPool(urlConHostPuerto(appUrl, '127.0.0.1', proxy.port), { max: 4 });
      try {
        // Caso A: COMMIT llegó y se confirmó; la respuesta se perdió.
        proxy.armar('despues');
        const hashA = await ledger.registrar(viaProxy, { tenantId: tenantD, actor: 'integration', accion: 'PAYMENT.RECORDED', entidad: 'payment', entidadId: 't10-a', despues: { cents: 5000 }, dedupKey: 't10-a' });
        assert(proxy.estado.cortes === 1, 'el proxy no cortó la conexión en el caso A: el escenario no se produjo');
        const { rows: filasA } = await admin.query('SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND dedup_key=$2', [tenantD, 't10-a']);
        assert(filasA.length === 1 && filasA[0].hash === hashA, `caso A: esperado 1 asiento con el hash devuelto; hay ${filasA.length}`);

        // Caso B: el COMMIT nunca llegó; el servidor revierte. registrar debe fallar sin dejar rastro.
        proxy.armar('antes');
        await esperarRechazo(
          ledger.registrar(viaProxy, { tenantId: tenantD, actor: 'integration', accion: 'PAYMENT.RECORDED', entidad: 'payment', entidadId: 't10-b', despues: { cents: 7000 }, dedupKey: 't10-b' }),
          /terminated|closed|ECONNRESET|EPIPE/i, 'caso B');
        assert(proxy.estado.cortes === 2, 'el proxy no cortó la conexión en el caso B: el escenario no se produjo');
        const { rows: filasB } = await conTimeout(admin.query('SELECT count(*)::int AS n FROM audit_ledger WHERE tenant_id=$1 AND dedup_key=$2', [tenantD, 't10-b']), 10000, 'consulta caso B');
        assert(filasB[0].n === 0, `caso B: el asiento no debía persistir; hay ${filasB[0].n}`);

        // Reintento limpio del caso B por la conexión normal.
        const hashB = await conTimeout(ledger.registrar(app, { tenantId: tenantD, actor: 'integration', accion: 'PAYMENT.RECORDED', entidad: 'payment', entidadId: 't10-b', despues: { cents: 7000 }, dedupKey: 't10-b' }), 15000, 'reintento caso B');
        // Reentrega del caso A: idempotente, mismo hash.
        const hashA2 = await ledger.registrar(app, { tenantId: tenantD, actor: 'integration', accion: 'PAYMENT.RECORDED', entidad: 'payment', entidadId: 't10-a', despues: { cents: 5000 }, dedupKey: 't10-a' });
        assert(hashA2 === hashA, 'reentrega del caso A produjo un hash distinto');
        const v = await ledger.verificarIntegridad(app, tenantD);
        assert(v.ok && v.registros === 2 && v.ultimoHash === hashB, `cadena final incorrecta: ${JSON.stringify(v)}`);
        return 'A: COMMIT confirmado con respuesta perdida → resuelto por re-consulta, 1 asiento; B: COMMIT perdido → error, 0 asientos, reintento ok; cadena=2';
      } finally {
        await cerrarPool(viaProxy);
        await proxy.cerrar();
      }
    });

    await test('T11_backup_restore_pg_dump_y_gate_DR', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-t11-'));
      const archivo = path.join(dir, 'micro_fleet.dump');
      const baseOrigen = decodeURIComponent(new URL(adminUrl).pathname.slice(1));
      const baseRestore = `${baseOrigen}_t11_${crypto.randomBytes(4).toString('hex')}`;
      let restAdmin = null;
      let restApp = null;
      try {
        ejecutarBinario('pg_dump', ['-Fc', '--no-password', '-f', archivo, ...argsConexion(adminUrl)], adminUrl);
        const bytes = fs.statSync(archivo).size;
        assert(bytes > 1000, `backup sospechosamente pequeño: ${bytes} bytes`);
        await admin.query(`CREATE DATABASE "${baseRestore}"`);
        ejecutarBinario('pg_restore', ['--exit-on-error', '--no-password', ...argsConexion(urlConBase(adminUrl, baseRestore)), archivo], adminUrl);

        restAdmin = nuevoPool(urlConBase(adminUrl, baseRestore), { max: 3 });
        restApp = nuevoPool(urlConBase(appUrl, baseRestore), { max: 3 });

        const resumen = async (p) => (await p.query(
          `SELECT tenant_id::text, count(*)::int AS n,
                  (array_agg(hash ORDER BY seq DESC))[1] AS ultimo
           FROM audit_ledger GROUP BY tenant_id ORDER BY tenant_id`)).rows;
        const origen = await resumen(admin);
        const copia = await resumen(restAdmin);
        assert(JSON.stringify(origen) === JSON.stringify(copia), 'el ledger restaurado difiere del origen (conteos o cabezas de cadena)');
        const { rows: [cps] } = await restAdmin.query('SELECT count(*)::int AS n FROM audit_checkpoints');
        assert(cps.n >= 1, 'la copia restaurada no contiene checkpoints');

        const gate = await ledger.verificacionPostRestauracion(restAdmin);
        assert(gate.ok && gate.tenants === origen.length, `gate DR sobre copia restaurada: ${JSON.stringify({ ok: gate.ok, tenants: gate.tenants })}`);

        const { rows: [rls] } = await restAdmin.query(
          `SELECT c.relrowsecurity AND c.relforcerowsecurity AS activo,
                  (SELECT count(*)::int FROM pg_policies WHERE tablename='drivers') AS politicas
           FROM pg_class c WHERE c.relname='drivers' AND c.relnamespace='public'::regnamespace`);
        assert(rls.activo && rls.politicas >= 1, 'RLS no quedó activo en la copia restaurada');
        const c = await restApp.connect();
        try {
          await c.query('BEGIN');
          await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantD]);
          const { rows } = await c.query('SELECT DISTINCT tenant_id::text AS t FROM audit_ledger');
          await c.query('COMMIT');
          assert(rows.length === 1 && rows[0].t === tenantD, `aislamiento roto en la copia: ve ${rows.length} tenants`);
        } finally { c.release(); }

        // El gate debe rechazar una copia restaurada que fue alterada.
        const ct = await restAdmin.connect();
        try {
          await ct.query('BEGIN');
          await ct.query('SET LOCAL session_replication_role = replica');
          await ct.query(`UPDATE audit_ledger SET motivo='restaurado-alterado' WHERE tenant_id=$1 AND seq=(SELECT min(seq) FROM audit_ledger WHERE tenant_id=$1)`, [tenantD]);
          await ct.query('COMMIT');
        } finally { ct.release(); }
        await esperarRechazo(ledger.verificacionPostRestauracion(restAdmin), /DR_LEDGER_INVALIDO/, 'gate DR con copia alterada');
        return `pg_dump ${bytes} B → pg_restore; ${origen.length} tenants idénticos; gate DR ok; RLS y aislamiento conservados; copia alterada rechazada`;
      } finally {
        if (restAdmin) await cerrarPool(restAdmin);
        if (restApp) await cerrarPool(restApp);
        await admin.query(`DROP DATABASE IF EXISTS "${baseRestore}" WITH (FORCE)`).catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test('T12_eleccion_de_lider_y_failover', async () => {
      // Mismo orden que el bootstrap: tabla del clúster antes de los grants del runtime.
      await admin.query(cluster.SQL);
      await admin.query(fs.readFileSync(path.join(root, 'infra/postgres/003_app_grants.sql'), 'utf8'));
      await admin.query(ledger.SQL_ROLES);
      const sufijo = crypto.randomBytes(3).toString('hex');
      const nombres = ['A', 'B', 'C'].map(n => `t12-${sufijo}-${n}`);
      const nodos = new Map(nombres.map(n => [n, nuevoPool(appUrl, { max: 2, application_name: `mf-t12-${n}` })]));
      const ronda = async (ids, etiqueta) => {
        const r = await Promise.all(ids.map(id =>
          conTimeout(cluster.campañaLiderazgo(nodos.get(id), id), 5000, `${etiqueta} nodo ${id}`)));
        return ids.filter((_, i) => r[i] === true);
      };
      try {
        for (const id of nombres) {
          await nodos.get(id).query('INSERT INTO cluster_nodos (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET ultimo_heartbeat=now()', [id]);
        }
        const r1 = await ronda(nombres, 'ronda 1');
        assert(r1.length === 1, `ronda 1: se esperaba exactamente 1 líder, hay ${r1.length}`);
        const lider = r1[0];
        const r2 = await ronda(nombres, 'ronda 2');
        assert(r2.length === 1 && r2[0] === lider, `ronda 2: el liderazgo cambió sin caída (${r2.join(',')})`);

        // Caída del líder: deja de latir y su proceso termina.
        await cerrarPool(nodos.get(lider));
        nodos.delete(lider);
        await admin.query(`UPDATE cluster_nodos SET ultimo_heartbeat = now() - interval '${cluster.TTL_LIDER_SEG * 4} seconds' WHERE id=$1`, [lider]);
        const supervivientes = nombres.filter(n => n !== lider);
        for (const id of supervivientes) {
          await nodos.get(id).query('UPDATE cluster_nodos SET ultimo_heartbeat=now() WHERE id=$1', [id]);
        }
        const r3 = await ronda(supervivientes, 'failover');
        assert(r3.length === 1 && r3[0] !== lider, `failover: se esperaba 1 líder nuevo, hay ${r3.length}`);
        const { rows } = await admin.query('SELECT id FROM cluster_nodos WHERE lider=TRUE AND id = ANY($1)', [nombres]);
        assert(rows.length === 1 && rows[0].id === r3[0], `estado persistido incoherente: ${JSON.stringify(rows)}`);
        const estado = await cluster.estadoCluster(admin);
        assert(estado.lider === r3[0], `estadoCluster reporta líder ${estado.lider}`);
        return `3 nodos: 1 líder estable en 2 rondas; caída de ${lider.slice(-1)} → failover a ${r3[0].slice(-1)} sin bloqueos`;
      } finally {
        // Si un nodo quedó bloqueado esperando un candado, se termina su backend para poder cerrar.
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = current_database() AND application_name LIKE $1 AND pid <> pg_backend_pid()`, [`mf-t12-t12-${sufijo}-%`]).catch(() => {});
        for (const p of nodos.values()) await cerrarPool(p);
        await admin.query('DELETE FROM cluster_nodos WHERE id = ANY($1)', [nombres]).catch(() => {});
      }
    });

    await test('T13_candado_distribuido_exclusion_mutua', async () => {
      const { rows: [carga] } = await admin.query(
        `INSERT INTO loads (tenant_id, origin_city, dest_city, rate, status) VALUES ($1,'Miami','Orlando',1500,'AVAILABLE') RETURNING id`, [tenantE]);
      // Claves deterministas que cubren ambos signos de la llave bigint (bit alto 1 y 0):
      // una clave aleatoria solo ejercería la mitad del rango en cada ejecución.
      const claveConSigno = (negativa) => {
        for (let i = 0; i < 10000; i++) {
          const k = `t13:carga:${carga.id}:${i}`;
          if ((BigInt(candado.llave64(k)) < 0n) === negativa) return k;
        }
        throw new Error('no se encontró clave con el signo pedido');
      };
      const clave = claveConSigno(true);
      const clavePositiva = claveConSigno(false);
      for (const k of [clave, clavePositiva]) {
        const r = await candado.ejecutarUnaVez(app, k, async (client) =>
          (await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS reentrante', [candado.llave64(k)])).rows[0].reentrante);
        assert(r.ejecutado && r.resultado === true, `candado con llave ${candado.llave64(k)} no operativo`);
      }
      let dentro = 0;
      let maxDentro = 0;
      const ganadores = [];
      const intentos = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        candado.ejecutarUnaVez(app, clave, async (client) => {
          dentro += 1; maxDentro = Math.max(maxDentro, dentro);
          try {
            await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantE]);
            const { rows: [estado] } = await client.query('SELECT status FROM loads WHERE id=$1', [carga.id]);
            await client.query('SELECT pg_sleep(0.03)'); // ensancha la ventana de carrera
            if (estado.status !== 'AVAILABLE') return { gano: false };
            const r = await client.query(`UPDATE loads SET status='OFFERED' WHERE id=$1 AND status='AVAILABLE' RETURNING id`, [carga.id]);
            if (r.rows.length) ganadores.push(i);
            return { gano: r.rows.length === 1 };
          } finally { dentro -= 1; }
        })));
      assert(intentos.every(r => r.ejecutado), 'algún intento bloqueante no se ejecutó');
      assert(maxDentro === 1, `exclusión mutua rota: ${maxDentro} procesos dentro de la sección crítica a la vez`);
      assert(ganadores.length === 1, `se esperaba 1 asignación, hubo ${ganadores.length}`);

      // Modo no bloqueante: mientras uno sostiene el candado, otro recibe "ya en proceso" al instante.
      let soltar;
      const sostenido = new Promise(r => { soltar = r; });
      let tomado;
      const tomadoP = new Promise(r => { tomado = r; });
      const titular = candado.ejecutarUnaVez(app, clave, async () => { tomado(); await sostenido; return 'titular'; });
      await tomadoP;
      const t0 = Date.now();
      const intruso = await candado.ejecutarUnaVez(app, clave, async () => 'intruso', { esperar: false });
      const espera = Date.now() - t0;
      soltar();
      const rTitular = await titular;
      assert(intruso.ejecutado === false && espera < 1000, `modo no bloqueante: ${JSON.stringify(intruso)} en ${espera}ms`);
      assert(rTitular.ejecutado && rTitular.resultado === 'titular', 'el titular no completó');
      return `llaves negativa y positiva operativas; 10 contendientes: máx. 1 en sección crítica; 1 asignación; no bloqueante rechazado en ${espera}ms`;
    });

    console.log('\nRESULTADO PostgreSQL T8-T13');
    console.table(results);
    console.log(`TOTAL ${results.filter(x => x.status === 'PASS').length}/6 PASS`);
  } catch (e) {
    if (!results.some(r => r.status === 'FAIL')) console.error(`ERROR FUERA DE PRUEBA: ${e.message}`);
    console.error('\nSUITE ABORTADA: no se considera aprobada.');
    process.exitCode = 1;
  } finally {
    for (const p of [...extraPools]) await cerrarPool(p);
    await Promise.allSettled([
      conTimeout(admin.end(), 10000, 'cierre admin'),
      conTimeout(app.end(), 10000, 'cierre app'),
    ]);
  }
})();
