'use strict';
// Bootstrap idempotente del esquema. No se debe ejecutar contra producción sin snapshot
// y revisión de migraciones; la identidad requerida es administrativa.
// No carga módulos de runtime (stripe, jsonwebtoken, twilio...): solo SQL versionado (E-017).
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { aplicarEsquema } = require('../db/esquema');
const ledger = require('../42_audit_ledger');

cargarEnv(path.resolve(__dirname, '..', '.env'));

const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.PG_ADMIN_URL;
if (!connectionString) {
  console.error('Falta MIGRATION_DATABASE_URL o PG_ADMIN_URL (credencial administrativa).');
  process.exit(1);
}

// Cargador .env mínimo: no sobrescribe variables ya definidas. Evita depender de dotenv
// para poder preparar la BD antes de instalar dependencias de runtime.
function cargarEnv(archivo) {
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(linea);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    process.env[m[1]] = v;
  }
}

const db = new Pool({ connectionString, max: 2 });
(async () => {
  try {
    const esquema = await aplicarEsquema(db, { log: (evento, datos) => console.log(evento, datos ? JSON.stringify(datos) : '') });
    const recovery = await ledger.verificacionPostRestauracion(db);
    console.log(JSON.stringify({ ok: true, esquema, recovery }, null, 2));
  } catch (e) {
    console.error('BOOTSTRAP/MIGRACIÓN FALLÓ:', e.stack || e);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
