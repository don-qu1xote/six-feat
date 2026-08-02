#!/usr/bin/env bash
# detect-changes.sh — определяет, какие сервисы/тесты затронуты изменениями.
#
# Использование: локально — source этого файла, затем проверка переменных:
#   source scripts/detect-changes.sh
#   echo "$SERVICES"      # список через пробел
#   echo "$TESTS"         # список через пробел
#   echo "$LINT"          # список через пробел: clang-tidy eslint format yaml promtool
#   echo "$FRONTEND"      # "true" или "false"
#   echo "$DOCKER"        # "true" или "false"
#
# CI вызывает файл иначе — `bash scripts/detect-changes.sh HEAD~1` (exec, не
# source) — и читает те же значения через $GITHUB_OUTPUT. Скрипт ни разу не
# использует return/exit для досрочного выхода (см. workflow_dispatch ниже —
# это if/else, а не ранний return), поэтому одинаково работает что
# исполненным, что source'нутым.
#
# [SF-CI-08] workflow_dispatch (кнопка "Run workflow" в интерфейсе Actions)
# не даёт осмысленного HEAD~1 для diff'а — в этом случае считается
# затронутым абсолютно всё, без обращения к git diff.

set -euo pipefail

BASE_REF="${1:-HEAD~1}"

# --- Инициализация выходных переменных ---
SERVICES=""
TESTS=""
LINT=""
FRONTEND="false"
DOCKER="false"

# При workflow_dispatch нет осмысленного HEAD~1 — считаем затронутым всё и
# пропускаем детект по diff'у целиком (ветки ниже трогают перечисленные
# переменные, не переопределяют их с нуля).
if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
  echo "=== workflow_dispatch: treating everything as affected ==="
  SERVICES="six-feat enrichment auth game genius-gateway yandex-gateway"
  TESTS="unit integration six-feat auth genius-gateway yandex-gateway enrichment bg-resilience health"
  LINT="clang-tidy eslint format yaml promtool"
  FRONTEND="true"
  DOCKER="true"
else

# Список изменённых файлов (пустой на первом коммите)
CHANGED_FILES=$(git diff --name-only "$BASE_REF" 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || echo "")

# --- Определение затронутых сервисов ---
if echo "$CHANGED_FILES" | grep -q "^libs/"; then
  SERVICES="six-feat enrichment auth game genius-gateway yandex-gateway"
fi

if echo "$CHANGED_FILES" | grep -qE "^services/six-feat/(src|tests/unit)/"; then
  SERVICES="$SERVICES six-feat yandex-gateway"
fi

if echo "$CHANGED_FILES" | grep -q "^services/six-feat-enrichment/"; then
  SERVICES="$SERVICES enrichment"
fi

if echo "$CHANGED_FILES" | grep -q "^services/auth/"; then
  SERVICES="$SERVICES auth"
fi

if echo "$CHANGED_FILES" | grep -q "^services/game/"; then
  SERVICES="$SERVICES game"
fi

if echo "$CHANGED_FILES" | grep -q "^services/genius-gateway/"; then
  SERVICES="$SERVICES genius-gateway"
fi

if echo "$CHANGED_FILES" | grep -q "^services/yandex-gateway/"; then
  SERVICES="$SERVICES yandex-gateway"
fi

