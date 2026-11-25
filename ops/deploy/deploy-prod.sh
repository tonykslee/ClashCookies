#!/usr/bin/env bash
set -euo pipefail

# Version-controlled representation of the established SSH deployment wrapper.
# The live ~/deploy-prod.sh must be updated separately after this procedure has
# been reviewed and approved. This script deliberately has no Discord or
# database credentials in the candidate-build path.
umask 077

APP_DIR="${APP_DIR:-/home/tilo/apps/clashcookies-prod}"
PROD_NETWORK="${PROD_NETWORK:-clashcookies-prod_default}"
NORMAL_CONTAINER="${NORMAL_CONTAINER:-clashcookies-app}"
BUILD_CONTAINER="${BUILD_CONTAINER:-clashcookies-prod-candidate-build}"
NORMAL_PORT="${NORMAL_PORT:-8085}"
TEMP_WORKTREE="${TEMP_WORKTREE:-${APP_DIR}-replacement}"
RUNTIME_ENV_FILE="${DEPLOY_RUNTIME_ENV_FILE:-${APP_DIR}/.env}"
NORMAL_NODE_MODULES_VOLUME="${NORMAL_NODE_MODULES_VOLUME:-clashcookies-prod_node_modules}"
NORMAL_YARN_CACHE_VOLUME="${NORMAL_YARN_CACHE_VOLUME:-clashcookies-prod_yarn_cache}"
BUILD_WORKSPACE_VOLUME="${BUILD_WORKSPACE_VOLUME:-}"
TARGET_REF="${TARGET_REF:-origin/main}"
CANDIDATE_BUILD_TIMEOUT_SECONDS="${CANDIDATE_BUILD_TIMEOUT_SECONDS:-1500}"
ARTIFACT_STAGE_TIMEOUT_SECONDS="${ARTIFACT_STAGE_TIMEOUT_SECONDS:-600}"
READINESS_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-1500}"
PROMOTION_HEALTH_TIMEOUT_SECONDS="${PROMOTION_HEALTH_TIMEOUT_SECONDS:-$READINESS_TIMEOUT_SECONDS}"
ROLLBACK_HEALTH_TIMEOUT_SECONDS="${ROLLBACK_HEALTH_TIMEOUT_SECONDS:-$READINESS_TIMEOUT_SECONDS}"
CLEANUP_OVERHEAD_SECONDS="${CLEANUP_OVERHEAD_SECONDS:-300}"
DEPLOYMENT_OVERHEAD_SECONDS="${DEPLOYMENT_OVERHEAD_SECONDS:-900}"
DEPLOY_OUTER_TIMEOUT_SECONDS="${DEPLOY_OUTER_TIMEOUT_SECONDS:-10800}"
HEALTH_POLL_INTERVAL_SECONDS="${HEALTH_POLL_INTERVAL_SECONDS:-2}"
HEALTH_REQUEST_TIMEOUT_SECONDS="${HEALTH_REQUEST_TIMEOUT_SECONDS:-5}"
DEPLOY_LOCK_PATH="${DEPLOY_LOCK_PATH:-${APP_DIR}-deploy.lock}"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-${DEPLOY_LOCK_PATH}.flock}"
DEPLOY_INTENT_DIR="${DEPLOY_INTENT_DIR:-${DEPLOY_LOCK_PATH}.attempts}"
DIAGNOSTIC_DIR="${DEPLOY_DIAGNOSTIC_DIR:-${APP_DIR}-deploy-diagnostics}"
ARTIFACT_VOLUME_PREFIX="${ARTIFACT_VOLUME_PREFIX:-clashcookies-prod-artifact}"
ARTIFACT_IMAGE="${ARTIFACT_IMAGE:-node:20-bookworm}"

# Candidate preparation is deliberately isolated from the production runtime.
# These defaults are conservative policy, not a claim that every production
# host can safely compile on-host. Admission below must prove the host has the
# configured headroom before any candidate work starts.
DEPLOY_ATTEMPT_ID="${DEPLOY_ATTEMPT_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}}"
DEPLOY_RESOURCE_ADMISSION_FILE="${DEPLOY_RESOURCE_ADMISSION_FILE:-}"
DEPLOY_RESERVED_MEMORY_MIB="${DEPLOY_RESERVED_MEMORY_MIB:-1536}"
DEPLOY_CANDIDATE_MEMORY_LIMIT="${DEPLOY_CANDIDATE_MEMORY_LIMIT:-1024m}"
DEPLOY_CANDIDATE_MEMORY_RESERVATION="${DEPLOY_CANDIDATE_MEMORY_RESERVATION:-768m}"
DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT="${DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT:-1024m}"
DEPLOY_CANDIDATE_CPUS="${DEPLOY_CANDIDATE_CPUS:-1.0}"
DEPLOY_CANDIDATE_PIDS_LIMIT="${DEPLOY_CANDIDATE_PIDS_LIMIT:-512}"
DEPLOY_MIN_FREE_PIDS="${DEPLOY_MIN_FREE_PIDS:-1024}"
DEPLOY_MAX_HOST_SWAP_USED_PERCENT="${DEPLOY_MAX_HOST_SWAP_USED_PERCENT:-25}"
DEPLOY_MAX_HOST_LOAD_PER_CPU_PERCENT="${DEPLOY_MAX_HOST_LOAD_PER_CPU_PERCENT:-75}"
DEPLOY_HEALTH_DEGRADATION_FAILURES="${DEPLOY_HEALTH_DEGRADATION_FAILURES:-3}"
DEPLOY_CONTAINER_STOP_TIMEOUT_SECONDS="${DEPLOY_CONTAINER_STOP_TIMEOUT_SECONDS:-10}"
DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS="${DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS:-15}"
DEPLOY_CONTAINER_POLL_INTERVAL_SECONDS="${DEPLOY_CONTAINER_POLL_INTERVAL_SECONDS:-1}"
DEPLOY_OWNER_LABEL="clashcookies-deploy"
DEPLOY_ENVIRONMENT_LABEL="prod"

TEMP_WORKTREE_CREATED="0"
BUILD_VOLUMES_IN_USE="0"
BUILD_WORKSPACE_CREATED="0"
BUILD_NODE_MODULES_CREATED="0"
BUILD_DIST_CREATED="0"
ACTIVE_CONTAINER_ID=""
CANDIDATE_CONTAINER_ID=""
ARTIFACT_CONTAINER_ID=""
CANDIDATE_CONTAINER_ATTEMPT=""
CANDIDATE_CONTAINER_REVISION=""
CANDIDATE_CONTAINER_NAME=""
ARTIFACT_CONTAINER_ATTEMPT=""
ARTIFACT_CONTAINER_REVISION=""
ARTIFACT_CONTAINER_NAME=""
ARTIFACT_STAGE_COUNTER="0"
CURRENT_CONTAINER_ROLE=""
CURRENT_CONTAINER_LOG=""
CURRENT_CONTAINER_WAIT_FILE=""
CURRENT_CONTAINER_NAME=""
CURRENT_CONTAINER_INTENT=""
OLD_SHA=""
NEW_SHA=""
BUILD_NODE_MODULES_VOLUME=""
BUILD_DIST_VOLUME=""
ROLLBACK_NODE_MODULES_VOLUME=""
ROLLBACK_DIST_VOLUME=""
LOCK_HELD="0"
ARTIFACT_STAGE_DEADLINE="0"
INTERRUPTION_SIGNAL=""
EXIT_CLEANUP_FAILED="0"
LAST_CONTAINER_STATUS_KIND="success"
PRODUCTION_RUNTIME_MONITOR="1"

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

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

is_nonnegative_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

validate_deadline_configuration() {
  local name value required margin
  for name in \
    CANDIDATE_BUILD_TIMEOUT_SECONDS \
    ARTIFACT_STAGE_TIMEOUT_SECONDS \
    PROMOTION_HEALTH_TIMEOUT_SECONDS \
    ROLLBACK_HEALTH_TIMEOUT_SECONDS \
    CLEANUP_OVERHEAD_SECONDS \
    DEPLOYMENT_OVERHEAD_SECONDS \
    DEPLOY_OUTER_TIMEOUT_SECONDS; do
    value="${!name}"
    is_positive_integer "$value" || fatal "invalid_deadline_configuration name=${name} value=${value:-empty}"
  done

  # The failure path can consume candidate build, seven bounded artifact stages
  # (stamp/verify, rollback copy/stamp/verify, promotion verify, rollback
  # verify), both readiness gates, and the documented cleanup/control margin.
  required=$((
    CANDIDATE_BUILD_TIMEOUT_SECONDS +
    (ARTIFACT_STAGE_TIMEOUT_SECONDS * 7) +
    PROMOTION_HEALTH_TIMEOUT_SECONDS +
    ROLLBACK_HEALTH_TIMEOUT_SECONDS +
    CLEANUP_OVERHEAD_SECONDS +
    DEPLOYMENT_OVERHEAD_SECONDS
  ))
  margin=$((DEPLOY_OUTER_TIMEOUT_SECONDS - required))
  [ "$margin" -ge 0 ] || fatal "unsafe_deadline_configuration outer=${DEPLOY_OUTER_TIMEOUT_SECONDS} required=${required} margin=${margin}"
  log "deadline_budget_seconds=outer:${DEPLOY_OUTER_TIMEOUT_SECONDS} candidate:${CANDIDATE_BUILD_TIMEOUT_SECONDS} artifact_stage:${ARTIFACT_STAGE_TIMEOUT_SECONDS} promotion:${PROMOTION_HEALTH_TIMEOUT_SECONDS} rollback:${ROLLBACK_HEALTH_TIMEOUT_SECONDS} cleanup:${CLEANUP_OVERHEAD_SECONDS} overhead:${DEPLOYMENT_OVERHEAD_SECONDS} margin:${margin}"
}

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  timeout --foreground --signal=TERM --kill-after=5s "${timeout_seconds}s" "$@"
}

docker_bounded() {
  run_with_timeout "$DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS" docker "$@"
}

begin_artifact_stage() {
  ARTIFACT_STAGE_DEADLINE=$((SECONDS + ARTIFACT_STAGE_TIMEOUT_SECONDS))
}

resource_value() {
  local key="$1" cpu_count value path
  if [ -n "$DEPLOY_RESOURCE_ADMISSION_FILE" ]; then
    value="$(sed -n "s/^${key}=//p" "$DEPLOY_RESOURCE_ADMISSION_FILE" | head -n1)"
    [ -n "$value" ] || return 1
    printf '%s\n' "$value"
    return 0
  fi
  case "$key" in
    mem_available_mib)
      awk '/^MemAvailable:/ { printf "%d\n", $2 / 1024; exit }' /proc/meminfo
      ;;
    swap_total_mib)
      awk '/^SwapTotal:/ { printf "%d\n", $2 / 1024; exit }' /proc/meminfo
      ;;
    swap_free_mib)
      awk '/^SwapFree:/ { printf "%d\n", $2 / 1024; exit }' /proc/meminfo
      ;;
    load_per_cpu_percent)
      cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')"
      awk -v cpu="$cpu_count" 'NR == 1 { if (NF < 1) exit 1; if (cpu < 1) cpu = 1; printf "%d\n", ($1 * 100) / cpu; exit }' /proc/loadavg
      ;;
    host_pid_max)
      cat /proc/sys/kernel/pid_max
      ;;
    host_pid_count)
      find /proc -maxdepth 1 -type d -regextype posix-extended -regex '/proc/[0-9]+' | wc -l
      ;;
    cgroup_pids_max)
      for path in /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids/pids.max; do
        if [ -r "$path" ]; then cat "$path"; return 0; fi
      done
      return 1
      ;;
    cgroup_pids_current)
      for path in /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids/pids.current; do
        if [ -r "$path" ]; then cat "$path"; return 0; fi
      done
      return 1
      ;;
    cgroup_memory_max_mib)
      for path in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
        if [ -r "$path" ]; then
          value="$(cat "$path")"
          [ "$value" = max ] && { printf 'max\n'; return 0; }
          is_nonnegative_integer "$value" || return 1
          awk -v bytes="$value" 'BEGIN { printf "%d\n", bytes / 1048576 }'
          return 0
        fi
      done
      return 1
      ;;
    cgroup_memory_current_mib)
      for path in /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory/memory.usage_in_bytes; do
        if [ -r "$path" ]; then
          value="$(cat "$path")"
          is_nonnegative_integer "$value" || return 1
          awk -v bytes="$value" 'BEGIN { printf "%d\n", bytes / 1048576 }'
          return 0
        fi
      done
      return 1
      ;;
    *) return 1 ;;
  esac
}

