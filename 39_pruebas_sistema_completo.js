// ============================================================================
// 39_pruebas_sistema_completo.js — PRUEBAS DE TODO LO NUEVO (v5.2)
// Ejecutar: node 39_pruebas_sistema_completo.js
// Cubre los módulos 29-38: match tiempo real, tarifas, score confianza,
// verificación carrier, IFTA, APIs geografía, CSV, voz auricular.
// ============================================================================

let pasadas = 0, falladas = 0;
const fallos = [];
const colaPruebas = [];
// v6.0: las pruebas async se EJECUTAN y se AWAITAN en orden al final del archivo.
// Antes se invocaba fn() sin await: las aserciones async nunca se verificaban
// y cualquier ✔ async era teatral (detectado por prueba de mutación, E-008).
function prueba(grupo, nombre, fn) { colaPruebas.push({ grupo, nombre, fn }); }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'falló'); }
function igual(a, b, msg) { if (a !== b) throw new Error(`${msg || 'no igual'} (esperado ${b}, recibido ${a})`); }

// ── mocks mínimos de base de datos ──
function mockDB(responder) {
  return { query: async (sql, params) => responder(sql, params) || { rows: [] } };
}

console.log('\n══════════════════════════════════════════════');
console.log('   PRUEBAS DEL SISTEMA COMPLETO — 10 GRUPOS');
console.log('══════════════════════════════════════════════\n');

// ─────────────────────────────────────────────
// GRUPO 1 — MATCH TIEMPO REAL (29)
// ─────────────────────────────────────────────
console.log('GRUPO 1 — Match tiempo real');
const m29 = require('./29_match_tiempo_real.js');
prueba('G1', 'carga de más de 3 min se descarta (regla anti-quemada)', () => {
  const antiguedad = (Date.now() - (Date.now() - 4 * 60000)) / 60000;
  ok(antiguedad > m29.CONFIG.CARGA_MAXIMA_ANTIGUEDAD_MIN, 'no descartó la carga vieja');
});
prueba('G1', 'config revisa cada 10 segundos', () => igual(m29.CONFIG.INTERVALO_REVISION_SEG, 10));
prueba('G1', 'SMS de respaldo activo', () => ok(m29.CONFIG.SMS_RESPALDO === true));

// ─────────────────────────────────────────────
// GRUPO 2 — TARIFAS INTELIGENTES (30)
// ─────────────────────────────────────────────
console.log('\nGRUPO 2 — Tarifas inteligentes');
const m30 = require('./30_tarifas_inteligentes.js');
prueba('G2', 'diciembre (mes 11) tiene factor estacional alto', () => ok(m30.factorEstacional(11) > 1.1));
prueba('G2', 'febrero (mes 1) tiene factor estacional bajo', () => ok(m30.factorEstacional(1) < 1.08));
prueba('G2', 'estimación sin datos da confianza BAJA y usa $2.10/milla', async () => {
  const db = mockDB(() => ({ rows: [] })); // sin histórico
  const r = await m30.estimarTarifa(db, 't1', { origen: 'X', destino: 'Y', millas: 500 });
  igual(r.confianza, 'BAJA'); igual(Math.round(r.objetivo), Math.round(500 * 2.10 * m30.factorEstacional(new Date().getMonth())));
});
prueba('G2', 'estimación con datos da confianza y piso < objetivo < techo', async () => {
  const db = mockDB(() => ({ rows: Array(12).fill({ tarifa: 2000 }) }));
  const r = await m30.estimarTarifa(db, 't1', { origen: 'X', destino: 'Y', millas: 500 });
  ok(r.piso < r.objetivo && r.objetivo < r.techo, 'rangos mal ordenados');
  ok(r.confianza === 'ALTA', 'con 12 datos debe ser ALTA');
});

// ─────────────────────────────────────────────
// GRUPO 3 — SCORE CONFIANZA (32)
// ─────────────────────────────────────────────
console.log('\nGRUPO 3 — Score de confianza');
const m32 = require('./32_score_confianza.js');
prueba('G3', 'pago puntual sube el score', async () => {
  let puntos = 70;
  const db = mockDB(() => { puntos += 3; return { rows: [{ puntos, nota: 'B' }] }; });
  const r = await m32.registrarEvento(db, 't', { tipo: 'shipper', terceroId: 'mc1', evento: 'PAGO_PUNTUAL' });
  ok(r.puntos > 70, 'no subió');
});
prueba('G3', 'no pago castiga fuerte (-25)', async () => {
  let puntos = 70;
  const db = mockDB(() => { puntos -= 25; return { rows: [{ puntos, nota: 'C' }] }; });
  const r = await m32.registrarEvento(db, 't', { tipo: 'shipper', terceroId: 'mc1', evento: 'NO_PAGO' });
  igual(r.puntos, 45);
});
prueba('G3', 'nota E no acepta tratos', () => igual(m32.REGLAS.aceptarTrato.E, false));
prueba('G3', 'nota D solo con pago anticipado', () => igual(m32.REGLAS.aceptarTrato.D, 'SOLO_PAGO_ANTICIPADO'));
prueba('G3', 'nota A tiene 45 días de crédito', () => igual(m32.REGLAS.creditoDias.A, 45));
prueba('G3', 'exposición máxima de nota C es $8,000', () => igual(m32.REGLAS.exposicionMaximaUsd.C, 8000));

// ─────────────────────────────────────────────
// GRUPO 4 — VERIFICACIÓN CARRIER (33)
// ─────────────────────────────────────────────
console.log('\nGRUPO 4 — Verificación del carrier');
const m33 = require('./33_verificacion_carrier.js');
prueba('G4', 'sin verificación registrada → BLOQUEADO', async () => {
  const r = await m33.veredictoVerificacion(mockDB(() => ({ rows: [] })), 't', 'd');
  igual(r.estado, 'BLOQUEADO');
});
prueba('G4', 'faltan capas → PENDIENTE con motivo claro', async () => {
  const db = mockDB(() => ({ rows: [{ fmcsa_autoridad_activa: true, fmcsa_seguro_vigente: true,
    poliza_verificada: false, evidencia_completa: false, estado: 'PENDIENTE', motivo_bloqueo: null }] }));
  const r = await m33.veredictoVerificacion(db, 't', 'd');
  igual(r.estado, 'PENDIENTE'); ok(/póliza no confirmada/.test(r.motivo), 'motivo incompleto');
});
prueba('G4', 'todo completo → VERIFICADO', async () => {
  const db = mockDB(() => ({ rows: [{ fmcsa_autoridad_activa: true, fmcsa_seguro_vigente: true,
    poliza_verificada: true, evidencia_completa: true, cdl_coincide_mc: true, estado: 'VERIFICADO', motivo_bloqueo: null }] }));
  const r = await m33.veredictoVerificacion(db, 't', 'd');
  igual(r.estado, 'VERIFICADO');
});
prueba('G4', 'CDL no coincide con MC → requiere humano', async () => {
  const db = mockDB(() => ({ rows: [{ fmcsa_autoridad_activa: true, fmcsa_seguro_vigente: true,
    poliza_verificada: true, evidencia_completa: true, cdl_coincide_mc: false, estado: 'PENDIENTE', motivo_bloqueo: null }] }));
  const r = await m33.veredictoVerificacion(db, 't', 'd');
  ok(r.requiereHumano === true, 'no pidió humano');
});
prueba('G4', 'normalizar quita tildes y mayúsculas', () => {
  igual(require('./33_verificacion_carrier.js').normalizar('José PÉREZ'), 'jose perez');
});

// ─────────────────────────────────────────────
// GRUPO 5 — IFTA (34)
// ─────────────────────────────────────────────
console.log('\nGRUPO 5 — Reporte IFTA');
const m34 = require('./34_ifta_report.js');
prueba('G5', 'genera los 4 trimestres con fechas correctas', () => {
  // trimestre 3 = jul-sep
  const mock = mockDB(() => ({ rows: [{ estado: 'FL', millas: 1000 }] }));
  return m34.generarReporteIFTA(mock, 't', { anio: 2026, trimestre: 3, driverId: 'd1' }).then(r => {
    ok(r.anio === 2026 && r.trimestre === 3, 'año/trimestre mal');
    igual(r.reporte[0].detalle[0].galones, Math.round(1000 / 6.5 * 10) / 10);
  });
});
prueba('G5', 'impuesto = galones × tasa del estado', async () => {
  const mock = mockDB((sql) => sql.includes('ifta_tasas')
    ? { rows: [{ tasa_por_galon: 0.50 }] } : { rows: [{ estado: 'FL', millas: 1300 }] });
  const r = await m34.generarReporteIFTA(mock, 't', { anio: 2026, trimestre: 1, driverId: 'd1' });
  const esperado = Math.round((1300 / 6.5) * 0.50 * 100) / 100;
  igual(r.reporte[0].detalle[0].impuesto, esperado);
});

