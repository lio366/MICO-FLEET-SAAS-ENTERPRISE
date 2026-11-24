# DECISIONES ARQUITECTÓNICAS — Micro-Fleet SaaS

Registro vivo de decisiones y su porqué. Toda decisión nueva entra aquí ANTES de implementarse.

## D-001 — Multi-tenant por columna tenant_id + RLS (no BD por cliente)
**Fecha:** nov 2026. **Decisión:** un solo PostgreSQL, aislamiento por RLS (`app.current_tenant`) y policies en 01. **Por qué:** operación de $6/mes; una BD por cliente costaría $6×cliente y multiplicaría backups. **Coste aceptado:** queries SIEMPRE con tenant_id; omitirlo = fuga entre clientes.

## D-002 — Agentes por eventos, no por llamadas directas
**Fecha:** nov 2026. **Decisión:** bus outbox (44) + suscriptores idempotentes. **Por qué:** un fallo en el canal de voz no puede perder una carga a media operación. **Consecuencia:** toda acción que dispara otra acción PUBLICA un evento; nunca llama directo.

## D-003 — Audit ledger encadenado con hash, inmutable por trigger
**Fecha:** nov 2026 (v5.4), endurecido v6.0 (dic 2026). **Decisión:** cadena SHA-256 por tenant, occurred_at persistido, serialización canónica JCS, dedup por fingerprint, checkpoints Ed25519. **Por qué:** la verdad contable debe sobrevivir a concurrencia, reinicios, errores humanos y manipulación. Correcciones = asiento compensatorio, nunca UPDATE/DELETE.

## D-004 — Candados en PostgreSQL, no en Redis
**Fecha:** nov 2026. **Decisión:** advisory locks (64 bits, hashtextextended) y candado distribuido (46) en la misma BD. **Por qué:** una dependencia menos; la BD es ya la fuente de verdad. **Límite:** si la BD se cae, todo se cae — aceptado (un solo VPS, RTO 60 min por 49).

## D-005 — Voz por llamada Twilio (canal HFP del auricular)
**Fecha:** nov 2026. **Decisión:** la oferta entra como llamada (~$0.02), no como push. **Por qué:** el auricular mono solo suena llamadas por Bluetooth; push/TTS se pierden en la cabina. **Coste:** ~$0.60/camión/mes.

## D-006 — Servidor único Hetzner ~$6/mes como diseño, no como límite
**Fecha:** nov 2026. **Decisión:** todo corre en un VPS; 46/47 permiten réplicas cuando haga falta. **Por qué:** 500 camiones caben en 4GB (pruebas de estrés 23). Escalar antes de tiempo es quemar margen.

## D-007 — Preferencia de API externas gratuitas con clave gratuita
**Fecha:** nov 2026. Nominatim/NWS/Open-Meteo/OpenRouteService/EIA/FMCSA — todas gratis; cacheadas en BD para no abusar (Nominatim exige ≤1 req/s).

## D-008 — Idempotencia por dedupKey + fingerprint en TODOS los asientos financieros
**Fecha:** dic 2026 (v6.0). Todo evento que puede reentregarse (bus, webhooks, reintentos) lleva dedupKey; el ledger verifica la IDENTIDAD del contenido, no solo la clave.

## Descartadas (para no re-discutir)
- Redis como bus/candados: dependencia extra, sin necesidad a esta escala.
- Microservicios: complejidad multiplicada por 10; módulos + workers bastan hasta >5.000 camiones.
- Mongo/NoSQL: nada que ganar; Postgres cubre geo (PostGIS), JSONB y transacciones.

## D-009 — Serialización canónica v6.0: RFC 8785 real
- **Contexto:** la orden v6.0 exige JCS real, no "estilo JCS".
- **Decisión:** canonico() implementa RFC 8785 (números ECMAScript, -0→"0", Unicode UTF-8 sin escape no ASCII, escapes JSON mínimos y rechazo de surrogate aislado). SERIALIZATION_VERSION pasa a 'rfc8785'; la verificación usa la versión persistida por fila, así cadenas antiguas 'jcs-v1' siguen verificándose.
- **Alternativa rechazada:** mantener 'jcs-v1' con el mismo algoritmo (mentiría sobre el cumplimiento).

