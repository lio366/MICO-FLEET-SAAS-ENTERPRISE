# FASE 2 — Evidencia de integración PostgreSQL real

Fecha: 2026-11-23T03:45:10.468Z · Motor: PostgreSQL 18.7 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
Regla: ningún resultado declarado sin ejecución real (sin mocks).

## T1 — 100 escritores concurrentes · 10.000 eventos + 500 reenvíos dedup
PostgreSQL: PostgreSQL 18.7 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
100 escritores × 100 eventos = 10000 asientos persistidos (único a pesar de +500 reenvíos con dedupKey)
hashes distintos: 10000 · forks: 0
verificarIntegridad: ok=true · registros=10000
duración: 55.3s (181 asientos/s serializados por candado por tenant)

## T2 — interrupción de COMMIT ×50 (socket TCP destruido en el límite)
50 interrupciones reales de conexión durante COMMIT
asientos persistidos: 50 · gaps de secuencia por rollback: 49 (comportamiento normal de BIGSERIAL, no son asientos perdidos)
verificarIntegridad tras el tormento: ok=true (cada fila encadena de su padre: cero huérfanos, cero pérdidas)

## T3 — detección de manipulación de contenido (UPDATE como superusuario)
trigger deshabilitado deliberadamente para simular atacante con privilegios
verificación ANTES: ok=true · DESPUÉS de alterar total 500→5000: ok=false · motivo="HASH NO COINCIDE: contenido alterado después de firmado" (rotoEn seq 10601)

## T4 — borrado detectado + recuperación desde backup + anclaje checkpoint
checkpoint firmado en seq 10621 (HMAC)
tras DELETE del seq 10602: ok=false · motivo="hash_previo no encadena (alterado, borrado o reordenado)"
restore desde backup_ledger_t4: ok=true · verificarCheckpoint: ok=true · registros=0

## T5 — backup → desastre (DELETE total) → restore → verificación criptográfica
respaldo lógico: 50 asientos + 1 checkpoint → /tmp/pgtest/backup_t5.json (pg_dump no existe en la distribución embebida; COPY/SELECT export es el método real disponible)
desastre: 0 asientos sobreviven · restore: 50 asientos · verificarIntegridad ok=true
checkpoint externo ancla la recuperación: ok=true

## T6 — aislamiento multi-tenant (100 escrituras cruzadas concurrentes)
tenant A: 50 asientos ok=true · tenant B: 50 asientos ok=true
sin filas cruzadas · hashes entre tenants compartidos: 0
duración: 440ms (ambos tenants progresan en paralelo: candados distintos)

## T7 — candado distribuido (46): 10 competidores, ejecución única
intentarCandado (sin espera): exactamente 1 ejecutado=true · 9 rechazados=true

---
**TOTAL: 7/7 escenarios superados en 62.3s**