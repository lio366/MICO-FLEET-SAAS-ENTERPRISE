# REGISTRO DE ERRORES Y CORRECCIONES

Formato: ID · fecha · síntoma · causa raíz · corrección · prevención.

## E-001 · nov 2026 · `require('embedded-postgres')` no es constructor
**Síntoma:** `TypeError: EmbeddedPostgres is not a constructor`. **Causa:** paquete beta transpilado ESM→CJS; el constructor está en `.default`. **Corrección:** `require('embedded-postgres').default`. **Prevención:** al usar un paquete nuevo, imprimir `Object.keys(require(...))` antes de asumir la forma del export. Verificado con `npm list` + diagnóstico de exports.

## E-002 · nov 2026 · Carrera A/B en audit ledger (fork de cadena)
**Síntoma:** dos procesos leen la misma cabeza y escriben dos hijos del mismo padre. **Causa:** leer-el-último-hash + INSERT sin exclusión. **Corrección:** candado advisory transaccional + índice único anti-fork + backoff. **Prevención:** ningún "leer-último-escribir" sin candado o restricción única.

## E-003 · nov 2026 · Ledger no verificable criptográficamente (D1-D4)
**Síntoma:** el timestamp del hash no se persistía; JSON no canónico; dedup sin identidad; candado de 32 bits. **Corrección:** v6.0 (occurred_at, JCS, fingerprint, hashtextextended, Ed25519). **Prevención:** toda cadena hash debe ser RECOMPUTABLE desde lo persistido — probarlo en test.

## E-004 · nov 2026 · 7 bugs de cableado en el backend (38-45, server/)
**Síntoma:** gateway montaba factories sin invocarlas; bus llamaba funciones inexistentes; notificaciones leían destinatario undefined; auth sin tablas; voz con ganchos vacíos; worker con columna inexistente; services solo README. **Causa:** módulos escritos por separado sin arranque end-to-end. **Corrección:** auditoría archivo-por-archivo + inyección de dependencias + adaptadores críticos. **Prevención:** Fase 4 del plan (arranque real) como paso obligatorio antes de declarar "operable"; regla VERIFY.md.

## E-005 · nov 2026 · npm install falla en /mnt (symlinks)
**Síntoma:** módulos corruptos (`Cannot find module 'qs'/'read'`). **Causa:** el montaje /mnt no soporta symlinks; npm los necesita. **Corrección:** demo con Node puro sin deps; pruebas con node_modules en /tmp. **Prevención:** nunca `npm install` dentro de /mnt; deps solo en entorno de prueba /tmp.

## E-006 · nov 2026 · Riesgo de pérdida de contexto entre sesiones
**Síntoma:** archivos 46-49 existían sin que la sesión actual tuviera registro de haberlos creado. **Corrección:** docs/ (este registro + DECISIONES + CONTRATOS) versionados en git. **Prevención:** toda sesión nueva lee docs/ + `git log` antes de modificar.

## Plantilla para nuevas entradas
```
## E-NNN · fecha · título
**Síntoma:** … **Causa raíz:** … **Corrección:** … **Prevención:** …
```

## E-007 — CHAR(64) rellenaba con espacios y rompía la verificación de la cadena
- **Detectado en:** validación v6.0 contra PostgreSQL real (nunca apareció con mocks — los mocks devuelven strings limpios).
- **Síntoma:** `verificarIntegridad` devolvía "hash_previo no encadena" en la fila 1 con cadena intacta.
- **Causa raíz:** PostgreSQL rellena `CHAR(n)` con espacios hasta la longitud fija; `'GENESIS'` llegaba como `'GENESIS'+59 espacios` y `r.hash_previo !== 'GENESIS'` fallaba. También afectaba la comparación de `event_fingerprint` y el mensaje firmado del checkpoint.
- **Corrección:** DDL v6.0 usa `VARCHAR(64)`; migración 001 incluye `ALTER COLUMN ... TYPE VARCHAR(64)` (el cast de CHAR→VARCHAR elimina el relleno en PG) con down reversible.
- **Lección:** tipos de longitud fija y comparación de strings criptográficos son enemigos. Todo hash en BD: VARCHAR, nunca CHAR.