## D-010 — Checkpoints Ed25519 con HMAC dual-mode
- **Contexto:** v6.0 exige Ed25519 fuera de PG sin romper contratos.
- **Decisión:** firmarMensaje/verificarMensaje dual: string→HMAC-SHA256 (comportamiento v5.4 preservado, test CLAVE_BUENA intacto), KeyObject→Ed25519. Columna firma_alg distingue; firma VARCHAR(128).

## D-011 — Snapshot de verificación del ledger: REPEATABLE READ READ ONLY en lugar de LOCK SHARE
- **Fecha:** 2026-11-23.
- **Contexto:** E-014. R4 exige que la verificación de cadena vea un estado consistente.
- **Decisión:** la verificación corre en `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY`. Todas las lecturas comparten snapshot; no se necesitan privilegios de escritura y no se bloquea a los escritores.
- **Alternativas rechazadas:** devolver UPDATE a `mf_app` (rompe el doble candado de inmutabilidad); función SECURITY DEFINER que tome el lock (más superficie y sigue bloqueando escritores).

## D-012 — pg-compat solo como herramienta de validación
- **Fecha:** 2026-11-23.
- **Contexto:** registro npm inaccesible; T1–T7 necesitaba un driver.
- **Decisión:** `tools/pg-compat` (protocolo v3, SCRAM) expuesto como `pg` solo vía NODE_PATH en validación. Nunca entra en `dependencies` ni en `node_modules` del proyecto. Toda evidencia registra la versión del driver.
- **Consecuencia:** el gate de dependencias sigue BLOCKED hasta `npm ci` con `pg` oficial, y T1–T7 se repetirá con él.

## D-013 — Candados de coordinación siempre de transacción
- **Fecha:** 2026-11-23.
- **Contexto:** E-018. Con pools de conexiones, un candado de sesión sobrevive a `release()`.
- **Decisión:** todo advisory lock del sistema (ledger, 46, 47) es `pg_advisory_xact_lock` / `pg_try_advisory_xact_lock` dentro de una transacción explícita. Los candados de sesión quedan prohibidos.
- **Consecuencia:** el liderazgo no lo «posee» una conexión, sino la fila `cluster_nodos.lider` con heartbeat y TTL. El candado solo serializa las campañas.

## D-014 — La suite de integración se valida con mutaciones
- **Fecha:** 2026-11-23.
- **Decisión:** cada protección que una prueba dice cubrir tiene una mutación en `tests/integration/mutaciones_pg.py`. Una mutación que sobrevive bloquea el gate. Una ejecución que falla sin prueba fallida es un error de entorno y no cuenta como detección.
- **Motivo:** la primera suite aprobaba con la verificación de hash anulada y con un defecto que solo se manifestaba el 50 % de las veces.

## D-015 — bookings es la fuente de verdad de la asignación
- **Fecha:** 2026-11-23. Aprobada por el propietario del proyecto.
- **Decisión:** la asignación chofer↔carga vive en `bookings` (ciclo `OFFERED → CONFIRMED/REJECTED → DISPATCHED → PICKED_UP/EN_CURSO → DELIVERED → INVOICED → PAID`, más `CANCELLED`). `loads.status` solo indica disponibilidad. Una sola reserva activa por carga (`uq_bookings_carga_activa`). Facturas en tabla propia `invoices`.
- **Alternativa rechazada:** `loads.driver_id` (una carga, un chofer) — impide conservar el historial de ofertas rechazadas y duplicaría el estado.

## D-016 — Llavero de claves de checkpoint solo desde el entorno
- **Fecha:** 2026-11-23.
- **Decisión:** las claves públicas de confianza vienen de `CHECKPOINT_PUBLIC_KEYS` / `CHECKPOINT_PUBLIC_KEY`, nunca de la BD. `firma_kid` en la BD es solo un selector. Rotación: añadir la clave nueva como vigente y mantener la antigua en `CHECKPOINT_PUBLIC_KEYS` mientras existan checkpoints firmados con ella.
- **Motivo:** quien controla la BD no debe poder introducir una clave «de confianza».

## D-017 — Una sola secuencia de esquema, serializada y con rollbacks que fallan cerrado
- **Fecha:** 2026-11-23.
- **Decisión:** `db/esquema.js` es la única forma de aplicar el esquema (bootstrap y servidor); cada fase y cada migración corre bajo el mismo candado de transacción. Un `down` que perdería datos se niega por defecto.