memory_limit_bytes() {
  local value="$1" quantity suffix multiplier
  quantity="$value"
  suffix=""
  case "$value" in
    *[bBkKmMgGtT]) suffix="${value: -1}"; quantity="${value::-1}" ;;
  esac
  is_positive_integer "$quantity" || return 1
  case "${suffix,,}" in
    b) multiplier=1 ;;
    k) multiplier=1024 ;;
    m) multiplier=1048576 ;;
    g) multiplier=1073741824 ;;
    t) multiplier=1099511627776 ;;
    '') return 1 ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$((quantity * multiplier))"
}

memory_limit_mib() {
  local bytes
  bytes="$(memory_limit_bytes "$1")" || return 1
  [ $((bytes % 1048576)) -eq 0 ] || return 1
  printf '%s\n' "$((bytes / 1048576))"
}

validate_resource_configuration() {
  local name value memory_mib
  for name in DEPLOY_RESERVED_MEMORY_MIB DEPLOY_MIN_FREE_PIDS DEPLOY_MAX_HOST_SWAP_USED_PERCENT DEPLOY_MAX_HOST_LOAD_PER_CPU_PERCENT DEPLOY_HEALTH_DEGRADATION_FAILURES DEPLOY_CONTAINER_STOP_TIMEOUT_SECONDS DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS DEPLOY_CANDIDATE_PIDS_LIMIT; do
    value="${!name}"
    is_positive_integer "$value" || fatal "invalid_resource_configuration name=${name} value=${value:-empty}"
  done
  is_nonnegative_integer "$DEPLOY_CONTAINER_POLL_INTERVAL_SECONDS" || fatal "invalid_resource_configuration name=DEPLOY_CONTAINER_POLL_INTERVAL_SECONDS value=${DEPLOY_CONTAINER_POLL_INTERVAL_SECONDS:-empty}"
  for name in DEPLOY_CANDIDATE_MEMORY_LIMIT DEPLOY_CANDIDATE_MEMORY_RESERVATION DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT; do
    memory_mib="$(memory_limit_mib "${!name}")" || fatal "invalid_resource_configuration name=${name} value=${!name}"
    [ "$memory_mib" -gt 0 ] || fatal "invalid_resource_configuration name=${name} value=${!name}"
  done
  [ "$(memory_limit_mib "$DEPLOY_CANDIDATE_MEMORY_RESERVATION")" -le "$(memory_limit_mib "$DEPLOY_CANDIDATE_MEMORY_LIMIT")" ] || fatal "invalid_resource_configuration reservation_above_memory_limit"
  [ "$(memory_limit_mib "$DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT")" -ge "$(memory_limit_mib "$DEPLOY_CANDIDATE_MEMORY_LIMIT")" ] || fatal "invalid_resource_configuration swap_limit_below_memory_limit"
  awk -v cpus="$DEPLOY_CANDIDATE_CPUS" 'BEGIN { exit !(cpus ~ /^[0-9]+(\.[0-9]+)?$/ && cpus > 0) }' || fatal "invalid_resource_configuration name=DEPLOY_CANDIDATE_CPUS value=${DEPLOY_CANDIDATE_CPUS}"
}

assert_host_resource_admission() {
  local available swap_total swap_free swap_used_percent load_percent host_pid_max host_pid_count free_pids
  local cgroup_pids_max cgroup_pids_current cgroup_memory_max cgroup_memory_current candidate_mib required_mib
  available="$(resource_value mem_available_mib)" || fatal "resource_admission=denied reason=unavailable_meminfo"
  swap_total="$(resource_value swap_total_mib)" || fatal "resource_admission=denied reason=unavailable_swapinfo"
  swap_free="$(resource_value swap_free_mib)" || fatal "resource_admission=denied reason=unavailable_swapinfo"
  load_percent="$(resource_value load_per_cpu_percent)" || fatal "resource_admission=denied reason=unavailable_loadavg"
  host_pid_max="$(resource_value host_pid_max)" || fatal "resource_admission=denied reason=unavailable_pid_limit"
  host_pid_count="$(resource_value host_pid_count)" || fatal "resource_admission=denied reason=unavailable_pid_count"
  candidate_mib="$(memory_limit_mib "$DEPLOY_CANDIDATE_MEMORY_LIMIT")"
  required_mib=$((DEPLOY_RESERVED_MEMORY_MIB + candidate_mib))

  is_nonnegative_integer "${available:-}" || fatal "resource_admission=denied reason=unavailable_meminfo"
  is_nonnegative_integer "${load_percent:-}" || fatal "resource_admission=denied reason=unavailable_loadavg"
  is_positive_integer "${host_pid_max:-}" || fatal "resource_admission=denied reason=invalid_pid_limit"
  is_nonnegative_integer "${host_pid_count:-}" || fatal "resource_admission=denied reason=invalid_pid_count"
  [ "$host_pid_count" -le "$host_pid_max" ] || fatal "resource_admission=denied reason=contradictory_pid_measurements"
  free_pids=$((host_pid_max - host_pid_count))
  if [ "$swap_total" -gt 0 ]; then
    is_nonnegative_integer "${swap_free:-}" || fatal "resource_admission=denied reason=unavailable_swapinfo"
    [ "$swap_free" -le "$swap_total" ] || fatal "resource_admission=denied reason=contradictory_swap_measurements"
    swap_used_percent=$(( (swap_total - swap_free) * 100 / swap_total ))
  else
    [ "$swap_free" -eq 0 ] || fatal "resource_admission=denied reason=contradictory_swap_measurements"
    swap_used_percent=0
  fi

  if cgroup_pids_max="$(resource_value cgroup_pids_max 2>/dev/null)"; then
    [ "$cgroup_pids_max" = max ] || is_positive_integer "$cgroup_pids_max" || fatal "resource_admission=denied reason=invalid_cgroup_pid_limit"
    cgroup_pids_current="$(resource_value cgroup_pids_current)" || fatal "resource_admission=denied reason=unavailable_cgroup_pid_count"
    is_nonnegative_integer "$cgroup_pids_current" || fatal "resource_admission=denied reason=invalid_cgroup_pid_count"
    if [ "$cgroup_pids_max" != max ]; then
      [ "$cgroup_pids_current" -le "$cgroup_pids_max" ] || fatal "resource_admission=denied reason=contradictory_cgroup_pid_measurements"
      [ $((cgroup_pids_max - cgroup_pids_current)) -lt "$free_pids" ] && free_pids=$((cgroup_pids_max - cgroup_pids_current))
    fi
  fi
  if cgroup_memory_max="$(resource_value cgroup_memory_max_mib 2>/dev/null)"; then
    [ "$cgroup_memory_max" = max ] || is_nonnegative_integer "$cgroup_memory_max" || fatal "resource_admission=denied reason=invalid_cgroup_memory_limit"
    cgroup_memory_current="$(resource_value cgroup_memory_current_mib)" || fatal "resource_admission=denied reason=unavailable_cgroup_memory_current"
    is_nonnegative_integer "$cgroup_memory_current" || fatal "resource_admission=denied reason=invalid_cgroup_memory_current"
    if [ "$cgroup_memory_max" != max ]; then
      [ "$cgroup_memory_current" -le "$cgroup_memory_max" ] || fatal "resource_admission=denied reason=contradictory_cgroup_memory_measurements"
      [ "$cgroup_memory_max" - $cgroup_memory_current -lt "$required_mib" ] && fatal "resource_admission=denied reason=insufficient_cgroup_memory available_mib=$((cgroup_memory_max - cgroup_memory_current)) required_mib=${required_mib}"
    fi
  fi

  log "resource_admission=observed attempt=${DEPLOY_ATTEMPT_ID} available_memory_mib=${available} reserved_memory_mib=${DEPLOY_RESERVED_MEMORY_MIB} candidate_memory_limit=${DEPLOY_CANDIDATE_MEMORY_LIMIT} swap_used_percent=${swap_used_percent} load_per_cpu_percent=${load_percent} free_pids=${free_pids}"
  if [ "$available" -lt "$required_mib" ]; then
    fatal "resource_admission=denied reason=insufficient_memory available_mib=${available} required_mib=${required_mib} reserved_mib=${DEPLOY_RESERVED_MEMORY_MIB} candidate_limit_mib=${candidate_mib}"
  fi
  if [ "$swap_used_percent" -gt "$DEPLOY_MAX_HOST_SWAP_USED_PERCENT" ]; then
    fatal "resource_admission=denied reason=swap_pressure used_percent=${swap_used_percent} max_percent=${DEPLOY_MAX_HOST_SWAP_USED_PERCENT}"
  fi
  if [ "$load_percent" -gt "$DEPLOY_MAX_HOST_LOAD_PER_CPU_PERCENT" ]; then
    fatal "resource_admission=denied reason=host_load load_per_cpu_percent=${load_percent} max_percent=${DEPLOY_MAX_HOST_LOAD_PER_CPU_PERCENT}"
  fi
  if [ "$free_pids" -lt "$DEPLOY_MIN_FREE_PIDS" ]; then
    fatal "resource_admission=denied reason=pid_pressure free_pids=${free_pids} min_free_pids=${DEPLOY_MIN_FREE_PIDS}"
  fi
  log "resource_admission=approved attempt=${DEPLOY_ATTEMPT_ID} policy=reserved_memory_${DEPLOY_RESERVED_MEMORY_MIB}m_candidate_memory_${candidate_mib}m_no_candidate_swap_cpus_${DEPLOY_CANDIDATE_CPUS}_pids_${DEPLOY_CANDIDATE_PIDS_LIMIT}"
}

container_identity() {
  local container_id="$1" metadata
  metadata="$(docker_bounded inspect --format '{{.Name}}|{{index .Config.Labels "com.clashcookies.deploy"}}|{{index .Config.Labels "com.clashcookies.deploy.owner"}}|{{index .Config.Labels "com.clashcookies.deploy.environment"}}|{{index .Config.Labels "com.clashcookies.deploy.role"}}|{{index .Config.Labels "com.clashcookies.deploy.attempt"}}|{{index .Config.Labels "com.clashcookies.deploy.revision"}}' "$container_id" 2>/dev/null)" || return 2
  printf '%s\n' "${metadata#/}"
}

