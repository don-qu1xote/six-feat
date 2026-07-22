#!/usr/bin/env bash
# loadtest/run-all.sh — SF-INF-05
#
# Runs all three k6 scenarios (graph_warm, path_cold, search) back to back
# against a single running six-feat stack, writing JSON+text summaries to
# loadtest/.output/. Used both for local dev (see README.md) and the
# k6-smoke-load CI workflow (.github/workflows/loadtest.yml).
#
# Connection info comes from the environment (BASE_URL, SESSION_COOKIE,
# ...) — or, if E2E_ENV_FILE points at a JSON file written by
# `scripts/e2e_env.py up` (base_url/session_cookie/seed_artist/
# target_artist), those fill in whichever of BASE_URL/SESSION_COOKIE/
# SEED_ARTIST/FROM_ARTIST/TO_ARTIST aren't already set — explicit env vars
# always win.
#
# Exits non-zero if any scenario's thresholds were breached or the run
# itself failed — informational for a human running this locally; the
# k6-smoke-load CI job wraps the whole job in continue-on-error so this
# never blocks anything (SF-INF-05: "пороги — предупреждающие, не
# блокирующие").
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/loadtest/.output"
mkdir -p "$OUT_DIR"

if [ -n "${E2E_ENV_FILE:-}" ] && [ -f "${E2E_ENV_FILE}" ]; then
  json_field() {
    python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ''))" \
      "$E2E_ENV_FILE" "$1"
  }
  : "${BASE_URL:=$(json_field base_url)}"
  : "${SESSION_COOKIE:=$(json_field session_cookie)}"
  : "${SEED_ARTIST:=$(json_field seed_artist)}"
  : "${FROM_ARTIST:=${SEED_ARTIST:-}}"
  : "${TO_ARTIST:=$(json_field target_artist)}"
fi

: "${BASE_URL:?Set BASE_URL, or E2E_ENV_FILE pointing at a JSON file written by scripts/e2e_env.py}"
: "${SESSION_COOKIE:?Set SESSION_COOKIE (a valid six_feat_session cookie value) — see loadtest/README.md}"

export BASE_URL SESSION_COOKIE
export SEED_ARTIST="${SEED_ARTIST:-Aurora Vale}"
export FROM_ARTIST="${FROM_ARTIST:-Aurora Vale}"
export TO_ARTIST="${TO_ARTIST:-Kessler Vane}"
# [fix] Deliberately NOT set here (was "${SEARCH_QUERY:-Aurora}" — a
# substring of the seeded artist name, not the name itself, which 404'd
# against scripts/e2e_env.py's mock Genius on every single search
# request). Left unset so lib/config.js's own default (both exact seeded
# names, "Aurora Vale"/"Kessler Vane") applies unless the caller sets
# SEARCH_QUERY/SEARCH_QUERIES explicitly.
export PROFILE="${PROFILE:-full}"

SCENARIOS=(graph_warm path_cold search)
# [SF-GAME-20] Opt-in — see README.md's scoping note: scripts/e2e_env.py
# doesn't boot six-feat-game yet, so the k6-smoke-load CI job (which never
# sets this) keeps running exactly the three scenarios it always has.
if [ "${GAME_SCENARIO:-0}" = "1" ]; then
  SCENARIOS+=(game)
fi

status=0
for scenario in "${SCENARIOS[@]}"; do
  echo "── k6 run loadtest/scenarios/${scenario}.js (PROFILE=${PROFILE}) ──"
  if ! k6 run "${REPO_ROOT}/loadtest/scenarios/${scenario}.js"; then
    echo "── ${scenario}: thresholds breached or run failed (advisory — see loadtest/.output/) ──"
    status=1
  fi
done

exit "$status"