## E-008 — El harness del archivo 39 nunca ejecutaba las pruebas async (✔ teatral)
- **Detectado en:** prueba de mutación durante v6.0 (una mutación de crypto.verify seguía dando 60/60).
- **Causa raíz:** `prueba()` invocaba `fn()` sin `await` y la impresión de ✔ era inmediata; las aserciones async jamás se evaluaban y los rejects quedaban huérfanos (process.exit los enterraba).
- **Corrección:** las pruebas se encolan y un ejecutor async final las corre secuencialmente con `await` antes del veredicto.
- **Consecuencia honesta:** al ejecutarse de verdad, 6 pruebas fallaron (57→60 tras reparos). Los fallos eran reales y quedaron documentados (E-009, E-010).

## E-009 — 38_modo_voz_auricular: avisarBroker inexistente + regex de rechazo demasiado ancha
- **Síntoma:** `avisarBroker is not defined` al aceptar por voz; "no sé qué dijiste" (ambiguo) se trataba como rechazo porque /no/ coincidía con "no sé".
- **Corrección:** avisarBroker ahora es gancho inyectable vía configurar() y opcional (guard); patrones con \b(uno|acepto|sí)\b y \b(dos|rechazo|rechaza|no quiero|no acepto)\b.

## E-010 — Mocks G9 rotos desde su creación (nunca ejecutados por E-008)
- Prefijo `SELECT hash FROM...` no coincidía con el SQL real `SELECT hash, event_fingerprint FROM...`; contadores que no medían lo que decía el nombre. Reparados para ejercer el escenario declarado (la intención del test se mantiene y ahora sí se verifica).

## E-011 — 46_distributed_lock: Buffer.readBigInt64 no existe en este entorno + llave advisory mal tipada
- **Detectado en:** T7 de la suite de integración con PG real (los tests previos eran solo de sintaxis).
- **Causa raíz:** dependencia de `Buffer.readBigInt64` (ausente en el Buffer del sandbox) y envío del bigint como número JS (pérdida de precisión > 2^53).
- **Corrección:** llave64() = primeros 8 bytes del SHA-256 como decimal string con cast explícito `$1::bigint`. **Rectificado en E-019:** la afirmación original («cubre el rango completo de 64 bits con signo») era falsa; el valor era sin signo y la mitad de las claves quedaba fuera de rango.
- **Nota de test:** con fn instantánea, 10 competidores pueden ganar en secuencia (el lock se libera al COMMIT); la exclusión se prueba con trabajo real dentro del lock.


## E-012 — Serializador etiquetado RFC 8785 escapaba Unicode no ASCII
- **Síntoma:** el serializador producía `\u00e9` para `é` y pares `\uXXXX` para emoji.
- **Causa raíz:** se confundía escape JSON válido con representación ASCII-only. RFC 8785 conserva Unicode válido en UTF-8 y solo aplica escapes JSON necesarios.
- **Corrección:** usar escape ECMAScript compatible para strings, rechazar surrogate aislado, mantener orden de claves UTF-16 y preservar un serializador legacy solo para filas etiquetadas `jcs-v1`.
- **Prevención:** incluir vectores Unicode no ASCII, emoji, surrogate inválido y orden UTF-16 en la regresión; verificar vectores RFC 8785 externos antes de declarar conformidad completa.

## E-013 — SQL_ROLES del ledger referenciaba una secuencia inexistente
- **Detectado en:** T1 contra PostgreSQL 16.15 real (2026-11-23).
- **Síntoma:** `relation "audit_ledger_seq" does not exist`.
- **Causa raíz:** `seq BIGSERIAL` crea `audit_ledger_seq_seq`. El SQL se había escrito sin ejecutarse nunca contra un motor real.
- **Corrección:** la propiedad de la secuencia sigue a `ALTER TABLE ... OWNER`; el GRANT se resuelve con `pg_get_serial_sequence('public.audit_ledger','seq')`.

## E-014 — verificarIntegridad imposible para el rol de runtime (LOCK SHARE MODE)
- **Detectado en:** T4 contra PostgreSQL real.
- **Síntoma:** `permission denied for table audit_ledger` en `LOCK TABLE audit_ledger IN SHARE MODE`.
- **Causa raíz:** PostgreSQL exige UPDATE/DELETE/TRUNCATE para los modos de lock superiores a ROW EXCLUSIVE. `mf_app` tiene esos privilegios revocados por diseño (inmutabilidad), así que la verificación y el gate DR fallaban siempre con el rol de aplicación.
- **Agravante:** el test unitario G10 exigía el LOCK; el mock certificaba el defecto.
- **Corrección:** `BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY` (D-011). G10 ahora exige el snapshot y prohíbe LOCK TABLE.

