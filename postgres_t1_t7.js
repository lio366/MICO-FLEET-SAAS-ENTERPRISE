'use strict';
// Suite de integración REAL: exige PostgreSQL accesible por PG_ADMIN_URL y DATABASE_URL.
// Nunca sustituye PostgreSQL por mocks/SQLite. Cada T se reporta individualmente.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const ledger = require('../../42_audit_ledger');

const adminUrl = process.env.PG_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  const msg = 'FALTAN PG_ADMIN_URL y/o DATABASE_URL. La suite exige PostgreSQL real.';
  console.error(msg);
  process.exit(process.env.REQUIRE_PG_TESTS === '1' ? 1 : 2);
}

const admin = new Pool({ connectionString: adminUrl, max: 5 });
const app = new Pool({ connectionString: appUrl, max: 20 });
const root = path.resolve(__dirname, '../..');
const results = [];
let tenantA, tenantB;

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
async function txAsApp(tenantId, fn) {
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

(async () => {
  try {
    await admin.query('SELECT version()');
    const { rows: versionRows } = await admin.query('SHOW server_version');
    console.log(`PostgreSQL real detectado: ${versionRows[0].server_version}`);

    // Precondición: BD desechable. T7 ejecuta el gate DR sobre TODOS los checkpoints de la BD
    // y cada ejecución firma con una clave Ed25519 efímera; los checkpoints de una ejecución
    // anterior no verifican con la clave nueva (no existe rotación de claves; ver docs/ERRORES.md).
    const { rows: pre } = await admin.query(
      "SELECT to_regclass('public.audit_ledger') IS NOT NULL AS ledger, to_regclass('public.audit_checkpoints') IS NOT NULL AS cps");
    if (pre[0].ledger || pre[0].cps) {
      const { rows: n } = await admin.query(
        `SELECT (SELECT count(*) FROM audit_ledger)::int AS asientos,
                ${pre[0].cps ? '(SELECT count(*) FROM audit_checkpoints)::int' : '0'} AS checkpoints`);
      if (n[0].asientos > 0 || n[0].checkpoints > 0) {
        throw new Error(`PRECONDICION_BD_NO_DESECHABLE: audit_ledger=${n[0].asientos} audit_checkpoints=${n[0].checkpoints}. ` +
          'La suite T1–T7 exige una base recién creada (001_roles.sql + 002_set_password.sh). Recree la BD de pruebas.');
      }
    }

    await test('T1_schema_base_y_objetos', async () => {
      const present = await admin.query("SELECT to_regclass('public.tenants') AS tenants, to_regclass('public.drivers') AS drivers");
      if (!present.rows[0].tenants || !present.rows[0].drivers) {
        const sql = fs.readFileSync(path.join(root, '01_multi_tenant_database.sql'), 'utf8');
        await admin.query(sql);
      }
      await admin.query(ledger.SQL);
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('tenants','drivers','loads','bookings','audit_ledger','audit_checkpoints')`);
      assert(rows[0].n === 6, `Se esperaban 6 tablas; existen ${rows[0].n}`);
      await admin.query(fs.readFileSync(path.join(root, 'infra/postgres/003_app_grants.sql'), 'utf8'));
      await admin.query(ledger.SQL_ROLES);
      return `${rows[0].n} tablas críticas verificadas`;
    });

    await test('T2_migracion_v6_idempotente', async () => {
      const first = await ledger.migrar(admin);
      const second = await ledger.migrar(admin);
      assert(first.ok && second.ok, 'migrar() no devolvió ok');
      assert(second.aplicadas.length === 0, 'segunda ejecución no fue idempotente');
      const { rows } = await admin.query('SELECT id FROM schema_migrations WHERE id=1');
      assert(rows.length === 1, 'versión 1 no quedó registrada exactamente una vez');
      return `primera=${first.aplicadas.length}; segunda=${second.aplicadas.length}`;
    });

    tenantA = crypto.randomUUID(); tenantB = crypto.randomUUID();
    await admin.query('INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3),($4,$5,$6)',
      [tenantA, 'Tenant A Integration', `ta-${tenantA.slice(0,8)}`, tenantB, 'Tenant B Integration', `tb-${tenantB.slice(0,8)}`]);
    await admin.query('INSERT INTO drivers (tenant_id,full_name) VALUES ($1,$2),($3,$4)',
      [tenantA, 'Driver A', tenantB, 'Driver B']);

    await test('T3_RLS_aislamiento_entre_tenants', async () => {
      const a = await txAsApp(tenantA, async c => {
        const visible = await c.query('SELECT full_name FROM drivers ORDER BY full_name');
        assert(visible.rows.length === 1 && visible.rows[0].full_name === 'Driver A', 'tenant A ve datos ajenos o no ve los propios');
        let denied = false;
        try { await c.query('INSERT INTO drivers (tenant_id,full_name) VALUES ($1,$2)', [tenantB, 'Cross Tenant Attack']); }
        catch (e) { denied = e.code === '42501'; }
        assert(denied, 'RLS no bloqueó INSERT en tenant B desde contexto A');
        return visible.rows.length;
      });
      const b = await txAsApp(tenantB, async c => (await c.query('SELECT full_name FROM drivers')).rows);
      assert(b.length === 1 && b[0].full_name === 'Driver B', 'tenant B contiene contaminación cruzada');
      return `A=${a}; B=${b.length}; INSERT cruzado bloqueado`;
    });

    await test('T4_ledger_append_y_verificacion_criptografica', async () => {
      const h1 = await ledger.registrar(app, { tenantId: tenantA, actor: 'integration', accion: 'LOAD.CREATED', entidad: 'load', entidadId: 'load-1', despues: { rate: 1200, currency: 'USD' }, dedupKey: 't4-load-1' });
      const h2 = await ledger.registrar(app, { tenantId: tenantA, actor: 'integration', accion: 'LOAD.ASSIGNED', entidad: 'load', entidadId: 'load-1', despues: { driver: 'd-1' }, dedupKey: 't4-load-2' });
      assert(h1 && h2 && h1 !== h2, 'hashes de ledger inválidos');
      const v = await ledger.verificarIntegridad(app, tenantA);
      assert(v.ok && v.registros === 2, `integridad incorrecta: ${JSON.stringify(v)}`);
      return `${v.registros} asientos; cadena válida`;
    });

    await test('T5_inmutabilidad_de_ledger', async () => {
      let blocked = false;
      try { await app.query("UPDATE audit_ledger SET motivo='tampered' WHERE tenant_id=$1", [tenantA]); }
      catch (e) { blocked = ['42501','P0001'].includes(e.code) || /AUDIT_LEDGER_INMUTABLE|permission denied/i.test(e.message); }
      assert(blocked, 'UPDATE no fue bloqueado por permisos o trigger');
      // Doble candado: cada capa se verifica por separado; ninguna puede depender de la otra.
      const { rows: [priv] } = await admin.query(
        `SELECT bool_or(has_table_privilege('mf_login', t, p)) AS alguno
         FROM unnest(ARRAY['audit_ledger','audit_checkpoints']) t, unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) p`);
      assert(priv.alguno === false, 'capa 1 rota: mf_login tiene UPDATE/DELETE/TRUNCATE sobre tablas de auditoría');
      let trigger = false;
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        try { await c.query("UPDATE audit_ledger SET motivo='tampered' WHERE tenant_id=$1", [tenantA]); }
        catch (e) { trigger = /AUDIT_LEDGER_INMUTABLE/.test(e.message); }
        await c.query('ROLLBACK');
      } finally { c.release(); }
      assert(trigger, 'capa 2 rota: el trigger de inmutabilidad no bloquea UPDATE ni siquiera al propietario/superusuario');
      return 'capa 1: sin UPDATE/DELETE/TRUNCATE para runtime; capa 2: trigger bloquea incluso a superusuario';
    });

    await test('T6_concurrencia_idempotencia_y_antiduplicado', async () => {
      const writes = await Promise.all(Array.from({ length: 12 }, (_, i) => ledger.registrar(app, {
        tenantId: tenantB, actor: 'parallel-worker', accion: 'LOAD.MATCHED', entidad: 'load', entidadId: `parallel-${i}`,
        despues: { index: i }, dedupKey: `parallel-key-${i}`
      })));
      assert(new Set(writes).size === 12, 'colisión de hashes inesperada');
      const sameA = await ledger.registrar(app, { tenantId: tenantB, actor: 'integration', accion: 'PAYMENT.RECORDED', entidad: 'payment', entidadId: 'p-1', despues: { cents: 1000 }, dedupKey: 'same-key' });
      const sameB = await ledger.registrar(app, { tenantId: tenantB, actor: 'integration', accion: 'PAYMENT.RECORDED', entidad: 'payment', entidadId: 'p-1', despues: { cents: 1000 }, dedupKey: 'same-key' });
      assert(sameA === sameB, 'reintento idempotente produjo hash distinto');
      let conflict = false;
      try { await ledger.registrar(app, { tenantId: tenantB, actor: 'integration', accion: 'PAYMENT.RECORDED', entidad: 'payment', entidadId: 'p-1', despues: { cents: 9999 }, dedupKey: 'same-key' }); }
      catch (e) { conflict = e.code === 'LEDGER_INTEGRITY_ALERT'; }
      assert(conflict, 'dedupKey con contenido distinto no generó alerta');
      const v = await ledger.verificarIntegridad(app, tenantB);
      assert(v.ok && v.registros === 13, `conteo/cadena incorrectos: ${JSON.stringify(v)}`);
      return `12 escrituras paralelas; dedup estable; reutilización conflictiva bloqueada; total=${v.registros}`;
    });

    await test('T7_checkpoint_ed25519_y_gate_post_restauracion', async () => {
      // Claves del entorno si existen (igual que en producción y compartidas con T8–T13);
      // si no, par efímero para una ejecución aislada.
      let pub = process.env.CHECKPOINT_PUBLIC_KEY;
      let priv = process.env.CHECKPOINT_PRIVATE_KEY;
      if (!pub || !priv) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        pub = publicKey.export({ type: 'spki', format: 'pem' });
        priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
        process.env.CHECKPOINT_PUBLIC_KEY = pub;
      }
      const cp = await ledger.crearCheckpoint(app, tenantA, priv);
      assert(cp.ok && cp.alg === 'ed25519', `checkpoint no creado: ${JSON.stringify(cp)}`);
      const valid = await ledger.verificarCheckpoint(app, tenantA, cp.seq, pub);
      assert(valid.ok, `checkpoint no verifica: ${JSON.stringify(valid)}`);
      const recovery = await ledger.verificacionPostRestauracion(admin);
      assert(recovery.ok && recovery.tenants >= 1, 'gate post-restauración no pasó');
      const original = await admin.query('SELECT firma FROM audit_checkpoints WHERE tenant_id=$1 AND seq=$2', [tenantA, cp.seq]);
      await admin.query('UPDATE audit_checkpoints SET firma=$3 WHERE tenant_id=$1 AND seq=$2', [tenantA, cp.seq, '00'.repeat(64)]);
      let rejected = false;
      try { await ledger.verificacionPostRestauracion(admin); } catch (e) { rejected = /DR_CHECKPOINT_INVALIDO/.test(e.message); }
      await admin.query('UPDATE audit_checkpoints SET firma=$3 WHERE tenant_id=$1 AND seq=$2', [tenantA, cp.seq, original.rows[0].firma]);
      assert(rejected, 'gate DR no detectó checkpoint manipulado');
      return 'Ed25519 válido; alteración detectada por gate DR; firma restaurada';
    });

    console.log('\nRESULTADO PostgreSQL T1-T7');
    console.table(results);
    console.log(`TOTAL ${results.filter(x => x.status === 'PASS').length}/7 PASS`);
  } catch (e) {
    if (!results.some(r => r.status === 'FAIL')) console.error(`ERROR FUERA DE PRUEBA: ${e.message}`);
    console.error('\nSUITE ABORTADA: no se considera aprobada.');
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([admin.end(), app.end()]);
  }
})();
