#!/usr/bin/env bash
set -u

scenario="${1:?scenario required}"
deploy_script="${2:?deployment script required}"
root="$(mktemp -d)"
app_dir="${root}/app"
replacement_dir="${app_dir}-replacement"
bin_dir="${root}/bin"
log_file="${root}/commands.log"
state_file="${root}/state"
worktree_state_file="${root}/worktree-state"
output_file="${root}/output.log"
mkdir -p "$app_dir" "$bin_dir"
printf 'DISCORD_TOKEN=fixture-only\n' > "$app_dir/.env"
cat > "$app_dir/docker-compose.yml" <<'EOF'
services:
  app:
    environment:
      DATABASE_URL: postgresql://db/clashcookies
EOF
: > "$log_file"
printf '%s\n' none > "$worktree_state_file"
if [ "$scenario" = "concurrent-active" ]; then
  printf '%s\n' two > "$state_file"
else
  printf '%s\n' 'active:OLD' > "$state_file"
fi

cat > "$bin_dir/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
log() { printf 'GIT %s\n' "$*" >> "$DEPLOY_TEST_LOG"; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c|-C) shift 2 ;;
    *) break ;;
  esac
done
command="${1:-}"; shift || true
case "$command" in
  fetch) log fetch; exit 0 ;;
  rev-parse)
    if [ "${1:-}" = "HEAD" ]; then printf '%s\n' old-reviewed-sha; else printf '%s\n' new-reviewed-sha; fi
    ;;
  diff)
    log diff "$*"
    if [[ " $* " == *" --name-only "* ]] && [ "${DEPLOY_TEST_SCENARIO:-}" = migration ]; then
      printf '%s\n' prisma/schema.prisma
    elif [ "${DEPLOY_TEST_SCENARIO:-}" = changed-checkout ]; then
      exit 1
    fi
    ;;
  ls-files)
    if [ "${DEPLOY_TEST_SCENARIO:-}" = untracked-collision ]; then printf '%s\n' unknown.txt; fi
    ;;
  ls-tree)
    if [ "${DEPLOY_TEST_SCENARIO:-}" = untracked-collision ]; then
      printf '%s\n' unknown.txt
    elif [ "${DEPLOY_TEST_SCENARIO:-}" = legacy-target ] || [ "${DEPLOY_TEST_SCENARIO:-}" = legacy-health-failure ]; then
      log legacy_target_missing_deploy_script
      printf '%s\n' package.json
    else
      printf '%s\n' package.json
    fi
    ;;
  worktree)
    action="${1:-}"; shift || true
    if [ "$action" = add ]; then
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --detach|--quiet) shift ;;
          *) path="$1"; shift; break ;;
        esac
      done
      mkdir -p "$path"
      printf 'owned:%s\n' "$path" > "$DEPLOY_TEST_WORKTREE_STATE"
      log worktree-add
    elif [ "$action" = list ]; then
      worktree_state="$(cat "$DEPLOY_TEST_WORKTREE_STATE")"
      if [[ "$worktree_state" == owned:* ]]; then
        worktree_path="${worktree_state#owned:}"
        printf 'worktree %s\nHEAD new-reviewed-sha\n\n' "$worktree_path"
      fi
    elif [ "$action" = remove ]; then
      path="${1:-}"; log worktree-remove
      if [ "${DEPLOY_TEST_SCENARIO:-}" = cleanup-failure ]; then
        exit 1
      fi
      rm -rf -- "$path"
      printf '%s\n' removed > "$DEPLOY_TEST_WORKTREE_STATE"
    fi
    ;;
  checkout)
    revision="${@: -1}"
    printf 'CHECKOUT %s\n' "$revision" >> "$DEPLOY_TEST_LOG"
    ;;
  *) log "unknown $command" ;;
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
state="$(cat "$DEPLOY_TEST_STATE")"
case "${1:-}" in
  compose)
    if [ "${2:-}" = "-f" ] && [ "${4:-}" = "config" ]; then
      case "${DEPLOY_TEST_SCENARIO:-}" in
        compose-environment-list)
          printf '%s\n' '{"services":{"app":{"environment":["DATABASE_URL=postgresql://db/clashcookies"]},"worker":{"environment":["LOG_LEVEL=info"]}}}'
          ;;
        compose-multi-service)
          printf '%s\n' '{"services":{"app":{"environment":{"DATABASE_URL":"postgresql://db/clashcookies"}},"worker":{"environment":{"CACHE_URL":"redis://cache"}}}}'
          ;;
        compose-wrong-service)
          printf '%s\n' '{"services":{"app":{"environment":{"LOG_LEVEL":"info"}},"worker":{"environment":{"DATABASE_URL":"postgresql://db/clashcookies"}}}}'
          ;;
        compose-unresolved)
          printf '%s\n' '{"services":{"app":{"environment":{"DATABASE_URL":"${DATABASE_URL}"}}}}'
          ;;
        compose-invalid)
          printf '%s\n' '{"services":{"app":{"environment":{"DATABASE_URL":"mysql://db/clashcookies"}}}}'
          ;;
        compose-ambiguous)
          printf '%s\n' '{"services":{"app":{"environment":["DATABASE_URL=postgresql://db/one","DATABASE_URL=postgresql://db/two"]}}}'
          ;;
        *)
          printf '%s\n' '{"services":{"app":{"environment":{"DATABASE_URL":"postgresql://db/clashcookies"}}}}'
          ;;
      esac
    else
      exit 1
    fi
    ;;
  ps)
    if [ "$state" = two ]; then
      printf '%s\n' 'clashcookies-app|127.0.0.1:8085->8080/tcp|active|node:20-bookworm|bash ./ops/deploy/container-start.sh'
      printf '%s\n' 'other-active|||node:20-bookworm|node dist/ClashCookies.js'
    elif [[ "$state" == active:* ]]; then
      printf '%s\n' 'clashcookies-app|127.0.0.1:8085->8080/tcp|active|node:20-bookworm|bash ./ops/deploy/container-start.sh'
    fi
    ;;
  rm)
    printf '%s\n' inactive > "$DEPLOY_TEST_STATE"
    ;;
  run)
    if [[ " $* " == *" npm run build "* ]]; then
      printf 'BUILD %s\n' "$*" >> "$DEPLOY_TEST_LOG"
      [ "${DEPLOY_TEST_SCENARIO:-}" != candidate-build-failure ] || exit 1
    else
      revision=unknown
      for argument in "$@"; do
        case "$argument" in
          com.clashcookies.revision=*) revision="${argument#*=}" ;;
        esac
      done
      printf 'ACTIVE_RUN %s\n' "$revision" >> "$DEPLOY_TEST_LOG"
      printf 'active:%s\n' "$revision" > "$DEPLOY_TEST_STATE"
      printf '%s\n' container-id
    fi
    ;;
