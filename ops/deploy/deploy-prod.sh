#!/usr/bin/env bash
set -euo pipefail

# Version-controlled representation of the established SSH deployment wrapper.
# The live ~/deploy-prod.sh must be updated separately after this procedure has
# been reviewed and approved. This script deliberately has no Discord or
# database credentials in the candidate-build path.

APP_DIR="${APP_DIR:-/home/tilo/apps/clashcookies-prod}"
PROD_NETWORK="${PROD_NETWORK:-clashcookies-prod_default}"
NORMAL_CONTAINER="${NORMAL_CONTAINER:-clashcookies-app}"
BUILD_CONTAINER="${BUILD_CONTAINER:-clashcookies-prod-candidate-build}"
NORMAL_PORT="${NORMAL_PORT:-8085}"
TEMP_WORKTREE="${TEMP_WORKTREE:-${APP_DIR}-replacement}"
RUNTIME_ENV_FILE="${DEPLOY_RUNTIME_ENV_FILE:-${APP_DIR}/.env}"
NORMAL_NODE_MODULES_VOLUME="${NORMAL_NODE_MODULES_VOLUME:-clashcookies-prod_node_modules}"
NORMAL_YARN_CACHE_VOLUME="${NORMAL_YARN_CACHE_VOLUME:-clashcookies-prod_yarn_cache}"
TARGET_REF="${TARGET_REF:-origin/main}"
READINESS_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-1500}"
PROMOTION_HEALTH_TIMEOUT_SECONDS="${PROMOTION_HEALTH_TIMEOUT_SECONDS:-$READINESS_TIMEOUT_SECONDS}"
ROLLBACK_HEALTH_TIMEOUT_SECONDS="${ROLLBACK_HEALTH_TIMEOUT_SECONDS:-$READINESS_TIMEOUT_SECONDS}"
HEALTH_POLL_INTERVAL_SECONDS="${HEALTH_POLL_INTERVAL_SECONDS:-2}"
HEALTH_REQUEST_TIMEOUT_SECONDS="${HEALTH_REQUEST_TIMEOUT_SECONDS:-5}"
DEPLOY_LOCK_PATH="${DEPLOY_LOCK_PATH:-${APP_DIR}-deploy.lock}"
DIAGNOSTIC_DIR="${DEPLOY_DIAGNOSTIC_DIR:-${APP_DIR}-deploy-diagnostics}"

TEMP_WORKTREE_CREATED="0"
BUILD_VOLUMES_CREATED="0"
BUILD_VOLUMES_IN_USE="0"
ACTIVE_CONTAINER_ID=""
OLD_SHA=""
NEW_SHA=""
BUILD_NODE_MODULES_VOLUME=""
BUILD_DIST_VOLUME=""
LOCK_HELD="0"

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
  git_safe diff --quiet || fatal "tracked_worktree_changes_present"
  git_safe diff --cached --quiet || fatal "staged_worktree_changes_present"
}

assert_safe_temp_worktree_path() {
  [ "$TEMP_WORKTREE" = "${APP_DIR}-replacement" ] || \
    fatal "temp_worktree_must_be_app_replacement_path"
  case "$TEMP_WORKTREE" in
    /|/home|/home/|/home/tilo|/home/tilo/|/home/tilo/apps|/home/tilo/apps/|"$APP_DIR")
      fatal "unsafe_temp_worktree_path=${TEMP_WORKTREE}"
      ;;
  esac
  if [ -e "$TEMP_WORKTREE" ] || [ -L "$TEMP_WORKTREE" ]; then
    fatal "refusing_to_clean_existing_temp_worktree=${TEMP_WORKTREE}"
  fi
}

assert_runtime_environment_source() {
  require_file "$RUNTIME_ENV_FILE"
  [ ! -L "$RUNTIME_ENV_FILE" ] || fatal "runtime_environment_symlinked"
}

list_active_runtime_names() {
  docker ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.clashcookies.runtime"}}|{{.Image}}|{{.Command}}' |
    while IFS='|' read -r name ports runtime_label image command; do
      [ -n "$name" ] || continue
      if [ "$runtime_label" = "active" ] \
        || [[ "$ports" == *":${NORMAL_PORT}->8080"* ]] \
        || [[ "$image" == *clashcookies* ]] \
        || [[ "$command" == *container-start.sh* ]] \
        || [[ "$command" == *start:runtime* ]] \
        || [[ "$command" == *ClashCookies.js* ]] \
        || [[ "$command" == *npm*start* ]] \
        || [[ "$command" == *yarn*start* ]]; then
        printf '%s\n' "$name"
      fi
    done
}

