// ============================================================================
// 33_verificacion_carrier.js — VERIFICACIÓN COMPLETA DEL CAMIONERO
// Versión 5.1
//
// REGLA DEL SISTEMA: ningún camionero acepta cargas sin pasar las 4 capas.
// Las capas 1 y 3 son automáticas (agentes). La capa 2 la hace el agente de
// voz una sola vez. La capa 4 la sube el propio chofer desde la app.
//
//   CAPA 1 — Registro federal FMCSA (gratis, automático, antes de cada carga)
//   CAPA 2 — Llamada a la aseguradora para confirmar la póliza (una vez)
//   CAPA 3 — Monitoreo continuo: seguros y autoridad se re-chequean cada 7 días
//            y ANTES de cada carga asignada
//   CAPA 4 — Evidencia física desde la app: foto CDL, foto camión, foto póliza
// ============================================================================

// ---------------------------------------------------------------------------
// Base de datos (ejecutar en Postgres junto al archivo 01)
// ---------------------------------------------------------------------------
// Caché local simple (en producción: Redis con 24h de TTL)
const cacheLocal = {
  datos: {},
  async set(k, v) { this.datos[k] = v; },
  async get(k) { return this.datos[k] || null; }
};

const SQL = require('./db/sql').leerSql('33_verificacion_carrier'); // DDL versionado en sql/33_verificacion_carrier.sql (E-017)

// ---------------------------------------------------------------------------
// CAPA 1 — Consulta FMCSA (registro federal público)
// En producción: API de fmcsa.dot.gov / SAFER. Aquí la función con su contrato.
// ---------------------------------------------------------------------------
async function capa1_fmcsa(db, tenantId, driverId, { mcNumero, dotNumero }) {
  // consultarFMCSA devuelve: { autoridadActiva, segurosVigentes, tipoAutoridad }
  const datos = await consultarFMCSA({ mcNumero, dotNumero });

  const activo = datos.autoridadActiva === true;
  const seguroOk = datos.segurosVigentes === true;

  await db.query(
    `INSERT INTO verificaciones_carrier (tenant_id, driver_id, mc_numero, dot_numero,
        fmcsa_autoridad_activa, fmcsa_seguro_vigente, fmcsa_verificado_en)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (tenant_id, driver_id) DO UPDATE SET
        fmcsa_autoridad_activa=$5, fmcsa_seguro_vigente=$6, fmcsa_verificado_en=now()`,
    [tenantId, driverId, mcNumero, dotNumero, activo, seguroOk]
  );

  if (!activo) return { ok: false, capa: 1, motivo: 'Autoridad MC/DOT inactiva o suspendida en FMCSA' };
  if (!seguroOk) return { ok: false, capa: 1, motivo: 'Seguros no figuran vigentes en el registro federal' };
  return { ok: true };
}

