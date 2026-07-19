#!/usr/bin/env bash

set -euo pipefail

# six-feat-game — competitive game service (SF-GAME-10 skeleton). It shares the
# same Postgres cluster as the rest of the mesh (its game_* tables land in
# SF-GAME-11). This entrypoint assembles the DSN and waits for Postgres to be
# ready exactly like services/enrichment/docker-entrypoint.sh, so SF-GAME-11's
# store component only has to read the already-plumbed db_connection_string.
#
# [SF-GAME-12] APP_SECRET is read directly from the environment by
# session_crypto::KeyFromEnv() to decrypt the six_feat_session cookie locally
# (no HTTP to six-feat-auth) — it MUST be the exact same value the rest of the
# mesh uses, or the game service can't read sessions the other services minted.
# Fail fast here instead of throwing deep in ProfileHandler's constructor.
: "${APP_SECRET:?APP_SECRET env var is required for session decryption — MUST match the rest of the mesh, generate with: openssl rand -hex 32}"

# ENRICHMENT_INTERNAL_SECRET (internal-mesh calls, SF-GAME-13) is passed in by
# docker-compose.yml but not consumed yet — its guard gets added by SF-GAME-13.

DB_HOST="${DB_HOST:-postgres}"
DB_PORT="${DB_PORT:-5432}"
# Optional — see the matching comment in enrichment's entrypoint: leave unset
# for a single Postgres instance, or point at a real streaming replica for
# genuine kMaster/kSlave read isolation. Never point this at the same host as
# DB_HOST — see DEVELOPMENT.md, "Postgres cluster topology".
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
  echo "[entrypoint] six-feat-game Postgres target: ${DB_HOST}:${DB_PORT} (master), ${DB_REPLICA_HOST}:${DB_REPLICA_PORT} (replica), db=${DB_NAME}"
else
  echo "[entrypoint] six-feat-game Postgres target: ${DB_HOST}:${DB_PORT} (single instance, no replica), db=${DB_NAME}"
fi

# ── Wait for Postgres to actually be ready ─────────────────────────────────
# Same rationale as enrichment's entrypoint: depends_on/healthcheck only gate
# this container's first start, not its "restart: unless-stopped" restarts, so
# wait here too. A raw TCP check isn't sufficient (Postgres opens its listener
# before it can serve sessions) — pg_isready checks protocol-level readiness.
# Capped under the HEALTHCHECK budget so a slow/absent Postgres fails the
# healthcheck instead of hanging the entrypoint. The replica is a soft
# dependency, so it gets only a brief best-effort wait.
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
EOF

exec /app/six_feat_game \
  --config /app/static_config.yaml \
  --config_vars /tmp/config_vars.yaml
