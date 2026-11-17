#!/usr/bin/env bash

# ClashCookies production VM discovery. This file is evidence collection only.
# It must not be used as a deployment wrapper and must never be sourced by one.

set -Eeuo pipefail
IFS=$' \t\n'
export LC_ALL=C

readonly SCHEMA="clashcookies.production-vm-discovery.v1"
readonly PROVENANCE="live-vm-read-only"
readonly MAX_OUTPUT_BYTES="${DISCOVERY_MAX_OUTPUT_BYTES:-131072}"
readonly MAX_COMMAND_SECONDS="${DISCOVERY_MAX_COMMAND_SECONDS:-5}"
readonly MAX_CONTAINERS="${DISCOVERY_MAX_CONTAINERS:-64}"
readonly APP_DIR="${DISCOVERY_APP_DIR:-/home/tilo/apps/clashcookies-prod}"
readonly WRAPPER_PATH="${DISCOVERY_WRAPPER_PATH:-/home/tilo/deploy-prod.sh}"
readonly LOCK_PATH="${DISCOVERY_LOCK_PATH:-/run/lock/clashcookies-prod-deploy.lock}"
readonly MIGRATION_LOCK_PATH="${DISCOVERY_MIGRATION_LOCK_PATH:-}"
readonly EXECUTOR_PATH="${DISCOVERY_EXECUTOR_PATH:-}"
readonly CREDENTIAL_PATH="${DISCOVERY_CREDENTIAL_PATH:-}"
readonly RELEASE_RECORD_PATH="${DISCOVERY_RELEASE_RECORD_PATH:-}"
readonly STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf '%s' unknown)"

if ! [[ "$MAX_OUTPUT_BYTES" =~ ^[1-9][0-9]{2,7}$ && "$MAX_COMMAND_SECONDS" =~ ^[1-9][0-9]?$ && "$MAX_CONTAINERS" =~ ^[1-9][0-9]?$ ]]; then
  printf '%s\n' '{"schema":"clashcookies.production-vm-discovery.v1","evidence":"script","status":"UNKNOWN","provenance":"live-vm-read-only","detail":"invalid bounded execution configuration; no probe was run"}'
  exit 0
fi

PASS_COUNT=0
FAIL_COUNT=0
UNKNOWN_COUNT=0
CAPTURE_OUTPUT=""
CAPTURE_STATUS=0

json_escape() {
  local value=${1-}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\r'/\\r}
  value=${value//$'\n'/\\n}
  printf '%s' "$value"
}

emit_evidence() {
  local evidence=$1
  local status=$2
  local detail=$3
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    UNKNOWN) UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1)) ;;
    *) status=UNKNOWN; UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1)) ;;
  esac
  printf '{"schema":"%s","evidence":"%s","status":"%s","observed_at":"%s","provenance":"%s","detail":"%s"}\n' \
    "$SCHEMA" "$(json_escape "$evidence")" "$status" "$(json_escape "$STARTED_AT")" "$PROVENANCE" "$(json_escape "$detail")"
}

