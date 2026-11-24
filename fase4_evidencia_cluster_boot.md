# FASE 4 — Cluster + boot (evidencia)

Fecha: 2026-11-23T03:53:50.042Z · PostgreSQL real embebido 18.7 · puerto 55472

## F4.1 — elección de líder exclusiva
primera campaña de A: lider=true · campaña de B con A vivo: lider=false (rechazado correctamente)

## F4.2 — estado del cluster
nodos=2 · líder=nodo-A · segundos_sin_vida(A)=0

## F4.3 — failover tras muerte del líder (tiempo medido)
TTL_LIDER_SEG=15 · campaña de B cada 500ms durante la prueba
tiempo hasta que B fue líder: 15.2s (límite 16.5s)

## F4.4 — regreso del líder viejo sin split-brain
A vuelve a candidatear con B vivo: aceptado=false (debe ser false) · líder actual=nodo-B

## F4.5 — soloLider ejecuta la tarea exactamente una vez en el cluster
ejecuciones totales de fn entre A (no líder) y B (líder): 1

## F4.6 — boot end-to-end del server
boot del server: NO ARRANCÓ en 20s
healthz: no disponible
últimas líneas del proceso: {"ts":"2026-11-23T03:53:49.920Z","nivel":"info","evento":"servidor.iniciando"} | {"ts":"2026-11-23T03:53:49.957Z","nivel":"error","evento":"servidor.caido","error":"Neither apiKey nor config.authenticator provided"} |  | [proceso salió con código 1]

---
Completado en 16.2s