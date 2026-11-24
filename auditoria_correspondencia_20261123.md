# Auditoría de correspondencia — archivos, contratos, dependencias y funcionalidad anunciada

- **Fecha:** 2026-11-23
- **Commit auditado:** el que registran `docs/INVENTARIO.md` y `inventario.json` (campo `commit`). El código de producto es idéntico a `2723df7`: los commits de la auditoría solo añaden la herramienta y documentación.
- **Herramienta:** `node tools/inventario.js --json … --md docs/INVENTARIO.md` → exit 0
- **Evidencia:** `informes/evidencia_auditoria_correspondencia_20261123/` (`inventario.json`, `inventario.log`, `inventario.exit`, `SHA256SUMS`)
- **Alcance:** todo archivo versionado excepto la evidencia histórica (`informes/evidencia_*`, `*.log`); funcionalidades prometidas en `00_README_MASTER.md` (versión anterior), `24_agentes_ia.md` y las descripciones del índice.

## 1. Resultado

| Pregunta | Respuesta |
|---|---|
| ¿Son 83 archivos? | No. La cifra no es reproducible por ningún recuento: línea base `8ba3da2` = 77, paquete v6.0 `7088099` = 92 (88 sin `informes/`), estado auditado = 141 sin evidencia histórica. No existe manifiesto que la respalde. |
| ¿Coincide el índice con los archivos? | Las 52 entradas apuntan a algo que existe, pero mezclaban archivos, directorios (`driver_app/`, `server/`) y una numeración lógica que desde la fila 29 dejó de coincidir con el prefijo del nombre (30→`29_…`, …, 51→`49_…`). Corregido: el índice ahora es por nombre de archivo, con el número antiguo como columna informativa. |
| ¿Se cumplen los contratos entre módulos? | 5 contratos rotos, todos en caminos que ninguna prueba ejercía. Tres de ellos están en el arranque del servidor. Registrados como E-037, E-038, E-039, E-040 y E-044 y bloqueados por el gate. |
| ¿Están declaradas las dependencias? | Sí: ningún paquete importado por código de producto falta en `package.json`. Pero no hay `package-lock.json` (sin `npm ci`) y Redis, que piden 08, 20 y 21 y que provisiona 48, no tiene cliente ni dependencia: ningún componente lo proporciona. |
| ¿Qué parte de lo anunciado funciona? | De 41 funcionalidades: **10 VERIFICADO**, **9 PARCIAL**, **20 ESPECIFICACIÓN**, **2 BLOQUEADO**. |

## 2. Método

1. **Inventario.** `git ls-files`; por archivo: tipo, líneas, SHA-256 y número del índice del README.
2. **Grafo de dependencias.** Análisis estático de `require` (comentarios y literales de texto se neutralizan antes de buscar usos). Dependencias internas resueltas a archivo; externas comparadas con `package.json`.
3. **Exportaciones reales.** Cada módulo se carga en un proceso aislado con los paquetes externos sustituidos por stubs y temporizadores neutralizados; se registran miembros estáticos y métodos de instancia por separado.
4. **Contratos.** Cada `alias.miembro`, desestructuración y `require(...).miembro` se contrasta con las exportaciones. Además: método de instancia invocado sobre la clase, clase inyectada como dependencia sin `new`, y `require` de un archivo inexistente.
5. **Alcance.** Clausura de `require` desde `server/index.js` (runtime) y `scripts/migrate.js` (bootstrap).
6. **Cobertura.** Clausura desde cada suite: unitarias (26, 39) e integración PostgreSQL (`tests/integration/postgres_*.js`); comprobaciones solo textuales se marcan aparte.
7. **Funcionalidad.** Cada promesa comercial se rastreó a su código y se clasificó leyendo ese código y la prueba que lo ejerce (no solo la que lo carga).

**Controles negativos** (la herramienta debe fallar): un uso inyectado de `41_auth_rbac.metodoInexistente` en 22 → exit 1 `[NUEVO]`; una excepción sin hallazgo → exit 1 `EXCEPCIÓN OBSOLETA`. Ambos revertidos; ejecución limpia → exit 0.

