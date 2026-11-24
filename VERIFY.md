# VERIFY — Micro Fleet SaaS Enterprise

Este archivo es el contrato de aceptación. **No marcar PASS sin comando ejecutado, código de salida y evidencia fechada.** Un informe en `informes/` es histórico hasta que se reproduce.

## Estado de gates (actualizado 2026-11-23: webhook de Stripe E-040, commit `ea6ce62`)

| Gate | Estado | Criterio de cierre | Evidencia / bloqueo |
|---|---|---|---|
| Fuente/Git | PASS | snapshot trazable, commit y hashes | rama `fase2/pg-real-t1-t7`; informes de fase con hashes |
| Manifiesto backend | PASS | `package.json` raíz con dependencias y scripts | `package.json` v3.1.0 (scripts `test:pg:strict`, `test:pg:t8`, `test:pg:t14`, `test:pg:full`, `test:pg:native`) |
| Dependencias backend | **BLOCKED** | `package-lock.json` versionado y `npm ci` limpio | falta `package-lock.json`; el registro npm no es accesible desde el entorno de ejecución |
| Sintaxis JS | PASS | `node --check` sobre todos los `.js` versionados | 67 archivos, 0 errores |
| Regresión 70 | PASS | `node 26_pruebas_estres_70.js` → 70/70 | `evidencia_fase2g_stripe_20261123/suite26_70.log` |
| Suite sistema | PASS | `node 39_pruebas_sistema_completo.js` → 92/92 | incluye G11–G16; `evidencia_fase2g_stripe_20261123/suite39_92.log` |
| PostgreSQL T1–T7 | **PASS (pg-compat)** | 7/7 contra PostgreSQL 16 real, BD desechable | 3 corridas limpias en `e195756` |
| PostgreSQL T8–T13 | **PASS (pg-compat)** | 6/6 tras T1–T7 en la misma BD | 3 corridas limpias en `e195756` |
| PostgreSQL T14–T16 | **PASS (pg-compat)** | 3/3 tras T1–T13 en la misma BD | 3 corridas limpias en `e195756` |
| PostgreSQL T17 (webhooks Twilio) | **PASS (pg-compat)** | peticiones firmadas por los manejadores reales, rol runtime bajo RLS | 3 corridas limpias en `e195756` |
| PostgreSQL T18 (API autenticada) | **PASS (pg-compat, proveedores criptográficos de prueba)** | cadena completa del gateway con 2 empresas y pool de 4 conexiones | 3 corridas limpias en `e195756` |
| PostgreSQL T19 (workers) | **PASS (pg-compat)** | bus con 3 réplicas, reintentos, cola de fallidos, suscriptores reales, cron y agente | 3 corridas limpias en `e195756` y en `ea6ce62` |
| PostgreSQL T20 (webhook Stripe) | **PASS (pg-compat)** | firma sobre cuerpo crudo, empresa por cliente, reentregas concurrentes, desorden, fallo atómico y reintento, mora → suspensión → reactivación | 6/6 en 3 corridas limpias en `ea6ce62` (`evidencia_fase2g_stripe_20261123/`) |
| Conformidad SQL ↔ esquema | PASS | todo SQL literal de `.query()` analizado con PREPARE; sin hallazgos fuera de excepciones; ninguna excepción obsoleta | `tests/integration/auditoria_sql.js`: 170 sentencias, 0 nuevos, 4 excepciones (E-032, E-034) |
| Mutaciones de integración | PASS | toda mutación del catálogo detectada | `tests/integration/mutaciones_pg.py` → 59/59 detectadas en `ea6ce62` (13 de E-040) |
| PostgreSQL integración §5 | **PASS (pg-compat)** | los 8 escenarios del §5 | ver matriz. Repetir con `pg` oficial tras `npm ci` |
| Casos de negocio de `46_distributed_lock` | **PASS (pg-compat)** | asignar/pagar/despachar/facturar operan sobre el esquema real con RLS | E-022 cerrado: migración 002 + T14 (10→1 en cada caso) |
| Webhooks de Twilio (SMS/voz) | **PASS (pg-compat)** | firma verificada antes de la BD; resolución de tenant de mínimo privilegio; exactamente-una-vez | E-025/E-026 cerrados (T17). El parser `urlencoded` de Express queda NOT RUN |
| Webhook de Stripe | **PASS (pg-compat)** | firma sobre el cuerpo crudo; `event.id` único; duplicados sin efectos y 2xx; suscripción + ledger en una transacción; orden; empresa por cliente; error recuperable si no termina | E-040 cerrado (T20). NOT RUN: parser `express.json` que rellena `req.rawBody` (E-027) y entregas reales de Stripe (CLI o endpoint de prueba) |
| RLS en ciclo HTTP (API autenticada) | **PASS (pg-compat)** | aislamiento por petición, token ligado a la empresa del Host, pool sin contexto residual | E-028 cerrado (T18). Enrutado Express y librerías `bcryptjs`/`jsonwebtoken` reales: NOT RUN |
| Workers multiempresa bajo RLS | **PASS (pg-compat)** | bus, cron y agente operan por empresa; exactamente-una-vez en el clúster | E-031 cerrado (T19): descubrimiento de trabajo por funciones que solo devuelven ids; trabajo con contexto por empresa |
| Motor neural de match | **FAIL (por análisis)** | el agente puntúa y ofrece cargas | E-036 abierto: módulo 15 inoperante (TensorFlow obligatorio, método inexistente); el agente falla seguro y no ofrece |
| Módulos geoespaciales (14, 34) | **BLOCKED** | PostGIS disponible y módulos en la secuencia de esquema | E-032: extensión no instalada en el entorno |
| Bootstrap `npm run db:bootstrap` | **PASS (pg-compat)** | exit 0 en BD nueva, idempotente y concurrente | E-017 cerrado: solo necesita el driver `pg`; 2 ejecuciones seguidas y 6 réplicas concurrentes (T16) |
| Ledger v6 | PARCIAL | vectores RFC 8785 oficiales + PG roles/migraciones + rotación | PG roles, migraciones up/down (T16), alteración, borrado, backup y rotación de claves (T15, E-016 cerrado): PASS. Faltan vectores RFC 8785 oficiales |
| Cluster/boot | **NOT RUN** | `/healthz` y `/metrics` con PG real tras `node server/index.js` | `server/index.js` ya invoca la elección de líder (47) y los workers; el arranque completo no se ha ejecutado (dependencias reales sin instalar). El informe histórico de fallo queda superado como evidencia pero no sustituido por una ejecución |
| Correspondencia de contratos | PASS | `node tools/inventario.js` → exit 0: ningún contrato roto, `require` sin archivo ni dependencia npm no declarada fuera de excepciones documentadas; ninguna excepción obsoleta | 4 excepciones (E-037, E-038, E-039, E-044; E-040 retirada al cerrarse); controles negativos: contrato inyectado y excepción obsoleta → exit 1. `informes/auditoria_correspondencia_20261123.md` |
| Funcionalidad comercial anunciada | **FAIL** | cada promesa de `00_README_MASTER.md` y `24_agentes_ia.md` con prueba de extremo a extremo | 41 funcionalidades auditadas: 10 VERIFICADO, 9 PARCIAL, 20 ESPECIFICACIÓN, 2 BLOQUEADO (`informes/auditoria_correspondencia_20261123.md`). Desde E-040 el cobro con Stripe sigue PARCIAL solo por `createSubscription`/`changePlan` contra la API real (NOT RUN). QuickBooks sin pruebas de idempotencia ni conciliación (E-045); agentes sin evidencia de ciclo autónomo |
| Restore drill de producción | **NOT RUN** | restauración cronometrada en otro host desde copia externa, con gate DR | solo existe restauración local en el mismo host (T11) |
| Producción | NO APROBADA | todos los gates críticos + secretos/DNS/TLS/backup/restore reales | — |