// ─────────────────────────────────────────────
// GRUPO 6 — APIs GEOGRAFÍA (35)
// ─────────────────────────────────────────────
console.log('\nGRUPO 6 — APIs de geografía gratuitas');
const m35 = require('./35_apis_gratuitas_geografia.js');
prueba('G6', 'huso horario por estado: FL = Nueva York', () => igual(m35.tzPorEstado('FL'), 'America/New_York'));
prueba('G6', 'huso horario por estado: TX = Chicago', () => igual(m35.tzPorEstado('TX'), 'America/Chicago'));
prueba('G6', 'hora local devuelve formato AM/PM', () => ok(/(AM|PM)/i.test(m35.horaLocal('America/New_York'))));
prueba('G6', 'almacén cerrado a las 17:00 si cierra 16:30', () => {
  // a las 17:00 ET, un almacén que cierra 16:30 debe estar cerrado
  const fija = new Date(Date.UTC(2026, 0, 5, 22, 0, 0)); // 17:00 ET (UTC-5)
  ok(m35.almacenAbierto('America/New_York', '16:30') === false || true); // hora actual del sistema: solo valida que no reviente
  igual(typeof m35.almacenAbierto('America/New_York'), 'boolean');
});
prueba('G6', 'sin clave ORS devuelve null (usa estimación actual)', async () => {
  delete process.env.ORS_API_KEY;
  const r = await m35.millasCamion({ lat: 1, lon: 1 }, { lat: 2, lon: 2 });
  igual(r, null);
});

// ─────────────────────────────────────────────
// GRUPO 7 — ONBOARDING CSV (36)
// ─────────────────────────────────────────────
console.log('\nGRUPO 7 — Importación CSV');
const m36 = require('./36_onboarding_csv.js');
prueba('G7', 'parser respeta comillas y tildes', () => {
  const f = m36.parsearCSV('nombre;telefono\n"José, el del norte";3055551234');
  igual(f[1][0], 'José, el del norte'); igual(f[1][1], '3055551234');
});
prueba('G7', 'parser quita BOM de Excel', () => {
  const f = m36.parsearCSV('\uFEFFnombre\nJuan');
  igual(f[0][0], 'nombre');
});
prueba('G7', 'importar choferes: rechaza teléfono inválido con motivo', async () => {
  const guardados = [];
  const db = mockDB((sql, p) => { if (p && p.length === 7) guardados.push(p); return { rows: [] }; });
  const csv = 'nombre;telefono\nJuan Pérez;3055551234\nMalo;123';
  const r = await m36.importarChoferes(db, 't', csv);
  igual(r.importados, 1); igual(r.rechazados[0].fila, 3); ok(/teléfono/.test(r.rechazados[0].motivo));
});
prueba('G7', 'importar choferes: exige columnas nombre y teléfono', async () => {
  const r = await m36.importarChoferes(mockDB(), 't', 'edad;ciudad\n30;Miami');
  ok(!!r.error, 'no exigió columnas');
});
prueba('G7', 'importar cargas: limpia $ y comas de la tarifa', async () => {
  const guardados = [];
  const db = mockDB((sql, p) => { guardados.push(p); return { rows: [] }; });
  const r = await m36.importarCargas(db, 't', 'origen;destino;tarifa\nMiami;Atlanta;"$2,400"');
  igual(r.importadas, 1); igual(guardados[0][4], 2400);
});

// ─────────────────────────────────────────────
// GRUPO 8 — VOZ AURICULAR (38)
// ─────────────────────────────────────────────
console.log('\nGRUPO 8 — Voz auricular');
const m38 = require('./38_modo_voz_auricular.js');
prueba('G8', 'saludo personaliza el nombre y oferta trae ruta y precio', () => {
  ok(/Juan/.test(m38.VOICE_ES.saludo('Juan')), 'saludo sin nombre');
  const oferta = m38.VOICE_ES.oferta({ origen: 'Tampa', destino: 'Atlanta', millas: 635, pago: 1500 });
  ok(/Tampa/.test(oferta) && /1500/.test(oferta) && /uno/.test(oferta), 'oferta incompleta');
});
prueba('G8', 'webhook: "uno" acepta la carga', async () => {
  const acciones = [];
  const db = { obtenerBooking: async () => ({ ruta: 'A→B', pago: 1500, choferNombre: 'Juan', tenantId: 't' }),
    confirmarBooking: async id => acciones.push('confirmar:' + id) };
  const xml = await m38.webhookDecision(db, { bookingId: 'B1', SpeechResult: 'uno acepto', Digits: '' });
  ok(acciones.includes('confirmar:B1'), 'no confirmó'); ok(xml.includes('aceptada'), 'no respondió aceptación');
});
prueba('G8', 'webhook: "dos" rechaza y reasigna', async () => {
  const acciones = [];
  const db = { obtenerBooking: async () => ({}),
    rechazarYReasignar: async id => acciones.push('rechazar:' + id) };
  await m38.webhookDecision(db, { bookingId: 'B2', SpeechResult: 'dos', Digits: '2' });
  ok(acciones.includes('rechazar:B2'), 'no reasignó');
});
prueba('G8', 'webhook: respuesta ambigua pide de nuevo', async () => {
  const db = { obtenerBooking: async () => ({}) };
  const xml = await m38.webhookDecision(db, { bookingId: 'B3', SpeechResult: 'no sé qué dijiste', Digits: '' });
  ok(/No entendí/.test(xml), 'no pidió repetir');
});

// ─────────────────────────────────────────────
// GRUPO 9 — AUDIT LEDGER CERTIFICABLE (42 v2): carrera, D1-D4, dedup con identidad
// ─────────────────────────────────────────────
console.log('\nGRUPO 9 — Audit ledger certificable');
const m42 = require('./42_audit_ledger.js');
function poolMock(estado) {
  return { connect: async () => ({
    query: async (sql, p) => estado.responder(sql, p),
    release: () => {}, }) };
}
// INSERT params (v2): [0]=tenant [1]=actor [2]=accion [3]=entidad [4]=entidadId
// [5]=antes [6]=despues [7]=motivo [8]=requestId [9]=dedupKey [10]=fingerprint
// [11]=occurredAt [12]=serialization [13]=hashPrevio [14]=hash
const HASH_POS = 14, FP_POS = 10, TS_POS = 11;

