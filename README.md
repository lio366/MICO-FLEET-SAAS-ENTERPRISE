# MICRO-FLEET SAAS ENTERPRISE — DOCUMENTACIÓN COMPLETA
## Versión de fuente 6.0 · 83 archivos versionados · Noviembre 2026

---

## 1. QUÉ ES ESTE SISTEMA

Una plataforma que rentas a brokers de carga (camiones) por suscripción mensual.
Cada broker tiene su espacio privado, con su marca, y una IA que:
- Busca cargas en DAT/Truckstop automáticamente
- Negocia precios en inglés por él
- Traduce todo al español
- Confirma cargas y asigna camiones (95% automático)
- Tú cobras cada mes solo con Stripe

---

## 2. ÍNDICE DE DOCUMENTACIÓN (todo registrado aquí)

| # | Archivo | Qué contiene |
|---|---|---|
| 00 | `00_README_MASTER.md` | Este documento — guía maestra e índice |
| 01 | `01_multi_tenant_database.sql` | Base de datos: cada broker aislado de los demás |
| 02 | `02_tenant_middleware.js` | El "portero": identifica al broker y protege cada piso |
| 03 | `03_billing_stripe.js` | Cobros automáticos mensuales con Stripe |
| 04 | `04_cron_jobs.js` | Tareas programadas: suspender morosos, avisos, reportes |
| 05 | `05_tenant_admin_api.js` | Panel de cada broker: camiones, usuarios, marca |
| 06 | `06_pricing_and_operations.md` | Plan de negocio original y operación |
| 07 | `07_ai_language_agent.js` | IA bilingüe: negocia en inglés, traduce al español |
| 08 | `08_auto_dispatch_agent.js` | Despacho automático con WhatsApp (modo 95% y modo 100%) |
| 09 | `09_ejemplo_dia_broker.md` | Día típico del broker: antes vs después |
| 10 | `10_modo_100_automatico.md` | Qué puede hacer la IA sola y qué aún necesita humano |
| 11 | `11_config_95_automatico.json` | Configuración lista para copiar: 95% automático |
| 12 | `12_precios_competitivos.md` | Análisis de competencia (precios reales nov 2026) |
| 13 | `13_resultados_prueba_estres.md` | Prueba de estrés: 2 brokers × 10 camiones, 30 días |
| 14 | `14_geospatial_engine.sql` | Geolocalización espacial: cargas cerca de cada camión en milisegundos |
| 15 | `15_neural_matching_engine.js` | Red neuronal que aprende los gustos de cada broker con cada despacho |
| 16 | `16_entrega_carga_al_chofer.md` | Cómo llega la carga al chofer: las 3 vías, el flujo y las reglas |
| 17 | `17_sms_emergencia.js` | Aceptar/rechazar carga por SMS con una rayita de señal (Twilio webhook) |
| 18 | `18_facturacion_quickbooks.js` | Factura automática al entregar + cobro conciliado en QuickBooks |
| 19 | `19_voz_ia_llamadas.js` | Voz de IA atiende llamadas de shippers y traduce todo al español |
| 20 | `20_alerta_diesel.js` | Descarta cargas donde el diésel caro se come la ganancia |
| 21 | `21_modo_familia.js` | Ubicación en vivo para un familiar + alerta si el camión se detiene 2h |
| 22 | `22_reporte_irs.js` | Reporte trimestral para el contador: ingresos, millas, reserva de impuestos |
| 23 | `23_pruebas_estres_completas.md` | Pruebas de estrés de TODA la cadena del dinero: 4 escenarios, oferta→pago al chofer |
| 24 | `24_agentes_ia.md` | Los 7 agentes de IA: qué hacen solos 24/7, sus 5 reglas de oro y sus límites |
| 25 | `25_enrutador_modelos.js` | Billetera de los 7 agentes: Ollama gratis (local) → OpenRouter gpt-4o-mini → OpenAI respaldo |
| 26 | `26_pruebas_estres_70.js` | **Suite de 70 pruebas de estrés ejecutables** — `node 26_pruebas_estres_70.js` |
| 27 | `27_informe_70_pruebas.md` | Informe oficial: 70/70 pasadas, 6 grupos, hallazgos corregidos |
| 28 | `28_camino2_broker_hibrido.md` | **✔ PLAN ELEGIDO:** sacar tu propio MC de broker y operar con tu app (vitrina + ingresos YA) |
| 29 | `driver_app/` | **La app del chofer construida** (Android + iPhone): login, carga, ACEPTAR, fotos, GPS, **modo sin internet** |
| 30 | `29_match_tiempo_real.js` | **Match en segundos:** el agente revisa el tablero cada 10s y alerta al chofer al instante (push + SMS de respaldo). Cargas con más de 3 min publicadas se descartan (ya están "quemadas") |
| 31 | `30_tarifas_inteligentes.js` | **Negociar con datos reales:** histórico propio de tarifas por ruta (últimos 30 días) + ajuste por diésel y temporada. Piso/objetivo/techo por ruta → +$30-80 de margen por carga |
| 32 | `31_panel_semaforo.html` | **Panel del broker en 10 segundos:** 4 tarjetas tipo semáforo (verde/amarillo/rojo) — cargas en camino, camiones disponibles, facturas por cobrar, y lo que necesita tu "SÍ" |
| 33 | `32_score_confianza.js` | **No trabajes con quien no paga:** cada shipper y camionero recibe nota A-E automática. Los agentes bloquean solos a los nota E, exigen factoring a los C/D, y dan crédito amplio a los A/B |
| 34 | `33_verificacion_carrier.js` | **4 capas de verificación del camionero:** (1) registro federal FMCSA gratis automático, (2) llamada del agente de voz a la aseguradora, (3) re-chequeo cada 7 días y antes de cada carga, (4) evidencia física desde la app (foto CDL, camión, póliza). Sin VERIFICADO no se suelta ninguna carga |
| 35 | `34_ifta_report.js` | **Reporte IFTA trimestral** (millas por estado desde el GPS ÷ mpg × tasa de cada estado). Los competidores lo cobran premium; aquí va incluido |
| 36 | `35_apis_gratuitas_geografia.js` | **Geografía, clima y hora — TODO GRATIS ya conectado:** Nominatim (ciudad→coordenadas+huso horario, sin clave), NWS (alertas de tormenta en ruta, sin clave), Open-Meteo (respaldo), OpenRouteService (millas reales de camión, clave gratis), hora local de cualquier ciudad y "¿el almacén sigue abierto?" |
| 37 | `36_onboarding_csv.js` | **Importar choferes y cargas desde Excel/CSV** al registrarse: valida teléfonos y tarifas, rechaza filas malas con motivo, reporta cuántas entraron |
| 38 | `37_investigacion_competencia_github.md` | **Investigación de competencia (GitHub + mercado, nov 2026):** qué tienen LogisticsX, LoadPartner, Fleetbase, AscendTMS; qué copiamos, en qué ya superamos a todos, y la fase 2 planificada (ELD/HOS, tracking link del shipper, MCP server, mapa con clima) |
| 39 | `38_modo_voz_auricular.js` | **El chofer nunca toca el teléfono:** la oferta entra AL AURICULAR Bluetooth mono como llamada de voz (IA en español, escucha "uno/dos", ~$0.02/llamada); el botón del BlueParrott habla con el agente IA (¿cuánto me deben?, ¿dónde paro barato?); resumen hablado cada mañana + alertas de seguridad habladas. Nadie más lo ofrece en español |
| 40 | `39_pruebas_sistema_completo.js` | **63 pruebas ejecutables** (módulos 29-38 + ledger v6.0, 10 grupos) — `node 39_pruebas_sistema_completo.js`. Última ejecución local de esta copia: 63/63. Suite de estrés separada: 70/70. Son suites distintas y no equivalen a validación PostgreSQL/producción |
| 41 | `40_api_gateway.js` | **Puerta única de entrada:** tenant antes de cualquier ruta, rate limit, CORS cerrado, headers de seguridad, request ID, errores sin fugas |
| 42 | `41_auth_rbac.js` | **Auth + roles (ADMIN/DISPATCHER/VIEWER/DRIVER):** JWT 12h revocable, bcrypt 12, bloqueo por 5 intentos, matriz de permisos, el DRIVER solo toca sus datos |
| 43 | `42_audit_ledger.js` | **Ledger encadenado v6.0:** serialización JCS con versión persistida, `occurred_at`, fingerprint de identidad, candado advisory 64 bits, índices anti-fork/dedup, trigger de inmutabilidad, resolución de COMMIT ambiguo, snapshot de verificación y checkpoints HMAC heredados/Ed25519. Requiere validar RFC 8785 y migraciones en PostgreSQL real; no se afirma auditoría externa ni certificación |
| 44 | `43_metrics_observability.js` | **Pulso de la plataforma:** /metrics estilo Prometheus, health check con DB, logger JSON, reglas de alerta (errores 5xx, memoria, latencia) |
| 45 | `44_event_bus.js` | **Sistema nervioso (outbox + bus):** los agentes publican eventos y siguen; suscriptores con idempotencia y reintentos. Imposible perder una carga a media operación |
| 46 | `45_notification_service.js` | **Un solo servicio para avisar a todos:** push/SMS/WhatsApp/voz/email con preferencias por destinatario, plantillas ES/EN, y caída automática al SMS si un canal falla |
| 47 | `server/` | **Backend y workers presentes:** `index.js`, gateway, rutas/webhooks, workers y adaptadores Twilio/FMCSA. El boot de esta copia no está certificado: el informe histórico registra fallo de arranque por autenticador ausente. Falta manifiesto npm en raíz; dependencias deben declararse y fijarse antes de instalación reproducible |
| 48 | `46_distributed_lock.js` | **Candado distribuido — los 4 "doble" imposibles:** doble asignación, doble pago, doble despacho, doble facturación. Candado por clave + UPDATE condicional (la BD es la verdad final) |
| 49 | `47_scheduler_cluster.js` | **Cluster de schedulers:** con 2+ réplicas, elección de líder por candado Postgres (el líder muere → otro toma el mando en 15s). Los cron y agentes corren UNA sola vez en todo el cluster |
| 50 | `48_deploy_stack.js` | **Pila de despliegue:** genera docker-compose, Caddyfile (HTTPS automático), Dockerfile, .env de ejemplo y deploy.sh — de cero a producción en 20 min en un VPS de $6/mes |
| 51 | `49_disaster_recovery.js` | **Plan de recuperación:** runbooks A/B/C, verificación de backup y pruebas de humo documentadas; no hay restore drill de producción certificado en este snapshot |