## Matriz de cobertura: escenarios del §5

| Escenario exigido (§5) | Prueba | Estado | Alcance y límites |
|---|---|---|---|
| Esquema, roles y migración idempotente | T1, T2 | PASS | — |
| Aislamiento tenant | T3, T11 | PASS | RLS de lectura y escritura cruzada en conexión transaccional; se conserva tras restore. **No** certifica el ciclo HTTP |
| Concurrencia y deduplicación | T6 | PASS | 12 escritores; dedup estable; reutilización conflictiva → alerta |
| Inmutabilidad | T5, T9 | PASS | cada capa por separado: sin UPDATE/DELETE/TRUNCATE para runtime y trigger que bloquea incluso al superusuario |
| Alteración de contenido | T8 | PASS | UPDATE directo como superusuario con triggers desactivados → `HASH NO COINCIDE` en el seq exacto; gate DR rechaza; restaurado verifica |
| COMMIT ambiguo | T10 | PASS | proxy TCP: (A) COMMIT confirmado con respuesta perdida → 1 asiento, mismo hash; (B) COMMIT perdido → error, 0 asientos, reintento ok |
| Borrado / restore | T9 | PASS | DELETE de asiento intermedio → `no encadena` en el seq siguiente; gate DR rechaza; restore del asiento verifica |
| Backup / restore | T11 | PASS | `pg_dump -Fc` → `pg_restore` en BD nueva del mismo clúster; ledger idéntico; gate DR ok; copia alterada rechazada. No cubre restore entre hosts ni PITR |
| Locks | T13, T14 | PASS | `ejecutarUnaVez`: exclusión mutua con 10 contendientes, llaves de ambos signos, modo no bloqueante; los 4 casos de negocio sobre el esquema v7 |
| Elección de líder | T12 | PASS | 3 nodos con pools y sesiones independientes: 1 líder estable, failover tras caída (heartbeat envejecido). No ejercita el bucle temporizado de `iniciarCluster` |
| Checkpoint firmado y gate DR | T7, T15 | PASS | firma manipulada → rechazo; rotación por `firma_kid`, clave retirada y kid cruzado rechazados |
| Operaciones de negocio exactamente-una-vez | T14 | PASS | asignar/despachar/facturar/cobrar 10→1 con RLS; índice único como verdad final; fallo externo sin estado parcial |
| Migraciones reversibles y arranque concurrente | T16 | PASS | orden inverso; rollbacks con pérdida bloqueados; down→up íntegro; 6 réplicas sobre BD nueva |
| Entradas externas sin sesión (Twilio) | T17 | PASS | firma exigida (403/503 sin efectos); resolvedor SECURITY DEFINER de mínimo privilegio; rechazo libera la carga; reintentos idempotentes |
| API autenticada multiempresa | T18 | PASS | token de otra empresa 403; login y sesión dentro del contexto; bloqueo de fuerza bruta persistente; 40 peticiones concurrentes sin cruce; pool sin contexto residual |
| Workers multiempresa y mensajería interna | T19 | PASS | eventos una vez por suscriptor con 3 réplicas y carrera determinista; reintentos y cola de fallidos; cron una vez por hora; agente solo en el líder y sin cruces |
| Webhook de pagos (Stripe) | T20 | PASS | firma sobre bytes crudos; empresa por cliente; 9 reentregas concurrentes → 1 efecto; desorden y empates; fallo a mitad sin efectos → reintento único |

