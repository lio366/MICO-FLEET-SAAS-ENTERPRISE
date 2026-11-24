# Fase 2: PostgreSQL 16 real, suite T1–T7

**Fecha de ejecución:** 2026-11-23 (16:19–16:24 UTC)
**Commit evaluado:** `c2faccaa98a51ad3d232a4872dbbddd197b1e52c` (rama `fase2/pg-real-t1-t7`, sobre `7088099`)
**Evidencia:** `informes/evidencia_fase2_pg16_20261123/` (hashes en `SHA256SUMS`)

## Veredicto

| Gate | Estado | Base |
|---|---|---|
| T1–T7 contra PostgreSQL real | **PASS 7/7** con driver `pg-compat` | `t1_t7.log`, exit 0, 5 ejecuciones limpias consecutivas sobre BD nueva |
| Dependencias backend (`npm ci`) | **BLOCKED** | no existe `package-lock.json`; el registro npm no es accesible desde el entorno |
| Integración PostgreSQL completa (VERIFY §5) | **PARCIAL** | T1–T7 no cubre COMMIT ambiguo, alteración de contenido del ledger, borrado/restore, backup/restore ni elección de líder |
| Producción | **NO APROBADA** | sin cambios |

T1–T7 PASS no equivale a cerrar la integración PostgreSQL. Ver la matriz de cobertura en `VERIFY.md`.

## Entorno

| Elemento | Valor |
|---|---|
| Motor | PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), clúster nativo desechable |
| Docker | binario cliente 29.10.0 presente, **sin daemon** (`/var/run/docker.sock` inexistente) |
| Autenticación | SCRAM-SHA-256 en local y TCP |
| Identidades | `mf_bootstrap` (superusuario de init, como en la imagen oficial) y `mf_login` (LOGIN, miembro de `mf_app`) |
| Node / npm | v22.23.5 / 10.9.9 |
| Driver `pg` | `0.0.0-pg-compat` (`tools/pg-compat`), **no** el paquete oficial |
| ZIP recibido | `7476cf62f4232f0c0606648a624d6b8f551f246901b6b06a26feceda89e60e3e` |
| Bundle git recibido | `f1f779bde2ccfd0224f1bd934a1722a1cfa77708e6ddd01b8e574e88d36de24c` |

El bundle y el ZIP contienen el mismo árbol (`diff -rq` sin diferencias antes de las correcciones).

### Por qué no se usó Docker

El cliente Docker existe, pero no hay daemon. La alternativa fue `tests/integration/run_native_pg16.sh`, que reproduce `docker-compose.postgres.yml` con binarios nativos: initdb con `mf_bootstrap` y SCRAM, base `micro_fleet`, y los scripts `001_roles.sql` y `002_set_password.sh` en el mismo orden que `docker-entrypoint-initdb.d`. El motor es el mismo (PostgreSQL 16); cambia el empaquetado.

### Por qué no se usó el paquete `pg` oficial

Con la red de paquetes cerrada, `npm install pg` y `npm install --offline` fallaron (`ENOTCACHED`). No había caché local ni driver de Python. Se escribió `tools/pg-compat`, que habla el protocolo v3 por TCP y SCRAM-SHA-256 contra el servidor real. Antes de la suite se validó que se comporta como `pg` en lo que el código usa: int8 como string, jsonb a objeto, timestamptz a `Date`, bytea a `Buffer`, arrays, códigos SQLSTATE, multi-statement, pool concurrente con `max`.

**Riesgo residual:** un comportamiento de `pg` oficial que difiera de pg-compat podría alterar algún resultado. Mitigación pendiente: repetir con `npm ci` y `pg` oficial (paso 1 del plan siguiente).

## Comandos ejecutados

```bash
NODE_PATH=<pg-compat> PG_PORT=55434 tests/integration/run_native_pg16.sh <evid>   # exit 0, 7/7
for f in $(git ls-files '*.js'); do node --check "$f"; done                       # 51 archivos, 0 errores
node 26_pruebas_estres_70.js                                                      # exit 0, 70/70
node 39_pruebas_sistema_completo.js                                               # exit 0, 63/63
```

## Resultados T1–T7 (commit c2facca)

