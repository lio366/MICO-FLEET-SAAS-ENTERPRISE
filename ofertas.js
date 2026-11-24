'use strict';
// Servicio de ofertas para canales sin sesión (SMS y voz de Twilio) — E-025.
// 1. Resolver el tenant con las funciones SECURITY DEFINER de la migración 004
//    (mf_resolver_chofer_por_telefono / mf_resolver_reserva), que solo devuelven ids.
// 2. Todo lo demás ocurre dentro de una transacción con app.current_tenant fijado (RLS normal).
// 3. Aceptar/rechazar pasa por 46.responderOfertaUnaVez: exactamente una vez y, al rechazar,
//    la carga vuelve a AVAILABLE en la misma transacción.
const candado = require('../../46_distributed_lock');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Variantes en dígitos de un número entrante (E.164 de Twilio frente a formatos guardados).
// '+13055551234' → ['13055551234', '3055551234'];  '3055551234' → ['3055551234', '13055551234'].
function candidatosTelefono(numero) {
  const digitos = String(numero ?? '').replace(/[^0-9]/g, '');
  if (digitos.length < 7 || digitos.length > 15) return [];
  const set = new Set([digitos]);
  if (digitos.length === 11 && digitos.startsWith('1')) set.add(digitos.slice(1));
  if (digitos.length === 10) set.add('1' + digitos);
  return [...set].slice(0, 3);
}

async function enTenant(pool, tenantId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function resolverChoferes(pool, numero) {
  const candidatos = candidatosTelefono(numero);
  if (!candidatos.length) return [];
  const { rows } = await pool.query('SELECT driver_id, tenant_id FROM mf_resolver_chofer_por_telefono($1::text[])', [candidatos]);
  return rows;
}

const SQL_OFERTA = `
  SELECT b.id AS booking_id, b.tenant_id, b.driver_id, b.load_id, b.assigned_at,
         d.full_name AS chofer_nombre, l.origin_city, l.dest_city, l.rate
  FROM bookings b
  JOIN drivers d ON d.id = b.driver_id
  LEFT JOIN loads l ON l.id = b.load_id
  WHERE b.status = 'OFFERED' AND b.driver_id = $1
  ORDER BY b.assigned_at DESC NULLS LAST
  LIMIT 1`;

// Oferta pendiente más reciente del número, entre todas las empresas donde trabaja ese teléfono.
async function ofertaPendientePorTelefono(pool, numero) {
  const choferes = await resolverChoferes(pool, numero);
  if (!choferes.length) return { chofer: null, oferta: null };
  let mejor = null;
  for (const { driver_id: driverId, tenant_id: tenantId } of choferes) {
    const fila = await enTenant(pool, tenantId, async c => (await c.query(SQL_OFERTA, [driverId])).rows[0] || null);
    if (fila && (!mejor || new Date(fila.assigned_at || 0) > new Date(mejor.assigned_at || 0))) mejor = fila;
  }
  return { chofer: choferes[0], oferta: mejor };
}

async function datosReserva(pool, bookingId) {
  if (typeof bookingId !== 'string' || !UUID.test(bookingId)) return null;
  const { rows } = await pool.query('SELECT tenant_id, driver_id FROM mf_resolver_reserva($1::uuid)', [bookingId]);
  if (!rows.length) return null;
  const tenantId = rows[0].tenant_id;
  return enTenant(pool, tenantId, async c => {
    const r = await c.query(
      `SELECT b.id AS booking_id, b.tenant_id, b.status, d.full_name AS chofer_nombre,
              l.origin_city, l.dest_city, l.rate
       FROM bookings b JOIN drivers d ON d.id = b.driver_id LEFT JOIN loads l ON l.id = b.load_id
       WHERE b.id = $1`, [bookingId]);
    return r.rows[0] || null;
  });
}

function responder(pool, { bookingId, tenantId, acepta }) {
  return candado.responderOfertaUnaVez(pool, { bookingId, tenantId, acepta });
}

const ruta = (o) => `${o.origin_city || '¿?'}→${o.dest_city || '¿?'}`;

// Adaptador con la interfaz que espera 38_modo_voz_auricular.webhookDecision.
function crearAdaptadorVoz(pool, { alRechazar = null } = {}) {
  return {
    async obtenerBooking(bookingId) {
      const o = await datosReserva(pool, bookingId);
      if (!o) return null;
      return { id: o.booking_id, tenantId: o.tenant_id, status: o.status, choferNombre: o.chofer_nombre, ruta: ruta(o), pago: o.rate };
    },
    async confirmarBooking(bookingId) {
      const o = await datosReserva(pool, bookingId);
      if (!o) return { respondida: false, motivo: 'reserva inexistente' };
      return (await responder(pool, { bookingId, tenantId: o.tenant_id, acepta: true })).resultado;
    },
    async rechazarYReasignar(bookingId) {
      const o = await datosReserva(pool, bookingId);
      if (!o) return { respondida: false, motivo: 'reserva inexistente' };
      const r = (await responder(pool, { bookingId, tenantId: o.tenant_id, acepta: false })).resultado;
      if (r.respondida && r.cargaLiberada && alRechazar) {
        try { await alRechazar({ bookingId, tenantId: o.tenant_id, loadId: r.loadId }); } catch (_) { /* reasignar es best-effort */ }
      }
      return r;
    },
  };
}

module.exports = { candidatosTelefono, resolverChoferes, ofertaPendientePorTelefono, datosReserva,
                   responder, crearAdaptadorVoz, ruta };
