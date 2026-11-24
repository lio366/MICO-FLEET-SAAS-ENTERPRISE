/**
 * TAREAS PROGRAMADAS (CRON) — El personal invisible que trabaja de noche
 *
 * node-cron ejecuta estas tareas automáticamente:
 */
const cron = require('node-cron');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

class CronJobs {
    constructor(db, billingService) {
        this.db = db;
        this.billing = billingService;
    }

    start() {
        // ── Tarea 1: Suspende cuentas con pago vencido (> 7 días de gracia) ──
        // Todos los días a las 8:00 AM
        cron.schedule('0 8 * * *', async () => {
            const result = await this.db.query(
                `UPDATE tenants SET status = 'SUSPENDED'
                 WHERE status = 'TRIAL' AND trial_ends_at < NOW() - INTERVAL '7 days'
                    OR status IN ('ACTIVE','TRIAL')
                       AND id IN (SELECT tenant_id FROM subscriptions
                                  WHERE status = 'PAST_DUE'
                                    AND current_period_end < NOW() - INTERVAL '7 days')
                 RETURNING id, name, email`
            );
            for (const t of result.rows) {
                console.log(`[CRON] Suspendido por falta de pago: ${t.name}`);
                await this.notifyAdmins(t.id, 'Tu acceso fue suspendido por falta de pago. Regulariza en /billing');
            }
        });

        // ── Tarea 2: Aviso 3 días antes de que termine el trial ──
        // Todos los días a las 9:00 AM
        cron.schedule('0 9 * * *', async () => {
            const trials = await this.db.query(
                `SELECT id, name FROM tenants
                 WHERE status = 'TRIAL' AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '3 days'`
            );
            for (const t of trials.rows) {
                await this.notifyAdmins(t.id,
                    `Tu prueba gratuita termina pronto. Elige un plan para no perder acceso a tus cargas.`);
            }
        });

        // ── Tarea 3: Reporte semanal de uso a cada broker (valor percibido) ──
        // Lunes a las 7:00 AM — "Tu flota ahorró $X esta semana"
        cron.schedule('0 7 * * 1', async () => {
            const report = await this.db.query(
                `SELECT t.id, t.name,
                        COUNT(b.id) as cargas,
                        COALESCE(SUM(l.rate), 0) as revenue
                 FROM tenants t
                 LEFT JOIN bookings b ON b.tenant_id = t.id
                     AND b.assigned_at > NOW() - INTERVAL '7 days'
                 LEFT JOIN loads l ON l.id = b.load_id
                 WHERE t.status = 'ACTIVE' GROUP BY t.id, t.name`
            );
            for (const r of report.rows) {
                await this.notifyAdmins(r.id,
                    `Resumen semanal: ${r.cargas} cargas asignadas, $${r.revenue} en ingresos generados.`);
            }
        });

        // ── Tarea 4: Limpieza de datos antiguos (mantenimiento) ──
        // 1ro de cada mes a las 3:00 AM
        cron.schedule('0 3 1 * *', async () => {
            await this.db.query(`DELETE FROM driver_positions WHERE created_at < NOW() - INTERVAL '6 months'`);
            await this.db.query(`TRUNCATE notification_log`);
            console.log('[CRON] Limpieza mensual completada');
        });

        console.log('[CRON] Tareas programadas activas');
    }

    async notifyAdmins(tenantId, message) {
        const admins = await this.db.query(
            `SELECT email FROM tenant_users WHERE tenant_id = $1 AND role = 'ADMIN'`, [tenantId]
        );
        for (const a of admins.rows) {
            await sgMail.send({
                to: a.email,
                from: 'soporte@tudominio.com',
                subject: 'Micro-Fleet: Aviso de tu cuenta',
                text: message
            });
        }
    }
}

module.exports = CronJobs;
