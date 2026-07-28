#!/usr/bin/env bash
# Удаляет .env и .env.example из каждого коммита в истории репозитория.
#
# Требует: git-filter-repo (https://github.com/newren/git-filter-repo)
#   pip install git-filter-repo
#
# Запасной вариант (если git-filter-repo недоступен): BFG Repo-Cleaner:
#   java -jar bfg.jar --delete-files .env --delete-files .env.example <repo>.git
#   cd <repo>.git && git reflog expire --expire=now --all && git gc --prune=now --aggressive
#
# Идемпотентно: безопасно перезапускать; filter-repo — no-op для путей,
# которые больше не появляются в истории.
#
# ОПАСНО: переписывает историю. После запуска этого скрипта:
#   1. Force-push каждой затронутой ветки:
#        git push --force --all
#        git push --force --tags
#   2. Каждый разработчик ДОЛЖЕН переклонировать репозиторий (или hard-reset
#      свои локальные копии на новую историю) — старые клоны несовместимы
#      и не должны пушиться/мержиться обратно.
#   3. Ротировать любые учётные данные, которые когда-либо были в удалённых файлах.
set -euo pipefail

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "error: git-filter-repo not found. Install it with 'pip install git-filter-repo'," >&2
  echo "       or use the BFG fallback described in this script's header." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

git filter-repo --force --invert-paths --path .env --path .env.example

echo "History rewritten. Remember to force-push and ask collaborators to re-clone."