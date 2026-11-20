#!/usr/bin/env bash
set -u

scenario="${1:?scenario required}"
deploy_script="${2:?deployment script required}"
root="${DEPLOY_TEST_ROOT:-$(mktemp -d)}"
app_dir="${root}/app"
replacement_dir="${app_dir}-replacement"
bin_dir="${root}/bin"
state_file="${root}/state"
log_file="${root}/commands.log"
output_file="${root}/output.log"
probe_file="${root}/probes"
mkdir -p "$app_dir" "$bin_dir"
printf 'DISCORD_TOKEN=fixture-only\n' > "$app_dir/.env"
printf 'services:\n  app:\n    environment:\n      DATABASE_URL: postgresql://fixture\n' > "$app_dir/docker-compose.yml"
printf '%s\n' 'active:OLD' > "$state_file"
: > "$log_file"
: > "$probe_file"

cat > "$bin_dir/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log() { printf 'GIT %s\n' "$*" >> "$DEPLOY_TEST_LOG"; }
while [ "$#" -gt 0 ]; do
  case "$1" in -c|-C) shift 2 ;; *) break ;; esac
done
command="${1:-}"; shift || true
case "$command" in
  fetch) log fetch; exit 0 ;;
  diff)
    log diff "$*"
    if [[ " $* " == *" --name-only "* ]] && [ "$DEPLOY_TEST_SCENARIO" = migration ]; then
      printf '%s\n' prisma/schema.prisma
    fi
    ;;
  rev-parse)
    if [ "${1:-}" = HEAD ]; then printf '%s\n' old-reviewed-sha; else printf '%s\n' new-reviewed-sha; fi
    ;;
  worktree)
    action="${1:-}"; shift || true
    if [ "$action" = add ]; then
      path="${@: -1}"; mkdir -p "$path"; log worktree-add
    elif [ "$action" = remove ]; then
      path="${@: -1}"; rm -rf -- "$path"; log worktree-remove
    fi
    ;;
  reset) log reset "$*" ;;
  *) log "$command $*" ;;
esac
EOF

cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
safe_args=()
for argument in "$@"; do
  case "$argument" in
    DATABASE_URL=*) safe_args+=(DATABASE_URL='<redacted>') ;;
    *) safe_args+=("$argument") ;;
  esac
done
printf 'DOCKER %s\n' "${safe_args[*]}" >> "$DEPLOY_TEST_LOG"
case "${1:-}" in
  volume)
    case "${2:-}" in create) printf '%s\n' "${3:-fixture-volume}" ;; rm) : ;; esac
    ;;
  ps)
    state="$(cat "$DEPLOY_TEST_STATE")"
    if [ "$state" = two ]; then
      printf '%s\n' 'clashcookies-app|127.0.0.1:8085->8080/tcp|active|node:20-bookworm|bash ./ops/deploy/container-start.sh'
      printf '%s\n' 'other-active|||node:20-bookworm|node dist/ClashCookies.js'
    elif [[ "$state" == active:* ]]; then
      printf '%s\n' 'clashcookies-app|127.0.0.1:8085->8080/tcp|active|node:20-bookworm|bash ./ops/deploy/container-start.sh'
    fi
    ;;
  run)
    if [[ " $* " == *" npm run build "* ]]; then
      printf 'BUILD %s\n' "$*" >> "$DEPLOY_TEST_LOG"
      [ "$DEPLOY_TEST_SCENARIO" != build-failure ] || exit 1
      exit 0
    fi
    if { [ "$DEPLOY_TEST_SCENARIO" = container-failure ] || [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ]; } && [[ "$*" == *new-reviewed-sha* ]]; then exit 1; fi
    revision=unknown
    name=unknown
    prebuilt=0
    previous=""
    for argument in "$@"; do
      case "$argument" in
        com.clashcookies.revision=*) revision="${argument#*=}" ;;
        CLASHCOOKIES_PREBUILT=*) prebuilt="${argument#*=}" ;;
      esac
      if [ "$previous" = --name ]; then name="$argument"; fi
      previous="$argument"
    done
    printf 'ACTIVE_RUN name=%s revision=%s prebuilt=%s\n' "$name" "$revision" "$prebuilt" >> "$DEPLOY_TEST_LOG"
    printf 'active:%s\n' "$revision" > "$DEPLOY_TEST_STATE"
    printf 'container-%s\n' "$revision"
    ;;
  rm) printf '%s\n' none > "$DEPLOY_TEST_STATE"; : > "$DEPLOY_TEST_PROBE_FILE" ;;
  inspect) printf 'running|0||2026-11-20T00:00:00Z||0\n' ;;
  logs) printf '[fixture] diagnostic log\n' ;;
esac
EOF

cat > "$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$DEPLOY_TEST_PROBE_FILE")"
count=$((count + 1))
printf '%s\n' "$count" > "$DEPLOY_TEST_PROBE_FILE"
state="$(cat "$DEPLOY_TEST_STATE")"
if { [ "$DEPLOY_TEST_SCENARIO" = cold-start ] || [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ]; } && [ "$count" -le 3 ]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = health-failure ] && [[ "$state" != active:old-reviewed-sha ]]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ] && [[ "$state" != active:old-reviewed-sha ]]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = rollback-failure ] || [ "$DEPLOY_TEST_SCENARIO" = health-timeout ]; then exit 1; fi
exit 0
EOF

cat > "$bin_dir/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$bin_dir"/*

if [ "$scenario" = concurrent-active ]; then printf '%s\n' two > "$state_file"; fi
if [ "$scenario" = lock-busy ]; then mkdir -p "${root}/deploy.lock"; fi

set +e
PATH="$bin_dir:$PATH" \
APP_DIR="$app_dir" \
TEMP_WORKTREE="$replacement_dir" \
DEPLOY_LOCK_PATH="${root}/deploy.lock" \
DEPLOY_DIAGNOSTIC_DIR="${root}/diagnostics" \
DEPLOY_TEST_LOG="$log_file" \
DEPLOY_TEST_STATE="$state_file" \
DEPLOY_TEST_PROBE_FILE="$probe_file" \
DEPLOY_TEST_SCENARIO="$scenario" \
PROMOTION_HEALTH_TIMEOUT_SECONDS="$([ "$scenario" = cold-start ] && printf 601 || printf 1)" \
ROLLBACK_HEALTH_TIMEOUT_SECONDS="$([ "$scenario" = rollback-cold-start ] && printf 601 || printf 1)" \
HEALTH_POLL_INTERVAL_SECONDS=0 \
HEALTH_REQUEST_TIMEOUT_SECONDS=1 \
TARGET_REF=origin/main \
bash "$deploy_script" > "$output_file" 2>&1
status=$?
set -e

printf 'STATUS=%s\n' "$status"
printf 'OUTPUT_BEGIN\n'; cat "$output_file"; printf 'OUTPUT_END\n'
printf 'LOG_BEGIN\n'; cat "$log_file"; printf 'LOG_END\n'
printf 'STATE=%s\n' "$(cat "$state_file")"
if [ -d "${root}/diagnostics" ]; then find "${root}/diagnostics" -maxdepth 1 -type f -printf 'DIAGNOSTIC=%f\n' | sort; fi
exit 0
