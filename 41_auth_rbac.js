// ============================================================================
// 41_auth_rbac.js — QUIÉN ERES Y QUÉ PUEDES TOCAR (Auth + Roles)
// Versión 7.2 (E-028)
//
// ROLES DEL SISTEMA:
//   ADMIN       — el dueño del tenant (broker): todo, incluida facturación
//   DISPATCHER  — empleado del broker: asigna cargas, NO toca pagos ni marca
//   VIEWER      — solo mira (contador, socio)
//   DRIVER      — el chofer: solo VE y responde sus propias cargas
//
// SEGURIDAD: contraseñas con bcrypt (12 rondas), JWT HS256 de 12h ligados a una sesión
// revocable en BD, bloqueo tras 5 intentos fallidos en 15 min.
//
// AISLAMIENTO (v7.2):
//   - users y sesiones tienen RLS: toda lectura/escritura ocurre con app.current_tenant
//     fijado (transacción local). Fuera de ese contexto el rol runtime no ve nada.
//   - requireAuth exige que el tenant del token (tid) sea el tenant del Host de la petición:
//     un token válido de la empresa A NO abre la API de la empresa B.
//   - Los intentos fallidos se registran en su propia transacción (si se registraran dentro de
//     la transacción del login, el error los desharía y el bloqueo nunca se activaría).
//   - Algoritmo JWT fijado a HS256 al verificar (sin "alg confusion" ni "none").
// ============================================================================

const crypto = require('crypto');
const { enTenant } = require('./server/http/contexto_tenant');

const SQL = require('./db/sql').leerSql('41_auth_rbac'); // DDL versionado en sql/41_auth_rbac.sql (E-017)

// Qué puede hacer cada rol (matriz de permisos — la fuente de verdad)
const PERMISOS = {
  'drivers:write':      ['ADMIN', 'DISPATCHER'],
  'drivers:read':       ['ADMIN', 'DISPATCHER', 'VIEWER'],
  'loads:read':         ['ADMIN', 'DISPATCHER', 'VIEWER'],
  'loads:assign':       ['ADMIN', 'DISPATCHER'],
  'loads:approve_si':   ['ADMIN'],                    // la firma humana del 95% automático
  'billing:manage':     ['ADMIN'],
  'branding:manage':    ['ADMIN'],
  'reports:read':       ['ADMIN', 'VIEWER'],
  'family:configure':   ['DRIVER'],                   // el chofer configura SU modo familia
  'driver:respond':     ['DRIVER'],                   // aceptar/rechazar SU carga
};
const ROLES = ['ADMIN', 'DISPATCHER', 'VIEWER', 'DRIVER'];
const MAX_INTENTOS = 5;
const VENTANA_BLOQUEO = '15 minutes';
const DURACION_SESION_H = 12;

// ── Proveedores criptográficos (bcryptjs / jsonwebtoken), cargados al usarse ─────
// Inyectables con configurarProveedores() para entornos sin esas dependencias instaladas.
let proveedores = null;
function proveedoresPorDefecto() {
  return {
    hashPassword: (p) => require('bcryptjs').hash(p, 12),
    compararPassword: (p, h) => require('bcryptjs').compare(p, h),
    firmarToken: (payload, secreto, segundos) =>
      require('jsonwebtoken').sign(payload, secreto, { algorithm: 'HS256', expiresIn: segundos }),
    verificarToken: (token, secreto) =>
      require('jsonwebtoken').verify(token, secreto, { algorithms: ['HS256'] }),
  };
}
function p() { return proveedores || (proveedores = proveedoresPorDefecto()); }
function configurarProveedores(nuevos) { proveedores = nuevos ? { ...proveedoresPorDefecto(), ...nuevos } : null; }

function secretoJwt() {
  const s = process.env.JWT_SECRET;
  if (typeof s !== 'string' || s.length < 32) {
    throw Object.assign(new Error('JWT_SECRET ausente o demasiado corto (mínimo 32 caracteres)'), { status: 500 });
  }
  return s;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const normalizarEmail = (e) => String(e ?? '').trim().toLowerCase();
const error = (status, mensaje) => Object.assign(new Error(mensaje), { status });

// Hash constante para comparar cuando el usuario no existe (mismo coste: no revela qué emails existen).
let hashFicticio = null;
async function compararSeguro(password, hash) {
  if (hash) return p().compararPassword(password, hash);
  if (!hashFicticio) hashFicticio = await p().hashPassword(crypto.randomBytes(16).toString('hex'));
  await p().compararPassword(password, hashFicticio);
  return false;
}

async function crearUsuario(db, { tenantId, nombre, email, password, rol = 'DISPATCHER' }) {
  const correo = normalizarEmail(email);
  if (!nombre || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) throw error(400, 'nombre y email válidos son obligatorios');
  if (!ROLES.includes(rol)) throw error(400, `rol inválido: ${rol}`);
  if (typeof password !== 'string' || password.length < 10) throw error(400, 'La contraseña necesita 10+ caracteres');
  const hash = await p().hashPassword(password);
  return enTenant(db, tenantId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (tenant_id, nombre, email, password_hash, rol) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, nombre, correo, hash, rol]);
    return { id: rows[0].id };
  });
}

