#!/usr/bin/env bash
set -euo pipefail

HASH_FILE="node_modules/.clashcookies-yarn-manifest.sha256"
INTEGRITY_FILE="node_modules/.yarn-integrity"

if [ ! -f package.json ]; then
  echo "[deploy:deps] missing package.json" >&2
  exit 1
fi

if [ ! -f yarn.lock ]; then
  echo "[deploy:deps] missing yarn.lock" >&2
  exit 1
fi

mkdir -p node_modules

current_hash="$(
  sha256sum package.json yarn.lock \
    | sha256sum \
    | awk '{print $1}'
)"
previous_hash=""
if [ -f "${HASH_FILE}" ]; then
  previous_hash="$(cat "${HASH_FILE}")"
fi

needs_install="0"
reason="manifest_unchanged"

if [ ! -f "${INTEGRITY_FILE}" ]; then
  needs_install="1"
  reason="missing_yarn_integrity"
elif [ ! -f "${HASH_FILE}" ]; then
  needs_install="1"
  reason="missing_manifest_hash"
elif [ "${previous_hash}" != "${current_hash}" ]; then
  needs_install="1"
  reason="manifest_changed"
fi

if [ "${needs_install}" = "1" ]; then
  echo "[deploy:deps] action=install reason=${reason}"
  corepack enable
  yarn install --frozen-lockfile
  printf '%s\n' "${current_hash}" > "${HASH_FILE}"
  exit 0
fi

echo "[deploy:deps] action=skip reason=${reason}"
