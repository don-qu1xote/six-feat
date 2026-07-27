#!/usr/bin/env bash
# detect-changes.sh — Determine which services/tests are affected by changes.
#
# Usage: source this file, then check the outputs:
#   source scripts/detect-changes.sh
#   echo "$SERVICES"      # space-separated list: six-feat enrichment auth game genius-gateway libs
#   echo "$TESTS"         # space-separated list: unit integration six-feat auth genius-gateway enrichment bg-resilience health
#   echo "$LINT"          # space-separated list: clang-tidy eslint format yaml promtool
#   echo "$FRONTEND"      # "true" or "false"
#   echo "$DOCKER"        # "true" or "false"
#
# Exit codes are not used — this is meant to be sourced, not executed.

set -euo pipefail

BASE_REF="${1:-HEAD~1}"

# Get changed files (fall back to empty list on first commit)
CHANGED_FILES=$(git diff --name-only "$BASE_REF" 2>/dev/null || git diff --name-only HEAD~1 2>/dev/null || echo "")

# --- Initialize outputs ---
SERVICES=""
TESTS=""
LINT=""
FRONTEND="false"
DOCKER="false"

# --- Detect services ---
if echo "$CHANGED_FILES" | grep -q "^libs/"; then
  SERVICES="six-feat enrichment auth game genius-gateway"
elif echo "$CHANGED_FILES" | grep -q "^services/six-feat/"; then
  SERVICES="$SERVICES six-feat"
fi

if echo "$CHANGED_FILES" | grep -q "^services/enrichment/"; then
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

# Deduplicate
SERVICES=$(echo "$SERVICES" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

# --- Detect tests ---
if echo "$CHANGED_FILES" | grep -q "^tests/"; then
  TESTS="unit integration"
fi

# Map services to their tests
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

# --- Detect lint ---
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

# --- Detect frontend ---
if echo "$CHANGED_FILES" | grep -q "^front/"; then
  FRONTEND="true"
fi

# --- Detect docker ---
if echo "$CHANGED_FILES" | grep -qE '(Dockerfile|docker-compose)'; then
  DOCKER="true"
fi

# If libs changed, everything is affected
if echo "$CHANGED_FILES" | grep -q "^libs/"; then
  TESTS="unit integration six-feat auth genius-gateway enrichment bg-resilience health"
  LINT="clang-tidy eslint format yaml promtool"
  FRONTEND="true"
fi

# --- Export as GitHub Actions outputs ---
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "services=$SERVICES" >> "$GITHUB_OUTPUT"
  echo "tests=$TESTS" >> "$GITHUB_OUTPUT"
  echo "lint=$LINT" >> "$GITHUB_OUTPUT"
  echo "frontend=$FRONTEND" >> "$GITHUB_OUTPUT"
  echo "docker=$DOCKER" >> "$GITHUB_OUTPUT"
fi

# --- Print for local use ---
echo "=== Changed Services ==="
echo "SERVICES: $SERVICES"
echo "TESTS: $TESTS"
echo "LINT: $LINT"
echo "FRONTEND: $FRONTEND"
echo "DOCKER: $DOCKER"