Presentación para inversores: `micro_fleet_saas_enterprise.pptx.html` (se entrega aparte)

---

## 3. CÓMO INSTALAR (paso a paso, en orden)

**PASO 1 — Base de datos**
1. Crea una base PostgreSQL
2. Ejecuta el archivo `01_multi_tenant_database.sql`
3. Verifica que se crearon las tablas: tenants, subscriptions, drivers, loads, bookings

**PASO 2 — Variables de entorno**
1. Copia `07_environment_variables.env` (está en el paquete v2.0, mismo formato)
2. Completa tus claves reales:
   - DAT_API_KEY y TRUCKSTOP_API_KEY (para las cargas)
   - STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET (para cobrar)
   - OPENAI_API_KEY (para la IA bilingüe)
   - JWT_SECRET (cámbialo, es la llave maestra de seguridad)
   - Credenciales de tu base de datos

**PASO 3 — Instalar componentes**
```
npm install express pg redis joi bcryptjs jsonwebtoken stripe openai node-cron winston twilio
```

**PASO 4 — Conectar los módulos**
```
09_server.js          → punto de entrada (arranca todo)
02_tenant_middleware  → va primero, antes de cualquier ruta
03_billing_stripe     → se monta en /billing/webhook
05_tenant_admin_api   → se monta en /api/panel
07 + 08 (agentes IA)  → se ejecutan con el cron cada 10 minutos
```

