#!/usr/bin/env bash
# detect-changes.sh — определяет, какие сервисы/тесты затронуты изменениями.
#
# Использование: source этого файла, затем проверка переменных:
#   source scripts/detect-changes.sh
#   echo "$SERVICES"      # список через пробел
#   echo "$TESTS"         # список через пробел
#   echo "$LINT"          # список через пробел: clang-tidy eslint format yaml promtool
#   echo "$FRONTEND"      # "true" или "false"
#   echo "$DOCKER"        # "true" или "false"
#
# Коды возврата не используются — предназначен для source, не для exec.

set -euo pipefail

BASE_REF="${1:-HEAD~1}"

# Список изменённых файлов (пустой на первом коммите)
CHANGED_FILES=$(git diff --name-only "$BASE_REF" 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || echo "")

# --- Инициализация выходных переменных ---
SERVICES=""
TESTS=""
LINT=""
FRONTEND="false"
DOCKER="false"

# --- Определение затронутых сервисов ---
if echo "$CHANGED_FILES" | grep -q "^libs/"; then
  SERVICES="six-feat enrichment auth game genius-gateway yandex-gateway"
elif echo "$CHANGED_FILES" | grep -q "^services/six-feat/"; then
  SERVICES="$SERVICES six-feat"
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
if echo "$CHANGED_FILES" | grep -q "^tests/"; then
  TESTS="unit integration"
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
