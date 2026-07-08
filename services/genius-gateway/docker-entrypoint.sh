#!/usr/bin/env bash

set -euo pipefail

# six-feat-genius-gateway has no OAuth/session concerns of its own and no
# database — it borrows the user_token forwarded by its callers (six_feat,
# six-feat-enrichment) on every /internal/genius/* call. The only credential
# this service needs at boot is the inter-service shared secret.
: "${ENRICHMENT_INTERNAL_SECRET:?ENRICHMENT_INTERNAL_SECRET env var is required — shared secret with six_feat / six-feat-enrichment, generate with: openssl rand -hex 32}"

LOGGING_LEVEL="${LOGGING_LEVEL:-info}"

cat > /app/config_vars.yaml <<EOF
logging_level: ${LOGGING_LEVEL}
EOF

exec /app/six_feat_genius_gateway \
  --config /app/static_config.yaml \
  --config_vars /app/config_vars.yaml