esac
EOF

cat > "$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="$(cat "$DEPLOY_TEST_STATE")"
revision="${state#active:}"
printf 'CURL %s\n' "$revision" >> "$DEPLOY_TEST_LOG"
if [ "${DEPLOY_TEST_SCENARIO:-}" = health-failure ] || [ "${DEPLOY_TEST_SCENARIO:-}" = legacy-health-failure ]; then
  [ "$revision" = OLD ] || exit 1
elif [ "${DEPLOY_TEST_SCENARIO:-}" = rollback-failure ]; then
  exit 1
fi
EOF

cat > "$bin_dir/flock" <<'EOF'
#!/usr/bin/env bash
printf 'FLOCK %s\n' "$*" >> "$DEPLOY_TEST_LOG"
[ "${DEPLOY_TEST_SCENARIO:-}" != lock-busy ] || exit 1
exit 0
EOF
cat > "$bin_dir/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$bin_dir"/*

if [ "$scenario" = stale-candidate ]; then
  mkdir -p "$replacement_dir"
  printf '%s\n' 'preserve me' > "$replacement_dir/operator-marker"
fi

if [ "$scenario" = lock-busy ]; then
  mkdir -p "${root}/deploy.lock"
fi

set +e
PATH="$bin_dir:$PATH" \
APP_DIR="$app_dir" \
DEPLOY_LOCK_PATH="${root}/deploy.lock" \
DEPLOY_TEST_LOG="$log_file" \
DEPLOY_TEST_STATE="$state_file" \
DEPLOY_TEST_WORKTREE_STATE="$worktree_state_file" \
DEPLOY_TEST_SCENARIO="$scenario" \
HEALTH_TIMEOUT_SECONDS=1 \
HEALTH_POLL_INTERVAL_SECONDS=0 \
bash "$deploy_script" > "$output_file" 2>&1
status=$?
set -e

printf 'STATUS=%s\n' "$status"
printf 'OUTPUT_BEGIN\n'
cat "$output_file"
printf 'OUTPUT_END\nLOG_BEGIN\n'
cat "$log_file"
printf 'LOG_END\nSTATE=%s\n' "$(cat "$state_file")"
printf 'WORKTREE=%s\n' "$(cat "$worktree_state_file")"
if [ -f "$replacement_dir/operator-marker" ]; then printf 'MARKER=preserved\n'; fi
exit 0