container_identity_matches() {
  local container_id="$1" expected_role="$2" expected_attempt="$3" expected_revision="$4" expected_name="$5"
  local name deploy owner environment role attempt revision metadata
  metadata="$(container_identity "$container_id")" || return 2
  IFS='|' read -r name deploy owner environment role attempt revision <<< "$metadata"
  [ -z "$expected_name" ] || [ "$name" = "$expected_name" ] || return 1
  [ "$deploy" = "$([ "$expected_role" = candidate-build ] && printf candidate-build-only || printf artifact-stage)" ] || return 1
  [ "$owner" = "$DEPLOY_OWNER_LABEL" ] || return 1
  [ "$environment" = "$DEPLOY_ENVIRONMENT_LABEL" ] || return 1
  [ "$role" = "$expected_role" ] || return 1
  [ "$attempt" = "$expected_attempt" ] || return 1
  [ "$revision" = "$expected_revision" ] || return 1
}

container_is_running() {
  local state
  state="$(docker_bounded inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" || return 2
  [ "$state" = true ]
}

assert_container_limits() {
  local container_id="$1" observed expected_memory expected_reservation expected_swap expected_cpu expected_pids
  expected_memory="$(memory_limit_bytes "$DEPLOY_CANDIDATE_MEMORY_LIMIT")"
  expected_reservation="$(memory_limit_bytes "$DEPLOY_CANDIDATE_MEMORY_RESERVATION")"
  expected_swap="$(memory_limit_bytes "$DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT")"
  expected_cpu="$(awk -v cpus="$DEPLOY_CANDIDATE_CPUS" 'BEGIN { printf "%.0f", cpus * 1000000000 }')"
  observed="$(docker_bounded inspect --format '{{.HostConfig.Memory}}|{{.HostConfig.MemoryReservation}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.PidsLimit}}' "$container_id" 2>/dev/null)" || {
    log "container_limits=failed reason=inspection_unknown container=${container_id}" >&2
    return 1
  }
  [ "$observed" = "${expected_memory}|${expected_reservation}|${expected_swap}|${expected_cpu}|${DEPLOY_CANDIDATE_PIDS_LIMIT}" ] || {
    log "container_limits=failed reason=restriction_not_enforced container=${container_id} observed=${observed} expected=${expected_memory}|${expected_reservation}|${expected_swap}|${expected_cpu}|${DEPLOY_CANDIDATE_PIDS_LIMIT}" >&2
    return 1
  }
}

terminate_owned_container() {
  local container_id="$1" role="$2" reason="${3:-cleanup}" expected_attempt="${4:-}" expected_revision="${5:-}" expected_name="${6:-}"
  local operation_status=0 running_status records
  expected_attempt="${expected_attempt:-$DEPLOY_ATTEMPT_ID}"
  expected_revision="${expected_revision:-$NEW_SHA}"
  expected_name="${expected_name:-}"
  if ! container_identity_matches "$container_id" "$role" "$expected_attempt" "$expected_revision" "$expected_name"; then
    log "container_cleanup=refused reason=ownership_verification_failed role=${role} container=${container_id} cleanup_reason=${reason}" >&2
    return 1
  fi
  log "container_cleanup=start attempt=${expected_attempt} role=${role} container=${container_id} reason=${reason}"
  if container_is_running "$container_id"; then running_status=0; else running_status=$?; fi
  [ "$running_status" -ne 2 ] || { log "container_cleanup=failed reason=inspection_unknown role=${role} container=${container_id}" >&2; return 1; }
  if [ "$running_status" -eq 0 ]; then
    docker_bounded stop --time "$DEPLOY_CONTAINER_STOP_TIMEOUT_SECONDS" "$container_id" >/dev/null 2>&1 || operation_status=$?
    if container_is_running "$container_id"; then running_status=0; else running_status=$?; fi
    [ "$running_status" -ne 2 ] || { log "container_cleanup=failed reason=inspection_unknown_after_stop role=${role} container=${container_id}" >&2; return 1; }
    if [ "$running_status" -eq 0 ]; then
      docker_bounded kill "$container_id" >/dev/null 2>&1 || operation_status=$?
    fi
  fi
  if container_is_running "$container_id"; then running_status=0; else running_status=$?; fi
  [ "$running_status" -ne 2 ] || { log "container_cleanup=failed reason=inspection_unknown_before_remove role=${role} container=${container_id}" >&2; return 1; }
  [ "$running_status" -ne 0 ] || { log "container_cleanup=failed reason=container_still_running role=${role} container=${container_id}" >&2; return 1; }
  docker_bounded rm "$container_id" >/dev/null 2>&1 || operation_status=$?
  records="$(docker_bounded ps -aq --filter "id=${container_id}" 2>/dev/null)" || { log "container_cleanup=failed reason=removal_verification_unknown role=${role} container=${container_id}" >&2; return 1; }
  [ -z "$records" ] || { log "container_cleanup=failed reason=container_remains role=${role} container=${container_id}" >&2; return 1; }
  [ "$operation_status" -eq 0 ] || { log "container_cleanup=failed reason=bounded_operation_status status=${operation_status} role=${role} container=${container_id}" >&2; return 1; }
  log "container_cleanup=verified attempt=${expected_attempt} role=${role} revision=${expected_revision} name=${expected_name:-unknown} container=${container_id} reason=${reason}"
}

reap_waiter_after_containment() {
  local waiter_pid="$1"
  kill -KILL "$waiter_pid" >/dev/null 2>&1 || true
  wait "$waiter_pid" >/dev/null 2>&1 || true
  log "container_waiter=reaped pid=${waiter_pid}"
}

intent_field() { sed -n "s/^$2=//p" "$1" | head -n1; }

write_container_intent() {
  local file="$1" name="$2" role="$3" revision="$4" tmp
  tmp="${file}.tmp.$$"
  printf 'name=%s\nrole=%s\nattempt=%s\nrevision=%s\nowner=%s\nenvironment=%s\ndeploy=%s\n' \
    "$name" "$role" "$DEPLOY_ATTEMPT_ID" "$revision" "$DEPLOY_OWNER_LABEL" "$DEPLOY_ENVIRONMENT_LABEL" \
    "$([ "$role" = candidate-build ] && printf candidate-build-only || printf artifact-stage)" > "$tmp"
  mv -- "$tmp" "$file"
}

reconcile_container_intent() {
  local intent="$1" name role attempt revision container_ids container_id count
  name="$(intent_field "$intent" name)"; role="$(intent_field "$intent" role)"; attempt="$(intent_field "$intent" attempt)"; revision="$(intent_field "$intent" revision)"
  [ -n "$name" ] && [ -n "$role" ] && [ -n "$attempt" ] && [ -n "$revision" ] || fatal "owned_resource_reconciliation=denied reason=malformed_container_intent file=${intent}"
  case "$role" in candidate-build|artifact-stage) ;; *) fatal "owned_resource_reconciliation=denied reason=ambiguous_container_intent file=${intent}" ;; esac
  container_ids="$(docker_bounded ps -aq --filter "name=^/${name}$" 2>/dev/null)" || fatal "owned_resource_reconciliation=failed reason=container_enumeration_unknown name=${name}"
  count="$(printf '%s\n' "$container_ids" | sed '/^$/d' | wc -l)"
  if [ "$count" -eq 0 ]; then rm -f -- "$intent"; return 0; fi
  [ "$count" -eq 1 ] || fatal "owned_resource_reconciliation=denied reason=ambiguous_container_name name=${name}"
  container_id="$(printf '%s\n' "$container_ids" | sed -n '1p')"
  container_identity_matches "$container_id" "$role" "$attempt" "$revision" "$name" || fatal "owned_resource_reconciliation=denied reason=container_identity_mismatch container=${container_id} name=${name}"
  terminate_owned_container "$container_id" "$role" intent-recovery "$attempt" "$revision" "$name" || fatal "owned_resource_reconciliation=failed reason=container_cleanup container=${container_id} operator_intervention_required"
  rm -f -- "$intent"
}

