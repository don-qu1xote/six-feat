#!/usr/bin/env bash
# Удаляет .env и .env.example из каждого коммита истории.
# Требует git-filter-repo (pip install git-filter-repo); без него — BFG Repo-Cleaner.
# ОПАСНО: переписывает историю — после запуска force-push всех веток и тегов,
# переклонирование у разработчиков и ротация учётных данных.
set -euo pipefail

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "error: git-filter-repo not found. Install it with 'pip install git-filter-repo'," >&2
  echo "       or use the BFG fallback described in this script's header." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Идемпотентно: no-op для путей, которых больше нет в истории
git filter-repo --force --invert-paths --path .env --path .env.example

echo "History rewritten. Remember to force-push and ask collaborators to re-clone."