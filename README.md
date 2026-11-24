# pg-compat — driver PostgreSQL de validación

Driver del protocolo PostgreSQL v3 en Node.js puro, sin dependencias, compatible con el subconjunto de la API de `pg` (node-postgres) que usa Micro Fleet: `Pool`, `Client`, `pool.query`, `pool.connect`/`client.release`, `pool.end`, errores con `code`/`constraint`/`detail`, y parsers de tipos equivalentes a `pg` (int8 y numeric como string, json/jsonb como objeto, timestamptz como `Date`, bytea como `Buffer`, arrays 1-D).

Autenticación: trust, cleartext, MD5 y SCRAM-SHA-256.

## Por qué existe

El 2026-11-23 el registro npm no era accesible desde el entorno de ejecución, por lo que no se pudo instalar el paquete oficial `pg`. Este driver permitió ejecutar T1–T7 contra un motor PostgreSQL 16 real. Las pruebas hablan con el servidor por TCP y SCRAM: no hay mocks ni SQLite.

## Límites

- No sustituye a `pg` en producción. No implementa TLS (`sslmode=require` se rechaza), COPY, cursores, LISTEN de alto nivel ni cancelación de consultas.
- Que T1–T7 pasen con este driver no cierra el gate «Dependencias backend». Ese gate exige `package-lock.json` y un `npm ci` limpio con el `pg` oficial.
- La evidencia obtenida con pg-compat debe reproducirse con `pg` oficial en cuanto haya acceso a npm.

## Uso

Exponerlo como módulo `pg` solo en el entorno de validación, nunca dentro de `node_modules` del proyecto:

```bash
mkdir -p /tmp/pgcompat/node_modules/pg
echo "module.exports = require('$(pwd)/tools/pg-compat/index.js');" > /tmp/pgcompat/node_modules/pg/index.js
echo '{"name":"pg","version":"0.0.0-pg-compat","main":"index.js"}' > /tmp/pgcompat/node_modules/pg/package.json
NODE_PATH=/tmp/pgcompat/node_modules tests/integration/run_native_pg16.sh
```

`run_native_pg16.sh` registra la versión del driver en `entorno.txt` (`0.0.0-pg-compat` frente a la versión real de `pg`), así que la evidencia indica siempre con qué driver se obtuvo.