reconcile_container_intents() {
  local intent
  for intent in "$DEPLOY_INTENT_DIR"/*.intent; do
    [ -f "$intent" ] || continue
    reconcile_container_intent "$intent"
  done
}

reconcile_abandoned_owned_containers() {
  local records record container_id name deploy owner environment role attempt revision
  records="$(docker_bounded ps -a --format '{{.ID}}|{{.Names}}|{{.Label "com.clashcookies.deploy"}}|{{.Label "com.clashcookies.deploy.owner"}}|{{.Label "com.clashcookies.deploy.environment"}}|{{.Label "com.clashcookies.deploy.role"}}|{{.Label "com.clashcookies.deploy.attempt"}}|{{.Label "com.clashcookies.deploy.revision"}}' 2>/dev/null)" || fatal "owned_resource_reconciliation=failed reason=container_enumeration_unknown"
  while IFS='|' read -r container_id name deploy owner environment role attempt revision; do
    [ -n "$container_id" ] || continue
    if { [ "$name" = "$BUILD_CONTAINER" ] || [[ "$name" = "$BUILD_CONTAINER"-* && "$name" != "$BUILD_CONTAINER-artifact-"* ]]; } && { [ "$owner" != "$DEPLOY_OWNER_LABEL" ] || [ "$environment" != "$DEPLOY_ENVIRONMENT_LABEL" ] || [ "$role" != candidate-build ] || [ "$deploy" != candidate-build-only ] || [ -z "$attempt" ] || [ -z "$revision" ]; }; then
      fatal "owned_resource_reconciliation=denied reason=legacy_candidate_ambiguous container=${container_id} name=${name}"
    fi
    if [ "$owner" = "$DEPLOY_OWNER_LABEL" ] || [[ "$name" = "$BUILD_CONTAINER"-* ]]; then
      [ "$owner" = "$DEPLOY_OWNER_LABEL" ] && [ "$environment" = "$DEPLOY_ENVIRONMENT_LABEL" ] && [ "$role" = candidate-build -o "$role" = artifact-stage ] && [ "$deploy" = candidate-build-only -o "$deploy" = artifact-stage ] && [ -n "$attempt" ] && [ -n "$revision" ] || fatal "owned_resource_reconciliation=denied reason=ambiguous_container container=${container_id} name=${name}"
      log "owned_resource_reconciliation=abandoned_container attempt=${attempt} role=${role} name=${name} id=${container_id}"
      terminate_owned_container "$container_id" "$role" abandoned "$attempt" "$revision" "$name" || fatal "owned_resource_reconciliation=failed reason=container_cleanup container=${container_id} operator_intervention_required"
    fi
  done <<< "$records"
}

reconcile_abandoned_owned_volumes() {
  local volumes volume labels deploy owner environment revision role attached
  volumes="$(docker_bounded volume ls -q 2>/dev/null)" || fatal "owned_resource_reconciliation=failed reason=volume_enumeration_unknown"
  while IFS= read -r volume; do
    [ -n "$volume" ] || continue
    case "$volume" in
      "$ARTIFACT_VOLUME_PREFIX"-*|clashcookies-prod-build-*) ;;
      *) continue ;;
    esac
    labels="$(docker_bounded volume inspect --format '{{index .Labels "com.clashcookies.deploy"}}|{{index .Labels "com.clashcookies.deploy.owner"}}|{{index .Labels "com.clashcookies.deploy.environment"}}|{{index .Labels "com.clashcookies.revision"}}|{{index .Labels "com.clashcookies.role"}}|{{index .Labels "com.clashcookies.deploy.attempt"}}' "$volume" 2>/dev/null)" || fatal "owned_resource_reconciliation=failed reason=volume_inspection_unknown volume=${volume}"
    IFS='|' read -r deploy owner environment revision role attempt <<< "$labels"
    [ "$owner" = "$DEPLOY_OWNER_LABEL" ] && [ "$environment" = "$DEPLOY_ENVIRONMENT_LABEL" ] && [ -n "$deploy" ] && [ -n "$revision" ] && [ -n "$role" ] && [ -n "$attempt" ] || fatal "owned_resource_reconciliation=denied reason=ambiguous_volume volume=${volume}"
    attached="$(docker_bounded ps -a --filter "volume=${volume}" --format '{{.Names}}')" || fatal "owned_resource_reconciliation=failed reason=volume_reference_check volume=${volume}"
    if [ -n "$attached" ]; then
      [ "$attached" = "$NORMAL_CONTAINER" ] || fatal "owned_resource_reconciliation=denied reason=volume_attached_unknown volume=${volume} containers=${attached} operator_intervention_required"
      log "owned_resource_reconciliation=preserved_active_volume volume=${volume} revision=${revision} role=${role}"
      continue
    fi
    case "$role" in
      rollback-dist|rollback-node-modules) log "owned_resource_reconciliation=preserved_rollback_volume volume=${volume} revision=${revision} role=${role}" ;;
      build-workspace|release-dist|release-node-modules|artifact-stage)
        docker_bounded volume rm "$volume" >/dev/null 2>&1 || fatal "owned_resource_reconciliation=failed reason=volume_cleanup volume=${volume} revision=${revision} role=${role} operator_intervention_required"
        log "owned_resource_reconciliation=removed_volume volume=${volume} revision=${revision} role=${role}" ;;
      *) fatal "owned_resource_reconciliation=denied reason=ambiguous_volume_role volume=${volume} role=${role}" ;;
    esac
  done <<< "$volumes"
}

reconcile_abandoned_resources() {
  reconcile_container_intents
  reconcile_abandoned_owned_containers
  reconcile_abandoned_owned_volumes
  log "owned_resource_reconciliation=complete attempt=${DEPLOY_ATTEMPT_ID}"
}

probe_production_health() {
  curl --fail --silent --show-error --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
    "http://127.0.0.1:${NORMAL_PORT}/healthz" >/dev/null 2>&1
}

assert_production_health_ready() {
  probe_production_health || fatal "resource_admission=denied reason=production_health_unavailable"
  log "resource_admission=health_approved container=${NORMAL_CONTAINER} port=${NORMAL_PORT}"
}

candidate_container_name() {
  printf '%s-%s' "$BUILD_CONTAINER" "$DEPLOY_ATTEMPT_ID"
}

artifact_container_name() {
  printf '%s-artifact-%s-%s' "$BUILD_CONTAINER" "$DEPLOY_ATTEMPT_ID" "$ARTIFACT_STAGE_COUNTER"
}

run_owned_container() {
  local timeout_seconds="$1"
  local role="$2"
  local log_file="$3"
  local monitor_health="$4"
  shift 4
  local container_name container_id wait_file wait_pid wait_status exit_status elapsed start_seconds health_failures=0 timed_out=0 health_abort=0 deploy_kind
  local stage_deadline remaining create_status diagnostics_status container_revision argument
  local -a run_args=("$@")
  container_revision="$NEW_SHA"
  for argument in "${run_args[@]}"; do
    case "$argument" in
      BUILD_SHA=*) container_revision="${argument#*=}" ;;
      EXPECTED_BUILD_SHA=*) container_revision="${argument#*=}" ;;
    esac
  done
  if [ "$role" = "candidate-build" ]; then
    container_name="$(candidate_container_name)"
  else
    ARTIFACT_STAGE_COUNTER=$((ARTIFACT_STAGE_COUNTER + 1))
    container_name="$(artifact_container_name)"
  fi
  deploy_kind="$( [ "$role" = "candidate-build" ] && printf '%s' candidate-build-only || printf '%s' artifact-stage )"
  wait_file="${log_file}.wait"
  CURRENT_CONTAINER_NAME="$container_name"
  CURRENT_CONTAINER_INTENT="${DEPLOY_INTENT_DIR}/${DEPLOY_ATTEMPT_ID}.${role}.${ARTIFACT_STAGE_COUNTER}.intent"
  CURRENT_CONTAINER_ROLE="$role"
  CURRENT_CONTAINER_LOG="$log_file"
  CURRENT_CONTAINER_WAIT_FILE="$wait_file"
  : > "$wait_file"
  write_container_intent "$CURRENT_CONTAINER_INTENT" "$container_name" "$role" "$container_revision"
  stage_deadline=$((SECONDS + timeout_seconds))
  remaining="$timeout_seconds"
  if container_id="$(run_with_timeout "$remaining" docker run -d \
    --name "$container_name" \
    --label "com.clashcookies.deploy=${deploy_kind}" \
    --label "com.clashcookies.deploy.owner=${DEPLOY_OWNER_LABEL}" \
    --label "com.clashcookies.deploy.environment=${DEPLOY_ENVIRONMENT_LABEL}" \
    --label "com.clashcookies.deploy.role=${role}" \
    --label "com.clashcookies.deploy.attempt=${DEPLOY_ATTEMPT_ID}" \
    --label "com.clashcookies.deploy.revision=${container_revision}" \
    --init \
    --memory "$DEPLOY_CANDIDATE_MEMORY_LIMIT" \
    --memory-reservation "$DEPLOY_CANDIDATE_MEMORY_RESERVATION" \
    --memory-swap "$DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT" \
    --cpus "$DEPLOY_CANDIDATE_CPUS" \
    --pids-limit "$DEPLOY_CANDIDATE_PIDS_LIMIT" \
    "${run_args[@]}")"; then
    :
  else
    create_status=$?
    reconcile_container_intent "$CURRENT_CONTAINER_INTENT"
    return "$create_status"
  fi
  [ -n "$container_id" ] || { reconcile_container_intent "$CURRENT_CONTAINER_INTENT"; return 1; }
  if [ "$role" = "candidate-build" ]; then
    CANDIDATE_CONTAINER_ID="$container_id"
    CANDIDATE_CONTAINER_ATTEMPT="$DEPLOY_ATTEMPT_ID"
    CANDIDATE_CONTAINER_REVISION="$container_revision"
    CANDIDATE_CONTAINER_NAME="$container_name"
  else
    ARTIFACT_CONTAINER_ID="$container_id"
    ARTIFACT_CONTAINER_ATTEMPT="$DEPLOY_ATTEMPT_ID"
    ARTIFACT_CONTAINER_REVISION="$container_revision"
    ARTIFACT_CONTAINER_NAME="$container_name"
  fi
  assert_container_limits "$container_id" || {
    if terminate_owned_container "$container_id" "$role" unenforceable_limits "$DEPLOY_ATTEMPT_ID" "$container_revision" "$container_name"; then
      if [ "$role" = "candidate-build" ]; then
        CANDIDATE_CONTAINER_ID=""
        CANDIDATE_CONTAINER_ATTEMPT=""
        CANDIDATE_CONTAINER_REVISION=""
        CANDIDATE_CONTAINER_NAME=""
      else
        ARTIFACT_CONTAINER_ID=""
        ARTIFACT_CONTAINER_ATTEMPT=""
        ARTIFACT_CONTAINER_REVISION=""
        ARTIFACT_CONTAINER_NAME=""
      fi
      rm -f -- "$CURRENT_CONTAINER_INTENT"
    fi
    return 125
  }
  rm -f -- "$CURRENT_CONTAINER_INTENT"
  log "container_started attempt=${DEPLOY_ATTEMPT_ID} role=${role} name=${container_name} id=${container_id} timeout_seconds=${timeout_seconds} memory=${DEPLOY_CANDIDATE_MEMORY_LIMIT} memory_swap=${DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT} cpus=${DEPLOY_CANDIDATE_CPUS} pids=${DEPLOY_CANDIDATE_PIDS_LIMIT}"
  (
    trap '' TERM INT HUP
    set +e
    wait_output="$(run_with_timeout "$timeout_seconds" docker wait "$container_id" 2>>"$log_file")"
    wait_status=$?
    printf 'client_status=%s\ncontainer_exit=%s\n' "$wait_status" "${wait_output##*$'\n'}" >"$wait_file"
  ) &
  wait_pid=$!
  start_seconds="$SECONDS"
  elapsed=0
  while [ ! -s "$wait_file" ] && kill -0 "$wait_pid" 2>/dev/null; do
    remaining=$((stage_deadline - SECONDS))
    [ "$remaining" -gt 0 ] || { timed_out=1; break; }
    if [ "$elapsed" -ge "$timeout_seconds" ]; then timed_out=1; break; fi
    if [ "$monitor_health" = "1" ] && [ "$PRODUCTION_RUNTIME_MONITOR" = "1" ]; then
      if probe_production_health; then
        health_failures=0
      else
        health_failures=$((health_failures + 1))
        log "production_health_monitor=failed attempt=${DEPLOY_ATTEMPT_ID} role=${role} consecutive_failures=${health_failures}"
        if [ "$health_failures" -ge "$DEPLOY_HEALTH_DEGRADATION_FAILURES" ]; then
          health_abort=1
          break
        fi
      fi
    fi
    sleep "$DEPLOY_CONTAINER_POLL_INTERVAL_SECONDS"
    elapsed=$((SECONDS - start_seconds))
  done
  if [ "$timed_out" = "1" ] || [ "$health_abort" = "1" ]; then
    if [ "$health_abort" = "1" ]; then
      log "container_abort=health_degradation attempt=${DEPLOY_ATTEMPT_ID} role=${role} container=${container_id}" >&2
      terminate_owned_container "$container_id" "$role" health_degradation "$DEPLOY_ATTEMPT_ID" "$container_revision" "$container_name" || {
        reap_waiter_after_containment "$wait_pid"
        return 125
      }
      reap_waiter_after_containment "$wait_pid"
      if [ "$role" = "candidate-build" ]; then
        CANDIDATE_CONTAINER_ID=""
        CANDIDATE_CONTAINER_ATTEMPT=""
        CANDIDATE_CONTAINER_REVISION=""
        CANDIDATE_CONTAINER_NAME=""
      else
        ARTIFACT_CONTAINER_ID=""
        ARTIFACT_CONTAINER_ATTEMPT=""
        ARTIFACT_CONTAINER_REVISION=""
        ARTIFACT_CONTAINER_NAME=""
      fi
      LAST_CONTAINER_STATUS_KIND=wrapper_abort
      return 125
    fi
    log "container_abort=deadline attempt=${DEPLOY_ATTEMPT_ID} role=${role} container=${container_id} timeout_seconds=${timeout_seconds}" >&2
    terminate_owned_container "$container_id" "$role" deadline "$DEPLOY_ATTEMPT_ID" "$container_revision" "$container_name" || {
      reap_waiter_after_containment "$wait_pid"
      return 125
    }
    reap_waiter_after_containment "$wait_pid"
    if [ "$role" = "candidate-build" ]; then
      CANDIDATE_CONTAINER_ID=""
      CANDIDATE_CONTAINER_ATTEMPT=""
      CANDIDATE_CONTAINER_REVISION=""
      CANDIDATE_CONTAINER_NAME=""
    else
      ARTIFACT_CONTAINER_ID=""
      ARTIFACT_CONTAINER_ATTEMPT=""
      ARTIFACT_CONTAINER_REVISION=""
      ARTIFACT_CONTAINER_NAME=""
    fi
    LAST_CONTAINER_STATUS_KIND="wrapper_deadline"
    return 124
  fi
  wait "$wait_pid" >/dev/null 2>&1 || true
  log "container_waiter=reaped pid=${wait_pid}"
  wait_status="$(sed -n 's/^client_status=//p' "$wait_file" | head -n1)"
  exit_status="$(sed -n 's/^container_exit=//p' "$wait_file" | head -n1)"
  wait_status="${wait_status:-125}"
  [ -n "$exit_status" ] || exit_status=125
  diagnostics_status=0
  docker_bounded inspect --format 'status={{.State.Status}} exit_status={{.State.ExitCode}}' "$container_id" >>"$log_file" 2>&1 || diagnostics_status=1
  docker_bounded logs --tail 400 "$container_id" >>"$log_file" 2>&1 || diagnostics_status=1
  if [ "$wait_status" -eq 124 ]; then
    log "container_abort=deadline attempt=${DEPLOY_ATTEMPT_ID} role=${role} container=${container_id} timeout_seconds=${timeout_seconds}" >&2
    terminate_owned_container "$container_id" "$role" deadline "$DEPLOY_ATTEMPT_ID" "$container_revision" "$container_name" || return 125
    if [ "$role" = "candidate-build" ]; then
      CANDIDATE_CONTAINER_ID=""
      CANDIDATE_CONTAINER_ATTEMPT=""
      CANDIDATE_CONTAINER_REVISION=""
      CANDIDATE_CONTAINER_NAME=""
    else
      ARTIFACT_CONTAINER_ID=""
      ARTIFACT_CONTAINER_ATTEMPT=""
      ARTIFACT_CONTAINER_REVISION=""
      ARTIFACT_CONTAINER_NAME=""
    fi
    LAST_CONTAINER_STATUS_KIND="wrapper_deadline"
    return 124
  fi
  if ! terminate_owned_container "$container_id" "$role" completed "$DEPLOY_ATTEMPT_ID" "$container_revision" "$container_name"; then return 125; fi
  if [ "$role" = "candidate-build" ]; then
    CANDIDATE_CONTAINER_ID=""
    CANDIDATE_CONTAINER_ATTEMPT=""
    CANDIDATE_CONTAINER_REVISION=""
    CANDIDATE_CONTAINER_NAME=""
  else
    ARTIFACT_CONTAINER_ID=""
    ARTIFACT_CONTAINER_ATTEMPT=""
    ARTIFACT_CONTAINER_REVISION=""
    ARTIFACT_CONTAINER_NAME=""
  fi
  rm -f -- "$CURRENT_CONTAINER_INTENT"
  [ "$diagnostics_status" -eq 0 ] || return 125
  [ "$wait_status" -eq 0 ] || { LAST_CONTAINER_STATUS_KIND=wrapper_status; return "$wait_status"; }
  [ "$exit_status" = "0" ] || { LAST_CONTAINER_STATUS_KIND=observed_exit; log "container_exit=observed attempt=${DEPLOY_ATTEMPT_ID} role=${role} container=${container_id} exit=${exit_status}"; return "$exit_status"; }
  LAST_CONTAINER_STATUS_KIND=success
  return 0
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
}

reconcile_abandoned_worktree() {
  local worktrees
  if [ ! -e "$TEMP_WORKTREE" ] && [ ! -L "$TEMP_WORKTREE" ]; then return 0; fi
  [ ! -L "$TEMP_WORKTREE" ] || fatal "refusing_symlinked_temp_worktree=${TEMP_WORKTREE}"
  worktrees="$(git_safe worktree list --porcelain)" || fatal "abandoned_worktree_query_failed=${TEMP_WORKTREE}"
  printf '%s\n' "$worktrees" | grep -Fqx "worktree ${TEMP_WORKTREE}" || fatal "refusing_unregistered_temp_worktree=${TEMP_WORKTREE}"
  run_with_timeout "$DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS" git -c "safe.directory=${APP_DIR}" -C "$APP_DIR" worktree remove "$TEMP_WORKTREE" || fatal "abandoned_worktree_cleanup_failed=${TEMP_WORKTREE}"
  [ ! -e "$TEMP_WORKTREE" ] && [ ! -L "$TEMP_WORKTREE" ] || fatal "abandoned_worktree_remains=${TEMP_WORKTREE}"
  log "abandoned_worktree=reconciled path=${TEMP_WORKTREE}"
}

assert_runtime_environment_source() {
  require_file "$RUNTIME_ENV_FILE"
  [ ! -L "$RUNTIME_ENV_FILE" ] || fatal "runtime_environment_symlinked"
}

validate_private_directory() {
  local path="$1"
  local owner mode current_uid
  current_uid="$(id -u)"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -d "$path" ] || fatal "private_directory_not_directory=${path}"
    [ ! -L "$path" ] || fatal "private_directory_symlinked=${path}"
    owner="$(stat -c '%u' "$path")"
    mode="$(stat -c '%a' "$path")"
    [ "$owner" = "$current_uid" ] || fatal "private_directory_owner_invalid=${path}"
    [ "$mode" = "700" ] || fatal "private_directory_mode_invalid=${path}"
  else
    mkdir -m 700 -- "$path"
  fi
}

prepare_private_file() {
  local path="$1"
  local owner mode current_uid
  current_uid="$(id -u)"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] || fatal "private_file_not_regular=${path}"
    [ ! -L "$path" ] || fatal "private_file_symlinked=${path}"
    owner="$(stat -c '%u' "$path")"
    mode="$(stat -c '%a' "$path")"
    [ "$owner" = "$current_uid" ] || fatal "private_file_owner_invalid=${path}"
    [ "$mode" = "600" ] || fatal "private_file_mode_invalid=${path}"
  else
    : > "$path"
    chmod 600 -- "$path"
  fi
}

prepare_diagnostic_directory() {
  validate_private_directory "$DIAGNOSTIC_DIR"
  prepare_private_file "${DIAGNOSTIC_DIR}/candidate-build.log"
  prepare_private_file "${DIAGNOSTIC_DIR}/promotion.state"
  prepare_private_file "${DIAGNOSTIC_DIR}/promotion.log"
  prepare_private_file "${DIAGNOSTIC_DIR}/rollback.state"
  prepare_private_file "${DIAGNOSTIC_DIR}/rollback.log"
  prepare_private_file "${DIAGNOSTIC_DIR}/downtime.state"
  prepare_private_file "${DIAGNOSTIC_DIR}/downtime.log"
  prepare_private_file "${DIAGNOSTIC_DIR}/attempt.state"
}

list_active_runtime_names() {
  local records
  records="$(docker_bounded ps --format '{{.Names}}|{{.Ports}}|{{.Label "com.clashcookies.runtime"}}|{{.Image}}|{{.Command}}')" || return 2
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
  done <<< "$records"
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

artifact_volume_name() {
  local revision="$1"
  local kind="$2"
  printf '%s-%s-%s' "$ARTIFACT_VOLUME_PREFIX" "$revision" "$kind"
}

assert_volume_detached() {
  local volume="$1"
  local attached
  attached="$(docker_bounded ps -a --filter "volume=${volume}" --format '{{.Names}}')"
  [ -z "$attached" ] || fatal "artifact_volume_attached volume=${volume} containers=${attached}"
}

volume_exists_or_missing() {
  local volume="$1" inspect_status
  if docker_bounded volume inspect "$volume" >/dev/null 2>&1; then
    return 0
  else
    inspect_status=$?
  fi
  [ "$inspect_status" -eq 1 ] && return 1
  log "volume_query=unknown volume=${volume} status=${inspect_status}" >&2
  return 2
}

artifact_volume_has_labels() {
  local volume="$1"
  local revision="$2"
  local role="$3"
  local labels
  labels="$(docker_bounded volume inspect --format '{{index .Labels "com.clashcookies.deploy"}}|{{index .Labels "com.clashcookies.deploy.owner"}}|{{index .Labels "com.clashcookies.deploy.environment"}}|{{index .Labels "com.clashcookies.revision"}}|{{index .Labels "com.clashcookies.role"}}' "$volume" 2>/dev/null)" || return 2
  [ "$labels" = "artifact|${DEPLOY_OWNER_LABEL}|${DEPLOY_ENVIRONMENT_LABEL}|${revision}|${role}" ]
}

artifact_volume_attached_to_live_runtime() {
  local volume="$1"
  local attached
  attached="$(docker_bounded ps --filter "volume=${volume}" --format '{{.Names}}')"
  [ "$attached" = "$NORMAL_CONTAINER" ]
}

ensure_owned_artifact_volume() {
  local volume="$1"
  local revision="$2"
  local role="$3"
  local existing_labels

  if volume_exists_or_missing "$volume"; then
    existing_labels="$(docker_bounded volume inspect --format '{{index .Labels "com.clashcookies.deploy"}}|{{index .Labels "com.clashcookies.deploy.owner"}}|{{index .Labels "com.clashcookies.deploy.environment"}}|{{index .Labels "com.clashcookies.revision"}}|{{index .Labels "com.clashcookies.role"}}' "$volume")"
    [ "$existing_labels" = "artifact|${DEPLOY_OWNER_LABEL}|${DEPLOY_ENVIRONMENT_LABEL}|${revision}|${role}" ] || \
      fatal "artifact_volume_ownership_mismatch volume=${volume} labels=${existing_labels}"
    assert_volume_detached "$volume"
    docker_bounded volume rm "$volume" >/dev/null
  else
    [ "$?" -eq 1 ] || fatal "artifact_volume_query_unknown volume=${volume}"
  fi

  docker_bounded volume create \
    --label com.clashcookies.deploy=artifact \
    --label "com.clashcookies.deploy.owner=${DEPLOY_OWNER_LABEL}" \
    --label "com.clashcookies.deploy.environment=${DEPLOY_ENVIRONMENT_LABEL}" \
    --label "com.clashcookies.deploy.attempt=${DEPLOY_ATTEMPT_ID}" \
    --label "com.clashcookies.revision=${revision}" \
    --label "com.clashcookies.role=${role}" \
    "$volume" >/dev/null
}

copy_artifacts_to_volumes() {
  local source_dist="$1"
  local source_node_modules="$2"
  local target_dist="$3"
  local target_node_modules="$4"
  local revision="$5"

  local stage_log="${DIAGNOSTIC_DIR}/artifact-copy-${DEPLOY_ATTEMPT_ID}-${ARTIFACT_STAGE_COUNTER}.log"
  prepare_private_file "$stage_log"
  begin_artifact_stage
  run_owned_container "$((ARTIFACT_STAGE_DEADLINE - SECONDS))" artifact-stage "$stage_log" 1 \
    --network bridge \
    -e "BUILD_SHA=${revision}" \
    -v "${source_dist}:/source-dist:ro" \
    -v "${source_node_modules}:/source-node-modules:ro" \
    -v "${target_dist}:/target-dist" \
    -v "${target_node_modules}:/target-node-modules" \
    "$ARTIFACT_IMAGE" bash -lc '
      set -euo pipefail
      find /target-dist -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      find /target-node-modules -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
      cp -a /source-dist/. /target-dist/
      cp -a /source-node-modules/. /target-node-modules/
    '
  stamp_artifact_volumes "$target_dist" "$target_node_modules" "$revision"
}

stamp_artifact_volumes() {
  local dist_volume="$1"
  local node_modules_volume="$2"
  local revision="$3"

  local stage_log="${DIAGNOSTIC_DIR}/artifact-stamp-${DEPLOY_ATTEMPT_ID}-${ARTIFACT_STAGE_COUNTER}.log"
  prepare_private_file "$stage_log"
  begin_artifact_stage
  run_owned_container "$((ARTIFACT_STAGE_DEADLINE - SECONDS))" artifact-stage "$stage_log" 1 \
    --network bridge \
    -e "EXPECTED_BUILD_SHA=${revision}" \
    -v "${dist_volume}:/dist" \
    -v "${node_modules_volume}:/node_modules" \
    "$ARTIFACT_IMAGE" bash -lc '
      set -euo pipefail
      digest_tree() {
        (
          cd "$1"
          find . -type f ! -name .clashcookies-artifact -printf "%P\\0" |
            sort -z |
            while IFS= read -r -d "" path; do
              sha256sum -- "$path"
            done |
            sha256sum | awk "{print \$1}"
        )
      }
      dist_digest="$(digest_tree /dist)"
      node_digest="$(digest_tree /node_modules)"
      printf "revision=%s\ndist_digest=%s\nnode_modules_digest=%s\n" "$EXPECTED_BUILD_SHA" "$dist_digest" "$node_digest" > /dist/.clashcookies-artifact
      cp /dist/.clashcookies-artifact /node_modules/.clashcookies-artifact
    '
}

verify_artifact_volumes() {
  local dist_volume="$1"
  local node_modules_volume="$2"
  local revision="$3"

  local stage_log="${DIAGNOSTIC_DIR}/artifact-verify-${DEPLOY_ATTEMPT_ID}-${ARTIFACT_STAGE_COUNTER}.log"
  prepare_private_file "$stage_log"
  begin_artifact_stage
  run_owned_container "$((ARTIFACT_STAGE_DEADLINE - SECONDS))" artifact-stage "$stage_log" 1 \
    --network bridge \
    -e "EXPECTED_BUILD_SHA=${revision}" \
    -v "${dist_volume}:/dist:ro" \
    -v "${node_modules_volume}:/node_modules:ro" \
    "$ARTIFACT_IMAGE" bash -lc '
      set -euo pipefail
      test -s /dist/.clashcookies-artifact
      test -s /node_modules/.clashcookies-artifact
      grep -Fx "revision=${EXPECTED_BUILD_SHA}" /dist/.clashcookies-artifact >/dev/null
      grep -Fx "revision=${EXPECTED_BUILD_SHA}" /node_modules/.clashcookies-artifact >/dev/null
      digest_tree() {
        (
          cd "$1"
          find . -type f ! -name .clashcookies-artifact -printf "%P\\0" |
            sort -z |
            while IFS= read -r -d "" path; do
              sha256sum -- "$path"
            done |
            sha256sum | awk "{print \$1}"
        )
      }
      dist_digest="$(digest_tree /dist)"
      node_digest="$(digest_tree /node_modules)"
      grep -Fx "dist_digest=${dist_digest}" /dist/.clashcookies-artifact >/dev/null
      grep -Fx "node_modules_digest=${node_digest}" /dist/.clashcookies-artifact >/dev/null
    '
}

capture_diagnostics() {
  local label="$1"
  local container_name="${2:-$NORMAL_CONTAINER}"
  local safe_label
  safe_label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')"
  validate_private_directory "$DIAGNOSTIC_DIR"
  prepare_private_file "${DIAGNOSTIC_DIR}/${safe_label}.state"
  prepare_private_file "${DIAGNOSTIC_DIR}/${safe_label}.log"
  {
    printf 'label=%s\ncontainer=%s\nold_sha=%s\nnew_sha=%s\n' "$label" "$container_name" "$OLD_SHA" "$NEW_SHA"
    docker_bounded inspect --format '{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.RestartCount}}' "$container_name" 2>/dev/null || true
  } > "${DIAGNOSTIC_DIR}/${safe_label}.state"
  docker_bounded logs --tail 400 "$container_name" > "${DIAGNOSTIC_DIR}/${safe_label}.log" 2>&1 || true
  log "diagnostics_saved label=${label} dir=${DIAGNOSTIC_DIR}"
}

prepare_rollback_artifact() {
  local source_dist source_node_modules
  ROLLBACK_DIST_VOLUME="$(artifact_volume_name "$OLD_SHA" rollback-dist)"
  ROLLBACK_NODE_MODULES_VOLUME="$(artifact_volume_name "$OLD_SHA" rollback-node-modules)"

  if docker_bounded volume inspect "$ROLLBACK_DIST_VOLUME" >/dev/null 2>&1 && \
    docker_bounded volume inspect "$ROLLBACK_NODE_MODULES_VOLUME" >/dev/null 2>&1 && \
    artifact_volume_has_labels "$ROLLBACK_DIST_VOLUME" "$OLD_SHA" rollback-dist && \
    artifact_volume_has_labels "$ROLLBACK_NODE_MODULES_VOLUME" "$OLD_SHA" rollback-node-modules && \
    artifact_volume_attached_to_live_runtime "$ROLLBACK_DIST_VOLUME" && \
    artifact_volume_attached_to_live_runtime "$ROLLBACK_NODE_MODULES_VOLUME"; then
    verify_artifact_volumes "$ROLLBACK_DIST_VOLUME" "$ROLLBACK_NODE_MODULES_VOLUME" "$OLD_SHA" || \
      fatal "rollback_artifact_verification_failed revision=${OLD_SHA}"
    log "rollback_artifact_prepare=reused_attached revision=${OLD_SHA} dist=${ROLLBACK_DIST_VOLUME} node_modules=${ROLLBACK_NODE_MODULES_VOLUME}"
    return 0
  fi

  source_dist="$(docker_bounded inspect --format '{{range .Mounts}}{{if eq .Destination "/app/dist"}}{{.Source}}{{end}}{{end}}' "$NORMAL_CONTAINER")"
  source_node_modules="$(docker_bounded inspect --format '{{range .Mounts}}{{if eq .Destination "/app/node_modules"}}{{.Source}}{{end}}{{end}}' "$NORMAL_CONTAINER")"
  if [ -z "$source_dist" ]; then
    source_dist="${APP_DIR}/dist"
    [ -e "$source_dist" ] || fatal "rollback_artifact_source_missing=dist"
  fi
  if [ -z "$source_node_modules" ]; then
    source_node_modules="${APP_DIR}/node_modules"
    [ -e "$source_node_modules" ] || fatal "rollback_artifact_source_missing=node_modules"
  fi

  ensure_owned_artifact_volume "$ROLLBACK_DIST_VOLUME" "$OLD_SHA" rollback-dist
  ensure_owned_artifact_volume "$ROLLBACK_NODE_MODULES_VOLUME" "$OLD_SHA" rollback-node-modules
  if ! copy_artifacts_to_volumes "$source_dist" "$source_node_modules" \
    "$ROLLBACK_DIST_VOLUME" "$ROLLBACK_NODE_MODULES_VOLUME" "$OLD_SHA"; then
    log "rollback_artifact_prepare=failed revision=${OLD_SHA}" >&2
    return 1
  fi
  verify_artifact_volumes "$ROLLBACK_DIST_VOLUME" "$ROLLBACK_NODE_MODULES_VOLUME" "$OLD_SHA" || \
    fatal "rollback_artifact_verification_failed revision=${OLD_SHA}"
  log "rollback_artifact_prepare=success revision=${OLD_SHA} dist=${ROLLBACK_DIST_VOLUME} node_modules=${ROLLBACK_NODE_MODULES_VOLUME}"
}

cleanup_owned_detached_artifacts() {
  local volumes volume labels role revision attached cleanup_status=0 deploy owner environment
  volumes="$(docker_bounded volume ls -q --filter label=com.clashcookies.deploy=artifact)" || {
    log "artifact_cleanup=deferred reason=volume_enumeration_unknown" >&2
    return 1
  }
  while IFS= read -r volume; do
    [ -n "$volume" ] || continue
    if ! labels="$(docker_bounded volume inspect --format '{{index .Labels "com.clashcookies.deploy"}}|{{index .Labels "com.clashcookies.deploy.owner"}}|{{index .Labels "com.clashcookies.deploy.environment"}}|{{index .Labels "com.clashcookies.revision"}}|{{index .Labels "com.clashcookies.role"}}' "$volume" 2>/dev/null)"; then
      log "artifact_cleanup=deferred reason=volume_inspection_unknown volume=${volume}" >&2
      cleanup_status=1
      continue
    fi
    IFS='|' read -r deploy owner environment revision role <<< "$labels"
    [ "$deploy" = artifact ] && [ "$owner" = "$DEPLOY_OWNER_LABEL" ] && [ "$environment" = "$DEPLOY_ENVIRONMENT_LABEL" ] || continue
    attached="$(docker_bounded ps -a --filter "volume=${volume}" --format '{{.Names}}')"
    if [ -n "$attached" ]; then
      if [ "$attached" = "$NORMAL_CONTAINER" ]; then
        continue
      fi
      log "artifact_cleanup=deferred reason=ambiguous_attachment volume=${volume} containers=${attached}" >&2
      cleanup_status=1
      continue
    fi
    if [ "$role" = "rollback-dist" ] || [ "$role" = "rollback-node-modules" ]; then
      [ "$revision" = "$OLD_SHA" ] && continue
    fi
    if docker_bounded volume rm "$volume" >/dev/null 2>&1; then
      log "artifact_cleanup=removed volume=${volume} revision=${revision} role=${role}"
    else
      log "artifact_cleanup=deferred volume=${volume} revision=${revision} role=${role}"
      cleanup_status=1
    fi
  done <<< "$volumes"
  return "$cleanup_status"
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
  if git_safe worktree remove "$TEMP_WORKTREE" >/dev/null; then
    TEMP_WORKTREE_CREATED="0"
    log "candidate_cleanup=success"
  else
    log "candidate_cleanup=failed path=${TEMP_WORKTREE}" >&2
    return 1
  fi
}

cleanup_candidate_workspace() {
  local labels attached
  [ "$BUILD_WORKSPACE_CREATED" = "1" ] || return 0

  if ! labels="$(docker_bounded volume inspect --format '{{index .Labels "com.clashcookies.deploy"}}|{{index .Labels "com.clashcookies.deploy.owner"}}|{{index .Labels "com.clashcookies.deploy.environment"}}|{{index .Labels "com.clashcookies.revision"}}|{{index .Labels "com.clashcookies.role"}}' "$BUILD_WORKSPACE_VOLUME" 2>/dev/null)"; then
    log "workspace_cleanup=failed reason=ownership_check volume=${BUILD_WORKSPACE_VOLUME}" >&2
    return 1
  fi
  if [ "$labels" != "artifact|${DEPLOY_OWNER_LABEL}|${DEPLOY_ENVIRONMENT_LABEL}|${NEW_SHA}|build-workspace" ]; then
    log "workspace_cleanup=failed reason=ownership_mismatch volume=${BUILD_WORKSPACE_VOLUME}" >&2
    return 1
  fi
  if ! attached="$(docker_bounded ps -a --filter "volume=${BUILD_WORKSPACE_VOLUME}" --format '{{.Names}}')"; then
    log "workspace_cleanup=failed reason=reference_check volume=${BUILD_WORKSPACE_VOLUME}" >&2
    return 1
  fi
  if [ -n "$attached" ]; then
    log "workspace_cleanup=failed reason=volume_attached volume=${BUILD_WORKSPACE_VOLUME} containers=${attached}" >&2
    return 1
  fi
  if ! docker_bounded volume rm "$BUILD_WORKSPACE_VOLUME" >/dev/null 2>&1; then
    log "workspace_cleanup=failed reason=remove volume=${BUILD_WORKSPACE_VOLUME}" >&2
    return 1
  fi

  BUILD_WORKSPACE_CREATED="0"
  BUILD_WORKSPACE_VOLUME=""
  log "workspace_cleanup=success"
}

cleanup_build_volumes() {
  local cleanup_status=0
  [ "$BUILD_VOLUMES_IN_USE" = "0" ] || return 0
  if [ "$BUILD_WORKSPACE_CREATED" = "1" ]; then
    cleanup_candidate_workspace || \
      { log "build_artifacts_cleanup=deferred workspace=${BUILD_WORKSPACE_VOLUME}"; cleanup_status=1; }
  fi
  if [ "$BUILD_NODE_MODULES_CREATED" = "1" ]; then
    docker_bounded volume rm "$BUILD_NODE_MODULES_VOLUME" >/dev/null 2>&1 || \
      { log "build_artifacts_cleanup=deferred node_modules=${BUILD_NODE_MODULES_VOLUME}"; cleanup_status=1; }
  fi
  if [ "$BUILD_DIST_CREATED" = "1" ]; then
    docker_bounded volume rm "$BUILD_DIST_VOLUME" >/dev/null 2>&1 || \
      { log "build_artifacts_cleanup=deferred dist=${BUILD_DIST_VOLUME}"; cleanup_status=1; }
  fi
  return "$cleanup_status"
}

cleanup_owned_containers_on_exit() {
  local cleanup_status=0
  log "cleanup_owned_containers=start candidate=${CANDIDATE_CONTAINER_ID:-none} artifact=${ARTIFACT_CONTAINER_ID:-none} intent=${CURRENT_CONTAINER_INTENT:-none}"
  if [ -n "$CANDIDATE_CONTAINER_ID" ]; then
    log "cleanup_owned_containers=candidate_begin id=${CANDIDATE_CONTAINER_ID}"
    set +e
    terminate_owned_container "$CANDIDATE_CONTAINER_ID" candidate-build interruption "$CANDIDATE_CONTAINER_ATTEMPT" "$CANDIDATE_CONTAINER_REVISION" "$CANDIDATE_CONTAINER_NAME"
    local terminate_status=$?
    set -e
    if [ "$terminate_status" -eq 0 ]; then
      CANDIDATE_CONTAINER_ID=""
      CANDIDATE_CONTAINER_ATTEMPT=""
      CANDIDATE_CONTAINER_REVISION=""
      CANDIDATE_CONTAINER_NAME=""
      [ -z "$CURRENT_CONTAINER_INTENT" ] || rm -f -- "$CURRENT_CONTAINER_INTENT"
    else
      cleanup_status=1
    fi
  fi
  if [ -n "$ARTIFACT_CONTAINER_ID" ]; then
    set +e
    terminate_owned_container "$ARTIFACT_CONTAINER_ID" artifact-stage interruption "$ARTIFACT_CONTAINER_ATTEMPT" "$ARTIFACT_CONTAINER_REVISION" "$ARTIFACT_CONTAINER_NAME"
    terminate_status=$?
    set -e
    if [ "$terminate_status" -eq 0 ]; then
      ARTIFACT_CONTAINER_ID=""
      ARTIFACT_CONTAINER_ATTEMPT=""
      ARTIFACT_CONTAINER_REVISION=""
      ARTIFACT_CONTAINER_NAME=""
      [ -z "$CURRENT_CONTAINER_INTENT" ] || rm -f -- "$CURRENT_CONTAINER_INTENT"
    else
      cleanup_status=1
    fi
  fi
  if [ -n "$CURRENT_CONTAINER_INTENT" ] && [ -f "$CURRENT_CONTAINER_INTENT" ] && [ -z "$CANDIDATE_CONTAINER_ID" ] && [ -z "$ARTIFACT_CONTAINER_ID" ]; then
    reconcile_container_intent "$CURRENT_CONTAINER_INTENT" || cleanup_status=1
  fi
  return "$cleanup_status"
}

cleanup_on_exit() {
  local status="${1:-$?}"
  log "cleanup_on_exit=start status=${status} attempt=${DEPLOY_ATTEMPT_ID}"
  trap - EXIT
  trap '' TERM INT HUP
  cleanup_owned_containers_on_exit || {
    log "cleanup_result=failed reason=owned_container_remains operator_intervention_required" >&2
    status=1
    EXIT_CLEANUP_FAILED="1"
  }
  cleanup_candidate_worktree || [ "$status" -ne 0 ] || status=1
  cleanup_build_volumes || {
    log "cleanup_result=failed reason=owned_volume_cleanup operator_intervention_required" >&2
    status=1
    EXIT_CLEANUP_FAILED="1"
  }
  if [ "$LOCK_HELD" = "1" ]; then
    local lock_owner
    lock_owner="$(cat "${DEPLOY_LOCK_PATH}/owner" 2>/dev/null || true)"
    if [ "$lock_owner" = "pid=$$"$'\n'"attempt=$DEPLOY_ATTEMPT_ID" ]; then
      rm -f -- "${DEPLOY_LOCK_PATH}/owner"
      rmdir "$DEPLOY_LOCK_PATH" >/dev/null 2>&1 || {
        log "deploy_lock_release=failed path=${DEPLOY_LOCK_PATH}" >&2
        [ "$status" -ne 0 ] || status=1
      }
    else
      log "deploy_lock_release=refused reason=owner_mismatch path=${DEPLOY_LOCK_PATH}" >&2
      [ "$status" -ne 0 ] || status=1
    fi
    LOCK_HELD="0"
  fi
  exit "$status"
}

handle_interruption() {
  local interruption_status
  INTERRUPTION_SIGNAL="$1"
  log "interruption=received signal=${INTERRUPTION_SIGNAL} attempt=${DEPLOY_ATTEMPT_ID} cleanup=bounded" >&2
  case "$INTERRUPTION_SIGNAL" in
    TERM) interruption_status=143 ;;
    INT) interruption_status=130 ;;
    HUP) interruption_status=129 ;;
    *) interruption_status=1 ;;
  esac
  cleanup_on_exit "$interruption_status"
}

acquire_lock() {
  if ! mkdir "$DEPLOY_LOCK_PATH" 2>/dev/null; then
    local owner_pid stale_lock owner_attempt
    owner_pid="$(sed -n 's/^pid=//p' "${DEPLOY_LOCK_PATH}/owner" 2>/dev/null | head -n1 || true)"
    owner_attempt="$(sed -n 's/^attempt=//p' "${DEPLOY_LOCK_PATH}/owner" 2>/dev/null | head -n1 || true)"
    if ! is_positive_integer "${owner_pid:-}" || [ -z "$owner_attempt" ] || kill -0 "$owner_pid" 2>/dev/null; then
      fatal "another_deployment_is_running lock=${DEPLOY_LOCK_PATH} owner_pid=${owner_pid:-unknown}"
    fi
    stale_lock="${DEPLOY_LOCK_PATH}.stale.${DEPLOY_ATTEMPT_ID}"
    mv -- "$DEPLOY_LOCK_PATH" "$stale_lock" 2>/dev/null || fatal "deployment_lock_recovery_race path=${DEPLOY_LOCK_PATH}"
    mkdir "$DEPLOY_LOCK_PATH" 2>/dev/null || fatal "deployment_lock_recovery_failed path=${DEPLOY_LOCK_PATH}"
    rmdir "$stale_lock" >/dev/null 2>&1 || log "deployment_lock_stale_evidence=${stale_lock} owner_attempt=${owner_attempt}"
    log "deploy_lock=recovered_stale owner_pid=${owner_pid} owner_attempt=${owner_attempt}"
  fi
  LOCK_HELD="1"
  printf 'pid=%s\nattempt=%s\n' "$$" "$DEPLOY_ATTEMPT_ID" > "${DEPLOY_LOCK_PATH}/owner"
  log "deploy_lock=acquired attempt=${DEPLOY_ATTEMPT_ID}"
}

extract_database_url() {
  local file="$1"
  sed -n 's/^[[:space:]]*DATABASE_URL:[[:space:]]*//p' "$file" | head -n1 | tr -d '"'
}

