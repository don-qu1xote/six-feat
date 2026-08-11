#!/usr/bin/env bash
# Прогоняет все k6-сценарии подряд на одном поднятом стеке, результаты — в loadtest/output/.
# Каталог намеренно НЕ скрытый: actions/upload-artifact пропускает файлы,
# начинающиеся с точки, и раньше эта джоба каждый раз заканчивалась ошибкой
# upload-artifact «No files were found with the provided path: loadtest/.output/»
# BASE_URL/SESSION_COOKIE берутся из окружения, либо из JSON-файла scripts/e2e_env.py up.
# Ненулевой код выхода — пороги нарушены; CI-джоба оборачивается в continue-on-error.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${REPO_ROOT}/loadtest/output"
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
# НЕ задаём SEARCH_QUERY: умолчание в lib/config.js (точные имена сидов) бьётся
# о mock-Genius, а подстрока имени давала 404
export PROFILE="${PROFILE:-full}"

SCENARIOS=(graph_warm path_cold search)
# Опционально: scripts/e2e_env.py не поднимает six-feat-game, поэтому CI сценарий game не запускает
if [ "${GAME_SCENARIO:-0}" = "1" ]; then
  SCENARIOS+=(game)
fi

status=0
for scenario in "${SCENARIOS[@]}"; do
  echo "── k6 run loadtest/scenarios/${scenario}.js (PROFILE=${PROFILE}) ──"
  if ! k6 run "${REPO_ROOT}/loadtest/scenarios/${scenario}.js"; then
    echo "── ${scenario}: thresholds breached or run failed (advisory — see loadtest/output/) ──"
    status=1
  fi
done

# Сводки — единственное, что джоба выкладывает артефактом. Если их вдруг нет,
# пусть это будет видно здесь и сразу, а не превратится в невнятное «No files
# were found» на шаге выгрузки через полминуты.
summaries=("$OUT_DIR"/*-summary.txt)
if [ -e "${summaries[0]}" ]; then
  echo "── сводок в ${OUT_DIR}: ${#summaries[@]} ──"
else
  echo "── ВНИМАНИЕ: в ${OUT_DIR} нет ни одной сводки, артефакт будет пустым ──" >&2
fi

exit "$status"
