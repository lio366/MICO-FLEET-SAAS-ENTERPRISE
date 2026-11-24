# Fase 2d: webhooks de Twilio bajo RLS (E-025, E-026, E-027)

**Fecha de ejecución:** 2026-11-23 (17:15–17:55 UTC)
**Commit evaluado:** `b86a250` (rama `fase2/pg-real-t1-t7`), árbol limpio
**Evidencia:** `informes/evidencia_fase2d_e025_webhooks_20261123/` (hashes en `SHA256SUMS`)

## Veredicto

| Gate | Estado |
|---|---|
| T1–T7 · T8–T13 · T14–T16 · T17 | PASS 7/7 · 6/6 · 3/3 · 1/1 (pg-compat), 3 de 3 corridas limpias en `b86a250` |
| Mutaciones de integración | 28/28 detectadas (`mutaciones_pg.py`, exit 0) |
| Suites 26 / 39 | 70/70 · 76/76 |
| `node --check` | 59 archivos, 0 errores |
| E-025 webhook SMS sin contexto de tenant | **CERRADO** |
| E-026 webhooks de Twilio sin verificación de firma | **CERRADO** |
| E-027 firma de Stripe sobre JSON re-serializado | **CORREGIDO, NOT RUN** (requiere `express` y `stripe` instalados) |
| Parsers de cuerpo de Express | **CORREGIDO, NOT RUN** (sin `express` en el entorno) |

## Lo que se encontró

E-025 se había registrado como "el webhook consulta sin contexto de tenant". Al revisarlo apareció algo más grave: **ninguno de los dos webhooks de Twilio podía funcionar, y ninguno estaba autenticado.**

1. **`/webhooks/sms`:** llamaba a `17_sms_emergencia.procesarRespuesta()`, una función que no existía (17 exportaba un router de Express que nadie montaba). Toda petición terminaba en un `TypeError`.
2. **`/webhooks/voz/decision`:** pasaba un Pool a `38.webhookDecision`, que espera un adaptador con `obtenerBooking`, `confirmarBooking` y `rechazarYReasignar`. Ninguno existía.
3. **Formato del cuerpo:** el gateway solo tenía `express.json`. Twilio envía `application/x-www-form-urlencoded`, así que `From` y `Body` llegaban vacíos.
4. **E-026, sin firma:** `/sms` y `/voz/decision` no verificaban `X-Twilio-Signature`. Quien conociera el teléfono de un chofer podía aceptar o rechazar cargas en su nombre con un POST.
5. **E-025 tal como estaba registrado:** con RLS forzado, el rol runtime no puede buscar al chofer por teléfono antes de conocer la empresa. Además, al rechazar una oferta, la carga quedaba en `OFFERED` y no se podía reasignar.
6. **E-027, Stripe:** `webhooks.js` usaba `req.rawBody`, pero nadie lo asignaba. La firma se verificaba sobre `JSON.stringify(req.body)`, que no reproduce los bytes firmados: **todo webhook legítimo de Stripe se habría rechazado**.

## Corrección

- **Migración `004_resolucion_webhooks`:** rol `mf_resolver` (NOLOGIN, **sin** BYPASSRLS, sin login) dueño de dos funciones `SECURITY DEFINER` con `search_path` fijo:
  - `mf_resolver_chofer_por_telefono(text[])`: devuelve solo `(driver_id, tenant_id)` de choferes activos en empresas activas.
  - `mf_resolver_reserva(uuid)`: devuelve solo `(tenant_id, driver_id)`.

  Tiene políticas de **solo lectura** para ese rol y SELECT por columnas (sin `email` ni datos de negocio). `EXECUTE` solo para `mf_app`, revocado para PUBLIC. Todo lo demás corre con `app.current_tenant` fijado.
- **`46.responderOfertaUnaVez`:** acepta o rechaza exactamente una vez (Twilio reintenta) y, al rechazar, devuelve la carga a `AVAILABLE` en la misma transacción.
- **`server/services/ofertas.js`:** normaliza teléfonos (E.164 frente a 10 dígitos). Si un mismo teléfono trabaja para varias empresas, elige la oferta pendiente más reciente. Incluye el adaptador de voz para 38.
- **`17_sms_emergencia` v7.1:** `procesarRespuesta()` devuelve un estado y TwiML escapado. A números desconocidos no se les revela nada.
- **`38`:** si la reserva es desconocida o ya se respondió, contesta "ya no está disponible" en lugar de anunciar una aceptación.
- **`server/api/twilio_firma.js`:** algoritmo documentado por Twilio. **Reproduce el ejemplo oficial** (`L/OH5YylLD5NRKLltdqwSvS0BnU=`, verificado en esta sesión contra https://www.twilio.com/docs/usage/security). La URL se toma de `TWILIO_WEBHOOK_BASE_URL`, nunca de las cabeceras Host. Sin configuración responde 503, y con firma inválida 403, siempre antes de tocar la BD.
- **`40_api_gateway`:** guarda el cuerpo crudo para Stripe y añade el parser `urlencoded` para Twilio.

## T17 (PostgreSQL real, rol runtime bajo RLS)

Peticiones firmadas, como las de Twilio, pasan por `exigirFirmaTwilio` y luego por los manejadores reales de `webhooks.js`:

- sin el resolvedor, el rol runtime no ve choferes;
- sin firma, firma calculada para otra URL o sin token: 403/503, **sin efectos en la BD**;
- aceptación por SMS con teléfono en otro formato; un reintento no cambia nada; una ráfaga de 5 SMS idénticos produce una sola confirmación;
- rechazo en otra empresa con el mismo teléfono: libera la carga, pide reasignar y la carga se puede volver a ofertar;
- con ofertas pendientes en dos empresas se responde la más reciente (caso determinista; ver abajo);
- una respuesta no entendida devuelve instrucciones sin cambios;
- empresa suspendida, chofer inactivo, número desconocido e intento de inyección: ignorados;
- voz firmada: el rechazo libera la carga; la repetición o una reserva desconocida no confirman nada; voz sin firma: 403;
- mínimo privilegio verificado en catálogo: funciones `SECURITY DEFINER` propiedad de `mf_resolver`, sin `BYPASSRLS`, sin login, sin UPDATE, sin acceso a `email`, y la función expone solo 2 columnas.

**Límite:** T17 no ejecuta el parser de Express ni el enrutado HTTP real (Express no está instalado); las peticiones llegan ya decodificadas. La corrección de Stripe (E-027) tampoco se ejecutó, por la misma razón y por falta del SDK.

## Mutaciones: 28/28

Seis nuevas: firma no verificada, resolvedor `SECURITY INVOKER`, resolvedor que acepta empresas suspendidas, rechazo que no libera la carga, respuesta sin condición `OFFERED` y SMS que responde la oferta antigua.

**Hallazgo de calidad en la propia prueba:** la primera versión del caso "oferta más reciente" ponía siempre la oferta antigua en la empresa A. Como el resolvedor ordena por `tenant_id` (UUID aleatorio), la mutación `sms_responde_oferta_antigua` se habría detectado solo la mitad de las veces. T17 coloca ahora la oferta antigua en la empresa que el resolvedor devuelve primero, así que la detección es determinista. Es el mismo patrón que se corrigió en T13 (fase 2b).

## Configuración nueva requerida

- `TWILIO_WEBHOOK_BASE_URL`: URL pública exacta con la que Twilio llama a los webhooks.
- `TWILIO_TOKEN`: Auth Token principal de Twilio (ya existía).
- Rol administrativo con CREATEROLE para la migración 004.
