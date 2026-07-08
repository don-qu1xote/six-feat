#!/usr/bin/env bash

set -euo pipefail

# six-feat-auth owns the whole Genius OAuth 2.0 flow (IDEA-53). It needs the
# OAuth app's own client_id/client_secret (registered once at
# https://genius.com/api-clients) plus APP_SECRET — the SAME session-
# encryption secret main six_feat is started with, since main decrypts the
# six_feat_session cookie this service mints, locally, with no HTTP call
# back here (see src/auth/token_router.hpp).
: "${GENIUS_CLIENT_ID:?GENIUS_CLIENT_ID env var is required for OAuth — from https://genius.com/api-clients}"
: "${GENIUS_CLIENT_SECRET:?GENIUS_CLIENT_SECRET env var is required for OAuth — keep it secret}"
: "${APP_SECRET:?APP_SECRET env var is required for session encryption — generate with: openssl rand -hex 32, and MUST match the main six_feat services APP_SECRET}"

# Must exactly match the Redirect URI registered for GENIUS_CLIENT_ID on
# https://genius.com/api-clients (scheme, host, port, trailing slash).
# There is no reverse proxy in front of six-feat/six-feat-auth in this
# repo's docker-compose.yml, so by default this points at six-feat-auth's
# own host port, not six-feat's — see docker-compose.yml's six-feat-auth
# service comment.
GENIUS_REDIRECT_URI="${GENIUS_REDIRECT_URI:-http://localhost:8083/auth/callback}"

# Secure-by-default: cookies get the Secure flag unless explicitly disabled.
# Only set COOKIE_SECURE=false for local HTTP development. Must match the
# value main six_feat is started with — cookie attributes are set here, but
# main reads the same cookie.
COOKIE_SECURE="${COOKIE_SECURE:-true}"

# Quiet-by-default: debug is verbose enough to leak tokens/URLs-with-tokens
# into stderr. Only set LOGGING_LEVEL=debug for local troubleshooting.
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
