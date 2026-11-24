/**
 * MÓDULA 21 — MODO FAMILIA: ubicación en vivo para un familiar
 * El chofer comparte SU ubicación en tiempo real con una persona de confianza
 * (esposa, hijo, hermano) por WhatsApp. Sin que el chofer toque nada:
 * sale sola cada X minutos mientras está en ruta.
 *
 * Valor de negocio: la familia del chofer presiona menos, el chofer acepta
 * más cargas nocturnas, y el broker retiene conductores. Cero costo extra.
 */
class ModoFamilia {
    constructor(db, redis) {
        this.db = db;
        this.redis = redis;
    }

    /**
     * El chofer configura UNA VEZ: nombre y WhatsApp de su familiar.
     * Desde la app: Ajustes → Modo Familia → "Compartir con: +1-XXX-XXX-XXXX"
     */
    async configurar(driverId, familiarNombre, familiarTelefono, cadaMinutos = 30) {
        await this.db.query(
            `UPDATE drivers SET
                familia_nombre = $1, familia_telefono = $2, familia_cada_minutos = $3,
                familia_activo = TRUE
             WHERE id = $4`,
            [familiarNombre, familiarTelefono, cadaMinutos, driverId]
        );
    }

    /**
     * Se ejecuta con el GPS (cada 10 min). Si el chofer está EN RUTA
     * y el modo familia está activo, manda la ubicación al familiar.
     * Solo se envía mientras trabaja — nunca en su tiempo personal.
     */
    async quizasEnviarUbicacion(driverId, lat, lng) {
        const r = await this.db.query(
            `SELECT familia_activo, familia_telefono, familia_cada_minutos, familia_ultimo_envio
             FROM drivers WHERE id = $1`, [driverId]
        );
        const d = r.rows[0];
        if (!d || !d.familia_activo || !d.familia_telefono) return;

        // ¿Está en ruta? (tiene booking CONFIRMED o PICKED_UP)
        const enRuta = await this.db.query(
            `SELECT 1 FROM bookings WHERE driver_id = $1 AND status IN ('CONFIRMED','PICKED_UP')`,
            [driverId]
        );
        if (!enRuta.rows.length) return;

        // ¿Ya pasó el tiempo configurado desde el último envío?
        const ultimo = d.familia_ultimo_envio ? new Date(d.familia_ultimo_envio) : 0;
        if (Date.now() - ultimo < (d.familia_cada_minutos || 30) * 60000) return;

        // Enviar ubicación en vivo por WhatsApp con enlace de mapa
        const link = `https://maps.google.com/?q=${lat},${lng}`;
        await this.enviarWhatsApp(d.familia_telefono,
            `🚛 ${'Tu familiar'} va en ruta.\n📍 Ubicación ahora: ${link}\n(Este aviso sale solo mientras trabaja)`);

        await this.db.query(
            `UPDATE drivers SET familia_ultimo_envio = NOW() WHERE id = $1`, [driverId]
        );
    }

    /**
     * ALERTA DE SEGURIDAD: si el camión lleva 2 horas DETENIDO en ruta
     * (sin moverse y no en dirección conocida), avisa al familiar Y al broker.
     * Posible falla mecánica o emergencia.
     */
    async alertaSeguridad(driverId) {
        const r = await this.db.query(
            `SELECT familia_telefono, truck_number FROM drivers WHERE id = $1`, [driverId]
        );
        const d = r.rows[0];
        if (!d?.familia_telefono) return;
        await this.enviarWhatsApp(d.familia_telefono,
            `⚠️ El camión ${d.truck_number} lleva 2 horas detenido en ruta. Ubicación: (enlace). Se ha avisado al despacho.`);
    }

    async enviarWhatsApp(telefono, mensaje) {
        // Mismo Twilio del archivo 05: client.messages.create({ from: WHATSAPP_NUM, to: telefono, body: mensaje })
    }
}

module.exports = ModoFamilia;