**PASO 5 — Configurar el modo de operación**
1. Abre `11_config_95_automatico.json`
2. Ajusta las reglas del broker: precio mínimo por milla, zonas prohibidas
3. Guarda y listo — la IA trabaja dentro de esas reglas siempre

**PASO 6 — Primer broker de prueba**
1. Regístrate como si fueras un broker
2. Carga 1 camión de prueba
3. Verifica que llegue el WhatsApp con cargas en español
4. Toca SÍ y confirma que la IA negocia en inglés

---

## 4. CÓMO COBRAR (ya programado)

- Los precios actuales están en `12_precios_competitivos.md`:
  Solo $99/mes (hasta 5 camiones) · Team $249 (hasta 15) · Business $499 (hasta 50)
- El cobro es automático con Stripe (archivo 03)
- Si un pago falla: 7 días de gracia → suspensión automática (archivo 04)
- Para cambiar un precio: edita la tabla `plans` en el archivo 01 y el objeto
  PLANS en el archivo 03. Ambos deben coincidir.

---

## 5. CÓMO SABER QUE TODO FUNCIONA (verificación)

| Señal | Dónde se ve | Estado correcto |
|---|---|---|
| Cobros entrando | Stripe Dashboard | Pagos mensuales SUCCEEDED |
| Brokers activos | Tabla `tenants` | status = ACTIVE |
| IA negociando | Logs del servidor | `[AGENTE] Negociación cerrada: $X` |
| Camiones con carga | Tabla `bookings` | status = CONFIRMED |
| Costo de IA | Panel OpenAI | ~$0.50/mes por broker activo |
| Servidor sano | Endpoint /health | uptime, memoria, conexiones DB |

