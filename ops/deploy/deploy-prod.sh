#!/usr/bin/env bash
set -euo pipefail

# Version-controlled production deploy entry point. The VM wrapper may exec this
# file without changing its argument-free interface or production paths.

APP_DIR="${APP_DIR:-/home/tilo/apps/clashcookies-prod}"
PROD_NETWORK="${PROD_NETWORK:-clashcookies-prod_default}"
NORMAL_CONTAINER="${NORMAL_CONTAINER:-clashcookies-app}"
NORMAL_PORT="${NORMAL_PORT:-8085}"
TEMP_WORKTREE="${TEMP_WORKTREE:-${APP_DIR}-replacement}"
BUILD_CONTAINER="${BUILD_CONTAINER:-clashcookies-prod-candidate-build}"
BUILD_VOLUME="${BUILD_VOLUME:-clashcookies-prod-candidate_node_modules}"
BUILD_DIST_VOLUME="${BUILD_DIST_VOLUME:-clashcookies-prod-candidate_dist}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/run/lock/clashcookies-prod-deploy.lock}"
TARGET_REF="${TARGET_REF:-origin/main}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-600}"
HEALTH_POLL_INTERVAL_SECONDS="${HEALTH_POLL_INTERVAL_SECONDS:-2}"
TEMP_WORKTREE_CREATED="0"
OLD_SHA=""
NEW_SHA=""
PROD_DATABASE_URL=""

log() {
  printf '%s\n' "[deploy-prod] $*"
}

fatal() {
  log "result=failed reason=$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fatal "missing_command=$1"
}

require_file() {
  [ -f "$1" ] || fatal "missing_required_file=$1"
}

git_safe() {
  git -c "safe.directory=${APP_DIR}" -C "$APP_DIR" "$@"
}

assert_checkout_safe() {
  if ! git_safe diff --quiet; then
    fatal "tracked_worktree_changes_present"
  fi
  if ! git_safe diff --cached --quiet; then
    fatal "staged_worktree_changes_present"
  fi
}

assert_target_does_not_overwrite_unknown_files() {
  local revision="$1"
  local untracked_paths
  local target_paths
  local unknown_path
  local target_path

  untracked_paths="$(git_safe ls-files --others --ignored --exclude-standard --directory)"
  target_paths="$(git_safe ls-tree -r --name-only "$revision")"

  while IFS= read -r unknown_path; do
    unknown_path="${unknown_path%/}"
    [ -n "$unknown_path" ] || continue
    while IFS= read -r target_path; do
      [ -n "$target_path" ] || continue
      case "$target_path" in
        "$unknown_path"|"$unknown_path"/*)
          fatal "unknown_path_would_be_overwritten path=${unknown_path}"
          ;;
      esac
      case "$unknown_path" in
        "$target_path"/*)
          fatal "unknown_path_would_be_overwritten path=${unknown_path}"
          ;;
      esac
    done <<< "$target_paths"
  done <<< "$untracked_paths"
}

assert_safe_temp_worktree_path() {
  case "$TEMP_WORKTREE" in
    /|/home|/home/|/home/tilo|/home/tilo/|/home/tilo/apps|/home/tilo/apps/|"$APP_DIR")
      fatal "unsafe_temp_worktree_path=${TEMP_WORKTREE}"
      ;;
  esac

  [ "$TEMP_WORKTREE" = "${APP_DIR}-replacement" ] || \
    fatal "temp_worktree_must_be_app_replacement_path"

  if [ -e "$TEMP_WORKTREE" ] || [ -L "$TEMP_WORKTREE" ]; then
    fatal "refusing_to_clean_existing_temp_worktree=${TEMP_WORKTREE}"
  fi
}

extract_database_url() {
  local compose_file="$1"
  sed -n 's/^[[:space:]]*DATABASE_URL:[[:space:]]*//p' "$compose_file" \
    | head -n1 \
    | tr -d '"' \
    | tr -d '\r'
}

