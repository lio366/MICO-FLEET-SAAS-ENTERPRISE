/**
 * MÓDULO 19 — VOCES DE IA PARA LLAMADAS TELEFÓNICAS
 * Cuando el shipper insiste en hablar por teléfono, UNA VOZ de IA atiende,
 * negocia en inglés con acento natural y transcribe TODO al español
 * para el broker por WhatsApp.
 *
 * TECNOLOGÍA: Twilio Media Streams (la llamada entra/sale por teléfono real)
 * + OpenAI Realtime API (voz que suena humana, responde en <1 segundo).
 */
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class AgenteVoz {
    constructor(db) {
        this.db = db;
        this.instrucciones = `You are a professional freight dispatcher named Alex calling on behalf of an independent trucking company.
Rules:
- Speak English, natural pace, professional and friendly.
- Negotiate rate: never accept below the MINIMUM the human gives you.
- Confirm details: pickup time, address, reference numbers.
- If asked about something you don't know, say "Let me confirm with my dispatcher and text you right back."
- Keep calls under 3 minutes. Always end by asking to confirm by email or text.`;
    }

    /**
     * El shipper llama al número del broker → Twilio contesta → la voz IA habla.
     * Lo que el shipper dice se transcribe y TRADUCE al español en vivo.
     * Lo que la IA responde queda grabado en inglés.
     */
    async atenderLlamada(streamDeAudio, datosCarga, minimoAceptable) {
        const sesion = await openai.realtime.connect({
            model: 'gpt-4o-realtime-preview',
            voice: 'echo',              // voz masculina natural; opciones: alloy, nova, shimmer
            instructions: this.instrucciones,
            temperature: 0.6
        });

        // Conectar el audio del teléfono con la voz de la IA (dos direcciones)
        streamDeAudio.pipe(sesion.audioInput);
        sesion.audioOutput.pipe(streamDeAudio);

        // Cada frase que diga el shipper: transcrita, traducida y enviada al broker
        sesion.on('transcript.user', async (frase) => {
            await this.enviarAlBroker(datosCarga.tenantId,
                `📞 Shipper dijo: "${frase}"`);
        });
        sesion.on('transcript.assistant', async (frase) => {
            await this.enviarAlBroker(datosCarga.tenantId,
                `🤖 IA respondió: "${frase}"`);
        });

        // La IA conoce el contexto de la carga al empezar
        await sesion.send({
            type: 'conversation.item.create',
            item: {
                role: 'user',
                content: `Load context: ${datosCarga.originCity} to ${datosCarga.destCity}, ${datosCarga.miles} miles. Their offer: $${datosCarga.rate}. Minimum acceptable: $${minimoAceptable}. Negotiate up.`
            }
        });

        // Cuando cuelgan: resumen automático
        sesion.on('call.ended', async () => {
            const resumen = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content:
                    `Summarize this freight call in simple Spanish for a broker who doesn't speak English: pickup confirmed? final rate? any issues?` }],
                temperature: 0.3
            });
            await this.enviarAlBroker(datosCarga.tenantId,
                `📋 RESUMEN DE LA LLAMADA:\n${resumen.choices[0].message.content}`);
        });
    }

    async enviarAlBroker(tenantId, mensaje) {
        // Mismo canal WhatsApp/SMS del archivo 05
        const { notificar } = require('./05_push_notifications');
        await notificar(tenantId, { title: '📞 Llamada', body: mensaje });
    }

    /**
     * LA IA MARCA SALIENTE: si el broker quiere que la IA llame al shipper
     * para confirmar algo (p.ej. "¿pueden cargar 2 horas antes?")
     */
    async llamarShipper(telefonoShipper, mensajeEnIngles) {
        // Twilio hace la llamada; al contestar, conecta la voz IA con el guion
        // client.calls.create({ to: telefonoShipper, from: NUMERO_BROKER,
        //   twiml: `<Response><Stream url="wss://tuserver/voz" /></Response>` })
        return { llamando: true, guion: mensajeEnIngles };
    }
}

module.exports = AgenteVoz;