## E-015 — 002_set_password.sh no asignaba la contraseña de mf_login
- **Síntoma:** `syntax error at or near ":"`; el init de Docker abortaba.
- **Causa raíz:** psql no interpola variables (`:'app_password'`) en `--command`.
- **Corrección:** el SQL llega por stdin con heredoc entre comillas; `MF_APP_PASSWORD` es obligatorio.

## E-016 — CERRADO (a988ddf): checkpoints sin rotación de clave bloquean el gate DR
- **Detectado en:** segunda ejecución de T1–T7 sobre la misma BD.
- **Síntoma:** `DR_CHECKPOINT_INVALIDO ... FIRMA INVÁLIDA` para un checkpoint legítimo firmado con una clave anterior.
- **Causa raíz:** `verificacionPostRestauracion` verifica todos los checkpoints con una única `CHECKPOINT_PUBLIC_KEY`; la tabla no registra qué clave firmó cada checkpoint.
- **Impacto:** rotar la clave Ed25519 impide arrancar tras una restauración.
- **Mitigación en tests:** la suite exige una BD desechable y aborta con `PRECONDICION_BD_NO_DESECHABLE`.
- **Corrección:** migración `003_ledger_checkpoint_kid` (`firma_kid` = SHA-256 de la clave pública en SPKI) y llavero de confianza desde `CHECKPOINT_PUBLIC_KEYS` + `CHECKPOINT_PUBLIC_KEY`. Clave retirada → `CLAVE DESCONOCIDA`; kid cruzado → `FIRMA INVÁLIDA`; llavero vacío → falla cerrado. T15, G12, mutaciones `kid_no_persistido` y `kid_ignorado_al_verificar`.

## E-017 — CERRADO (736690f): el bootstrap depende de librerías de runtime
- **Síntoma:** `npm run db:bootstrap` → `Cannot find module 'jsonwebtoken'`.
- **Causa raíz:** `scripts/migrate.js` importa `02`, `03`, `41`, `44` y `45` solo para leer su constante `SQL`, y esos módulos cargan jsonwebtoken, stripe, etc. al importarse.
- **Corrección:** DDL en `sql/*.sql` (idéntico carácter a carácter), `db/migrador.js` y `db/esquema.js` como secuencia única para el bootstrap y el servidor. `scripts/migrate.js` solo necesita el driver `pg`.

## E-018 — Elección de líder: candado de sesión retenido por conexiones del pool
- **Detectado en:** T12 contra PostgreSQL real (timeout de la ronda 1); causa confirmada en `pg_locks`.
- **Síntoma:** el primer nodo se proclama líder; los demás quedan esperando `pg_advisory_lock(727272)` indefinidamente.
- **Causa raíz:** `pg_advisory_lock` es de sesión. Con un Pool, `client.release()` devuelve la conexión abierta y el candado queda en una sesión inactiva. El comentario «se suelta al cerrar la conexión» era falso con pool.
- **Impacto:** sin failover; cada ciclo de 5 s de los nodos no líderes atasca otra conexión de su pool hasta agotarlo.
- **Corrección:** `BEGIN` + `pg_advisory_xact_lock` + `COMMIT/ROLLBACK`. Un nodo sin fila en `cluster_nodos` no puede declararse líder (antes devolvía `true` sin fila).
- **Prevención:** G11 (unitaria) prohíbe `pg_advisory_lock(` en la campaña; T12 y la mutación `lider_candado_sesion`.

## E-019 — llave64 generaba claves sin signo fuera del rango bigint
- **Detectado en:** T13 (`value "9740006678498246168" is out of range for type bigint`).
- **Causa raíz:** `BigInt('0x' + 16 hex)` produce 0..2^64−1; PostgreSQL `bigint` es −2^63..2^63−1.
- **Impacto:** cualquier operación protegida por `ejecutarUnaVez` fallaba en ~50 % de las claves.
- **Corrección:** `BigInt.asIntN(64, …)`. Rectifica la nota de E-011.
- **Prevención:** G11 sobre 2000 claves (rango y distribución de signo); T13 con claves deterministas de ambos signos; mutación `llave64_sin_signo`.

## E-020 — El bootstrap no creaba cluster_nodos
- **Causa raíz:** `scripts/migrate.js` no incluía `47_scheduler_cluster.SQL`.
- **Corrección:** añadido a la lista de módulos, antes de `003_app_grants.sql`, para que el runtime reciba privilegios.

