# Fase 3 — Ledger v6.0: validación local

**Fecha:** 2026-11-23  
**Entorno:** Node.js v22.16.0 · npm 10.9.2

## Cambios implementados en esta sesión

- RFC 8785: Unicode no ASCII permanece UTF-8; escapes JSON mínimos; surrogate aislado rechazado; orden de claves UTF-16; `-0` se serializa como `0`; números no finitos rechazados.
- Compatibilidad de lectura para filas heredadas `jcs-v1`; nuevos asientos usan `rfc8785`.
- Ed25519 acepta PEM desde `CHECKPOINT_PRIVATE_KEY` / `CHECKPOINT_PUBLIC_KEY`; HMAC heredado queda explícito y usa `CHECKPOINT_HMAC_SECRET` para verificación sin pasar secreto por argumento.
- `verificarCheckpoint` valida firma, ancla contra la fila del ledger y cadena completa desde GENESIS.
- `verificacionPostRestauracion(db)` valida cadenas y checkpoints por tenant; `server/index.js` ejecuta migraciones versionadas y la verificación antes de abrir HTTP.
- `migrar` y `migrarRevertir` usan una única conexión PostgreSQL para cada transacción (antes podían enviar BEGIN/DDL/COMMIT a conexiones distintas al recibir un Pool).
- Añadidos `migrations/001_ledger_v6.up.sql` y `.down.sql`, documentación de migraciones y `.env.example` sin secretos.
- Corregidos tests que exigían escape ASCII-only, comportamiento contrario a RFC 8785.

## Resultados ejecutados

| Prueba | Resultado |
|---|---:|
| `node --check` para todos los `.js` | PASS · 0 errores |
| `node 26_pruebas_estres_70.js` | PASS · 70/70 |
| `node 39_pruebas_sistema_completo.js` | PASS · 63/63 |

## Límites no superados

- No se ejecutaron vectores oficiales externos RFC 8785; las pruebas locales cubren los casos descritos en la suite.
- No se aplicaron `SQL_ROLES` ni migraciones up/down contra PostgreSQL real.
- No se verificó Ed25519 PEM en una BD real ni restauración de backup real.
- No se pudo instalar `pg`/`embedded-postgres`: DNS del registro npm devolvió `EAI_AGAIN`.

**Veredicto:** IMPLEMENTACIÓN LOCAL PARCIALMENTE VALIDADA. No declarar Fase 3 cerrada ni producción aprobada hasta completar PostgreSQL real.