**Límites conocidos de la herramienta:** no sigue objetos pasados como parámetro (por eso los ganchos de E-038 se encontraron leyendo el código, no por la herramienta); "cargado por una suite" no implica "ejercido por la suite" (p. ej. 03 y 15 figuran como cargados por pruebas PostgreSQL porque las suites importan los webhooks y el worker, pero ninguna prueba ejecuta su lógica).

## 3. Conexión de los 53 módulos JS de producto

| Conexión | Nº | Módulos |
|---|---|---|
| Runtime y cargado por prueba PostgreSQL | 25 | 02, 03, 15, 17, 29, 33, 38, 41–47, `db/*` (3), `server/api/*` (3), `server/http/contexto_tenant.js`, `server/services/fmcsa_client.js`, `server/services/ofertas.js`, `server/workers/agentWorker.js`, `server/workers/cronWorker.js` |
| Runtime sin prueba PostgreSQL | 6 | 07, 08, 25, 40 (su cadena se reproduce en T18), `server/index.js`, `server/workers/eventWorker.js` |
| Bootstrap | 1 | `scripts/migrate.js` |
| Solo pruebas unitarias | 6 | 20, 30, 32, 34, 35, 36 |
| Sin conexión | 15 | 04, 05, 18, 19, 21, 22, 48, 49, `driver_app/*` (5), `scripts/verify.js`, `server/services/twilio_client.js` |

`server/services/twilio_client.js` es un adaptador huérfano: `server/index.js` instancia el SDK de Twilio directamente.

## 4. Contratos rotos

| Origen | Destino | Defecto | Efecto |
|---|---|---|---|
| `server/api/webhooks.js:57` | `03_billing_stripe.js` `handleWebhook` | E-040 | Método de instancia llamado sobre la clase: todo evento Stripe válido → 500. Ningún pago se registra. |
| `server/index.js:55` | `08_auto_dispatch_agent.js` | E-038 | Clase inyectada sin instanciar en bus, gateway y webhooks; además los ganchos esperados (`ejecutarPostAceptacion`, `pausarChofer`, `reasignar`, `confirmarTrasSms`) no existen en 08. Protegidos con `typeof`: fallo silencioso. |
| `server/index.js:59` | `25_enrutador_modelos.js` | E-039 | Clase inyectada en 38; `agenteIA.completar` → `TypeError` en la primera conversación por auricular. |
| `30_tarifas_inteligentes.js:76` | `20_alerta_diesel.js` `obtenerPrecioActual` | E-037 | Miembro inexistente oculto por `try/catch`: ajuste por diésel siempre neutro. |
| `19_voz_ia_llamadas.js` | `./05_push_notifications` | E-044 | Archivo inexistente. |

Contratos rotos encontrados por lectura (fuera del alcance de la herramienta):

| Dónde | Defecto | Efecto |
|---|---|---|
| `server/index.js` → 45 | E-041 | `pushSender` y `emailSender` vacíos: los envíos "tienen éxito" sin salir. |
| `driver_app/src/api.js`, `31_panel_semaforo.html` → `server/api/routes.js` | E-042 | La app usa `/api/driver/*` y el panel `/api/panel/resumen`; ninguna ruta existe. |
| `18_facturacion_quickbooks.js` | E-045 | Lee `realmId/accessToken` pero la consulta devuelve `qb_realm_id/qb_access_token`. |
| `12_precios_competitivos.md` ↔ 03 ↔ 01 | E-047 | $99/$249/$499 anunciados frente a $299/$799/$1999 en el código. |
| `48_deploy_stack.js` ↔ `infra/postgres` | E-043 | La pila generada no inicializa PostgreSQL ni crea los roles de los que depende el RLS. |

## 5. Funcionalidades anunciadas

Leyenda: **VERIFICADO** = en runtime y ejercido contra PostgreSQL real con evidencia; **PARCIAL** = conectado pero con una parte rota, sin probar o dependiente de un defecto; **ESPECIFICACIÓN** = nada del servidor lo carga, o el código simula el resultado; **BLOQUEADO** = falta PostGIS.

