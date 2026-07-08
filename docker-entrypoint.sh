#!/usr/bin/env bash

set -euo pipefail

# [ТЗ-6] No more server-level Genius token / config-supplied credentials.
# Every Genius API call is made with a per-user OAuth session token obtained
# via /auth/login — there is nothing to paste into a config file anymore.
# The only credentials this service needs at boot are the OAuth app's own
# client_id/client_secret (registered once at https://genius.com/api-clients)
# plus the session-encryption secret.

# ── OAuth 2.0 ─────────────────────────────────────────────────────────────────
# client_id is not secret (goes into config_vars.yaml below).
# client_secret + APP_SECRET are secrets and are consumed directly from env by
# the C++ components (OAuthConfig / session_crypto::KeyFromEnv) — never written
# to disk here.
: "${GENIUS_CLIENT_ID:?GENIUS_CLIENT_ID env var is required for OAuth — from https://genius.com/api-clients}"
: "${GENIUS_CLIENT_SECRET:?GENIUS_CLIENT_SECRET env var is required for OAuth — keep it secret}"
: "${APP_SECRET:?APP_SECRET env var is required for session encryption — generate with: openssl rand -hex 32}"

# [IDEA-26] Background enrichment now runs in the standalone
# six-feat-enrichment service — this service only talks to it over HTTP.
# ENRICHMENT_INTERNAL_SECRET is read directly from the environment by
# EnrichmentClient (never written to config_vars.yaml), same handling as
# GENIUS_CLIENT_SECRET/APP_SECRET above; validated here too so a missing
# secret fails loudly at container boot instead of on the first request.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six-feat-enrichment, generate with: openssl rand -hex 32}"
ENRICHMENT_BASE_URL="${ENRICHMENT_BASE_URL:-http://six-feat-enrichment:8081}"

# [IDEA-46] Genius API access moved to the standalone six-feat-genius-gateway
# service — GeniusGatewayClient talks to it over HTTP, gated by the same
# ENRICHMENT_INTERNAL_SECRET checked above.
GENIUS_GATEWAY_BASE_URL="${GENIUS_GATEWAY_BASE_URL:-http://six-feat-genius-gateway:8082}"

# ── PostgreSQL ────────────────────────────────────────────────────────────────
# host/port have Docker-Compose-friendly defaults; db/user/password are always
# required (docker-compose's postgres service and this container must agree
# on them — see docker-compose.yml).
DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
# Read replica — streaming standby of DB_HOST (see docker-compose's
# postgres-replica service). Reads in src/storage/persistent_store.cpp are issued
# with ClusterHostType::kSlave; without a real host here the cluster has no
# Slave pool and userver falls back to master for every read.
DB_REPLICA_HOST="${DB_REPLICA_HOST:-postgres-replica}"
DB_REPLICA_PORT="${DB_REPLICA_PORT:-5432}"
: "${DB_NAME:?DB_NAME env var is required — Postgres database name}"
: "${DB_USER:?DB_USER env var is required — Postgres user}"
: "${DB_PASSWORD:?DB_PASSWORD env var is required — Postgres password, keep it secret}"

# Assembled only in memory / in the runtime config_vars.yaml written below —
# never committed to a tracked file. Multi-host DSN: userver's Cluster
# connects to every host and discovers master/slave dynamically via
# pg_is_in_recovery(), so host order here doesn't matter.
DB_CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT},${DB_REPLICA_HOST}:${DB_REPLICA_PORT}/${DB_NAME}"

# Optional overrides with sane defaults.
GENIUS_REDIRECT_URI="${GENIUS_REDIRECT_URI:-http://localhost:8080/auth/callback}"
# Secure-by-default: cookies get the Secure flag unless explicitly disabled.
# Only set COOKIE_SECURE=false for local HTTP development.
COOKIE_SECURE="${COOKIE_SECURE:-true}"

# Quiet-by-default: debug is verbose enough to leak tokens/URLs-with-tokens
# into stderr. Only set LOGGING_LEVEL=debug for local troubleshooting.
LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

# ── Front-end asset cache-busting ──────────────────────────────────────────
# The Dockerfile bakes the actual content-hashed JS bundle filename (e.g.
# script.a1b2c3d4.js) into /usr/share/six_feat/.script-filename at image
# build time (see js-builder stage + hash-build.mjs). We read it here and
# feed it into config_vars.yaml so:
#   - handler-script's route/file-path point at the real hashed file
#   - handler-index rewrites its "/script.js" reference to the same URL
# This means a rebuilt image with changed JS content gets a new hash, a new
# URL, and the browser picks it up on a normal refresh — no manual cache
# clearing, no hard-refresh (index.html itself is served no-cache; the
# hashed script URL is served cache-forever, since its name changes
# whenever its content does).
SCRIPT_FILENAME_FILE=/usr/share/six_feat/.script-filename
if [[ ! -f "$SCRIPT_FILENAME_FILE" ]]; then
  echo "[entrypoint] ERROR: $SCRIPT_FILENAME_FILE missing — JS bundle was not baked into the image correctly" >&2
  exit 1
fi
SCRIPT_FILENAME="$(cat "$SCRIPT_FILENAME_FILE")"
SCRIPT_PATH="/${SCRIPT_FILENAME}"
SCRIPT_FILE_PATH="/usr/share/six_feat/${SCRIPT_FILENAME}"

echo "[entrypoint] serving JS bundle as ${SCRIPT_PATH}"
echo "[entrypoint] Postgres target: ${DB_HOST}:${DB_PORT} (master), ${DB_REPLICA_HOST}:${DB_REPLICA_PORT} (replica), db=${DB_NAME}"

cat > /tmp/config_vars.yaml <<EOF
genius_client_id: ${GENIUS_CLIENT_ID}
genius_redirect_uri: ${GENIUS_REDIRECT_URI}
cookie_secure: ${COOKIE_SECURE}
logging_level: ${LOGGING_LEVEL}
script_filename: ${SCRIPT_FILENAME}
script_path: ${SCRIPT_PATH}
script_url: ${SCRIPT_PATH}
script_file_path: ${SCRIPT_FILE_PATH}
db_connection_string: "${DB_CONNECTION_STRING}"
enrichment_base_url: ${ENRICHMENT_BASE_URL}
genius_gateway_base_url: ${GENIUS_GATEWAY_BASE_URL}
EOF

exec /app/six_feat \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml