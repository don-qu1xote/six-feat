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

: "${YANDEX_SERVICE_TOKEN:?YANDEX_SERVICE_TOKEN env var is required — a single Yandex Music OAuth token for the whole deployment (NOT per-user), see docs/DEVELOPMENT.md}"
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six_feat / six-feat-enrichment, generate with: openssl rand -hex 32}"

YANDEX_DEVICE_CLIENT_ID="${YANDEX_DEVICE_CLIENT_ID:-}"
if [[ -n "${YANDEX_DEVICE_CLIENT_ID}" ]]; then
  : "${YANDEX_DEVICE_CLIENT_SECRET:?YANDEX_DEVICE_CLIENT_SECRET env var is required when YANDEX_DEVICE_CLIENT_ID is set — same app as YANDEX_OAUTH_CLIENT_ID (both scopes enabled), oauth.yandex.ru/token returns invalid_client without it}"
fi
YANDEX_DEVICE_SCOPE="${YANDEX_DEVICE_SCOPE:-music:api-public}"
LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

cat > /tmp/config_vars.yaml <<EOF
yandex_device_client_id: ${YANDEX_DEVICE_CLIENT_ID}
yandex_device_scope: '${YANDEX_DEVICE_SCOPE}'
logging_level: ${LOGGING_LEVEL}
EOF

exec /app/six_feat_yandex_gateway \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