## E-021 — 003_app_grants.sql dependía del orden para no dar UPDATE sobre el ledger
- **Causa raíz:** `GRANT ... UPDATE, DELETE ON ALL TABLES` incluía `audit_ledger` y `audit_checkpoints`; solo el `REVOKE` posterior de `SQL_ROLES` lo deshacía.
- **Corrección:** el bucle de grants excluye las tablas de auditoría y `schema_migrations`, y revoca de forma explícita. Reejecutar el script ya no abre el ledger.

## E-022 — CERRADO (c16863c/a988ddf): casos de negocio de 46_distributed_lock sobre esquema inexistente
- **Detectado en:** análisis previo a T13 (búsqueda de columnas en todo el SQL del repositorio).
- **Síntoma esperado:** `column "driver_id" of relation "loads" does not exist` (y equivalentes) en cuanto se invoquen.
- **Causa raíz:** los cuatro casos usan `loads.driver_id`, `loads.assigned_at`, `bookings.paid_amount`, `bookings.dispatched_at`, `invoices` e `invoice_seq`, que no existen. Tampoco fijan `app.current_tenant`, así que bajo RLS con el rol runtime actualizarían 0 filas.
- **Corrección:** migración `002_operaciones_v7` (D-015), `ejecutarUnaVez(..., { tenantId })`, los cuatro casos reescritos y `server/api/routes.js` usando `asignarCargaUnaVez`. T14 y 5 mutaciones.
- **Alcance ampliado:** `server/api/routes.js` también escribía `loads.driver_id`/`assigned_at` inexistentes; corregido en el mismo cambio.

## E-023 — Arranques concurrentes sobre BD vacía aplicaban el esquema base a la vez
- **Detectado en:** prueba manual con 4 réplicas de `scripts/migrate.js` sobre una BD nueva tras E-017: 3 de 4 fallaron con `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` (log no conservado).
- **Causa raíz:** la comprobación «¿existe tenants?» y la creación se hacían fuera de cualquier candado.
- **Corrección:** cada fase de `db/esquema.js` toma el candado de migraciones (`pg_advisory_xact_lock(1835627, 1)`) y decide dentro de él.
- **Prevención:** T16 con 6 réplicas (esquema base 1 vez; cada migración 1 vez); mutación `esquema_sin_candado`.

## E-024 — Rollbacks que corrompían o destruían datos en silencio
- **Detectado en:** análisis al diseñar T16.
- **Síntoma:** `001 down` eliminaba `firma_alg`, y `001 up` lo recreaba con valor por defecto `'hmac-sha256'`: tras un ida y vuelta, todos los checkpoints Ed25519 quedaban etiquetados como HMAC y el gate DR fallaba. `002 down` eliminaba `invoices` sin aviso.
- **Corrección:** `001 down` aborta con `ROLLBACK_BLOQUEADO` si hay checkpoints no HMAC; `002 down` aborta si hay facturas, salvo con `SET LOCAL micro_fleet.permitir_rollback_destructivo = 'on'`.
- **Prevención:** T16 (bloqueos sobre BD poblada sin alterar datos) y mutación `rollback_001_sin_guardia`.

## E-025 — CERRADO (b86a250): webhook de SMS sin contexto de tenant y carga bloqueada tras rechazo
- **Detectado en:** revisión de consumidores de `bookings` durante E-022.
- **Síntoma esperado:** bajo RLS con el rol runtime, `17_sms_emergencia` no encuentra al chofer ni su oferta (consulta antes de conocer el tenant). Al rechazar una oferta, la reserva pasa a `REJECTED` pero la carga queda en `OFFERED` y no se puede reasignar.
- **Alcance real (hallado al corregir):** los webhooks de SMS y voz eran inoperantes: `procesarRespuesta` no existía en 17, a 38 se le pasaba un Pool en lugar de un adaptador y el gateway no tenía parser `urlencoded`.
- **Corrección:** migración 004 (rol `mf_resolver` NOLOGIN sin BYPASSRLS, funciones SECURITY DEFINER que solo devuelven ids, políticas de solo lectura), `46.responderOfertaUnaVez` (el rechazo libera la carga), `server/services/ofertas.js`, 17 v7.1, adaptador de voz y guardas en 38. T17, G13 y 5 mutaciones.

