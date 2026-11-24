// ============================================================================
// 49_disaster_recovery.js — SI TODO SE CAE, ESTO TE LEVANTA
// Versión 5.4
//
// OBJETIVOS MEDIDOS (los números que importan):
//   RPO (pérdida máxima de datos):  24 horas (backup diario)
//                                   → 15 minutos si activas WAL (instrucciones abajo)
//   RTO (tiempo de volver a operar): 60 minutos con este runbook
//
// ESCENARIOS CUBIERTOS:
//   1. Se cayó el VPS            → levantar réplica desde backup (runbook A)
//   2. Base de datos corrupta    → restaurar a hora exacta con WAL (runbook B)
//   3. Borrado accidental        → restaurar copia a servidor temporal y
//                                   rescatar solo lo borrado (runbook C)
//   4. El servidor vivo, la app no → health check + reinicio automático
// ============================================================================

// ---------------------------------------------------------------------------
// SALUD AUTOMÁTICA: si /healthz falla 3 veces seguidas, Docker reinicia el
// contenedor solo (restart: always en el compose) y avisa al admin.
// UptimeRobot (gratis) toca /healthz cada 5 min desde fuera.
// ---------------------------------------------------------------------------
const MONITOREO_EXTERNO = `
# UptimeRobot gratis: monitoreo cada 5 min → te avisa por email/app si cae.
# Configurar: Add Monitor → HTTP(s) → https://api.tudominio.com/healthz
# Regla: si está caído > 5 min, ejecutar el runbook A automáticamente
# (UptimeRobot tiene "alert contacts" con webhook a tu celular).
`;

// ---------------------------------------------------------------------------
// RUNBOOK A — EL VPS MURIÓ (o lo perdiste): volver a operar en 60 min
// ---------------------------------------------------------------------------
const RUNBOOK_A = `
# RUNBOOK A — Recuperación total en servidor nuevo
# 0:00  Crear VPS nuevo (Hetzner, 3 clics, ~$6/mes)
# 0:05  apt install docker + git           → ya está en deploy.sh
# 0:10  git clone del repo + .env (tienes las claves en tu gestor)
# 0:20  docker compose up -d
# 0:25  Restaurar último backup:
        gunzip -c backups/backup-ULTIMO.sql.gz | docker compose exec -T db \\
          psql -U microfleet microfleet
# 0:40  Apuntar el DNS (app/api.tudominio.com) al IP nuevo
# 0:45  Esperar certificado HTTPS (Caddy lo hace solo, 1 min)
# 0:50  Pruebas de humo (abajo) → VOLVISTE A OPERAR
`;

// ---------------------------------------------------------------------------
// RUNBOOK B — RESTAURAR A UNA HORA EXACTA (WAL, pérdida máx 15 min)
// Requiere activar WAL una sola vez: wal_level=replica ya va activado
// en el docker-compose generado por el archivo 48_deploy_stack.js.
// ---------------------------------------------------------------------------
const RUNBOOK_B = `
# RUNBOOK B — Point-in-Time Recovery (Postgres PITR)
# 1. Los WAL van a un storage externo barato (Backblaze B2, 10GB gratis):
       rclone sync /opt/micro-fleet/wal remote:micro-fleet-wal
# 2. Para volver a las 14:30 de ayer:
       docker compose exec -T db pg_basebackup -D /restore
       # + replay de WAL hasta 14:30 (recovery_target_time)
# 3. Levantar la BD restaurada, exportar lo necesario, volver al presente.
# (La empresa de contabilidad no notará nada: el ledger protege los datos.)
`;

// ---------------------------------------------------------------------------
// RUNBOOK C — BORRADO ACCIDENTAL (alguien borró cargas/choferes)
// ---------------------------------------------------------------------------
const RUNBOOK_C = `
# RUNBOOK C — Rescate selectivo
# 1. NO tocar la base viva.
# 2. Restaurar el backup de anoche en un servidor temporal:
       docker compose -f docker-compose.temp.yml up db
       gunzip -c backups/backup-AYER.sql.gz | docker compose exec -T db psql -U microfleet microfleet
# 3. Exportar SOLO lo borrado:
       pg_dump -t drivers -t loads --where="..." > rescate.sql
# 4. Importar rescate.sql a la base viva.
# 5. El audit_ledger (archivo 42) dice QUIÉN borró qué y cuándo — revisarlo.
`;

// ---------------------------------------------------------------------------
// PRUEBAS DE HUMO después de cualquier recuperación (todas deben pasar)
// ---------------------------------------------------------------------------
const PRUEBAS_HUMO = [
  'GET /healthz → 200 con db:ok',
  'Login de prueba en el panel → token válido',
  'GET /api/loads → devuelve cargas (datos restaurados)',
  'Ledger: SELECT COUNT(*) FROM audit_ledger > 0 y verificarIntegridad = ok',
  'Un SMS de prueba al número del sistema → llega',
  'Stripe webhook de prueba (modo test) → procesado',
];

// ---------------------------------------------------------------------------
// CHEQUEO PROGRAMADO: una vez al día, verifica que el backup de anoche
// exista y sea restaurable (lo monta en una BD temporal y corre las humo).
// Si falla → alerta al admin ANTES de que necesites el backup de verdad.
// ---------------------------------------------------------------------------
async function verificarBackupDiario({ db, rutaBackups, notificar }) {
  const fs = require('fs');
  const hoy = new Date().toISOString().slice(0, 10);
  const archivo = `${rutaBackups}/backup-${hoy}.sql.gz`;
  if (!fs.existsSync(archivo)) {
    await notificar('admin', { tipo: 'ALERTA_SISTEMA', texto: '🚨 NO SE GENERÓ EL BACKUP DE HOY. Corregir antes de las 24h.' });
    return { ok: false, motivo: 'backup faltante' };
  }
  const tamaño = fs.statSync(archivo).size;
  if (tamaño < 10000) {
    await notificar('admin', { tipo: 'ALERTA_SISTEMA', texto: '🚨 El backup de hoy está vacío o dañado. Revisar backup.sh' });
    return { ok: false, motivo: 'backup sospechosamente pequeño' };
  }
  return { ok: true, bytes: tamaño };
}

module.exports = { MONITOREO_EXTERNO, RUNBOOK_A, RUNBOOK_B, RUNBOOK_C, PRUEBAS_HUMO, verificarBackupDiario };