list_active_runtime_names() {
  docker ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.clashcookies.runtime"}}' \
    | awk -F'|' -v port="$NORMAL_PORT" '$3 == "active" || index($2, ":" port "->8080") > 0 { print $1 }'
}

assert_single_active_runtime() {
  local names
  local count
  names="$(list_active_runtime_names)"
  count="$(printf '%s\n' "$names" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

  if [ "$count" != "1" ] || [ "$names" != "$NORMAL_CONTAINER" ]; then
    log "active_runtime_guard=failed expected=1 name=${NORMAL_CONTAINER} observed=${names:-none}"
    return 1
  fi
}

assert_no_active_runtime() {
  local names
  names="$(list_active_runtime_names)"
  if [ -n "$names" ]; then
    log "active_runtime_guard=failed expected=0 observed=${names}"
    return 1
  fi
}

stop_active_runtime() {
  docker rm -f "$NORMAL_CONTAINER" >/dev/null 2>&1 || return 1
  assert_no_active_runtime
}

stop_active_runtime_for_recovery() {
  docker rm -f "$NORMAL_CONTAINER" >/dev/null 2>&1 || true
  assert_no_active_runtime
}

wait_for_health() {
  local label="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl --fail --silent --show-error --max-time 5 \
      "http://127.0.0.1:${NORMAL_PORT}/healthz" >/dev/null 2>&1; then
      log "health_result=${label} status=200"
      return 0
    fi
    sleep "$HEALTH_POLL_INTERVAL_SECONDS"
  done

  log "health_result=${label} status=timeout" >&2
  return 1
}

start_active_runtime() {
  local revision="$1"
  local container_id
  local -a docker_args

  require_file "$APP_DIR/.env"
  [ -n "$PROD_DATABASE_URL" ] || return 1

  docker_args=(
    run -d
    --restart unless-stopped
    --name "$NORMAL_CONTAINER"
    --label "com.clashcookies.runtime=active"
    --label "com.clashcookies.environment=prod"
    --label "com.clashcookies.revision=${revision}"
    --network "$PROD_NETWORK"
    -p "127.0.0.1:${NORMAL_PORT}:8080"
    --env-file "$APP_DIR/.env"
    -e "DATABASE_URL=${PROD_DATABASE_URL}"
    -e POLLING_MODE=active
    -e POLLING_ENV=prod
    -w /app
    -v "$APP_DIR:/app"
    -v clashcookies-prod_node_modules:/app/node_modules
    -v clashcookies-prod_yarn_cache:/usr/local/share/.cache/yarn
    node:20-bookworm
    bash ./ops/deploy/container-start.sh
  )

  if ! container_id="$(docker "${docker_args[@]}")"; then
    log "active_runtime_start=failed revision=${revision}"
    return 1
  fi
  if [ -z "$container_id" ]; then
    log "active_runtime_start=failed reason=missing_container_id revision=${revision}"
    return 1
  fi

  log "active_runtime_start=success revision=${revision}"
  assert_single_active_runtime
}

build_candidate_only() {
  local build_log
  build_log="$(mktemp)"

  # Deliberately do not pass .env, DATABASE_URL, Discord credentials, the
  # production Docker network, or container-start.sh. This command installs
  # dependencies and compiles only; it cannot start the app or run migrations.
  if ! docker run --rm \
    --name "$BUILD_CONTAINER" \
    --label com.clashcookies.deploy=candidate-build-only \
    --network bridge \
    -w /app \
    -v "$TEMP_WORKTREE:/app" \
    -v "$BUILD_VOLUME:/app/node_modules" \
    -v "$BUILD_DIST_VOLUME:/app/dist" \
    -v clashcookies-prod_yarn_cache:/usr/local/share/.cache/yarn \
    node:20-bookworm \
    bash -lc './ops/deploy/ensure-yarn-deps.sh && npm run build' \
    >"$build_log" 2>&1; then
    rm -f -- "$build_log"
    log "candidate_build=failed revision=${NEW_SHA}"
    return 1
  fi

  rm -f -- "$build_log"
  log "candidate_build=success revision=${NEW_SHA}"
}

