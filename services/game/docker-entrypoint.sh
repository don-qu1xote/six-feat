#!/usr/bin/env bash

set -euo pipefail

readonly COMMON_ENTRYPOINT="/app/services/.base/docker-entrypoint-common.sh"
if [[ ! -f "$COMMON_ENTRYPOINT" ]]; then
  echo "[entrypoint] ERROR: ${COMMON_ENTRYPOINT} not found — check Dockerfile or volume mount" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$COMMON_ENTRYPOINT"

load_env_profile

: "${APP_SECRET:?APP_SECRET env var is required for session decryption — MUST match the rest of the mesh, generate with: openssl rand -hex 32}"

: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required for internal-mesh calls to six-feat — MUST match the rest of the mesh, generate with: openssl rand -hex 32}"

: "${DB_NAME:?DB_NAME env var is required — Postgres database name}"
: "${DB_USER:?DB_USER env var is required — Postgres user}"
: "${DB_PASSWORD:?DB_PASSWORD env var is required — Postgres password, keep it secret}"

build_db_connection_string
log_db_target "six-feat-game"

LOGGING_LEVEL="${LOGGING_LEVEL:-info}"
SIX_FEAT_BASE_URL="${SIX_FEAT_BASE_URL:-http://six-feat:8080}"

echo "[entrypoint] waiting for Postgres to be ready..."
wait_for_postgres "${DB_HOST}" "${DB_PORT}" 120
wait_for_postgres "${DB_REPLICA_HOST}" "${DB_REPLICA_PORT}" 10
sleep 1

cat > /tmp/config_vars.yaml <<EOF
logging_level: ${LOGGING_LEVEL}
db_connection_string: "${DB_CONNECTION_STRING}"
six_feat_base_url: "${SIX_FEAT_BASE_URL}"
game_admin_genius_ids: "${GAME_ADMIN_GENIUS_IDS:-}"
EOF

exec /app/six_feat_game \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
