// ============================================================================
// server/api/routes.js — ENDPOINTS DE LA API AUTENTICADA
// Versión 7.2 (E-028, E-029)
//
// Cadena por ruta: [requireAuth] → [requirePermiso] → [límite de plan] → manejador.
// El gateway ya ejecutó identificarTenant → verificarSuscripcion → adjuntarContexto, así que
// cada manejador accede a los datos SOLO mediante req.enTenant(fn): transacción con
// app.current_tenant local; RLS limita cada consulta a la empresa del Host.
//
// crearDefinicionesApi() no depende de Express: las pruebas de integración ejecutan estas
// mismas cadenas contra PostgreSQL real (tests/integration/postgres_t18.js).
// ============================================================================

const auth = require('../../41_auth_rbac');
const verificacion = require('../../33_verificacion_carrier');
const bus = require('../../44_event_bus');
const candado = require('../../46_distributed_lock');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esUuid = (v) => typeof v === 'string' && UUID.test(v);

// Errores con status < 500 (validación, credenciales, bloqueo) → JSON; el resto → manejador de errores.
const seguro = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); }
  catch (e) {
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
    return next(e);
  }
};

function crearDefinicionesApi({ db, tenantMiddleware = null }) {
  const autenticado = auth.requireAuth(db);
  const permiso = auth.requirePermiso;
  const limiteChoferes = tenantMiddleware ? [tenantMiddleware.checkPlanLimit('drivers')] : [];

  return [
    // ── Auth ────────────────────────────────────────────────────────────
    { metodo: 'post', ruta: '/auth/login', cadena: [seguro(async (req, res) => {
      const { email, password } = req.body || {};
      const r = await auth.login(db, { tenantId: req.tenant.id, email, password,
        ip: req.ip || null, userAgent: (req.headers && req.headers['user-agent']) || null });
      res.json(r);
    })] },

    { metodo: 'post', ruta: '/auth/logout', cadena: [autenticado, seguro(async (req, res) => {
      const r = await auth.logout(db, { tenantId: req.tenant.id, token: req.headers.authorization.slice(7) });
      res.json({ ok: true, revocadas: r.revocadas });
    })] },

    // ── Choferes ────────────────────────────────────────────────────────
    { metodo: 'get', ruta: '/drivers', cadena: [autenticado, permiso('drivers:read'), seguro(async (req, res) => {
      const { rows } = await req.enTenant((c) => c.query(
        `SELECT id, full_name, phone, truck_number, mc_number, status, hos_status
         FROM drivers WHERE is_active IS TRUE ORDER BY full_name`), { soloLectura: true });
      res.json(rows);
    })] },

    { metodo: 'post', ruta: '/drivers', cadena: [autenticado, permiso('drivers:write'), ...limiteChoferes, seguro(async (req, res) => {
      const { nombre, telefono, mc = null, camion = null } = req.body || {};
      const digitos = String(telefono || '').replace(/\D/g, '');
      if (!nombre || digitos.length < 10) return res.status(400).json({ error: 'nombre y telefono (10+ dígitos) son obligatorios' });
      const { rows } = await req.enTenant((c) => c.query(
        `INSERT INTO drivers (tenant_id, full_name, phone, mc_number, truck_number, is_active)
         VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id`,
        [req.tenant.id, String(nombre).trim(), String(telefono).trim(), mc, camion]));
      res.status(201).json({ id: rows[0].id });
    })] },

    // Sello de verificación de un chofer (panel del broker)
    { metodo: 'get', ruta: '/drivers/:id/verificacion', cadena: [autenticado, permiso('drivers:read'), seguro(async (req, res) => {
      if (!esUuid(req.params.id)) return res.status(400).json({ error: 'id de chofer inválido' });
      const r = await req.enTenant((c) => verificacion.veredictoVerificacion(c, req.tenant.id, req.params.id), { soloLectura: true });
      res.json(r);
    })] },

    // El chofer sube su evidencia física desde la app (Capa 4)
    { metodo: 'post', ruta: '/drivers/:id/documentos', cadena: [autenticado, seguro(async (req, res) => {
      if (req.usuario.rol !== 'DRIVER' || req.usuario.uid !== req.params.id) {
        return res.status(403).json({ error: 'Solo el propio chofer sube sus documentos' });
      }
      const r = await req.enTenant((c) => verificacion.capa4_evidenciaFisica(c, req.tenant.id, req.params.id, req.body || {}));
      res.json(r === undefined ? { ok: true } : r);
    })] },

    // ── Cargas y asignación ─────────────────────────────────────────────
    { metodo: 'get', ruta: '/loads', cadena: [autenticado, permiso('loads:read'), seguro(async (req, res) => {
      const { rows } = await req.enTenant((c) => c.query(
        `SELECT id, origin_city, origin_state, dest_city, dest_state, miles, rate, equipment, pickup_at, delivery_at, status
         FROM loads WHERE status='AVAILABLE' ORDER BY created_at DESC LIMIT 100`), { soloLectura: true });
      res.json(rows);
    })] },

    { metodo: 'post', ruta: '/loads/:id/asignar', cadena: [autenticado, permiso('loads:assign'), seguro(async (req, res) => {
      const driverId = (req.body || {}).driverId;
      if (!esUuid(req.params.id) || !esUuid(driverId)) return res.status(400).json({ error: 'loadId y driverId deben ser UUID' });
      const veredicto = await req.enTenant((c) => verificacion.veredictoVerificacion(c, req.tenant.id, driverId), { soloLectura: true });
      if (veredicto.estado !== 'VERIFICADO') {
        return res.status(403).json({ error: 'Chofer no verificado. La seguridad lo bloquea: ' + veredicto.motivo });
      }
      // Asignación exactamente-una-vez (D-015) y evento en el outbox EN LA MISMA transacción.
      let r;
      try {
        r = await candado.asignarCargaUnaVez(db, {
          loadId: req.params.id, driverId, tenantId: req.tenant.id,
          alAsignar: (client, { bookingId }) => bus.publicar(null, client, { tenantId: req.tenant.id, tipo: 'carga.ofertada',
            payload: { loadId: req.params.id, driverId, bookingId } }),
        });
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'La carga ya tiene una reserva activa' });
        throw e;
      }
      if (!r.resultado.asignada) return res.status(409).json({ error: r.resultado.motivo });
      res.status(201).json({ loadId: req.params.id, bookingId: r.resultado.bookingId, status: 'OFFERED' });
    })] },

    // El "SÍ" humano del modo 95%: no existe esquema ni productor de aprobaciones (E-033).
    { metodo: 'post', ruta: '/aprobaciones/:id/si', cadena: [autenticado, permiso('loads:approve_si'), (req, res) =>
      res.status(501).json({ error: 'Aprobaciones del modo 95% aún no implementadas (sin esquema): E-033' })] },

    // ── Reportes ────────────────────────────────────────────────────────
    { metodo: 'get', ruta: '/reportes/mensual', cadena: [autenticado, permiso('reports:read'), seguro(async (req, res) => {
      const { rows } = await req.enTenant((c) => c.query(
        `SELECT (SELECT count(*)::int FROM bookings
                 WHERE assigned_at >= date_trunc('month', now()) AND status NOT IN ('REJECTED','CANCELLED')) AS cargas,
                (SELECT coalesce(sum(monto), 0)::text FROM invoices
                 WHERE creada_en >= date_trunc('month', now()) AND estado <> 'ANULADA') AS facturado`), { soloLectura: true });
      res.json(rows[0]);
    })] },
  ];
}

module.exports = function crearRutas({ db, tenantMiddleware = null }) {
  const r = require('express').Router();
  for (const d of crearDefinicionesApi({ db, tenantMiddleware })) r[d.metodo](d.ruta, ...d.cadena);
  return r;
};
module.exports.crearDefinicionesApi = crearDefinicionesApi;
