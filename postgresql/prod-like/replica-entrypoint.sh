#!/bin/sh
# postgresql/prod-like/replica-entrypoint.sh — SF-INF-02
#
# Custom entrypoint for the postgres-replica service (docker-compose.yml,
# "prod-like" profile). The official postgres image has no built-in
# "bootstrap as a streaming standby of X" mode — this script bridges that:
#
#   1. On a genuinely first start (empty data dir), wait for the primary
#      (`postgres`) to accept connections, then take a physical base
#      backup FROM it with `pg_basebackup -R`. -R writes standby.signal +
#      primary_conninfo into postgresql.auto.conf automatically — the data
#      directory this produces boots directly into streaming-replica mode,
#      no separate `recovery.conf`/manual signal-file step needed (that
#      old recovery.conf mechanism was removed in PG12+; -R is the
#      current equivalent).
#   2. Hand off to the official image's own entrypoint (already on PATH as
#      docker-entrypoint.sh) exactly like an un-overridden `postgres`
#      service would — same permission-fixing/signal-handling it always
#      does, just now starting from a basebackup'd data dir instead of a
#      fresh initdb.
#
# Idempotent: a non-empty data dir (any restart after the first) skips
# straight to step 2 — the standby.signal file pg_basebackup -R wrote
# persists across restarts, so postgres keeps coming back up as a replica
# without repeating the basebackup.
set -e

DATA_DIR="${PGDATA:-/var/lib/postgresql/data}"

if [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
    echo "[replica-entrypoint] Empty data dir — waiting for primary ${PRIMARY_HOST}:${PRIMARY_PORT}..."
    until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$DB_REPLICATOR_USER" >/dev/null 2>&1; do
        sleep 1
    done

    echo "[replica-entrypoint] Primary reachable — running pg_basebackup..."
    export PGPASSWORD="$DB_REPLICATOR_PASSWORD"
    pg_basebackup \
        -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$DB_REPLICATOR_USER" \
        -D "$DATA_DIR" -Fp -Xs -P -R
    unset PGPASSWORD

    # pg_basebackup preserves the primary's directory permissions, but
    # postgres itself still insists on 0700 for PGDATA at startup.
    chmod 0700 "$DATA_DIR"
    echo "[replica-entrypoint] Base backup complete — standby.signal + primary_conninfo written."
fi

exec docker-entrypoint.sh postgres
