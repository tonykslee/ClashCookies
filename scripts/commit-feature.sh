#!/usr/bin/env bash
set -euo pipefail

if [ ! -f ".git/AI_COMMIT_MSG" ]; then
  echo "Missing .git/AI_COMMIT_MSG. Generate and save a Conventional Commit message first."
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "No changes to commit."
  exit 1
fi

git add -A
git commit -F .git/AI_COMMIT_MSG
git push -u origin HEAD

echo "Committed and pushed $(git branch --show-current)"