assert_single_active_runtime() {
  local names count
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
  [ -z "$names" ] || {
    log "active_runtime_guard=failed expected=0 observed=${names}"
    return 1
  }
}

capture_diagnostics() {
  local label="$1"
  local container_name="${2:-$NORMAL_CONTAINER}"
  local safe_label
  safe_label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')"
  mkdir -p "$DIAGNOSTIC_DIR"
  {
    printf 'label=%s\ncontainer=%s\nold_sha=%s\nnew_sha=%s\n' "$label" "$container_name" "$OLD_SHA" "$NEW_SHA"
    docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.RestartCount}}' "$container_name" 2>/dev/null || true
  } > "${DIAGNOSTIC_DIR}/${safe_label}.state"
  docker logs --tail 400 "$container_name" > "${DIAGNOSTIC_DIR}/${safe_label}.log" 2>&1 || true
  log "diagnostics_saved label=${label} dir=${DIAGNOSTIC_DIR}"
}

wait_for_health() {
  local host_port="$1"
  local label="$2"
  local timeout_seconds="${3:-$READINESS_TIMEOUT_SECONDS}"
  local deadline=$((SECONDS + timeout_seconds))
  local probe_count=0

  while [ "$SECONDS" -lt "$deadline" ]; do
    probe_count=$((probe_count + 1))
    if curl --fail --silent --show-error --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
      "http://127.0.0.1:${host_port}/healthz" >/dev/null 2>&1; then
      log "health_result=${label} status=200 probes=${probe_count} timeout_seconds=${timeout_seconds}"
      return 0
    fi
    sleep "$HEALTH_POLL_INTERVAL_SECONDS"
  done

  log "health_result=${label} status=timeout probes=${probe_count} timeout_seconds=${timeout_seconds} request_timeout_seconds=${HEALTH_REQUEST_TIMEOUT_SECONDS}" >&2
  return 1
}

cleanup_candidate_worktree() {
  [ "$TEMP_WORKTREE_CREATED" = "1" ] || return 0
  if git_safe worktree remove --quiet "$TEMP_WORKTREE"; then
    TEMP_WORKTREE_CREATED="0"
    log "candidate_cleanup=success"
  else
    log "candidate_cleanup=failed path=${TEMP_WORKTREE}" >&2
    return 1
  fi
}

cleanup_build_volumes() {
  [ "$BUILD_VOLUMES_CREATED" = "1" ] || return 0
  [ "$BUILD_VOLUMES_IN_USE" = "0" ] || return 0
  docker volume rm "$BUILD_NODE_MODULES_VOLUME" "$BUILD_DIST_VOLUME" >/dev/null 2>&1 || \
    log "build_artifacts_cleanup=deferred node_modules=${BUILD_NODE_MODULES_VOLUME} dist=${BUILD_DIST_VOLUME}"
}

cleanup_on_exit() {
  local status="$?"
  trap - EXIT
  cleanup_candidate_worktree || [ "$status" -ne 0 ] || status=1
  cleanup_build_volumes
  if [ "$LOCK_HELD" = "1" ]; then
    rm -f -- "${DEPLOY_LOCK_PATH}/owner"
    rmdir "$DEPLOY_LOCK_PATH" >/dev/null 2>&1 || {
      log "deploy_lock_release=failed path=${DEPLOY_LOCK_PATH}" >&2
      [ "$status" -ne 0 ] || status=1
    }
    LOCK_HELD="0"
  fi
  exit "$status"
}

acquire_lock() {
  if ! mkdir "$DEPLOY_LOCK_PATH" 2>/dev/null; then
    fatal "another_deployment_is_running"
  fi
  LOCK_HELD="1"
  printf 'pid=%s\n' "$$" > "${DEPLOY_LOCK_PATH}/owner"
  log "deploy_lock=acquired"
}

extract_database_url() {
  local file="$1"
  sed -n 's/^[[:space:]]*DATABASE_URL:[[:space:]]*//p' "$file" | head -n1 | tr -d '"'
}

