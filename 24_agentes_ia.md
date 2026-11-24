# LOS 7 AGENTES DE IA DEL SISTEMA — Autonomía, límites y horario

## RESUMEN EN UNA FRASE
7 agentes de IA trabajan SOLOS las 24 horas, los 7 días, dentro de las reglas
que el broker fija UNA VEZ. Ninguno las rompe jamás. El humano solo firma (1 clic)
y decide imprevistos físicos. Por eso el sistema es 95% automático.

## LOS AGENTES

| # | Agente | Archivo | Qué hace SOLO, 24/7 |
|---|---|---|---|
| 1 | **Buscador de cargas** | 01 + 08 | Revisa DAT/Truckstop cada 10 min por cada camión; si DAT cae, cambia solo a Truckstop |
| 2 | **Ojo espacial** | 14 | Ubica cada camión en el mapa y halla las cargas a menos de 150 millas en milisegundos |
| 3 | **Cerebro neuronal** | 15 | Predice qué carga aceptará cada chofer y aprende de cada SÍ/NO; se reentrena solo cada 30 decisiones |
| 4 | **Negociador bilingüe** | 07 | Negocia el precio en inglés con el shipper, traduce todo al español, redacta correos profesionales |
| 5 | **Despachador automático** | 08 + 11 | Filtra por reglas (mínimo $/milla, zonas NO, horario), descarta la que pierde dinero con el diésel (20) y envía la oferta al chofer |
| 6 | **Voz** | 19 | Atiende llamadas de shippers, negocia hablando, y manda al broker el resumen en español |
| 7 | **Cobrador y contador** | 03 + 18 + 22 | Cobra la renta al broker (Stripe), factura al shipper (QuickBooks), concilia pagos y arma el reporte del IRS cada trimestre |

## SUS 5 REGLAS DE ORO (ningún agente las puede romper)
1. **Precio mínimo por milla del broker** — jamás acepta abajo de eso.
2. **Zonas prohibidas** — jamás ofrece cargas a estados que el broker vetó.
3. **Nada se confirma sin el SÍ del humano** — firma (1 clic) o SMS "1".
4. **Todo queda registrado** — cada decisión de la IA queda en la base de datos (auditable).
5. **Si duda, pregunta** — si algo sale de lo normal, avisa al broker y espera. Nunca improvisa fuera de sus reglas.

## HORARIO REAL DE UN DÍA (sin que nadie toque nada)
```
00:00–06:00  Agente 1 y 2 vigilan tableros y mapa. Camiones descansan (HOS).
07:00        Agente 5 envía ofertas por WhatsApp. Broker firma con 1 clic.
07:02        Agente 4 negocia en inglés. Cierra +$150 de alza.
08:00        Agente 7 manda el resumen del día anterior a cada broker.
09:15        Chofer sin datos: agente 5 activa SMS; el chofer responde "1".
14:00        Entrega: agente 7 factura al shipper sola y agenda el cobro a 30 días.
18:30        Agente 6 atiende una llamada del shipper, negocia y resume en español.
22:00        Agente 3 reentrena la red neuronal con las decisiones del día.
02:00        Agente 7 concilia pagos y marca facturas vencidas (alerta factoring).
```

## QUÉ NO HACEN LOS AGENTES (y nunca harán solos)
- Firmar documentos legales (la ley exige persona real).
- Decidir ante un accidente, carga dañada o camión descompuesto (avisarán y sugerirán, pero el humano decide).
- Cambiar las reglas del broker (solo el broker las cambia, desde su panel).

## COSTO DE TENER 7 AGENTES TRABAJANDO 24/7
$0.42 centavos por cada 100 decisiones de IA. Un broker activo les cuesta
menos de $0.50 al mes. Verificado en la prueba de estrés (archivo 23).
