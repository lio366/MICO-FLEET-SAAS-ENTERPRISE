// ============================================================================
// 46_distributed_lock.js — CANDADO DISTRIBUIDO (nada pasa dos veces)
// Versión 7.0 (esquema de operaciones v7; contexto de tenant bajo RLS)
//
// CON EL SERVER/ EN VARIAS RÉPLICAS (o varios workers), dos procesos pueden
// intentar a la vez: asignar la MISMA carga a dos camiones, registrar el
// MISMO pago dos veces, despachar dos veces, facturar dos veces.
// Este candado resuelve los 4 casos con DOS mecanismos redundantes:
//
//   MECANISMO 1 — Candado distribuido: Postgres advisory lock por clave
//     (`carga:4521:asignacion`). Solo un proceso entra; los demás esperan o
//     reciben "ya está siendo procesado".
//   MECANISMO 2 — Estado idempotente: el propio UPDATE condicional de la
//     base de datos (`... WHERE status='AVAILABLE' RETURNING`). Aunque el
//     candado fallara, el segundo proceso actualiza 0 filas y sabe que
//     perdió la carrera. El candado es velocidad; el UPDATE es la verdad.
//
// REGLA: TODA operación de dinero o de carga pasa por `ejecutarUnaVez`.
// ============================================================================

const crypto = require('crypto');

// Llave de 64 bits estable para advisory locks: primeros 8 bytes del SHA-256
// de la clave, interpretados como entero CON SIGNO en complemento a dos
// (bigint de PostgreSQL: -2^63 .. 2^63-1), como decimal en string.
// Sin BigInt.asIntN, la mitad de las claves (bit alto = 1) superaban 2^63-1 y
// PostgreSQL las rechazaba con "out of range for type bigint" (E-019).
// No depende de Buffer.readBigInt64, ausente en algunos entornos.
function llave64(clave) {
  const h = crypto.createHash('sha256').update(String(clave)).digest();
  return BigInt.asIntN(64, BigInt('0x' + h.toString('hex', 0, 8))).toString();
}

// Obtener el candado (advisory xact lock). Se libera solo al COMMIT/ROLLBACK
// de la transacción: imposible olvidar soltarlo.
async function obtenerCandado(client, clave) {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [llave64(clave)]);
}

// Intento NO bloqueante: si otro proceso lo tiene, devuelve false al instante.
async function intentarCandado(client, clave) {
  const r = await client.query('SELECT pg_try_advisory_xact_lock($1::bigint)', [llave64(clave)]);
  return r.rows[0].pg_try_advisory_xact_lock === true;
}

// ---------------------------------------------------------------------------
// NÚCLEO: ejecutar fn() con candado + verificación de "exactamente una vez".
// db debe ser un Pool (pg). fn(client) corre dentro de BEGIN/COMMIT con el candado tomado.
// tenantId (obligatorio para tablas con RLS): fija app.current_tenant SOLO para esta
// transacción (set_config local), de modo que el rol runtime vea y modifique únicamente
// filas de ese tenant. Sin él, bajo RLS, todo UPDATE afectaría 0 filas (E-022).
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exigirUuid(valor, nombre) {
  if (typeof valor !== 'string' || !UUID.test(valor)) {
    throw Object.assign(new Error(`${nombre} debe ser un UUID válido`), { code: 'PARAMETRO_INVALIDO', status: 400 });
  }
}

async function ejecutarUnaVez(db, clave, fn, { esperar = true, tenantId = null } = {}) {
  if (tenantId !== null) exigirUuid(tenantId, 'tenantId');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== null) {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    }
    const tomado = esperar ? (await obtenerCandado(client, clave), true)
                           : await intentarCandado(client, clave);
    if (!tomado) {
      await client.query('ROLLBACK');
      return { ejecutado: false, motivo: 'Otro proceso ya lo está haciendo' };
    }
    const resultado = await fn(client);        // fn hace sus UPDATEs condicionales aquí
    await client.query('COMMIT');
    return { ejecutado: true, resultado };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// LOS 4 CASOS PROTEGIDOS — sobre el esquema v7 (migrations/002_operaciones_v7).
// bookings es la fuente de verdad de la asignación (D-015). Cada caso combina:
//   candado por clave (velocidad) + UPDATE/INSERT condicional + índice único (verdad final).
// ---------------------------------------------------------------------------

