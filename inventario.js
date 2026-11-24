#!/usr/bin/env node
'use strict';
// Inventario verificable del repositorio (auditoría de correspondencia).
// Para cada archivo versionado (git ls-files, excluida la evidencia histórica de informes/):
//   ruta, tipo, líneas, SHA-256, número lógico del índice de 00_README_MASTER.md.
// Para cada módulo JavaScript, por análisis estático + carga aislada:
//   - dependencias internas (require relativos) y externas (paquetes npm), y si las externas
//     están declaradas en package.json;
//   - exportaciones reales (se carga el módulo con los paquetes externos sustituidos por stubs);
//   - CONTRATOS: cada `alias.miembro` usado sobre un módulo interno se contrasta con sus exportaciones;
//   - alcance desde el runtime (server/index.js) y desde el bootstrap (scripts/migrate.js);
//   - cobertura: suites unitarias (26, 39) e integración PostgreSQL (tests/integration/postgres_*.js)
//     que lo cargan, y suites que solo lo comprueban por texto.
// Uso:  node tools/inventario.js [--json salida.json] [--md salida.md]
// Salida: exit 0; exit 1 si hay contratos rotos o dependencias externas no declaradas.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const salidaJson = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const salidaMd = args.includes('--md') ? args[args.indexOf('--md') + 1] : null;

const commit = execFileSync('git', ['-C', RAIZ, 'rev-parse', '--short', 'HEAD']).toString().trim();
const archivos = execFileSync('git', ['-C', RAIZ, 'ls-files', '-z']).toString().split('\0').filter(Boolean)
  .filter(f => !/^informes\/evidencia_/.test(f) && !/^informes\/.*\.log$/.test(f) && f !== 'docs/INVENTARIO.md');

const TIPOS = { '.js': 'código JS', '.sql': 'SQL', '.md': 'documento', '.json': 'datos/config', '.html': 'HTML',
  '.sh': 'script shell', '.py': 'script Python', '.yml': 'config', '.yaml': 'config', '.env': 'config', '.example': 'config' };
const tipoDe = (f) => TIPOS[path.extname(f)] || (path.basename(f).startsWith('.') ? 'config' : 'otro');

