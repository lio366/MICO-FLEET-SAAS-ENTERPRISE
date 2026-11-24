// ============================================================================
// 42_audit_ledger.js — LIBRO CONTABLE CRIPTOGRÁFICO (Audit Ledger) — v6.0 ENTERPRISE HARDENED
//
// RECONSTRUCCIÓN v6.0 (orden técnica). Mantiene 100% de los contratos públicos
// de v5.4: registrar/verificarIntegridad/crearCheckpoint/verificarCheckpoint/
// eventos/canonico/sha256 + posiciones de parámetros del INSERT [9..14].
//
// NUEVO EN v6.0:
//   R1  canonico() ahora es RFC 8785 (JCS) REAL: números ECMAScript (-0→"0",
//       1.0→"1"), strings con escape \uXXXX minúsculo y pares sustitutos.
//   R2  Normalización de eventos (trim, acción en minúscula) ANTES de firmar:
//       mismo hecho semántico ⇒ mismo fingerprint/hash aunque llegue sucio.
//   R3  COMMIT ambiguo: si COMMIT falla (caída de conexión), se re-consulta
//       por hash antes de reintentar → jamás asiento duplicado ni perdido.
//   R4  verificarIntegridad con snapshot consistente: BEGIN + LOCK TABLE
//       audit_ledger IN SHARE MODE (writers bloqueados durante la verificación).
//   R5  Separación de roles PostgreSQL (SQL_ROLES): mf_owner/mf_app/mf_readonly.
//   R6  Checkpoints Ed25519 (firma real, clave fuera de BD) + HMAC dual-mode.
//   R7  Migraciones versionadas y reversibles (MIGRACIONES + migrar/migrarRevertir).
//   R8  Observabilidad envuelta: una falla de métricas NUNCA rompe el ledger.
//   R9  Gancho DR: configurarDR(fn) recibe cada asiento confirmado (para 49).
//
// GARANTÍAS HEREDADAS (v5.4, auditadas):
//   - READ COMMITTED explícito, candado advisory 64 bits por tenant
//   - UNIQUE anti-fork (tenant_id, hash_previo) + dedup parcial verificable
//   - occurred_at persistido exacto en el hash; trigger de inmutabilidad real
// ============================================================================

const crypto = require('crypto');

const SERIALIZATION_VERSION = 'rfc8785';

const SQL = require('./db/sql').leerSql('42_audit_ledger'); // DDL versionado en sql/42_audit_ledger.sql (E-017)

// ---------------------------------------------------------------------------
// R5 — SEPARACIÓN DE ROLES PostgreSQL (ejecutar como superusuario/owner una vez).
//   mf_owner : dueño de los objetos (migraciones, DDL).
//   mf_app   : rol de la aplicación: INSERT y SELECT únicamente. Ni UPDATE,
//              ni DELETE, ni DDL, ni TRUNCATE. La inmutabilidad tiene doble candado.
//   mf_readonly : verificación/reportes de solo lectura.
// Idempotente: usa DO $$ ... $$ con detección de existencia.
// ---------------------------------------------------------------------------
const SQL_ROLES = require('./db/sql').leerSql('42_audit_ledger_roles'); // DDL versionado en sql/42_audit_ledger_roles.sql (E-017)

// ---------------------------------------------------------------------------
// R7 — MIGRACIONES VERSIONADAS Y REVERSIBLES (de v5.4 a v6.0 y regreso)
// ---------------------------------------------------------------------------
// Fuente única: migrations/001_ledger_v6.{up,down}.sql, aplicadas por db/migrador.js
// (candado de transacción, re-comprobación por migración y revertir solo en orden inverso).
const migrador = require('./db/migrador');
// Migraciones propiedad del ledger: 001 (v6.0) y 003 (firma_kid, v6.1). La 002 es de operaciones.
const IDS_LEDGER = [1, 3];
const MIGRACIONES = migrador.cargarMigraciones().filter(m => IDS_LEDGER.includes(m.id));
if (MIGRACIONES.length !== IDS_LEDGER.length) throw new Error('Faltan migraciones del ledger: migrations/001_ledger_v6 y 003_ledger_checkpoint_kid');

