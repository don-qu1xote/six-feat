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

# six-feat-auth владеет всем OAuth 2.0 флоу (IDEA-53). Нужны: OAuth
# client_id/client_secret (https://genius.com/api-clients) и APP_SECRET —
# тот же ключ шифрования сессий, что и у основного six_feat (он расшифровывает
# cookie, которую этот сервис выставляет — локально, без HTTP-вызова обратно,
# см. src/auth/token_router.hpp).
: "${GENIUS_CLIENT_ID:?GENIUS_CLIENT_ID env var is required for OAuth — from https://genius.com/api-clients}"
: "${GENIUS_CLIENT_SECRET:?GENIUS_CLIENT_SECRET env var is required for OAuth — keep it secret}"
: "${APP_SECRET:?APP_SECRET env var is required for session encryption — generate with: openssl rand -hex 32, and MUST match the main six_feat services APP_SECRET}"

# [SF-SEC-01] Gates GET /internal/key-fingerprint — тот же общий секрет
# что и у остального internal-mesh (six-feat's EnrichmentClient/GeniusGatewayClient).
# Читается из env через internal_api::SharedSecretFromEnv(), в config_vars.yaml не пишется.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six-feat/six-feat-enrichment, generate with: openssl rand -hex 32}"

# Должен точно совпадать с Redirect URI, зарегистрированным для
# GENIUS_CLIENT_ID на https://genius.com/api-clients (схема, хост, порт, /).
# В данном docker-compose.yml нет прокси перед six-feat-auth — по умолчанию
# указывает на собственный порт six-feat-auth (8083), а не six-feat (8080).
# См. комментарий к сервису six-feat-auth в docker-compose.yml.
GENIUS_REDIRECT_URI="${GENIUS_REDIRECT_URI:-http://localhost:8083/auth/callback}"

# Secure по умолчанию — cookie получает Secure-флаг, если не отключить явно.
# COOKIE_SECURE=false только для локальной HTTP-разработки. Должно совпадать
# со значением основного six_feat — атрибуты cookie ставятся здесь, но
# основной six_feat эту же cookie читает.
COOKIE_SECURE="${COOKIE_SECURE:-true}"

# Тихий по умолчанию: debug demasiрует токены/URL с токенами в stderr.
# LOGGING_LEVEL=debug — только для локального троблшутинга.
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
