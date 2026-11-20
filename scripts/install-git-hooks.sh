#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ ! -f .githooks/pre-commit ] || [ ! -f .githooks/commit-msg ]; then
  echo "Tracked Git hooks are missing from .githooks/." >&2
  exit 1
fi

git config core.hooksPath .githooks
echo "Installed tracked Git hooks from .githooks/"