build_candidate_only() {
  local log_file="${DIAGNOSTIC_DIR}/candidate-build.log"
  local build_status artifact_status reason
  validate_private_directory "$DIAGNOSTIC_DIR"
  prepare_private_file "$log_file"
  ensure_owned_artifact_volume "$BUILD_WORKSPACE_VOLUME" "$NEW_SHA" build-workspace
  BUILD_WORKSPACE_CREATED="1"
  ensure_owned_artifact_volume "$BUILD_NODE_MODULES_VOLUME" "$NEW_SHA" release-node-modules
  BUILD_NODE_MODULES_CREATED="1"
  ensure_owned_artifact_volume "$BUILD_DIST_VOLUME" "$NEW_SHA" release-dist
  BUILD_DIST_CREATED="1"
  if run_owned_container "$CANDIDATE_BUILD_TIMEOUT_SECONDS" candidate-build "$log_file" 1 \
      --network bridge \
      -w /app \
      -v "$TEMP_WORKTREE:/source:ro" \
      -v "$BUILD_WORKSPACE_VOLUME:/app" \
      -v "$BUILD_NODE_MODULES_VOLUME:/app/node_modules" \
      -v "$BUILD_DIST_VOLUME:/build-dist" \
      -v "$NORMAL_YARN_CACHE_VOLUME:/usr/local/share/.cache/yarn" \
      -e "BUILD_SHA=${NEW_SHA}" \
      node:20-bookworm \
      bash -lc 'set -euo pipefail; cp -a /source/. /app/; ./ops/deploy/ensure-yarn-deps.sh && npm run build && test -d /app/dist && find /build-dist -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /app/dist/. /build-dist/' >"$log_file" 2>&1; then
    build_status=0
  else
    build_status=$?
  fi
  if [ "$build_status" -ne 0 ]; then
    reason="build"
    [ "$build_status" -eq 124 ] && { [ "$LAST_CONTAINER_STATUS_KIND" = wrapper_deadline ] && reason="build_deadline" || reason="build_exit_124"; }
    [ "$build_status" -eq 125 ] && reason="build_abort_or_cleanup"
    log "candidate_build=failed reason=${reason} status=${build_status} revision=${NEW_SHA} diagnostics=${log_file}" >&2
    return 1
  fi

  if stamp_artifact_volumes "$BUILD_DIST_VOLUME" "$BUILD_NODE_MODULES_VOLUME" "$NEW_SHA" >>"$log_file" 2>&1; then
    artifact_status=0
  else
    artifact_status=$?
  fi
  if [ "$artifact_status" -ne 0 ]; then
    reason="artifact_stamp"
    [ "$artifact_status" -eq 124 ] && { [ "$LAST_CONTAINER_STATUS_KIND" = wrapper_deadline ] && reason="artifact_stamp_deadline" || reason="artifact_stamp_exit_124"; }
    [ "$artifact_status" -eq 125 ] && reason="artifact_stamp_abort_or_cleanup"
    log "candidate_build=failed reason=${reason} status=${artifact_status} revision=${NEW_SHA} diagnostics=${log_file}" >&2
    return 1
  fi

  if verify_artifact_volumes "$BUILD_DIST_VOLUME" "$BUILD_NODE_MODULES_VOLUME" "$NEW_SHA" >>"$log_file" 2>&1; then
    artifact_status=0
  else
    artifact_status=$?
  fi
  if [ "$artifact_status" -ne 0 ]; then
    reason="artifact_verification"
    [ "$artifact_status" -eq 124 ] && { [ "$LAST_CONTAINER_STATUS_KIND" = wrapper_deadline ] && reason="artifact_verification_deadline" || reason="artifact_verification_exit_124"; }
    [ "$artifact_status" -eq 125 ] && reason="artifact_verification_abort_or_cleanup"
    log "candidate_build=failed reason=${reason} status=${artifact_status} revision=${NEW_SHA} diagnostics=${log_file}" >&2
    return 1
  fi
  log "candidate_build=success revision=${NEW_SHA} diagnostics=${log_file}"
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
  local startup_mode="${12:-checkout}"
  local -a restart_args=() volume_args=( -v "$node_modules_volume:/app/node_modules" ) startup_args=(bash ./ops/deploy/container-start.sh)

  require_file "$env_file"
  [ "$restart_mode" = "restart" ] && restart_args=(--restart unless-stopped)
  [ -n "$dist_volume" ] && volume_args+=( -v "$dist_volume:/app/dist" )
  if [ "$prebuilt" = "1" ]; then
    [ -n "$dist_volume" ] || return 1
    verify_artifact_volumes "$dist_volume" "$node_modules_volume" "$revision" || return 1
  fi
  if [ "$startup_mode" = "prebuilt-inline" ]; then
    startup_args=(bash -lc '
      set -euo pipefail
      [ "${CLASHCOOKIES_PREBUILT:-0}" = "1" ]
      expected_build_sha="${BUILD_SHA:-}"
      dist_revision="$(sed -n "s/^revision=//p" ./dist/.clashcookies-artifact 2>/dev/null || true)"
      node_modules_revision="$(sed -n "s/^revision=//p" ./node_modules/.clashcookies-artifact 2>/dev/null || true)"
      if [ -z "${expected_build_sha}" ] || [ "${dist_revision}" != "${expected_build_sha}" ] || [ "${node_modules_revision}" != "${expected_build_sha}" ]; then
        echo "[deploy:start] action=refuse reason=artifact_sha_mismatch expected=${expected_build_sha:-unknown} dist=${dist_revision:-unknown} node_modules=${node_modules_revision:-unknown}" >&2
        exit 1
      fi
      echo "[deploy:start] action=skip-build reason=prebuilt build_sha=${BUILD_SHA:-unknown}"
      npm run start:runtime
    ')
  fi

  ACTIVE_CONTAINER_ID="$(run_with_timeout "$DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS" docker run -d \
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
    "${startup_args[@]}")"
  [ -n "$ACTIVE_CONTAINER_ID" ] || return 1
  log "container_started name=${container_name} id=${ACTIVE_CONTAINER_ID} revision=${revision} prebuilt=${prebuilt}"
}