| # | Funcionalidad | Archivos | Estado | Evidencia o motivo |
|---|---|---|---|---|
| 1 | Aislamiento por empresa (RLS forzado) | 01, `infra/postgres`, `contexto_tenant` | VERIFICADO | T3, T18, T19 |
| 2 | Empresa por subdominio + suscripción vigente | 02 | VERIFICADO | T18 |
| 3 | API de flota (choferes, cargas, asignar, reporte mensual) | `server/api/routes.js` | VERIFICADO | T18 |
| 4 | Ledger auditable con checkpoints firmados | 42 | VERIFICADO | T1–T16; faltan vectores RFC 8785 oficiales |
| 5 | Bus de eventos sin pérdida (lease, reintentos, fallidos) | 44 | VERIFICADO | T19 |
| 6 | Exactamente-una-vez (asignar, pagar, despachar, facturar) | 46 | VERIFICADO | T13, T14 |
| 7 | Elección de líder y relevo | 47 | VERIFICADO | T12 |
| 8 | Tareas programadas únicas en el clúster (suspensión, ledger nocturno, reporte, limpieza) | `cronWorker` | VERIFICADO | T19 |
| 9 | Aceptar/rechazar carga por SMS | 17 | VERIFICADO | T17 (firma, RLS, una vez); la reasignación tras rechazo depende de E-038 |
| 10 | Decisión de oferta por voz | 38, `ofertas.js` | VERIFICADO | T17 |
| 11 | Autenticación, roles y bloqueo | 41 | PARCIAL | T18 con proveedores criptográficos de prueba; `bcryptjs`/`jsonwebtoken` reales NOT RUN |
| 12 | Notificaciones multicanal con caída a SMS | 45 | PARCIAL | Historial y etiqueta verificados (T19c); push/email vacíos (E-041); Twilio real NOT RUN |
| 13 | Verificación del camionero en 4 capas | 33 | PARCIAL | Capa 1 (FMCSA) conectada y consultable (T18); capa 2 (llamada a aseguradora) no existe; capa 3 (re-chequeo 7 días) no existe en cron (E-046); capa 4 depende de la app (E-042) |
| 14 | Match en tiempo real | 29, `agentWorker` | PARCIAL | Verificado con puntuador inyectado (T19); con el puntuador por defecto no ofrece nada (E-036) |
| 15 | Cobro con Stripe | 03, `cronWorker` | PARCIAL | Suspensión de morosos verificada; webhook roto (E-040); DDL duplicado (E-030) |
| 16 | Métricas y salud | 43 | PARCIAL | Lógica probada en suite 39; `/healthz` y `/metrics` con servidor arrancado NOT RUN |
| 17 | Conversación con el agente por auricular | 38 + 25 | PARCIAL | Conectado pero falla en el primer uso (E-039) |
| 18 | Enrutador de modelos Ollama → OpenRouter → OpenAI | 25 | PARCIAL | Solo lo usa 38, y como clase (E-039); proveedores reales NOT RUN |
| 19 | Recuperación ante desastres | 42, 49, T8–T11 | PARCIAL | Restauración local verificada; runbooks y drill de producción no ejecutados (§6) |
| 20 | Búsqueda en DAT/Truckstop cada 10 min | 01 + 08 | ESPECIFICACIÓN | No existe cliente DAT ni Truckstop |
| 21 | Negociación en inglés y traducción | 07 | ESPECIFICACIÓN | Solo se alcanza a través de 08, que nunca se instancia (E-038); `modoPilotoAutomatico` deja el envío real como comentario |
| 22 | Despacho automático 95 % / 100 % | 08, 11 | ESPECIFICACIÓN | E-038; `11_config_95_automatico.json` no lo lee ningún código |
| 23 | Aprobaciones de 1 clic | `routes.js`, 31 | ESPECIFICACIÓN | 501 (E-033) |
| 24 | Red neuronal que aprende | 15 | ESPECIFICACIÓN | E-036 |
| 25 | Facturación automática QuickBooks y conciliación | 18 | ESPECIFICACIÓN | E-045: sin conexión, valores fijos, sin idempotencia ni conciliación probadas |
| 26 | Voz IA que atiende y llama a shippers | 19 | ESPECIFICACIÓN | E-044 |
| 27 | Descarte por diésel | 20 | ESPECIFICACIÓN | E-037 |
| 28 | Tarifas inteligentes por ruta | 30 | ESPECIFICACIÓN | Solo unitarias; ningún agente la consulta |
| 29 | Score A–E con bloqueo automático | 32 | ESPECIFICACIÓN | Solo unitarias; ningún agente la consulta |
| 30 | Modo familia | 21 | ESPECIFICACIÓN | E-046 |
| 31 | Reporte IRS trimestral | 22 | ESPECIFICACIÓN | E-046 |
| 32 | Geografía, clima y hora local | 35 | ESPECIFICACIÓN | Solo unitarias |
| 33 | Importación CSV | 36 | ESPECIFICACIÓN | Sin ruta HTTP |
| 34 | Panel semáforo | 31 | ESPECIFICACIÓN | E-042 |
| 35 | App del chofer | `driver_app/` | ESPECIFICACIÓN | E-042 |
| 36 | Modo sin internet de la app | `driver_app/src/offline.js` | ESPECIFICACIÓN | Depende de la app (E-042) |
| 37 | Panel de administración del broker | 05 | ESPECIFICACIÓN | No se monta |
| 38 | Despliegue "de cero a producción en 20 min" | 48 | ESPECIFICACIÓN | E-043 |
| 39 | Lista de precios $99/$249/$499 | 12 ↔ 03 | ESPECIFICACIÓN | El código cobra otra lista (E-047) |
| 40 | Búsqueda espacial de cargas | 14 | BLOQUEADO | PostGIS (E-032) |
| 41 | Reporte IFTA | 34 | BLOQUEADO | PostGIS (E-032) |

