'use strict';
// Lector del DDL versionado en sql/*.sql (fuente única del esquema de cada módulo).
// Sin dependencias de runtime: lo usan los módulos de dominio, el bootstrap y el
// arranque del servidor sin cargar stripe, jsonwebtoken, twilio, etc. (E-017).
const fs = require('node:fs');
const path = require('node:path');

const DIR_SQL = path.resolve(__dirname, '..', 'sql');
const NOMBRE_VALIDO = /^[0-9A-Za-z_]+$/;
const cache = new Map();

function leerSql(nombre) {
  if (!NOMBRE_VALIDO.test(nombre)) throw new Error(`Nombre de SQL inválido: ${nombre}`);
  if (!cache.has(nombre)) {
    const ruta = path.join(DIR_SQL, `${nombre}.sql`);
    const texto = fs.readFileSync(ruta, 'utf8');
    if (!texto.trim()) throw new Error(`SQL vacío: ${ruta}`);
    cache.set(nombre, texto);
  }
  return cache.get(nombre);
}

module.exports = { leerSql, DIR_SQL };