remove_started_container() {
  [ -n "$ACTIVE_CONTAINER_ID" ] || return 0
  docker_bounded rm -f "$ACTIVE_CONTAINER_ID" >/dev/null 2>&1 || true
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
    capture_diagnostics rollback "$NORMAL_CONTAINER"
    log "rollback_result=failed reason=checkout_old_revision final_state=unknown" >&2
    return 1
  }
  if ! start_app_container "$NORMAL_CONTAINER" "$APP_DIR" "$NORMAL_PORT" "$RUNTIME_ENV_FILE" \
    "$ROLLBACK_NODE_MODULES_VOLUME" "$NORMAL_YARN_CACHE_VOLUME" "$prod_database_url" restart \
    "$OLD_SHA" 1 "$ROLLBACK_DIST_VOLUME" prebuilt-inline; then
    capture_diagnostics rollback "$NORMAL_CONTAINER"
    log "rollback_result=failed reason=start_old_revision final_state=unknown" >&2
    return 1
  fi
  if wait_for_health "$NORMAL_PORT" rollback "$ROLLBACK_HEALTH_TIMEOUT_SECONDS"; then
    BUILD_VOLUMES_IN_USE="0"
    cleanup_owned_detached_artifacts || {
      log "rollback_result=failed reason=artifact_cleanup final_state=unknown" >&2
      return 1
    }
    log "rollback_result=success final_state=old_sha:${OLD_SHA}"
    return 0
  fi
  capture_diagnostics rollback "$NORMAL_CONTAINER"
  log "rollback_result=failed reason=health final_state=unhealthy_old_sha:${OLD_SHA}" >&2
  return 1
}

