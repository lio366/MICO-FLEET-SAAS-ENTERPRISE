'use strict';
// Secuencia ÚNICA de esquema, compartida por scripts/migrate.js (bootstrap) y server/index.js (arranque).
// Sin dependencias de runtime (E-017): solo lee archivos SQL versionados.
//
// Orden (importa):
//   1. 01_multi_tenant_database.sql      esquema base, solo si la BD está vacía (no es idempotente)
//   2. sql/<módulo>.sql                  DDL idempotente de cada módulo
//   3. migrations/NNN_*.up.sql           migraciones versionadas pendientes
//   4. infra/postgres/003_app_grants.sql privilegios del runtime + RLS de tablas con tenant_id
//   5. sql/42_audit_ledger_roles.sql     privilegio mínimo del ledger (SELECT, INSERT)
// Debe ejecutarse con la identidad administrativa (MIGRATION_DATABASE_URL / PG_ADMIN_URL).
//
// Concurrencia: varias réplicas pueden arrancar a la vez contra la misma BD. Cada fase corre
// en una transacción que toma el mismo candado que el migrador y decide DENTRO del candado
// (p. ej. si falta el esquema base). Sin esto, dos réplicas sobre una BD vacía aplicaban el
// esquema base en paralelo y fallaban con "duplicate key ... pg_type_typname_nsp_index" (E-023).
const fs = require('node:fs');
const path = require('node:path');
const { leerSql } = require('./sql');
const migrador = require('./migrador');

const RAIZ = path.resolve(__dirname, '..');
const MODULOS_SQL = [
  '02_tenant_middleware',
  '03_billing_stripe',
  '41_auth_rbac',
  '42_audit_ledger',
  '44_event_bus',
  '45_notification_service',
  '47_scheduler_cluster',
  // Módulos de dominio con DDL propio que no se aplicaba en ningún arranque (E-029).
  '30_tarifas_inteligentes',
  '32_score_confianza',
  '33_verificacion_carrier',
  '35_apis_gratuitas_geografia',
  // 14_geospatial_engine.sql y 34_ifta_report requieren la extensión PostGIS: fuera de la
  // secuencia hasta que el despliegue la incluya (E-032).
];

const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

async function aplicarEsquema(db, { log = () => {} } = {}) {
  return migrador.conCliente(db, async (client) => {
    const base = await migrador.transaccionConCandado(client, async () => {
      const { rows } = await client.query("SELECT to_regclass('public.tenants') IS NOT NULL AS existe");
      const aplicarBase = !rows[0].existe;
      if (aplicarBase) await client.query(leer('01_multi_tenant_database.sql'));
      for (const nombre of MODULOS_SQL) await client.query(leerSql(nombre));
      return aplicarBase;
    });
    if (base) log('esquema.base_aplicada');
    log('esquema.modulos_aplicados', { modulos: MODULOS_SQL.length });

    const migraciones = await migrador.migrar(client);
    log('esquema.migraciones', { aplicadas: migraciones.aplicadas });

    await migrador.transaccionConCandado(client, async () => {
      await client.query(leer('infra/postgres/003_app_grants.sql'));
      await client.query(leerSql('42_audit_ledger_roles'));
    });
    log('esquema.privilegios_aplicados');
    return { ok: true, base, modulos: MODULOS_SQL, migraciones };
  });
}

module.exports = { aplicarEsquema, MODULOS_SQL };
