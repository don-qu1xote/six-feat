#!/usr/bin/env bash
# docker-entrypoint.sh
set -euo pipefail

: "${GENIUS_TOKEN:?GENIUS_TOKEN is required — get your Client Access Token at https://genius.com/api-clients}"

# Write config_vars at runtime so the token never ends up baked into an image layer.
# /app is owned by root; the file is overwritten on every container start.
cat > /app/config_vars.yaml <<EOF
genius_token: ${GENIUS_TOKEN}
EOF
chmod 600 /app/config_vars.yaml

exec /app/six_feat \
  --config     /app/static_config.yaml \
  --config_vars /app/config_vars.yaml
  