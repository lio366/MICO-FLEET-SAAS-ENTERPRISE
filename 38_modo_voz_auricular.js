// ============================================================================
// 38_modo_voz_auricular.js — EL CHOFER NUNCA TOCA EL TELÉFONO
// Versión 5.2
//
// EL PROBLEMA DEL SECTOR: el chofer maneja con auricular Bluetooth MONO
// (BlueParrott, 24h de batería) y por ley FMCSA no puede tocar el teléfono.
// Las notificaciones normales de las apps suenan por el altavón del camión
// o no suenan — el chofer tiene que MIRAR la pantalla. DAT, Trucker Path y
// MacroPoint no resuelven esto en español.
//
// LA SOLUCIÓN (3 piezas):
//   A. LLAMADA DE VOZ CON LA OFERTA — Twilio llama al auricular como si
//      fuera una llamada normal: la IA habla en español, escucha "uno/dos".
//      Entra por el auricular automáticamente. ~$0.02 por llamada.
//   B. BOTÓN DEL AURICULAR = AGENTE IA (push-to-talk) — el BlueParrott tiene
//      botón configurable; en Android se enlaza a la app: aprieta y habla.
//   C. RESUMEN HABLADO DEL DÍA + ALERTAS DE SEGURIDAD HABLADAS.
// ============================================================================

const VOICE_ES = {
  saludo: (nombre) => `Hola ${nombre}. Soy tu despachadora.`,
  oferta: (c) => `Nueva carga: de ${c.origen} a ${c.destino}, ${c.millas} millas, ${c.pago} dólares. Diga uno para aceptar, dos para rechazar.`,
  aceptada: `Carga aceptada. Ya le avisé al broker. Que tenga buen viaje.`,
  rechazada: `Entendido. Buscando otra carga para usted.`,
  sinEntender: `No entendí. Diga uno para aceptar o dos para rechazar.`,
  noEncontrada: `Esta oferta ya no está disponible.`,
  resumen: (n, mejor) => `Buenos días. Hay ${n} cargas disponibles cerca de usted. La mejor paga ${mejor.rpm} dólares la milla, de ${mejor.origen} a ${mejor.destino}. Diga asignar la primera si la quiere.`,
  alerta: (t) => `Atención: ${t}`,
  cierre: `¿Algo más? Apriete el botón del auricular cuando necesite hablar conmigo.`
};

// GANCHOS DE INTEGRACIÓN (inyectados al arrancar el server; ver server/index.js):
//   agenteIA       → EnrutadorIA del archivo 25 (Ollama → gpt-4o-mini)
//   enviarPushYSMS → NotificationService del archivo 45 (push → SMS de respaldo)
let agenteIA = null, enviarPushYSMS = null, avisarBroker = null;
function configurar({ agenteIA: a, enviarPushYSMS: e, avisarBroker: ab }) {
  agenteIA = a; enviarPushYSMS = e; avisarBroker = ab || null;
}

// ---------------------------------------------------------------------------
// A. LLAMADA DE VOZ CON LA OFERTA (Twilio <Gather> = escucha "uno/dos")
// El auricular mono entra en "modo llamada" automáticamente: es el único
// canal que suena DIRECTO en el auricular sin trucos del teléfono.
// Costo: ~$0.02 por llamada de 2 min. 30 ofertas/mes = $0.60 por camión/mes.
// ---------------------------------------------------------------------------
async function llamarConOferta(twilio, chofer, carga) {
  if (!chofer.prefiereVoz) {
    if (!enviarPushYSMS) throw new Error('Módulo 38 sin configurar: falta NotificationService (45)');
    return enviarPushYSMS(chofer, carga); // respaldo digital
  }

  const twiml = `
    <Response>
      <Gather input="speech dtmf" language="es-US" timeout="6" numDigits="1" action="/webhook/voz/decision?booking=${carga.bookingId}">
        <Say voice="Polly.Lupe" language="es-US">${VOICE_ES.saludo(chofer.nombre)} ${VOICE_ES.oferta(carga)}</Say>
      </Gather>
      <Say voice="Polly.Lupe" language="es-US">${VOICE_ES.sinEntender}</Say>
      <Redirect>/webhook/voz/repetir?booking=${carga.bookingId}</Redirect>
    </Response>`;

  return twilio.calls.create({
    to: chofer.telefono,
    from: process.env.TWILIO_NUMERO_VOZ,
    twiml,
    // Los auriculares mono suenan TAMBIÉN por el altavón del camión:
    // eso es bueno (el chofer oye aunque el auricular esté cargando).
    record: false
  });
}

