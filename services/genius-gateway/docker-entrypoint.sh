#!/usr/bin/env bash

set -euo pipefail

# ── Env-профиль ──────────────────────────────────────────────────────────────
# Аналогичный блок — см. services/six-feat/docker-entrypoint.sh.
ENV_PROFILE="${ENV_PROFILE:-dev}"
PROFILE_FILE="/app/config/profiles/${ENV_PROFILE}.env"
if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "[entrypoint] ERROR: ENV_PROFILE=${ENV_PROFILE} but ${PROFILE_FILE} not found (expected dev, staging, or prod — see config/profiles/)" >&2
  exit 1
fi
echo "[entrypoint] ENV_PROFILE=${ENV_PROFILE} (${PROFILE_FILE})"
set -a
# shellcheck disable=SC1090
source "$PROFILE_FILE"
set +a

# six-feat-genius-gateway не имеет OAuth/сессий и не работает с БД — берёт
# user_token из пересылаемого вызывающими (six_feat, six-feat-enrichment).
# Единственный секрет при старте — общий внутренний ключ.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six_feat / six-feat-enrichment, generate with: openssl rand -hex 32}"

LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

cat > /tmp/config_vars.yaml <<EOF
logging_level: ${LOGGING_LEVEL}
EOF

exec /app/six_feat_genius_gateway \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