| Prueba | Estado | Detalle |
|---|---|---|
| T1 esquema base y objetos | PASS | 6 tablas críticas verificadas |
| T2 migración v6 idempotente | PASS | primera=1; segunda=0 |
| T3 RLS entre tenants | PASS | A=1; B=1; INSERT cruzado bloqueado (42501) |
| T4 ledger append y verificación | PASS | 2 asientos; cadena válida |
| T5 inmutabilidad | PASS | UPDATE denegado al rol de aplicación |
| T6 concurrencia e idempotencia | PASS | 12 escrituras paralelas; dedup estable; reutilización conflictiva bloqueada; total=13 |
| T7 checkpoint Ed25519 y gate DR | PASS | firma válida; alteración detectada; firma restaurada |

La línea `ledger.integridad_dedup` de nivel error en T6 es la alerta esperada del caso conflictivo, no un fallo.

## Defectos reales encontrados y corregidos

La primera ejecución contra el motor real falló en T1, y después en T4. Las tres corrigieron código del producto, no de la prueba.

1. **E-013 · Secuencia inexistente en `SQL_ROLES`** (T1). `BIGSERIAL seq` crea `audit_ledger_seq_seq`, pero el SQL hacía `ALTER/GRANT` sobre `audit_ledger_seq`. Ningún despliegue podía aplicar los roles del ledger. Log: `historico_fallo1_seq_inexistente.log`.
2. **E-014 · `LOCK TABLE … IN SHARE MODE` imposible para `mf_app`** (T4). PostgreSQL exige UPDATE/DELETE/TRUNCATE para ese modo, y esos privilegios están revocados a propósito. `verificarIntegridad` fallaba siempre con el rol de runtime y, por tanto, también el gate DR de arranque. El test unitario G10 exigía ese LOCK, así que la regresión lo daba por bueno. Se corrigió con `REPEATABLE READ, READ ONLY` (D-011). Log: `historico_fallo2_lock_share_mode.log`.
3. **E-015 · `002_set_password.sh` no asignaba la contraseña.** `psql --command` no interpola `:'app_password'`; el init del contenedor Docker abortaba. Ahora el SQL llega por stdin.

## Defectos encontrados y abiertos

4. **E-016 · Los checkpoints no admiten rotación de clave.** El gate post-restauración verifica todos los checkpoints con una sola clave pública. Un checkpoint firmado con una clave anterior bloquea el arranque. Se detectó al repetir la suite sobre una BD poblada (`historico_fallo3_rerun_sin_precondicion.log`). La suite ahora exige BD desechable y lo dice de forma explícita (`precondicion_bd_poblada.log`). El defecto del producto sigue abierto.
5. **E-017 · `scripts/migrate.js` necesita dependencias de runtime para leer SQL.** El bootstrap importa `02`, `03`, `41`, `44` y `45`, que cargan `jsonwebtoken`, `stripe`, etc. Sin `npm ci` el bootstrap no arranca. No se pudo ejecutar `npm run db:bootstrap` en esta sesión.

## Pruebas de mutación (¿falla la suite si se rompe la protección?)

| Mutación deliberada | Resultado | Lectura |
|---|---|---|
| RLS desactivado en `drivers` | FAIL T3 | detecta |
| Trigger de inmutabilidad eliminado + `GRANT UPDATE` a `mf_app` | FAIL T5 | detecta |
| Índice único de dedup anulado | FAIL T4 | detecta |
| Verificación de firma del checkpoint anulada | FAIL T7 | detecta |
| Recálculo del hash en `_verificar` anulado | **PASS 7/7** | **no detecta**: ninguna prueba altera el contenido del ledger en PostgreSQL |

Los dos fallos reales previos también sirven como mutaciones: la secuencia mal nombrada la detecta T1 y el LOCK SHARE la detecta T4.

Las mutaciones se ejecutaron sobre copias desechables del árbol, cada una con BD recreada. La de firma se ejecutó sobre la rama de pool real (`42_audit_ledger.js:585`). Un primer intento sobre la rama de mocks no ejercía el código, se descartó y no se cuenta.

## Plan siguiente, por orden

1. Con acceso a npm: generar `package-lock.json`, ejecutar `npm ci` y repetir `run_native_pg16.sh` (o el compose de Docker) con `pg` oficial. Comparar con este informe.
2. Ampliar la suite con T8–T12: alteración directa de contenido como superusuario seguida de verificación (cierra la mutación no detectada), COMMIT ambiguo con conexión cortada entre el envío de COMMIT y la respuesta, borrado/restore, `pg_dump`/`pg_restore` con gate DR, y elección de líder con `47_scheduler_cluster` en varios procesos.
3. Resolver E-016 (identificador de clave por checkpoint, `firma_kid`) y E-017 (SQL de módulos en archivos `.sql` independientes de sus dependencias de runtime).
4. Gate de arranque: `server/index.js` con `/healthz` y `/metrics`.
