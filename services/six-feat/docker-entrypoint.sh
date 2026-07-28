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

# Серверный токен Genius больше не нужен — вся авторизация через OAuth.
# Единственные секреты, необходимые при старте — OAuth-credentials
# (зарегистрированы на https://genius.com/api-clients) и ключ шифрования сессий.

# ── OAuth 2.0 ─────────────────────────────────────────────────────────────────
# client_id не секрет (попадает в config_vars.yaml ниже).
# client_secret + APP_SECRET — секреты, читаются напрямую из env
# компонентами C++ (OAuthConfig / session_crypto::KeyFromEnv), на диск не пишутся.
: "${GENIUS_CLIENT_ID:?GENIUS_CLIENT_ID env var is required for OAuth — from https://genius.com/api-clients}"
: "${GENIUS_CLIENT_SECRET:?GENIUS_CLIENT_SECRET env var is required for OAuth — keep it secret}"
: "${APP_SECRET:?APP_SECRET env var is required for session encryption — generate with: openssl rand -hex 32}"

# ENRICHMENT_INTERNAL_SECRET читается из env напрямую EnrichmentClient
# (в config_vars.yaml не пишется).
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six-feat-enrichment, generate with: openssl rand -hex 32}"
ENRICHMENT_BASE_URL="${ENRICHMENT_BASE_URL:-http://six-feat-enrichment:8081}"
GENIUS_GATEWAY_BASE_URL="${GENIUS_GATEWAY_BASE_URL:-http://six-feat-genius-gateway:8082}"
AUTH_BASE_URL="${AUTH_BASE_URL:-http://six-feat-auth:8083}"

# ── PostgreSQL ────────────────────────────────────────────────────────────────
: "${DB_NAME:?DB_NAME env var is required — Postgres database name}"
: "${DB_USER:?DB_USER env var is required — Postgres user}"
: "${DB_PASSWORD:?DB_PASSWORD env var is required — Postgres password, keep it secret}"

build_db_connection_string
log_db_target "Postgres"

GENIUS_REDIRECT_URI="${GENIUS_REDIRECT_URI:-http://localhost:8080/auth/callback}"
COOKIE_SECURE="${COOKIE_SECURE:-true}"
LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

# ── Кэширование фронтенд-бандлов ─────────────────────────────────────────────
SCRIPT_FILENAME_FILE=/usr/share/six_feat/.script-filename
if [[ ! -f "$SCRIPT_FILENAME_FILE" ]]; then
  echo "[entrypoint] ERROR: $SCRIPT_FILENAME_FILE missing — JS bundle was not baked into the image correctly" >&2
  exit 1
fi
SCRIPT_FILENAME="$(cat "$SCRIPT_FILENAME_FILE")"
SCRIPT_PATH="/${SCRIPT_FILENAME}"
SCRIPT_FILE_PATH="/usr/share/six_feat/${SCRIPT_FILENAME}"

STYLE_FILENAME_FILE=/usr/share/six_feat/.style-filename
if [[ ! -f "$STYLE_FILENAME_FILE" ]]; then
  echo "[entrypoint] ERROR: $STYLE_FILENAME_FILE missing — CSS bundle was not baked into the image correctly" >&2
  exit 1
fi
STYLE_FILENAME="$(cat "$STYLE_FILENAME_FILE")"
STYLE_PATH="/${STYLE_FILENAME}"
STYLE_FILE_PATH="/usr/share/six_feat/${STYLE_FILENAME}"

echo "[entrypoint] serving JS bundle as ${SCRIPT_PATH}"
echo "[entrypoint] serving CSS bundle as ${STYLE_PATH}"

# ── Ожидание готовности Postgres ─────────────────────────────────────────────
echo "[entrypoint] waiting for Postgres to be ready..."
wait_for_postgres "${DB_HOST}" "${DB_PORT}" 120
wait_for_postgres "${DB_REPLICA_HOST}" "${DB_REPLICA_PORT}" 10
sleep 1

cat > /tmp/config_vars.yaml <<EOF
genius_client_id: ${GENIUS_CLIENT_ID}
genius_redirect_uri: ${GENIUS_REDIRECT_URI}
cookie_secure: ${COOKIE_SECURE}
logging_level: ${LOGGING_LEVEL}
script_filename: ${SCRIPT_FILENAME}
script_path: ${SCRIPT_PATH}
script_url: ${SCRIPT_PATH}
script_file_path: ${SCRIPT_FILE_PATH}
style_filename: ${STYLE_FILENAME}
style_path: ${STYLE_PATH}
style_url: ${STYLE_PATH}
style_file_path: ${STYLE_FILE_PATH}
db_connection_string: "${DB_CONNECTION_STRING}"
enrichment_base_url: ${ENRICHMENT_BASE_URL}
genius_gateway_base_url: ${GENIUS_GATEWAY_BASE_URL}
auth_base_url: ${AUTH_BASE_URL}
EOF

exec /app/six_feat \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml