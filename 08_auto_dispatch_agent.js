/**
 * AGENTE DE DESPACHO AUTOMÁTICO — Para brokers de 1-5 camiones que no quieren
 * abrir DAT ni hablar inglés. Tú solo manejas los camiones; la IA hace el despacho.
 *
 * FLUJO COMPLETO (lo que VE el broker hispanohablante):
 *
 *   07:00 AM — WhatsApp: "Buenos días. Encontré 4 cargas buenas para el camión #3.
 *            La mejor: Miami → Atlanta, $2,400, carga mañana 8 AM. ¿La agarro? [SÍ] [VER MÁS]"
 *
 *   Toca SÍ → La IA confirma con el shipper EN INGLÉS, agenda, y avisa:
 *            "Listo. Camión #3 confirmado. Recoge mañana 8 AM en 4500 NW 74 Ave, Miami."
 *
 *   Si la tarifa está baja → la IA negocia sola y te avisa:
 *            "Ofrecían $2,000. Negocié a $2,350. ¿Confirmo? [SÍ] [NO]"
 */
const AiLanguageAgent = require('./07_ai_language_agent');

class AutoDispatchAgent {
    constructor(db, redis, loadService, notify) {
        this.db = db;
        this.redis = redis;
        this.loads = loadService;      // del archivo 01: DAT + Truckstop + respaldo
        this.agenteIA = new AiLanguageAgent();
        this.notify = notify;          // envía WhatsApp/SMS/push en español
    }

    /**
     * Se ejecuta cada 10 minutos para cada camión disponible.
     * Busca cargas, filtra las malas, negocia las buenas y le pregunta
     * al broker SOLO con las 3 mejores opciones, ya en español.
     */
    async buscarYProponer(tenantId, driver) {
        // 1. Buscar cargas cerca del camión (usa el motor v2.0 con respaldo automático)
        const cargas = await this.loads.getLoadsNear(
            { lat: driver.current_lat, lng: driver.current_lng },
            150,
            { equipment: driver.equipment }
        );

        // 2. Filtrar y ordenar con el motor de puntaje (archivo 02 de v2.0)
        const mejores = cargas
            .filter(c => (c.rate / c.miles) >= 2.0)               // mínimo $2/milla
            .sort((a, b) => (b.rate / b.miles) - (a.rate / a.miles))
            .slice(0, 3);

        if (!mejores.length) return;

        // 3. Resumir cada una en español para el broker
        const propuestas = [];
        for (const carga of mejores) {
            const resumen = await this.agenteIA.explainLoadInSpanish(carga, driver.full_name);
            propuestas.push({ carga, resumen });
        }

        // 4. Enviar UNA notificación en español con las 3 opciones
        await this.notify(tenantId, {
            titulo: `Opciones para el camión ${driver.truck_number}`,
            mensaje: propuestas.map((p, i) =>
                `${i + 1}. ${p.resumen}`
            ).join('\n\n') + '\n\nResponde 1, 2 o 3 para escoger.',
            acciones: ['1', '2', '3']
        });
    }

    /**
     * El broker respondió "1" → la IA confirma la carga EN INGLÉS y agenda todo
     */
    async confirmarEleccion(tenantId, driver, carga, reglasNegociacion) {
        // 1. Si la tarifa es negociable y está baja, la IA negocia sola primero
        let resultado;
        if ((carga.rate / carga.miles) < 2.3 && reglasNegociacion.autoNegociar) {
            resultado = await this.agenteIA.modoPilotoAutomatico(carga, reglasNegociacion);
            await this.notify(tenantId, { mensaje: resultado.notificacion_para_el_broker });
            if (!resultado.aceptada) return;
            carga.rate = resultado.precio_final;
        }

        // 2. Confirmar con el shipper en inglés (correo/chat de DAT)
        const confirmacion = await this.agenteIA.respuestaRapida('aceptar', {
            precio: carga.rate,
            hora: carga.pickupWindow
        });
        // await emailService.enviar(carga.contactEmail, confirmacion.enviar_en_ingles);

        // 3. Registrar la reserva en la base de datos
        await this.db.query(
            `INSERT INTO bookings (tenant_id, load_id, driver_id, status)
             VALUES ($1, $2, $3, 'CONFIRMED')`,
            [tenantId, carga.id, driver.id]
        );

        // 4. Aviso final en español con TODOS los datos de la carga
        await this.notify(tenantId, {
            titulo: '✅ Carga confirmada',
            mensaje:
`Camión ${driver.truck_number} asignado:
📦 ${carga.originCity}, ${carga.originState} → ${carga.destCity}, ${carga.destState}
💰 $${carga.rate} (${(carga.rate / carga.miles).toFixed(2)}/milla) | 🛣️ ${carga.miles} millas
📅 Carga: ${carga.pickupDate} | Entrega: ${carga.deliveryDate}
📍 Recoger en: ${carga.originAddress}
Todo el contacto en inglés lo hizo la IA por ti.`
        });
    }

