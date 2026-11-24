'use strict';
// Contexto de tenant por petición HTTP (E-028). Sin dependencias de Express.
//
// Modelo de aislamiento:
//   1. La empresa se resuelve por el Host (dominio propio o subdominio de APP_BASE_DOMAIN).
//      `tenants` no tiene RLS (se consulta antes de conocer la empresa) y solo se leen columnas públicas.
//   2. Cada acceso a datos de la empresa ocurre en req.enTenant(fn): una transacción sobre UNA
//      conexión del pool con set_config('app.current_tenant', id, true) — local a la transacción.
//      Al terminar (COMMIT o ROLLBACK) el contexto desaparece; la conexión vuelve limpia al pool.
//   3. Nunca se usa set_config(..., false): un contexto de sesión sobrevive en conexiones reutilizadas
//      y otra petición (de otra empresa) heredaría el tenant equivocado.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const COLUMNAS_TENANT = 'id, slug, name, custom_domain, status, plan, max_trucks, max_users, trial_ends_at';

async function enTenant(db, tenantId, fn, { soloLectura = false } = {}) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw Object.assign(new Error('tenantId inválido para el contexto de base de datos'), { status: 500 });
  }
  const c = await db.connect();
  try {
    await c.query(soloLectura ? 'BEGIN READ ONLY' : 'BEGIN');
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Host → { tipo: 'dominio' | 'slug', valor } normalizado; null si no es válido.
function analizarHost(host, dominioBase) {
  if (typeof host !== 'string' || !host) return null;
  const sinPuerto = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(sinPuerto)) return null;
  const base = String(dominioBase || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (base && sinPuerto.endsWith('.' + base)) {
    const slug = sinPuerto.slice(0, -(base.length + 1));
    return SLUG.test(slug) ? { tipo: 'slug', valor: slug } : null;
  }
  return { tipo: 'dominio', valor: sinPuerto };
}

// Resolución con caché en memoria (TTL) — el proyecto no usa Redis (D: descartadas).
// Se cachea también la ausencia (evita consultas repetidas por hosts inexistentes).
function crearResolverTenant({ db, dominioBase = process.env.APP_BASE_DOMAIN || 'tuapp.com', ttlMs = 60000, maxEntradas = 5000, ahora = () => Date.now() } = {}) {
  const cache = new Map();
  async function resolver(host) {
    const h = analizarHost(host, dominioBase);
    if (!h) return null;
    const clave = `${h.tipo}:${h.valor}`;
    const e = cache.get(clave);
    if (e && e.expira > ahora()) return e.tenant;
    const sql = h.tipo === 'slug'
      ? `SELECT ${COLUMNAS_TENANT} FROM tenants WHERE slug = $1`
      : `SELECT ${COLUMNAS_TENANT} FROM tenants WHERE lower(custom_domain) = $1`;
    const { rows } = await db.query(sql, [h.valor]);
    const tenant = rows[0] || null;
    if (cache.size >= maxEntradas) cache.delete(cache.keys().next().value);
    cache.set(clave, { tenant, expira: ahora() + ttlMs });
    return tenant;
  }
  resolver.invalidar = () => cache.clear();
  return resolver;
}

// ── Middlewares (firma Express: req, res, next) ────────────────────────────────
function identificarTenant(resolver) {
  return async function identificarTenantMw(req, res, next) {
    try {
      const tenant = await resolver(req.headers && req.headers.host);
      if (!tenant) {
        return res.status(404).json({ error: 'Empresa no encontrada', message: 'Verifica la dirección web de tu empresa' });
      }
      req.tenant = tenant;
      return next();
    } catch (e) { return next(e); }
  };
}

// Suscripción: SUSPENDED/CANCELLED bloquean; TRIAL vencido bloquea (regla de negocio del archivo 02).
function verificarSuscripcion({ ahora = () => new Date() } = {}) {
  return function verificarSuscripcionMw(req, res, next) {
    const t = req.tenant;
    if (!t) return res.status(500).json({ error: 'Tenant no identificado' });
    if (t.status === 'SUSPENDED' || t.status === 'CANCELLED') {
      return res.status(402).json({ error: 'Suscripción suspendida',
        message: 'Tu acceso está pausado por falta de pago. Regulariza tu plan para continuar.', portal: '/billing' });
    }
    if (t.status === 'TRIAL' && t.trial_ends_at && ahora() > new Date(t.trial_ends_at)) {
      return res.status(402).json({ error: 'Prueba gratuita finalizada',
        message: 'Tu prueba de 14 días terminó. Elige un plan para seguir despachando.', portal: '/billing/plans' });
    }
    return next();
  };
}

// Adjunta req.enTenant(fn, opciones) ligado a la empresa de la petición.
function adjuntarContexto(db) {
  return function adjuntarContextoMw(req, res, next) {
    if (!req.tenant) return res.status(500).json({ error: 'Tenant no identificado' });
    const tenantId = req.tenant.id;
    req.enTenant = (fn, opciones) => enTenant(db, tenantId, fn, opciones);
    return next();
  };
}

// "db" ligado a una empresa para código que espera un Pool (manejadores del bus, workers):
//   query(sql, params) → cada consulta en su propia transacción con el contexto LOCAL de la empresa;
//   connect()          → conexión sin contexto, para código que gestiona su propia transacción y
//                        fija el tenant por sí mismo (ledger 42, candado 46).
function dbDeTenant(db, tenantId) {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new Error('dbDeTenant requiere un tenantId UUID');
  return {
    tenantId,
    query: (sql, params) => enTenant(db, tenantId, (c) => c.query(sql, params)),
    connect: () => db.connect(),
  };
}

module.exports = { enTenant, dbDeTenant, analizarHost, crearResolverTenant, identificarTenant, verificarSuscripcion, adjuntarContexto, COLUMNAS_TENANT };
