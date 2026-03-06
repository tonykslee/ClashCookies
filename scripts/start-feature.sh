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

git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c "$branch"

echo "Created and switched to $branch"
