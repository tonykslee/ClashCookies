#!/usr/bin/env bash
set -euo pipefail

if [ "${CLASHCOOKIES_PREBUILT:-0}" = "1" ]; then
  echo "[deploy:start] action=skip-build reason=prebuilt build_sha=${BUILD_SHA:-unknown}"
  npm run start:runtime
else
  ./ops/deploy/ensure-yarn-deps.sh
  npm run start
fi