# Дедупликация
SERVICES=$(echo "$SERVICES" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

# --- Определение затронутых тестов ---
# tests/ — общий каталог: один pytest-файл там может относиться к любой из
# job'ов test-six-feat/test-auth/test-genius-gateway/test-yandex-gateway/
# test-health/test-bg-resilience (см. их собственные списки файлов в
# ci.yml), а detect-changes не сопоставляет файл с конкретной job. Раньше
# при изменении ТОЛЬКО tests/ выставлялись только служебные метки "unit
# integration", которые ни одна job не проверяет в своём if: — сами
# интеграционные job'ы гейтятся исключительно по именам сервисов (в SERVICES
# выше), так что правки только в tests/ ни разу не запускали ни одну из них.
# Как и в блоке "если изменились libs — затронуто всё" ниже, при изменении
# tests/ безопаснее считать затронутыми ВСЕ интеграционные наборы, чем
# пытаться сопоставлять файлы поштучно и рисковать пропустить прогон.
if echo "$CHANGED_FILES" | grep -q "^tests/"; then
  TESTS="unit integration six-feat auth genius-gateway yandex-gateway enrichment bg-resilience health"
fi

if echo "$CHANGED_FILES" | grep -q "^services/six-feat/tests/unit/"; then
  TESTS="$TESTS six-feat"
fi

# Сопоставление сервисов с их тестами
if echo "$SERVICES" | grep -q "six-feat"; then
  TESTS="$TESTS six-feat"
fi

if echo "$SERVICES" | grep -q "auth"; then
  TESTS="$TESTS auth"
fi

if echo "$SERVICES" | grep -q "genius-gateway"; then
  TESTS="$TESTS genius-gateway"
fi

if echo "$SERVICES" | grep -q "yandex-gateway"; then
  TESTS="$TESTS yandex-gateway"
fi

if echo "$SERVICES" | grep -q "enrichment"; then
  TESTS="$TESTS enrichment bg-resilience"
fi

if echo "$SERVICES" | grep -q "six-feat\|auth\|enrichment\|genius-gateway"; then
  TESTS="$TESTS health"
fi

TESTS=$(echo "$TESTS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

# --- Определение затронутых линтеров ---
if echo "$CHANGED_FILES" | grep -qE '\.(cpp|hpp)$'; then
  LINT="$LINT clang-tidy format"
fi

if echo "$CHANGED_FILES" | grep -qE '\.(js|mjs)$'; then
  LINT="$LINT eslint format"
fi

if echo "$CHANGED_FILES" | grep -qE '\.(py)$'; then
  LINT="$LINT format"
fi

if echo "$CHANGED_FILES" | grep -qE '(^\.clang-format$|^\.clang-tidy$|^pyproject\.toml$|^front/\.prettierrc$|^front/\.prettierignore$|^front/package\.json$|^Makefile$|^scripts/check_comments\.py$)'; then
  LINT="$LINT format"
fi

if echo "$CHANGED_FILES" | grep -qE '\.(yml|yaml)$'; then
  LINT="$LINT yaml"
fi

if echo "$CHANGED_FILES" | grep -q "observability/"; then
  LINT="$LINT promtool"
fi

LINT=$(echo "$LINT" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

# --- Определение изменений фронтенда ---
if echo "$CHANGED_FILES" | grep -q "^front/"; then
  FRONTEND="true"
fi

# --- Определение изменений Docker ---
if echo "$CHANGED_FILES" | grep -qE '(Dockerfile|docker-compose)'; then
  DOCKER="true"
fi

# Если изменились libs — затронуто всё
if echo "$CHANGED_FILES" | grep -q "^libs/"; then
  TESTS="unit integration six-feat auth genius-gateway yandex-gateway enrichment bg-resilience health"
  LINT="clang-tidy eslint format yaml promtool"
  FRONTEND="true"
fi

fi  # ${GITHUB_EVENT_NAME:-} = workflow_dispatch

# --- Экспорт в GitHub Actions outputs ---
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "services=$SERVICES" >> "$GITHUB_OUTPUT"
  echo "tests=$TESTS" >> "$GITHUB_OUTPUT"
  echo "lint=$LINT" >> "$GITHUB_OUTPUT"
  echo "frontend=$FRONTEND" >> "$GITHUB_OUTPUT"
  echo "docker=$DOCKER" >> "$GITHUB_OUTPUT"
fi

# --- Вывод для локального использования ---
echo "=== Changed Services ==="
echo "SERVICES: $SERVICES"
echo "TESTS: $TESTS"
echo "LINT: $LINT"
echo "FRONTEND: $FRONTEND"
echo "DOCKER: $DOCKER"