resolve_command() {
  local command_name=$1
  case "$command_name" in
    awk|curl|date|df|docker|git|id|ps|psql|sha256sum|stat|systemctl|timeout)
      ;;
    *) return 126 ;;
  esac
  local resolved
  resolved=$(command -v "$command_name" 2>/dev/null || true)
  [[ "$resolved" == /* && -x "$resolved" ]] || return 127
  printf '%s' "$resolved"
}

capture_command() {
  local command_name=$1
  shift
  CAPTURE_OUTPUT=""
  CAPTURE_STATUS=0
  local command_path timeout_path
  command_path=$(resolve_command "$command_name") || { CAPTURE_STATUS=126; return 1; }
  timeout_path=$(resolve_command timeout) || { CAPTURE_STATUS=126; return 1; }
  local output="" chunk read_status=0 command_status=0 byte_count=0 capture_fd capture_pid
  set +e
  coproc DISCOVERY_CAPTURE_CHILD { "$timeout_path" --signal=TERM --kill-after=1s "${MAX_COMMAND_SECONDS}s" "$command_path" "$@" 2>/dev/null; }
  capture_fd=${DISCOVERY_CAPTURE_CHILD[0]}
  capture_pid=$DISCOVERY_CAPTURE_CHILD_PID
  while :; do
    chunk=""
    read_status=0
    IFS= read -r -N 4096 chunk <&"$capture_fd" || read_status=$?
    if [[ -n "$chunk" ]]; then
      output+="$chunk"
      byte_count=${#output}
      if (( byte_count > MAX_OUTPUT_BYTES )); then
        kill "$capture_pid" 2>/dev/null || true
        exec {capture_fd}<&-
        wait "$capture_pid" 2>/dev/null || true
        set -e
        CAPTURE_STATUS=125
        return 1
      fi
    fi
    (( read_status != 0 )) && break
  done
  exec {capture_fd}<&-
  wait "$capture_pid" 2>/dev/null
  command_status=$?
  set -e
  CAPTURE_STATUS=$command_status
  if (( command_status != 0 )); then
    return 1
  fi
  CAPTURE_OUTPUT=$output
  return 0
}

valid_absolute_path() {
  local value=$1
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *'..'* && "$value" != *'//'* ]]
}

path_has_symlink_component() {
  local path_value=$1
  valid_absolute_path "$path_value" || return 2
  local current=/ component
  local rest=${path_value#/}
  IFS=/ read -r -a components <<< "$rest"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current%/}/$component"
    if [[ -L "$current" ]]; then
      return 0
    fi
  done
  return 1
}

safe_path_digest() {
  local path_value=$1
  local sha_path
  sha_path=$(resolve_command sha256sum) || { printf '%s' unknown; return; }
  printf '%s' "$path_value" | "$sha_path" | awk '{print $1}'
}

parse_stat() {
  local path_value=$1
  capture_command stat -c '%u|%g|%a|%F|%s' -- "$path_value"
}

inspect_resource() {
  local evidence=$1
  local path_value=$2
  local expected_kind=$3
  local expected_mode=${4:-}
  if ! valid_absolute_path "$path_value"; then
    emit_evidence "$evidence" UNKNOWN 'path is unset, relative, malformed, or intentionally not guessed'
    return
  fi
  if [[ -L "$path_value" ]]; then
    emit_evidence "$evidence" FAIL 'expected protected path is a symlink; target was not followed'
    return
  fi
  if [[ ! -e "$path_value" ]]; then
    emit_evidence "$evidence" UNKNOWN 'expected protected resource is absent'
    return
  fi
  local symlink_state
  if path_has_symlink_component "$path_value"; then
    emit_evidence "$evidence" FAIL 'a protected path component is a symlink; target was not followed'
    return
  elif [[ $? -eq 2 ]]; then
    emit_evidence "$evidence" UNKNOWN 'protected path safety could not be established'
    return
  fi
  if ! parse_stat "$path_value"; then
    emit_evidence "$evidence" UNKNOWN "metadata command failed or exceeded bound; path_ref=$(safe_path_digest "$path_value")"
    return
  fi
  local stat_value=$CAPTURE_OUTPUT
  IFS='|' read -r owner_uid owner_gid mode file_kind size <<< "$stat_value"
  if ! [[ "$owner_uid" =~ ^[0-9]+$ && "$owner_gid" =~ ^[0-9]+$ && "$mode" =~ ^[0-9]+$ && "$size" =~ ^[0-9]+$ ]]; then
    emit_evidence "$evidence" UNKNOWN 'unexpected protected-resource metadata shape'
    return
  fi
  if [[ "$file_kind" != "$expected_kind" ]]; then
    emit_evidence "$evidence" FAIL "expected_kind=$expected_kind observed_kind=unexpected path_ref=$(safe_path_digest "$path_value")"
    return
  fi
  local detail="path_ref=$(safe_path_digest "$path_value") owner_uid=$owner_uid owner_gid=$owner_gid mode=$mode bytes=$size"
  if [[ -n "$expected_mode" && "$mode" != "$expected_mode" ]]; then
    emit_evidence "$evidence" FAIL "$detail expected_mode=$expected_mode"
  else
    emit_evidence "$evidence" PASS "$detail"
  fi
}

inspect_wrapper() {
  if ! valid_absolute_path "$WRAPPER_PATH"; then
    emit_evidence wrapper_identity UNKNOWN 'wrapper path is malformed; no wrapper was opened'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper control flow is unavailable'
    return
  fi
  if [[ -L "$WRAPPER_PATH" ]]; then
    emit_evidence wrapper_identity FAIL 'wrapper is a symlink; target was not followed'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper content was not inspected because symlink safety failed'
    return
  fi
  if [[ ! -f "$WRAPPER_PATH" ]]; then
    emit_evidence wrapper_identity UNKNOWN 'wrapper is missing or is not a regular file'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper control flow is unavailable'
    return
  fi
  if path_has_symlink_component "$WRAPPER_PATH"; then
    emit_evidence wrapper_identity FAIL 'wrapper path contains a symlink component; target was not followed'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper content was not inspected because path safety failed'
    return
  elif [[ $? -eq 2 ]]; then
    emit_evidence wrapper_identity UNKNOWN 'wrapper path safety could not be established'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper control flow is unavailable'
    return
  fi
  if ! parse_stat "$WRAPPER_PATH"; then
    emit_evidence wrapper_identity UNKNOWN "wrapper metadata command failed or exceeded bound; path_ref=$(safe_path_digest "$WRAPPER_PATH")"
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper control flow is unavailable'
    return
  fi
  local metadata=$CAPTURE_OUTPUT owner_uid owner_gid mode file_kind size
  IFS='|' read -r owner_uid owner_gid mode file_kind size <<< "$metadata"
  if [[ "$file_kind" != "regular file" || ! "$owner_uid" =~ ^[0-9]+$ || ! "$owner_gid" =~ ^[0-9]+$ || ! "$mode" =~ ^[0-9]+$ || ! "$size" =~ ^[0-9]+$ ]]; then
    emit_evidence wrapper_identity UNKNOWN 'unexpected wrapper metadata shape'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper control flow is unavailable'
    return
  fi
  if (( size > MAX_OUTPUT_BYTES )); then
    emit_evidence wrapper_identity UNKNOWN "wrapper exceeds the bounded inspection size path_ref=$(safe_path_digest "$WRAPPER_PATH")"
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper content was not inspected because the bounded size was exceeded'
    return
  fi
  local digest_before digest_after
  if ! capture_command sha256sum -- "$WRAPPER_PATH"; then
    emit_evidence wrapper_identity UNKNOWN 'wrapper SHA-256 command failed or exceeded bound'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper control flow is unavailable'
    return
  fi
  digest_before=${CAPTURE_OUTPUT%% *}
  if ! [[ "$digest_before" =~ ^[0-9a-fA-F]{64}$ ]]; then
    emit_evidence wrapper_identity UNKNOWN 'wrapper SHA-256 output was unexpected'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper control flow is unavailable'
    return
  fi
  local lock=0 mkdir_count=0 owner_count=0 checkout_count=0 runtime_count=0 health_count=0 rollback_count=0 sensitive_count=0
  local lock_line=0 mkdir_line=0 checkout_line=0 runtime_line=0 health_line=0 rollback_line=0 line_count=0 line lower
  # The wrapper is never executed and no source line is emitted. Bash only
  # retains fixed marker counts and line ordering, so sensitive assignments and
  # arguments cannot reach normal output or stderr.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_count=$((line_count + 1))
    lower=${line,,}
    if [[ "$lower" == *deploy_lock_path* || "$lower" == *deploy_lock_file* || "$lower" == *deployment-lock* || "$lower" == *flock* ]]; then
      lock=$((lock + 1)); (( lock_line == 0 )) && lock_line=$line_count
    fi
    if [[ "$lower" == *mkdir*lock* || "$lower" == *'mkdir --'* ]]; then
      mkdir_count=$((mkdir_count + 1)); (( mkdir_line == 0 )) && mkdir_line=$line_count
    fi
    if [[ "$lower" == *owner.json* || "$lower" == *release\ record* || "$lower" == *release_record* ]]; then owner_count=$((owner_count + 1)); fi
    if [[ "$lower" == *'git fetch'* || "$lower" == *'git checkout'* || "$lower" == *'git rev-parse'* || "$lower" == *'git status'* ]]; then
      checkout_count=$((checkout_count + 1)); (( checkout_line == 0 )) && checkout_line=$line_count
    fi
    if [[ "$lower" == *docker* || "$lower" == *docker-compose* || "$lower" == *compose* ]]; then
      runtime_count=$((runtime_count + 1)); (( runtime_line == 0 )) && runtime_line=$line_count
    fi
    if [[ "$lower" == *curl* || "$lower" == *healthz* || "$lower" == *livez* ]]; then
      health_count=$((health_count + 1)); (( health_line == 0 )) && health_line=$line_count
    fi
    if [[ "$lower" == *rollback* || "$lower" == *old_sha* || "$lower" == *new_sha* ]]; then
      rollback_count=$((rollback_count + 1)); (( rollback_line == 0 )) && rollback_line=$line_count
    fi
    if [[ "$lower" == *database_url* || "$lower" == *password* || "$lower" == *token* || "$lower" == *secret* || "$lower" == *private_key* || "$lower" == *.env* || "$lower" == *--env* ]]; then
      sensitive_count=$((sensitive_count + 1))
    fi
  done < "$WRAPPER_PATH"
  local scan="$lock|$mkdir_count|$owner_count|$checkout_count|$runtime_count|$health_count|$rollback_count|$sensitive_count|$lock_line|$mkdir_line|$checkout_line|$runtime_line|$health_line|$rollback_line|$line_count|0"
  if ! capture_command sha256sum -- "$WRAPPER_PATH"; then
    emit_evidence wrapper_identity UNKNOWN 'wrapper changed or SHA-256 recheck failed'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper scan was not stable'
    return
  fi
  digest_after=${CAPTURE_OUTPUT%% *}
  if [[ "$digest_before" != "$digest_after" ]]; then
    emit_evidence wrapper_identity UNKNOWN 'wrapper changed during read-only inspection'
    emit_evidence wrapper_control_flow UNKNOWN 'wrapper scan was not stable'
    return
  fi
  emit_evidence wrapper_identity PASS "sha256=$digest_before owner_uid=$owner_uid owner_gid=$owner_gid mode=$mode bytes=$size path_ref=$(safe_path_digest "$WRAPPER_PATH")"
  if (( lock > 0 && mkdir_count > 0 && owner_count > 0 && mkdir_line >= lock_line )); then
    emit_evidence wrapper_control_flow PASS "canonical_lock_markers=$lock atomic_lock_markers=$mkdir_count owner_record_markers=$owner_count checkout_markers=$checkout_count runtime_markers=$runtime_count health_markers=$health_count rollback_markers=$rollback_count redacted_sensitive_lines=$sensitive_count line_count=$line_count; content presence is not live lock-cooperation proof"
  else
    emit_evidence wrapper_control_flow UNKNOWN "canonical_lock_markers=$lock atomic_lock_markers=$mkdir_count owner_record_markers=$owner_count checkout_markers=$checkout_count runtime_markers=$runtime_count health_markers=$health_count rollback_markers=$rollback_count redacted_sensitive_lines=$sensitive_count line_count=$line_count; controlled review required"
  fi
}

inspect_permissions() {
  local uid gid user groups
  if ! capture_command id -u; then emit_evidence operator_identity UNKNOWN 'effective UID unavailable'; return; fi
  uid=$CAPTURE_OUTPUT
  if ! capture_command id -g; then emit_evidence operator_identity UNKNOWN 'effective GID unavailable'; return; fi
  gid=$CAPTURE_OUTPUT
  if ! capture_command id -un; then emit_evidence operator_identity UNKNOWN 'effective username unavailable'; return; fi
  user=$CAPTURE_OUTPUT
  if ! capture_command id -G; then groups=unknown; else groups=$CAPTURE_OUTPUT; fi
  if [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && "$user" =~ ^[A-Za-z0-9._-]+$ && "$groups" =~ ^[0-9[:space:]]+$ ]]; then
    local group_count
    group_count=$(printf '%s\n' "$groups" | awk '{print NF}')
    emit_evidence operator_identity PASS "uid=$uid gid=$gid user=$user group_count=$group_count"
  else
    emit_evidence operator_identity UNKNOWN 'identity output was unexpected'
  fi
  if [[ -d "$APP_DIR" && -r "$APP_DIR" && -x "$APP_DIR" ]]; then
    emit_evidence checkout_filesystem_permission PASS 'application checkout is readable and searchable by the effective operator'
  else
    emit_evidence checkout_filesystem_permission UNKNOWN 'application checkout readability/searchability could not be established'
  fi
}

inspect_checkout() {
  if ! valid_absolute_path "$APP_DIR" || [[ ! -d "$APP_DIR" ]]; then
    emit_evidence checkout_identity UNKNOWN 'production checkout is absent or path was not safely configured'
    emit_evidence checkout_unknown_files UNKNOWN 'unknown-file inventory unavailable'
    return
  fi
  local head branch status_output
  if ! capture_command git -C "$APP_DIR" rev-parse --verify HEAD; then
    emit_evidence checkout_identity UNKNOWN 'git HEAD query failed or exceeded bound'
    emit_evidence checkout_unknown_files UNKNOWN 'unknown-file inventory unavailable'
    return
  fi
  head=$CAPTURE_OUTPUT
  if ! [[ "$head" =~ ^[0-9a-fA-F]{40}$ ]]; then
    emit_evidence checkout_identity UNKNOWN 'git HEAD output was unexpected'
    emit_evidence checkout_unknown_files UNKNOWN 'unknown-file inventory unavailable'
    return
  fi
  if ! capture_command git -C "$APP_DIR" symbolic-ref --short -q HEAD; then branch=detached_or_unknown; else branch=$CAPTURE_OUTPUT; fi
  if ! [[ "$branch" =~ ^[A-Za-z0-9._/-]{1,200}$ ]]; then branch=detached_or_unknown; fi
  if ! capture_command git -C "$APP_DIR" status --porcelain=v1 -uall --branch; then
    emit_evidence checkout_identity UNKNOWN "head=$head branch=$branch git-status=UNKNOWN"
    emit_evidence checkout_unknown_files UNKNOWN 'git unknown-file inventory command failed'
    return
  fi
  status_output=$CAPTURE_OUTPUT
  local status_digest
  status_digest=$(printf '%s' "$status_output" | sha256sum 2>/dev/null | awk '{print $1}')
  local counts
  counts=$(printf '%s' "$status_output" | awk 'BEGIN { tracked=unknown=branch=0 } /^## / { branch++ ; next } /^\?\? / { unknown++; next } { tracked++ } END { printf "%d|%d|%d", tracked,unknown,branch }')
  local tracked_count unknown_count branch_count
  IFS='|' read -r tracked_count unknown_count branch_count <<< "$counts"
  if [[ "$tracked_count" =~ ^[0-9]+$ && "$unknown_count" =~ ^[0-9]+$ && "$status_digest" =~ ^[0-9a-fA-F]{64}$ ]]; then
    if (( tracked_count == 0 )); then
      emit_evidence checkout_identity PASS "head=$head branch=$branch tracked_clean=true"
    else
      emit_evidence checkout_identity FAIL "head=$head branch=$branch tracked_clean=false tracked_change_count=$tracked_count"
    fi
    emit_evidence checkout_unknown_files PASS "untracked_count=$unknown_count inventory_sha256=$status_digest filenames_and_contents=not_emitted"
  else
    emit_evidence checkout_identity UNKNOWN 'sanitized git-status summary was unexpected'
    emit_evidence checkout_unknown_files UNKNOWN 'sanitized unknown-file inventory was unexpected'
  fi
}

inspect_runtime() {
  local list_output inspect_output process_output
  if ! capture_command docker container ls --filter status=running --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}|{{.Networks}}'; then
    emit_evidence runtime_docker UNKNOWN "docker container listing failed_or_bounded status=$CAPTURE_STATUS"
    emit_evidence runtime_identity UNKNOWN 'runtime identity unavailable'
    return
  fi
  list_output=$CAPTURE_OUTPUT
  local list_count=0
  [[ -z "$list_output" ]] || list_count=$(printf '%s\n' "$list_output" | awk 'NF { count++ } END { print count+0 }')
  if ! [[ "$list_count" =~ ^[0-9]+$ ]] || (( list_count > MAX_CONTAINERS )); then
    emit_evidence runtime_docker UNKNOWN 'running-container enumeration exceeded the configured bound or had an unexpected shape'
    emit_evidence runtime_identity UNKNOWN 'runtime identity unavailable'
    return
  fi
  local ids
  ids=$(printf '%s\n' "$list_output" | awk -F'|' 'NF { if ($1 !~ /^[0-9a-fA-F]{12,64}$/) bad=1; else printf "%s\n", $1 } END { if (bad) exit 1 }') || {
    emit_evidence runtime_docker UNKNOWN 'running-container identity output was malformed'
    emit_evidence runtime_identity UNKNOWN 'runtime identity unavailable'
    return
  }
  if [[ -n "$ids" ]]; then
    # IDs come only from the validated listing and are passed as direct argv.
    if ! capture_command docker container inspect --format '{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{.State.Pid}}|{{with index .Config.Labels "com.docker.compose.project"}}{{.}}{{end}}|{{with index .Config.Labels "com.docker.compose.service"}}{{.}}{{end}}|{{with index .Config.Labels "com.clashcookies.runtime"}}{{.}}{{end}}|{{with index .Config.Labels "com.clashcookies.environment"}}{{.}}{{end}}|{{with index .Config.Labels "com.clashcookies.revision"}}{{.}}{{end}}' $ids; then
      emit_evidence runtime_docker UNKNOWN "docker selected-metadata inspection failed_or_bounded status=$CAPTURE_STATUS"
      emit_evidence runtime_identity UNKNOWN 'runtime identity unavailable'
      return
    fi
    inspect_output=$CAPTURE_OUTPUT
  else
    inspect_output=
  fi
  if ! capture_command ps --no-headers -eo 'pid=,uid=,comm=,state=,cgroup='; then
    emit_evidence runtime_docker UNKNOWN "host process correlation failed_or_bounded status=$CAPTURE_STATUS"
    emit_evidence runtime_identity UNKNOWN 'runtime identity unavailable'
    return
  fi
  process_output=$CAPTURE_OUTPUT
  local candidate_count=0 app_count=0 canonical_count=0 host_potential=0 correlated=0 malformed=0
  local id name image state ports networks pid compose_project compose_service runtime_label environment_label revision
  while IFS='|' read -r id name image state ports networks; do
    [[ -z "$id" ]] && continue
    if ! [[ "$id" =~ ^[0-9a-fA-F]{12,64}$ && "$name" =~ ^[A-Za-z0-9_.-]{1,128}$ && "$state" =~ ^[A-Za-z0-9_.-]{1,64}$ && "$ports" != *$'\n'* && "$networks" != *$'\n'* ]]; then malformed=$((malformed + 1)); continue; fi
    candidate_count=$((candidate_count + 1))
    [[ "$name" == "clashcookies-app" ]] && app_count=$((app_count + 1))
  done <<< "$list_output"
  while IFS='|' read -r id name image state pid compose_project compose_service runtime_label environment_label revision; do
    [[ -z "$id" ]] && continue
    if [[ "$id" =~ ^[0-9a-fA-F]{12,64}$ && "$name" == "/clashcookies-app" && "$state" == "running" && "$pid" =~ ^[1-9][0-9]*$ && "$compose_project" == "" && "$compose_service" == "" && "$runtime_label" == "" && "$environment_label" == "" && "$revision" =~ ^[0-9a-fA-F]{40}$ ]]; then
      canonical_count=$((canonical_count + 1))
    fi
  done <<< "$inspect_output"
  while read -r pid _uid comm _state cgroup; do
    [[ -z "$pid" ]] && continue
    if [[ "$comm" =~ ^(node|nodejs|npm|yarn)$ ]]; then
      host_potential=$((host_potential + 1))
      if [[ "$cgroup" =~ ([0-9a-fA-F]{12,64}) && "$cgroup" == *"/docker/"* ]]; then correlated=$((correlated + 1)); fi
    fi
  done <<< "$process_output"
  if (( malformed > 0 )); then
    emit_evidence runtime_docker UNKNOWN "container_metadata_malformed_count=$malformed candidate_count=$candidate_count; raw metadata not emitted"
  else
    emit_evidence runtime_docker PASS "running_container_count=$candidate_count selected_metadata=bounded_labels_only process_args=not_collected"
  fi
  if (( canonical_count == 1 && app_count == 1 && host_potential == correlated )); then
    emit_evidence runtime_identity PASS "canonical_app_candidates=$canonical_count host_process_potentials=$host_potential correlated_container_processes=$correlated; IDs and cgroups sanitized"
  elif (( canonical_count == 0 || app_count > 1 || host_potential != correlated )); then
    emit_evidence runtime_identity FAIL "canonical_app_candidates=$canonical_count app_name_candidates=$app_count host_process_potentials=$host_potential correlated_container_processes=$correlated"
  else
    emit_evidence runtime_identity UNKNOWN "canonical_app_candidates=$canonical_count app_name_candidates=$app_count host_process_potentials=$host_potential correlated_container_processes=$correlated"
  fi
}

inspect_database() {
  local pg_service=${DISCOVERY_PG_SERVICE:-}
  local pg_host=${PGHOST:-}
  local pg_db=${PGDATABASE:-}
  local pg_user=${PGUSER:-}
  if [[ -z "$pg_service" && -z "$pg_host" && -z "$pg_db" && -z "$pg_user" ]]; then
    emit_evidence database_identity UNKNOWN 'no existing least-privilege PostgreSQL selection was configured; no connection was attempted'
    emit_evidence prisma_migration_baseline UNKNOWN 'database baseline unavailable without an existing operator-provided read-only selection'
    return
  fi
  if [[ -n "$pg_service" && ! "$pg_service" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
    emit_evidence database_identity UNKNOWN 'PostgreSQL service selector was malformed'
    emit_evidence prisma_migration_baseline UNKNOWN 'PostgreSQL service selector was malformed'
    return
  fi
  local query="BEGIN READ ONLY; SELECT current_database(), current_user, current_schema(), COALESCE(inet_server_addr()::text,''), inet_server_port(), current_setting('server_version_num'), current_setting('transaction_read_only'); ROLLBACK;"
  local args=(-X -v ON_ERROR_STOP=1 -At -F '|' -c "$query")
  [[ -n "$pg_service" ]] && args+=(--dbname "service=$pg_service")
  if ! capture_command psql "${args[@]}"; then
    emit_evidence database_identity UNKNOWN "read-only identity query failed_or_bounded status=$CAPTURE_STATUS; credentials_and_connection_strings=not_emitted"
    emit_evidence prisma_migration_baseline UNKNOWN 'migration baseline not queried because database identity was unavailable'
    return
  fi
  local identity=$CAPTURE_OUTPUT db role schema address port version read_only
  IFS='|' read -r db role schema address port version read_only <<< "$identity"
  if [[ "$db" =~ ^[A-Za-z0-9_$-]{1,63}$ && "$role" =~ ^[A-Za-z0-9_$-]{1,63}$ && "$schema" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ && "$port" =~ ^[0-9]{1,5}$ && "$version" =~ ^[0-9]+$ && "$read_only" == "on" ]]; then
    emit_evidence database_identity PASS "database=$db role=$role schema=$schema server_address_class=$( [[ -z "$address" ]] && printf local || printf loopback_or_local ) server_port=$port postgres_major=$((version / 10000)) transaction_read_only=on"
  else
    emit_evidence database_identity UNKNOWN 'database identity output was missing, unexpected, or not read-only'
    emit_evidence prisma_migration_baseline UNKNOWN 'migration baseline not queried because read-only identity was not established'
    return
  fi
  local migration_query="BEGIN READ ONLY; SELECT COUNT(*) FROM \"_prisma_migrations\"; ROLLBACK;"
  args=(-X -v ON_ERROR_STOP=1 -At -c "$migration_query")
  [[ -n "$pg_service" ]] && args+=(--dbname "service=$pg_service")
  if ! capture_command psql "${args[@]}"; then
    emit_evidence prisma_migration_baseline UNKNOWN "_prisma_migrations read-only query failed_or_bounded status=$CAPTURE_STATUS"
    return
  fi
  local migration_count=$CAPTURE_OUTPUT
  if [[ "$migration_count" =~ ^[0-9]+$ ]]; then
    emit_evidence prisma_migration_baseline PASS "migration_row_count=$migration_count contents_and_connection_details=not_emitted"
  else
    emit_evidence prisma_migration_baseline UNKNOWN 'migration baseline output was unexpected'
  fi
}

inspect_health_and_capacity() {
  local endpoint status
  for endpoint in livez healthz; do
    if ! capture_command curl --silent --show-error --max-time "$MAX_COMMAND_SECONDS" --connect-timeout 2 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:8085/$endpoint"; then
      emit_evidence "health_$endpoint" UNKNOWN "localhost production endpoint probe failed_or_bounded status=$CAPTURE_STATUS"
      continue
    fi
    status=$CAPTURE_OUTPUT
    if [[ "$status" == "200" ]]; then
      emit_evidence "health_$endpoint" PASS 'fresh localhost HTTP status=200 body=not_emitted'
    elif [[ "$status" =~ ^[0-9]{3}$ ]]; then
      emit_evidence "health_$endpoint" FAIL "fresh localhost HTTP status=$status body=not_emitted"
    else
      emit_evidence "health_$endpoint" UNKNOWN 'HTTP status output was unexpected'
    fi
  done
  local root_bytes inode_bytes root_free inode_free
  if capture_command df -P -k /; then
    root_bytes=$(printf '%s\n' "$CAPTURE_OUTPUT" | awk 'NR==2 {print $4}')
  else root_bytes=unknown; fi
  if capture_command df -Pi /; then
    inode_bytes=$(printf '%s\n' "$CAPTURE_OUTPUT" | awk 'NR==2 {print $5}')
  else inode_bytes=unknown; fi
  if [[ "$root_bytes" =~ ^[0-9]+$ && "$inode_bytes" =~ ^[0-9]+%$ ]]; then
    root_free=$((root_bytes * 1024))
    inode_free=$((100 - ${inode_bytes%%%}))
    emit_evidence capacity PASS "root_free_bytes=$root_free inode_free_percent=$inode_free"
  else
    emit_evidence capacity UNKNOWN 'disk or inode capacity output was unavailable or unexpected'
  fi
}

inspect_monitoring() {
  local service port code
  for service in uptime-kuma dozzle netdata; do
    if capture_command docker container ls --filter name="clashcookies-$service" --format '{{.Names}}|{{.State}}'; then
      if [[ -n "$CAPTURE_OUTPUT" ]]; then emit_evidence "monitoring_$service" PASS 'named monitoring container metadata observed; labels and arguments not collected'; else emit_evidence "monitoring_$service" UNKNOWN 'named monitoring container was not observed'; fi
    else
      emit_evidence "monitoring_$service" UNKNOWN "monitoring container probe failed_or_bounded status=$CAPTURE_STATUS"
    fi
  done
  for port in 3001 8080 19999; do
    if capture_command curl --silent --show-error --max-time 3 --connect-timeout 2 --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/"; then
      code=$CAPTURE_OUTPUT
      if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then emit_evidence "monitoring_port_$port" PASS "localhost HTTP status=$code private_body=not_emitted"; else emit_evidence "monitoring_port_$port" UNKNOWN "localhost HTTP status=$code"; fi
    else
      emit_evidence "monitoring_port_$port" UNKNOWN "localhost monitoring probe failed_or_bounded status=$CAPTURE_STATUS"
    fi
  done
}

inspect_backup_and_staging() {
  local enabled result service_state
  if capture_command systemctl show clashcookies-backup.service --property=ActiveState,SubState,Result --value; then
    result=${CAPTURE_OUTPUT//$'\n'/|}
    service_state=${CAPTURE_OUTPUT%%$'\n'*}
    if [[ "$service_state" == active* ]]; then emit_evidence backup_service FAIL "systemd service state=$result; service was not started by this script"; else emit_evidence backup_service PASS "systemd service state=$result; service was not started by this script"; fi
  else
    emit_evidence backup_service UNKNOWN "systemd service status failed_or_bounded status=$CAPTURE_STATUS"
  fi
  if capture_command systemctl is-enabled clashcookies-backup.timer; then
    enabled=$CAPTURE_OUTPUT
    if [[ "$enabled" == enabled* ]]; then emit_evidence backup_timer FAIL 'backup timer is enabled; timer was not activated by this script'; else emit_evidence backup_timer PASS "backup timer state=$enabled; timer was not activated by this script"; fi
  else
    local code=$CAPTURE_STATUS
    if [[ "$code" == 1 ]]; then emit_evidence backup_timer PASS 'backup timer is not enabled or is inactive; timer was not activated by this script'; else emit_evidence backup_timer UNKNOWN "systemd timer status failed_or_bounded status=$code"; fi
  fi
  local staging_lines staging_digest
  staging_lines=
  for probe in "docker container ls -a --filter name=staging --format {{.Names}}|{{.State}}" "docker network ls --filter name=staging --format {{.Name}}" "docker volume ls --filter name=staging --format {{.Name}}"; do
    # The command families are fixed below; this loop never evaluates the text.
    case "$probe" in
      "docker container ls -a --filter name=staging --format {{.Names}}|{{.State}}") capture_command docker container ls -a --filter name=staging --format '{{.Names}}|{{.State}}' || true ;;
      "docker network ls --filter name=staging --format {{.Name}}") capture_command docker network ls --filter name=staging --format '{{.Name}}' || true ;;
      *) capture_command docker volume ls --filter name=staging --format '{{.Name}}' || true ;;
    esac
    if [[ -n "$CAPTURE_OUTPUT" ]]; then staging_lines+="$CAPTURE_OUTPUT"$'\n'; fi
  done
  staging_digest=$(printf '%s' "$staging_lines" | sha256sum 2>/dev/null | awk '{print $1}')
  if [[ "$staging_digest" =~ ^[0-9a-fA-F]{64}$ ]]; then
    local staging_count
    staging_count=$(printf '%s' "$staging_lines" | awk 'NF {n++} END {print n+0}')
    emit_evidence staging_residuals PASS "matching_container_network_volume_count=$staging_count inventory_sha256=$staging_digest no_resource_was_modified=true"
  else
    emit_evidence staging_residuals UNKNOWN 'staging resource probes were unavailable or unexpected'
  fi
  emit_evidence staging_waiver UNKNOWN 'staging absence/presence does not imply an approved release waiver'
}

main() {
  emit_evidence script PASS 'read-only evidence collection started; no deployment, migration, backup run, timer activation, cleanup, checkout, fetch, chmod, chown, or SSH execution is performed'
  inspect_wrapper
  inspect_permissions
  inspect_resource lock_resource "$LOCK_PATH" "directory"
  inspect_resource migration_lock_resource "$MIGRATION_LOCK_PATH" "directory"
  inspect_resource executor_resource "$EXECUTOR_PATH" "regular file"
  inspect_resource credential_resource "$CREDENTIAL_PATH" "regular file" 600
  inspect_resource release_record_resource "$RELEASE_RECORD_PATH" "regular file"
  inspect_checkout
  inspect_runtime
  inspect_database
  inspect_health_and_capacity
  inspect_monitoring
  inspect_backup_and_staging
  printf '{"schema":"%s","evidence":"summary","status":"%s","observed_at":"%s","provenance":"%s","detail":"pass_count=%d fail_count=%d unknown_count=%d actual_vm_execution_claimed=false production_resources_changed=false mutation_gate_enabled=false"}\n' \
    "$SCHEMA" "$(if (( FAIL_COUNT > 0 )); then printf FAIL; elif (( UNKNOWN_COUNT > 0 )); then printf UNKNOWN; else printf PASS; fi)" "$STARTED_AT" "$PROVENANCE" "$PASS_COUNT" "$FAIL_COUNT" "$UNKNOWN_COUNT"
}

main "$@"