## E-026 — Webhooks de Twilio sin verificación de firma
- **Detectado en:** revisión de `server/api/webhooks.js` durante E-025.
- **Impacto:** cualquiera que conociera el teléfono de un chofer (o el id de una reserva) podía aceptar o rechazar cargas con un POST falsificado.
- **Corrección:** `server/api/twilio_firma.js` (algoritmo documentado por Twilio; reproduce el ejemplo oficial). La URL viene de `TWILIO_WEBHOOK_BASE_URL`, no de cabeceras controlables. Sin configuración → 503; firma inválida → 403; ambos antes de tocar la BD.
- **Prevención:** G13 (vector oficial y alteraciones), T17 (403/503 sin efectos), mutación `firma_twilio_no_verificada`.

## E-027 — Firma de Stripe verificada sobre JSON re-serializado
- **Detectado en:** revisión de `server/api/webhooks.js` durante E-025.
- **Causa raíz:** `req.rawBody` nunca se asignaba; `constructEvent` recibía `JSON.stringify(req.body)`, que no reproduce los bytes firmados por Stripe.
- **Impacto:** todos los webhooks legítimos de Stripe se habrían rechazado con 400 (pagos, fallos y cancelaciones no procesados).
- **Corrección:** `express.json`/`express.urlencoded` con `verify` que guarda `req.rawBody`; el webhook rechaza si falta el cuerpo crudo.
- **Estado:** la verificación sobre los bytes crudos está **probada** (T20a, incluido un cuerpo re-serializado que se rechaza) con el verificador propio `server/api/stripe_firma.js` (E-040). Sigue **NOT RUN** el parser `express.json` con `verify` que rellena `req.rawBody` (requiere `express` instalado).

## E-028 — La API autenticada no podía arrancar ni aislar empresas
- **Detectado en:** revisión del camino `/api` y T18.
- **Defectos:** (1) se pasaba la clase `TenantMiddleware`, no una instancia: `app.use(undefined)` impedía arrancar; exigía Redis. (2) `users`/`sesiones` bajo RLS se consultaban sin contexto: login y sesión imposibles. (3) **`requireAuth` no comparaba el tenant del token con el del Host: un token válido de la empresa A abría la API de la empresa B.** (4) `set_config(..., false)` en el pool (fuga de contexto). (5) Intentos fallidos registrados junto al login fallido. (6) Rutas con columnas/tablas inexistentes; `33` con `$3` sin tipar (fallaba siempre); `GET /loads` sin permiso.
- **Corrección:** `server/http/contexto_tenant.js` (`req.enTenant`, contexto local por transacción), `02` y `41` v7.2, rutas reescritas, outbox atómico con la asignación, migración 005.
- **Prevención:** T18, G14 y 6 mutaciones (`token_de_otra_empresa_aceptado`, `contexto_de_sesion_en_pool`, `intentos_fallidos_no_registrados`, `limite_plan_fuera_de_contexto`, `ruta_consulta_sin_contexto`, `sesion_revocada_aceptada`).

## E-029 — Código SQL escrito contra un esquema inexistente
- **Detectado en:** `tests/integration/auditoria_sql.js` (PREPARE de cada SQL literal contra el esquema real).
- **Alcance inicial:** 26 errores en 11 archivos (16 tablas y 10 columnas inexistentes) y 2 parámetros sin tipo. Causa principal: DDL de módulos (30, 32, 33, 34, 35) que ninguna secuencia aplicaba, y columnas imaginadas.
- **Corrección:** DDL de 30, 32, 33 y 35 a `sql/` y a la secuencia; migración 005; correcciones en 33, 36, rutas y cronWorker.
- **Prevención:** la auditoría es un gate del runner con excepciones documentadas (`auditoria_sql_excepciones.json`); falla ante un hallazgo nuevo o una excepción obsoleta. Mutación `columna_inexistente_en_modulo_sin_pruebas`.

## E-030 — DDL duplicado de subscriptions con columnas divergentes
- **Causa raíz:** `01` y `03` definen `subscriptions` (y `payments`) con columnas distintas; `CREATE TABLE IF NOT EXISTS` hace que la segunda definición nunca se aplique (`estado`, `grace_termina`, `stripe_subscription_id` no existen).
- **Corrección:** `cronWorker` usa las columnas reales y la regla documentada (7 días tras `current_period_end` → `tenants.status = 'SUSPENDED'`); formato de notificación corregido.
- **Pendiente:** unificar el DDL de facturación en una sola definición (el de `03` es hoy inerte).

