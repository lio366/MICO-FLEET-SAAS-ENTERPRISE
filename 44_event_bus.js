// ============================================================================
// 44_event_bus.js — EL SISTEMA NERVIOSO (Event Bus + Outbox)
// Versión 7.3 (multiempresa bajo RLS, lease + reintentos + cola de fallidos: E-031)
//
// PROBLEMA QUE EVITA: los agentes llamándose unos a otros en cadena. Si el
// agente de despacho llama directo al de voz y el de voz falla, la carga se
// pierde a media operación. Con el bus, cada pieza PUBLICA un evento y sigue;
// los interesados lo PROCESAN a su ritmo, con reintentos e idempotencia.
//
// PATRÓN OUTBOX: el evento se guarda EN LA MISMA transacción que el cambio
// de datos → imposible perderlo aunque el proceso caiga después.
// ============================================================================

const SQL = require('./db/sql').leerSql('44_event_bus'); // DDL versionado en sql/44_event_bus.sql (E-017)
const { enTenant, dbDeTenant } = require('./server/http/contexto_tenant');
const metricas = () => require('./43_metrics_observability'); // carga perezosa, sin ciclo

// ---------------------------------------------------------------------------
// Publicar = INSERT en outbox (dentro de la transacción del cambio).
// El worker (server/workers/eventWorker.js) lo reparte a los suscriptores.
// ---------------------------------------------------------------------------
async function publicar(db, client, { tenantId, tipo, payload }) {
  await client.query(
    `INSERT INTO outbox (tenant_id, tipo, payload) VALUES ($1,$2,$3)`,
    [tenantId, tipo, JSON.stringify(payload)]);
}

// Suscripciones en memoria: tipo → [handlers]. El worker las llama en orden.
const suscriptores = new Map();
function suscribir(tipo, nombreSuscriptor, handler) {
  if (!suscriptores.has(tipo)) suscriptores.set(tipo, []);
  suscriptores.get(tipo).push({ nombreSuscriptor, handler });
}

// ---------------------------------------------------------------------------
// PROCESAMIENTO MULTIEMPRESA (v7.3, E-031)
//   1. mf_tenants_con_eventos_pendientes() (SECURITY DEFINER, solo ids) dice qué empresas tienen trabajo.
//   2. Por empresa, en una transacción con su contexto, se ARRIENDAN eventos con FOR UPDATE SKIP LOCKED:
//      reclamado_hasta = now()+LEASE y intentos+1. Otra réplica no puede tomar el mismo evento.
//   3. Cada suscriptor corre una sola vez por evento (consumos_eventos) y recibe ctx.db ligado a la
//      empresa del evento: sus consultas ven solo esa empresa.
//   4. Si todos los suscriptores terminan → publicado. Si alguno falla → se reintenta con espera
//      creciente; tras MAX_INTENTOS → fallido_en (cola de fallidos, no se reintenta más).
// Antes: el FOR UPDATE se ejecutaba en una consulta autocommit (candado inútil), el evento se marcaba
// publicado aunque un suscriptor fallara (nunca se reintentaba) y bajo RLS no se veía ningún evento.
// ---------------------------------------------------------------------------
const LEASE_SEG = 60;
const MAX_INTENTOS = 5;

async function reclamarEventos(db, tenantId, limite) {
  const filas = await enTenant(db, tenantId, async (c) => (await c.query(
    `UPDATE outbox SET reclamado_hasta = now() + make_interval(secs => $2), intentos = intentos + 1
     WHERE id IN (SELECT id FROM outbox
                  WHERE publicado_en IS NULL AND fallido_en IS NULL
                    AND (reclamado_hasta IS NULL OR reclamado_hasta < now())
                  ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, tenant_id, tipo, payload, intentos`, [limite, LEASE_SEG])).rows);
  return filas.sort((a, b) => Number(a.id) - Number(b.id));
}