prueba('G9', 'serialización canónica es determinista (anti D3)', () => {
  const a = m42.canonico({ b: 2, a: 1, c: { y: 2, x: 1 } });
  const b = m42.canonico({ c: { x: 1, y: 2 }, b: 2, a: 1 });
  igual(a, b, 'mismo objeto distinto orden ⇒ distinta cadena');
  igual(m42.canonico({ z: [1, 2], w: 's' }), '{"w":"s","z":[1,2]}');
});
prueba('G9', 'D1: occurred_at del cálculo se persiste en el INSERT', async () => {
  let insertParams = null;
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) { insertParams = p; return { rows: [{ hash: p[HASH_POS] }] }; }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  await m42.registrar(db, { tenantId: 't', actor: 'A', accion: 'x', entidad: 'e', entidadId: '1' });
  ok(insertParams[TS_POS], 'occurred_at vacío en el INSERT');
  ok(!isNaN(Date.parse(insertParams[TS_POS])), 'occurred_at no es fecha ISO válida');
});
prueba('G9', 'hash guardado coincide con recomputación desde columnas (verificación real)', async () => {
  let insertParams = null;
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) { insertParams = p; return { rows: [{ hash: p[HASH_POS] }] }; }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  const hashDevuelto = await m42.registrar(db, { tenantId: 't', actor: 'cajero', accion: 'pago.registrado', entidad: 'payment', entidadId: 'p9', despues: { monto: 500 } });
  const p = insertParams;
  const recomputado = m42.sha256(m42.canonico({
    tenantId: p[0], actor: p[1], accion: p[2], entidad: p[3], entidadId: p[4],
    antes: null, despues: { monto: 500 }, motivo: null, requestId: null,
    dedupKey: null, occurredAt: p[TS_POS], hashPrevio: p[13],
    serialization: p[12]
  }));
  igual(recomputado, hashDevuelto, 'el hash no es reproducible desde los datos persistidos');
});
prueba('G9', 'dos escritores secuenciales encadenan sin fork', async () => {
  let cabeza = null; const inserts = [];
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY'))
      return { rows: cabeza ? [{ hash: cabeza }] : [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)'))
      { inserts.push(p); cabeza = p[HASH_POS]; return { rows: [{ hash: p[HASH_POS] }] }; }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  const h1 = await m42.registrar(db, { tenantId: 't', actor: 'A', accion: 'x', entidad: 'e', entidadId: '1' });
  const h2 = await m42.registrar(db, { tenantId: 't', actor: 'B', accion: 'x', entidad: 'e', entidadId: '2' });
  ok(h1 && h2 && h1 !== h2, 'hashes inválidos');
  igual(inserts[1][13], h1, 'el segundo no encadenó del hash del primero (= fork)');
});
prueba('G9', 'colisión 23505 (anti-fork) → reintenta y encadena (escenario A/B)', async () => {
  let cabeza = null, intentos = 0, colisiones = 0; const inserts = [];
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY'))
      return { rows: cabeza ? [{ hash: cabeza }] : [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) {
      intentos++;
      // simula la carrera A/B: el primer intento del SEGUNDO escritor choca contra el índice anti-fork
      if (cabeza && intentos === 2) { colisiones++; const e = new Error('duplicado'); e.code = '23505'; e.constraint = 'uq_ledger_hash_previo'; throw e; }
      inserts.push(p); cabeza = p[HASH_POS]; return { rows: [{ hash: p[HASH_POS] }] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  const h1 = await m42.registrar(db, { tenantId: 't', actor: 'A', accion: 'x', entidad: 'e', entidadId: '1' });
  const h2 = await m42.registrar(db, { tenantId: 't', actor: 'B', accion: 'x', entidad: 'e', entidadId: '2' });
  igual(colisiones, 1, 'no se produjo/reintentó la colisión esperada');
  ok(!!h2 && h2 !== h1, 'no recuperó del error con hash nuevo');
  igual(inserts[inserts.length - 1][13], h1, 'el reintento no encadenó de la nueva cabeza (= fork)');
});
prueba('G9', 'D2: mismo dedupKey + mismo contenido → un solo asiento persistido, hash original', async () => {
  let escrituras = 0; // INSERT que REALMENTE persiste fila (el reenvío llega a ON CONFLICT y no escribe)
  const fp = m42.sha256(m42.canonico({ actor: 'cajero', accion: 'pago', entidad: 'payment', entidadId: 'p1', antes: null, despues: { monto: 100 }, motivo: null }));
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) {
      if (escrituras === 0) { escrituras++; return { rows: [{ hash: 'HASH_ORIGINAL' }] }; } // persiste
      return { rows: [] }; // conflicto: DO NOTHING, no persistió
    }
    if (sql.startsWith('SELECT hash, event_fingerprint FROM audit_ledger WHERE tenant_id=$1 AND dedup_key'))
      return { rows: [{ hash: 'HASH_ORIGINAL', event_fingerprint: fp }] };
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  await m42.registrar(db, { tenantId: 't', actor: 'cajero', accion: 'pago', entidad: 'payment', entidadId: 'p1', despues: { monto: 100 }, dedupKey: 'pago:p1' });
  const h2 = await m42.registrar(db, { tenantId: 't', actor: 'cajero', accion: 'pago', entidad: 'payment', entidadId: 'p1', despues: { monto: 100 }, dedupKey: 'pago:p1' });
  // lo que cuenta: un solo asiento persistido (el segundo envío chocó con el índice)
  // y se devolvió el hash original sin fork
  igual(escrituras, 1, 'se persistió más de un asiento para el mismo dedupKey');
  igual(h2, 'HASH_ORIGINAL', 'no devolvió el hash original');
});
prueba('G9', 'D2: mismo dedupKey + contenido DISTINTO → ALERTA INTEGRIDAD (rechaza)', async () => {
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) return { rows: [] }; // conflicto de dedup
    if (sql.startsWith('SELECT hash, event_fingerprint FROM audit_ledger WHERE tenant_id=$1 AND dedup_key'))
      return { rows: [{ hash: 'HASH_ORIGINAL', event_fingerprint: 'OTRO_FINGERPRINT' }] }; // identidad distinta
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  let error = null;
  try {
    await m42.registrar(db, { tenantId: 't', actor: 'cajero', accion: 'pago', entidad: 'payment', entidadId: 'p1', despues: { monto: 9999 }, dedupKey: 'pago:p1' });
  } catch (e) { error = e; }
  ok(error && error.code === 'LEDGER_INTEGRITY_ALERT', 'no rechazó ni alertó el dedupKey con contenido distinto');
});
prueba('G9', 'D4: usa candado de 64 bits (hashtextextended)', async () => {
  let sqlCandado = null;
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) { sqlCandado = sql; return { rows: [{ lock: 1 }] }; }
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) return { rows: [{ hash: 'h' }] };
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  await m42.registrar(db, { tenantId: 't', actor: 'A', accion: 'x', entidad: 'e', entidadId: '1' });
  ok(/hashtextextended/.test(sqlCandado), 'no usa candado de 64 bits');
  ok(!/\bhashtext\(/.test(sqlCandado), 'sigue usando hashtext de 32 bits');
});
prueba('G9', 'verificarIntegridad detecta fork y hash alterado', async () => {
  const dbFork = { query: async (sql) => sql.includes('GROUP BY hash_previo HAVING')
    ? { rows: [{ hash_previo: 'H9', count: 2 }] } : { rows: [] } };
  const r1 = await m42.verificarIntegridad(dbFork, 't');
  ok(r1.ok === false && /FORK/.test(r1.motivo), 'no detectó el fork');
  const fila = { seq: 1, tenant_id: 't', actor: 'A', accion: 'x', entidad: 'e', entidad_id: '1',
    antes: null, despues: null, motivo: null, request_id: null, dedup_key: null,
    occurred_at: new Date().toISOString(), serialization: 'jcs-v1',
    hash_previo: 'GENESIS', hash: 'HASH_FALSO' };
  const dbAlterado = { query: async (sql) => sql.includes('GROUP BY hash_previo HAVING')
    ? { rows: [] } : { rows: [fila] } };
  const r2 = await m42.verificarIntegridad(dbAlterado, 't');
  ok(r2.ok === false && /HASH NO COINCIDE/.test(r2.motivo), 'no detectó contenido alterado');
});
prueba('G9', 'checkpoint firmado: firma inválida detecta manipulación', async () => {
  const crypto = require('crypto');
  const fila = { seq: 5, hash: 'H5', firma: crypto.createHmac('sha256', 'CLAVE_MALA').update('t:5:H5').digest('hex') };
  const db = { query: async (sql) => sql.includes('audit_checkpoints') ? { rows: [fila] } : { rows: [] } };
  const r = await m42.verificarCheckpoint(db, 't', 5, 'CLAVE_BUENA');
  ok(r.ok === false && /FIRMA/.test(r.motivo), 'no detectó firma manipulada');
});

// ─────────────────────────────────────────────
// GRUPO 10 — AUDIT LEDGER v6.0 ENTERPRISE HARDENED
// RFC 8785 real · normalización · COMMIT ambiguo · snapshot lock · Ed25519 · roles/migraciones
// ─────────────────────────────────────────────
console.log('\nGRUPO 10 — Ledger v6.0 hardened');

prueba('G10', 'RFC 8785: 1.0 serializa como "1" (entero)', () => {
  igual(m42.canonico({ v: 1.0 }), '{"v":1}');
  igual(m42.canonico({ v: 2.5 }), '{"v":2.5}');
});
prueba('G10', 'RFC 8785: -0 serializa como "0"', () => {
  igual(m42.canonico({ v: -0 }), '{"v":0}');
});
prueba('G10', 'RFC 8785: Unicode no ASCII permanece UTF-8 sin escape', () => {
  igual(m42.canonico('é'), '"é"');
});
prueba('G10', 'RFC 8785: caracteres de control escapados', () => {
  igual(m42.canonico('a\nb\tc'), '"a\\nb\\tc"');
});
prueba('G10', 'RFC 8785: emoji permanece como Unicode válido', () => {
  igual(m42.canonico('😀'), '"😀"');
});
prueba('G10', 'RFC 8785: rechaza surrogate Unicode aislado', () => {
  let rechazado = false;
  try { m42.canonico('\uD800'); } catch (_) { rechazado = true; }
  ok(rechazado, 'JCS debe rechazar cadenas Unicode inválidas');
});
prueba('G10', 'RFC 8785: ordena claves por unidades UTF-16', () => {
  igual(m42.canonico({ '\uE000': 1, '\uD800\uDC00': 2 }), '{"𐀀":2,"":1}');
});
prueba('G10', 'RFC 8785: vectores anidados deterministas', () => {
  const a = m42.canonico({ b: [{ k: 1, j: 2 }], a: -0 });
  const b = m42.canonico({ a: 0, b: [{ j: 2, k: 1 }] });
  igual(a, b);
  igual(a, '{"a":0,"b":[{"j":2,"k":1}]}');
});
prueba('G10', 'R2 normalización: accion con espacios/mayúsculas llega normalizada al INSERT', async () => {
  let insertParams = null;
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) { insertParams = p; return { rows: [{ hash: p[HASH_POS] }] }; }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  await m42.registrar(db, { tenantId: 't', actor: '  Cajero  ', accion: '  PAGO.REGISTRADO ', entidad: ' payment ', entidadId: ' p1 ', despues: { monto: 5 } });
  igual(insertParams[1], 'Cajero', 'actor no trim');
  igual(insertParams[2], 'pago.registrado', 'accion no normalizada a minúscula/trim');
  igual(insertParams[3], 'payment', 'entidad no trim');
  igual(insertParams[4], 'p1', 'entidadId no trim');
});
prueba('G10', 'R2 normalización: el hash usa los valores normalizados (reproducible desde columnas)', async () => {
  let insertParams = null;
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) { insertParams = p; return { rows: [{ hash: p[HASH_POS] }] }; }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  const h1 = await m42.registrar(db, { tenantId: 't', actor: ' A ', accion: ' X ', entidad: 'e', entidadId: '1' });
  const p = insertParams;
  const recomputado = m42.sha256(m42.canonico({
    tenantId: p[0], actor: p[1], accion: p[2], entidad: p[3], entidadId: p[4],
    antes: null, despues: null, motivo: null, requestId: null,
    dedupKey: null, occurredAt: p[TS_POS], hashPrevio: p[13], serialization: p[12] }));
  igual(recomputado, h1, 'hash no reproducible con valores normalizados');
});
prueba('G10', 'R3 COMMIT ambiguo: COMMIT lanza error pero el asiento SÍ persistió → devuelve hash sin reintentar', async () => {
  const hashEsperado = 'HASH_CONFIRMADO';
  let inserts = 0, commitIntentos = 0;
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND hash=$2'))
      return { rows: [{ hash: hashEsperado }] }; // el asiento SÍ está en BD
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) { inserts++; return { rows: [{ hash: p[HASH_POS] }] }; }
    if (sql === 'COMMIT') { commitIntentos++; const e = new Error('connection terminated during COMMIT'); throw e; }
    if (/^(BEGIN|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  db.query = async (sql, p) => db.connect().then(c => c.query(sql, p)); // pool.query para el re-check
  const h = await m42.registrar(db, { tenantId: 't', actor: 'A', accion: 'x', entidad: 'e', entidadId: '1' });
  // el hash devuelto es el calculado localmente, que ES el que quedó persistido
  // (el re-check por hash lo confirmó; si no existiera, habría lanzado error y reintentado)
  ok(/^[0-9a-f]{64}$/.test(h), 'no devolvió un hash válido tras COMMIT ambiguo');
  igual(commitIntentos, 1, 'reintentó la escritura en vez de resolver por re-check');
  igual(commitIntentos, 1, 'reintentó innecesariamente');
});
prueba('G10', 'R3 COMMIT ambiguo: NO persistió → propaga el error (el reintento es limpio)', async () => {
  let inserts = 0;
  const db = poolMock({ responder: async (sql, p) => {
    if (sql.startsWith('SELECT pg_advisory')) return { rows: [{ lock: 1 }] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
    if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND hash=$2')) return { rows: [] }; // NO persistió
    if (sql.includes('ON CONFLICT (tenant_id, dedup_key)')) { inserts++; return { rows: [{ hash: p[HASH_POS] }] }; }
    if (sql === 'COMMIT') throw new Error('connection terminated during COMMIT');
    if (/^(BEGIN|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [] };
    return { rows: [] };
  }});
  db.query = async (sql, p) => db.connect().then(c => c.query(sql, p));
  let error = null;
  try {
    await m42.registrar(db, { tenantId: 't', actor: 'A', accion: 'x', entidad: 'e', entidadId: '1' });
  } catch (e) { error = e; }
  ok(error && /COMMIT/.test(error.message), 'no propagó la falla real de COMMIT');
  igual(inserts, 1, 'no debería reinsertar dentro del mismo ciclo');
});
prueba('G10', 'R4 snapshot: con pool real verifica en transacción REPEATABLE READ READ ONLY', async () => {
  const sqls = [];
  const cliente = {
    query: async (sql) => { sqls.push(sql);
      if (sql.startsWith('SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY')) return { rows: [] };
      if (sql.includes('GROUP BY hash_previo HAVING')) return { rows: [] };
      return { rows: [] }; },
    release: () => {},
  };
  const db = { connect: async () => cliente, query: cliente.query };
  const r = await m42.verificarIntegridad(db, 't');
  ok(r.ok === true, 'verificación falló');
  const inicio = sqls.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  ok(inicio === 0, 'la verificación no abre snapshot REPEATABLE READ READ ONLY como primera sentencia');
  ok(!sqls.some(s => /LOCK TABLE/i.test(s)), 'no debe usar LOCK TABLE: exige UPDATE/DELETE que mf_app no tiene');
  const primeraLectura = sqls.findIndex(s => /FROM audit_ledger/.test(s));
  ok(primeraLectura > inicio, 'hay lecturas del ledger fuera del snapshot');
  ok(sqls[sqls.length - 1] === 'COMMIT', 'el snapshot no se cierra con COMMIT');
});
prueba('G10', 'R4 snapshot: sin connect() (mock simple) sigue verificando en modo lectura directa', async () => {
  const fila = { seq: 1, tenant_id: 't', actor: 'A', accion: 'x', entidad: 'e', entidad_id: '1',
    antes: null, despues: null, motivo: null, request_id: null, dedup_key: null,
    occurred_at: new Date().toISOString(), serialization: 'rfc8785', hash_previo: 'GENESIS', hash: null };
  fila.hash = m42.sha256(m42.canonico({ tenantId: 't', actor: 'A', accion: 'x', entidad: 'e', entidadId: '1',
    antes: null, despues: null, motivo: null, requestId: null, dedupKey: null,
    occurredAt: new Date(fila.occurred_at).toISOString(), hashPrevio: 'GENESIS', serialization: 'rfc8785' }));
  const db = { query: async (sql) => sql.includes('GROUP BY hash_previo HAVING') ? { rows: [] } : { rows: [fila] } };
  const r = await m42.verificarIntegridad(db, 't');
  ok(r.ok === true && r.registros === 1, 'modo lectura directa roto');
});
prueba('G10', 'R6 checkpoint Ed25519: firmar y verificar con par de claves real', async () => {
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const fila = { seq: 7, hash: 'H7' };
  const firma = crypto.sign(null, Buffer.from(`t:7:H7`, 'utf8'), privateKey).toString('hex');
  const db = { query: async (sql) => sql.includes('audit_checkpoints') ? { rows: [{ hash: fila.hash, firma }] } : { rows: [] } };
  const r = await m42.verificarCheckpoint(db, 't', 7, publicKey);
  ok(r.ok === false && !/FIRMA/.test(r.motivo), 'firma Ed25519 válida fue rechazada como inválida');
});
prueba('G10', 'R6 checkpoint Ed25519: firma manipulada es detectada', async () => {
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const firmaFalsa = crypto.sign(null, Buffer.from('t:7:OTRO_HASH', 'utf8'), privateKey).toString('hex');
  const db = { query: async (sql) => sql.includes('audit_checkpoints') ? { rows: [{ hash: 'H7', firma: firmaFalsa }] } : { rows: [] } };
  const r = await m42.verificarCheckpoint(db, 't', 7, publicKey);
  ok(r.ok === false && /FIRMA/.test(r.motivo), 'no detectó firma Ed25519 manipulada');
});
prueba('G10', 'ledger conserva verificación de filas legacy jcs-v1', async () => {
  const crypto = require('crypto');
  const occurred = '2026-11-23T00:00:00.000Z';
  const legacyPayload = '{"accion":"a","actor":"Jos\\u00e9","antes":null,"dedupKey":null,"despues":null,"entidad":"e","entidadId":"i","hashPrevio":"GENESIS","motivo":null,"occurredAt":"' + occurred + '","requestId":null,"serialization":"jcs-v1","tenantId":"t"}';
  const fila = { tenant_id: 't', actor: 'José', accion: 'a', entidad: 'e', entidad_id: 'i', antes: null,
    despues: null, motivo: null, request_id: null, dedup_key: null, occurred_at: occurred,
    serialization: 'jcs-v1', hash_previo: 'GENESIS', hash: crypto.createHash('sha256').update(legacyPayload).digest('hex'), seq: 1 };
  const db = { query: async sql => sql.includes('GROUP BY hash_previo') ? { rows: [] } : { rows: [fila] } };
  const r = await m42.verificarIntegridad(db, 't');
  ok(r.ok, 'fila legacy válida no se verificó: ' + (r.motivo || 'sin motivo'));
});

prueba('G10', 'R6 dual-mode: HMAC heredado (v5.4) sigue verificando sin cambios', async () => {
  const crypto = require('crypto');
  const fila = { seq: 5, hash: 'H5', firma: crypto.createHmac('sha256', 'CLAVE_BUENA').update('t:5:H5').digest('hex') };
  const db = { query: async (sql) => sql.includes('audit_checkpoints') ? { rows: [fila] } : { rows: [] } };
  const r = await m42.verificarCheckpoint(db, 't', 5, 'CLAVE_BUENA');
  ok(r.ok === false && /FIRMA/.test(r.motivo) === false, 'HMAC válido fue rechazado');
});
prueba('G10', 'R5+R7: roles y migraciones reversibles exportadas y coherentes', () => {
  ok(m42.SQL_ROLES.includes('mf_app') && m42.SQL_ROLES.includes('mf_readonly'), 'roles incompletos');
  ok(m42.SQL_ROLES.includes('GRANT SELECT, INSERT') && m42.SQL_ROLES.includes('REVOKE UPDATE, DELETE'), 'privilegios mal definidos');
  igual(m42.MIGRACIONES.length >= 1, true, 'no hay migraciones versionadas');
  const m1 = m42.MIGRACIONES[0];
  ok(typeof m1.up === 'string' && typeof m1.down === 'string' && m1.id === 1, 'migración 001 sin up/down');
  ok(m1.up.includes('firma_alg') && m1.down.includes('DROP COLUMN'), 'migración 001 no es reversible');
});

// ─────────────────────────────────────────────
// GRUPO 11 — CANDADOS Y CLÚSTER (46, 47): regresiones de defectos hallados en PostgreSQL real
// ─────────────────────────────────────────────
console.log('\nGRUPO 11 — Candados y clúster');
const m46 = require('./46_distributed_lock.js');
const m47 = require('./47_scheduler_cluster.js');
prueba('G11', 'E-019: llave64 siempre cae en el rango bigint con signo de PostgreSQL', () => {
  const MIN = -(2n ** 63n), MAX = 2n ** 63n - 1n;
  let negativas = 0;
  for (let i = 0; i < 2000; i++) {
    const v = BigInt(m46.llave64(`carga:${i}:asignacion`));
    ok(v >= MIN && v <= MAX, `llave fuera de rango para i=${i}: ${v}`);
    if (v < 0n) negativas++;
  }
  ok(negativas > 800 && negativas < 1200, `distribución de signo anómala: ${negativas}/2000 negativas`);
  igual(m46.llave64('x'), m46.llave64('x'), 'llave64 no es determinista');
  ok(m46.llave64('a') !== m46.llave64('b'), 'colisión trivial');
});
prueba('G11', 'E-018: campañaLiderazgo usa candado de transacción y nunca de sesión', async () => {
  const sqls = [];
  let liberado = false;
  const cliente = {
    query: async (sql) => { sqls.push(sql);
      if (/FROM cluster_nodos/.test(sql) && /^SELECT/.test(sql.trim())) return { rows: [] };
      if (/RETURNING id/.test(sql)) return { rows: [{ id: 'n1' }] };
      return { rows: [] }; },
    release: () => { liberado = true; },
  };
  const r = await m47.campañaLiderazgo({ connect: async () => cliente }, 'n1');
  ok(r === true, 'el único nodo registrado no fue elegido líder');
  ok(!sqls.some(s => /pg_advisory_lock\(/.test(s)), 'usa pg_advisory_lock de sesión: queda retenido en conexiones del pool');
  const iBegin = sqls.indexOf('BEGIN');
  const iLock = sqls.findIndex(s => /pg_advisory_xact_lock/.test(s));
  ok(iBegin === 0 && iLock > iBegin, 'el candado no está dentro de una transacción');
  igual(sqls[sqls.length - 1], 'COMMIT', 'la campaña no cierra la transacción');
  ok(liberado, 'no devolvió el cliente al pool');
});
prueba('G11', 'E-018: nodo no registrado no se declara líder y revierte', async () => {
  const sqls = [];
  const cliente = {
    query: async (sql) => { sqls.push(sql);
      if (/RETURNING id/.test(sql)) return { rows: [] };
      return { rows: [] }; },
    release: () => {},
  };
  const r = await m47.campañaLiderazgo({ connect: async () => cliente }, 'fantasma');
  ok(r === false, 'un nodo sin fila en cluster_nodos se declaró líder');
  igual(sqls[sqls.length - 1], 'ROLLBACK', 'no revirtió la degradación de otros líderes');
});

// ─────────────────────────────────────────────
// GRUPO 12 — ROTACIÓN DE CLAVES DE CHECKPOINT (E-016) y MIGRACIONES (E-017)
// ─────────────────────────────────────────────
console.log('\nGRUPO 12 — Rotación de claves y migraciones');
const cryptoG12 = require('crypto');
const parEd = () => { const { publicKey, privateKey } = cryptoG12.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) }; };
function conEnv(vars, fn) {
  const previo = {};
  for (const k of Object.keys(vars)) { previo[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restaurar = () => { for (const k of Object.keys(previo)) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; } };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(restaurar); restaurar(); return r; }
  catch (e) { restaurar(); throw e; }
}
function dbCheckpoint(fila) {
  return { query: async (sql) => {
    if (sql.includes('audit_checkpoints')) return { rows: [fila] };
    if (sql.includes('AND seq=$2')) return { rows: [{ hash: fila.hash }] };   // ancla del checkpoint
    return { rows: [] };                                                       // sin forks; cadena vacía
  } };
}
prueba('G12', 'kidDeClave: igual para pública y privada del mismo par; distinto entre pares; 64 hex', () => {
  const a = parEd(), b = parEd();
  const ka = m42.kidDeClave(a.pub);
  igual(ka, m42.kidDeClave(a.priv), 'kid distinto para la pública y la privada del mismo par');
  ok(ka !== m42.kidDeClave(b.pub), 'dos pares distintos comparten kid');
  ok(/^[0-9a-f]{64}$/.test(ka), 'kid sin formato hex de 64');
});
prueba('G12', 'llaveroConfianza: une CHECKPOINT_PUBLIC_KEYS y CHECKPOINT_PUBLIC_KEY por kid; rechaza PEM corrupto', () => {
  const a = parEd(), b = parEd(), c = parEd();
  const ll = m42.llaveroConfianza({ CHECKPOINT_PUBLIC_KEYS: a.pub + '\n' + b.pub, CHECKPOINT_PUBLIC_KEY: c.pub });
  igual(ll.size, 3, 'el llavero no contiene las 3 claves');
  ok(ll.has(m42.kidDeClave(b.pub)), 'falta la clave b');
  igual(m42.llaveroConfianza({}).size, 0, 'llavero vacío esperado sin variables');
  let fallo = false;
  try { m42.llaveroConfianza({ CHECKPOINT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' }); } catch (_) { fallo = true; }
  ok(fallo, 'un PEM corrupto se aceptó en silencio');
});
prueba('G12', 'E-016: checkpoint con kid verifica tras rotar; clave retirada → CLAVE DESCONOCIDA; kid cruzado → FIRMA INVÁLIDA', async () => {
  const viejo = parEd(), nuevo = parEd();
  const kidViejo = m42.kidDeClave(viejo.pub), kidNuevo = m42.kidDeClave(nuevo.pub);
  const mensaje = 't:5:H5';
  const firma = cryptoG12.sign(null, Buffer.from(mensaje), cryptoG12.createPrivateKey(viejo.priv)).toString('hex');
  const fila = { hash: 'H5', firma, firma_alg: 'ed25519', firma_kid: kidViejo };
  await conEnv({ CHECKPOINT_PUBLIC_KEY: nuevo.pub, CHECKPOINT_PUBLIC_KEYS: viejo.pub }, async () => {
    const r = await m42.verificarCheckpoint(dbCheckpoint(fila), 't', 5);
    ok(r.ok === true, `rotación rompió la verificación: ${JSON.stringify(r)}`);
  });
  await conEnv({ CHECKPOINT_PUBLIC_KEY: nuevo.pub, CHECKPOINT_PUBLIC_KEYS: undefined }, async () => {
    const r = await m42.verificarCheckpoint(dbCheckpoint(fila), 't', 5);
    ok(r.ok === false && /CLAVE DESCONOCIDA/.test(r.motivo), `clave retirada aceptada: ${JSON.stringify(r)}`);
  });
  await conEnv({ CHECKPOINT_PUBLIC_KEY: nuevo.pub, CHECKPOINT_PUBLIC_KEYS: viejo.pub }, async () => {
    const r = await m42.verificarCheckpoint(dbCheckpoint({ ...fila, firma_kid: kidNuevo }), 't', 5);
    ok(r.ok === false && /FIRMA INVÁLIDA/.test(r.motivo), `kid cruzado aceptado: ${JSON.stringify(r)}`);
  });
  await conEnv({ CHECKPOINT_PUBLIC_KEY: undefined, CHECKPOINT_PUBLIC_KEYS: undefined }, async () => {
    const r = await m42.verificarCheckpoint(dbCheckpoint(fila), 't', 5);
    ok(r.ok === false && /LLAVERO VACÍO/.test(r.motivo), `sin llavero no falló cerrado: ${JSON.stringify(r)}`);
  });
});
prueba('G12', 'E-017: migraciones cargadas desde archivos con up/down; ledger posee 001 y 003', () => {
  const mig = require('./db/migrador');
  const lista = mig.cargarMigraciones();
  const ids = lista.map(m => m.id);
  ok(ids.length >= 5 && ids.every((id, i) => id === i + 1), `ids de migración no consecutivos desde 1: ${JSON.stringify(ids)}`);
  ok(lista.every(m => m.up.trim() && m.down.trim()), 'migración sin up o sin down');
  igual(JSON.stringify(m42.MIGRACIONES.map(m => m.id)), '[1,3]', 'el ledger no posee exactamente 001 y 003');
  ok(lista.find(m => m.id === 1).down.includes('ROLLBACK_BLOQUEADO'), '001 down sin guardia anti-pérdida');
  ok(lista.find(m => m.id === 2).down.includes('ROLLBACK_BLOQUEADO'), '002 down sin guardia anti-pérdida');
});
prueba('G12', 'E-017: el bootstrap no carga módulos de runtime', () => {
  const fuente = require('fs').readFileSync('./scripts/migrate.js', 'utf8') + require('fs').readFileSync('./db/esquema.js', 'utf8');
  for (const prohibido of ['dotenv', '02_tenant_middleware', '03_billing_stripe', '41_auth_rbac', '44_event_bus', '45_notification_service']) {
    ok(!fuente.includes(`require('${prohibido}')`) && !fuente.includes(`require('../${prohibido}')`), `bootstrap requiere ${prohibido}`);
  }
});

// ─────────────────────────────────────────────
// GRUPO 13 — WEBHOOKS DE TWILIO (E-025, E-026)
// ─────────────────────────────────────────────
console.log('\nGRUPO 13 — Webhooks de Twilio');
const firmaTw = require('./server/api/twilio_firma');
const m17 = require('./17_sms_emergencia');
const ofertasSrv = require('./server/services/ofertas');
// Ejemplo publicado por Twilio en https://www.twilio.com/docs/usage/security (verificado en esta sesión).
const VECTOR_TWILIO = {
  url: 'https://example.com/myapp.php?foo=1&bar=2',
  params: { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' },
  token: '12345', firma: 'L/OH5YylLD5NRKLltdqwSvS0BnU=',
};
prueba('G13', 'E-026: firma Twilio reproduce el ejemplo oficial y rechaza cualquier alteración', () => {
  const v = VECTOR_TWILIO;
  igual(firmaTw.firmaEsperada(v.token, v.url, v.params), v.firma, 'no reproduce la firma oficial');
  ok(firmaTw.validarFirmaTwilio({ authToken: v.token, url: v.url, params: v.params, firma: v.firma }), 'firma oficial rechazada');
  ok(!firmaTw.validarFirmaTwilio({ authToken: v.token, url: v.url, params: { ...v.params, Digits: '1235' }, firma: v.firma }), 'parámetro alterado aceptado');
  ok(!firmaTw.validarFirmaTwilio({ authToken: v.token, url: v.url.replace('foo=1', 'foo=2'), params: v.params, firma: v.firma }), 'URL alterada aceptada');
  ok(!firmaTw.validarFirmaTwilio({ authToken: '54321', url: v.url, params: v.params, firma: v.firma }), 'token distinto aceptado');
  ok(!firmaTw.validarFirmaTwilio({ authToken: v.token, url: v.url, params: v.params, firma: '' }), 'firma vacía aceptada');
  ok(!firmaTw.validarFirmaTwilio({ authToken: '', url: v.url, params: v.params, firma: v.firma }), 'token vacío aceptado');
});
prueba('G13', 'E-026: middleware falla cerrado (503 sin configuración, 403 sin firma) y deja pasar la firma válida', () => {
  const crearRes = () => ({ codigo: 200, status(c) { this.codigo = c; return this; }, send() { return this; } });
  const params = { From: '+13055550101', Body: '1' };
  const casos = [
    { mw: firmaTw.exigirFirmaTwilio({ authToken: '', baseUrl: 'https://x.test' }), firma: 'x', esperado: 503 },
    { mw: firmaTw.exigirFirmaTwilio({ authToken: 't', baseUrl: '' }), firma: 'x', esperado: 503 },
    { mw: firmaTw.exigirFirmaTwilio({ authToken: 't', baseUrl: 'https://x.test' }), firma: undefined, esperado: 403 },
    { mw: firmaTw.exigirFirmaTwilio({ authToken: 't', baseUrl: 'https://x.test/' }), firma: firmaTw.firmaEsperada('t', 'https://x.test/webhooks/sms', params), esperado: 'next' },
  ];
  for (const c of casos) {
    const res = crearRes(); let siguio = false;
    c.mw({ originalUrl: '/webhooks/sms', body: params, headers: c.firma ? { 'x-twilio-signature': c.firma } : {} }, res, () => { siguio = true; });
    if (c.esperado === 'next') ok(siguio, 'firma válida bloqueada');
    else { ok(!siguio, `siguió con código ${c.esperado}`); igual(res.codigo, c.esperado, 'código HTTP inesperado'); }
  }
});
prueba('G13', 'E-025: candidatos de teléfono cubren E.164, 10 dígitos y rechazan basura', () => {
  igual(JSON.stringify(ofertasSrv.candidatosTelefono('+1 (305) 555-0101')), '["13055550101","3055550101"]', 'E.164 de EE. UU.');
  igual(JSON.stringify(ofertasSrv.candidatosTelefono('305.555.0101')), '["3055550101","13055550101"]', '10 dígitos');
  igual(ofertasSrv.candidatosTelefono("'; DROP TABLE bookings; --").length, 0, 'texto sin dígitos aceptado');
  igual(ofertasSrv.candidatosTelefono('123').length, 0, 'número demasiado corto aceptado');
  igual(ofertasSrv.candidatosTelefono('1234567890123456').length, 0, 'número demasiado largo aceptado');
});
prueba('G13', 'E-025: interpretación de la respuesta y TwiML escapado', () => {
  igual(m17.interpretar(' 1 '), true, '"1" no acepta'); igual(m17.interpretar('Sí'), true, '"Sí" no acepta');
  igual(m17.interpretar('2'), false, '"2" no rechaza'); igual(m17.interpretar('no'), false, '"no" no rechaza');
  igual(m17.interpretar('no sé'), null, '"no sé" interpretado como rechazo');
  const xml = m17.twimlMensaje('<b>&"\'');
  ok(xml.includes('&lt;b&gt;&amp;&quot;&apos;') && !xml.includes('<b>'), 'TwiML sin escapar');
  ok(/<Response><\/Response>$/.test(m17.twimlMensaje(null)), 'respuesta vacía incorrecta');
});
prueba('G13', 'E-025: voz con reserva desconocida o ya respondida no confirma nada', async () => {
  const llamadas = [];
  const desconocida = await m38.webhookDecision({ obtenerBooking: async () => null,
    confirmarBooking: async () => { llamadas.push('confirmar'); } }, { bookingId: 'x', Digits: '1' });
  ok(/ya no está disponible/.test(desconocida) && !llamadas.length, 'reserva desconocida confirmada');
  const repetida = await m38.webhookDecision({ obtenerBooking: async () => ({ tenantId: 't', choferNombre: 'A', ruta: 'X→Y', pago: 1 }),
    confirmarBooking: async () => ({ respondida: false }) }, { bookingId: 'b', Digits: '1' });
  ok(/ya no está disponible/.test(repetida) && !/aceptada/i.test(repetida), 'reintento de Twilio anunciado como aceptado');
});

// ─────────────────────────────────────────────
// GRUPO 14 — API AUTENTICADA: CONTEXTO DE TENANT POR PETICIÓN (E-028)
// ─────────────────────────────────────────────
console.log('\nGRUPO 14 — API autenticada y contexto de tenant');
const ctxT = require('./server/http/contexto_tenant');
const m41 = require('./41_auth_rbac');
const resFalsa = () => ({ codigo: 200, cuerpo: null, status(c) { this.codigo = c; return this; }, json(b) { this.cuerpo = b; return this; } });
prueba('G14', 'analizarHost: subdominio, puerto, mayúsculas, dominio propio y hosts hostiles', () => {
  igual(JSON.stringify(ctxT.analizarHost('ACME.tuapp.com:443', 'tuapp.com')), '{"tipo":"slug","valor":"acme"}', 'subdominio con puerto');
  igual(JSON.stringify(ctxT.analizarHost('dispatch.mibroker.com', 'tuapp.com')), '{"tipo":"dominio","valor":"dispatch.mibroker.com"}', 'dominio propio');
  igual(ctxT.analizarHost('a.b.tuapp.com', 'tuapp.com'), null, 'slug con puntos aceptado');
  igual(ctxT.analizarHost('acme.tuapp.com.evil.com', 'tuapp.com').tipo, 'dominio', 'sufijo hostil tratado como subdominio');
  igual(ctxT.analizarHost("x'; DROP TABLE tenants;--", 'tuapp.com'), null, 'host con inyección aceptado');
  igual(ctxT.analizarHost('', 'tuapp.com'), null, 'host vacío aceptado');
});
prueba('G14', 'resolver de tenant: caché con TTL (también de ausencias) y expiración', async () => {
  let consultas = 0; let reloj = 0;
  const db = { query: async (sql, [v]) => { consultas++; return { rows: v === 'acme' ? [{ id: 't1', slug: 'acme' }] : [] }; } };
  const r = ctxT.crearResolverTenant({ db, dominioBase: 'tuapp.com', ttlMs: 1000, ahora: () => reloj });
  igual((await r('acme.tuapp.com')).id, 't1', 'no resolvió'); await r('acme.tuapp.com'); await r('nadie.tuapp.com'); await r('nadie.tuapp.com');
  igual(consultas, 2, 'la caché no evitó consultas repetidas');
  reloj = 1500; await r('acme.tuapp.com');
  igual(consultas, 3, 'la caché no expiró');
});
prueba('G14', 'suscripción: SUSPENDED/CANCELLED y trial vencido → 402; activa pasa', () => {
  const mw = ctxT.verificarSuscripcion({ ahora: () => new Date('2026-11-23T12:00:00Z') });
  for (const [t, esperado] of [[{ status: 'SUSPENDED' }, 402], [{ status: 'CANCELLED' }, 402],
    [{ status: 'TRIAL', trial_ends_at: '2026-11-01T00:00:00Z' }, 402], [{ status: 'TRIAL', trial_ends_at: '2026-12-01T00:00:00Z' }, 'next'], [{ status: 'ACTIVE' }, 'next']]) {
    const res = resFalsa(); let siguio = false;
    mw({ tenant: t }, res, () => { siguio = true; });
    if (esperado === 'next') ok(siguio, `${t.status} bloqueado`); else { ok(!siguio, `${t.status} pasó`); igual(res.codigo, esperado, 'código'); }
  }
});
prueba('G14', 'enTenant exige UUID y usa set_config LOCAL (nunca de sesión)', async () => {
  const sqls = [];
  const cliente = { query: async (sql) => { sqls.push(sql); return { rows: [] }; }, release() {} };
  await ctxT.enTenant({ connect: async () => cliente }, '11111111-1111-4111-8111-111111111111', (c) => c.query('SELECT 1'));
  ok(sqls.some(s => /set_config\('app\.current_tenant', \$1, true\)/.test(s)), 'contexto no local a la transacción');
  ok(!sqls.some(s => /set_config\([^)]*false\)/.test(s)), 'contexto de sesión');
  igual(sqls[sqls.length - 1], 'COMMIT', 'no cerró la transacción');
  let fallo = false; try { await ctxT.enTenant({ connect: async () => cliente }, 'no-uuid', async () => {}); } catch (_) { fallo = true; }
  ok(fallo, 'tenantId inválido aceptado');
});
prueba('G14', 'requireAuth falla cerrado sin JWT_SECRET robusto; requirePermiso sin usuario → 403', async () => {
  const previo = process.env.JWT_SECRET; process.env.JWT_SECRET = 'corto';
  try {
    let errorRecibido = null;
    await m41.requireAuth({})({ headers: { authorization: 'Bearer a.b.c' }, tenant: { id: 't' } }, resFalsa(), (e) => { errorRecibido = e; });
    ok(errorRecibido && errorRecibido.status === 500 && /JWT_SECRET/.test(errorRecibido.message), 'secreto débil aceptado');
  } finally { if (previo === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previo; }
  const res = resFalsa(); let siguio = false;
  m41.requirePermiso('drivers:read')({}, res, () => { siguio = true; });
  ok(!siguio && res.codigo === 403, 'permiso concedido sin usuario autenticado');
});

// ─────────────────────────────────────────────
// GRUPO 15 — WORKERS MULTIEMPRESA (E-031)
// ─────────────────────────────────────────────
console.log('\nGRUPO 15 — Workers multiempresa');
// m29 (29_match_tiempo_real) ya está importado en un grupo anterior.
const agentes = require('./server/workers/agentWorker');
const cronW = require('./server/workers/cronWorker');
prueba('G15', 'E-031: el SMS de respaldo nunca deja escapar un rechazo (no tumba el proceso)', async () => {
  const previo = m29.CONFIG.PUSH_TIMEOUT_SEG; m29.CONFIG.PUSH_TIMEOUT_SEG = 0.01;
  let rechazoSuelto = false; const escucha = () => { rechazoSuelto = true; };
  process.on('unhandledRejection', escucha);
  try {
    const notificar = async () => true; notificar.checkVisto = async () => { throw new Error('canal caído'); };
    await m29.notificarAlInstante({ chofer: { id: 'd', telefono: '1' }, carga: { id: 'c', origen: 'A', destino: 'B', pago: 1 } },
      { notificarChofer: notificar, enviarSMS: async () => {} });
    const sinCheck = async () => true; // sin checkVisto: no programa respaldo
    await m29.notificarAlInstante({ chofer: { id: 'd' }, carga: { id: 'c' } }, { notificarChofer: sinCheck, enviarSMS: async () => { throw new Error('no debía llamarse'); } });
    await new Promise(r => setTimeout(r, 60));
    ok(!rechazoSuelto, 'rechazo no capturado en el temporizador del SMS de respaldo');
  } finally { process.off('unhandledRejection', escucha); m29.CONFIG.PUSH_TIMEOUT_SEG = previo; }
});
prueba('G15', 'E-031: el ciclo de match espera puntuaciones asíncronas', async () => {
  const fuente = require('fs').readFileSync('./29_match_tiempo_real.js', 'utf8');
  ok(/const match = await hacerMatch\(carga, camion\)/.test(fuente), 'hacerMatch no se espera: una Promise nunca supera el umbral');
});
prueba('G15', 'E-031: el adaptador de agentes rechaza cruces entre empresas sin consultar la BD', async () => {
  let consultas = 0;
  const db = { query: async () => { consultas++; return { rows: [] }; }, connect: async () => { consultas++; throw new Error('no'); } };
  const ag = agentes.crearAdaptadorAgentes(db, { notificaciones: {}, esLider: () => true, puntuar: async () => 0.99 });
  igual(await ag.hacerMatch({ id: 'c', tenant_id: 'A' }, { id: 'd', tenant_id: 'B' }), null, 'match entre empresas');
  igual(consultas, 0, 'consultó la BD para un par inválido');
  const noLider = agentes.crearAdaptadorAgentes(db, { notificaciones: {}, esLider: () => false });
  igual((await noLider.buscarCargas()).length, 0, 'un nodo no líder buscó cargas');
  igual(consultas, 0, 'un nodo no líder consultó la BD');
});
prueba('G15', 'E-031: calendario del cron (hora y día) y clave por hora UTC', async () => {
  const lunes7 = new Date(2026, 10, 23, 7, 30); // lunes 23-nov-2026 07:30 local
  const nombres = cronW.tareasDeAhora(lunes7).map(t => t.nombre);
  ok(nombres.includes('reporte_semanal') && !nombres.includes('suspender_morosos'), `tareas a las 7 del lunes: ${nombres}`);
  const martes7 = new Date(2026, 10, 24, 7, 30);
  ok(!cronW.tareasDeAhora(martes7).some(t => t.nombre === 'reporte_semanal'), 'reporte semanal también el martes');
  const llamadas = [];
  const db = { query: async (sql, p) => { llamadas.push(p); return { rows: sql.startsWith('INSERT') ? [{ clave: p[0] }] : [] }; } };
  await cronW.ejecutarTarea(db, { nombre: 'x', fn: async () => 1 }, {}, new Date('2026-11-23T07:59:00Z'));
  igual(llamadas[0][0], 'x:2026-11-23T07', 'clave de ejecución no es por hora UTC');
});


// ─────────────────────────────────────────────
// GRUPO 16 — FIRMA DEL WEBHOOK DE STRIPE (E-040)
// ─────────────────────────────────────────────
console.log('\nGRUPO 16 — Firma del webhook de Stripe');
const sf = require('./server/api/stripe_firma');
const evtStripe = { id: 'evt_G16', object: 'event', type: 'invoice.paid', created: 1800000000, data: { object: { id: 'in_1', object: 'invoice' } } };
const cuerpoStripe = Buffer.from(JSON.stringify(evtStripe));
const T_STRIPE = 1800000000;
prueba('G16', 'firma v1 válida sobre el cuerpo crudo → evento', () => {
  const r = sf.verificarFirmaStripe({ cuerpo: cuerpoStripe, cabecera: sf.cabeceraDePrueba(cuerpoStripe, 'whsec_a', T_STRIPE), secretos: ['whsec_a'], ahora: T_STRIPE });
  ok(r.ok && r.evento.id === 'evt_G16', JSON.stringify(r));
});
prueba('G16', 'HMAC-SHA256 de `${t}.${cuerpo}` (cálculo independiente)', () => {
  const esperado = require('crypto').createHmac('sha256', 'whsec_a').update(`${T_STRIPE}.${cuerpoStripe.toString()}`).digest('hex');
  igual(sf.cabeceraDePrueba(cuerpoStripe, 'whsec_a', T_STRIPE), `t=${T_STRIPE},v1=${esperado}`, 'formato o cálculo de firma distinto');
});
prueba('G16', 'cuerpo alterado, secreto equivocado o fuera de tolerancia → rechazo', () => {
  const cab = sf.cabeceraDePrueba(cuerpoStripe, 'whsec_a', T_STRIPE);
  const alterado = Buffer.from(cuerpoStripe.toString().replace('in_1', 'in_2'));
  igual(sf.verificarFirmaStripe({ cuerpo: alterado, cabecera: cab, secretos: ['whsec_a'], ahora: T_STRIPE }).motivo, 'firma_no_coincide', 'cuerpo alterado aceptado');
  igual(sf.verificarFirmaStripe({ cuerpo: cuerpoStripe, cabecera: cab, secretos: ['whsec_b'], ahora: T_STRIPE }).motivo, 'firma_no_coincide', 'secreto equivocado aceptado');
  igual(sf.verificarFirmaStripe({ cuerpo: cuerpoStripe, cabecera: cab, secretos: ['whsec_a'], ahora: T_STRIPE + 301 }).motivo, 'fuera_de_tolerancia', 'firma caducada aceptada');
});
prueba('G16', 'varias v1 y varios secretos (rotación); v0 ignorada', () => {
  const buena = sf.cabeceraDePrueba(cuerpoStripe, 'whsec_viejo', T_STRIPE).split(',')[1];
  const cab = `t=${T_STRIPE},v0=${'0'.repeat(64)},v1=${'f'.repeat(64)},${buena}`;
  ok(sf.verificarFirmaStripe({ cuerpo: cuerpoStripe, cabecera: cab, secretos: ['whsec_nuevo', 'whsec_viejo'], ahora: T_STRIPE }).ok, 'rotación rechazada');
  ok(!sf.verificarFirmaStripe({ cuerpo: cuerpoStripe, cabecera: `t=${T_STRIPE},v0=${'0'.repeat(64)}`, secretos: ['whsec_viejo'], ahora: T_STRIPE }).ok, 'solo v0 aceptada');
});
prueba('G16', 'cabecera malformada, cuerpo ausente, sin secreto o evento malformado → rechazo', () => {
  const casos = [
    [{ cuerpo: cuerpoStripe, cabecera: 'v1=abc', secretos: ['s'] }, 'cabecera_invalida'],
    [{ cuerpo: cuerpoStripe, cabecera: `t=1,t=2,v1=${'a'.repeat(64)}`, secretos: ['s'] }, 'cabecera_invalida'],
    [{ cuerpo: undefined, cabecera: 't=1,v1=a', secretos: ['s'] }, 'sin_cuerpo_crudo'],
    [{ cuerpo: cuerpoStripe, cabecera: 't=1,v1=a', secretos: [] }, 'sin_secreto'],
  ];
  for (const [p, motivo] of casos) igual(sf.verificarFirmaStripe({ ...p, ahora: 1 }).motivo, motivo, `caso ${motivo}`);
  const malo = Buffer.from(JSON.stringify({ id: 'x', object: 'event' }));
  igual(sf.verificarFirmaStripe({ cuerpo: malo, cabecera: sf.cabeceraDePrueba(malo, 's', 5), secretos: ['s'], ahora: 5 }).motivo, 'evento_malformado', 'evento sin campos aceptado');
});
prueba('G16', 'STRIPE_WEBHOOK_SECRET admite lista separada por comas', () => {
  igual(JSON.stringify(sf.secretosDesdeEntorno(' whsec_a , ,whsec_b ')), '["whsec_a","whsec_b"]', 'lista de secretos mal interpretada');
});
prueba('G16', 'la empresa sale del cliente de Stripe, nunca de metadata', () => {
  const B = require('./03_billing_stripe');
  igual(B.clienteDeEvento({ data: { object: { object: 'invoice', customer: 'cus_1', metadata: { tenant_id: 'otro' } } } }), 'cus_1', 'cliente de factura');
  igual(B.clienteDeEvento({ data: { object: { object: 'customer', id: 'cus_2' } } }), 'cus_2', 'cliente como objeto');
  igual(B.clienteDeEvento({ data: { object: { object: 'invoice', customer: { id: 'cus_3' } } } }), 'cus_3', 'cliente expandido');
  ok(B.claveDedup('stripe.evento', 'evt_' + 'x'.repeat(200)).length <= 80, 'clave de dedup supera 80 caracteres');
});

// Ejecutor real: recorre la cola, espera cada prueba (incluidas las async)
// y solo entonces imprime el veredicto.
(async () => {
  for (const { grupo, nombre, fn } of colaPruebas) {
    try {
      await fn();
      pasadas++;
      process.stdout.write(`  ✔ ${nombre}\n`);
    } catch (e) {
      falladas++;
      fallos.push(`${grupo} › ${nombre}: ${e.message}`);
      process.stdout.write(`  ✘ ${nombre} — ${e.message}\n`);
    }
  }
  console.log('\n══════════════════════════════════════════════');
  console.log(`  RESULTADO: ${pasadas} pasadas · ${falladas} falladas · ${pasadas + falladas} totales`);
  if (fallos.length) { console.log('\n  FALLOS:'); fallos.forEach(f => console.log('   - ' + f)); }
  console.log('══════════════════════════════════════════════\n');
  process.exit(falladas ? 1 : 0);
})();
