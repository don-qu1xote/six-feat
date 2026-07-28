#!/usr/bin/env bash
# Убирает data/ (локальная SQLite БД + WAL/SHM) из git, оставляя файлы на диске.
set -euo pipefail

if git ls-files --error-unmatch -- data >/dev/null 2>&1; then
    git rm --cached -r data/
    echo "data/ untracked. Review 'git status', then commit the removal."
else
    echo "data/ is not tracked by git — nothing to do."
fi