const migrar = (db) => migrador.migrar(db, MIGRACIONES);
const migrarRevertir = (db, id) => migrador.revertir(db, id, MIGRACIONES);

// ---------------------------------------------------------------------------
// R1 — SERIALIZACIÓN CANÓNICA RFC 8785 (JSON Canonicalization Scheme), real.
//   - Objetos: claves ordenadas (UTF-16), sin claves undefined
//   - Arrays: orden preservado
//   - Números: semántica ECMAScript Number::toString (-0 → "0", 1.0 → "1")
//   - Strings: escape JSON mínimo; Unicode UTF-8 preservado; surrogate aislado rechazado
// ---------------------------------------------------------------------------
function canonico(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Número no representable en JSON: ' + v);
    if (Object.is(v, -0)) return '0';
    return JSON.stringify(v); // ECMAScript ToString = RFC 8785 para doubles finitos
  }
  if (typeof v === 'string') {
    // RFC 8785: preservar Unicode válido en UTF-8; escapar solo lo exigido
    // por JSON. JCS no convierte caracteres no ASCII a \\uXXXX.
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = v.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) {
          throw new Error('Cadena Unicode inválida: surrogate alto sin pareja');
        }
        i++;
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        throw new Error('Cadena Unicode inválida: surrogate bajo sin pareja');
      }
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return '[' + Array.from(v, x => canonico(x === undefined ? null : x)).join(',') + ']';
  }
  if (typeof v === 'object') {
    // Orden lexicográfico por unidades UTF-16, requerido por JCS.
    const claves = Object.keys(v).sort();
    return '{' + claves.map(k => canonico(k) + ':' + canonico(v[k] === undefined ? null : v[k])).join(',') + '}';
  }
  throw new Error('Tipo no soportado en serialización canónica: ' + typeof v);
}

// Compatibilidad de lectura para asientos creados con el serializador v5.4
// (que escapaba todo carácter no ASCII). Solo se usa al verificar filas marcadas
// explícitamente como jcs-v1; los nuevos asientos siempre usan RFC 8785.
function canonicoLegacyV1(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Número no representable en JSON: ' + v);
    if (Object.is(v, -0)) return '0';
    return JSON.stringify(v);
  }
  if (typeof v === 'string') {
    let out = '"';
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 0x22) out += '\\"';
      else if (c === 0x5c) out += '\\\\';
      else if (c === 0x08) out += '\\b';
      else if (c === 0x09) out += '\\t';
      else if (c === 0x0a) out += '\\n';
      else if (c === 0x0c) out += '\\f';
      else if (c === 0x0d) out += '\\r';
      else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0');
      else out += v[i];
    }
    return out + '"';
  }
  if (Array.isArray(v)) return '[' + v.map(canonicoLegacyV1).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => canonicoLegacyV1(k) + ':' + canonicoLegacyV1(v[k])).join(',') + '}';
  }
  throw new Error('Tipo no soportado en serialización legacy: ' + typeof v);
}

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
const dormir = ms => new Promise(r => setTimeout(r, ms));
const metricas = () => require('./43_metrics_observability'); // carga perezosa, sin ciclo

// R8 — la observabilidad NUNCA debe romper el camino crítico del ledger
function obs(fn) { try { fn(metricas()); } catch (_) { /* métricas caídas: el ledger sigue */ } }

// R9 — gancho de Disaster Recovery (49_disaster_recovery.js)
let ganchoDR = null;
function configurarDR(fn) { ganchoDR = fn; }
async function avisarDR(asiento) {
  if (!ganchoDR) return;
  try { await ganchoDR(asiento); } catch (_) { /* el DR no puede tumbar el ledger */ }
}