remove_candidate_worktree() {
  if [ "$TEMP_WORKTREE_CREATED" != "1" ]; then
    return 0
  fi

  # Never force-remove this path. If the build left an unexpected file or the
  # path no longer identifies our Git worktree, leave it for operator review.
  if ! git_safe worktree remove "$TEMP_WORKTREE" >/dev/null 2>&1; then
    log "candidate_cleanup=refused path=${TEMP_WORKTREE}" >&2
    return 1
  fi
  TEMP_WORKTREE_CREATED="0"
  log "candidate_cleanup=success"
}

cleanup() {
  remove_candidate_worktree || true
}

rollback_to_old_revision() {
  log "rollback=start revision=${OLD_SHA}"

  if ! stop_active_runtime_for_recovery; then
    log "rollback_result=failed reason=active_runtime_was_not_singleton" >&2
    return 1
  fi
  if ! git_safe checkout --quiet --detach "$OLD_SHA"; then
    log "rollback_result=failed reason=checkout_old_revision" >&2
    return 1
  fi
  if ! start_active_runtime "$OLD_SHA"; then
    log "rollback_result=failed reason=start_old_revision" >&2
    return 1
  fi
  if ! wait_for_health rollback; then
    log "rollback_result=failed reason=health" >&2
    return 1
  fi

  log "rollback_result=success"
  return 0
}

require_command git
require_command docker
require_command curl
require_command flock
require_file "$APP_DIR/.env"
require_file "$APP_DIR/docker-compose.yml"
assert_safe_temp_worktree_path
assert_checkout_safe

lock_parent="$(dirname "$LOCK_FILE")"
[ -d "$lock_parent" ] || fatal "missing_lock_directory=${lock_parent}"
exec {lock_fd}>"$LOCK_FILE"
flock -n "$lock_fd" || fatal "another_deployment_is_running"

assert_single_active_runtime || fatal "active_runtime_singleton_required_before_deploy"

log "fetch=origin/main"
git_safe fetch --quiet origin main
OLD_SHA="$(git_safe rev-parse HEAD)"
NEW_SHA="$(git_safe rev-parse "${TARGET_REF}^{commit}")"
log "old_revision=${OLD_SHA}"
log "new_revision=${NEW_SHA}"

changed_prisma_files="$(git_safe diff --name-only "$OLD_SHA" "$NEW_SHA" -- prisma/migrations prisma/schema.prisma)"
if [ -n "$changed_prisma_files" ]; then
  fatal "migration_changes_detected_fail_closed"
fi

assert_target_does_not_overwrite_unknown_files "$NEW_SHA"
PROD_DATABASE_URL="$(extract_database_url "$APP_DIR/docker-compose.yml")"
[ -n "$PROD_DATABASE_URL" ] || fatal "production_database_url_not_found"

git_safe worktree add --quiet --detach "$TEMP_WORKTREE" "$NEW_SHA"
TEMP_WORKTREE_CREATED="1"

if ! build_candidate_only; then
  exit 1
fi
remove_candidate_worktree || fatal "candidate_cleanup_required_before_promotion"

assert_single_active_runtime || fatal "active_runtime_changed_during_candidate_build"
if ! stop_active_runtime; then
  fatal "failed_to_stop_existing_active_runtime"
fi

if ! git_safe checkout --quiet --detach "$NEW_SHA"; then
  rollback_to_old_revision || true
  exit 1
fi

if ! start_active_runtime "$NEW_SHA" || ! wait_for_health promotion; then
  log "promotion_result=failed reason=health_or_start" >&2
  rollback_to_old_revision || true
  exit 1
fi

log "promotion_result=success"
exit 0
