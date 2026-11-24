#!/usr/bin/env bash
# Ejecuta T1–T7 contra un clúster PostgreSQL 16 NATIVO y desechable (sin Docker).
# Replica docker-compose.postgres.yml: superusuario bootstrap = mf_bootstrap, auth SCRAM-SHA-256,
# base micro_fleet, y los scripts de docker-entrypoint-initdb.d (001_roles.sql + 002_set_password.sh).
#
# Requisitos: binarios PostgreSQL 16 (initdb, pg_ctl, psql), node >= 20, openssl,
#             y el driver `pg` resoluble por Node (npm ci, o NODE_PATH hacia un módulo compatible).
# Uso:        tests/integration/run_native_pg16.sh [directorio_de_trabajo]
# Variables:  PG_BIN (def. /usr/lib/postgresql/16/bin), PG_PORT (def. 55432), PG_OS_USER (def. postgres si se ejecuta como root)
# Salida:     código de salida de la suite; logs en <directorio_de_trabajo>/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${1:-$(mktemp -d /tmp/mf-pg16-XXXXXX)}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_PORT="${PG_PORT:-55432}"
DB=micro_fleet

for bin in initdb pg_ctl psql pg_isready; do
  [ -x "$PG_BIN/$bin" ] || { echo "BLOCKED: falta $PG_BIN/$bin (PostgreSQL 16)"; exit 3; }
done
command -v node >/dev/null || { echo "BLOCKED: falta node"; exit 3; }
command -v openssl >/dev/null || { echo "BLOCKED: falta openssl"; exit 3; }
node -e "require('pg')" 2>/dev/null || { echo "BLOCKED: el módulo 'pg' no es resoluble (ejecutar npm ci o definir NODE_PATH)"; exit 3; }

"$PG_BIN/postgres" --version | grep -q ' 16\.' || { echo "BLOCKED: se exige PostgreSQL 16"; exit 3; }

mkdir -p "$WORK"
umask 077
PGDATA="$WORK/pgdata"
SOCK="$WORK/sock"
SRVLOG="$WORK/srvlog"
mkdir -p "$PGDATA" "$SOCK" "$SRVLOG"
BOOT_PW="$(openssl rand -hex 24)"
APP_PW="$(openssl rand -hex 24)"
PWFILE="$(mktemp)"
printf '%s' "$BOOT_PW" > "$PWFILE"

run_pg() {
  if [ "$(id -u)" = "0" ]; then
    local os_user="${PG_OS_USER:-postgres}"
    chown -R "$os_user" "$PGDATA" "$SOCK" "$SRVLOG" "$PWFILE"
    chmod 711 "$WORK"
    if ! su "$os_user" -s /bin/bash -c "test -w '$PGDATA'"; then
      echo "BLOCKED: el usuario $os_user no puede acceder a $PGDATA (revisar permisos de los directorios padre de $WORK)" >&2
      exit 3
    fi
    su "$os_user" -s /bin/bash -c "$*"
  else
    bash -c "$*"
  fi
}

cleanup() {
  run_pg "'$PG_BIN/pg_ctl' -D '$PGDATA' -m fast -w stop" >/dev/null 2>&1 || true
  rm -f "$PWFILE"
}
trap cleanup EXIT

run_pg "'$PG_BIN/initdb' -D '$PGDATA' -U mf_bootstrap --pwfile='$PWFILE' --auth-local=scram-sha-256 --auth-host=scram-sha-256 -E UTF8 --locale=C.UTF-8" > "$WORK/initdb.log" 2>&1 \
  || { echo "FAIL: initdb falló; ver $WORK/initdb.log" >&2; tail -5 "$WORK/initdb.log" >&2; exit 1; }
run_pg "'$PG_BIN/pg_ctl' -D '$PGDATA' -l '$SRVLOG/postgres.log' -w -o \"-c listen_addresses=127.0.0.1 -p $PG_PORT -c unix_socket_directories=$SOCK -c timezone=UTC\" start" > /dev/null
"$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null

export PGHOST=127.0.0.1 PGPORT="$PG_PORT" PGPASSWORD="$BOOT_PW"
"$PG_BIN/psql" -U mf_bootstrap -d postgres -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $DB"
"$PG_BIN/psql" -U mf_bootstrap -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROOT/infra/postgres/001_roles.sql"
PATH="$PG_BIN:$PATH" POSTGRES_USER=mf_bootstrap POSTGRES_DB="$DB" MF_APP_PASSWORD="$APP_PW" \
  bash "$ROOT/infra/postgres/002_set_password.sh" > /dev/null
unset PGPASSWORD

{
  echo "fecha_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "postgres=$("$PG_BIN/postgres" --version)"
  echo "node=$(node --version)"
  echo "pg_driver=$(node -e "try{console.log(require('pg/package.json').version)}catch(e){console.log('desconocido')}")"
  echo "git_head=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 'sin-git')"
} > "$WORK/entorno.txt"

# Par Ed25519 de la ejecución, compartido por ambas suites (como CHECKPOINT_*_KEY en producción).
CHECKPOINT_PRIVATE_KEY="$(node -e "const {privateKey}=require('crypto').generateKeyPairSync('ed25519');process.stdout.write(privateKey.export({type:'pkcs8',format:'pem'}))" | tee "$WORK/.ckpt_priv.pem")"
CHECKPOINT_PUBLIC_KEY="$(node -e "const c=require('crypto');process.stdout.write(c.createPublicKey(require('fs').readFileSync('$WORK/.ckpt_priv.pem','utf8')).export({type:'spki',format:'pem'}))")"
rm -f "$WORK/.ckpt_priv.pem"
export CHECKPOINT_PRIVATE_KEY CHECKPOINT_PUBLIC_KEY PG_BIN
export PG_ADMIN_URL="postgresql://mf_bootstrap:${BOOT_PW}@127.0.0.1:${PG_PORT}/${DB}"
export DATABASE_URL="postgresql://mf_login:${APP_PW}@127.0.0.1:${PG_PORT}/${DB}"
export REQUIRE_PG_TESTS=1

set +e
node "$ROOT/tests/integration/postgres_t1_t7.js" 2>&1 | tee "$WORK/t1_t7.log"
STATUS_A=${PIPESTATUS[0]}
STATUS_B=99
STATUS_C=99
if [ "$STATUS_A" = "0" ]; then
  node "$ROOT/tests/integration/postgres_t8_t13.js" 2>&1 | tee "$WORK/t8_t13.log"
  STATUS_B=${PIPESTATUS[0]}
else
  echo "T8–T13 NO EJECUTADO: T1–T7 falló (exit $STATUS_A)" | tee "$WORK/t8_t13.log"
fi
if [ "$STATUS_B" = "0" ]; then
  node "$ROOT/tests/integration/postgres_t14_t16.js" 2>&1 | tee "$WORK/t14_t16.log"
  STATUS_C=${PIPESTATUS[0]}
else
  echo "T14–T16 NO EJECUTADO: T1–T13 falló" | tee "$WORK/t14_t16.log"
fi
STATUS_D=99
if [ "$STATUS_C" = "0" ]; then
  node "$ROOT/tests/integration/postgres_t17.js" 2>&1 | tee "$WORK/t17.log"
  STATUS_D=${PIPESTATUS[0]}
else
  echo "T17 NO EJECUTADO: T1–T16 falló" | tee "$WORK/t17.log"
fi
STATUS_E=99
if [ "$STATUS_D" = "0" ]; then
  node "$ROOT/tests/integration/postgres_t18.js" 2>&1 | tee "$WORK/t18.log"
  STATUS_E=${PIPESTATUS[0]}
else
  echo "T18 NO EJECUTADO: T1–T17 falló" | tee "$WORK/t18.log"
fi
STATUS_G=99
if [ "$STATUS_E" = "0" ]; then
  node "$ROOT/tests/integration/postgres_t19.js" 2>&1 | tee "$WORK/t19.log"
  STATUS_G=${PIPESTATUS[0]}
else
  echo "T19 NO EJECUTADO: T1–T18 falló" | tee "$WORK/t19.log"
fi
STATUS_H=99
if [ "$STATUS_G" = "0" ]; then
  node "$ROOT/tests/integration/postgres_t20.js" 2>&1 | tee "$WORK/t20.log"
  STATUS_H=${PIPESTATUS[0]}
else
  echo "T20 NO EJECUTADO: T1–T19 falló" | tee "$WORK/t20.log"
fi
STATUS_F=99
if [ "$STATUS_H" = "0" ]; then
  node "$ROOT/tests/integration/auditoria_sql.js" 2>&1 | tee "$WORK/auditoria_sql.log"
  STATUS_F=${PIPESTATUS[0]}
else
  echo "AUDITORÍA SQL NO EJECUTADA: T1–T20 falló" | tee "$WORK/auditoria_sql.log"
fi
set -e
STATUS=0
for s in "$STATUS_A" "$STATUS_B" "$STATUS_C" "$STATUS_D" "$STATUS_E" "$STATUS_G" "$STATUS_H" "$STATUS_F"; do
  if [ "$s" != "0" ]; then STATUS=$s; break; fi
done
{ echo "exit_t1_t7=$STATUS_A"; echo "exit_t8_t13=$STATUS_B"; echo "exit_t14_t16=$STATUS_C"; echo "exit_t17=$STATUS_D";
  echo "exit_t18=$STATUS_E"; echo "exit_t19=$STATUS_G"; echo "exit_t20=$STATUS_H"; echo "exit_auditoria_sql=$STATUS_F"; echo "exit_code=$STATUS"; } >> "$WORK/entorno.txt"
echo "Logs en: $WORK"
exit "$STATUS"