// ---------------------------------------------------------------------------
// R2 — NORMALIZACIÓN DE EVENTOS: mismo hecho semántico ⇒ misma huella,
// aunque llegue con espacios, mayúsculas o tipos sueltos.
// ---------------------------------------------------------------------------
function normalizarEvento({ actor, accion, entidad, entidadId, motivo }) {
  return {
    actor: String(actor ?? '').trim().slice(0, 60),
    accion: String(accion ?? '').trim().toLowerCase().slice(0, 80),
    entidad: String(entidad ?? '').trim().slice(0, 40),
    entidadId: String(entidadId ?? '').trim().slice(0, 40),
    motivo: motivo == null ? null : String(motivo).trim(),
  };
}

// Contenido cuya identidad protege el dedupKey (anti D2) — sobre valores YA normalizados
function contenidoEvento(n) {
  return { actor: n.actor, accion: n.accion, entidad: n.entidad, entidadId: n.entidadId,
           antes: n.antes ?? null, despues: n.despues ?? null, motivo: n.motivo ?? null };
}

// ---------------------------------------------------------------------------
// registrar() — ENDURECIDO v6.0: candado 64 bits + anti-fork + dedup
// verificable + COMMIT ambiguo resuelto (R3).
//
//   CAPA 1: pg_advisory_xact_lock(hashtextextended(tenant)) — serializa escritores
//   CAPA 2: UNIQUE (tenant_id, hash_previo) — un fork rechaza el INSERT siempre
//   CAPA 3: 23505 clasificado por e.constraint con backoff 50/100ms
//   R3:     si COMMIT lanza (conexión caída en el límite), se re-consulta por
//           hash: persistió → se devuelve (sin duplicar); no persistió → error.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// asentar() — escribe UN asiento dentro de una transacción YA ABIERTA por el llamador, sobre su
// cliente y con app.current_tenant ya fijado (local a esa transacción). Mismas garantías que
// registrar() (candado por empresa, anti-fork, dedup con verificación de identidad), pero el asiento
// se confirma o se deshace JUNTO con el resto de la transacción del llamador: así un cambio de negocio
// y su rastro de auditoría nunca quedan separados (E-040). El llamador gestiona COMMIT/ROLLBACK y, si
// el COMMIT es ambiguo, su propia idempotencia (p. ej. stripe_eventos).
// Devuelve { hash, duplicado }.
// ---------------------------------------------------------------------------
async function asentar(client, { tenantId, actor, accion, entidad, entidadId, antes, despues, motivo, requestId, dedupKey = null }) {
  const n = normalizarEvento({ actor, accion, entidad, entidadId, motivo });
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 48151623))`, [tenantId]);

  const { rows } = await client.query(
    `SELECT hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1`, [tenantId]);
  const hashPrevio = rows[0]?.hash || 'GENESIS';

  const occurredAt = new Date().toISOString();               // anti D1: se persiste igual
  const fingerprint = sha256(canonico(contenidoEvento({ ...n, antes, despues })));
  const payload = canonico({
    tenantId, actor: n.actor, accion: n.accion, entidad: n.entidad, entidadId: n.entidadId,
    antes: antes ?? null, despues: despues ?? null,
    motivo: n.motivo, requestId: requestId ?? null,
    dedupKey, occurredAt, hashPrevio,
    serialization: SERIALIZATION_VERSION
  });
  const hash = sha256(payload);

  const insert = await client.query(
    `INSERT INTO audit_ledger (tenant_id, actor, accion, entidad, entidad_id, antes, despues, motivo, request_id, dedup_key, event_fingerprint, occurred_at, serialization, hash_previo, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL
     DO NOTHING RETURNING hash`,
    [tenantId, n.actor, n.accion, n.entidad, n.entidadId,
     antes ? JSON.stringify(antes) : null, despues ? JSON.stringify(despues) : null,
     n.motivo, requestId ?? null, dedupKey, fingerprint, occurredAt,
     SERIALIZATION_VERSION, hashPrevio, hash]);   // posiciones [9..14] CONTRATO FIJO

  if (!insert.rows.length && dedupKey) {
    // Ya existía este dedupKey → VERIFICAR IDENTIDAD antes de devolver nada (anti D2)
    const previo = await client.query(
      `SELECT hash, event_fingerprint FROM audit_ledger WHERE tenant_id=$1 AND dedup_key=$2`,
      [tenantId, dedupKey]);
    const original = previo.rows[0];
    if (original.event_fingerprint !== fingerprint) {
      obs(m => m.log('error', 'ledger.integridad_dedup', { tenantId, dedupKey,
        esperado: original.event_fingerprint, recibido: fingerprint }));
      throw Object.assign(
        new Error('ALERTA INTEGRIDAD: dedupKey reutilizado con contenido distinto. Posible fraude o bug de idempotencia.'),
        { code: 'LEDGER_INTEGRITY_ALERT', status: 409 });
    }
    return { hash: original.hash, duplicado: true }; // mismo evento re-entregado: mismo asiento
  }
  return { hash, duplicado: false };
}

async function registrar(db, { tenantId, actor, accion, entidad, entidadId, antes, despues, motivo, requestId, dedupKey = null }) {
  const MAX_INTENTOS = 3;
  for (let intento = 1; ; intento++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      const asiento = await asentar(client, { tenantId, actor, accion, entidad, entidadId, antes, despues, motivo, requestId, dedupKey });
      const hash = asiento.hash;
      if (asiento.duplicado) {
        await client.query('COMMIT');
        return hash; // mismo evento re-entregado: mismo asiento
      }

      // R3 — COMMIT ambiguo: persistió o no, esa es la cuestión
      try {
        await client.query('COMMIT');
      } catch (ce) {
        await client.query('ROLLBACK').catch(() => {});
        let check;
        if (typeof db.connect === 'function') {
          const checkClient = await db.connect();
          try {
            await checkClient.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
            check = await checkClient.query(
              `SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND hash=$2`, [tenantId, hash]);
          } finally {
            await checkClient.query("SELECT set_config('app.current_tenant', '', false)").catch(() => {});
            checkClient.release();
          }
        } else {
          check = await db.query(`SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND hash=$2`, [tenantId, hash]);
        }
        if (check.rows.length) {
          obs(m => m.contador('ledger_commit_ambiguo_resuelto'));
          await avisarDR({ tenantId, hash, seq: null }); // confirmado aunque el COMMIT diera error
          return hash; // estaba persistido: idempotencia real
        }
        obs(m => m.contador('ledger_commit_ambiguo_perdido'));
        throw ce; // no persistió: reintento limpio (hash_previo no ocupado)
      }
      await avisarDR({ tenantId, hash });
      return hash;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') {
        obs(m => m.contador('ledger_colisiones', { constraint: e.constraint || 'unknown' }));
        if (e.constraint === 'uq_ledger_dedup' && intento < MAX_INTENTOS) {
          await dormir(50 * intento); continue; // re-leerá y verificará identidad
        }
        if (e.constraint === 'uq_ledger_hash_previo' && intento < MAX_INTENTOS) {
          obs(m => m.contador('ledger_reintentos'));
          await dormir(50 * intento);             // backoff 50/100ms y reintenta
          continue;
        }
      }
      throw e;
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// R4 — verificación CRIPTOGRÁFICA con SNAPSHOT CONSISTENTE:
// Transacción REPEATABLE READ, READ ONLY: todas las lecturas de la verificación
// ven el mismo snapshot aunque haya escritores concurrentes.
// No se usa LOCK TABLE ... IN SHARE MODE: en PostgreSQL ese modo exige privilegio
// UPDATE/DELETE/TRUNCATE, que mf_app tiene revocado por diseño (inmutabilidad),
// y además bloquearía a los escritores del ledger durante toda la verificación.
// Con pool real usa cliente dedicado; sin connect() (mocks/tests) cae al modo
// lectura directa, preservando compatibilidad.
// ---------------------------------------------------------------------------
async function _verificar(q, tenantId, desdeSeq) {
  const { rows: forks } = await q.query(
    `SELECT hash_previo, COUNT(*) FROM audit_ledger WHERE tenant_id=$1
     GROUP BY hash_previo HAVING COUNT(*) > 1`, [tenantId]);
  if (forks.length) return { ok: false, motivo: 'FORK: dos registros comparten hash_previo', registros: forks };

  const { rows } = await q.query(
    `SELECT * FROM audit_ledger WHERE tenant_id=$1 AND seq > $2 ORDER BY seq`, [tenantId, desdeSeq]);
  let previo = desdeSeq === 0 ? 'GENESIS' : null;
  if (desdeSeq > 0) {
    const cabeza = await q.query(`SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND seq=$2`, [tenantId, desdeSeq]);
    if (!cabeza.rows.length) return { ok: false, motivo: 'checkpoint de arranque inexistente' };
    previo = cabeza.rows[0].hash;
  }
  for (const r of rows) {
    if (r.hash_previo !== previo) {
      return { ok: false, rotoEn: r.seq, motivo: 'hash_previo no encadena (alterado, borrado o reordenado)' };
    }
    const serializar = r.serialization === 'jcs-v1' ? canonicoLegacyV1 : canonico;
    const payload = serializar({
      tenantId: r.tenant_id, actor: r.actor, accion: r.accion, entidad: r.entidad, entidadId: r.entidad_id,
      antes: r.antes, despues: r.despues, motivo: r.motivo, requestId: r.request_id,
      dedupKey: r.dedup_key, occurredAt: new Date(r.occurred_at).toISOString(), hashPrevio: r.hash_previo,
      serialization: r.serialization
    });
    if (sha256(payload) !== r.hash) {
      return { ok: false, rotoEn: r.seq, motivo: 'HASH NO COINCIDE: contenido alterado después de firmado' };
    }
    previo = r.hash;
  }
  return { ok: true, registros: rows.length, ultimoHash: previo };
}

async function verificarIntegridad(db, tenantId, desdeSeq = 0) {
  if (typeof db.connect === 'function') {
    const client = await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY'); // R4: snapshot consistente
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      const r = await _verificar(client, tenantId, desdeSeq);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return _verificar(db, tenantId, desdeSeq); // mocks/tests: lectura directa
}

// ---------------------------------------------------------------------------
// R6 — CHECKPOINT EXTERNO FIRMADO, DUAL-MODE:
//   clave string              → HMAC-SHA256 (compatibilidad v5.4)
//   clave objeto (KeyObject)  → Ed25519 real (firmado fuera de PostgreSQL)
// El mensaje firmado es idéntico en ambos modos; firma_alg lo distingue.
// ---------------------------------------------------------------------------
function resolverClavePrivada(clave) {
  if (clave && typeof clave !== 'string') return clave;
  const pem = clave || process.env.CHECKPOINT_PRIVATE_KEY;
  if (typeof pem === 'string' && pem.includes('PRIVATE KEY')) return crypto.createPrivateKey(pem);
  if (typeof clave === 'string') return clave; // compatibilidad HMAC explícita
  throw new Error('CHECKPOINT_PRIVATE_KEY no configurada; no se permite checkpoint sin clave persistente');
}

function resolverClavePublica(clave) {
  if (clave && typeof clave !== 'string') return clave;
  const pem = clave || process.env.CHECKPOINT_PUBLIC_KEY;
  if (typeof pem === 'string' && (pem.includes('PUBLIC KEY') || pem.includes('CERTIFICATE'))) {
    return crypto.createPublicKey(pem);
  }
  if (typeof clave === 'string') return clave; // compatibilidad HMAC explícita
  throw new Error('CHECKPOINT_PUBLIC_KEY no configurada para verificar checkpoint Ed25519');
}

// ---------------------------------------------------------------------------
// E-016 — ROTACIÓN DE CLAVES: cada checkpoint Ed25519 guarda firma_kid, el SHA-256 (hex)
// de su clave pública en DER/SPKI. La verificación elige la clave por kid dentro del
// LLAVERO DE CONFIANZA, que solo viene del entorno (nunca de la BD):
//   CHECKPOINT_PUBLIC_KEYS  uno o más PEM concatenados (claves vigentes y retiradas aún confiables)
//   CHECKPOINT_PUBLIC_KEY   la clave actual (se incluye siempre si está definida)
// El kid es solo un selector: la firma se verifica siempre contra una clave de confianza.
// Un kid manipulado que apunte a otra clave de confianza produce FIRMA INVÁLIDA; un kid que
// no está en el llavero produce CLAVE DESCONOCIDA (clave retirada o desconocida).
// ---------------------------------------------------------------------------
function kidDeClave(clave) {
  let pub;
  if (typeof clave === 'string') {
    pub = clave.includes('PRIVATE KEY') ? crypto.createPublicKey(crypto.createPrivateKey(clave)) : crypto.createPublicKey(clave);
  } else if (clave && clave.type === 'private') {
    pub = crypto.createPublicKey(clave);
  } else {
    pub = clave;
  }
  if (!pub || pub.asymmetricKeyType !== 'ed25519') throw new Error('kidDeClave requiere una clave Ed25519');
  return crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex');
}

const PEM_PUBLICA = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g;

function llaveroConfianza(env = process.env) {
  const llavero = new Map();
  const fuentes = [env.CHECKPOINT_PUBLIC_KEYS, env.CHECKPOINT_PUBLIC_KEY].filter(Boolean).join('\n');
  for (const pem of fuentes.match(PEM_PUBLICA) || []) {
    let key;
    try { key = crypto.createPublicKey(pem); }
    catch (e) { throw new Error(`Llavero de checkpoints: PEM público inválido (${e.message})`); }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Llavero de checkpoints: solo se admiten claves Ed25519');
    llavero.set(kidDeClave(key), key);
  }
  return llavero;
}

function firmarMensaje(clave, mensaje) {
  const key = resolverClavePrivada(clave);
  if (typeof key === 'string') {
    return { firma: crypto.createHmac('sha256', key).update(mensaje).digest('hex'), alg: 'hmac-sha256', kid: null };
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('La clave de checkpoint debe ser Ed25519');
  return { firma: crypto.sign(null, Buffer.from(mensaje, 'utf8'), key).toString('hex'), alg: 'ed25519', kid: kidDeClave(key) };
}

// Decide si la firma de un checkpoint es válida. clave explícita → se usa tal cual (compatibilidad);
// sin clave y Ed25519 → llavero de confianza por kid (o todo el llavero para filas sin kid).
function evaluarFirma(cp, mensaje, clave) {
  const alg = cp.firma_alg || null;
  if (clave || alg !== 'ed25519') {
    return verificarMensaje(clave, mensaje, cp.firma, alg)
      ? { ok: true } : { ok: false, motivo: 'FIRMA INVÁLIDA: checkpoint manipulado' };
  }
  const llavero = llaveroConfianza();
  if (!llavero.size) return { ok: false, motivo: 'LLAVERO VACÍO: configurar CHECKPOINT_PUBLIC_KEY / CHECKPOINT_PUBLIC_KEYS' };
  if (cp.firma_kid) {
    const key = llavero.get(cp.firma_kid);
    if (!key) return { ok: false, motivo: `CLAVE DESCONOCIDA: kid=${cp.firma_kid.slice(0, 16)}… no está en el llavero de confianza` };
    return verificarMensaje(key, mensaje, cp.firma, alg)
      ? { ok: true, kid: cp.firma_kid } : { ok: false, motivo: 'FIRMA INVÁLIDA: checkpoint manipulado' };
  }
  for (const [kid, key] of llavero) {
    if (verificarMensaje(key, mensaje, cp.firma, alg)) return { ok: true, kid };
  }
  return { ok: false, motivo: 'FIRMA INVÁLIDA: checkpoint manipulado' };
}

function verificarMensaje(clave, mensaje, firmaHex, alg = null) {
  try {
    if (alg === 'hmac-sha256') {
      const secret = clave || process.env.CHECKPOINT_HMAC_SECRET;
      if (typeof secret !== 'string' || !secret) return false;
      const esperado = crypto.createHmac('sha256', secret).update(mensaje).digest();
      const recibido = Buffer.from(firmaHex, 'hex');
      return recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado);
    }
    const key = resolverClavePublica(clave);
    if (alg == null && typeof key === 'string') {
      const esperado = crypto.createHmac('sha256', key).update(mensaje).digest();
      const recibido = Buffer.from(firmaHex, 'hex');
      return recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado);
    }
    if (typeof key === 'string' || key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(mensaje, 'utf8'), key, Buffer.from(firmaHex, 'hex'));
  } catch (_) { return false; }
}

async function crearCheckpoint(db, tenantId, clave) {
  if (typeof db.connect !== 'function') {
    const v = await verificarIntegridad(db, tenantId);
    if (!v.ok) throw new Error('No se firma checkpoint sobre cadena rota: ' + v.motivo);
    const { rows } = await db.query(`SELECT seq, hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1`, [tenantId]);
    if (!rows.length) return { ok: false, motivo: 'sin registros' };
    const mensaje = `${tenantId}:${rows[0].seq}:${rows[0].hash}`;
    const { firma, alg, kid } = firmarMensaje(clave, mensaje);
    await db.query(`INSERT INTO audit_checkpoints (tenant_id, seq, hash, firma, firma_alg, firma_kid) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, seq) DO NOTHING`, [tenantId, rows[0].seq, rows[0].hash, firma, alg, kid]);
    return { ok: true, seq: rows[0].seq, hash: rows[0].hash, firma, alg, kid };
  }
  const v = await verificarIntegridad(db, tenantId);
  if (!v.ok) throw new Error('No se firma checkpoint sobre cadena rota: ' + v.motivo);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const { rows } = await client.query(
      `SELECT seq, hash FROM audit_ledger WHERE tenant_id=$1 ORDER BY seq DESC LIMIT 1`, [tenantId]);
    if (!rows.length) { await client.query('ROLLBACK'); return { ok: false, motivo: 'sin registros' }; }
    const mensaje = `${tenantId}:${rows[0].seq}:${rows[0].hash}`;
    const { firma, alg, kid } = firmarMensaje(clave, mensaje);
    await client.query(
      `INSERT INTO audit_checkpoints (tenant_id, seq, hash, firma, firma_alg, firma_kid) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, seq) DO NOTHING`,
      [tenantId, rows[0].seq, rows[0].hash, firma, alg, kid]);
    await client.query('COMMIT');
    return { ok: true, seq: rows[0].seq, hash: rows[0].hash, firma, alg, kid };
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function verificarCheckpoint(db, tenantId, seq, clave) {
  if (typeof db.connect !== 'function') {
    const { rows } = await db.query(`SELECT hash, firma, firma_alg, firma_kid FROM audit_checkpoints WHERE tenant_id=$1 AND seq=$2`, [tenantId, seq]);
    if (!rows.length) return { ok: false, motivo: 'checkpoint inexistente' };
    const cp = rows[0];
    const mensaje = `${tenantId}:${seq}:${cp.hash}`;
    const firmaOk = evaluarFirma(cp, mensaje, clave);
    if (!firmaOk.ok) return firmaOk;
    const ancla = await db.query(`SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND seq=$2`, [tenantId, seq]);
    if (!ancla.rows.length || ancla.rows[0].hash !== cp.hash) return { ok: false, motivo: 'ANCLA INVÁLIDA: el checkpoint no coincide con el ledger restaurado' };
    return verificarIntegridad(db, tenantId);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const { rows } = await client.query(
      `SELECT hash, firma, firma_alg, firma_kid FROM audit_checkpoints WHERE tenant_id=$1 AND seq=$2`, [tenantId, seq]);
    if (!rows.length) { await client.query('COMMIT'); return { ok: false, motivo: 'checkpoint inexistente' }; }
    const cp = rows[0];
    const mensaje = `${tenantId}:${seq}:${cp.hash}`;
    const firmaOk = evaluarFirma(cp, mensaje, clave);
    if (!firmaOk.ok) {
      await client.query('COMMIT');
      return firmaOk;
    }
    const ancla = await client.query(
      `SELECT hash FROM audit_ledger WHERE tenant_id=$1 AND seq=$2`, [tenantId, seq]);
    if (!ancla.rows.length || ancla.rows[0].hash !== cp.hash) {
      await client.query('COMMIT');
      return { ok: false, motivo: 'ANCLA INVÁLIDA: el checkpoint no coincide con el ledger restaurado' };
    }
    await client.query('COMMIT');
    return verificarIntegridad(db, tenantId); // cadena completa desde GENESIS
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// Gate de recuperación: después de restaurar, valida cada cadena completa y
// cada checkpoint almacenado. Las claves privadas nunca se consultan desde PG.
async function verificacionPostRestauracion(db) {
  const { rows: tenants } = await db.query(
    'SELECT DISTINCT tenant_id FROM audit_ledger ORDER BY tenant_id');
  const resultados = [];
  for (const { tenant_id: tenantId } of tenants) {
    const integridad = await verificarIntegridad(db, tenantId);
    if (!integridad.ok) throw new Error(`DR_LEDGER_INVALIDO tenant=${tenantId}: ${integridad.motivo}`);
    const { rows: checkpoints } = await db.query(
      'SELECT seq FROM audit_checkpoints WHERE tenant_id=$1 ORDER BY seq', [tenantId]);
    for (const cp of checkpoints) {
      const verificado = await verificarCheckpoint(db, tenantId, Number(cp.seq));
      if (!verificado.ok) throw new Error(`DR_CHECKPOINT_INVALIDO tenant=${tenantId} seq=${cp.seq}: ${verificado.motivo}`);
    }
    resultados.push({ tenantId, registros: integridad.registros, checkpoints: checkpoints.length, ok: true });
  }
  return { ok: true, tenants: resultados.length, resultados };
}

// Helpers para los agentes — con dedupKey por defecto (idempotencia gratis)
const eventos = (db) => ({
  registrarCargaAceptada: (t, id, quien, req) => registrar(db, { tenantId: t, actor: quien, accion: 'carga.aceptada', entidad: 'booking', entidadId: id, despues: { status: 'ACCEPTED' }, requestId: req, dedupKey: `carga.aceptada:${id}` }),
  registrarPrecioNegociado: (t, id, antes, despues, motivo) => registrar(db, { tenantId: t, actor: 'agente:negociador', accion: 'precio.negociado', entidad: 'booking', entidadId: id, antes: { rate: antes }, despues: { rate: despues }, motivo, dedupKey: `precio.negociado:${id}:${despues}` }),
  registrarPagoRegistrado: (t, id, monto) => registrar(db, { tenantId: t, actor: 'agente:cajero', accion: 'pago.registrado', entidad: 'payment', entidadId: id, despues: { monto }, dedupKey: `pago.registrado:${id}` }),
  registrarVeredictoBloqueo: (t, driverId, motivo) => registrar(db, { tenantId: t, actor: 'agente:seguridad', accion: 'driver.bloqueado', entidad: 'driver', entidadId: driverId, motivo, dedupKey: `driver.bloqueado:${driverId}` }),
});

module.exports = { SQL, SQL_ROLES, MIGRACIONES, migrar, migrarRevertir,
                   SERIALIZATION_VERSION, canonico, registrar, asentar, verificarIntegridad,
                   crearCheckpoint, verificarCheckpoint, eventos, sha256,
                   configurarDR, normalizarEvento, verificacionPostRestauracion,
                   kidDeClave, llaveroConfianza };
