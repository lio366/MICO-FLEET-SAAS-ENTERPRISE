#!/usr/bin/env bash
# Asigna la contraseña del login de aplicación (mf_login) durante el init de PostgreSQL.
# psql NO interpola variables en --command; el SQL debe llegar por stdin para que
# :'app_password' se sustituya como literal correctamente escapado.
set -euo pipefail
: "${MF_APP_PASSWORD:?MF_APP_PASSWORD no definido}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --no-psqlrc --set=ON_ERROR_STOP=1 --set=app_password="$MF_APP_PASSWORD" <<'SQL'
ALTER ROLE mf_login PASSWORD :'app_password';
SQL