build_candidate_only() {
  local log_file="${DIAGNOSTIC_DIR}/candidate-build.log"
  mkdir -p "$DIAGNOSTIC_DIR"
  docker volume create "$BUILD_NODE_MODULES_VOLUME" >/dev/null
  docker volume create "$BUILD_DIST_VOLUME" >/dev/null
  BUILD_VOLUMES_CREATED="1"
  if docker run --rm \
    --name "$BUILD_CONTAINER" \
    --label com.clashcookies.deploy=candidate-build-only \
    --network bridge \
    -w /app \
    -v "$TEMP_WORKTREE:/app" \
    -v "$BUILD_NODE_MODULES_VOLUME:/app/node_modules" \
    -v "$BUILD_DIST_VOLUME:/app/dist" \
    -v "$NORMAL_YARN_CACHE_VOLUME:/usr/local/share/.cache/yarn" \
    -e "BUILD_SHA=${NEW_SHA}" \
    node:20-bookworm \
    bash -lc './ops/deploy/ensure-yarn-deps.sh && npm run build' >"$log_file" 2>&1; then
    log "candidate_build=success revision=${NEW_SHA} diagnostics=${log_file}"
  else
    log "candidate_build=failed revision=${NEW_SHA} diagnostics=${log_file}" >&2
    return 1
  fi
}

start_app_container() {
  local container_name="$1"
  local app_dir="$2"
  local host_port="$3"
  local env_file="$4"
  local node_modules_volume="$5"
  local yarn_cache_volume="$6"
  local database_url="$7"
  local restart_mode="${8:-none}"
  local revision="${9:-unknown}"
  local prebuilt="${10:-0}"
  local dist_volume="${11:-}"
  local -a restart_args=() volume_args=( -v "$node_modules_volume:/app/node_modules" )

  require_file "$env_file"
  [ "$restart_mode" = "restart" ] && restart_args=(--restart unless-stopped)
  [ -n "$dist_volume" ] && volume_args+=( -v "$dist_volume:/app/dist" )

  ACTIVE_CONTAINER_ID="$(docker run -d \
    "${restart_args[@]}" \
    --name "$container_name" \
    --label "com.clashcookies.runtime=active" \
    --label "com.clashcookies.environment=prod" \
    --label "com.clashcookies.revision=${revision}" \
    --network "$PROD_NETWORK" \
    -p "127.0.0.1:${host_port}:8080" \
    --env-file "$env_file" \
    -e "DATABASE_URL=${database_url}" \
    -e POLLING_MODE=active \
    -e POLLING_ENV=prod \
    -e "BUILD_SHA=${revision}" \
    -e "CLASHCOOKIES_PREBUILT=${prebuilt}" \
    -w /app \
    -v "$app_dir:/app" \
    "${volume_args[@]}" \
    -v "$yarn_cache_volume:/usr/local/share/.cache/yarn" \
    node:20-bookworm \
    bash ./ops/deploy/container-start.sh)"
  [ -n "$ACTIVE_CONTAINER_ID" ] || return 1
  log "container_started name=${container_name} id=${ACTIVE_CONTAINER_ID} revision=${revision} prebuilt=${prebuilt}"
}

remove_started_container() {
  [ -n "$ACTIVE_CONTAINER_ID" ] || return 0
  docker rm -f "$ACTIVE_CONTAINER_ID" >/dev/null 2>&1 || true
  ACTIVE_CONTAINER_ID=""
}

rollback_to_old_revision() {
  log "rollback=start revision=${OLD_SHA}"
  remove_started_container
  BUILD_VOLUMES_IN_USE="0"
  assert_no_active_runtime || {
    capture_diagnostics rollback "$NORMAL_CONTAINER"
    log "rollback_result=failed reason=active_runtime_not_empty final_state=unknown" >&2
    return 1
  }
  git_safe reset --hard "$OLD_SHA" || {
    log "rollback_result=failed reason=checkout_old_revision final_state=unknown" >&2
    return 1
  }
  if ! start_app_container "$NORMAL_CONTAINER" "$APP_DIR" "$NORMAL_PORT" "$RUNTIME_ENV_FILE" \
    "$NORMAL_NODE_MODULES_VOLUME" "$NORMAL_YARN_CACHE_VOLUME" "$prod_database_url" restart \
    "$OLD_SHA" 1; then
    log "rollback_result=failed reason=start_old_revision final_state=unknown" >&2
    return 1
  fi
  if wait_for_health "$NORMAL_PORT" rollback "$ROLLBACK_HEALTH_TIMEOUT_SECONDS"; then
    BUILD_VOLUMES_IN_USE="0"
    log "rollback_result=success final_state=old_sha:${OLD_SHA}"
    return 0
  fi
  capture_diagnostics rollback "$NORMAL_CONTAINER"
  log "rollback_result=failed reason=health final_state=unhealthy_old_sha:${OLD_SHA}" >&2
  return 1
}

require_command git
require_command docker
require_command curl
require_command mkdir
require_command rmdir
require_command sed
require_command tr
require_command wc
require_file "$APP_DIR/docker-compose.yml"
assert_runtime_environment_source
assert_safe_temp_worktree_path
assert_checkout_safe
acquire_lock
trap cleanup_on_exit EXIT
assert_single_active_runtime || fatal "active_runtime_singleton_required_before_deploy"

