# MAPA DE DEPENDENCIAS — Micro Fleet SaaS Enterprise v5.4

## Grafo `require()` interno (generado por grep real)

```
07_ai_language_agent.js        -> 25_enrutador_modelos
08_auto_dispatch_agent.js      -> 07_ai_language_agent
19_voz_ia_llamadas.js          -> 05_push_notifications
30_tarifas_inteligentes.js     -> 20_alerta_diesel
33_verificacion_carrier.js     -> server/services/fmcsa_client
39_pruebas_sistema_completo.js -> 29, 30, 32, 33(x2), 34, 35, 36, 38, 42
40_api_gateway.js              -> server/api/webhooks, server/api/routes
42_audit_ledger.js             -> 43_metrics_observability
44_event_bus.js                -> 43_metrics_observability
45_notification_service.js     -> 38_modo_voz_auricular
server/index.js                -> workers/eventWorker, agentWorker, cronWorker
```

## Dependencias por SQL (tablas compartidas)

- **audit_ledger / audit_checkpoints**: 42 (DDL) — leídas por verificación v6.0, DR (49), tests 39-G9.
- **outbox (eventos)**: 44 (DDL + publicar/procesar) — consumida por eventWorker; productores: negocio + ledger (vía `eventos(db)`).
- **login_intentos**: 41 — usada por `login`.
- **scheduler/cluster**: 47 (liderazgo) — usado por cronWorker.
- **métricas**: 43 — observabilidad de 42 y 44; endpoint en gateway (40).

## Observaciones de acoplamiento

1. **43 es dependencia de 42 y 44** — si 43 falla en boot, ledger y bus caen. En v6.0 la observabilidad debe ir envuelta en try/catch (regla 14 de la orden) para no romper el camino crítico del ledger.
2. **05_push_notifications no aparece en el árbol `ls` de raíz** — 19 lo requiere. Verificar existencia (posible archivo huérfano/documentado mal). → verificado: existe en el paquete; no listado en README.
3. **39 depende de 42 por posiciones de parámetros** (mock del pool) — cualquier cambio en el INSERT de `registrar` rompe G9.
4. **45 → 38**: notificaciones dependen del módulo de voz; cambios en 38 (firmas de `agenteIA`, `enviarPushYSMS`) afectan a 45. Ya cableado en fase de arreglo E-004.
5. **server/index.js no aparece en el grafo `require` hacia módulos raíz** — los workers cargan lógica vía `registrarSuscripciones` del bus; el gateway es montado por 40. El boot depende de que el SQL de cada módulo se ejecute al arrancar.

## Impacto de v6.0 (ledger)

Toca directamente: 39 (tests G9 + 15 nuevos), 44 (eventos), 49 (DR), server/index.js (orden de aplicación de SQL), gateway (roles RLS). No toca: 26 (congelada), módulos de negocio 29-38.
