#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: ./scripts/start-feature.sh <2-4 word description>"
  exit 1
fi

description="$*"
slug="$(echo "$description" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"

if [ -z "$slug" ]; then
  echo "Could not derive a branch slug from input."
  exit 1
fi

branch="feature/$slug"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

bash "$script_dir/install-git-hooks.sh"

git fetch origin
git switch dev
git pull --ff-only origin dev

latest_dev="$(git rev-parse --verify origin/dev)"
dev_head="$(git rev-parse --verify dev)"
if [ "$dev_head" != "$latest_dev" ]; then
  echo "Refusing to create $branch: local dev is not exactly origin/dev."
  exit 1
fi

git switch -c "$branch"

echo "Created and switched to $branch"