mkdir -p "$DIAGNOSTIC_DIR"
log "fetch=origin"
git_safe fetch origin
OLD_SHA="$(git_safe rev-parse HEAD)"
NEW_SHA="$(git_safe rev-parse "${TARGET_REF}^{commit}")"
BUILD_NODE_MODULES_VOLUME="${BUILD_NODE_MODULES_VOLUME:-clashcookies-prod-build-${NEW_SHA}}"
BUILD_DIST_VOLUME="${BUILD_DIST_VOLUME:-clashcookies-prod-build-dist-${NEW_SHA}}"
log "old_sha=${OLD_SHA}"
log "new_sha=${NEW_SHA}"
log "promotion_readiness_budget_seconds=${PROMOTION_HEALTH_TIMEOUT_SECONDS} rollback_readiness_budget_seconds=${ROLLBACK_HEALTH_TIMEOUT_SECONDS} request_timeout_seconds=${HEALTH_REQUEST_TIMEOUT_SECONDS}"

changed_prisma_files="$(git_safe diff --name-only "$OLD_SHA" "$NEW_SHA" -- prisma/migrations prisma/schema.prisma || true)"
prod_database_url="$(extract_database_url "$APP_DIR/docker-compose.yml")"
[ -n "$prod_database_url" ] || fatal "unable_to_read_production_database_url"

if [ -n "$changed_prisma_files" ]; then
  log "mode=downtime reason=prisma_changes"
  docker rm -f "$NORMAL_CONTAINER" >/dev/null 2>&1 || true
  assert_no_active_runtime || fatal "active_runtime_did_not_stop"
  git_safe reset --hard "$NEW_SHA"
  if start_app_container "$NORMAL_CONTAINER" "$APP_DIR" "$NORMAL_PORT" "$RUNTIME_ENV_FILE" \
    "$NORMAL_NODE_MODULES_VOLUME" "$NORMAL_YARN_CACHE_VOLUME" "$prod_database_url" restart \
    "$NEW_SHA" 0; then
    if wait_for_health "$NORMAL_PORT" downtime "$PROMOTION_HEALTH_TIMEOUT_SECONDS"; then
      log "promotion_result=success mode=downtime final_state=new_sha:${NEW_SHA}"
      exit 0
    fi
    capture_diagnostics downtime "$NORMAL_CONTAINER"
  fi
  remove_started_container
  assert_no_active_runtime || log "final_state=unknown active_runtime_not_empty" >&2
  fatal "promotion_result=failed mode=downtime migration_recovery_required final_state=unknown"
fi

log "mode=build-only reason=prisma_unchanged"
git_safe worktree add --detach "$TEMP_WORKTREE" "$NEW_SHA"
TEMP_WORKTREE_CREATED="1"
build_candidate_only || fatal "candidate_build_failed final_state=old_sha:${OLD_SHA}"
cleanup_candidate_worktree || fatal "candidate_cleanup_failed"
assert_single_active_runtime || fatal "active_runtime_changed_during_candidate_build"

log "promotion_step=stop_old_app"
docker rm -f "$NORMAL_CONTAINER" >/dev/null 2>&1 || true
assert_no_active_runtime || fatal "active_runtime_did_not_stop"
git_safe reset --hard "$NEW_SHA"

if start_app_container "$NORMAL_CONTAINER" "$APP_DIR" "$NORMAL_PORT" "$RUNTIME_ENV_FILE" \
  "$BUILD_NODE_MODULES_VOLUME" "$NORMAL_YARN_CACHE_VOLUME" "$prod_database_url" restart \
  "$NEW_SHA" 1 "$BUILD_DIST_VOLUME"; then
  BUILD_VOLUMES_IN_USE="1"
  if wait_for_health "$NORMAL_PORT" promotion "$PROMOTION_HEALTH_TIMEOUT_SECONDS"; then
    assert_single_active_runtime || fatal "active_runtime_singleton_failed_after_promotion"
    log "promotion_result=success mode=build-only final_state=new_sha:${NEW_SHA}"
    exit 0
  fi
  capture_diagnostics promotion "$NORMAL_CONTAINER"
else
  log "promotion_result=failed reason=container_start final_state=unknown" >&2
fi

log "promotion_result=failed reason=health_or_start"
rollback_to_old_revision || true
if assert_single_active_runtime; then
  log "final_state=single_active_runtime"
else
  log "final_state=unknown active_runtime_guard_failed" >&2
fi
exit 1