## E-031 — CERRADO (5ae367a/e195756): workers multiempresa sin contexto de tenant bajo RLS
- **Síntoma esperado:** `cronWorker`, `agentWorker` y el bus de eventos (44) consultan con el rol runtime sin `app.current_tenant`: bajo RLS forzado no ven filas (suspensiones, verificación nocturna del ledger, búsqueda de camiones y pausas no actúan).
- **Alcance real (hallado al corregir):** bus con candado inútil (FOR UPDATE en autocommit) y sin reintentos reales (publicaba aunque fallara un suscriptor), suscriptores del ledger con nombres de método inexistentes; cron sin ejecución única (clave calculada y no usada) y con reporte vacío; agente que cruzaba empresas, no emparejaba nunca (función inexistente, puntuación no esperada), podía tumbar el proceso (rechazo no capturado en un setTimeout) y repetía avisos cada 10 s.
- **Corrección:** migración 006 (lease/reintentos/cola de fallidos, `cron_ejecuciones`, `match_notificaciones`, funciones de descubrimiento que solo devuelven ids), 44/45/cronWorker/agentWorker v7.3, 29 y 47 ajustados.
- **Prevención:** T19 (incluida una carrera determinista de reclamación), G15 y 11 mutaciones.

## E-032 — BLOCKED: módulos geoespaciales requieren PostGIS
- `14_geospatial_engine.sql` y `34_ifta_report` usan `GEOGRAPHY`/`ST_*`. La extensión no está instalada en el entorno de validación; ambos quedan fuera de la secuencia de esquema y sus consultas son excepciones documentadas de la auditoría.

## E-033 — ABIERTO: aprobaciones del modo 95 % sin esquema
- La ruta `POST /api/aprobaciones/:id/si` actualizaba una tabla `aprobaciones` que no existe y nada produce aprobaciones. Responde 501 hasta definir el modelo (quién crea la aprobación, qué decide, qué ejecuta).

## E-034 — ABIERTO: planificador legado 04_cron_jobs.js no cableado
- El servidor usa `server/workers/cronWorker.js`; `04_cron_jobs.js` no se carga en ningún sitio y consulta `tenants.email` (inexistente). Retirarlo requiere ajustar tres comprobaciones textuales de la suite 26.

## E-035 — Notificaciones: historial imposible y etiqueta pisada
- **Detectado en:** revisión de 45 durante E-031 y T19c.
- **Síntoma:** `destinatario VARCHAR(20)` frente a `'driver:<uuid>'` (43): el INSERT del historial fallaba siempre después de enviar; con reintentos del bus, el chofer recibiría el mismo SMS hasta 5 veces. Además `contactoChofer` devolvía `{ id: 'driver:…', ...fila }` y la columna `id` de la fila pisaba la etiqueta.
- **Corrección:** migración 006 (`VARCHAR(64)`, `tenant_id` admite NULL para alertas del sistema), etiqueta aplicada al final, historial que nunca hace fallar un envío ya hecho.
- **Prevención:** T19c y mutación `notificacion_etiqueta_pisada`.

## E-036 — ABIERTO: motor neural de match inoperante
- **Síntoma:** `15_neural_matching_engine.js` exige `@tensorflow/tfjs-node` al cargarse (dependencia opcional) y `predecirAceptacion` llama a `this.cargarModeloEntrenado()`, que no existe en la clase.
- **Mitigación:** el agente usa una puntuación inyectable; si el motor no está disponible, no ofrece cargas y lo registra (`agentes.puntuador_no_disponible`).
- **Corrección pendiente:** definir el modelo (entrenamiento, persistencia, carga) o un puntuador basado en reglas, con su prueba.

## E-037 — ABIERTO: tarifas (30) llama a un método que el módulo de diésel (20) no tiene
- **Detectado en:** auditoría de correspondencia (`tools/inventario.js`, 2026-11-23).
- **Síntoma:** `30_tarifas_inteligentes.js:76` llama `require('./20_alerta_diesel').obtenerPrecioActual()`. El módulo 20 exporta la clase `AlertaDiesel`, sin ese método (ni estático ni de instancia). El `try/catch` lo oculta: el ajuste por diésel es siempre neutro (`variacionSemanal: 0`).
- **Agravantes en 20:** mapa estado→región incompleto (`/* ... */`), precios cacheados en Redis, que ningún componente del runtime proporciona.
- **Corrección pendiente:** definir la fuente del precio (tabla en PostgreSQL alimentada por la tarea EIA), exponer una función real y probarla.

