#!/bin/sh
# Официальный образ postgres не умеет стартовать репликой: на пустом data-каталоге
# ждём primary и делаем pg_basebackup -R (пишет standby.signal + primary_conninfo),
# затем передаём управление штатному docker-entrypoint.sh. Повторные рестарты
# пропускают basebackup — standby.signal уже на месте.
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

    # pg_basebackup сохраняет права primary, а postgres требует 0700 на PGDATA
    chmod 0700 "$DATA_DIR"
    echo "[replica-entrypoint] Base backup complete — standby.signal + primary_conninfo written."
fi

exec docker-entrypoint.sh postgres
