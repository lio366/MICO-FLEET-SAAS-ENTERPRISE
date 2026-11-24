// ============================================================================
// 43_metrics_observability.js — VER EL PULSO DE LA PLATAFORMA EN VIVO
// Versión 5.3
//
// Sin monitoreo, un SaaS muere de noche un sábado y nadie se entera.
// Esto da: métricas estilo Prometheus (/metrics), health checks, logger
// estructurado y alertas básicas que avisan ANTES de que el cliente lo note.
// ============================================================================

// ---------------------------------------------------------------------------
// Métricas en memoria (contadores, gauges, histogramas). En producción con
// varios servidores se exporta a Prometheus; la interfaz no cambia.
// ---------------------------------------------------------------------------
const metricas = { contadores: new Map(), gauges: new Map(), hist: new Map() };

function contador(nombre, etiquetas = {}, delta = 1) {
  const clave = nombre + JSON.stringify(etiquetas);
  metricas.contadores.set(clave, (metricas.contadores.get(clave) || 0) + delta);
}
function gauge(nombre, valor) { metricas.gauges.set(nombre, valor); }
function histograma(nombre, valorMs) {
  const h = metricas.hist.get(nombre) || { n: 0, sum: 0, max: 0, buckets: { 100: 0, 500: 0, 1000: 0, 5000: 0 } };
  h.n++; h.sum += valorMs; h.max = Math.max(h.max, valorMs);
  for (const b of Object.keys(h.buckets)) if (valorMs <= +b) h.buckets[b]++;
  metricas.hist.set(nombre, h);
}

// Middleware: mide latencia y errores de CADA petición HTTP
function middlewareMetricas() {
  return (req, res, next) => {
    const inicio = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
      contador('http_peticiones_total', { ruta: req.baseUrl + req.path, status: res.statusCode });
      histograma('http_duracion_ms', ms);
      gauge('uptime_segundos', Math.floor(process.uptime()));
      if (res.statusCode >= 500) contador('http_errores_5xx');
    });
    next();
  };
}

// ---------------------------------------------------------------------------
// /metrics — formato texto Prometheus (lo lee Grafana o se scrapea gratis)
// ---------------------------------------------------------------------------
function endpointMetrics() {
  return (req, res) => {
    const lineas = [];
    for (const [k, v] of metricas.contadores) lineas.push(`mf_${k.replace(/[^\w]/g, '_')} ${v}`);
    for (const [k, v] of metricas.gauges) lineas.push(`mf_${k.replace(/[^\w]/g, '_')} ${v}`);
    for (const [k, h] of metricas.hist) {
      lineas.push(`mf_${k.replace(/[^\w]/g, '_')}_count ${h.n}`);
      lineas.push(`mf_${k.replace(/[^\w]/g, '_')}_avg ${(h.sum / h.n).toFixed(1)}`);
      lineas.push(`mf_${k.replace(/[^\w]/g, '_')}_max ${h.max}`);
    }
    lineas.push(`mf_memoria_mb ${Math.round(process.memoryUsage().rss / 1048576)}`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(lineas.join('\n'));
  };
}

// ---------------------------------------------------------------------------
// Health detallado: /healthz responde 200 solo si TODO lo crítico responde.
// El monitor del servidor (UptimeRobot gratis) lo toca cada 5 min.
// ---------------------------------------------------------------------------
function endpointHealth({ db, redis }) {
  return async (req, res) => {
    const checks = {};
    try { await db.query('SELECT 1'); checks.db = 'ok'; } catch { checks.db = 'FALLO'; }
    try { if (redis) { await redis.ping(); checks.redis = 'ok'; } } catch { checks.redis = 'FALLO'; }
    const sano = Object.values(checks).every(v => v === 'ok');
    res.status(sano ? 200 : 503).json({ ok: sano, checks, uptime: process.uptime() });
  };
}

// ---------------------------------------------------------------------------
// Logger estructurado: una línea JSON por evento → se envía a cualquier
// agregador gratis (Grafana Cloud, Better Stack) con un webhook.
// ---------------------------------------------------------------------------
function log(nivel, evento, datos = {}) {
  const linea = JSON.stringify({ ts: new Date().toISOString(), nivel, evento, ...datos });
  (nivel === 'error' ? console.error : console.log)(linea);
}

// ---------------------------------------------------------------------------
// Alertas básicas sin costo: reglas sobre las métricas; si se rompen,
// avisa por el servicio de notificaciones (archivo 45).
// ---------------------------------------------------------------------------
const REGLAS_ALERTA = [
  { nombre: 'errores_5xx_explosion', cuando: m => (m.contadores.get('http_errores_5xx') || 0) > 20, msg: 'Más de 20 errores 5xx acumulados' },
  { nombre: 'memoria_alta', cuando: () => process.memoryUsage().rss > 1.5e9, msg: 'Memoria > 1.5GB — revisar workers' },
  { nombre: 'latencia_alta', cuando: m => { const h = m.hist.get('http_duracion_ms'); return h && h.n > 50 && (h.sum / h.n) > 1500; }, msg: 'Latencia media > 1.5s' },
];

async function revisarAlertas(notificar) {
  for (const r of REGLAS_ALERTA) {
    if (r.cuando(metricas)) {
      log('error', 'alerta.disparada', { regla: r.nombre });
      await notificar('ADMIN', { tipo: 'ALERTA_SISTEMA', texto: `⚠️ ${r.msg}` });
    }
  }
}

module.exports = { contador, gauge, histograma, middlewareMetricas, endpointMetrics, endpointHealth, log, revisarAlertas };