---

## 6. MANTENIMIENTO MENSUAL (lo único que toca un humano)

1. Revisar Stripe: pagos fallidos y responder a disputas (raro)
2. Revisar costo de IA en el panel de OpenAI (debe ser bajo)
3. Verificar que el servidor tenga espacio en disco
4. Leer reportes de errores en los logs (archivo 09 registra todo)
5. Atender solicitudes de soporte de brokers (WhatsApp o email)

Tiempo estimado: **2-4 horas al mes** con todo automatizado.

---

## 7. HISTORIAL DE VERSIONES

| Versión | Fecha | Cambio |
|---|---|---|
| 1.0 | — | Sistema base de despacho (1 solo usuario) |
| 2.0 | Nov 2026 | Revisión completa: respaldo automático, rutas de 3 cargas, validación, límites |
| 3.0 | Nov 2026 | SaaS Enterprise: multi-tenant, Stripe, white-label, panel de brokers |
| 3.1 | Nov 2026 | Agente bilingüe (negocia en inglés), despacho 95% automático, precios competitivos, prueba de estrés |
| 3.2 | Nov 2026 | Motor espacial (PostGIS) + red neuronal de matching que aprende de cada decisión |
| 3.3 | Nov 2026 | App móvil del chofer construida (carpeta driver_app/: 4 pantallas + GPS + cámara) |
| 3.4 | Nov 2026 | Modo sin internet (cola offline + SMS de emergencia) + selector de idioma EN/ES |
| 3.5 | Nov 2026 | Módulos 18-22: QuickBooks, voz IA, diésel por ruta, modo familia, reporte IRS |
| 3.6 | Nov 2026 | Pruebas de estrés completas de la cadena del dinero (4 escenarios hasta el pago al chofer) |
| 3.7 | Nov 2026 | Documentación oficial de los 7 agentes de IA autónomos (archivo 24) |
| 3.8 | Nov 2026 | Enrutador de modelos: tareas en Ollama local gratis, nube solo para negociar (archivo 25) |
| 3.9 | Nov 2026 | Suite de 70 pruebas de estrés ejecutada: 70/70 (archivos 26-27) |
| 4.0 | Nov 2026 | **DECISIÓN ESTRATÉGICA: Camino 2 híbrido** — TOUR 567 LLC saca MC de broker y opera con la app (archivo 28) |

---

*Documentación completa registrada. Todos los archivos numerados del 01 al 13
están en este paquete y son la fuente única de verdad del sistema.*

## PostgreSQL real — entorno reproducible

Se añadió `docker-compose.postgres.yml` (PostgreSQL 16), roles `mf_bootstrap`/`mf_login`, grants mínimos y políticas RLS para tablas con `tenant_id`. El backend dispone ahora de manifiesto raíz `package.json`, bootstrap administrativo `scripts/migrate.js` y suite `tests/integration/postgres_t1_t7.js`.

La suite T1–T7 exige dos conexiones reales (`PG_ADMIN_URL` y `DATABASE_URL`) y valida esquema, migración v6, aislamiento RLS, cadena del ledger, inmutabilidad, concurrencia/idempotencia y checkpoint Ed25519/recuperación. No se considera aprobada si no se ejecuta contra PostgreSQL real. Ver `docs/POSTGRESQL_REAL.md`.

**Estado de esta entrega:** pruebas unitarias/locales ejecutadas; PostgreSQL T1–T7 todavía NO ejecutadas porque el entorno de construcción no incluye Docker/Podman ni binarios PostgreSQL y no dispone de repositorio npm resoluble. No presentar esta entrega como certificación de producción.

