# MICRO-FLEET SAAS ENTERPRISE v3.0 — Plan de Negocio y Operación

## La idea en una frase
Ya no vendes el software una vez: lo **rentas todos los meses** a brokers de carga, y ellos lo usan con su propia marca y sus propios camioneros.

## Los 3 planes (qué cobras cada mes)

| Plan | Precio/mes | Camiones | Usuarios | Para quién |
|---|---|---|---|---|
| **Starter** | $299 | 10 | 3 | Broker pequeño, 1 oficina |
| **Pro** | $799 | 50 | 10 | Broker creciente, varios despachadores |
| **Enterprise** | $1,999 | 200 | 50 | Broker grande, flota completa |

Todos incluyen: prueba gratis de 14 días, IA de asignación de cargas, notificaciones, reportes.

## La matemática del negocio (cuánto ganas tú)

- 10 brokers en Starter = **$2,990/mes**
- 10 brokers en Pro = **$7,990/mes**
- 5 brokers en Enterprise = **$9,995/mes**
- **Total con 25 clientes: ~$20,000/mes = $240,000/año** recibiéndose solo

El costo de atender a 1 broker o a 100 es casi el mismo. Ese es el poder del SaaS.

## Cómo entra un cliente nuevo (sin que tú trabajes)

1. Llega a tu página → se registra solo → prueba 14 días gratis
2. Carga sus camioneros y empieza a despachar
3. Al día 14, si no puso tarjeta, se pausa solo
4. Si pagó, Stripe cobra cada mes automáticamente
5. Si un pago falla, tiene 7 días de gracia y luego se suspende solo

**Tú no cobras facturas. El sistema cobra solo.**

## Qué recibe cada broker (su "piso" privado)

- Su propia dirección web: `subroker.tuapp.com` o `dispatch.subroker.com`
- Su logo y su color en la app (white-label)
- Sus camioneros, sus cargas, sus reportes — **nadie más los ve**
- Panel de control: agregar camiones, usuarios, ver cuánto ganó la app por él

## Seguridad entre clientes (aislamiento total)

- Cada dato lleva una etiqueta del broker al que pertenece
- La base de datos rechaza cualquier consulta que cruce de un broker a otro
- Aunque un broker sea hacker, no puede ver los datos de otro

## Costos mensuales tuyos (qué te cuesta operar)

| Concepto | Costo/mes |
|---|---|
| Servidor (soporta 100+ brokers) | $200 |
| Base de datos administrada | $100 |
| Stripe (cobros) | 2.9% de cada pago |
| Correos (SendGrid) | $20 |
| DAT API (compartida, con límite por broker) | $500 |
| **Total fijo** | **~$820/mes** |

Con 25 clientes gastas $820 y entran $20,000. Margen de **96%**.

## Hoja de ruta a los primeros $10,000/mes

| Fase | Tiempo | Meta |
|---|---|---|
| 1. Fundamentos | Semanas 1-4 | Multi-tenant + Stripe funcionando |
| 2. Primer piloto | Semanas 5-8 | 3 brokers reales usando la app gratis a cambio de feedback |
| 3. Primeros pagos | Mes 3 | 10 brokers pagando |
| 4. Escalar | Mes 4-6 | 25-40 brokers, contratar 1 persona de soporte |

## Qué se necesita legalmente

- LLC ya la tienes (TOUR 567 LLC) — opera el SaaS bajo la misma
- Términos de servicio y política de privacidad (abogado, ~$1,500 una vez)
- Acuerdo de procesamiento de datos si manejas datos de conductores
- Contratos con DAT/Truckstop verificados para revender el acceso
