#!/usr/bin/env bash
set -euo pipefail

root="${1:-}"
if [ -z "${root}" ] || [ ! -d "${root}" ]; then
  echo "Usage: $0 ARTIFACT_ROOT" >&2
  exit 2
fi

# Normalize only materialized directories and regular files. find does not follow
# dependency symlinks, so their relative targets and link identity remain intact.
find "${root}" -type d -exec chmod 0755 {} +
find "${root}" -type d -exec chmod a-s,a-t {} +
find "${root}" -type f ! -perm /111 -exec chmod 0644 {} +
find "${root}" -type f -perm /111 -exec chmod 0755 {} +
find "${root}" -type f -exec chmod a-s,a-t {} +