async function login(db, { tenantId, email, password, ip = null, userAgent = null }) {
  const correo = normalizarEmail(email);
  if (!correo || typeof password !== 'string' || !password) throw error(400, 'email y contraseña son obligatorios');

  // 1. Bloqueo por intentos (login_intentos no tiene tenant: el bloqueo es por email).
  const { rows: [b] } = await db.query(
    `SELECT count(*)::int AS n FROM login_intentos
     WHERE email=$1 AND exito=FALSE AND intento_en > now() - $2::interval`, [correo, VENTANA_BLOQUEO]);
  if (b.n >= MAX_INTENTOS) throw error(429, 'Cuenta bloqueada 15 min por intentos fallidos');

  // 2. Usuario dentro del contexto del tenant del Host: un usuario de otra empresa no existe aquí.
  const u = await enTenant(db, tenantId, async (c) => (await c.query(
    `SELECT id, nombre, rol, password_hash FROM users WHERE email=$1 AND is_active IS TRUE`, [correo])).rows[0] || null,
    { soloLectura: true });
  const valido = await compararSeguro(password, u && u.password_hash);

  // 3. Registrar el intento en su propia transacción (persiste aunque el login falle).
  await db.query(`INSERT INTO login_intentos (email, exito) VALUES ($1,$2)`, [correo, valido]);
  if (!valido) throw error(401, 'Email o contraseña incorrectos');

  // 4. JWT + sesión revocable (solo el hash del token se guarda).
  const token = p().firmarToken({ uid: u.id, tid: tenantId, rol: u.rol, jti: crypto.randomUUID() }, secretoJwt(), DURACION_SESION_H * 3600);
  await enTenant(db, tenantId, (c) => c.query(
    `INSERT INTO sesiones (tenant_id, user_id, rol, token_hash, ip, user_agent, expira_en)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(hours => $7))`,
    [tenantId, u.id, u.rol, hashToken(token), ip, userAgent, DURACION_SESION_H]));
  return { token, rol: u.rol, nombre: u.nombre };
}

// Middleware: exige sesión válida DE ESTA EMPRESA y adjunta req.usuario = { uid, tid, rol }.
// Requiere que identificarTenant haya fijado req.tenant.
function requireAuth(db) {
  return async (req, res, next) => {
    const header = (req.headers && req.headers.authorization) || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Falta el token de sesión' });
    if (!req.tenant) return res.status(500).json({ error: 'Tenant no identificado' });
    let payload;
    try {
      payload = p().verificarToken(token, secretoJwt());
    } catch (e) {
      if (e.status === 500) return next(e);
      return res.status(401).json({ error: 'Token inválido o vencido' });
    }
    if (!payload || payload.tid !== req.tenant.id) {
      return res.status(403).json({ error: 'El token pertenece a otra empresa' });
    }
    try {
      const valida = await enTenant(db, req.tenant.id, async (c) => (await c.query(
        `SELECT s.rol FROM sesiones s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash=$1 AND s.user_id=$2 AND s.revocada IS FALSE AND s.expira_en > now() AND u.is_active IS TRUE`,
        [hashToken(token), payload.uid])).rows[0] || null, { soloLectura: true });
      if (!valida) return res.status(401).json({ error: 'Sesión cerrada o vencida' });
      // El rol vigente es el de la sesión en BD, no el que trae el token.
      req.usuario = { uid: payload.uid, tid: payload.tid, rol: valida.rol };
      req.tokenHash = hashToken(token);
      return next();
    } catch (e) { return next(e); }
  };
}

// Middleware: exige un permiso específico según la matriz
function requirePermiso(permiso) {
  return (req, res, next) => {
    const permitidos = PERMISOS[permiso] || [];
    if (!req.usuario || !permitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ error: `Permiso denegado: se requiere rol ${permitidos.join(' o ')}` });
    }
    req.permiso = permiso;
    return next();
  };
}

// Cierra la sesión del token dentro de su empresa.
async function logout(db, { tenantId, token }) {
  const { rowCount } = await enTenant(db, tenantId, (c) =>
    c.query(`UPDATE sesiones SET revocada=TRUE WHERE token_hash=$1 AND revocada IS FALSE`, [hashToken(token)]));
  return { revocadas: rowCount };
}

// Cambio de contraseña con verificación de la actual; cierra todas las sesiones del usuario.
async function cambiarPassword(db, { tenantId, userId, actual, nueva }) {
  if (typeof nueva !== 'string' || nueva.length < 10) throw error(400, 'La nueva contraseña necesita 10+ caracteres');
  const fila = await enTenant(db, tenantId, async (c) =>
    (await c.query(`SELECT password_hash FROM users WHERE id=$1`, [userId])).rows[0] || null, { soloLectura: true });
  if (!fila || !(await p().compararPassword(actual, fila.password_hash))) throw error(400, 'Contraseña actual incorrecta');
  const hash = await p().hashPassword(nueva);
  await enTenant(db, tenantId, async (c) => {
    await c.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, userId]);
    await c.query(`UPDATE sesiones SET revocada=TRUE WHERE user_id=$1`, [userId]);
  });
  return { ok: true };
}

module.exports = { SQL, PERMISOS, ROLES, crearUsuario, login, requireAuth, requirePermiso, logout, cambiarPassword,
                   configurarProveedores, hashToken };
