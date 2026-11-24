# PostgreSQL real — Micro Fleet

## Objetivo

Entorno reproducible PostgreSQL 16 para desarrollo e integración. La suite T1–T7 usa dos identidades distintas: `mf_bootstrap` (provisionamiento/migraciones) y `mf_login` (tráfico de aplicación, miembro de `mf_app`). No se usa SQLite ni mocks como sustituto del motor.

## Archivos construidos

- `docker-compose.postgres.yml`: PostgreSQL 16, volumen persistente, healthcheck y red dedicada.
- `infra/postgres/001_roles.sql` y `002_set_password.sh`: roles y contraseña del login de aplicación.
- `infra/postgres/003_app_grants.sql`: privilegios y RLS para tablas con `tenant_id`.
- `package.json`: manifiesto backend, dependencias y scripts reproducibles.
- `scripts/migrate.js`: bootstrap de una base vacía con credenciales administrativas.
- `tests/integration/postgres_t1_t7.js`: siete pruebas de integración contra PostgreSQL real.

## Preparación

1. Copiar `.env.example` a `.env` y definir dos contraseñas largas y diferentes: `POSTGRES_PASSWORD` y `MF_APP_PASSWORD`.
2. Levantar el servicio `postgres` mediante `docker-compose.postgres.yml`.
3. Instalar dependencias Node del manifiesto raíz.
4. Ejecutar el bootstrap administrativo una sola vez en la base nueva.
5. Ejecutar `npm run test:pg:strict` con `PG_ADMIN_URL` y `DATABASE_URL` apuntando a la misma base: el primero como `mf_bootstrap`, el segundo como `mf_login`.

El volumen conserva los datos. Para reinicializar un entorno desechable de pruebas se debe eliminar explícitamente el volumen; nunca hacerlo en producción.

## Contrato de pruebas T1–T7

| Prueba | Evidencia exigida |
|---|---|
| T1 | PostgreSQL real detectado, esquema base y tablas críticas |
| T2 | Migración v6 aplicada una vez y segunda ejecución idempotente |
| T3 | RLS: lectura aislada e intento de escritura cruzada bloqueado |
| T4 | Asientos append-only, hashes y verificación de cadena |
| T5 | UPDATE del ledger denegado al rol runtime |
| T6 | 12 escrituras concurrentes, deduplicación estable y conflicto detectado |
| T7 | Checkpoint Ed25519 válido y gate DR rechaza firma manipulada |

La suite aborta al primer fallo. Un resultado sin conexión PostgreSQL no cuenta como PASS.

## Límites de seguridad que siguen abiertos

- Resuelto (E-028, commit aa55d52): `tenants` se lee sin RLS solo para resolver la empresa por Host (columnas públicas, caché con TTL). Todo acceso posterior pasa por `req.enTenant(fn)`: transacción con `set_config('app.current_tenant', id, true)`, local a la transacción. `set_config(..., false)` está prohibido; T18 verifica que ninguna conexión del pool conserve contexto.
- Resuelto (E-031, commit 5ae367a): los workers descubren las empresas con trabajo mediante funciones SECURITY DEFINER que solo devuelven ids (migración 006) y trabajan empresa por empresa con contexto local. T19 lo verifica con 3 réplicas concurrentes.
- El servidor debe usar `DATABASE_URL` como rol runtime y `MIGRATION_DATABASE_URL` como identidad administrativa. No se deben compartir credenciales admin con workers ni exponerlas al cliente.
- Ejecución real (2026-11-23, commit c2facca): T1–T7 7/7 PASS contra PostgreSQL 16.15 nativo con el driver de validación `tools/pg-compat`, porque Docker no tenía daemon y el registro npm no era accesible. Ver `informes/fase2_pg_real_t1_t7_20261123.md`. Falta repetirla con `pg` oficial tras `npm ci`.
- T19 (commit e195756) cubre los workers multiempresa (bus, cron, agente). Ver `informes/fase2f_workers_multiempresa_20261123.md`.
- T20 (commit ea6ce62) cubre el webhook de Stripe (E-040). Ver `informes/fase2g_stripe_webhook_20261123.md`.
- T18 (commit 98597a4) cubre la API autenticada con RLS por petición; la auditoría SQL (`tests/integration/auditoria_sql.js`) forma parte del runner: 0 hallazgos nuevos; mutaciones 35/35. Ver `informes/fase2e_api_rls_20261123.md`.
- T17 (commit b86a250) cubre los webhooks de Twilio bajo RLS (firma, resolución de tenant de mínimo privilegio, exactamente-una-vez): 1/1 PASS; batería de mutaciones 28/28. Ver `informes/fase2d_e025_webhooks_20261123.md`.
- T14–T16 (commit a988ddf) cubre operaciones de negocio v7, rotación de claves de checkpoint, migraciones reversibles y arranque concurrente: 3/3 PASS; batería de mutaciones 22/22. Ver `informes/fase2c_e016_e017_e022_20261123.md`.
- T8–T13 (commit e6353e6/f4ecafe) cubre alteración, borrado/restore, COMMIT ambiguo, backup/restore, elección de líder y candado distribuido: 6/6 PASS con pg-compat; 12/12 mutaciones detectadas. Ver `informes/fase2b_t8_t13_20261123.md` y la matriz en `VERIFY.md`.

## Ejecución sin Docker

`tests/integration/run_native_pg16.sh [dir]` crea un clúster PostgreSQL 16 desechable que replica el compose (superusuario `mf_bootstrap`, SCRAM, `001_roles.sql` y `002_set_password.sh`), genera un par Ed25519 compartido (`CHECKPOINT_*_KEY`), ejecuta en modo estricto T1–T7, T8–T13, T14–T16, T17, T18, T19, T20 y la auditoría SQL (cada etapa solo si la anterior pasa), guarda `entorno.txt` y un log por etapa, y detiene el clúster. `tests/integration/mutaciones_pg.py` lo usa para validar la suite con mutaciones. Devuelve 3 (BLOCKED) si faltan binarios de PostgreSQL 16, node, openssl o el módulo `pg`.

La suite exige una BD recién creada y aborta con `PRECONDICION_BD_NO_DESECHABLE` si el ledger ya tiene asientos o checkpoints (ver E-016).