// Webhook: la respuesta del chofer (dijo "uno"/"dos" o marcó 1/2)
// db: adaptador con obtenerBooking / confirmarBooking / rechazarYReasignar
// (en producción: server/services/ofertas.crearAdaptadorVoz, que resuelve el tenant y usa
// 46.responderOfertaUnaVez — exactamente una vez y liberando la carga al rechazar).
async function webhookDecision(db, { bookingId, SpeechResult, Digits }) {
  const booking = await db.obtenerBooking(bookingId);
  if (!booking) return twiml(VOICE_ES.noEncontrada); // id desconocido: no revelar nada más
  // Palabras exactas (\b) para no confundir: "no sé qué dijiste" NO es un rechazo.
  const dijoUno = Digits === '1' || /\b(uno|acepto|s[ií])\b/i.test(SpeechResult || '');
  const dijoDos = Digits === '2' || /\b(dos|rechazo|rechaza|no quiero|no acepto)\b/i.test(SpeechResult || '');

  if (dijoUno) {
    const r = await db.confirmarBooking(bookingId);
    if (r && r.respondida === false) return twiml(VOICE_ES.noEncontrada); // ya respondida (reintento de Twilio)
    if (avisarBroker) {
      await avisarBroker(db, booking.tenantId, `✅ ${booking.choferNombre} aceptó POR VOZ (${booking.ruta} $${booking.pago}). Nunca tocó el teléfono.`);
    }
    return twiml(VOICE_ES.aceptada);
  }
  if (dijoDos) {
    const r = await db.rechazarYReasignar(bookingId);
    if (r && r.respondida === false) return twiml(VOICE_ES.noEncontrada);
    return twiml(VOICE_ES.rechazada);
  }
  return twiml(VOICE_ES.sinEntender); // Twilio re-pregunta solo
}

// ---------------------------------------------------------------------------
// B. BOTÓN DEL AURICULAR = HABLAR CON EL AGENTE IA (push-to-talk)
// El BlueParrott (y la mayoría de auriculares mono) tiene un botón físico
// configurable. En Android: el botón dispara MEDIA_BUTTON / intent de la app.
// Aquí: el chofer aprieta, habla en español, la IA responde por el auricular.
// ---------------------------------------------------------------------------
async function botonAuricularPresionado(db, chofer, textoDelChofer) {
  // Llega del SDK del auricular (driver_app lo envía por websocket).
  // La IA entiende español hablado y responde hablando (llamada corta o TTS).
  if (!agenteIA) throw new Error('Módulo 38 sin configurar: falta EnrutadorIA (25). Llamar configurar() al arrancar.');
  const respuesta = await agenteIA.completar('conversacion_chofer', {
    tenant: chofer.tenantId,
    chofer: chofer.id,
    texto: textoDelChofer,
    contexto: 'chofer_manejando', // la IA sabe que está al volante: respuestas cortas
    reglas: [
      'Respuestas de máximo 15 palabras (está manejando)',
      'Solo español, lenguaje de camionero, nada técnico',
      'Si pide una carga, usar el motor neural (archivo 15) y tarifas (archivo 30)',
      'Si pregunta por dinero: decirle cuánto le deben y cuándo paga'
    ]
  });
  await hablarPorAuricular(chofer, respuesta.texto);
  return respuesta;
}

// Preguntas típicas que el botón responde, verificadas con camioneros reales:
//   "¿Cuánto me deben?"         → agente cajero consulta pagos pendientes
//   "¿Dónde paro barato cerca?" → geografía (archivo 35) + diesel (archivo 20)
//   "¿A qué hora entrego?"      → hora local del destino (archivo 35)
//   "¿Y el clima allá?"         → NWS (archivo 35)
//   "Llama a mi esposa"         → módulo familia (archivo 21), manos libres

// ---------------------------------------------------------------------------
// C. RESUMEN HABLADO DEL DÍA + ALERTAS DE SEGURIDAD HABLADAS
// ---------------------------------------------------------------------------
async function resumenHabladoDelDia(db, chofer) {
  const cargas = await db.cargasCercanas(chofer.tenantId, chofer.posicion, 150);
  if (!cargas.length) return hablarPorAuricular(chofer, 'Buenos días. Todavía no hay cargas cerca suyo. Le aviso en cuanto aparezca una buena.');
  const mejor = cargas[0];
  await hablarPorAuricular(chofer, VOICE_ES.resumen(cargas.length, mejor));
}

async function alertaSeguridadHablada(db, chofer, tipo, detalle) {
  const TEXTOS = {
    tormenta: `Atención: ${detalle} en su ruta. Considere parar o cambiar de carretera.`,
    camionDetenido: `Su camión lleva dos horas quieto. ¿Todo bien? Diga asistencia si necesita ayuda.`,
    dieselCaro: `Ojo: el diésel cuesta más en su destino. Le conviene llenar el tanque antes de cruzar.`,
    horaEntrega: `Su entrega en ${detalle.ciudad} cierra a las ${detalle.cierre}. Le quedan ${detalle.horas} horas.`
  };
  await hablarPorAuricular(chofer, TEXTOS[tipo] || VOICE_ES.alerta(detalle));
}

// ---------------------------------------------------------------------------
// Canal de salida: llamada corta de Twilio (garantizado en el auricular)
// o TTS local si el teléfono lo permite. Nunca bloquea si falla.
// ---------------------------------------------------------------------------
async function hablarPorAuricular(chofer, texto) {
  try {
    await twilio.calls.create({ to: chofer.telefono, from: process.env.TWILIO_NUMERO_VOZ,
      twiml: `<Response><Say voice="Polly.Lupe" language="es-US">${texto}</Say></Response>`,
      timeout: 10 }); // si no contesta (manejando y ocupado), no insiste
  } catch (e) {
    await enviarSMS(chofer.telefono, texto.slice(0, 140)); // respaldo: el SMS siempre entra
  }
}

function twiml(texto) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Lupe" language="es-US">${texto}</Say></Response>`;
}

module.exports = { VOICE_ES, configurar, llamarConOferta, webhookDecision, botonAuricularPresionado,
                   resumenHabladoDelDia, alertaSeguridadHablada };
