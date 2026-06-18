#!/usr/bin/env bash
#
# Container entrypoint for six-feat.
#
# The Genius token is provided as an environment variable (GENIUS_TOKEN) so it
# never has to live inside the image. We write it into config_vars.yaml at
# start-up, then hand control to the server. `exec` replaces this shell with the
# server process so it becomes PID 1 and receives signals (graceful shutdown).

set -euo pipefail

# Fail fast with a clear message if the token wasn't passed in.
: "${GENIUS_TOKEN:?GENIUS_TOKEN env var is required — your Genius Client Access Token from https://genius.com/api-clients}"

cat > /app/config_vars.yaml <<EOF
genius_token: ${GENIUS_TOKEN}
EOF

exec /app/six-feat \
  --config /app/static_config.yaml \
  --config_vars /app/config_vars.yaml
