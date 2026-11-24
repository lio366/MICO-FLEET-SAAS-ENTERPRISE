/**
 * MÓDULO 20 — ALERTA DE DIÉSEL POR RUTA
 * El diésel no cuesta igual en Miami que en California.
 * Este módulo le dice a la IA: "esta carga se ve buena en papel,
 * pero en la ruta el diésel se come la ganancia" → la rechaza antes de ofrecerla.
 */
const axios = require('axios');

class AlertaDiesel {
    constructor(db, redis) {
        this.db = db;
        this.redis = redis;
        this.API_DIesel = 'https://api.eia.gov/v2/petroleum/pri/gnd/data'; // precios oficiales EIA por región
    }

    /**
     * Actualiza los precios de diésel por región USA cada 24 horas (gratis, gobierno)
     */
    async actualizarPrecios() {
        const res = await axios.get(this.API_DIesel, {
            params: {
                api_key: process.env.EIA_API_KEY,
                frequency: 'daily',
                'data[0]': 'value',
                facets: { product: ['EPD2D'], duarea: ['R10','R20','R30','R40','R50'] }, // 5 regiones
                sort: [{ column: 'period', direction: 'desc' }],
                length: 5
            }
        });
        for (const r of res.data.response.data) {
            await this.redis.setex(`diesel:${r.area}`, 86400, r.value);
        }
    }

    /**
     * ¿Vale la pena esta carga DESPUÉS del diésel?
     * Se llama dentro del filtro de reglas del agente (archivo 08).
     *
     * @returns {object} { valeLaPena, gananciaTrasDiesel, alerta }
     */
    async evaluarRuta(load, truck) {
        const mpg = 6.5;                        // millas por galón de un camión cargado
        const millasTotales = load.miles * 1.25; // ida con carga + regreso estimado
        const galones = millasTotales / mpg;

        // Precio diésel en el destino vs en el origen (región del estado)
        const dieselDestino = await this.precioEn(load.destState);
        const dieselOrigen = await this.precioEn(load.originState);

        const costoDiesel = galones * dieselDestino;
        const costoOperativo = millasTotales * 1.65; // camión + mantenimiento + peajes promedio
        const gananciaNeta = load.rate - costoOperativo - costoDiesel;

        // Si el diésel del destino es 8%+ más caro que el origen: alerta especial
        const dieselCaro = dieselDestino > dieselOrigen * 1.08;

        return {
            valeLaPena: gananciaNeta > 150,          // mínimo $150 limpios por el viaje
            gananciaTrasDiesel: Math.round(gananciaNeta),
            alerta: dieselCaro
                ? `⛽ OJO: el diésel en ${load.destState} está ${(((dieselDestino/dieselOrigen)-1)*100).toFixed(0)}% más caro que en ${load.originState}. Se agregó al cálculo.`
                : null
        };
    }

    async precioEn(state) {
        // Mapa estado → región EIA; cacheado en Redis 24h
        const REGION = { FL:'R30', GA:'R30', TX:'R30', CA:'R50', NY:'R10', /* ... */ };
        const region = REGION[state] || 'R30';
        const cached = await this.redis.get(`diesel:${region}`);
        return cached ? parseFloat(cached) : 3.85; // promedio nacional si no hay dato
    }
}

module.exports = AlertaDiesel;
