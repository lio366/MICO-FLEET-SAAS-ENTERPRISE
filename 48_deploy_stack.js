// ============================================================================
// 48_deploy_stack.js — PILA DE DESPLIEGUE (de cero a producción en 20 min)
// Versión 5.4
//
// SERVIDOR ÚNICO (arranque): 1 VPS Hetzner (~$6/mes) corre TODO:
// Postgres + Redis + la app (server/index.js) + Caddy (HTTPS automático).
// Cuando crezcas, la MISMA pila se replica a más VPS (archivo 47 manda).
//
// ESTE ARCHIVO ES EL CÓDIGO FUENTE DE: docker-compose.yml, Caddyfile,
// .env de ejemplo y scripts de despliegue. Edítalo y regenera con:
//   node 48_deploy_stack.js
// ============================================================================

const fs = require('fs');

const COMPOSE = `version: "3.9"
services:
  app:
    build: .
    restart: always
    env_file: .env
    depends_on: [db, redis]
    ports: ["127.0.0.1:3000:3000"]   # solo local: Caddy pone HTTPS delante
    deploy: { resources: { limits: { memory: 512M } } }
  db:
    image: postgres:16
    restart: always
    env_file: .env
    volumes: ["pgdata:/var/lib/postgresql/data", "./backups:/backups"]
    command: postgres -c wal_level=replica -c max_wal_senders=3
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U microfleet"]
      interval: 10s
  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --maxmemory 128mb --maxmemory-policy allkeys-lru
  caddy:
    image: caddy:2
    restart: always
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddydata:/data"]
volumes: { pgdata: {}, caddydata: {} }
`;

const CADDYFILE = `# HTTPS automático (Let's Encrypt) sin configurar nada
api.tudominio.com {
    reverse_proxy app:3000
}
# El panel del broker y la web app salen del mismo servidor
app.tudominio.com {
    reverse_proxy app:3000
}
`;

const ENV_EJEMPLO = `# === OBLIGATORIOS ===
DATABASE_URL=postgres://microfleet:CAMBIA-ESTA-CLAVE@db:5432/microfleet
JWT_SECRET=genera-uno-largo-y-aleatorio
STRIPE_SECRET=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
TWILIO_SID=AC...
TWILIO_TOKEN=...
TWILIO_NUMERO=+1...
OPENROUTER_KEY=sk-or-...
# === GRATIS (opcionales, con clave gratis en su web) ===
FMCSA_API_KEY=
ORS_API_KEY=
EIA_API_KEY=
# === SEGURIDAD ===
CORS_ORIGINS=https://app.tudominio.com,https://api.tudominio.com
PORT=3000
`;

const DOCKERFILE = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
`;

// ---------------------------------------------------------------------------
// Script de despliegue en servidor nuevo (Hetzner/DigitalOcean/Vultr, Ubuntu)
// ---------------------------------------------------------------------------
const DEPLOY_SH = `#!/bin/bash
# Uso: ./deploy.sh   (en un VPS Ubuntu 22.04 limpio)
set -e
apt update && apt install -y docker.io docker-compose-plugin ufw
ufw allow 80,443/tcp && ufw --force enable
git clone https://github.com/TU-USUARIO/micro-fleet.git /opt/micro-fleet && cd /opt/micro-fleet
cp .env.ejemplo .env   # EDITA LAS CLAVES ANTES DE SEGUIR
nano .env
docker compose up -d --build
echo "Listo. El panel está en https://app.tudominio.com"
`;

// ---------------------------------------------------------------------------
// Backup diario automático (PG_DUMP a las 3am, retención 30 días)
// ---------------------------------------------------------------------------
const BACKUP_SH = `#!/bin/bash
# Cron: 0 3 * * * /opt/micro-fleet/backup.sh
cd /opt/micro-fleet
docker compose exec -T db pg_dump -U microfleet microfleet | gzip > backups/backup-$(date +%F).sql.gz
# Copia externa GRATIS: Backblaze B2 (10GB gratis) o rclone a Google Drive
rclone copy backups remote:micro-fleet-backups 2>/dev/null || true
ls -t backups/*.sql.gz | tail -n +31 | xargs -r rm
`;

function generar() {
  fs.writeFileSync('docker-compose.yml', COMPOSE);
  fs.writeFileSync('Caddyfile', CADDYFILE);
  fs.writeFileSync('.env.ejemplo', ENV_EJEMPLO);
  fs.writeFileSync('Dockerfile', DOCKERFILE);
  fs.writeFileSync('deploy.sh', DEPLOY_SH);
  fs.writeFileSync('backup.sh', BACKUP_SH);
  console.log('Generados: docker-compose.yml, Caddyfile, .env.ejemplo, Dockerfile, deploy.sh, backup.sh');
}

module.exports = { COMPOSE, CADDYFILE, ENV_EJEMPLO, DOCKERFILE, DEPLOY_SH, BACKUP_SH, generar };

// Ejecutar directamente: node 48_deploy_stack.js
if (require.main === module) generar();
