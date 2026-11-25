#!/usr/bin/env bash
set -euo pipefail
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$script_dir/validate-runtime-artifact.py" "$@"
fi
exec python "$script_dir/validate-runtime-artifact.py" "$@"
