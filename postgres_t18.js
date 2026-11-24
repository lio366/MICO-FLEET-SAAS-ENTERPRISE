'use strict';
// Suite de integración REAL T18 (tras T1–T17, misma BD): API autenticada con RLS por petición (E-028).
// Ejecuta la misma cadena que el gateway (40) monta para /api:
//   identificarTenant → verificarSuscripcion → adjuntarContexto → requireAuth → requirePermiso
//   → [límite de plan] → manejador (server/api/routes.js · crearDefinicionesApi)
// con el rol runtime (mf_app) y un pool pequeño (4 conexiones) para forzar la reutilización.
//
// Proveedores criptográficos de PRUEBA (bcryptjs/jsonwebtoken no instalados en este entorno):
//   contraseñas con scrypt; JWT HS256 con node:crypto (verifica alg, firma y exp; rechaza "none").
// Lo que se valida es la lógica propia (RLS, aislamiento entre empresas, sesiones, bloqueo);
// la ejecución con las librerías reales queda pendiente de `npm ci`.
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { aplicarEsquema } = require('../../db/esquema');
const auth = require('../../41_auth_rbac');
const TenantMiddleware = require('../../02_tenant_middleware');
const { crearDefinicionesApi } = require('../../server/api/routes');

const adminUrl = process.env.PG_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.error('FALTAN PG_ADMIN_URL y/o DATABASE_URL. La suite exige PostgreSQL real.');
  process.exit(process.env.REQUIRE_PG_TESTS === '1' ? 1 : 2);
}
const admin = new Pool({ connectionString: adminUrl, max: 5 });
const app = new Pool({ connectionString: appUrl, max: 4 });
const results = [];
const TOTAL = 1;
const DOMINIO = 'microfleet.test';

