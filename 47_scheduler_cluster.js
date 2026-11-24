// ============================================================================
// 47_scheduler_cluster.js — CLUSTER DE SCHEDULERS (varios servidores, un jefe)
// Versión 5.4
//
// CUANDO HAY 2+ RÉPLICAS DEL SERVER: si cada una corre su cron y sus agentes,
// las tareas se ejecutan DUPLICADAS (doble cobro, doble reporte) y los matches
// se pelean entre sí. La solución, sin Redis ni Zookeeper:
//
//   ELECCIÓN DE LÍDER por candado consultivo de Postgres: solo el nodo que
//   mantiene el candado ejecuta los schedulers (cronWorker, eventWorker,
//   match en tiempo real). Si el líder muere, el candado expira a los 15s
//   y otro nodo toma el mando. Cero configuración extra.
//
//   HEARTBEATS: cada nodo escribe "estoy vivo" cada 10s → el panel muestra
//   cuántos servidores corren y quién es el líder.
// ============================================================================

const SQL = require('./db/sql').leerSql('47_scheduler_cluster'); // DDL versionado en sql/47_scheduler_cluster.sql (E-017)

const TTL_LIDER_SEG = 15;   // si el líder no renueva, otro puede tomar el mando
const HEARTBEAT_SEG = 10;

let soyLider = false;

async function registrarNodo(db, nodoId) {
  await db.query(
    `INSERT INTO cluster_nodos (id) VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET ultimo_heartbeat=now()`, [nodoId]);
}

// Renueva mi heartbeat y reporta si soy líder
async function latido(db, nodoId) {
  await registrarNodo(db, nodoId);
  const { rows } = await db.query(`SELECT lider FROM cluster_nodos WHERE id=$1`, [nodoId]);
  return rows[0]?.lider === true;
}

// ---------------------------------------------------------------------------
// CAMPAÑA DE LIDERAZGO: se corre cada 5 segundos. Devuelve true si SOY líder.
// Reglas:
//   - Si ya hay líder vivo (heartbeat < TTL), no se disputa.
//   - Si no hay líder o está muerto, me declaro líder dentro de la misma transacción.
//   - Las campañas se serializan con pg_advisory_xact_lock: el candado vive solo
//     durante la transacción y se libera siempre en COMMIT/ROLLBACK.
//
// No se usa pg_advisory_lock (de sesión): con un Pool la conexión vuelve al pool
// sin cerrarse, el candado queda retenido por una sesión inactiva y los demás
// nodos esperan indefinidamente, agotando su pool (ver docs/ERRORES.md E-018).
// ---------------------------------------------------------------------------
const CANDADO_CLUSTER = 727272;

async function campañaLiderazgo(db, nodoId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_CLUSTER]);

    const { rows: lideres } = await client.query(
      `SELECT id FROM cluster_nodos
       WHERE lider=TRUE AND ultimo_heartbeat > now() - make_interval(secs => $1)
       ORDER BY ultimo_heartbeat DESC LIMIT 1`, [TTL_LIDER_SEG]);
    const liderVivo = lideres[0]?.id || null;

    if (liderVivo && liderVivo !== nodoId) {
      await client.query('COMMIT');
      soyLider = false;
      return false;
    }

    await client.query(`UPDATE cluster_nodos SET lider=FALSE WHERE lider=TRUE AND id<>$1`, [nodoId]);
    const yo = await client.query(
      `UPDATE cluster_nodos SET lider=TRUE, ultimo_heartbeat=now() WHERE id=$1 RETURNING id`, [nodoId]);
    if (!yo.rows.length) {
      // Nodo no registrado: no puede declararse líder (evita "líder fantasma" sin fila).
      await client.query('ROLLBACK');
      soyLider = false;
      return false;
    }
    await client.query('COMMIT');
    soyLider = true;
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    soyLider = false;
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// ENVOLVENTE: correr una función SOLO en el líder. Uso:
//   soloLider(db, nodoId, 'cron', () => cronWorker.iniciar(db))
// ---------------------------------------------------------------------------
async function soloLider(db, nodoId, nombreTarea, fn) {
  if (!(await campañaLiderazgo(db, nodoId))) return false;
  await fn();
  return true;
}

// Arranque típico en cada réplica (server/index.js llama esto):
//   iniciarCluster(db, () => { /* iniciar cron, eventWorker, match */ })
function iniciarCluster(db, nodoId, alSerLider) {
  const ciclo = async () => {
    try {
      const lider = await campañaLiderazgo(db, nodoId);
      await db.query(`UPDATE cluster_nodos SET ultimo_heartbeat=now() WHERE id=$1`, [nodoId]);
      if (lider && !iniciado) { iniciado = true; await alSerLider(); }
      if (!lider && iniciado) { iniciado = false; /* matar workers locales */ }
    } catch (e) { soyLider = false; }
  };
  let iniciado = false;
  // Registrar el nodo ANTES de la primera campaña: un nodo sin fila no puede declararse líder (E-018).
  registrarNodo(db, nodoId).catch(() => {}).then(ciclo);
  const t1 = setInterval(ciclo, 5000);
  const t2 = setInterval(() => latido(db, nodoId).catch(() => {}), HEARTBEAT_SEG * 1000);
  return () => { clearInterval(t1); clearInterval(t2); soyLider = false; };
}

// ¿Este proceso es el líder ahora mismo? (lo consultan los workers que deben correr en un solo nodo)
const esLider = () => soyLider;

// Estado del cluster para el panel de métricas (archivo 43)
async function estadoCluster(db) {
  const { rows } = await db.query(
    `SELECT id, lider, ultimo_heartbeat, EXTRACT(EPOCH FROM now()-ultimo_heartbeat)::int AS segundos_sin_vida
     FROM cluster_nodos ORDER BY lider DESC, ultimo_heartbeat DESC`);
  return { nodos: rows, total: rows.length, lider: rows.find(r => r.lider)?.id || null };
}

module.exports = { SQL, campañaLiderazgo, soloLider, iniciarCluster, estadoCluster, esLider, TTL_LIDER_SEG };
