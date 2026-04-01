#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 4 ]; then
  echo "Usage: $0 <username> <password> [email] [display-name]" >&2
  exit 1
fi

username="$1"
password="$2"
email="${3:-ops@example.com}"
display_name="${4:-ClashCookies Ops}"
target_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dozzle"
target_file="${target_dir}/users.yml"

mkdir -p "${target_dir}"

docker run --rm amir20/dozzle generate \
  --name "${display_name}" \
  --email "${email}" \
  --password "${password}" \
  --user-filter "name=clashcookies" \
  --user-roles "none" \
  "${username}" > "${target_file}"

echo "Wrote ${target_file}"