// CASO 1 — DOBLE ASIGNACIÓN DE CARGA
// La carga pasa de AVAILABLE a OFFERED y nace UNA reserva OFFERED para el chofer.
// El segundo proceso ve la carga ya ofertada y no crea otra reserva; además
// uq_bookings_carga_activa impide dos reservas activas aunque alguien omita el candado.
// alAsignar(client, { bookingId }) — opcional: corre DENTRO de la misma transacción tras crear la
// reserva (p. ej. escribir el evento en el outbox de 44): asignación y evento se confirman juntos.
async function asignarCargaUnaVez(db, { loadId, driverId, tenantId, alAsignar = null }) {
  exigirUuid(loadId, 'loadId'); exigirUuid(driverId, 'driverId'); exigirUuid(tenantId, 'tenantId');
  return ejecutarUnaVez(db, `carga:${loadId}:asignacion`, async (client) => {
    // Bajo RLS, el chofer solo es visible si pertenece al tenant del contexto.
    const chofer = await client.query('SELECT 1 FROM drivers WHERE id=$1 AND tenant_id=$2', [driverId, tenantId]);
    if (!chofer.rows.length) return { asignada: false, motivo: 'El chofer no pertenece a esta empresa' };
    const carga = await client.query(
      `UPDATE loads SET status='OFFERED'
       WHERE id=$1 AND tenant_id=$2 AND status='AVAILABLE' RETURNING id`,
      [loadId, tenantId]);
    if (!carga.rows.length) return { asignada: false, motivo: 'La carga ya no está disponible (otro proceso la tomó)' };
    const reserva = await client.query(
      `INSERT INTO bookings (tenant_id, load_id, driver_id, status, assigned_at)
       VALUES ($1,$2,$3,'OFFERED', now()) RETURNING id`,
      [tenantId, loadId, driverId]);
    const bookingId = reserva.rows[0].id;
    if (typeof alAsignar === 'function') await alAsignar(client, { bookingId });
    return { asignada: true, bookingId };
  }, { tenantId });
}

// CASO 1b — RESPUESTA A UNA OFERTA (SMS, voz o app): exactamente una vez.
// Solo una reserva OFFERED cambia: aceptar → CONFIRMED; rechazar → REJECTED y la carga
// vuelve a AVAILABLE en la MISMA transacción, para poder reasignarla (E-025).
// Twilio reintenta webhooks: la segunda respuesta encuentra la reserva ya resuelta y no cambia nada.
async function responderOfertaUnaVez(db, { bookingId, tenantId, acepta }) {
  exigirUuid(bookingId, 'bookingId'); exigirUuid(tenantId, 'tenantId');
  if (typeof acepta !== 'boolean') {
    throw Object.assign(new Error('acepta debe ser booleano'), { code: 'PARAMETRO_INVALIDO', status: 400 });
  }
  return ejecutarUnaVez(db, `oferta:${bookingId}`, async (client) => {
    const r = await client.query(
      `UPDATE bookings SET status=$3
       WHERE id=$1 AND tenant_id=$2 AND status='OFFERED' RETURNING load_id`,
      [bookingId, tenantId, acepta ? 'CONFIRMED' : 'REJECTED']);
    if (!r.rows.length) return { respondida: false, motivo: 'La oferta ya fue respondida o no existe' };
    let cargaLiberada = false;
    if (!acepta && r.rows[0].load_id) {
      const l = await client.query(
        `UPDATE loads SET status='AVAILABLE' WHERE id=$1 AND tenant_id=$2 AND status='OFFERED' RETURNING id`,
        [r.rows[0].load_id, tenantId]);
      cargaLiberada = l.rows.length === 1;
    }
    return { respondida: true, estado: acepta ? 'CONFIRMED' : 'REJECTED', loadId: r.rows[0].load_id, cargaLiberada };
  }, { tenantId });
}