// ── Proveedores de prueba ────────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const proveedoresPrueba = {
  // Formato compacto (≈73 caracteres; users.password_hash es VARCHAR(100), como un hash bcrypt de 60).
  hashPassword: async (pw) => { const sal = crypto.randomBytes(16); return `scrypt$${b64u(sal)}$${b64u(crypto.scryptSync(pw, sal, 32))}`; },
  compararPassword: async (pw, h) => {
    const [, sal, hash] = String(h).split('$');
    const a = crypto.scryptSync(pw, Buffer.from(sal, 'base64url'), 32); const b = Buffer.from(hash, 'base64url');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
  firmarToken: (payload, secreto, segundos) => {
    const ahora = Math.floor(Date.now() / 1000);
    const cabecera = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const cuerpo = b64u(JSON.stringify({ ...payload, iat: ahora, exp: ahora + segundos }));
    return `${cabecera}.${cuerpo}.${b64u(crypto.createHmac('sha256', secreto).update(`${cabecera}.${cuerpo}`).digest())}`;
  },
  verificarToken: (token, secreto) => {
    const partes = String(token).split('.');
    if (partes.length !== 3) throw new Error('jwt malformed');
    const cab = JSON.parse(Buffer.from(partes[0], 'base64url').toString());
    if (cab.alg !== 'HS256') throw new Error('invalid algorithm');
    const esperado = crypto.createHmac('sha256', secreto).update(`${partes[0]}.${partes[1]}`).digest();
    const recibido = Buffer.from(partes[2], 'base64url');
    if (esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) throw new Error('invalid signature');
    const payload = JSON.parse(Buffer.from(partes[1], 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('jwt expired');
    return payload;
  },
};

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

// ── Emulación de la cadena del gateway ──────────────────────────────────────
function compilar(ruta) {
  const nombres = [];
  const re = new RegExp('^' + ruta.replace(/:([a-zA-Z]+)/g, (_, n) => { nombres.push(n); return '([^/]+)'; }) + '$');
  return (path) => { const m = re.exec(path); return m ? Object.fromEntries(nombres.map((n, i) => [n, decodeURIComponent(m[i + 1])])) : null; };
}
function crearApi(tm) {
  const base = [tm.identifyTenant, tm.verifySubscription, tm.setTenantContext];
  const defs = crearDefinicionesApi({ db: app, tenantMiddleware: tm }).map(d => ({ ...d, coincide: compilar(d.ruta) }));
  return async function peticion(metodo, ruta, { host, token, body } = {}) {
    const def = defs.find(d => d.metodo === metodo && d.coincide(ruta));
    if (!def) throw new Error(`ruta no definida: ${metodo} ${ruta}`);
    const req = { method: metodo.toUpperCase(), headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body || {}, params: def.coincide(ruta), ip: '127.0.0.1' };
    const res = { codigo: 200, cuerpo: undefined, terminado: false,
      status(c) { this.codigo = c; return this; }, json(b) { this.cuerpo = b; this.terminado = true; return this; },
      send(b) { this.cuerpo = b; this.terminado = true; return this; }, type() { return this; } };
    for (const mw of [...base, ...def.cadena]) {
      let siguio = false; let error = null;
      await new Promise((resolve, reject) => {
        let r;
        try { r = mw(req, res, (e) => { siguio = true; error = e || null; resolve(); }); } catch (e) { reject(e); return; }
        Promise.resolve(r).then(resolve, reject);
      });
      if (error) { res.codigo = error.status || 500; res.cuerpo = { error: error.message, code: error.code }; res.error = error; break; }
      if (!siguio || res.terminado) break;
    }
    return res;
  };
}

async function crearTenant(etiqueta, extra = {}) {
  const id = crypto.randomUUID();
  const slug = `${etiqueta.toLowerCase()}-${id.slice(0, 8)}`;
  await admin.query(
    `INSERT INTO tenants (id, name, slug, status, max_trucks, custom_domain, trial_ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, `Tenant ${etiqueta}`, slug, extra.status || 'ACTIVE', extra.maxTrucks || 10, extra.dominio || null, extra.trialEnds || null]);
  return { id, host: `${slug}.${DOMINIO}` };
}

(async () => {
  try {
    const { rows: v } = await admin.query('SHOW server_version');
    console.log(`PostgreSQL real detectado: ${v[0].server_version}`);
    const esquema = await aplicarEsquema(admin);
    console.log(`Esquema aplicado; migraciones nuevas: [${esquema.migraciones.aplicadas.join(',')}]`);
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    auth.configurarProveedores(proveedoresPrueba);

    await test('T18_api_autenticada_RLS_por_peticion', async () => {
      const tm = new TenantMiddleware(app, { dominioBase: DOMINIO, ttlMs: 60000 });
      const api = crearApi(tm);
      const dominioA = `dispatch-${crypto.randomBytes(3).toString('hex')}.acme-cliente.test`;
      const A = await crearTenant('ACME', { maxTrucks: 3, dominio: dominioA });
      const B = await crearTenant('BETA');
      const S = await crearTenant('SUSP', { status: 'SUSPENDED' });
      const T = await crearTenant('TRIAL', { status: 'TRIAL', trialEnds: new Date(Date.now() - 86400000).toISOString() });
      const sufijo = crypto.randomBytes(3).toString('hex');
      const correo = (n) => `${n}-${sufijo}@flota.test`;
      const PW = 'Clave-Segura-2026';
      await auth.crearUsuario(app, { tenantId: A.id, nombre: 'Admin A', email: correo('admin-a'), password: PW, rol: 'ADMIN' });
      await auth.crearUsuario(app, { tenantId: A.id, nombre: 'Disp A', email: correo('disp-a'), password: PW, rol: 'DISPATCHER' });
      await auth.crearUsuario(app, { tenantId: A.id, nombre: 'Viewer A', email: correo('viewer-a'), password: PW, rol: 'VIEWER' });
      await auth.crearUsuario(app, { tenantId: A.id, nombre: 'Victima', email: correo('bloqueo-a'), password: PW, rol: 'VIEWER' });
      await auth.crearUsuario(app, { tenantId: B.id, nombre: 'Admin B', email: correo('admin-b'), password: PW, rol: 'ADMIN' });
      const chofer = async (t, n) => (await admin.query('INSERT INTO drivers (tenant_id, full_name, phone) VALUES ($1,$2,$3) RETURNING id', [t, n, '3055550000'])).rows[0].id;
      const dA1 = await chofer(A.id, 'A Verificado'); const dA2 = await chofer(A.id, 'A Pendiente'); const dB1 = await chofer(B.id, 'B Uno');
      // evidencia_completa es generada: se deriva de las tres fotos.
      await admin.query(`INSERT INTO verificaciones_carrier (tenant_id, driver_id, fmcsa_autoridad_activa, fmcsa_seguro_vigente, poliza_verificada,
          foto_cdl_url, foto_camion_url, foto_poliza_url, cdl_coincide_mc, estado)
        VALUES ($1,$2,TRUE,TRUE,TRUE,'s3://cdl','s3://camion','s3://poliza',TRUE,'VERIFICADO'),
               ($3,$4,TRUE,TRUE,TRUE,'s3://cdl','s3://camion','s3://poliza',TRUE,'VERIFICADO')`, [A.id, dA1, B.id, dB1]);
      const { rows: [LA1] } = await admin.query(`INSERT INTO loads (tenant_id, origin_city, dest_city, rate, status) VALUES ($1,'Miami','Atlanta',2100,'AVAILABLE') RETURNING id`, [A.id]);

      // 1) Resolución por Host.
      for (const [host, esperado] of [[`desconocida.${DOMINIO}`, 404], [`${A.host}.evil.com`, 404], ['', 404], [S.host, 402], [T.host, 402]]) {
        const r = await api('post', '/auth/login', { host, body: { email: correo('admin-a'), password: PW } });
        assert(r.codigo === esperado, `host ${host || '(vacío)'}: ${r.codigo} (esperado ${esperado})`);
      }
      const login = async (host, nombre, pw = PW) => api('post', '/auth/login', { host, body: { email: correo(nombre), password: pw } });
      const lA = await login(`${A.host.toUpperCase()}:443`, 'admin-a');
      assert(lA.codigo === 200 && lA.cuerpo.token, `login admin A por subdominio: ${lA.codigo} ${JSON.stringify(lA.cuerpo)}`);
      const lDom = await login(dominioA, 'disp-a');
      assert(lDom.codigo === 200, `login por dominio propio: ${lDom.codigo}`);
      const tokA = lA.cuerpo.token; const tokDisp = lDom.cuerpo.token;
      const tokViewer = (await login(A.host, 'viewer-a')).cuerpo.token;
      const tokB = (await login(B.host, 'admin-b')).cuerpo.token;

      // 2) Un usuario de B no existe en el host de A; bloqueo tras 5 fallos persiste aunque el login falle.
      assert((await login(A.host, 'admin-b')).codigo === 401, 'usuario de B autenticado en el host de A');
      for (let i = 0; i < 5; i++) assert((await login(A.host, 'bloqueo-a', 'incorrecta-' + i)).codigo === 401, 'intento fallido no devolvió 401');
      const bloqueado = await login(A.host, 'bloqueo-a');
      assert(bloqueado.codigo === 429, `tras 5 fallos la contraseña correcta no se bloqueó: ${bloqueado.codigo}`);

      // 3) Token de A en el host de B → 403; en A → solo choferes de A.
      const cruzado = await api('get', '/drivers', { host: B.host, token: tokA });
      assert(cruzado.codigo === 403 && /otra empresa/.test(cruzado.cuerpo.error), `token de A en B: ${cruzado.codigo}`);
      const choferesA = await api('get', '/drivers', { host: A.host, token: tokA });
      const idsA = new Set(choferesA.cuerpo.map(d => d.id));
      assert(choferesA.codigo === 200 && idsA.size === 2 && idsA.has(dA1) && idsA.has(dA2) && !idsA.has(dB1), `choferes de A: ${JSON.stringify(choferesA.cuerpo)}`);
      assert(choferesA.cuerpo.every(d => 'status' in d && 'mc_number' in d), 'columnas de esquema v7.2 ausentes');

      // 4) Tokens manipulados.
      const [h, p, s] = tokA.split('.');
      const pMod = b64u(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), tid: B.id }));
      assert((await api('get', '/drivers', { host: B.host, token: `${h}.${pMod}.${s}` })).codigo === 401, 'token con tid alterado aceptado');
      const none = `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${p}.`;
      assert((await api('get', '/drivers', { host: A.host, token: none })).codigo === 401, 'token alg=none aceptado');
      assert((await api('get', '/drivers', { host: A.host })).codigo === 401, 'petición sin token aceptada');

      // 5) Permisos y límite de plan (max_trucks=3).
      const crear = (token, nombre) => api('post', '/drivers', { host: A.host, token, body: { nombre, telefono: '(305) 555-0199', mc: 'MC123456', camion: 'T-9' } });
      assert((await crear(tokViewer, 'Intruso')).codigo === 403, 'VIEWER creó un chofer');
      const nuevo = await crear(tokDisp, 'Tercero');
      assert(nuevo.codigo === 201 && nuevo.cuerpo.id, `DISPATCHER no pudo crear: ${nuevo.codigo} ${JSON.stringify(nuevo.cuerpo)}`);
      const { rows: [fila] } = await admin.query('SELECT tenant_id, mc_number, truck_number FROM drivers WHERE id=$1', [nuevo.cuerpo.id]);
      assert(fila.tenant_id === A.id && fila.mc_number === 'MC123456' && fila.truck_number === 'T-9', 'chofer persistido con datos incorrectos');
      const limite = await crear(tokDisp, 'Cuarto');
      assert(limite.codigo === 403 && /Límite del plan/.test(limite.cuerpo.error), `límite de plan no aplicado: ${limite.codigo}`);
      const errorBd = await api('post', '/drivers', { host: B.host, token: tokB, body: { nombre: 'x'.repeat(300), telefono: '3055550100' } });
      assert(errorBd.codigo === 500, `error de BD no propagado: ${errorBd.codigo}`);
      const { rows: [sinParcial] } = await admin.query("SELECT count(*)::int AS n FROM drivers WHERE tenant_id=$1 AND length(full_name) > 255", [B.id]);
      assert(sinParcial.n === 0, 'la transacción fallida dejó datos');

      // 6) Verificación y asignación con outbox atómico.
      assert((await api('get', `/drivers/${dB1}/verificacion`, { host: A.host, token: tokA })).cuerpo.estado === 'BLOQUEADO', 'A ve la verificación de un chofer de B');
      assert((await api('get', `/drivers/${dA1}/verificacion`, { host: A.host, token: tokA })).cuerpo.estado === 'VERIFICADO', 'verificación propia no visible');
      const asignar = (driverId) => api('post', `/loads/${LA1.id}/asignar`, { host: A.host, token: tokDisp, body: { driverId } });
      assert((await asignar('no-uuid')).codigo === 400, 'driverId inválido aceptado');
      assert((await asignar(dA2)).codigo === 403, 'chofer no verificado asignado');
      assert((await asignar(dB1)).codigo === 403, 'chofer de otra empresa asignado');
      const ok = await asignar(dA1);
      assert(ok.codigo === 201 && ok.cuerpo.bookingId, `asignación: ${ok.codigo} ${JSON.stringify(ok.cuerpo)}`);
      const { rows: ev } = await admin.query(`SELECT tenant_id, payload FROM outbox WHERE tipo='carga.ofertada' AND payload->>'bookingId' = $1`, [ok.cuerpo.bookingId]);
      assert(ev.length === 1 && ev[0].tenant_id === A.id, `evento outbox: ${ev.length}`);
      assert((await asignar(dA1)).codigo === 409, 'segunda asignación aceptada');
      assert((await api('post', `/drivers/${dA1}/documentos`, { host: A.host, token: tokDisp, body: {} })).codigo === 403, 'DISPATCHER subió documentos de un chofer');

      // 7) Cargas, reportes, aprobaciones.
      assert((await api('get', '/loads', { host: B.host, token: tokB })).cuerpo.every(l => l.id !== LA1.id), 'B ve cargas de A');
      const rep = await api('get', '/reportes/mensual', { host: A.host, token: tokViewer });
      assert(rep.codigo === 200 && rep.cuerpo.cargas === 1 && rep.cuerpo.facturado === '0', `reporte: ${JSON.stringify(rep.cuerpo)}`);
      assert((await api('get', '/reportes/mensual', { host: A.host, token: tokDisp })).codigo === 403, 'DISPATCHER leyó reportes');
      assert((await api('post', `/aprobaciones/${crypto.randomUUID()}/si`, { host: A.host, token: tokA })).codigo === 501, 'aprobaciones no responde 501');

      // 8) Concurrencia: 40 peticiones alternando empresas con 4 conexiones → nunca se cruzan datos.
      const lote = await Promise.all(Array.from({ length: 40 }, (_, i) => i % 2
        ? api('get', '/drivers', { host: A.host, token: tokA }).then(r => ({ t: 'A', r }))
        : api('get', '/drivers', { host: B.host, token: tokB }).then(r => ({ t: 'B', r }))));
      for (const { t, r } of lote) {
        assert(r.codigo === 200, `concurrencia: ${r.codigo}`);
        const ids = r.cuerpo.map(d => d.id);
        if (t === 'A') assert(!ids.includes(dB1) && ids.includes(dA1), 'A recibió datos de B bajo concurrencia');
        else assert(ids.length === 1 && ids[0] === dB1, 'B recibió datos de A bajo concurrencia');
      }

      // 9) Higiene del pool: ninguna conexión conserva contexto de tenant tras las peticiones.
      const clientes = await Promise.all(Array.from({ length: 4 }, () => app.connect()));
      try {
        for (const c of clientes) {
          const { rows: [x] } = await c.query("SELECT coalesce(current_setting('app.current_tenant', true), '') AS t");
          assert(x.t === '', `conexión del pool con contexto residual: ${x.t}`);
        }
      } finally { clientes.forEach(c => c.release()); }

      // 10) Logout revoca la sesión.
      const fuera = await api('post', '/auth/logout', { host: A.host, token: tokViewer });
      assert(fuera.codigo === 200 && fuera.cuerpo.revocadas === 1, `logout: ${JSON.stringify(fuera.cuerpo)}`);
      assert((await api('get', '/drivers', { host: A.host, token: tokViewer })).codigo === 401, 'sesión revocada sigue activa');
      return 'Host→empresa (subdominio, dominio propio, suspendida/trial 402); login aislado por empresa; bloqueo 5 fallos persistente; token de otra empresa 403; tid/alg manipulados 401; permisos y límite de plan; rollback ante error de BD; asignación con outbox atómico; 40 peticiones concurrentes sin cruce con 4 conexiones; pool sin contexto residual; logout revoca';
    });

    console.log('\nRESULTADO PostgreSQL T18');
    console.table(results);
    console.log(`TOTAL ${results.filter(x => x.status === 'PASS').length}/${TOTAL} PASS`);
    if (results.filter(x => x.status === 'PASS').length !== TOTAL) process.exitCode = 1;
  } catch (e) {
    if (!results.some(r => r.status === 'FAIL')) console.error(`ERROR FUERA DE PRUEBA: ${e.message}`);
    console.error('\nSUITE ABORTADA: no se considera aprobada.');
    process.exitCode = 1;
  } finally {
    auth.configurarProveedores(null);
    await Promise.allSettled([admin.end(), app.end()]);
  }
})();
