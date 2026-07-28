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

# six-feat-genius-gateway не имеет OAuth/сессий и не работает с БД.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six_feat / six-feat-enrichment, generate with: openssl rand -hex 32}"

LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

cat > /tmp/config_vars.yaml <<EOF
logging_level: ${LOGGING_LEVEL}
EOF

exec /app/six_feat_genius_gateway \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
