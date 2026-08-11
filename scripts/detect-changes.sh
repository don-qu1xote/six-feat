#!/usr/bin/env bash
# Работает и как source (локально), и как exec (CI: `bash scripts/detect-changes.sh HEAD~1`),
# значения читаются из $SERVICES/$TESTS/$LINT/$FRONTEND/$DOCKER или $GITHUB_OUTPUT.
# workflow_dispatch не даёт осмысленного HEAD~1 — тогда затронуто всё, без git diff.
# [SF-CI-11] FORCE_ALL=true даёт то же самое из ЛЮБОГО события (галочка force_all
# в ci.yml). Ровно одна точка форсирования — на выходе этого скрипта, а не
# `|| force_all` по условиям джоб: иначе следующая новая джоба про флаг забудет.

set -euo pipefail

BASE_REF="${1:-HEAD~1}"

SERVICES=""
TESTS=""
LINT=""
FRONTEND="false"
DOCKER="false"

FORCE_ALL="${FORCE_ALL:-false}"

if [ "$FORCE_ALL" = "true" ] || [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
  echo "=== treating everything as affected (force_all=$FORCE_ALL, event=${GITHUB_EVENT_NAME:-none}) ==="
  SERVICES="six-feat enrichment auth game genius-gateway"
  TESTS="unit integration six-feat auth genius-gateway enrichment bg-resilience health"
  LINT="clang-tidy eslint format yaml promtool"
  FRONTEND="true"
  DOCKER="true"
else

# Список изменённых файлов (пустой на первом коммите)
CHANGED_FILES=$(git diff --name-only "$BASE_REF" 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || echo "")

if echo "$CHANGED_FILES" | grep -q "^libs/"; then
  SERVICES="six-feat enrichment auth game genius-gateway"
fi

if echo "$CHANGED_FILES" | grep -qE "^services/six-feat/src/"; then
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

# Дедупликация
SERVICES=$(echo "$SERVICES" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

# tests/ — общий каталог: файл может относиться к любой из интеграционных job,
# поштучно не сопоставляем — безопаснее прогнать все наборы
if echo "$CHANGED_FILES" | grep -q "^tests/"; then
  TESTS="unit integration six-feat auth genius-gateway enrichment bg-resilience health"
fi

# Сопоставление затронутых сервисов с их тестами
if echo "$SERVICES" | grep -q "six-feat"; then
  TESTS="$TESTS six-feat"
fi

if echo "$SERVICES" | grep -q "auth"; then
  TESTS="$TESTS auth"
fi

if echo "$SERVICES" | grep -q "genius-gateway"; then
  TESTS="$TESTS genius-gateway"
fi

if echo "$SERVICES" | grep -q "enrichment"; then
  TESTS="$TESTS enrichment bg-resilience"
fi

if echo "$SERVICES" | grep -q "six-feat\|auth\|enrichment\|genius-gateway"; then
  TESTS="$TESTS health"
fi

TESTS=$(echo "$TESTS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

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

if echo "$CHANGED_FILES" | grep -q "^front/"; then
  FRONTEND="true"
fi

if echo "$CHANGED_FILES" | grep -qE '(Dockerfile|docker-compose)'; then
  DOCKER="true"
fi

# libs — общий код: затронуто всё
if echo "$CHANGED_FILES" | grep -q "^libs/"; then
  TESTS="unit integration six-feat auth genius-gateway enrichment bg-resilience health"
  LINT="clang-tidy eslint format yaml promtool"
  FRONTEND="true"
fi

if echo "$TESTS" | grep -qE "six-feat|health|bg-resilience"; then
  SERVICES="$SERVICES six-feat enrichment genius-gateway auth"
fi
if echo "$TESTS" | grep -q "auth"; then
  SERVICES="$SERVICES six-feat auth genius-gateway"
fi
if echo "$TESTS" | grep -q "genius-gateway"; then
  SERVICES="$SERVICES genius-gateway six-feat auth"
fi
SERVICES=$(echo "$SERVICES" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "services=$SERVICES" >> "$GITHUB_OUTPUT"
  echo "tests=$TESTS" >> "$GITHUB_OUTPUT"
  echo "lint=$LINT" >> "$GITHUB_OUTPUT"
  echo "frontend=$FRONTEND" >> "$GITHUB_OUTPUT"
  echo "docker=$DOCKER" >> "$GITHUB_OUTPUT"
fi

# Вывод для локального использования
echo "=== Changed Services ==="
echo "SERVICES: $SERVICES"
echo "TESTS: $TESTS"
echo "LINT: $LINT"
echo "FRONTEND: $FRONTEND"
echo "DOCKER: $DOCKER"
