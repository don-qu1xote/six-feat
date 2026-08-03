#!/bin/sh
# Выполняется механизмом /docker-entrypoint-initdb.d/ при первом старте пустого data-каталога:
# создаёт роль репликации и открывает pg_hba.conf для физической репликации.
# Смонтирован безусловно, но идемпотентен и безвреден для дефолтного профиля.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE "${DB_REPLICATOR_USER}" WITH REPLICATION LOGIN PASSWORD '${DB_REPLICATOR_PASSWORD}';
EOSQL

# 0.0.0.0/0 — это только compose-сеть (host-порт у postgres не опубликован)
echo "host replication ${DB_REPLICATOR_USER} 0.0.0.0/0 md5" >> "${PGDATA}/pg_hba.conf"
