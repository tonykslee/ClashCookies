#!/usr/bin/env bash
set -euo pipefail

if [ "${CLASHCOOKIES_PREBUILT:-0}" = "1" ]; then
  expected_build_sha="${BUILD_SHA:-}"
  dist_revision="$(sed -n 's/^revision=//p' ./dist/.clashcookies-artifact 2>/dev/null || true)"
  node_modules_revision="$(sed -n 's/^revision=//p' ./node_modules/.clashcookies-artifact 2>/dev/null || true)"
  if [ -z "${expected_build_sha}" ] || [ "${dist_revision}" != "${expected_build_sha}" ] || [ "${node_modules_revision}" != "${expected_build_sha}" ]; then
    echo "[deploy:start] action=refuse reason=artifact_sha_mismatch expected=${expected_build_sha:-unknown} dist=${dist_revision:-unknown} node_modules=${node_modules_revision:-unknown}" >&2
    exit 1
  fi
  echo "[deploy:start] action=skip-build reason=prebuilt build_sha=${BUILD_SHA:-unknown}"
  npm run start:runtime
else
  ./ops/deploy/ensure-yarn-deps.sh
  npm run start
fi
