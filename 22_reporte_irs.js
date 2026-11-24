/**
 * MÓDULO 22 — REPORTE TRIMESTRAL PARA EL CONTADOR (IRS)
 * Cada 3 meses, el sistema arma SOLO el resumen financiero de cada camión:
 * ingresos, gastos de diésel estimados, millas, y cuánto apartar para impuestos.
 * El broker se lo entrega a su contador en 1 clic. El contador hace el resto.
 */
class ReporteIRS {
    constructor(db) {
        this.db = db;
    }

    /**
     * Genera el reporte del trimestre para un broker.
     * Sale automático el 1 de abril, julio, octubre y enero (cron, archivo 04).
     */
    async generarTrimestre(tenantId, anio, trimestre) {
        const meses = { 1: ['01','02','03'], 2: ['04','05','06'], 3: ['07','08','09'], 4: ['10','11','12'] }[trimestre];

        const res = await this.db.query(
            `SELECT
                d.truck_number,
                COUNT(b.id) AS cargas,
                COALESCE(SUM(l.rate), 0) AS ingresos,
                COALESCE(SUM(l.miles), 0) AS millas_pagadas,
                COALESCE(SUM(l.miles * 1.25 * 0.153), 0) AS deduccion_millas_irs,
                COALESCE(SUM(l.rate * 0.20), 0) AS reserva_impuestos_20pct
             FROM drivers d
             LEFT JOIN bookings b ON b.driver_id = d.id
                 AND b.status = 'DELIVERED'
                 AND to_char(b.delivered_at, 'MM') = ANY($1)
                 AND to_char(b.delivered_at, 'YYYY') = $2
             LEFT JOIN loads l ON l.id = b.load_id
             WHERE d.tenant_id = $3
             GROUP BY d.truck_number
             ORDER BY d.truck_number`,
            [meses, String(anio), tenantId]
        );

        const totalIngresos = res.rows.reduce((s, r) => s + parseFloat(r.ingresos), 0);

        // Formato simple que cualquier contador entiende
        const lineas = res.rows.map(r =>
            `Camión ${r.truck_number}: ${r.cargas} cargas | $${parseFloat(r.ingresos).toLocaleString()} ingresos | ` +
            `${r.millas_pagadas} millas | deducción IRS $${parseFloat(r.deduccion_millas_irs).toLocaleString()}`
        ).join('\n');

        const reporte =
`📊 REPORTE TRIMESTRAL ${trimestre}/${anio} — Para tu contador

${lineas}

─────────────────────────
TOTAL INGRESOS DEL TRIMESTRE: $${totalIngresos.toLocaleString()}
RESERVA RECOMENDADA PARA IMPUESTOS (20%): $${(totalIngresos * 0.20).toLocaleString()}

Notas para el contador:
- Deducción por millas: tarifa IRS 2026 de $0.67/milla (o costos reales si prefiere)
- Las facturas de QuickBooks (módulo 18) respaldan cada carga
- Entregar también el 1099 de cada shipper si aplica`;

        // Enviar por WhatsApp/correo al broker y guardar copia
        await this.notificar(tenantId, reporte);
        await this.db.query(
            `INSERT INTO irs_reports (tenant_id, anio, trimestre, contenido, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [tenantId, anio, trimestre, reporte]
        );
        return reporte;
    }
}

module.exports = ReporteIRS;
