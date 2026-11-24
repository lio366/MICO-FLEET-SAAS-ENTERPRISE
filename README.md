# server/services/ — ADAPTADORES A TERCEROS

Cada integración externa vive aquí como UN archivo con la misma forma:
recibe credenciales del tenant, expone funciones pequeñas, traduce errores a
español simple. Si un proveedor cambia o se cae, solo se toca SU archivo.

| Archivo (a crear al conectar) | Proveedor | Para qué |
|---|---|---|
| `dat_board.js` | DAT / Truckstop (API del tenant) | Buscar y postear cargas (archivos 29/07) |
| `twilio_client.js` | Twilio | SMS, WhatsApp, llamadas de voz (17/38/45) |
| `stripe_client.js` | Stripe | Suscripciones y cobros (03) — ya probado |
| `quickbooks_client.js` | Intuit QuickBooks | Facturación (18) |
| `openrouter_client.js` | OpenRouter | gpt-4o-mini, nube (25) |
| `fmcsa_client.js` | FMCSA API | Verificación carrier (33) |
| `eia_client.js` | EIA | Precio diésel (20) |
| `open_meteo_client.js` | Open-Meteo / NWS | Clima en ruta (35) |

Regla: ningún archivo fuera de `services/` habla con un proveedor directo.
Los módulos 17/20/25/33/35/38/45 llaman al adaptador, nunca a la API cruda.