async function consultarFMCSA({ mcNumero, dotNumero }) {
  // Regla services/: la llamada externa vive en el adaptador; aquí solo
  // orquestación + caché de respaldo si la red falla (nunca tumba el servicio).
  const cacheKey = `fmcsa:${mcNumero || dotNumero}`;
  try {
    const resultado = await require('./server/services/fmcsa_client').consultarCarrier({ mcNumero, dotNumero });
    await cacheLocal.set(cacheKey, resultado);
    return resultado;
  } catch (e) {
    const cacheado = await cacheLocal.get(cacheKey);
    if (cacheado) return { ...cacheado, desdeCache: true };
    throw new Error('FMCSA no responde y no hay caché: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// CAPA 2 — El agente de voz confirma la póliza con la aseguradora
// Se dispara una sola vez por camionero nuevo. Si la póliza es falsa o
// cancelada, el veredicto final bloquea al camionero.
// ---------------------------------------------------------------------------
async function capa2_confirmarPoliza(db, tenantId, driverId, { aseguradora, polizaAuto, polizaCargo }, agenteVoz) {
  const confirmacion = await agenteVoz.confirmarSeguro({
    aseguradora, polizaAuto, polizaCargo,
    holder: 'TOUR 567 LLC'   // quedas registrado como tenedor del certificado
  });

  await db.query(
    `UPDATE verificaciones_carrier SET aseguradora=$3, poliza_auto_liability=$4, poliza_cargo=$5,
        poliza_verificada=$6, poliza_verificada_en=now(), poliza_verificada_por='agente_voz'
     WHERE tenant_id=$1 AND driver_id=$2`,
    [tenantId, driverId, aseguradora, polizaAuto, polizaCargo, confirmacion.vigente]
  );

  if (!confirmacion.vigente) {
    return { ok: false, capa: 2, motivo: `Aseguradora ${aseguradora} no confirma la póliza ${polizaAuto}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CAPA 3 — Re-chequeo automático cada 7 días y ANTES de cada carga
// Lo corre el cron (archivo 04). Si algo venció, el camionero queda en pausa
// y no puede aceptar cargas hasta regularizar.
// ---------------------------------------------------------------------------
async function capa3_monitoreoContinuo(db, tenantId, driverId) {
  const { rows } = await db.query(
    `SELECT mc_numero, dot_numero FROM verificaciones_carrier
     WHERE tenant_id=$1 AND driver_id=$2`, [tenantId, driverId]);
  if (!rows[0]) return { ok: false, motivo: 'Sin registro de verificación' };

  // Re-correr capa 1 (la autoridad y los seguros se pueden vencer/vencer)
  return capa1_fmcsa(db, tenantId, driverId, rows[0]);
}

// ---------------------------------------------------------------------------
// CAPA 4 — Evidencia física subida desde la app del chofer
// Foto CDL + foto camión con placa + foto póliza física.
// El agente cruza el nombre del CDL con el titular del MC: si no coinciden,
// la aprobación pasa a un humano (regla de oro: when in doubt, ask).
// ---------------------------------------------------------------------------
async function capa4_evidenciaFisica(db, tenantId, driverId, { fotoCdlUrl, fotoCamionUrl, fotoPolizaUrl, cdlNombre, titularMC }) {
  const coincide = normalizar(cdlNombre) === normalizar(titularMC);

  await db.query(
    `UPDATE verificaciones_carrier SET foto_cdl_url=$3, foto_camion_url=$4, foto_poliza_url=$5,
        cdl_nombre=$6, cdl_coincide_mc=$7
     WHERE tenant_id=$1 AND driver_id=$2`,
    [tenantId, driverId, fotoCdlUrl, fotoCamionUrl, fotoPolizaUrl, cdlNombre, coincide]
  );

  return { ok: true, requiereHumano: !coincide,
           motivo: coincide ? null : 'Nombre del CDL no coincide con el titular del MC — aprobar manualmente' };
}

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// ---------------------------------------------------------------------------
// VEREDICTO FINAL — lo llama el agente despachador antes de asignar CUALQUIER
// carga. Si no está VERIFICADO, la carga no se suelta, sin excepciones.
// ---------------------------------------------------------------------------
async function veredictoVerificacion(db, tenantId, driverId) {
  const { rows } = await db.query(
    `SELECT v.*, d.full_name FROM verificaciones_carrier v
     JOIN drivers d ON d.id = v.driver_id
     WHERE v.tenant_id=$1 AND v.driver_id=$2`, [tenantId, driverId]);

  const v = rows[0];
  if (!v) return { estado: 'BLOQUEADO', motivo: 'Camionero sin verificación registrada' };

  const fallas = [];
  if (!v.fmcsa_autoridad_activa) fallas.push('autoridad FMCSA inactiva');
  if (!v.fmcsa_seguro_vigente) fallas.push('seguros no vigentes');
  if (!v.poliza_verificada) fallas.push('póliza no confirmada con aseguradora');
  if (!v.evidencia_completa) fallas.push('falta evidencia física (CDL/camión/póliza)');

  if (v.estado === 'BLOQUEADO') {
    return { estado: 'BLOQUEADO', motivo: v.motivo_bloqueo || 'Bloqueado manualmente' };
  }
  if (fallas.length > 0) {
    return { estado: 'PENDIENTE', motivo: 'Faltan: ' + fallas.join(', ') };
  }
  if (v.cdl_coincide_mc === false) {
    return { estado: 'PENDIENTE', motivo: 'CDL no coincide con titular del MC — esperando aprobación humana', requiereHumano: true };
  }
  return { estado: 'VERIFICADO' };
}

module.exports = { SQL, capa1_fmcsa, capa2_confirmarPoliza, capa3_monitoreoContinuo,
                   capa4_evidenciaFisica, veredictoVerificacion, normalizar };
