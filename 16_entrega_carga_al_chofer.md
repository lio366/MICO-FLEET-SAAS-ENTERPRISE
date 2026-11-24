# CÓMO LLEGA LA CARGA AL CHOFER — Flujo completo de entrega

## LAS 3 VÍAS POR LAS QUE EL CHOFER RECIBE LA CARGA
Se envían las 3 al mismo tiempo. Si una falla, las otras dos ya llegaron.
El chofer NO necesita entrar a DAT ni hablar inglés. Todo le llega en español.

| Vía | Qué recibe el chofer | Tecnología |
|---|---|---|
| 1. **WhatsApp/SMS** | Mensaje con todos los datos de la carga | WhatsApp Business API (Twilio) |
| 2. **Notificación push** | Aviso en la app con botón "Ver carga" | Firebase Cloud Messaging (archivo 05) |
| 3. **Pantalla en la app** | La carga aparece en su lista con botón ACEPTAR | App del conductor (archivo 03) |

## MENSAJE QUE RECIBE EL CHOFER (ejemplo real)
```
🔔 NUEVA CARGA ASIGNADA — Camión #3

📦 Carga:  Pallets de productos secos (no peligrosa)
🗺️ Ruta:   Miami, FL  →  Atlanta, GA
🛣️ Millas: 662
💰 Pago:   $1,950 ($2.95/milla) ✅ Buen precio
📅 Recoger: HOY 2:00 PM
📍 Dirección: 4500 NW 74 Ave, Miami, FL 33166
   Contacto: Mike — (555) 123-4567
📅 Entregar: MAÑANA 10:00 AM
📍 Dirección: 2100 Bolton Rd NW, Atlanta, GA 30318

[FOTOS DE DOCUMENTOS]  [INICIAR NAVEGACIÓN]  [ACEPTAR]  [RECHAZAR]
```

## FLUJO PASO A PASO (qué pasa en cada segundo)

```
1. La IA cierra la carga (negoció en inglés, broker firmó con 1 clic)
        ↓
2. El sistema busca el mejor camión disponible
   (motor espacial archivo 14 + red neuronal archivo 15)
        ↓
3. Se envía el mensaje al chofer por las 3 vías (5 segundos)
        ↓
4. EL CHOFER TOCA "ACEPTAR" (obligatorio — sin eso no hay carga)
        ↓
5. El chofer recibe:
   • Documentos de la carga (rate confirmation traducida al español)
   • Botón de navegación (Google Maps/Waze ya con la dirección)
   • Checklist: "Antes de salir: papeles del camión ✓ seguro ✓ ELD ✓"
        ↓
6. En la recogida: el chofer toca "LLEGÉ" → toma 2 fotos
   (papel firmado + mercancía cargada) → se envían al broker al instante
        ↓
7. En la entrega: toca "ENTREGUÉ" → 2 fotos del POD
   (Proof of Delivery) → el sistema factura al shipper SOLO
   y avisa al broker: "Entregada. Factura enviada: $1,950"
```

## REGLAS DE SEGURIDAD DEL FLUJO
- **Nada se confirma sin el ACEPTAR del chofer.** La IA negocia y prepara,
  pero el humano con el camión tiene la última palabra.
- Si el chofer **no responde en 15 minutos**, el sistema avisa al broker:
  "Camión #3 no confirmó. ¿Reasigno a otro chofer?" → el broker toca SÍ y
  la carga salta al siguiente camión disponible (la red neuronal ya sabe cuál).
- Si el chofer rechaza, la IA registra el motivo (peso, zona, horario) y
  **aprende** para no ofrecerle cargas así otra vez (archivo 15).
- Todo lo que el shipper escriba en inglés le llega al chofer traducido.

## LO QUE VE CADA PERSONA
| Persona | Lo que ve |
|---|---|
| **Broker** | "Carga asignada a Juan (Camión #3). Aceptó hace 2 min." |
| **Chofer** | El mensaje de arriba + botones: Aceptar / Navegar / Fotos |
| **Shipper** | Todo en inglés, profesional, sin saber que hay IA de por medio |

## ESTADO DE LA CARGA EN LA BASE DE DATOS
```
OFFERED  → el mensaje salió al chofer
ACCEPTED → el chofer tocó ACEPTAR
PICKED_UP → fotos de recogida tomadas
DELIVERED → POD entregado, factura enviada
PAID      → el shipper pagó, se acredita al broker
```
Cada cambio de estado dispara el aviso automático al broker por WhatsApp.
