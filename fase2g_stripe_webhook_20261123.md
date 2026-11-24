# Fase 2g — Webhook de Stripe exactamente-una-vez (E-040)

- **Fecha:** 2026-11-23
- **Commit del código probado:** `ea6ce62` (los commits posteriores de esta fase solo añaden el grupo G16 a la suite 39, documentación y evidencia)
- **Entorno:** PostgreSQL 16.15 nativo (clúster desechable, SCRAM, roles separados, RLS forzado), Node 22.23.5, driver de validación `tools/pg-compat` (el registro npm no es accesible: `pg`, `express` y `stripe` oficiales no instalados)
- **Evidencia:** `informes/evidencia_fase2g_stripe_20261123/` (`SHA256SUMS`)

## Requisitos de la autorización y cómo se cumplen

| Requisito | Implementación | Prueba |
|---|---|---|
| Instanciar correctamente `BillingService` | `crearManejadorStripe` crea `new BillingService(db)` una vez por servidor; `handleWebhook` sobre la clase desaparece; `aplicarEvento(client, tenantId, evento)` | T20a–f (manejador real); el gate de contratos ya no tiene la excepción E-040 |
| Firma Stripe sobre el cuerpo HTTP original | `server/api/stripe_firma.js`: HMAC-SHA256 de `t.cuerpo_crudo`, tolerancia 300 s, varias `v1`, varios secretos, tiempo constante; 400 antes de tocar la BD | T20a (secreto equivocado, cuerpo alterado, cuerpo re-serializado, firma caducada, cuerpo ausente, cabecera inválida → 400 sin filas; sin secreto → 503; rotación → 200); G16 (7 casos, incluido el cálculo independiente del HMAC); mutaciones `firma_stripe_no_verificada`, `firma_stripe_sin_tolerancia` |
| Cada `event.id` con restricción única en PostgreSQL | `stripe_eventos.id` clave primaria (migración 007), con RLS por empresa | T20b, T20d, T20e |
| Duplicados sin duplicar pagos | duplicado detectado por `stripe_eventos` (PROCESADO/IGNORADO); además un SUCCEEDED por factura (índice único parcial) para dos eventos distintos de la misma factura | T20b: 9 entregas simultáneas en 3 réplicas → 1 aplicada, 1 pago, 1 asiento; `invoice.paid` + `invoice.payment_succeeded` → 1 pago. Mutaciones `stripe_sin_deduplicacion`, `stripe_pago_sin_unicidad_por_factura` |
| Suscripción y ledger en una transacción | `ledger.asentar(client, …)` (nuevo en 42, mismas garantías que `registrar`) dentro de la transacción del webhook, junto con suscripción, pago y estado de la empresa | T20d: fallo inyectado al asentar → sin pago, sin suscripción, sin cambio de estado, sin asiento. Mutación `stripe_ledger_fuera_de_transaccion` |
| Reintentos | fallo → ROLLBACK total, `FALLIDO` con `intentos` y `ultimo_error` en transacción aparte, 500; el reintento aplica una vez y deja `intentos = 2` | T20d. Mutaciones `stripe_fallo_no_registrado`, `stripe_error_respondido_como_exito` |
| Eventos fuera de orden | estado solo con `event.created` posterior al último aplicado (`stripe_estado_en`); empate: gana la baja; fin de periodo solo avanza | T20c: baja(300) antes que pago(200), fallo(150), empate active(300) y alta(100); empate inverso; fallo tardío tras pago. Mutaciones `stripe_estado_sin_orden`, `stripe_empate_sin_prioridad_de_baja`, `stripe_periodo_no_monotono` |
| Empresa correcta, nunca `tenant_id` del cliente | solo `tenants.stripe_customer_id` (único); `metadata` no se lee | T20a y T20c (metadata apunta a otra empresa: no la afecta), T20e. Mutación `stripe_empresa_desde_metadata` |
| 2xx si ya fue procesado | duplicado → 200 `{duplicado: true}` | T20b, T20d (tercera entrega), T20e |
| Error recuperable si no terminó | 500 tras fallo; 503 si el cliente aún no está enlazado a una empresa o falta el secreto | T20a, T20d. Mutación `stripe_cliente_desconocido_aceptado` |

También corregido en 03, por depender de él la atribución: `createSubscription` guarda el enlace con el cliente antes de cobrar, usa claves de idempotencia de Stripe y registra `stripe_subscription_id`; `changePlan` ya no llama a un método inexistente (`getStripeSubscriptionId` implementado).

## Resultados

| Gate | Resultado |
|---|---|
| T1–T19 + T20 + auditoría SQL, 3 corridas consecutivas | 3/3 exit 0; T20 6/6 en cada una |
| Auditoría SQL | 170 sentencias (160 antes), 0 hallazgos nuevos |
| Mutaciones | 59/59 detectadas (13 nuevas), 0 sobreviven, 0 errores de entorno |
| Suite 39 / suite 26 | 92/92 / 70/70 |
| `node --check` | 67 archivos, 0 errores |
| `node tools/inventario.js` | exit 0; 4 excepciones (E-040 retirada) |

## No ejecutado

- Parser `express.json` con `verify` que rellena `req.rawBody` en el servidor real (E-027): `express` no instalado.
- Entregas reales de Stripe (Stripe CLI o endpoint de prueba) y `createSubscription`/`changePlan` contra la API de Stripe.
- `pg` oficial en lugar de `pg-compat`.
- La mutación `stripe_pago_sin_unicidad_por_factura` se detecta porque `ON CONFLICT` deja de tener índice (500), no por un pago duplicado observado.

## Límite de diseño

Dos eventos de la misma suscripción con el mismo `event.created` (segundo) y estados no terminales distintos conservan el que se aplicó primero (D-025). Una conciliación periódica contra la API de Stripe lo cerraría; no forma parte de esta fase.
