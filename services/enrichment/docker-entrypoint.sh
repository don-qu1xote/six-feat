#!/usr/bin/env bash

set -euo pipefail

# six-feat-enrichment has no OAuth/session concerns of its own — it borrows
# the user_token forwarded by six_feat on every /internal/enqueue call. The
# only credentials this service needs at boot are the inter-service shared
# secret and the (shared) Postgres connection.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six_feat, generate with: openssl rand -hex 32}"

# [IDEA-46] Genius API access moved to the standalone six-feat-genius-gateway
# service — GeniusGatewayClient talks to it over HTTP, gated by the same
# ENRICHMENT_INTERNAL_SECRET checked above.
GENIUS_GATEWAY_BASE_URL="${GENIUS_GATEWAY_BASE_URL:-http://six-feat-genius-gateway:8082}"

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
# Optional — see the matching comment in the root docker-entrypoint.sh:
# leave unset for a single Postgres instance, or point at a real streaming
# replica for genuine kMaster/kSlave read isolation. Never point this at the
# same host as DB_HOST — see DEVELOPMENT.md, "Postgres cluster topology".
DB_REPLICA_HOST="${DB_REPLICA_HOST:-}"
DB_REPLICA_PORT="${DB_REPLICA_PORT:-5432}"
: "${DB_NAME:?DB_NAME env var is required — Postgres database name}"
: "${DB_USER:?DB_USER env var is required — Postgres user}"
: "${DB_PASSWORD:?DB_PASSWORD env var is required — Postgres password, keep it secret}"

if [[ -n "$DB_REPLICA_HOST" ]]; then
  DB_CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT},${DB_REPLICA_HOST}:${DB_REPLICA_PORT}/${DB_NAME}"
else
  DB_CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

if [[ -n "$DB_REPLICA_HOST" ]]; then
  echo "[entrypoint] six-feat-enrichment Postgres target: ${DB_HOST}:${DB_PORT} (master), ${DB_REPLICA_HOST}:${DB_REPLICA_PORT} (replica), db=${DB_NAME}"
else
  echo "[entrypoint] six-feat-enrichment Postgres target: ${DB_HOST}:${DB_PORT} (single instance, no replica), db=${DB_NAME}"
fi

# ── Wait for Postgres to actually be reachable ─────────────────────────────
# See the matching comment in the main service's docker-entrypoint.sh: on a
# Postgres restart that lands close to this container's own restart,
# postgres-db-1's synchronous pool bootstrap (static_config.yaml's
# sync-start: true) races Postgres coming back up. A couple of transient
# connection failures there trip userver's connection-pool circuit breaker,
# and persistent-store's own single-shot connection attempt right after gets
# rejected outright, crashing the whole process with an unhandled exception.
# depends_on/healthcheck in docker-compose.yml only gate this container's
# first start, not its "restart: unless-stopped" restarts, so wait here too.
#
# Capped well under the HEALTHCHECK's own budget so a slow/absent Postgres
# fails the container's healthcheck instead of hanging the entrypoint
# indefinitely. The replica is a soft dependency (cluster falls back to
# master reads without it, and some deployments of this compose file don't
# run a replica at all), so it only gets a brief best-effort wait.
wait_for_postgres() {
  local host="$1" port="$2" max="$3" waited=0
  until (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; do
    waited=$((waited + 1))
    if (( waited >= max )); then
      echo "[entrypoint] WARNING: gave up waiting for ${host}:${port} after ${max}s, starting anyway" >&2
      return 0
    fi
    sleep 1
  done
}

echo "[entrypoint] waiting for Postgres to accept TCP connections..."
wait_for_postgres "${DB_HOST}" "${DB_PORT}" 20
wait_for_postgres "${DB_REPLICA_HOST}" "${DB_REPLICA_PORT}" 5
sleep 1

cat > /app/config_vars.yaml <<EOF
logging_level: ${LOGGING_LEVEL}
db_connection_string: "${DB_CONNECTION_STRING}"
genius_gateway_base_url: ${GENIUS_GATEWAY_BASE_URL}
EOF

exec /app/six_feat_enrichment \
  --config /app/static_config.yaml \
  --config_vars /app/config_vars.yaml
