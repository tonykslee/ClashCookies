#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ ! -f .githooks/pre-commit ] || [ ! -f .githooks/commit-msg ]; then
  echo "Tracked Git hooks are missing from .githooks/." >&2
  exit 1
fi

configured_hooks_path="$(git config --get core.hooksPath || true)"
if [ -n "$configured_hooks_path" ] && [ "$configured_hooks_path" != '.githooks' ]; then
  echo "Refusing to replace configured core.hooksPath='$configured_hooks_path'." >&2
  echo "Review that hooks directory, then explicitly choose the tracked hooks if appropriate:" >&2
  echo "  git config --local core.hooksPath .githooks" >&2
  exit 1
fi

if [ -z "$configured_hooks_path" ]; then
  legacy_hooks_dir="$(git rev-parse --git-path hooks)"
  legacy_hooks="$(find "$legacy_hooks_dir" -maxdepth 1 -type f ! -name '*.sample' -exec basename {} \; 2>/dev/null || true)"
  if [ -n "$legacy_hooks" ]; then
    echo "Refusing to replace active hooks in $legacy_hooks_dir:" >&2
    printf '  %s\n' "$legacy_hooks" >&2
    echo "Review or migrate them explicitly before selecting .githooks:" >&2
    echo "  git diff --no-index .git/hooks/pre-commit .githooks/pre-commit" >&2
    echo "  git diff --no-index .git/hooks/commit-msg .githooks/commit-msg" >&2
    echo "  git config --local core.hooksPath .githooks" >&2
    exit 1
  fi
fi

git config core.hooksPath .githooks
echo "Installed tracked Git hooks from .githooks/"