## 6. Puntos señalados en la orden

| Punto | Hallazgo | Corrección aplicada |
|---|---|---|
| Versión 6.0 frente a historial 4.0 | El historial terminaba en 4.0. No existe ningún registro de 4.1–4.9. Las cabeceras de los módulos permiten reconstruir 5.0–5.4 y 6.0. | Historial ampliado con 4.1–4.9 (declarado sin registro), 5.0–6.0 (fuente: cabeceras) y 6.1–7.3 (fuente: commits). |
| 83 archivos frente al índice | Cifra no verificable; numeración desplazada desde la fila 29. | `docs/INVENTARIO.md` generado; índice por nombre de archivo con estado por fila. |
| PostgreSQL | El cierre decía que T1–T7 no se ejecutaron. | Sección 10 con T1–T19, auditoría SQL y mutaciones, y las salvedades (pg-compat, proveedores de prueba, sin arranque completo). |
| Instalación | `npm install` de una lista suelta, `.env` de "paquete v2.0", tabla `plans` inexistente. | Procedimiento con `package.json`, `.env.example`, `docker-compose.postgres.yml`/`run_native_pg16.sh`, `npm run db:bootstrap`, `npm start`; `npm ci` declarado BLOCKED. |
| Servidor | `09_server.js` no existe. | `server/index.js` (`npm start`); `driver_app/LEEME_PRIMERO.md` también lo citaba. |
| Agentes | Ninguna evidencia de ciclo autónomo de extremo a extremo. | Sección 3 del README: estado por agente y lo que sí está demostrado (cron único, bus, ledger nocturno, líder). |
| QuickBooks | Además de faltar pruebas, el código no es operable (E-045). | Clasificado ESPECIFICACIÓN con criterio de cierre: idempotencia (reintento tras timeout, doble entrega) y conciliación (pago parcial, duplicado, factura inexistente). |
| Recuperación | Hay restauración local verificada (T8, T9, T11), no drill. | Sección 6 del README separa lo verificado de lo no acreditado; nuevo gate "Restore drill de producción: NOT RUN" en VERIFY. |

## 7. Orden recomendado de corrección

1. **E-040** (Stripe): es la ruta del ingreso. Instanciar `BillingService`, idempotencia por `event.id`, prueba con evento firmado.
2. **E-047** (precios): decisión comercial antes de vender.
3. **E-038/E-039/E-041**: inyección correcta en `server/index.js` y adaptadores reales o eliminados; con prueba de arranque.
4. **E-042**: contrato de la API del chofer; sin él, la app no se puede usar.
5. **E-043** y lockfile: sin ellos no hay despliegue reproducible ni drill.
6. QuickBooks, diésel, voz, familia, IRS: decidir cuáles siguen en la oferta comercial y retirar del material de venta los que no.
