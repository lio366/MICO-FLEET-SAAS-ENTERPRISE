'use strict';
// Runner de migraciones versionadas: migrations/NNN_nombre.up.sql + NNN_nombre.down.sql.
// Registro en schema_migrations (id, nombre, aplicada_en), compartido con el ledger.
//
// Garantías:
//   - Cada migración corre en su propia transacción sobre UNA conexión dedicada.
//   - Arranques concurrentes (varias réplicas) se serializan con pg_advisory_xact_lock
//     y cada migración se vuelve a comprobar dentro del candado: nunca se aplica dos veces.
//   - Revertir solo se permite sobre la última migración aplicada (orden inverso).
//   - Toda migración debe tener up y down; ids únicos y positivos.
// Sin dependencias de runtime (E-017).
const fs = require('node:fs');
const path = require('node:path');

const DIR_MIGRACIONES = path.resolve(__dirname, '..', 'migrations');
const PATRON = /^(\d{3})_([0-9A-Za-z_]+)\.(up|down)\.sql$/;
// Espacio de candado de dos claves (int4, int4): no colisiona con los candados de una clave bigint.
const CANDADO_MIGRACIONES = [1835627, 1];

function cargarMigraciones(dir = DIR_MIGRACIONES) {
  const porId = new Map();
  for (const archivo of fs.readdirSync(dir).sort()) {
    const m = PATRON.exec(archivo);
    if (!m) continue;
    const id = Number(m[1]);
    if (id <= 0) throw new Error(`Migración con id inválido: ${archivo}`);
    const actual = porId.get(id) || { id, nombre: m[2] };
    if (actual.nombre !== m[2]) throw new Error(`Id ${id} usado por dos nombres: ${actual.nombre} y ${m[2]}`);
    if (actual[m[3]]) throw new Error(`Archivo ${m[3]} duplicado para la migración ${id}`);
    const texto = fs.readFileSync(path.join(dir, archivo), 'utf8');
    if (!texto.trim()) throw new Error(`Migración vacía: ${archivo}`);
    actual[m[3]] = texto;
    porId.set(id, actual);
  }
  const lista = [...porId.values()].sort((a, b) => a.id - b.id);
  for (const mig of lista) {
    if (!mig.up || !mig.down) throw new Error(`La migración ${mig.id}_${mig.nombre} debe tener .up.sql y .down.sql`);
  }
  return lista;
}

const SQL_TABLA = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT PRIMARY KEY, nombre VARCHAR(120) NOT NULL, aplicada_en TIMESTAMPTZ DEFAULT now())`;

// Acepta un Pool (obtiene una conexión dedicada y la devuelve) o un cliente ya
// obtenido de un pool (tiene release(): se usa tal cual, sin reconectar).
const esPool = (db) => typeof db.connect === 'function' && typeof db.release !== 'function';

async function conCliente(db, fn) {
  const client = esPool(db) ? await db.connect() : db;
  try { return await fn(client); }
  finally { if (client !== db) client.release(); }
}

async function transaccionConCandado(client, fn) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', CANDADO_MIGRACIONES);
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function migrar(db, migraciones = cargarMigraciones()) {
  return conCliente(db, async (client) => {
    await transaccionConCandado(client, () => client.query(SQL_TABLA));
    const aplicadas = [];
    for (const m of migraciones) {
      const hecha = await transaccionConCandado(client, async () => {
        const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id=$1', [m.id]);
        if (rows.length) return true;
        await client.query(m.up);
        await client.query('INSERT INTO schema_migrations (id, nombre) VALUES ($1,$2)', [m.id, m.nombre]);
        return false;
      });
      if (!hecha) aplicadas.push(m.id);
    }
    return { ok: true, aplicadas };
  });
}

async function revertir(db, id, migraciones = cargarMigraciones()) {
  const m = migraciones.find(x => x.id === id);
  if (!m) return { ok: false, motivo: 'migración inexistente: ' + id };
  return conCliente(db, (client) => transaccionConCandado(client, async () => {
    const { rows } = await client.query('SELECT id FROM schema_migrations ORDER BY id DESC');
    const ids = rows.map(r => Number(r.id));
    if (!ids.includes(id)) return { ok: false, motivo: `la migración ${id} no está aplicada` };
    if (ids[0] !== id) return { ok: false, motivo: `revertir en orden inverso: antes revertir ${ids[0]}` };
    await client.query(m.down);
    await client.query('DELETE FROM schema_migrations WHERE id=$1', [id]);
    return { ok: true, revertida: id };
  }));
}

async function estado(db, migraciones = cargarMigraciones()) {
  const { rows } = await db.query(
    "SELECT id FROM schema_migrations WHERE to_regclass('public.schema_migrations') IS NOT NULL ORDER BY id")
    .catch(e => (e.code === '42P01' ? { rows: [] } : Promise.reject(e)));
  const hechas = new Set(rows.map(r => Number(r.id)));
  return migraciones.map(m => ({ id: m.id, nombre: m.nombre, aplicada: hechas.has(m.id) }));
}

module.exports = { cargarMigraciones, migrar, revertir, estado, conCliente, transaccionConCandado, DIR_MIGRACIONES };