## E-038 — ABIERTO: el despachador automático (08) se inyecta como clase y sus ganchos no existen
- **Detectado en:** auditoría de correspondencia.
- **Síntoma:** `server/index.js:55` pasa la clase `AutoDispatchAgent` (sin `new`) al bus (44), al gateway (40) y a los webhooks. Los ganchos que esos módulos invocan —`ejecutarPostAceptacion`, `pausarChofer`, `reasignar`, `confirmarTrasSms`— no existen en 08 ni siquiera en una instancia. Todos están protegidos con `typeof … === 'function'`, así que el runtime no falla: simplemente nunca despacha, nunca reasigna y nunca pausa.
- **Dependencias ausentes:** 08 exige `redis` y un `loadService` "del archivo 01: DAT + Truckstop"; 01 es SQL y no existe cliente DAT/Truckstop en el repositorio.
- **Corrección pendiente:** decidir el contrato del despachador (qué ganchos, con qué datos), implementarlo sobre PostgreSQL y probarlo; mientras tanto, la funcionalidad no debe anunciarse como operativa.

## E-039 — ABIERTO: el módulo de voz (38) recibe el enrutador de IA (25) como clase
- **Síntoma:** `server/index.js:59` configura 38 con `agenteIA: require('../25_enrutador_modelos')` (la clase). `38_modo_voz_auricular.js:108` llama `agenteIA.completar(...)`, que es un método de instancia: la conversación por auricular lanza `TypeError` en el primer uso.
- **Corrección pendiente:** inyectar una instancia (`new EnrutadorIA()`), con prueba que ejerza el camino de conversación.

## E-040 — CERRADO (ea6ce62): el webhook de Stripe llamaba a un método de instancia sobre la clase
- **Síntoma original:** `server/api/webhooks.js` ejecutaba `require('../../03_billing_stripe').handleWebhook(db, evento)` sobre la clase `BillingService`: todo evento válido → 500. Además: la empresa salía de `metadata.tenant_id` (las facturas de suscripción no lo traen y es un dato del cuerpo), sin idempotencia (cada reentrega insertaba otro pago), sin orden (un `payment_failed` antiguo pisaba un pago posterior), escrituras sueltas fuera de transacción y sin asiento en el ledger; `createSubscription` no guardaba el id de la suscripción de Stripe y `changePlan` llamaba a un método inexistente.
- **Corrección:**
  - `BillingService` se instancia una vez por servidor; `aplicarEvento(client, tenantId, evento)` sustituye a `handleWebhook`.
  - Firma v1 verificada sobre el cuerpo crudo sin SDK (`server/api/stripe_firma.js`): tolerancia de 300 s, varias `v1`, varios secretos (rotación), comparación en tiempo constante. Rechazo 400 antes de tocar la BD; sin secreto configurado → 503.
  - Empresa solo por `tenants.stripe_customer_id` (único, migración 007). Cliente desconocido: 503 si el tipo se gestiona, 200 si no.
  - `stripe_eventos` (clave primaria `event.id`, RLS) escrito en la misma transacción que el efecto: PROCESADO/IGNORADO → 200 duplicado sin efectos; reentregas simultáneas se serializan por la clave primaria.
  - Suscripción, pago, estado de la empresa y asiento del ledger (`ledger.asentar`, nuevo, dentro de la transacción del llamador) se confirman o se deshacen juntos.
  - Orden: el estado solo cambia con un `event.created` posterior al último aplicado (empate: gana la baja); el fin de periodo solo avanza. Un SUCCEEDED por factura (índice único parcial).
  - Fallo → ROLLBACK total, FALLIDO con intentos y último error en transacción aparte, 500. El reintento lo aplica una vez.
- **Prevención:** T20 (6 casos) y 13 mutaciones (59/59 detectadas en total); grupo G16 de la suite 39.
- **Pendiente fuera de este defecto:** `createSubscription`/`changePlan` contra la API real de Stripe (NOT RUN), parser Express (E-027).

## E-041 — ABIERTO: envíos push y email vacíos en el arranque
- **Síntoma:** `server/index.js` construye el servicio de notificaciones (45) con `pushSender: async () => { /* expo push */ }` y `emailSender: async () => { /* SMTP */ }`. Los envíos por esos canales "tienen éxito" sin enviar nada y no activan la caída a SMS de 45.
- **Corrección pendiente:** implementar los dos adaptadores (Expo Push, `@sendgrid/mail` ya declarado) o retirarlos para que 45 caiga a SMS.