## Procedimiento de validación

1. Registrar `git rev-parse HEAD`, `git status --short`, versiones de Node/npm/PostgreSQL y SHA-256 del paquete fuente.
2. Instalar dependencias con `npm ci` en un entorno limpio, fuera de `/mnt` si el montaje no soporta symlinks. Requiere `package-lock.json`, que **todavía no existe**: se genera una sola vez con `npm install` en un host con acceso al registro, se revisa y se versiona.
3. Ejecutar `node --check` en todos los JavaScript del backend y los workers.
4. Ejecutar las suites 26 y 39.
5. Ejecutar la integración en PostgreSQL 16 real sobre una **BD desechable**:
   - sin Docker: `tests/integration/run_native_pg16.sh` (ejecuta T1–T7, T8–T13, T14–T16, T17, T18, T19, T20 y la auditoría SQL);
   - con Docker: `docker-compose.postgres.yml`, exportar `CHECKPOINT_PRIVATE_KEY`/`CHECKPOINT_PUBLIC_KEY` (Ed25519) y `PG_BIN`, y luego `npm run test:pg:full`.
6. Ejecutar `python3 -I tests/integration/mutaciones_pg.py`. Toda mutación debe quedar DETECTADA; una que sobrevive invalida la suite para esa propiedad.
7. Validar ledger v6 con los vectores RFC 8785 oficiales, checkpoint Ed25519 con claves separadas y migraciones up/down sobre una BD descartable.
8. Arrancar `server/index.js` con PostgreSQL y variables de entorno de prueba. Exigir `GET /healthz` y `GET /metrics`, y cerrar ordenadamente workers y pool.
9. Guardar comandos, versiones, exit codes, logs y hashes bajo `informes/`. No sobrescribir evidencia histórica: un informe nuevo por ejecución.

## Política de estado

- **PASS:** ejecución real reproducible con evidencia. Si se obtuvo con una herramienta sustituta (p. ej. `pg-compat`), se indica entre paréntesis.
- **FAIL:** ejecución real o análisis verificable que incumple el criterio.
- **BLOCKED:** falta una dependencia, credencial o servicio; indicar exactamente cuál.
- **PARCIAL:** parte del criterio cerrada con evidencia; el resto se enumera.
- **NOT RUN:** no ejecutado.
- **HISTÓRICO:** evidencia incluida previamente, no revalidada en esta sesión.

La etiqueta Enterprise/Production Ready sigue bloqueada hasta completar los gates críticos. Un test unitario, una comprobación de sintaxis o un informe previo no sustituye a las pruebas de integración, seguridad y recuperación.

Informes vigentes: `informes/fase2f_workers_multiempresa_20261123.md` (este estado), `informes/fase2e_api_rls_20261123.md`, `informes/fase2d_e025_webhooks_20261123.md`, `informes/fase2c_e016_e017_e022_20261123.md`, `informes/fase2b_t8_t13_20261123.md`, `informes/fase2_pg_real_t1_t7_20261123.md`, `informes/fase3_ledger_v6_local_20261123.md`. Histórico: `informes/fase2_estado_ejecucion_20261123.md` (anterior a la ejecución en PG real).