## D-018 — Resolución de tenant para entradas sin sesión
- **Fecha:** 2026-11-23.
- **Decisión:** las entradas externas sin sesión (webhooks) resuelven la empresa con funciones `SECURITY DEFINER` propiedad de `mf_resolver` (NOLOGIN, **sin** BYPASSRLS), que solo devuelven identificadores. El acceso de lectura se concede por política explícita y por columnas. El resto del procesamiento corre con `app.current_tenant` fijado.
- **Alternativas rechazadas:** funciones propiedad de un superusuario (privilegio excesivo); desactivar RLS en `drivers`/`bookings` (rompe el aislamiento); usar credenciales administrativas en el webhook.

## D-019 — Todo webhook verifica la firma del proveedor antes de tocar la BD
- **Fecha:** 2026-11-23.
- **Decisión:** Stripe (sobre el cuerpo crudo) y Twilio (sobre la URL pública configurada + parámetros). Si falta configuración, el webhook falla cerrado (503); nunca acepta sin verificar.

## D-020 — Contexto de tenant por petición mediante req.enTenant
- **Fecha:** 2026-11-23.
- **Decisión:** las rutas no reciben un cliente "fijado" para toda la petición; cada acceso a datos se envuelve en `req.enTenant(fn)` (transacción con contexto local). Se confirma antes de responder y la conexión vuelve limpia al pool.
- **Alternativa rechazada:** transacción abierta durante toda la petición con COMMIT en `res.on('finish')` (el cliente podría recibir 200 de una escritura que luego no confirma).

## D-021 — Auditoría SQL como gate con excepciones explícitas
- **Fecha:** 2026-11-23.
- **Decisión:** todo SQL literal pasado a `.query()` debe analizar contra el esquema real (PREPARE). Las excepciones viven en `auditoria_sql_excepciones.json` con su defecto; el gate falla también si una excepción deja de corresponder a un hallazgo.

## D-022 — Proveedores criptográficos inyectables en 41
- **Fecha:** 2026-11-23.
- **Decisión:** `bcryptjs` y `jsonwebtoken` se cargan al usarse y pueden sustituirse con `configurarProveedores()` (solo pruebas o entornos sin esas dependencias). En producción se usan las librerías; el algoritmo JWT queda fijado a HS256 al verificar.

## D-023 — Workers: descubrir por ids, trabajar por empresa
- **Fecha:** 2026-11-23.
- **Decisión:** los workers descubren qué empresas tienen trabajo con funciones `SECURITY DEFINER` de `mf_resolver` que devuelven solo identificadores, y hacen el trabajo empresa por empresa con contexto local. No existe un rol de mantenimiento con BYPASSRLS.
- **Alternativa rechazada:** rol de mantenimiento que salta RLS (un fallo en un worker expondría o modificaría datos de todas las empresas).

## D-024 — Garantías de entrega de los workers
- **Bus:** al menos una vez por evento; exactamente una vez por suscriptor gracias a `consumos_eventos` (el suscriptor debe tolerar un reintento si falla tras su efecto y antes del registro). Cola de fallidos tras 5 intentos.
- **Cron:** como máximo una vez por tarea y hora en el clúster.
- **Agente:** como máximo un aviso por (carga, chofer); solo el líder.

## D-025 — Webhook de Stripe: verificación propia, empresa por cliente, orden por event.created
- **Fecha:** 2026-11-23.
- **Decisión:** la firma se verifica con `server/api/stripe_firma.js` (esquema v1 documentado: HMAC-SHA256 de `t.cuerpo`, tolerancia 300 s) en lugar de `stripe.webhooks.constructEvent`, para no depender del SDK en la ruta de cobro y poder probarla sin red. La empresa de un evento se decide únicamente por `tenants.stripe_customer_id`; `metadata` no se consulta. El estado de una suscripción lo fija el evento con mayor `event.created` (empate: gana la cancelación) y el periodo pagado solo avanza, de modo que el resultado no depende del orden de llegada. Cada `event.id` se registra en la misma transacción que su efecto y su asiento del ledger.
- **Alternativas rechazadas:** consultar a la API de Stripe el estado actual en cada evento (añade red y fallos a la ruta crítica; queda como conciliación periódica futura); confiar en `metadata.tenant_id` (dato del cuerpo, ausente en facturas de suscripción); registrar el evento en una transacción previa al efecto (deja eventos "procesados" sin efecto si el proceso cae).
- **Límite conocido:** dos eventos con el mismo segundo y estados no terminales distintos conservan el primero aplicado.
