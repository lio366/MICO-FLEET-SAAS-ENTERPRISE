# Fase 2 — Estado actualizado de PostgreSQL real

Fecha: 2026-11-23

## Causa original

La ejecución anterior no pudo iniciar PostgreSQL: no había `postgres`, `initdb`, `pg_ctl`, `psql` ni Docker/Podman. El paquete Node `pg` tampoco estaba instalado. La instalación remota no se pudo completar por `EAI_AGAIN` al resolver `registry.npmjs.org`.

## Trabajo construido en esta iteración

- `package.json` raíz con dependencias del backend y scripts.
- `docker-compose.postgres.yml` para PostgreSQL 16 con volumen persistente y healthcheck.
- Bootstrap de roles y credenciales separados (`mf_bootstrap`, `mf_login`, `mf_app`, `mf_owner`, `mf_readonly`).
- `infra/postgres/003_app_grants.sql` para grants y RLS en tablas tenant-scoped.
- Separación `MIGRATION_DATABASE_URL` (DDL/migraciones) y `DATABASE_URL` (runtime) en el arranque.
- `scripts/migrate.js` para bootstrap administrativo de una base nueva.
- Suite de integración real `tests/integration/postgres_t1_t7.js`.
- Ajustes del ledger para establecer contexto RLS transaccional por tenant en escrituras, verificación y checkpoints.

## Evidencia ejecutada

| Control | Resultado |
|---|---|
| Sintaxis JavaScript de archivos nuevos/modificados | PASS |
| Suite de estrés local | 70/70 PASS |
| Suite de sistema local | 63/63 PASS |
| PostgreSQL real T1–T7 | NOT RUN — preflight termina en `Cannot find module 'pg'`; no hay motor ni cliente PostgreSQL |
| Instalación de dependencias / package-lock | NOT RUN — DNS npm no disponible |
| Docker Compose config/up | NOT RUN — Docker/Podman ausentes |

## Criterio de aceptación pendiente

No declarar Fase 2 cerrada hasta ejecutar `npm run test:pg:strict` con PostgreSQL 16 real, app login no-superuser y conexión administrativa separada. El reporte generado por esa suite debe mostrar T1 a T7 PASS. La suite no usa SQLite ni mocks.

## Riesgos que no se ocultan

- El middleware HTTP general aún necesita fijar el contexto RLS y mantener la misma conexión/transacción durante todas las consultas de cada request. La prueba T3 valida RLS en una transacción dedicada, no todo el flujo HTTP.
- La resolución de tenant por host ocurre antes de conocer el tenant; `tenants` no se incluye en el barrido RLS genérico. Debe implementarse una función `SECURITY DEFINER` limitada para resolver el tenant por host antes de certificar aislamiento integral.
- No existe `package-lock.json`; debe generarse en un entorno con acceso al registry y conservarse para builds reproducibles.

**Conclusión:** se construyó la infraestructura y el harness que faltaban. La prueba real sigue pendiente por una limitación del entorno de ejecución, no por falta de test diseñado. No hay evidencia para afirmar PostgreSQL 7/7 ni producción lista.
