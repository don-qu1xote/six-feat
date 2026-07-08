#!/usr/bin/env bash
# Purges .env and .env.example from every commit in the repository's history.
#
# Requires: git-filter-repo (https://github.com/newren/git-filter-repo)
#   pip install git-filter-repo
#
# Fallback (if git-filter-repo is unavailable): use BFG Repo-Cleaner instead:
#   java -jar bfg.jar --delete-files .env --delete-files .env.example <repo>.git
#   cd <repo>.git && git reflog expire --expire=now --all && git gc --prune=now --aggressive
#
# Idempotent: safe to re-run; filter-repo is a no-op on paths that no longer
# appear in history.
#
# DANGER: this rewrites history. After running this script:
#   1. Force-push every affected branch:
#        git push --force --all
#        git push --force --tags
#   2. Every other developer MUST re-clone the repository (or hard-reset
#      their local clones to the new history) — old clones are incompatible
#      and must not be pushed/merged back.
#   3. Rotate any credentials that were ever present in the removed files.
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