## E-042 — ABIERTO: la app del chofer y el panel del broker llaman rutas que el servidor no tiene
- **Síntoma:** `driver_app/src/api.js` usa la base `/api/driver` con `/login` (por teléfono), `/loads/pending`, `/loads/active`, `/loads/:id/accept|reject`, `/bookings/:id/pickup|delivery`. `31_panel_semaforo.html` llama `/api/panel/resumen` y `/api/aprobaciones/resolver`. Ninguna existe en `server/api/routes.js` (rutas reales: `/api/auth/login|logout`, `/api/drivers`, `/api/drivers/:id/verificacion|documentos`, `/api/loads`, `/api/loads/:id/asignar`, `/api/aprobaciones/:id/si` → 501, `/api/reportes/mensual`).
- **Corrección pendiente:** contrato de API del chofer (autenticación por teléfono, rol DRIVER limitado a sus datos) y del panel, con pruebas T18 equivalentes.

## E-043 — ABIERTO: la pila de despliegue (48) no arranca y contradice el modelo de seguridad
- **Síntoma (verificado en el texto de `48_deploy_stack.js`):** el `.env` generado no define `POSTGRES_PASSWORD` (la imagen oficial `postgres:16` se niega a inicializar) ni `POSTGRES_USER`/`POSTGRES_DB`, así que el usuario `microfleet` de `DATABASE_URL` nunca se crea y el `healthcheck` (`pg_isready -U microfleet`) no corresponde a ningún rol. No hay `MIGRATION_DATABASE_URL`, no se montan `infra/postgres/*` (roles `mf_login`/`mf_app`/`mf_resolver`, sin los cuales no existe la separación runtime/propietario ni el RLS forzado), faltan `CHECKPOINT_PUBLIC_KEYS`, `TWILIO_WEBHOOK_BASE_URL` y `APP_BASE_DOMAIN`; el `JWT_SECRET` de ejemplo tiene 28 caracteres y 41 exige 32; el `Dockerfile` ejecuta `npm ci` sin `package-lock.json` (falla); provisiona Redis, que ningún módulo del runtime usa. Si un operador "arreglara" el arranque usando el superusuario como `DATABASE_URL`, el runtime ignoraría RLS.
- **Corrección pendiente:** reescribir 48 sobre `docker-compose.postgres.yml` e `infra/postgres`, con prueba de humo del contenedor.

## E-044 — ABIERTO: voz IA de llamadas (19) depende de un archivo inexistente y simula llamadas
- **Síntoma:** `19_voz_ia_llamadas.js` requiere `./05_push_notifications` (no existe); `llamarShipper` devuelve `{ llamando: true }` sin llamar; `openai.realtime.connect` no se ha comprobado contra el SDK declarado. Nada carga el módulo.
- **Estado:** especificación con código, no funcionalidad.

## E-045 — ABIERTO: facturación QuickBooks (18) no es operable ni idempotente
- **Síntoma:** nada carga el módulo. `getTokensBroker` devuelve `qb_realm_id/qb_access_token` pero se leen `realmId/accessToken` (URL con `undefined`); `buscarOCrearCliente` y `buscarOCrearServicio` devuelven `'1'` fijo; `notificar` vacío; sin renovación OAuth2, sin clave de idempotencia (`requestid`) ni comprobación previa de factura existente (un reintento factura dos veces); `alRecibirPago` no verifica la firma del webhook de Intuit ni concilia importes.
- **Criterio de cierre:** pruebas de idempotencia (reintento tras timeout, doble evento de entrega) y de conciliación (pago parcial, pago duplicado, factura inexistente) contra un sandbox o un doble HTTP verificable.

## E-046 — ABIERTO: modo familia (21), reporte IRS (22) y verificación de respaldo (49) sin cablear
- **Síntoma:** nada carga 21 ni 22; `21.enviarWhatsApp` está vacío (las alertas "camión detenido 2 h" no salen). `49.verificarBackupDiario` no lo invoca ninguna tarea. La re-verificación FMCSA cada 7 días anunciada en 33 no existe en `cronWorker`.

## E-047 — ABIERTO: los precios anunciados no son los que cobra el código
- **Síntoma:** `12_precios_competitivos.md` y la documentación comercial anuncian Solo $99 / Team $249 / Business $499 (5/15/50 camiones). `03_billing_stripe.js` define `PLANS` STARTER $299 / PRO $799 / ENTERPRISE $1999 (10/50/200 camiones) y `01` usa esos nombres en `tenants.plan`. La documentación antigua remitía a una tabla `plans` que no existe.
- **Corrección pendiente:** decisión comercial de una sola lista de precios; después, alinear 01, 03, 12 y los `price_id` de Stripe, con prueba que compare las tres fuentes.
