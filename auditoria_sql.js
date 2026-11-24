'use strict';
// Auditoría de conformidad SQL ↔ esquema real (E-029).
// Extrae cada SQL literal pasado a .query() en el código de la aplicación y pide a PostgreSQL que lo
// analice con PREPARE (parseo + resolución de tablas, columnas, funciones y tipos), SIN ejecutarlo.
// Detecta código escrito contra un esquema inexistente: columnas o tablas que no existen,
// funciones desconocidas, tipos incompatibles.
//
// Uso:  PG_ADMIN_URL=... node tests/integration/auditoria_sql.js [--json salida.json] [--solo a.js,b.js]
// Salida: tabla de hallazgos; exit 0 si todo error de esquema está en auditoria_sql_excepciones.json y
// ninguna excepción está obsoleta; 1 en otro caso; 2 si falta configuración.
// La BD debe tener el esquema completo aplicado (db/esquema.js). Se usa la identidad administrativa:
// PREPARE no lee datos y el análisis no depende de RLS.
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { aplicarEsquema } = require('../../db/esquema');

const RAIZ = path.resolve(__dirname, '../..');
const EXCLUIR_DIRS = new Set(['node_modules', '.git', 'tests', 'tools', 'driver_app', 'informes', 'docs']);
// Pruebas que fabrican SQL de mocks a propósito.
const EXCLUIR_ARCHIVOS = new Set(['26_pruebas_estres_70.js', '39_pruebas_sistema_completo.js']);
// Códigos SQLSTATE que significan "el código no corresponde al esquema".
const ERRORES_ESQUEMA = new Set(['42703', '42P01', '42883', '42804', '42P10', '42702', '42725', '42846', '42601', '42P02', '42704']);

function archivosJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUIR_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...archivosJs(p));
    else if (e.name.endsWith('.js') && !EXCLUIR_ARCHIVOS.has(e.name)) out.push(p);
  }
  return out;
}

// Literal SQL inmediatamente pasado a .query( … ). Soporta `…`, '…' y "…".
const PATRON = /\.query\(\s*(`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g;

function extraer(archivo) {
  const texto = fs.readFileSync(archivo, 'utf8');
  const hallados = [];
  let m;
  while ((m = PATRON.exec(texto))) {
    const literal = m[1];
    const linea = texto.slice(0, m.index).split('\n').length;
    const cuerpo = literal.slice(1, -1);
    if (literal[0] === '`' && cuerpo.includes('${')) {
      hallados.push({ linea, sql: cuerpo, dinamica: true });
      continue;
    }
    hallados.push({ linea, sql: cuerpo.replace(/\\`/g, '`').replace(/\\'/g, "'").replace(/\\"/g, '"'), dinamica: false });
  }
  return hallados;
}

const DML = /^\s*(WITH|SELECT|INSERT|UPDATE|DELETE|VALUES|MERGE)\b/i;

(async () => {
  const url = process.env.PG_ADMIN_URL;
  if (!url) { console.error('Falta PG_ADMIN_URL'); process.exit(2); }
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  const solo = args.includes('--solo') ? new Set(args[args.indexOf('--solo') + 1].split(',')) : null;
  const db = new Pool({ connectionString: url, max: 1 });
  const hallazgos = [];
  let auditadas = 0, dinamicas = 0, utilitarias = 0, indeterminadas = 0;
  try {
    await aplicarEsquema(db);
    const c = await db.connect();
    try {
      for (const archivo of archivosJs(RAIZ).sort()) {
        const rel = path.relative(RAIZ, archivo);
        if (solo && !solo.has(rel)) continue;
        for (const { linea, sql, dinamica } of extraer(archivo)) {
          if (dinamica) { dinamicas++; hallazgos.push({ archivo: rel, linea, tipo: 'DINAMICA', codigo: '-', mensaje: 'SQL con interpolación ${…}: no auditable estáticamente' }); continue; }
          if (!DML.test(sql)) { utilitarias++; continue; }
          auditadas++;
          await c.query('BEGIN');
          try {
            await c.query(`PREPARE auditoria_sql AS ${sql}`);
          } catch (e) {
            if (e.code === '42P18') { indeterminadas++; hallazgos.push({ archivo: rel, linea, tipo: 'INDETERMINADA', codigo: e.code, mensaje: e.message }); }
            else hallazgos.push({ archivo: rel, linea, tipo: ERRORES_ESQUEMA.has(e.code) ? 'ESQUEMA' : 'OTRO', codigo: e.code, mensaje: e.message });
          } finally {
            await c.query('ROLLBACK');
            // Las sentencias preparadas son de sesión: ROLLBACK no las elimina.
            await c.query('DEALLOCATE ALL');
          }
        }
      }
    } finally { c.release(); }
  } finally { await db.end(); }

  // Excepciones documentadas (cada una con su defecto en docs/ERRORES.md).
  const rutaExc = path.join(__dirname, 'auditoria_sql_excepciones.json');
  const excepciones = fs.existsSync(rutaExc) ? JSON.parse(fs.readFileSync(rutaExc, 'utf8')).excepciones : [];
  const usadas = new Set();
  for (const h of hallazgos) {
    if (h.tipo !== 'ESQUEMA' && h.tipo !== 'OTRO') continue;
    const i = excepciones.findIndex(x => x.archivo === h.archivo && x.codigo === h.codigo && h.mensaje.includes(x.contiene));
    if (i >= 0) { usadas.add(i); h.tipo = 'EXCEPCION'; h.defecto = excepciones[i].defecto; }
  }
  const obsoletas = solo ? [] : excepciones.filter((_, i) => !usadas.has(i));
  for (const x of obsoletas) console.log(`EXCEPCION_OBSOLETA ${x.archivo} ${x.codigo} "${x.contiene}" (${x.defecto}): ya no hay hallazgo; retirarla`);
  const errores = hallazgos.filter(h => h.tipo === 'ESQUEMA' || h.tipo === 'OTRO');
  console.log(`Sentencias DML auditadas: ${auditadas}; utilitarias omitidas: ${utilitarias}; dinámicas: ${dinamicas}; tipos indeterminados: ${indeterminadas}`);
  for (const h of hallazgos.filter(x => x.tipo !== 'DINAMICA')) {
    console.log(`${h.tipo.padEnd(13)} ${h.codigo.padEnd(6)} ${h.archivo}:${h.linea}  ${h.mensaje}${h.defecto ? `  [${h.defecto}]` : ''}`);
  }
  const excepcionados = hallazgos.filter(h => h.tipo === 'EXCEPCION').length;
  console.log(`\nERRORES DE ESQUEMA: ${errores.length} en ${new Set(errores.map(e => e.archivo)).size} archivos; excepciones documentadas: ${excepcionados}; excepciones obsoletas: ${obsoletas.length}`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ auditadas, utilitarias, dinamicas, indeterminadas, hallazgos, obsoletas }, null, 2));
  process.exitCode = errores.length || obsoletas.length ? 1 : 0;
})().catch(e => { console.error('AUDITORÍA ABORTADA:', e.stack || e); process.exitCode = 2; });
