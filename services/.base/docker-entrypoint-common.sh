#!/usr/bin/env bash
# shellcheck disable=SC2034
#
# Общие функции для docker-entrypoint.sh всех сервисов.
# source-ится в каждом services/<name>/docker-entrypoint.sh перед его
# собственной логикой. Предоставляет:
#   load_env_profile     — загрузка ENV_PROFILE (fail-fast)
#   wait_for_postgres    — ожидание готовности Postgres (pg_isready)
#   build_db_connection_string — сборка multi-host DSN
#   log_db_target        — единообразное логирование цели Postgres
#
# Переменные, которые ДОЛЖНЫ быть установлены до вызова:
#   DB_USER, DB_PASSWORD, DB_NAME — обязательные
# Переменные с дефолтами:
#   DB_HOST, DB_PORT, DB_REPLICA_HOST, DB_REPLICA_PORT — опциональные

load_env_profile() {
  ENV_PROFILE="${ENV_PROFILE:-dev}"
  local profile_file
  profile_file="${PROFILE_DIR:-/app/config/profiles}/${ENV_PROFILE}.env"
  if [[ ! -f "$profile_file" ]]; then
    echo "[entrypoint] ERROR: ENV_PROFILE=${ENV_PROFILE} but ${profile_file} not found (expected dev, staging, or prod — see config/profiles/)" >&2
    exit 1
  fi
  echo "[entrypoint] ENV_PROFILE=${ENV_PROFILE} (${profile_file})"
  set -a
  # shellcheck disable=SC1090
  source "$profile_file"
  set +a
}

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

# Полная документация — в DEVELOPMENT.md «Postgres cluster topology».
# Собирает multi-host DSN только когда задана реплика, single-host иначе.
build_db_connection_string() {
  DB_HOST="${DB_HOST:-postgres}"
  DB_PORT="${DB_PORT:-5432}"
  DB_REPLICA_HOST="${DB_REPLICA_HOST:-}"
  DB_REPLICA_PORT="${DB_REPLICA_PORT:-5432}"

  if [[ -n "$DB_REPLICA_HOST" ]]; then
    DB_CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT},${DB_REPLICA_HOST}:${DB_REPLICA_PORT}/${DB_NAME}"
  else
    DB_CONNECTION_STRING="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  fi
}

log_db_target() {
  local prefix="${1:-Postgres}"
  if [[ -n "$DB_REPLICA_HOST" ]]; then
    echo "[entrypoint] ${prefix} target: ${DB_HOST}:${DB_PORT} (master), ${DB_REPLICA_HOST}:${DB_REPLICA_PORT} (replica), db=${DB_NAME}"
  else
    echo "[entrypoint] ${prefix} target: ${DB_HOST}:${DB_PORT} (single instance, no replica), db=${DB_NAME}"
  fi
}
