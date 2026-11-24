// ============================================================================
// 40_api_gateway.js — LA PUERTA ÚNICA DE ENTRADA (API Gateway)
// Versión 5.3
//
// Todo lo que entra al sistema pasa por aquí: celular del chofer, panel del
// broker, webhooks de Stripe/Twilio. Responsabilidades:
//   - Identificar el tenant (archivo 02) antes de cualquier ruta privada
//   - Rate limiting (anti-abuso, por IP y por tenant)
//   - Headers de seguridad + CORS cerrado
//   - Request ID en todo (para rastrear un problema en los logs)
//   - Manejo de errores único: nunca se filtra un stack trace al cliente
// ============================================================================

const express = require('express');

function crearGateway({ tenantMiddleware, limiteRpm = 120, db, notificar = null, autoDispatch = null, log = () => {} }) {
  const app = express();
  app.disable('x-powered-by');
  // Se guarda el cuerpo CRUDO: Stripe firma los bytes exactos (re-serializar el JSON rompe la firma, E-027).
  // Twilio envía application/x-www-form-urlencoded: sin este parser, req.body llegaba vacío (E-025).
  const guardarCuerpoCrudo = (req, _res, buf) => { req.rawBody = buf; };
  app.use(express.json({ limit: '1mb', verify: guardarCuerpoCrudo }));
  app.use(express.urlencoded({ extended: false, limit: '100kb', verify: guardarCuerpoCrudo }));

  // 1. Request ID — cada petición lleva número de seguimiento
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // 2. Headers de seguridad (equivalente manual a helmet)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // 3. CORS cerrado: solo los dominios de la app y el panel
  const PERMITIDOS = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',');
  app.use((req, res, next) => {
    const origen = req.headers.origin;
    if (origen && PERMITIDOS.includes(origen)) {
      res.setHeader('Access-Control-Allow-Origin', origen);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // 4. Rate limiting por IP+tenant (ventana fija de 1 minuto, en memoria;
  //    en multi-servidor se cambia por Redis sin tocar el resto)
  const ventanas = new Map();
  app.use((req, res, next) => {
    const clave = `${req.ip}:${req.headers['x-tenant'] || 'pub'}`;
    const ahora = Date.now();
    const v = ventanas.get(clave) || { inicio: ahora, count: 0 };
    if (ahora - v.inicio > 60000) { v.inicio = ahora; v.count = 0; }
    v.count++;
    ventanas.set(clave, v);
    if (v.count > limiteRpm) {
      return res.status(429).json({ error: 'Demasiadas peticiones. Espera un minuto.' });
    }
    next();
  });

  // 5. Webhooks públicos (Stripe y Twilio verifican su firma antes de tocar la BD)
  //    → se montan ANTES del tenant middleware.
  app.use('/webhooks', require('./server/api/webhooks')({ db, notificar, autoDispatch, log }));

  // 6. Todo lo demás exige tenant válido (Host), suscripción al día y contexto de BD por petición:
  //    req.enTenant(fn) = transacción con app.current_tenant LOCAL (RLS), nunca de sesión (E-028).
  if (!tenantMiddleware || typeof tenantMiddleware.identifyTenant !== 'function') {
    throw new Error('crearGateway requiere una INSTANCIA de TenantMiddleware (new TenantMiddleware(db))');
  }
  app.use(tenantMiddleware.identifyTenant, tenantMiddleware.verifySubscription, tenantMiddleware.setTenantContext);

  // 7. Rutas de la API (server/api/routes.js — se invoca la factory con sus deps)
  app.use('/api', require('./server/api/routes')({ db, tenantMiddleware }));

  // 8. Health pública (para el monitoreo del servidor, sin datos)
  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // 9. 404 y manejo de errores único
  app.use((req, res) => res.status(404).json({ error: 'Ruta no existe', requestId: req.id }));
  app.use((err, req, res, next) => { // eslint-disable-line
    const status = err.status || 500;
    if (status >= 500) console.error(`[${req.id}]`, err);
    res.status(status).json({
      error: status >= 500 ? 'Error interno. Reporta este número: ' + req.id : err.message,
      requestId: req.id
    });
  });

  return app;
}

module.exports = { crearGateway };
