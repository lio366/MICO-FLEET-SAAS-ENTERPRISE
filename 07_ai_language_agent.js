/**
 * AGENTE DE IA BILINGÜE — Tu negociador de cargas que habla inglés por ti
 *
 * PROBLEMA QUE RESUELVE:
 *   El broker hispanohablante tiene que entrar a DAT, leer en inglés,
 *   negociar tarifas por teléfono/correo en inglés. No domina el idioma
 *   y pierde cargas buenas por no negociar bien.
 *
 * SOLUCIÓN:
 *   La IA hace TODO el contacto en inglés. El broker solo ve todo en
 *   español y aprueba con un toque. Nunca escribe ni habla inglés.
 *
 * Qué hace este agente:
 *   1. LEE las cargas de DAT/Truckstop y te las resume en ESPAÑOL
 *   2. NEGOCIA la tarifa por correo/chat en inglés, con tope que TÚ fijas
 *   3. TRADUCE cualquier mensaje del shipper al español al instante
 *   4. CONFIRMA la carga y te avisa: "Carga asegurada, $2,400, Miami→Atlanta"
 */
const OpenAI = require('openai');
const EnrutadorIA = require('./25_enrutador_modelos');
const enrutador = new EnrutadorIA();   // Ollama gratis → OpenRouter → OpenAI

class AiLanguageAgent {

    /**
     * PASO 1 — El broker ve la carga en ESPAÑOL
     * La IA traduce y resume cada carga candidata en 2 líneas claras
     */
    async explainLoadInSpanish(load, driverName) {
        const prompt = `Eres asistente de un despachador hispanohablante de camiones en USA.
Resume esta carga en español simple, máximo 3 líneas. Incluye: origen→destino,
millas, tarifa, $/milla, tipo de equipo, fecha de carga, y si es buen precio
(compara con el promedio de $2.30/milla del corredor). Sé directo, sin tecnicismos.

CARGA: ${JSON.stringify(load)}
CONDUCTOR: ${driverName}`;

        // Traducir/resumir es tarea local: Ollama lo hace GRATIS si puede
        const r = await enrutador.completar('traducir', prompt);
        return r.texto;
    }

    /**
     * PASO 2 — La IA NEGOCIA en inglés por ti
     * El broker escribe en español (o solo fija su precio mínimo) y la IA
     * redacta la contraoferta profesional en inglés hacia el shipper/broker.
     *
     * @param {object} negociacion - {load, ofrecido, minimoAceptado, estilo}
     * @returns {object} - {mensaje_en_ingles, resumen_en_espanol, aceptar: boolean}
     */
    async negociarCarga(negociacion) {
        const { load, ofrecido, minimoAceptado, estilo = 'firme pero profesional' } = negociacion;

        const prompt = `You are a professional freight dispatcher negotiating a load rate
on behalf of an independent trucking company. Write a short negotiation message
in English, style: ${estilo}. Do NOT accept below the minimum.
- Load: ${load.originCity},${load.originState} -> ${load.destCity},${load.destState}
- Miles: ${load.miles} | Their offer: $${ofrecido} | Minimum we accept: $${minimoAceptado}
- Target: ask $${Math.round(minimoAceptado * 1.15)} to leave room to settle.
Write ONLY the message body, max 4 sentences, professional tone.`;

        // Negociar sí exige calidad de nube: OpenRouter gpt-4o-mini (~$0.0004)
        const r = await enrutador.completar('negociar', prompt, { forzarNube: true });
        const mensaje_en_ingles = r.texto;

        // El resumen para el broker vuelve a ser tarea local (gratis)
        const resumen = await enrutador.completar('resumen_corto',
            `Traduce y resume en 1 línea de español simple qué dice este mensaje: "${mensaje_en_ingles}"`);

        return {
            mensaje_en_ingles,
            resumen_en_espanol: resumen.texto,
            precio_pedido: Math.round(minimoAceptado * 1.15),
            precio_minimo: minimoAceptado
        };
    }

    /**
     * PASO 3 — Cualquier mensaje que llegue EN INGLÉS, el broker lo recibe EN ESPAÑOL
     * Funciona con correos del shipper, mensajes de la app de DAT, SMS
     */
    async traducirParaBroker(mensajeIngles) {
        const r = await enrutador.completar('traducir',
            `Traduce al español simple de negocios (el usuario no habla inglés).
Si es una oferta de precio, indica el número claramente. Mensaje: "${mensajeIngles}"`);
        return r.texto;
    }

    /**
     * PASO 4 — Respuestas rápidas: el broker toca un botón, la IA escribe en inglés
     * Botones pre-hechos: "Aceptar", "Pide $200 más", "Pregunta por el peso", "Rechaza"
     */
    async respuestaRapida(tipo, contexto = {}) {
        const plantillas = {
            aceptar: `Please confirm the load at $${contexto.precio}. We can pick up at ${contexto.hora}. Thank you.`,
            pedir_mas: `Thank you for the offer. Given the miles and current market, we can do this for $${contexto.precio}. Please advise.`,
            preguntar_peso: `Before confirming, could you confirm the total weight and if there are any additional stops?`,
            rechazar: `Thank you for the opportunity, but we'll have to pass on this one at this rate. Please keep us in mind for future loads.`
        };
        const en_ingles = plantillas[tipo] || '';

        const traduccion = await this.traducirParaBroker(en_ingles);
        return { enviar_en_ingles: en_ingles, que_dice_en_espanol: traduccion.texto || traduccion };
    }

    /**
     * MODO PILOTO AUTOMÁTICO — La IA negocia sola dentro de tus reglas
     * El broker configura una vez: "Nunca aceptes menos de $2.10/milla" y la IA:
     *   - Recibe la oferta
     *   - Contraoferta hasta 2 veces si vale la pena
     *   - Acepta automáticamente si llega al mínimo
     *   - Te notifica en español cada movimiento por WhatsApp/SMS
     */
    async modoPilotoAutomatico(load, reglas) {
        let oferta = load.rate;
        const minimo = reglas.precioMinimoMilla * load.miles;
        const historial = [];

        for (let ronda = 0; ronda < 2; ronda++) {
            if (oferta >= minimo) break;
            const contrapropuesta = Math.min(oferta + reglas.incrementoPorRonda, Math.round(minimo * 1.1));
            historial.push({ ronda: ronda + 1, pedimos: contrapropuesta });
            // En producción: aquí se envía por email/chat de DAT y se espera respuesta
            oferta = contrapropuesta; // simulado
        }

        const aceptada = oferta >= minimo;
        return {
            aceptada,
            precio_final: aceptada ? oferta : null,
            notificacion_para_el_broker: aceptada
                ? `✅ Carga asegurada: ${load.originCity} → ${load.destCity} por $${oferta} (${(oferta/load.miles).toFixed(2)}/milla). Todo negociado en inglés por la IA.`
                : `❌ No llegaron a tu precio mínimo ($${Math.round(minimo)}). La carga se dejó pasar. Buscaré otra similar.`,
            historial_negociacion: historial
        };
    }
}

module.exports = AiLanguageAgent;