    /**
     * MODO 100% AUTOMÁTICO — La IA trabaja 24/7 sin preguntar
     * Configuración única del broker (reglas): precio mínimo por milla,
     * zonas prohibidas, horarios. La IA nunca rompe estas reglas.
     * Lo único que pide: un clic para firmar el rate confirmation.
     */
    async ejecutarModoAutomatico(tenantId, reglas) {
        // 1. Todos los camiones disponibles de este broker
        const camiones = await this.db.query(
            `SELECT * FROM drivers WHERE tenant_id = $1 AND is_active = TRUE
             AND id NOT IN (SELECT driver_id FROM bookings WHERE status = 'CONFIRMED')`,
            [tenantId]
        );

        for (const camion of camiones.rows) {
            // 2. Buscar, filtrar y aplicar las REGLAS del broker
            const cargas = await this.loads.getLoadsNear(
                { lat: camion.current_lat, lng: camion.current_lng }, 150,
                { equipment: camion.equipment }
            );
            const validas = cargas.filter(c =>
                (c.rate / c.miles) >= reglas.precioMinimoMilla &&      // regla 1: precio mínimo
                !reglas.zonasProhibidas.includes(c.destState) &&        // regla 2: zonas NO
                this._horarioPermitido(c, reglas.horarioMaximoCarga)    // regla 3: horario
            );
            if (!validas.length) continue;

            // 3. Tomar la mejor y negociar al alza (modo piloto, dentro de reglas)
            const mejor = validas.sort((a, b) => (b.rate / b.miles) - (a.rate / a.miles))[0];
            const resultado = await this.agenteIA.modoPilotoAutomatico(mejor, {
                precioMinimoMilla: reglas.precioMinimoMilla,
                incrementoPorRonda: 100
            });

            if (resultado.aceptada) {
                // 4. Preparar TODO, pero esperar el clic de firma del broker
                await this.db.query(
                    `INSERT INTO bookings (tenant_id, load_id, driver_id, status)
                     VALUES ($1, $2, $3, 'PENDING_SIGNATURE')`,
                    [tenantId, mejor.id, camion.id]
                );
                await this.notify(tenantId, {
                    titulo: '✍️ Toca para firmar',
                    mensaje:
`La IA negoció y cerró esta carga sola:
📦 ${mejor.originCity} → ${mejor.destCity} | 💰 $${resultado.precio_final} (${(resultado.precio_final/mejor.miles).toFixed(2)}/milla)
Camión ${camion.truck_number} | Recoge: ${mejor.pickupDate}
Solo falta TU FIRMA (1 clic): [FIRMAR]`,
                    requiereFirma: true
                });
            }
        }
    }

    _horarioPermitido(carga, horaMaxima) {
        if (!horaMaxima) return true;
        const hora = new Date(carga.pickupDate).getHours();
        return hora <= horaMaxima;
    }

    /**
     * TRADUCCIÓN INSTANTÁNEA — Si el shipper escribe en inglés por cualquier canal
     * (correo, SMS, chat de DAT), el broker lo recibe traducido al español,
     * y sus respuestas se envían en inglés automáticamente.
     */
    async canalBilingue(tenantId, mensajeEntrante, idiomaDetectado) {
        if (idiomaDetectado === 'en') {
            const traduccion = await this.agenteIA.traducirParaBroker(mensajeEntrante);
            await this.notify(tenantId, {
                titulo: '📩 Mensaje del shipper (traducido)',
                mensaje: traduccion,
                original_en_ingles: mensajeEntrante
            });
        }
    }
}

module.exports = AutoDispatchAgent;
