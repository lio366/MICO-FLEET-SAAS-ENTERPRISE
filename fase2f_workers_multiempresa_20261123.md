# Fase 2f: workers multiempresa bajo RLS (E-031) y defectos asociados

**Fecha de ejecución:** 2026-11-23 (19:00–20:00 UTC)
**Commit evaluado:** `e195756` (rama `fase2/pg-real-t1-t7`), árbol limpio
**Evidencia:** `informes/evidencia_fase2f_workers_20261123/` (hashes en `SHA256SUMS`)

## Veredicto

| Gate | Estado |
|---|---|
| T1–T7 · T8–T13 · T14–T16 · T17 · T18 · T19 | PASS 7/7 · 6/6 · 3/3 · 1/1 · 1/1 · 4/4 (pg-compat), 3 de 3 corridas limpias en `e195756` |
| Auditoría SQL ↔ esquema | PASS: 0 errores nuevos, 4 excepciones documentadas |
| Mutaciones de integración | 46/46 detectadas (`mutaciones_pg.py`, exit 0) |
| Suites 26 / 39 | 70/70 · 85/85 |
| `node --check` | 63 archivos, 0 errores |
| Workers multiempresa bajo RLS (E-031) | **PASS (pg-compat)** |
| Motor neural de match (E-036) | **FAIL por análisis**, abierto: el agente falla seguro (no ofrece) |

## Qué estaba roto

E-031 se había registrado como "los workers no ven filas bajo RLS". Al revisarlos aparecieron defectos más graves en los tres workers y en el servicio de notificaciones:

**Bus de eventos (44)**
- **El candado no protegía nada:** `FOR UPDATE SKIP LOCKED` iba en una consulta autocommit y se soltaba al instante. Varias réplicas procesaban los mismos eventos.
- **Nunca se reintentaba:** el evento se marcaba publicado aunque un suscriptor hubiera fallado.
- **Dos suscriptores fallaban siempre:** el del ledger llamaba a `asientos.cargaAceptada` y `asientos.pagoRegistrado`, que no existen (los métodos reales son `registrarCargaAceptada` y `registrarPagoRegistrado`).
- Bajo RLS no veía ningún evento, y los manejadores escribían sin contexto de empresa.

**Cron (`cronWorker`)**
- **Sin "una vez por hora":** la clave de ejecución única se calculaba y no se usaba. Cada tarea corría unas 60 veces en su hora y en cada réplica.
- `reporte_semanal` era un comentario vacío, y la "limpieza mensual" corría en realidad cada lunes.

**Agente de match (`agentWorker` + 29)**
- **Cruzaba empresas:** emparejaba cargas de una empresa con choferes de **cualquier** empresa.
- **El emparejamiento nunca ocurría:** llamaba a `predecirAceptacion` como función del módulo 15, que exporta una clase; y el ciclo de 29 no esperaba la puntuación asíncrona.
- **Podía tumbar el servidor:** el temporizador del SMS de respaldo llamaba a `notificarChofer.checkVisto`, que no existe, dentro de un `setTimeout` asíncrono, y en Node 22 un rechazo no capturado ahí termina el proceso.
- Sin deduplicación, el ciclo de 10 segundos avisaba al mismo chofer unas 18 veces por carga, y lo hacía cada réplica.

**Notificaciones (45)**
- **El historial nunca se guardaba:** `destinatario` era `VARCHAR(20)` y se guardaba `driver:<uuid>` (43 caracteres), así que el INSERT fallaba **siempre, después de enviar**. Con reintentos reales, el chofer habría recibido el mismo SMS hasta 5 veces.
- La etiqueta `driver:<uuid>` quedaba pisada por la columna `id` de la fila: se guardaba el uuid suelto (lo detectó T19).
- Búsqueda del chofer e historial sin contexto de empresa; alertas del sistema contra un `tenant_id NOT NULL`.

## Corrección

