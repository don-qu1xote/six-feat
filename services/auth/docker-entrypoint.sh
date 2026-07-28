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

# six-feat-auth владеет всем OAuth 2.0 флоу.
: "${GENIUS_CLIENT_ID:?GENIUS_CLIENT_ID env var is required for OAuth — from https://genius.com/api-clients}"
: "${GENIUS_CLIENT_SECRET:?GENIUS_CLIENT_SECRET env var is required for OAuth — keep it secret}"
: "${APP_SECRET:?APP_SECRET env var is required for session encryption — generate with: openssl rand -hex 32, and MUST match the main six_feat services APP_SECRET}"
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six-feat/six-feat-enrichment, generate with: openssl rand -hex 32}"

GENIUS_REDIRECT_URI="${GENIUS_REDIRECT_URI:-http://localhost:8083/auth/callback}"
COOKIE_SECURE="${COOKIE_SECURE:-true}"
LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

cat > /tmp/config_vars.yaml <<EOF
genius_client_id: ${GENIUS_CLIENT_ID}
genius_redirect_uri: ${GENIUS_REDIRECT_URI}
cookie_secure: ${COOKIE_SECURE}
logging_level: ${LOGGING_LEVEL}
EOF

exec /app/six_feat_auth \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
