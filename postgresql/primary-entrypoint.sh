#!/bin/bash
# Entrypoint for the "postgres" (primary) service.
#
# Ensures the dedicated replication role + pg_hba.conf entry that
# postgres-replica needs exist, idempotently, on every boot — not just on a
# fresh initdb. Postgres only runs /docker-entrypoint-initdb.d/ scripts
# against a brand-new (empty) PGDATA, so a pre-existing local dev volume
# from before this feature existed would otherwise never get this setup,
# and postgres-replica would crash-loop forever on "no pg_hba.conf entry
# for replication connection" / "role does not exist".
set -euo pipefail

: "${REPLICATION_USER:?REPLICATION_USER env var is required}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD env var is required}"
: "${POSTGRES_USER:?POSTGRES_USER env var is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD env var is required}"
: "${POSTGRES_DB:?POSTGRES_DB env var is required}"

(
  until pg_isready -h 127.0.0.1 -p 5432 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; do
    sleep 1
  done

  export PGPASSWORD="${POSTGRES_PASSWORD}"

  role_exists="$(psql -tA -h 127.0.0.1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c \
    "SELECT 1 FROM pg_roles WHERE rolname = '${REPLICATION_USER}'")"
  if [ "${role_exists}" != "1" ]; then
    echo "[primary-entrypoint] creating replication role ${REPLICATION_USER}"
    psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c \
      "CREATE ROLE \"${REPLICATION_USER}\" WITH REPLICATION LOGIN ENCRYPTED PASSWORD '${REPLICATION_PASSWORD}';"
  else
    psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c \
      "ALTER ROLE \"${REPLICATION_USER}\" WITH REPLICATION LOGIN ENCRYPTED PASSWORD '${REPLICATION_PASSWORD}';"
  fi

  if ! grep -q "replication ${REPLICATION_USER} " "${PGDATA}/pg_hba.conf" 2>/dev/null; then
    echo "[primary-entrypoint] opening pg_hba.conf for ${REPLICATION_USER}"
    echo "host replication ${REPLICATION_USER} samenet scram-sha-256" >> "${PGDATA}/pg_hba.conf"
    psql -h 127.0.0.1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "SELECT pg_reload_conf();" >/dev/null
  fi
) &

exec docker-entrypoint.sh "$@"