- **Migración 006**:
  - outbox con arrendamiento (`reclamado_hasta`), `intentos`, `ultimo_error` y `fallido_en` (cola de fallidos);
  - `cron_ejecuciones` (una ejecución por tarea y hora en todo el clúster);
  - `match_notificaciones` (una notificación por carga y chofer);
  - historial de notificaciones con `VARCHAR(64)`, alertas del sistema sin empresa (el rol runtime puede insertarlas, no leerlas);
  - funciones `SECURITY DEFINER` propiedad de `mf_resolver` que devuelven **solo ids** de empresas con trabajo: eventos pendientes, cargas recientes, morosos, más la limpieza de alertas del sistema.
- **44 v7.3:** reclamación por empresa con `FOR UPDATE SKIP LOCKED` **dentro de una transacción**; cada suscriptor una vez por evento (`consumos_eventos`); reintento con espera creciente; cola de fallidos tras 5 intentos; los manejadores reciben `ctx.db` ligado a la empresa del evento.
- **45:** contexto de empresa en la búsqueda del chofer y en el historial; el historial nunca hace fallar un envío ya hecho; historial por empresa.
- **`cronWorker` v7.3:** una sola ejecución por hora en el clúster; trabajo por empresa; reporte semanal real; limpieza de las empresas y del sistema.
- **`agentWorker` v7.3:**
  - solo en el líder del clúster (47 expone `esLider`);
  - jamás entre empresas;
  - deduplicación en BD;
  - puntuación inyectable: si el motor neural no está disponible, no ofrece nada (falla seguro).
- **29:** espera `hacerMatch` y el temporizador del respaldo nunca deja escapar un rechazo.
- **47:** registra el nodo antes de la primera campaña.
- **`server/index.js`:** arranca el clúster; el bus y el cron corren en todas las réplicas (son seguros) y el agente solo en el líder.

## T19 (PostgreSQL real, rol runtime)

- **T19a:**
  - 30 eventos de 2 empresas procesados por **3 réplicas concurrentes**: cada evento una sola vez, y cada manejador ve solo las filas de su empresa;
  - **carrera determinista:** con los eventos bloqueados por otra réplica a mitad de reclamar, la reclamación los salta al instante.
- **T19b:**
  - un fallo transitorio se reintenta sin repetir el suscriptor que ya funcionó;
  - un fallo permanente se reintenta 5 veces y pasa a la cola de fallidos.
- **T19c:** los suscriptores reales de la plataforma:
  - el despachador pasa la reserva a `EN_CURSO` y seguridad pausa al chofer, solo en su empresa;
  - el auditor escribe los asientos en el ledger;
  - las notificaciones `driver:<uuid>` y al admin quedan registradas, con exactamente 2 envíos;
  - la alerta del sistema se registra y el rol runtime no puede leerla.
- **T19d:**
  - cron: 6 llamadas concurrentes en la misma hora producen 1 ejecución, y el error queda registrado;
  - morosos con 7 días de gracia;
  - limpieza a 90 días (empresas y sistema), verificación del ledger de todas las empresas y reporte semanal;
  - agente: un nodo no líder no busca, no hay cruces entre empresas, sin repetición de avisos, y sin motor neural no hay ofertas;
  - ninguna conexión conserva contexto.

## Calidad de la suite (mutaciones)

Once mutaciones nuevas para E-031. Dos hallazgos durante el proceso:

1. **Nombres de prueba con letra.** El arnés buscaba `FAIL T<n>_` y T19 usa nombres como `T19a_`. Las 11 mutaciones se clasificaron como **error de entorno**, no como detectadas (la regla de seguridad funcionó). Se corrigió la expresión.
2. **Una mutación sobrevivió:** quitar `SKIP LOCKED` del arrendamiento. La carrera entre réplicas casi nunca se producía en T19a. Se añadió el caso determinista descrito arriba, y ahora se detecta.

## Abierto

- **E-036:** el motor neural (15) exige `@tensorflow/tfjs-node` al cargarse y llama a `cargarModeloEntrenado()`, que no existe. Sin motor, el agente no ofrece cargas (falla seguro y lo registra). Rehacer el modelo es trabajo aparte.
- El "SMS de respaldo" del agente queda desactivado hasta que el canal push sepa decir si el chofer vio la oferta (`checkVisto`).
- Las tareas de cron son "como máximo una vez por hora": si una falla a mitad, el error queda registrado y no se reintenta esa hora.
