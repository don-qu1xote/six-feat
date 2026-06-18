#!/usr/bin/env bash

set -euo pipefail

: "${GENIUS_TOKEN:?GENIUS_TOKEN env var is required — your Genius Client Access Token from https://genius.com/api-clients}"

cat > /app/config_vars.yaml <<EOF
genius_token: ${GENIUS_TOKEN}
EOF

exec /app/six-feat \
  --config /app/static_config.yaml \
  --config_vars /app/config_vars.yaml
