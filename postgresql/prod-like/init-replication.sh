#!/bin/sh
# postgresql/prod-like/init-replication.sh — SF-INF-02
#
# Runs once, automatically, via the official postgres image's
# /docker-entrypoint-initdb.d/ mechanism — ONLY on the very first start of
# a fresh (empty) data directory. Creates the dedicated replication role
# postgres-replica authenticates as, and opens pg_hba.conf for physical
# replication connections.
#
# Mounted into the `postgres` service (docker-compose.yml) unconditionally
# — not gated behind the "prod-like" profile itself, since it's harmless
# and idempotent-by-construction for the default single-instance profile
# (a replication-capable role that never gets used costs nothing). This is
# what lets `postgres` serve as the primary the moment postgres-replica
# (prod-like profile only) also starts, without needing a separate,
# always-on "postgres-primary" service — see the comment on `postgres` in
# docker-compose.yml for why that specific service-naming choice matters
# for depends_on/profile interaction.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE "${DB_REPLICATOR_USER}" WITH REPLICATION LOGIN PASSWORD '${DB_REPLICATOR_PASSWORD}';
EOSQL

# [prod-like only] Physical replication connections from postgres-replica —
# scoped to the "replication" pseudo-database (not real data), password-
# authenticated, and only reachable at all from inside the compose network
# (postgres publishes no host port) — see docker-compose.yml's own comment
# on the `postgres` service for that boundary. 0.0.0.0/0 here means "any
# container on this compose network", not "any host on the internet".
echo "host replication ${DB_REPLICATOR_USER} 0.0.0.0/0 md5" >> "${PGDATA}/pg_hba.conf"
