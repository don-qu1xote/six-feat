#!/usr/bin/env bash

set -euo pipefail

# ── Env-профиль (SF-CFG-01) ──────────────────────────────────────────────────
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

# six-feat-enrichment не имеет собственных OAuth/сессий — берёт user_token
# из пересылаемого six_feat на каждом /internal/enqueue. Единственные
# необходимые при старте секреты — общий внутренний ключ и (общий) Postgres.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six_feat, generate with: openssl rand -hex 32}"

# [IDEA-46] Genius API — через отдельный six-feat-genius-gateway
# (GeniusGatewayClient, HTTP, тот же ENRICHMENT_INTERNAL_SECRET).
GENIUS_GATEWAY_BASE_URL="${GENIUS_GATEWAY_BASE_URL:-http://six-feat-genius-gateway:8082}"

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
# Опционально — оставить пустым для одного инстанса, задать реальный хост
# реплики для kMaster/kSlave. НЕ указывать тот же хост, что и DB_HOST
# (см. DEVELOPMENT.md, «Postgres cluster topology»).
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

# ── Ожидание готовности Postgres ─────────────────────────────────────────────
# Та же логика, что в основном six-feat: depends_on/healthcheck блокируют
# только первый старт, при рестарте нужна своя проверка. pg_isready —
# протокольная готовность, а не TCP. Задержка меньше HEALTHCHECK-бюджета.
# Реплика — мягкая зависимость, кратковременное ожидание.
wait_for_postgres() {
  local host="$1" port="$2" max="$3" waited=0
  [[ -z "$host" ]] && return 0
  until pg_isready -h "$host" -p "$port" -U "${DB_USER}" -d "${DB_NAME}" -t 3 >/dev/null 2>&1; do
    if (( waited >= max )); then
      echo "[entrypoint] WARNING: gave up waiting for ${host}:${port} to report ready after ${max}s, starting anyway" >&2
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

echo "[entrypoint] waiting for Postgres to be ready..."
wait_for_postgres "${DB_HOST}" "${DB_PORT}" 120
wait_for_postgres "${DB_REPLICA_HOST}" "${DB_REPLICA_PORT}" 10
sleep 1

cat > /tmp/config_vars.yaml <<EOF
logging_level: ${LOGGING_LEVEL}
db_connection_string: "${DB_CONNECTION_STRING}"
genius_gateway_base_url: ${GENIUS_GATEWAY_BASE_URL}
EOF

exec /app/six_feat_enrichment \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