if [ "${DEPLOY_PROD_ARTIFACT_TEST_MODE:-0}" = "1" ]; then
  [ "$#" -eq 5 ] || fatal "artifact_test_requires_source_dist_source_node_modules_target_dist_target_node_modules_revision"
  NEW_SHA="$5"
  DIAGNOSTIC_DIR="${DEPLOY_DIAGNOSTIC_DIR:-${TMPDIR:-/tmp}/clashcookies-artifact-test-$$}"
  mkdir -p "$DEPLOY_INTENT_DIR"
  chmod 700 "$DEPLOY_INTENT_DIR"
  validate_private_directory "$DIAGNOSTIC_DIR"
  copy_artifacts_to_volumes "$@"
  verify_artifact_volumes "$3" "$4" "$5"
  log "artifact_test=success revision=$5"
  exit 0
fi

# flock is the primary inter-process lock.  The old directory lock remains
# below as a transition guard for the already-installed wrapper; a new
# wrapper never performs stale recovery without first holding this kernel lock.
if [ "${DEPLOY_LOCK_WRAPPED:-0}" != "1" ]; then
  require_command flock
  export DEPLOY_LOCK_WRAPPED=1
  exec flock -n --no-fork "$DEPLOY_LOCK_FILE" "$0" "$@"
fi

