/**
 * API DE ADMINISTRACIÓN POR BROKER — El panel de control de cada inquilino
 *
 * Cada broker gestiona SU flota desde SU panel, sin verte a ti ni a otros brokers.
 */
const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Protección general del panel
const panelLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// ─────────────────────────────────────────────
// GESTIÓN DE CAMIONES DEL BROKER
// ─────────────────────────────────────────────
const driverSchema = Joi.object({
    full_name: Joi.string().min(3).max(255).required(),
    phone: Joi.string().pattern(/^\+?[\d\s-]{10,15}$/).required(),
    email: Joi.string().email().optional(),
    truck_number: Joi.string().max(50).required()
});

router.post('/drivers', panelLimiter, async (req, res) => {
    const { error, value } = driverSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // tenant_id sale del token — el broker NO puede tocar otro tenant
    const result = await req.db.query(
        `INSERT INTO drivers (tenant_id, full_name, phone, email, truck_number)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name, truck_number`,
        [req.user.tenantId, value.full_name, value.phone, value.email, value.truck_number]
    );
    res.status(201).json(result.rows[0]);
});

router.get('/drivers', panelLimiter, async (req, res) => {
    const result = await req.db.query(
        `SELECT id, full_name, phone, truck_number, hos_status, is_active
         FROM drivers WHERE tenant_id = $1 ORDER BY created_at DESC`, [req.user.tenantId]
    );
    res.json(result.rows);
});

// ─────────────────────────────────────────────
// GESTIÓN DE USUARIOS DEL BROKER (su equipo de despachadores)
// ─────────────────────────────────────────────
const userSchema = Joi.object({
    email: Joi.string().email().required(),
    full_name: Joi.string().min(3).max(255).required(),
    role: Joi.string().valid('DISPATCHER', 'VIEWER').required(),
    password: Joi.string().min(8).required()
});

router.post('/users', panelLimiter, async (req, res) => {
    // Solo el ADMIN del broker puede crear usuarios
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Solo el administrador puede agregar usuarios' });
    }
    const { error, value } = userSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(value.password, 12);
    const result = await req.db.query(
        `INSERT INTO tenant_users (tenant_id, email, full_name, role, password_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, email, full_name, role`,
        [req.user.tenantId, value.email, value.full_name, value.role, hash]
    );
    res.status(201).json(result.rows[0]);
});

// ─────────────────────────────────────────────
// MARCA PERSONAL (WHITE-LABEL): logo y color de su empresa
// ─────────────────────────────────────────────
router.put('/branding', panelLimiter, async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Solo el administrador puede cambiar la marca' });
    }
    const { logo_url, brand_color, custom_domain } = req.body;
    await req.db.query(
        `UPDATE tenants SET logo_url = $1, brand_color = $2, custom_domain = $3 WHERE id = $4`,
        [logo_url, brand_color, custom_domain, req.user.tenantId]
    );
    res.json({ ok: true, message: 'Marca actualizada' });
});

// ─────────────────────────────────────────────
// REPORTE DEL BROKER: cuánto le está ganando la app
// ─────────────────────────────────────────────
router.get('/reports/monthly', panelLimiter, async (req, res) => {
    const result = await req.db.query(
        `SELECT
            COUNT(b.id) as cargas_asignadas,
            COALESCE(SUM(l.rate), 0) as ingresos,
            COALESCE(SUM(l.miles), 0) as millas_pagadas,
            COALESCE(AVG(l.rate / NULLIF(l.miles, 0)), 0) as rpm_promedio
         FROM bookings b
         JOIN loads l ON l.id = b.load_id
         WHERE b.tenant_id = $1 AND b.assigned_at > date_trunc('month', NOW())`,
        [req.user.tenantId]
    );
    res.json(result.rows[0]);
});

// ─────────────────────────────────────────────
// FACTURACIÓN DEL BROKER: ver su plan y pagos
// ─────────────────────────────────────────────
router.get('/billing', panelLimiter, async (req, res) => {
    const sub = await req.db.query(
        `SELECT plan, amount_monthly, status, current_period_end FROM subscriptions
         WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.user.tenantId]
    );
    const payments = await req.db.query(
        `SELECT amount, status, paid_at FROM payments
         WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 12`, [req.user.tenantId]
    );
    res.json({ subscription: sub.rows[0] || null, recent_payments: payments.rows });
});

module.exports = router;
