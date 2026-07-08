#!/bin/bash
# Entrypoint for the "postgres-replica" service.
#
# On first boot (empty PGDATA) clones the primary via pg_basebackup with -R,
# which writes standby.signal + primary_conninfo for us — the upstream
# postgres image then starts this data directory in hot-standby/recovery
# mode automatically, so `SELECT pg_is_in_recovery()` is true here and
# userver's Cluster discovers it as a Slave host (see pg_topology docs).
# On restart, PGDATA is already populated, so we just resume as standby.
set -euo pipefail

: "${PRIMARY_HOST:?PRIMARY_HOST env var is required}"
: "${PRIMARY_PORT:?PRIMARY_PORT env var is required}"
: "${REPLICATION_USER:?REPLICATION_USER env var is required}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD env var is required}"

if [ -z "$(ls -A "${PGDATA}" 2>/dev/null)" ]; then
  echo "[replica-entrypoint] ${PGDATA} is empty — cloning from primary ${PRIMARY_HOST}:${PRIMARY_PORT}"

  until PGPASSWORD="${REPLICATION_PASSWORD}" pg_isready -h "${PRIMARY_HOST}" -p "${PRIMARY_PORT}" -U "${REPLICATION_USER}" >/dev/null 2>&1; do
    echo "[replica-entrypoint] waiting for primary to accept connections..."
    sleep 2
  done

  PGPASSWORD="${REPLICATION_PASSWORD}" pg_basebackup \
    -h "${PRIMARY_HOST}" -p "${PRIMARY_PORT}" \
    -U "${REPLICATION_USER}" \
    -D "${PGDATA}" \
    -Fp -Xs -P -R
  chmod 0700 "${PGDATA}"
  echo "[replica-entrypoint] base backup complete — starting as standby"
else
  echo "[replica-entrypoint] ${PGDATA} already populated — resuming as standby"
fi

exec docker-entrypoint.sh "$@"