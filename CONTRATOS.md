# CONTRATOS PÚBLICOS — Micro Fleet SaaS Enterprise v5.4

Registro de interfaces públicas por módulo. **Regla:** ninguna refactorización (incluida v6.0 del ledger) puede romper estos contratos sin análisis de dependencias previo y entrada en DECISIONES.md.

## 42_audit_ledger.js (crítico — no romper)

| Contrato | Firma | Notas |
|---|---|---|
| `SQL` | string | DDL completo: `audit_ledger` + `audit_checkpoints` + trigger inmutabilidad + índices UNIQUE anti-fork y dedup parcial |
| `SERIALIZATION_VERSION` | string | versión de serialización canónica (`rfc8785` para nuevos asientos; `jcs-v1` legacy para lectura) |
| `canonico(obj)` | → string | serialización determinista ordenada por claves |
| `sha256(str)` | → string hex | hash SHA-256 |
| `registrar(db, {tenantId, actor, accion, entidad, entidadId, antes, despues, motivo, requestId, dedupKey})` | → asiento | **Posiciones de parámetros del INSERT fijadas por tests G9:** [9]=dedupKey, [10]=fingerprint, [11]=occurredAt, [12]=serialization, [13]=hashPrevio, [14]=hash. No reordenar sin actualizar tests. |
| `verificarIntegridad(db, tenantId, desdeSeq)` | → {ok, eventos, primeroRoto} | recomputa hashes, detecta forks y huecos |
| `crearCheckpoint(...)` / `verificarCheckpoint(...)` / `verificacionPostRestauracion(db)` | | HMAC legado explícito y Ed25519 mediante PEM/KeyObject; verificación de ancla y cadena completa. Test existente usa 'CLAVE_MALA'/'CLAVE_BUENA' (HMAC) — debe seguir pasando sin modificación. |
| `eventos(db)` | factory | expone `registrarCargaAceptada`, `registrarPrecioNegociado`, `registrarPagoRegistrado`, `registrarVeredictoBloqueo` (usado por el bus en 44) |

## Módulos de plataforma

| Archivo | Exports | Contrato clave |
|---|---|---|
| 02_tenant_middleware.js | `TenantMiddleware` | inyección de `tenant_id`, RLS, candado advisory por tenant |
| 03_billing_stripe.js | `BillingService` | suscripciones por tenant vía Stripe |
| 40_api_gateway.js | `crearGateway({...})` | fábrica; monta rutas invocando `crearRutas({db})` y `crearWebhooks({db, stripe})` |
| 41_auth_rbac.js | `SQL, PERMISOS, login, requireAuth, requirePermiso, logout, cambiarPassword` | incluye tabla `login_intentos` (anti fuerza bruta) |
| 43_metrics_observability.js | `contador, gauge, histograma, middlewareMetricas, endpointMetrics, endpointHealth, log, revisarAlertas` | métricas en memoria + endpoint `/metrics` |
| 44_event_bus.js | `SQL, publicar, suscribir, procesarPendientes, registrarSuscripciones` | outbox pattern; consumidores idempotentes |
| 45_notification_service.js | `SQL, PLANTILLAS, crearServicioNotificaciones` | fallback canal→SMS |
| 46_distributed_lock.js | `obtenerCandado, intentarCandado, ejecutarUnaVez` | candados PostgreSQL (`pg_try_advisory_lock`) |
| 47_scheduler_cluster.js | `SQL, campañaLiderazgo, soloLider, iniciarCluster, estadoCluster, TTL_LIDER_SEG` | un solo líder de cron en el cluster |
| 48_deploy_stack.js | `COMPOSE, CADDYFILE, ENV_EJEMPLO, DOCKERFILE, DEPLOY_SH, BACKUP_SH, generar` | genera artefactos de despliegue |
| 49_disaster_recovery.js | `MONITOREO_EXTERNO, RUNBOOK_A..C, PRUEBAS_HUMO, verificarBackupDiario` | runbooks + verificación de respaldos |

## server/

| Archivo | Contrato |
|---|---|
| server/index.js | orquesta boot: DB → migraciones implícitas (SQL de módulos) → `bus.registrarSuscripciones({db,...})` → voz (`configurar`) → HTTP |
| server/api/routes.js | `crearRutas({db})` — fábrica |
| server/api/webhooks.js | `crearWebhooks({db, stripe})` — fábrica |
| server/workers/eventWorker.js | consume outbox |
| server/workers/agentWorker.js | usa `created_at` (no `publicada_en`) |
| server/workers/cronWorker.js | cron vía 47 |
| server/services/twilio_client.js, fmcsa_client.js | adaptadores con fallback/mock |

## Regla de cambio de contrato

1. Buscar usos (`grep`) en todos los módulos + tests.
2. Anotar decisión en DECISIONES.md con justificación.
3. Actualizar este documento en el mismo commit.
