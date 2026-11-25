#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --output DIR [--image IMAGE@sha256:DIGEST] [--platform linux/amd64] [--expected-sha SHA]" >&2
  exit 2
}

output_dir=""
image="node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5"
platform="linux/amd64"
expected_sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output_dir="${2:-}"; shift 2 ;;
    --image) image="${2:-}"; shift 2 ;;
    --platform) platform="${2:-}"; shift 2 ;;
    --expected-sha) expected_sha="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "${output_dir}" ] || usage
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required for the off-host artifact builder" >&2; exit 1; }
case "${image}" in *@sha256:*) ;; *) echo "--image must be digest-pinned" >&2; exit 1 ;; esac

source_sha="$(git rev-parse --verify HEAD)"
if [ -n "${expected_sha}" ] && [ "${source_sha}" != "${expected_sha}" ]; then
  echo "checked-out SHA ${source_sha} does not match expected SHA ${expected_sha}" >&2
  exit 1
fi
mkdir -p "${output_dir}"
if [ -n "$(find "${output_dir}" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "output directory must be empty: ${output_dir}" >&2
  exit 1
fi

source_tar="$(mktemp)"
cleanup() { rm -f "${source_tar}"; }
trap cleanup EXIT
git archive --format=tar --output="${source_tar}" "${source_sha}"
artifact_name="clashcookies-runtime-${source_sha}.tar.gz"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch_ms="$(date +%s%3N)"

docker run --rm --platform "${platform}" -i \
  -e "SOURCE_SHA=${source_sha}" \
  -e "BUILD_IMAGE=${image}" \
  -e "BUILD_PLATFORM=${platform}" \
  -e "BUILD_ARCHITECTURE=${platform#*/}" \
  -e "GITHUB_EVENT_NAME=${GITHUB_EVENT_NAME:-local}" \
  -e "GITHUB_WORKFLOW=${GITHUB_WORKFLOW:-local}" \
  -e "GITHUB_RUN_ID=${GITHUB_RUN_ID:-local}" \
  -e "GITHUB_RUN_ATTEMPT=${GITHUB_RUN_ATTEMPT:-1}" \
  -e "GITHUB_REF=${GITHUB_REF:-local}" \
  -e "GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-local}" \
  -e "GITHUB_SERVER_URL=${GITHUB_SERVER_URL:-}" \
  -e "ARTIFACT_NAME=${artifact_name}" \
  -e "BUILD_STARTED_AT=${started_at}" \
  -e "BUILD_STARTED_EPOCH_MS=${started_epoch_ms}" \
  -v "$(cd "${output_dir}" && pwd):/output" \
  "${image}" bash -euo pipefail -c '
    mkdir -p /work/source /work/package
    tar -xf - -C /work/source
    cd /work/source
    corepack enable
    corepack prepare yarn@1.22.22 --activate
    export NODE_VERSION="$(node --version)"
    export YARN_VERSION="$(yarn --version)"
    yarn install --frozen-lockfile
    npm run build
    export BUILD_DURATION_MS="$(( $(date +%s%3N) - BUILD_STARTED_EPOCH_MS ))"
    node scripts/runtime-artifact-manifest.js --root /work/source --output /work/package/runtime-artifact-manifest.json
    cp -a dist node_modules prisma package.json yarn.lock /work/package/
    tar -czf "/output/${ARTIFACT_NAME}" -C /work/package dist node_modules prisma package.json yarn.lock runtime-artifact-manifest.json
    archive_sha="$(sha256sum "/output/${ARTIFACT_NAME}" | awk "{print \$1}")"
    archive_bytes="$(stat -c %s "/output/${ARTIFACT_NAME}")"
    node scripts/finalize-runtime-artifact.js \
      --root /work/package \
      --embedded /work/package/runtime-artifact-manifest.json \
      --output "/output/${ARTIFACT_NAME}.manifest.json" \
      --sha256 "${archive_sha}" \
      --archive-bytes "${archive_bytes}"
    printf "%s  %s\n" "${archive_sha}" "${ARTIFACT_NAME}" > "/output/${ARTIFACT_NAME}.sha256"
  ' < "${source_tar}"

echo "Built ${output_dir}/${artifact_name}"