// CASO 2 — DOBLE PAGO
// Clave por reserva: dos eventos de pago distintos para la misma reserva también se
// serializan. Solo una reserva DELIVERED o INVOICED pasa a PAID; la factura vigente
// queda PAGADA en la misma transacción. Reentregar el evento 10 veces paga 1 sola vez.
async function registrarPagoUnaVez(db, { paymentId, bookingId, monto, tenantId }) {
  exigirUuid(bookingId, 'bookingId'); exigirUuid(tenantId, 'tenantId');
  const importe = Number(monto);
  if (!Number.isFinite(importe) || importe <= 0) {
    throw Object.assign(new Error('monto debe ser un número positivo'), { code: 'PARAMETRO_INVALIDO', status: 400 });
  }
  return ejecutarUnaVez(db, `pago:${bookingId}`, async (client) => {
    const r = await client.query(
      `UPDATE bookings SET status='PAID', paid_at=now(), paid_amount=$1
       WHERE id=$2 AND tenant_id=$3 AND status IN ('DELIVERED','INVOICED') RETURNING id`,
      [importe.toFixed(2), bookingId, tenantId]);
    if (!r.rows.length) return { pagado: false, motivo: 'Este pago ya fue registrado o la carga no está entregada', paymentId: paymentId ?? null };
    await client.query(
      `UPDATE invoices SET estado='PAGADA', pagada_en=now()
       WHERE booking_id=$1 AND tenant_id=$2 AND estado IN ('EMITIDA','ENVIADA')`,
      [bookingId, tenantId]);
    return { pagado: true, paymentId: paymentId ?? null };
  }, { tenantId });
}

// CASO 3 — DOBLE DESPACHO
// Clave por reserva: solo la primera pasa de CONFIRMED a DISPATCHED.
async function despacharUnaVez(db, { bookingId, tenantId }) {
  exigirUuid(bookingId, 'bookingId'); exigirUuid(tenantId, 'tenantId');
  return ejecutarUnaVez(db, `despacho:${bookingId}`, async (client) => {
    const r = await client.query(
      `UPDATE bookings SET status='DISPATCHED', dispatched_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status='CONFIRMED' RETURNING id`,
      [bookingId, tenantId]);
    if (!r.rows.length) return { despachado: false, motivo: 'Ya fue despachado o no está confirmado' };
    return { despachado: true };
  }, { tenantId });
}

// CASO 4 — DOBLE FACTURACIÓN
// Solo se factura una reserva DELIVERED. El número sale de invoice_seq bajo candado y
// uq_invoices_booking_vigente garantiza una sola factura vigente por reserva.
// quickbooks (opcional) se invoca DENTRO de la transacción: si falla, no queda factura.
async function facturarUnaVez(db, { bookingId, tenantId, quickbooks = null }) {
  exigirUuid(bookingId, 'bookingId'); exigirUuid(tenantId, 'tenantId');
  return ejecutarUnaVez(db, `factura:${bookingId}`, async (client) => {
    const reserva = await client.query(
      `SELECT b.status, l.rate FROM bookings b JOIN loads l ON l.id = b.load_id
       WHERE b.id=$1 AND b.tenant_id=$2`, [bookingId, tenantId]);
    if (!reserva.rows.length) return { facturada: false, motivo: 'Reserva inexistente en esta empresa' };
    const duplicada = await client.query(
      `SELECT numero FROM invoices WHERE booking_id=$1 AND tenant_id=$2 AND estado <> 'ANULADA'`, [bookingId, tenantId]);
    if (duplicada.rows.length) return { facturada: false, motivo: 'Esta carga ya tiene factura', numero: duplicada.rows[0].numero };
    if (reserva.rows[0].status !== 'DELIVERED') return { facturada: false, motivo: 'Solo se factura una carga entregada' };
    const num = await client.query(
      `INSERT INTO invoices (tenant_id, booking_id, numero, estado, monto)
       VALUES ($1, $2, 'INV-' || nextval('invoice_seq'), 'EMITIDA', $3) RETURNING numero`,
      [tenantId, bookingId, reserva.rows[0].rate]);
    const numero = num.rows[0].numero;
    await client.query(
      `UPDATE bookings SET status='INVOICED' WHERE id=$1 AND tenant_id=$2 AND status='DELIVERED'`, [bookingId, tenantId]);
    if (quickbooks) {
      const externo = await quickbooks.crearFactura(bookingId, numero); // dentro: si falla, ROLLBACK
      if (externo && externo.id) {
        await client.query('UPDATE invoices SET qb_invoice_id=$1 WHERE numero=$2', [String(externo.id), numero]);
        await client.query('UPDATE bookings SET invoice_id=$1 WHERE id=$2', [String(externo.id), bookingId]);
      }
    }
    return { facturada: true, numero };
  }, { tenantId });
}

module.exports = { llave64, obtenerCandado, intentarCandado, ejecutarUnaVez,
                   asignarCargaUnaVez, responderOfertaUnaVez, registrarPagoUnaVez,
                   despacharUnaVez, facturarUnaVez };
