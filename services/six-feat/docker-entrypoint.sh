#!/usr/bin/env bash

set -euo pipefail

# ── Env-профиль ──────────────────────────────────────────────────────────────
# Источник дефолтов (LOGGING_LEVEL, COOKIE_SECURE, DB_REPLICA_HOST и т.д.)
# — выбирается через ENV_PROFILE, см. DEVELOPMENT.md «Env-профили».
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

# Серверный токен Genius больше не нужен — вся авторизация через OAuth.
# Единственные секреты, необходимые при старте — OAuth- credentials
# (зарегистрированы на https://genius.com/api-clients) и ключ шифрования сессий.

# ── OAuth 2.0 ─────────────────────────────────────────────────────────────────
# client_id не секрет (попадает в config_vars.yaml ниже).
# client_secret + APP_SECRET — секреты, читаются напрямую из env
# компонентами C++ (OAuthConfig / session_crypto::KeyFromEnv), на диск не пишутся.
: "${GENIUS_CLIENT_ID:?GENIUS_CLIENT_ID env var is required for OAuth — from https://genius.com/api-clients}"
: "${GENIUS_CLIENT_SECRET:?GENIUS_CLIENT_SECRET env var is required for OAuth — keep it secret}"
: "${APP_SECRET:?APP_SECRET env var is required for session encryption — generate with: openssl rand -hex 32}"

# Фоновое обогащение теперь в отдельном six-feat-enrichment.
# ENRICHMENT_INTERNAL_SECRET читается из env напрямую EnrichmentClient
# (в config_vars.yaml не пишется) — проверяется и здесь, чтобы пропуск
# секрета падал сразу при старте контейнера, а не на первом запросе.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six-feat-enrichment, generate with: openssl rand -hex 32}"
ENRICHMENT_BASE_URL="${ENRICHMENT_BASE_URL:-http://six-feat-enrichment:8081}"

# Genius API — через отдельный six-feat-genius-gateway
# (GeniusGatewayClient, HTTP, тот же ENRICHMENT_INTERNAL_SECRET).
GENIUS_GATEWAY_BASE_URL="${GENIUS_GATEWAY_BASE_URL:-http://six-feat-genius-gateway:8082}"

# AppSecretParityChecker — сверяет отпечаток APP_SECRET
# этого процесса с six-feat-auth по HTTP, сам секрет не передаётся.
AUTH_BASE_URL="${AUTH_BASE_URL:-http://six-feat-auth:8083}"

# ── PostgreSQL ────────────────────────────────────────────────────────────────
# host/port — дефолты из docker-compose; db/user/password обязательны.
DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
# Опционально — оставить пустым для одного инстанса (дефолт compose).
# Задать реальный хост реплики для kMaster/kSlave (см. DEVELOPMENT.md,
# «Postgres cluster topology»). НЕ указывать тот же хост, что и DB_HOST —
# otherwise оба ответят "not in recovery" и Slave-пула не будет.
DB_REPLICA_HOST="${DB_REPLICA_HOST:-}"
DB_REPLICA_PORT="${DB_REPLICA_PORT:-5432}"
: "${DB_NAME:?DB_NAME env var is required — Postgres database name}"
: "${DB_USER:?DB_USER env var is required — Postgres user}"
: "${DB_PASSWORD:?DB_PASSWORD env var is required — Postgres password, keep it secret}"

# DSN собирается только в памяти (config_vars.yaml ниже) — на диск не пишется.
# Multi-host только если задана реплика, single-host иначе (дефолт dev).
if [[ -n "$DB_REPLICA_HOST" ]]; then
  DB_CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT},${DB_REPLICA_HOST}:${DB_REPLICA_PORT}/${DB_NAME}"
else
  DB_CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

GENIUS_REDIRECT_URI="${GENIUS_REDIRECT_URI:-http://localhost:8080/auth/callback}"
# Secure по умолчанию:除非 явно отключить, cookie получает Secure-флаг.
# COOKIE_SECURE=false — только для локальной разработки по HTTP.
COOKIE_SECURE="${COOKIE_SECURE:-true}"

# Тихий по умолчанию: debug demasiрует токены/URL с токенами в stderr.
# LOGGING_LEVEL=debug — только для локального троблшутинга.
LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

# ── Кэширование фронтенд-бандлов ─────────────────────────────────────────────
# Dockerfile записывает хешированное имя JS-бандла (script.a1b2c3d4.js) в
# /usr/share/six_feat/.script-filename на этапе сборки образа.
# handler-script и handler-index используют это имя для маршрутов и
#.cache-busting: новый бандл → новое имя → браузер подхватит при обычном
# обновлении (index.html — no-cache, хешированный скрипт — cache-forever).
SCRIPT_FILENAME_FILE=/usr/share/six_feat/.script-filename
if [[ ! -f "$SCRIPT_FILENAME_FILE" ]]; then
  echo "[entrypoint] ERROR: $SCRIPT_FILENAME_FILE missing — JS bundle was not baked into the image correctly" >&2
  exit 1
fi
SCRIPT_FILENAME="$(cat "$SCRIPT_FILENAME_FILE")"
SCRIPT_PATH="/${SCRIPT_FILENAME}"
SCRIPT_FILE_PATH="/usr/share/six_feat/${SCRIPT_FILENAME}"

# То же для CSS-бандла (.style-filename из manifest.json).
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
if [[ -n "$DB_REPLICA_HOST" ]]; then
  echo "[entrypoint] Postgres target: ${DB_HOST}:${DB_PORT} (master), ${DB_REPLICA_HOST}:${DB_REPLICA_PORT} (replica), db=${DB_NAME}"
else
  echo "[entrypoint] Postgres target: ${DB_HOST}:${DB_PORT} (single instance, no replica), db=${DB_NAME}"
fi

# ── Ожидание готовности Postgres ─────────────────────────────────────────────
# depends_on/healthcheck блокируют только ПЕРВЫЙ старт. При рестарте
# (restart: unless-stopped) проверки нет — если Postgres ещё не готов,
# persistent-store падает с unhandled exception. pg_isready проверяет
# протокольную готовность (а не просто TCP-порт).
# Задержка намеренно меньше HEALTHCHECK-бюджета, чтобы медленный Postgres
# падал по healthcheck, а не вешал entrypoint. Реплика — мягкая зависимость,
# ждёт лишь короткое время.
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