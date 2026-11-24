/**
 * ENRUTADOR DE MODELOS DE IA — La billetera de los 7 agentes
 *
 * PROBLEMA: si los 7 agentes usan OpenAI directo para todo, el costo crece
 * con el volumen. La prueba de estrés lo midió: pico de 500 camiones ≈ $20/mes
 * de IA. Poco... pero se puede reducir a CASI CERO.
 *
 * SOLUCIÓN (3 niveles, del más barato al más caro):
 *   1. OLLAMA (local, en tu servidor): $0.00 — resuelve lo rutinario:
 *      traducir mensajes, clasificar rechazos, formatear resúmenes,
 *      decidir si un SMS es "1" o "2", redactar confirmaciones cortas.
 *   2. OPENROUTER + gpt-4o-mini: ~$0.0004 por llamada — solo para lo que
 *      exige negociación fina: contraofertas, llamadas de voz, resúmenes
 *      importantes del broker.
 *   3. OPENAI directo: respaldo si los dos anteriores caen.
 *
 * REGLA DE ORO: si Ollama responde con confianza (puntuación > 0.8),
 * no se gasta NI UN CENTAVO en la nube. La nube solo se usa cuando el
 * modelo local duda.
 */
const axios = require('axios');

class EnrutadorIA {
    constructor() {
        this.OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
        this.MODELO_LOCAL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
        this.OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
        this.OPENAI_KEY = process.env.OPENAI_API_KEY;

        // Contador de gasto por agente (se puede ver en /admin/ia-costos)
        this.gasto = { ollama_gratis: 0, openrouter_cents: 0, openai_cents: 0 };

        // Qué tareas pueden resolverse 100% locales (baratas) y cuáles no
        this.TAREAS_LOCALES = [
            'traducir', 'clasificar_rechazo', 'resumen_corto',
            'confirmacion_corta', 'parsear_sms', 'formatear_whatsapp'
        ];
    }

    /**
     * PUNTO ÚNICO DE ENTRADA — todos los agentes llaman aquí, nunca a OpenAI directo.
     *
     * @param {string} tarea  - tipo de tarea (ver TAREAS_LOCALES)
     * @param {string} prompt - instrucción completa
     * @param {object} opts   - { forzarNube: bool, maxTokens: int }
     */
    async completar(tarea, prompt, opts = {}) {
        // NIVEL 1: Ollama local — gratis, sin límite de llamadas
        if (!opts.forzarNube && this.TAREAS_LOCALES.includes(tarea)) {
            try {
                const resp = await this.ollama(prompt, opts.maxTokens || 300);
                if (resp.confianza > 0.8) {
                    this.gasto.ollama_gratis++;
                    return { texto: resp.texto, origen: 'ollama', costo_usd: 0 };
                }
                // confianza baja → cae al nivel 2 (la nube decide mejor)
            } catch (e) { /* Ollama apagado o saturado: cae a la nube */ }
        }

        // NIVEL 2: OpenRouter + gpt-4o-mini (la opción barata de nube)
        try {
            const texto = await this.openRouter(prompt, opts.maxTokens || 400);
            this.gasto.openrouter_cents += 0.042; // ~$0.00042 por llamada típica
            return { texto, origen: 'openrouter-gpt4o-mini', costo_usd: 0.00042 };
        } catch (e) { /* cae al respaldo */ }

        // NIVEL 3: OpenAI directo (solo emergencia)
        const texto = await this.openai(prompt, opts.maxTokens || 400);
        this.gasto.openai_cents += 0.055;
        return { texto, origen: 'openai-respaldo', costo_usd: 0.00055 };
    }

    /**
     * NIVEL 1 — Ollama corriendo en el mismo servidor. $0, ilimitado.
     * Se instala una vez: curl -fsSL https://ollama.com/install.sh | sh
     */
    async ollama(prompt, maxTokens) {
        const r = await axios.post(`${this.OLLAMA_URL}/api/generate`, {
            model: this.MODELO_LOCAL,
            prompt,
            stream: false,
            options: { temperature: 0.2, num_predict: maxTokens }
        }, { timeout: 15000 });

        const texto = r.data.response?.trim() || '';
        // Confianza simple: respuesta no vacía y de largo razonable = confiable
        const confianza = texto.length > 10 && !texto.includes('error') ? 0.9 : 0.5;
        return { texto, confianza };
    }

    /**
     * NIVEL 2 — OpenRouter. Un solo API key, acceso a cientos de modelos.
     * Aquí usamos gpt-4o-mini: el mejor precio/calidad para negociar.
     */
    async openRouter(prompt, maxTokens) {
        const r = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'openai/gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.3
        }, {
            headers: { Authorization: `Bearer ${this.OPENROUTER_KEY}` },
            timeout: 20000
        });
        return r.data.choices[0].message.content.trim();
    }

    /**
     * NIVEL 3 — OpenAI directo (respaldo final)
     */
    async openai(prompt, maxTokens) {
        const r = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.3
        }, {
            headers: { Authorization: `Bearer ${this.OPENAI_KEY}` },
            timeout: 20000
        });
        return r.data.choices[0].message.content.trim();
    }

    /**
     * Reporte de gasto en vivo: cuánto ahorró Ollama este mes
     */
    getReporteGasto() {
        return {
            ...this.gasto,
            ahorro_estimado_usd: this.gasto.ollama_gratis * 0.00042,
            mensaje: `Ollama resolvió gratis ${this.gasto.ollama_gratis} tareas. ` +
                     `La nube solo costó $${(this.gasto.openrouter_cents + this.gasto.openai_cents).toFixed(2)}.`
        };
    }
}

module.exports = EnrutadorIA;