// ── Índice del README maestro: número lógico → archivo ───────────────────────
const readme = fs.readFileSync(path.join(RAIZ, '00_README_MASTER.md'), 'utf8');
const indice = [];
// Formato actual: | `archivo` | Nº antiguo | … ; formato anterior: | Nº | `archivo` | …
for (const m of readme.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(\d{2})\s*\|/gm)) indice.push({ numero: m[2], entrada: m[1] });
for (const m of readme.matchAll(/^\|\s*(\d{2})\s*\|\s*`([^`]+)`\s*\|/gm)) indice.push({ numero: m[1], entrada: m[2] });

// ── Paquete npm declarado ────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const declarados = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const NATIVOS = new Set(require('node:module').builtinModules);
const esNativo = (n) => n.startsWith('node:') || NATIVOS.has(n.split('/')[0]);
const paqueteDe = (n) => (n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0]);

// ── Análisis estático de requires ────────────────────────────────────────────
function resolverInterno(desde, spec) {
  const base = path.resolve(path.dirname(path.join(RAIZ, desde)), spec);
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(RAIZ, c);
  }
  return null;
}
// Sustituye comentarios y contenido de literales de texto por espacios (conserva posiciones y saltos
// de línea) para que `alias.miembro` dentro de un mensaje o comentario no cuente como uso de contrato.
function soloCodigo(t) {
  let o = ''; let i = 0;
  while (i < t.length) {
    const c = t[i], d = t[i + 1];
    if (c === '/' && d === '/') { while (i < t.length && t[i] !== '\n') { o += ' '; i++; } continue; }
    if (c === '/' && d === '*') { const f = t.indexOf('*/', i + 2); const fin = f < 0 ? t.length : f + 2; o += t.slice(i, fin).replace(/[^\n]/g, ' '); i = fin; continue; }
    if (c === "'" || c === '"' || c === '`') {
      o += c; i++;
      while (i < t.length && t[i] !== c) { if (t[i] === '\\') { o += '  '; i += 2; continue; } o += t[i] === '\n' ? '\n' : ' '; i++; }
      o += c; i++; continue;
    }
    o += c; i++;
  }
  return o;
}
function analizar(rel) {
  const texto = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  const sinComentarios = texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const internos = new Map(); const externos = new Set(); const noResueltos = [];
  const usos = []; // { destino, miembro, linea }
  for (const m of sinComentarios.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    if (spec.includes('${')) continue;
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const r = resolverInterno(rel, spec);
      if (r) internos.set(r, true); else noResueltos.push(spec);
    } else if (!esNativo(spec)) externos.add(paqueteDe(spec));
  }
  // Alias: const x = require('./m');   const { a, b: c } = require('./m');   require('./m').fn
  const codigo = soloCodigo(texto);
  const lineaDe = (idx) => texto.slice(0, idx).split('\n').length;
  const enlaces = []; // { alias, destino, linea, instanciado, usadoComoValor }
  for (const m of texto.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)\s*(?:;|\n)/g)) {
    const destino = resolverInterno(rel, m[2]); if (!destino) continue;
    const alias = m[1];
    const esc = alias.replace(/\$/g, '\\$');
    const instanciado = new RegExp(`\\b(?:new|extends)\\s+${esc}\\b`).test(codigo);
    const comoValor = [...codigo.matchAll(new RegExp(`(?<![\\w$.])${esc}(?![\\w$])(?!\\s*[.(\\[])`, 'g'))].filter(u => u.index !== codigo.indexOf(alias, m.index)).map(u => lineaDe(u.index));
    enlaces.push({ alias, destino, linea: lineaDe(m.index), instanciado, comoValor });
    for (const u of codigo.matchAll(new RegExp(`(?<![\\w$.])${alias.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
      usos.push({ destino, miembro: u[1], linea: lineaDe(u.index), forma: 'alias' });
    }
  }
  for (const m of texto.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const destino = resolverInterno(rel, m[2]); if (!destino) continue;
    for (const parte of m[1].split(',')) {
      const nombre = parte.split(':')[0].trim(); if (nombre) usos.push({ destino, miembro: nombre, linea: lineaDe(m.index), forma: 'desestructurado' });
    }
  }
  for (const m of texto.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/g)) {
    const destino = resolverInterno(rel, m[1]); if (destino) usos.push({ destino, miembro: m[2], linea: lineaDe(m.index), forma: 'directo' });
  }
  // Inyección en línea: `clave: require('./m')` o `fn(require('./m'))` (el valor es la exportación tal cual).
  for (const m of codigo.matchAll(/(?:[:,(]\s*)require\(/g)) {
    const spec = texto.slice(m.index).match(/require\(\s*['"](\.[^'"]+)['"]\s*\)(\s*[.(]?)/);
    if (!spec || spec[2].trim()) continue;
    const destino = resolverInterno(rel, spec[1]); if (destino) enlaces.push({ alias: null, destino, linea: lineaDe(m.index), instanciado: false, comoValor: [lineaDe(m.index)] });
  }
  return { internos: [...internos.keys()].sort(), externos: [...externos].sort(), noResueltos, usos, enlaces };
}

// ── Exportaciones reales: carga aislada con paquetes externos sustituidos ────
function exportacionesReales(modulos) {
  const script = `
    const Module = require('module'); const path = require('path');
    const resolver = Module._resolveFilename;
    Module._resolveFilename = function (req, parent, ...r) {
      try { return resolver.call(this, req, parent, ...r); }
      catch (e) { if (!req.startsWith('.') && !req.startsWith('/')) return '__stub__'; throw e; } };
    const stub = new Proxy(function () {}, { get: (t, p) => (p === '__esModule' ? false : stub), apply: () => stub, construct: () => stub });
    require.cache['__stub__'] = { id: '__stub__', filename: '__stub__', loaded: true, exports: stub };
    const setI = global.setInterval, setT = global.setTimeout;
    global.setInterval = () => ({ unref() {} }); global.setTimeout = (f, ms) => (ms > 50 ? { unref() {} } : setT(f, ms));
    const salir = process.exit; process.exit = () => {}; process.on = () => process;
    const out = {};
    for (const rel of JSON.parse(process.argv[process.argv.length - 3])) {
      try {
        const m = require(path.join(process.argv[process.argv.length - 2], rel));
        const claves = new Set(Object.keys(m || {})); const instancia = new Set();
        if (typeof m === 'function') {
          claves.add('__funcion__');
          for (const k of Object.getOwnPropertyNames(m)) if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(k)) claves.add(k);
          if (m.prototype) for (const k of Object.getOwnPropertyNames(m.prototype)) if (k !== 'constructor') instancia.add(k);
        }
        out[rel] = { ok: true, claves: [...claves].sort(), instancia: [...instancia].sort(), tipo: typeof m === 'function' ? (/^class\\s/.test(Function.prototype.toString.call(m)) ? 'clase' : 'función') : 'objeto' };
      } catch (e) { out[rel] = { ok: false, error: e.message.split('\\n')[0] }; }
    }
    require('fs').writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(out));
    salir(0);`;
  const tmp = path.join(require('node:os').tmpdir(), `inventario_${process.pid}.json`);
  try {
    execFileSync(process.execPath, ['-e', script, JSON.stringify(modulos), RAIZ, tmp],
      { cwd: RAIZ, env: { ...process.env, NODE_ENV: 'test' }, timeout: 60000, stdio: ['ignore', 'ignore', 'ignore'] });
    const r = JSON.parse(fs.readFileSync(tmp, 'utf8')); fs.unlinkSync(tmp); return r;
  } catch (e) { return Object.fromEntries(modulos.map(m => [m, { ok: false, error: 'carga aislada abortada: ' + e.message.split('\n')[0] }])); }
}

// ── Construcción ─────────────────────────────────────────────────────────────
const js = archivos.filter(f => f.endsWith('.js') && !f.startsWith('tools/'));
const analisis = Object.fromEntries(js.map(f => [f, analizar(f)]));
const ENTRADAS = new Set(['server/index.js', 'scripts/migrate.js', 'scripts/verify.js']);
const exportaciones = exportacionesReales(js.filter(f => !f.startsWith('tests/') && !/^(26|39)_/.test(f) && !f.startsWith('driver_app/') && !ENTRADAS.has(f)));

function alcanzables(entradas) {
  const vistos = new Set(); const pila = [...entradas];
  while (pila.length) { const f = pila.pop(); if (vistos.has(f) || !analisis[f]) continue; vistos.add(f); pila.push(...analisis[f].internos); }
  return vistos;
}
const runtime = alcanzables(['server/index.js']);
const bootstrap = alcanzables(['scripts/migrate.js']);
const SUITES_UNIT = ['26_pruebas_estres_70.js', '39_pruebas_sistema_completo.js'];
const SUITES_PG = archivos.filter(f => /^tests\/integration\/postgres_.*\.js$/.test(f)).sort();
const cubiertoPor = (suites) => { const m = new Map(); for (const s of suites) for (const f of alcanzables([s])) if (f !== s) m.set(f, [...(m.get(f) || []), s]); return m; };
const unit = cubiertoPor(SUITES_UNIT); const pg = cubiertoPor(SUITES_PG);
const textual = new Map();
for (const s of SUITES_UNIT) {
  const t = fs.readFileSync(path.join(RAIZ, s), 'utf8');
  for (const m of t.matchAll(/leer\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const f = archivos.find(a => a === m[1] || a.startsWith(m[1]));
    if (f) textual.set(f, [...new Set([...(textual.get(f) || []), s])]);
  }
}

// Contratos: miembro usado que el módulo destino no exporta.
const contratos = [];
for (const [origen, a] of Object.entries(analisis)) {
  if (origen.startsWith('tests/') || SUITES_UNIT.includes(origen)) continue;
  for (const u of a.usos) {
    const ex = exportaciones[u.destino];
    if (!ex || !ex.ok) continue;
    if (['prototype', 'call', 'apply', 'bind', 'then'].includes(u.miembro)) continue;
    if (!ex.claves.includes(u.miembro)) contratos.push({ origen, linea: u.linea, destino: u.destino, miembro: u.miembro,
      tipo: ex.instancia.includes(u.miembro) ? 'método de instancia llamado sobre la clase' : 'miembro no exportado',
      exporta: ex.claves.filter(k => k !== '__funcion__') });
  }
  for (const e of a.enlaces) {
    const ex = exportaciones[e.destino];
    if (!ex || !ex.ok || ex.tipo !== 'clase' || e.instanciado || !e.comoValor.length) continue;
    contratos.push({ origen, linea: e.comoValor[0], destino: e.destino, miembro: '(clase)', tipo: 'clase inyectada como dependencia sin instanciar',
      exporta: ex.instancia });
  }
}
// Excepciones documentadas: cada una apunta a un defecto abierto en docs/ERRORES.md. Un hallazgo nuevo
// o una excepción que ya no coincide con ningún hallazgo hacen fallar la herramienta (exit 1).
const RUTA_EXC = path.join(__dirname, 'inventario_excepciones.json');
const excepciones = fs.existsSync(RUTA_EXC) ? JSON.parse(fs.readFileSync(RUTA_EXC, 'utf8')).excepciones : [];
const claveC = (c) => `${c.origen}|${c.destino}|${c.miembro}`;
for (const c of contratos) { const e = excepciones.find(x => `${x.origen}|${x.destino}|${x.miembro}` === claveC(c)); c.defecto = e ? e.defecto : null; }
for (const [f, a] of Object.entries(analisis)) for (const r of a.noResueltos)
  contratos.push({ origen: f, linea: null, destino: r, miembro: '(archivo)', tipo: 'require de un archivo que no existe',
    defecto: (excepciones.find(x => x.origen === f && x.destino === r) || {}).defecto || null, exporta: [] });
const nuevos = contratos.filter(c => !c.defecto);
const obsoletas = excepciones.filter(x => !contratos.some(c => claveC(c) === `${x.origen}|${x.destino}|${x.miembro}`));
const noDeclarados = new Map();
for (const [f, a] of Object.entries(analisis)) {
  if (f.startsWith('tests/') || f.startsWith('driver_app/')) continue;
  for (const e of a.externos) if (!declarados.has(e)) noDeclarados.set(e, [...(noDeclarados.get(e) || []), f]);
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, f))).digest('hex');
const lineas = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8').split('\n').length;
const numeroIndice = (f) => { const e = indice.find(i => i.entrada === f || (i.entrada.endsWith('/') && f.startsWith(i.entrada))); return e ? e.numero : null; };

const inventario = archivos.sort().map(f => {
  const base = { ruta: f, tipo: tipoDe(f), lineas: lineas(f), sha256: sha(f), indice: numeroIndice(f) };
  if (!analisis[f]) return base;
  const a = analisis[f]; const ex = exportaciones[f];
  return { ...base, internos: a.internos, externos: a.externos, externos_no_declarados: a.externos.filter(e => !declarados.has(e)),
    exporta: ex ? (ex.ok ? ex.claves.filter(k => k !== '__funcion__') : `ERROR: ${ex.error}`) : null, forma_export: ex && ex.ok ? ex.tipo : null,
    runtime: runtime.has(f), bootstrap: bootstrap.has(f),
    pruebas_unitarias: unit.get(f) || [], pruebas_pg: pg.get(f) || [], comprobacion_textual: textual.get(f) || [],
    contratos_rotos: contratos.filter(c => c.origen === f).map(c => `${c.destino}.${c.miembro} (línea ${c.linea})`) };
});

const resumen = {
  commit, generado: new Date().toISOString(), archivos: inventario.length,
  por_tipo: inventario.reduce((acc, i) => ({ ...acc, [i.tipo]: (acc[i.tipo] || 0) + 1 }), {}),
  modulos_js: js.length, en_runtime: runtime.size, en_bootstrap: bootstrap.size,
  con_pruebas_pg: [...pg.keys()].filter(f => !f.startsWith('tests/')).length,
  contratos_rotos: contratos.length, contratos_nuevos: nuevos.length, excepciones_obsoletas: obsoletas.map(x => `${x.origen} → ${x.destino}.${x.miembro}`), dependencias_no_declaradas: Object.fromEntries(noDeclarados),
  indice_readme: { entradas: indice.length, sin_archivo: indice.filter(i => !archivos.some(f => f === i.entrada || (i.entrada.endsWith('/') && f.startsWith(i.entrada)))).map(i => i.entrada),
    numeros_duplicados: [...new Set(indice.map(i => i.numero).filter((n, k, a) => a.indexOf(n) !== k))] },
  requires_sin_archivo: Object.entries(analisis).flatMap(([f, a]) => a.noResueltos.map(r => `${f} → ${r}`)),
  cargas_fallidas: Object.entries(exportaciones).filter(([, e]) => !e.ok).map(([f, e]) => `${f}: ${e.error}`),
};
const total = { resumen, contratos, inventario };
if (salidaJson) fs.writeFileSync(salidaJson, JSON.stringify(total, null, 2));
if (salidaMd) {
  const conexion = (i) => i.runtime ? (i.pruebas_pg.length ? 'runtime + PG' : 'runtime sin PG')
    : i.bootstrap ? 'bootstrap' : (i.pruebas_pg.length || i.pruebas_unitarias.length) ? 'solo pruebas' : 'sin conexión';
  const filas = inventario.map(i => `| \`${i.ruta}\` | ${i.indice || '—'} | ${i.tipo} | ${i.lineas} | \`${i.sha256.slice(0, 12)}\` |` +
    (i.internos ? ` ${conexion(i)} | ${i.pruebas_pg.length ? 'sí' : 'no'} | ${i.pruebas_unitarias.length ? 'sí' : (i.comprobacion_textual.length ? 'texto' : 'no')} | ${i.contratos_rotos.length ? i.contratos_rotos.join('<br>') : ''} |` : ' | | | |'));
  fs.writeFileSync(salidaMd, [
    `# Inventario verificable — commit ${commit}`, '',
    `Generado por \`node tools/inventario.js --md docs/INVENTARIO.md\` (${resumen.generado}). No editar a mano: regenerar.`, '',
    `Archivos versionados (sin evidencia histórica de \`informes/\`): **${resumen.archivos}**. Módulos JS: ${resumen.modulos_js}; alcanzables desde \`server/index.js\`: ${resumen.en_runtime}; cargados por pruebas PostgreSQL: ${resumen.con_pruebas_pg}. Contratos rotos: ${resumen.contratos_rotos}.`, '',
    'Conexión: *runtime* = alcanzable por `require` desde `server/index.js`; *bootstrap* = desde `scripts/migrate.js`; *solo pruebas* = únicamente lo cargan suites; *sin conexión* = nada lo carga. *texto* = la suite solo inspecciona su texto, no lo ejecuta.', '',
    '| Ruta | Nº índice | Tipo | Líneas | SHA-256 (12) | Conexión | Prueba PG | Prueba unitaria | Contratos rotos |', '|---|---|---|---|---|---|---|---|---|', ...filas, ''].join('\n'));
}
console.log(JSON.stringify(resumen, null, 2));
if (contratos.length) { console.log('\nCONTRATOS ROTOS:'); for (const c of contratos) console.log(`  ${c.origen}:${c.linea} → ${c.destino} ${c.miembro}: ${c.tipo} [${c.defecto || 'NUEVO'}]`); }
for (const o of obsoletas) console.log(`EXCEPCIÓN OBSOLETA: ${o.origen} → ${o.destino}.${o.miembro} (${o.defecto})`);
process.exitCode = nuevos.length || obsoletas.length || noDeclarados.size ? 1 : 0;
