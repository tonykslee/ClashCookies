#!/usr/bin/env bash
set -euo pipefail

./ops/deploy/ensure-yarn-deps.sh
npm run start