async function procesarEvento(db, evento) {
  const ctx = { db: dbDeTenant(db, evento.tenant_id), tenantId: evento.tenant_id };
  const handlers = suscriptores.get(evento.tipo) || [];
  const errores = [];
  for (const { nombreSuscriptor, handler } of handlers) {
    const ya = await db.query(
      `SELECT 1 FROM consumos_eventos WHERE suscriptor=$1 AND evento_id=$2`, [nombreSuscriptor, evento.id]);
    if (ya.rows.length) continue; // idempotente: un reintento no repite lo que ya funcionó
    try {
      await handler(evento, ctx);
      await db.query(`INSERT INTO consumos_eventos (suscriptor, evento_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [nombreSuscriptor, evento.id]);
    } catch (e) {
      errores.push(`${nombreSuscriptor}: ${e.message}`);
      metricas().log('error', 'evento.fallo', { id: evento.id, suscriptor: nombreSuscriptor, intento: evento.intentos, error: e.message });
    }
  }
  if (!errores.length) {
    await ctx.db.query(
      `UPDATE outbox SET publicado_en=now(), reclamado_hasta=NULL, ultimo_error=NULL WHERE id=$1`, [evento.id]);
    return 'publicado';
  }
  const agotado = evento.intentos >= MAX_INTENTOS;
  await ctx.db.query(
    `UPDATE outbox SET ultimo_error=$2,
            reclamado_hasta = CASE WHEN $3 THEN NULL ELSE now() + make_interval(secs => least(300, power(2, intentos)::int)) END,
            fallido_en = CASE WHEN $3 THEN now() ELSE NULL END
     WHERE id=$1`, [evento.id, errores.join(' | ').slice(0, 2000), agotado]);
  return agotado ? 'fallido' : 'reintentar';
}

// Lo corre el worker de eventos cada 2 segundos. Devuelve cuántos eventos se procesaron.
async function procesarPendientes(db, limite = 50) {
  const { rows } = await db.query('SELECT t AS tenant_id FROM mf_tenants_con_eventos_pendientes($1) AS t', [limite]);
  const resumen = { procesados: 0, publicados: 0, reintentar: 0, fallidos: 0 };
  for (const { tenant_id: tenantId } of rows) {
    for (const evento of await reclamarEventos(db, tenantId, limite)) {
      const r = await procesarEvento(db, evento);
      resumen.procesados++;
      if (r === 'publicado') resumen.publicados++; else if (r === 'fallido') resumen.fallidos++; else resumen.reintentar++;
    }
  }
  procesarPendientes.ultimoResumen = resumen;
  return resumen.procesados;
}

// ---------------------------------------------------------------------------
// SUSCRIPCIONES REALES DE LA PLATAFORMA (se registran al arrancar el server)
// ---------------------------------------------------------------------------
function registrarSuscripciones({ db, notificaciones, ledger, autoDispatch }) {
  // La factory de eventos del ledger recibe db (42): un asiento por evento
  const asientos = ledger.eventos(db);

  // El despachador (08) expone ejecutarModoAutomatico/reasignar; los pasos
  // post-aceptación se encapsulan aquí para no acoplar el bus a su interno.
  // ctx.db está ligado a la empresa del evento: bajo RLS, sin él estas escrituras afectaban 0 filas.
  const postAceptacion = async (ctx, bookingId) => {
    if (autoDispatch && typeof autoDispatch.ejecutarPostAceptacion === 'function')
      return autoDispatch.ejecutarPostAceptacion(bookingId, ctx);
    // Fallback: pasar a EN_CURSO solo desde un estado previo (un reintento no retrocede una reserva pagada).
    await ctx.db.query(`UPDATE bookings SET status='EN_CURSO' WHERE id=$1 AND status IN ('CONFIRMED','DISPATCHED')`, [bookingId]);
  };
  const pausarChofer = async (ctx, driverId, motivo) => {
    if (autoDispatch && typeof autoDispatch.pausarChofer === 'function')
      return autoDispatch.pausarChofer(driverId, motivo, ctx);
    await ctx.db.query(`UPDATE drivers SET status='PAUSED', notes=$2 WHERE id=$1`, [driverId, motivo]);
  };

  // Una carga ofertada → notificar al chofer por todos sus canales
  suscribir('carga.ofertada', 'notificador', async (ev) => {
    await notificaciones.alChofer(ev.tenant_id, ev.payload.driverId, {
      tipo: 'NUEVA_CARGA', datos: ev.payload });
  });

  // El chofer aceptó → auditar + disparar el despacho (factura, GPS, etc.)
  // 42.eventos expone registrarCargaAceptada / registrarPagoRegistrado (antes se llamaban con otros
  // nombres inexistentes y el suscriptor fallaba siempre).
  suscribir('carga.aceptada', 'auditor', async (ev) => {
    await asientos.registrarCargaAceptada(ev.tenant_id, ev.payload.bookingId, ev.payload.actor || 'chofer', ev.payload.requestId);
  });
  suscribir('carga.aceptada', 'despachador', async (ev, ctx) => {
    await postAceptacion(ctx, ev.payload.bookingId);
  });

  // Pago registrado → auditar + avisar al chofer ("ya te depositaron")
  suscribir('pago.registrado', 'auditor', async (ev) => {
    await asientos.registrarPagoRegistrado(ev.tenant_id, ev.payload.paymentId, ev.payload.monto);
  });
  suscribir('pago.registrado', 'notificador', async (ev) => {
    await notificaciones.alChofer(ev.tenant_id, ev.payload.driverId, {
      tipo: 'PAGO_DEPOSITADO', datos: { monto: ev.payload.monto } });
  });

  // Seguro vencido detectado en monitoreo → pausar al chofer + avisar
  suscribir('seguro.vencido', 'seguridad', async (ev, ctx) => {
    await pausarChofer(ctx, ev.payload.driverId, 'Seguro vencido — regularizar para recibir cargas');
    await notificaciones.alAdmin(ev.tenant_id, {
      tipo: 'ALERTA_SEGURIDAD', datos: { texto: `🛡 ${ev.payload.nombre}: seguro vencido. Pausado automáticamente.` } });
  });
}

module.exports = { SQL, publicar, suscribir, procesarPendientes, procesarEvento, reclamarEventos,
                   registrarSuscripciones, LEASE_SEG, MAX_INTENTOS };
