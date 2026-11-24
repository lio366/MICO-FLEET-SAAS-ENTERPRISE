'use strict';
const { spawnSync } = require('node:child_process');
function run(args) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status || 1);
}
run(['26_pruebas_estres_70.js']);
run(['39_pruebas_sistema_completo.js']);
run(['tests/integration/postgres_t1_t7.js']);