require_command git
require_command docker
require_command curl
require_command timeout
require_command mkdir
require_command rmdir
require_command sed
require_command tr
require_command wc
require_command id
require_command stat
require_command chmod
require_command awk
require_command grep
require_command head
require_command tail
require_command getconf
require_file "$APP_DIR/docker-compose.yml"
validate_deadline_configuration
validate_resource_configuration
[ -z "$DEPLOY_RESOURCE_ADMISSION_FILE" ] || require_file "$DEPLOY_RESOURCE_ADMISSION_FILE"
assert_runtime_environment_source
assert_safe_temp_worktree_path
assert_checkout_safe
acquire_lock
mkdir -p "$DEPLOY_INTENT_DIR"
chmod 700 "$DEPLOY_INTENT_DIR"
trap cleanup_on_exit EXIT
trap 'handle_interruption TERM' TERM
trap 'handle_interruption INT' INT
trap 'handle_interruption HUP' HUP
reconcile_abandoned_resources
reconcile_abandoned_worktree
assert_single_active_runtime || fatal "active_runtime_singleton_required_before_deploy"

prepare_diagnostic_directory
assert_host_resource_admission
assert_production_health_ready
log "fetch=origin"
git_safe fetch origin
OLD_SHA="$(git_safe rev-parse HEAD)"
NEW_SHA="$(git_safe rev-parse "${TARGET_REF}^{commit}")"
BUILD_NODE_MODULES_VOLUME="${BUILD_NODE_MODULES_VOLUME:-clashcookies-prod-build-${NEW_SHA}}"
BUILD_DIST_VOLUME="${BUILD_DIST_VOLUME:-clashcookies-prod-build-dist-${NEW_SHA}}"
BUILD_WORKSPACE_VOLUME="${BUILD_WORKSPACE_VOLUME:-clashcookies-prod-build-workspace-${NEW_SHA}}"
log "old_sha=${OLD_SHA}"
log "new_sha=${NEW_SHA}"
printf 'attempt_id=%s\nold_sha=%s\nnew_sha=%s\nlock_path=%s\n' "$DEPLOY_ATTEMPT_ID" "$OLD_SHA" "$NEW_SHA" "$DEPLOY_LOCK_PATH" > "${DIAGNOSTIC_DIR}/attempt.state"
log "promotion_readiness_budget_seconds=${PROMOTION_HEALTH_TIMEOUT_SECONDS} rollback_readiness_budget_seconds=${ROLLBACK_HEALTH_TIMEOUT_SECONDS} candidate_build_timeout_seconds=${CANDIDATE_BUILD_TIMEOUT_SECONDS} artifact_stage_timeout_seconds=${ARTIFACT_STAGE_TIMEOUT_SECONDS} request_timeout_seconds=${HEALTH_REQUEST_TIMEOUT_SECONDS}"

changed_prisma_files="$(git_safe diff --name-only "$OLD_SHA" "$NEW_SHA" -- prisma/migrations prisma/schema.prisma || true)"
prod_database_url="$(extract_database_url "$APP_DIR/docker-compose.yml")"
[ -n "$prod_database_url" ] || fatal "unable_to_read_production_database_url"

if [ -n "$changed_prisma_files" ]; then
  log "mode=downtime reason=prisma_changes"
  prepare_rollback_artifact || fatal "rollback_artifact_prepare_failed final_state=old_runtime_still_active"
  PRODUCTION_RUNTIME_MONITOR="0"
docker_bounded rm -f "$NORMAL_CONTAINER" >/dev/null 2>&1 || true
  assert_no_active_runtime || fatal "active_runtime_did_not_stop"
  if ! git_safe reset --hard "$NEW_SHA"; then
    log "promotion_result=failed reason=checkout_new_revision recovery=rollback_attempt" >&2
    capture_diagnostics promotion "$NORMAL_CONTAINER"
    if rollback_to_old_revision; then
      log "promotion_result=failed reason=checkout_new_revision final_state=old_sha:${OLD_SHA}" >&2
    elif assert_single_active_runtime; then
      log "promotion_result=failed reason=checkout_new_revision final_state=single_active_runtime" >&2
    else
      log "promotion_result=failed reason=checkout_new_revision final_state=unknown" >&2
    fi
    exit 1
  fi
  if start_app_container "$NORMAL_CONTAINER" "$APP_DIR" "$NORMAL_PORT" "$RUNTIME_ENV_FILE" \
    "$NORMAL_NODE_MODULES_VOLUME" "$NORMAL_YARN_CACHE_VOLUME" "$prod_database_url" restart \
    "$NEW_SHA" 0; then
    if wait_for_health "$NORMAL_PORT" downtime "$PROMOTION_HEALTH_TIMEOUT_SECONDS"; then
      cleanup_owned_detached_artifacts || fatal "artifact_cleanup_failed final_state=new_runtime_healthy"
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
cleanup_candidate_workspace || fatal "candidate_workspace_cleanup_failed final_state=old_runtime_still_active"
assert_single_active_runtime || fatal "active_runtime_changed_during_candidate_build"
prepare_rollback_artifact || fatal "rollback_artifact_prepare_failed final_state=old_runtime_still_active"

log "promotion_step=stop_old_app"
PRODUCTION_RUNTIME_MONITOR="0"
docker_bounded rm -f "$NORMAL_CONTAINER" >/dev/null 2>&1 || true
assert_no_active_runtime || fatal "active_runtime_did_not_stop"
if ! git_safe reset --hard "$NEW_SHA"; then
  log "promotion_result=failed reason=checkout_new_revision recovery=rollback_attempt" >&2
  capture_diagnostics promotion "$NORMAL_CONTAINER"
  if rollback_to_old_revision; then
    log "promotion_result=failed reason=checkout_new_revision final_state=old_sha:${OLD_SHA}" >&2
  elif assert_single_active_runtime; then
    log "promotion_result=failed reason=checkout_new_revision final_state=single_active_runtime" >&2
  else
    log "promotion_result=failed reason=checkout_new_revision final_state=unknown" >&2
  fi
  exit 1
fi

if start_app_container "$NORMAL_CONTAINER" "$APP_DIR" "$NORMAL_PORT" "$RUNTIME_ENV_FILE" \
  "$BUILD_NODE_MODULES_VOLUME" "$NORMAL_YARN_CACHE_VOLUME" "$prod_database_url" restart \
  "$NEW_SHA" 1 "$BUILD_DIST_VOLUME"; then
  BUILD_VOLUMES_IN_USE="1"
  if wait_for_health "$NORMAL_PORT" promotion "$PROMOTION_HEALTH_TIMEOUT_SECONDS"; then
    assert_single_active_runtime || fatal "active_runtime_singleton_failed_after_promotion"
    cleanup_owned_detached_artifacts || fatal "artifact_cleanup_failed final_state=new_runtime_healthy"
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
