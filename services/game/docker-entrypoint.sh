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

# six-feat-game — игровой сервис (SF-GAME-10). Тот же Postgres-кластер,
# game_* таблицы в SF-GAME-11. Entry point собирает DSN и ждёт Postgres
# аналогично services/enrichment/docker-entrypoint.sh.
#
# [SF-GAME-12] APP_SECRET читается из env session_crypto::KeyFromEnv() для
# локальной расшифровки six_feat_session cookie (без HTTP к six-feat-auth) —
# ДОЛЖЕН совпадать со значением остального mesh, иначе game не прочитает
# сессии, выданные другими сервисами. Проверяем здесь, а не в конструкторе
# ProfileHandler.
: "${APP_SECRET:?APP_SECRET env var is required for session decryption — MUST match the rest of the mesh, generate with: openssl rand -hex 32}"

# [SF-GAME-13] Общий секрет для внутренних вызовов к six-feat
# (POST /internal/neighbours, см. neighbours_client.cpp) — читается из env
# через internal_api::SharedSecretFromEnv(), ДОЛЖЕН совпадать со значением
# остального mesh. Проверяем здесь, а не в конструкторе NeighboursClient.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required for internal-mesh calls to six-feat — MUST match the rest of the mesh, generate with: openssl rand -hex 32}"

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
# [SF-GAME-13] Адрес основного six-feat для античита (neighbours_client.cpp).
# Тот же compose-network формат, что ENRICHMENT_BASE_URL/GENIUS_GATEWAY_BASE_URL
# в основном entrypoint.
SIX_FEAT_BASE_URL="${SIX_FEAT_BASE_URL:-http://six-feat:8080}"

if [[ -n "$DB_REPLICA_HOST" ]]; then
  echo "[entrypoint] six-feat-game Postgres target: ${DB_HOST}:${DB_PORT} (master), ${DB_REPLICA_HOST}:${DB_REPLICA_PORT} (replica), db=${DB_NAME}"
else
  echo "[entrypoint] six-feat-game Postgres target: ${DB_HOST}:${DB_PORT} (single instance, no replica), db=${DB_NAME}"
fi

# ── Ожидание готовности Postgres ─────────────────────────────────────────────
# Та же логика, что в enrichment: depends_on/healthcheck блокируют только
# первый старт, при рестарте нужна своя проверка. pg_isready — протокольная
# готовность, а не TCP. Задержка меньше HEALTHCHECK-бюджета.
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
six_feat_base_url: "${SIX_FEAT_BASE_URL}"
game_admin_genius_ids: "${GAME_ADMIN_GENIUS_IDS:-}"
EOF

exec /app/six_feat_game \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
