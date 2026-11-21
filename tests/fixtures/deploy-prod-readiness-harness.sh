#!/usr/bin/env bash
set -u

scenario="${1:?scenario required}"
deploy_script="${2:?deployment script required}"
root="${DEPLOY_TEST_ROOT:-$(mktemp -d)}"
app_dir="${root}/app"
replacement_dir="${app_dir}-replacement"
bin_dir="${root}/bin"
volume_dir="${root}/volumes"
state_file="${root}/state"
mounts_file="${root}/mounts"
log_file="${root}/commands.log"
output_file="${root}/output.log"
probe_file="${root}/probes"
mkdir -p "$app_dir/dist" "$app_dir/node_modules" "$bin_dir" "$volume_dir"
mkdir -p "$app_dir/ops/deploy"
printf 'legacy-build\n' > "$app_dir/dist/ClashCookies.js"
printf 'legacy-dependency\n' > "$app_dir/node_modules/.fixture-dependency"
printf '%s\n' '#!/usr/bin/env bash' './ops/deploy/ensure-yarn-deps.sh' 'npm run start' > "$app_dir/ops/deploy/container-start.sh"
printf 'DISCORD_TOKEN=fixture-only\n' > "$app_dir/.env"
printf 'services:\n  app:\n    environment:\n      DATABASE_URL: postgresql://fixture\n' > "$app_dir/docker-compose.yml"
printf '%s\n' 'active:OLD' > "$state_file"
: > "$mounts_file"
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
    if [ "$DEPLOY_TEST_SCENARIO" = sequence ]; then
      case "${DEPLOY_TEST_PASS:-1}:$1" in
        1:HEAD) printf '%s\n' release-0 ;;
        1:*) printf '%s\n' release-a ;;
        2:HEAD) printf '%s\n' release-a ;;
        2:*) printf '%s\n' release-b ;;
        3:HEAD) printf '%s\n' release-b ;;
        3:*) printf '%s\n' release-c ;;
        4:HEAD) printf '%s\n' release-b ;;
        4:*) printf '%s\n' release-c ;;
      esac
    elif [ "${1:-}" = HEAD ]; then
      printf '%s\n' old-reviewed-sha
    else
      printf '%s\n' new-reviewed-sha
    fi
    ;;
  worktree)
    action="${1:-}"; shift || true
    if [ "$action" = add ]; then
      path="${@: -1}"; mkdir -p "$path"; log worktree-add
    elif [ "$action" = remove ]; then
      [ "${1:-}" != --quiet ] || { log unsupported-worktree-option; exit 129; }
      path="${@: -1}"; rm -rf -- "$path"; log worktree-remove
    fi
    ;;
  reset)
    log reset "$*"
    if [ "$DEPLOY_TEST_SCENARIO" = reset-failure ] && [[ "$*" == *new-reviewed-sha* ]]; then
      exit 1
    fi
    ;;
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
    DISCORD_TOKEN=*) safe_args+=(DISCORD_TOKEN='<redacted>') ;;
    *) safe_args+=("$argument") ;;
  esac
done
printf 'DOCKER %s\n' "${safe_args[*]}" >> "$DEPLOY_TEST_LOG"

volume_meta() { printf '%s/%s.meta' "$DEPLOY_TEST_VOLUME_DIR" "$1"; }
volume_field() { sed -n "s/^$2=//p" "$(volume_meta "$1")"; }
set_volume_ready() {
  local volume="$1" revision="$2"
  [ -f "$(volume_meta "$volume")" ] || return 1
  sed -i "s/^ready=.*/ready=1/; s/^content_revision=.*/content_revision=${revision}/" "$(volume_meta "$volume")"
}

case "${1:-}" in
  volume)
    case "${2:-}" in
      create)
        deploy= revision= role= name=""
        shift 2
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --label) value="$2"; shift 2; case "$value" in com.clashcookies.deploy=*) deploy="${value#*=}" ;; com.clashcookies.revision=*) revision="${value#*=}" ;; com.clashcookies.role=*) role="${value#*=}" ;; esac ;;
            *) name="$1"; shift ;;
          esac
        done
        : "${name:=fixture-volume}"
        printf 'deploy=%s\nrevision=%s\nrole=%s\nready=0\ncontent_revision=\n' "$deploy" "$revision" "$role" > "$(volume_meta "$name")"
        printf '%s\n' "$name"
        ;;
      inspect)
        name="${@: -1}"
        [ -f "$(volume_meta "$name")" ] || exit 1
        if [[ "$*" == *".Mounts"* ]]; then
          state="$(cat "$DEPLOY_TEST_STATE")"
          if [[ "$state" == active:* ]] && [ -s "$DEPLOY_TEST_MOUNTS" ]; then cat "$DEPLOY_TEST_MOUNTS"; fi
        elif [[ " $* " == *" .Labels "* ]]; then
          printf '%s|%s|%s\n' "$(volume_field "$name" deploy)" "$(volume_field "$name" revision)" "$(volume_field "$name" role)"
        else
          printf '[{"Name":"%s"}]\n' "$name"
        fi
        ;;
      ls)
        for meta in "$DEPLOY_TEST_VOLUME_DIR"/*.meta; do
          [ -f "$meta" ] || continue
          [ "$(sed -n 's/^deploy=//p' "$meta")" = artifact ] || continue
          basename "$meta" .meta
        done
        ;;
      rm)
        shift 2
        for name in "$@"; do rm -f "$(volume_meta "$name")"; done
        ;;
    esac
    ;;
  ps)
    if [[ " $* " == *" --filter volume="* ]]; then
      volume=""
      for argument in "$@"; do case "$argument" in volume=*) volume="${argument#volume=}" ;; esac; done
      state="$(cat "$DEPLOY_TEST_STATE")"
      if grep -qx "$volume" "$DEPLOY_TEST_MOUNTS" 2>/dev/null || { [[ "$state" == active:* ]] && [[ "$volume" == *"${state#active:}" ]]; }; then
        printf '%s\n' clashcookies-app
      fi
    else
      state="$(cat "$DEPLOY_TEST_STATE")"
      if [ "$state" = two ]; then
        printf '%s\n' 'clashcookies-app|127.0.0.1:8085->8080/tcp|active|node:20-bookworm|bash ./ops/deploy/container-start.sh'
        printf '%s\n' 'other-active|||node:20-bookworm|node dist/ClashCookies.js'
      elif [[ "$state" == active:* ]]; then
        printf '%s\n' 'clashcookies-app|127.0.0.1:8085->8080/tcp|active|node:20-bookworm|bash ./ops/deploy/container-start.sh'
      fi
    fi
    ;;
  run)
    if [[ " $* " == *" npm run build "* ]]; then
      printf 'BUILD %s\n' "$*" >> "$DEPLOY_TEST_LOG"
      [ "$DEPLOY_TEST_SCENARIO" != build-failure ] || exit 1
      if [ "$DEPLOY_TEST_SCENARIO" = slow-candidate-build ]; then
        /usr/bin/sleep 2
      fi
      revision="new-reviewed-sha"; previous=""; dist_volume=""; node_volume=""
      for argument in "$@"; do
        case "$argument" in BUILD_SHA=*) revision="${argument#*=}" ;; esac
        if [ "$previous" = -v ]; then
          case "$argument" in *:/build-dist) dist_volume="${argument%%:/build-dist}" ;; *:/app/node_modules) node_volume="${argument%%:/app/node_modules}" ;; esac
        fi
        previous="$argument"
      done
      set_volume_ready "$dist_volume" "$revision" || true
      set_volume_ready "$node_volume" "$revision" || true
      exit 0
    fi
    if [[ " $* " == *" /target-dist "* ]] && [[ " $* " == *" /source-dist "* ]]; then
      revision="unknown"; previous=""; target_dist=""; target_node=""
      for argument in "$@"; do
        case "$argument" in BUILD_SHA=*) revision="${argument#*=}" ;; esac
        if [ "$previous" = -v ]; then
          case "$argument" in *:/target-dist) target_dist="${argument%%:/target-dist}" ;; *:/target-node-modules) target_node="${argument%%:/target-node-modules}" ;; esac
        fi
        previous="$argument"
      done
      set_volume_ready "$target_dist" "$revision"
      set_volume_ready "$target_node" "$revision"
      exit 0
    fi
    if [[ " $* " == *" EXPECTED_BUILD_SHA="* ]] && [[ " $* " != *":ro"* ]] && [[ " $* " == *" /dist "* ]]; then
      revision="unknown"; previous=""; dist_volume=""; node_volume=""
      for argument in "$@"; do
        case "$argument" in EXPECTED_BUILD_SHA=*) revision="${argument#*=}" ;; esac
        if [ "$previous" = -v ]; then
          case "$argument" in *:/dist) dist_volume="${argument%%:/dist}" ;; *:/node_modules) node_volume="${argument%%:/node_modules}" ;; esac
        fi
        previous="$argument"
      done
      set_volume_ready "$dist_volume" "$revision"
      set_volume_ready "$node_volume" "$revision"
      exit 0
    fi
    if [[ " $* " == *" EXPECTED_BUILD_SHA="* ]]; then
      expected="unknown"; previous=""; dist_volume=""; node_volume=""
      for argument in "$@"; do
        case "$argument" in EXPECTED_BUILD_SHA=*) expected="${argument#*=}" ;; esac
        if [ "$previous" = -v ]; then
          case "$argument" in *:/dist:ro) dist_volume="${argument%%:/dist:ro}" ;; *:/node_modules:ro) node_volume="${argument%%:/node_modules:ro}" ;; esac
        fi
        previous="$argument"
      done
      [ "$(volume_field "$dist_volume" ready)" = 1 ] && [ "$(volume_field "$dist_volume" content_revision)" = "$expected" ]
      [ "$(volume_field "$node_volume" ready)" = 1 ] && [ "$(volume_field "$node_volume" content_revision)" = "$expected" ]
      exit 0
    fi
    if [ "$DEPLOY_TEST_SCENARIO" = legacy-rollback ] && [[ "$*" == *old-reviewed-sha* ]] && [[ "$*" == *"CLASHCOOKIES_PREBUILT=1"* ]]; then
      [[ "$*" == *"npm run start:runtime"* ]] || exit 1
      [[ "$*" != *"./ops/deploy/container-start.sh"* ]] || exit 1
      printf 'LEGACY_ROLLBACK_LAUNCHER=inline\n' >> "$DEPLOY_TEST_LOG"
    fi
    if { [ "$DEPLOY_TEST_SCENARIO" = container-failure ] || [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ]; } && [[ "$*" == *new-reviewed-sha* ]]; then exit 1; fi
    revision=unknown; name=unknown; prebuilt=0; previous=""; dist_volume=""; node_volume=""
    for argument in "$@"; do
      case "$argument" in com.clashcookies.revision=*) revision="${argument#*=}" ;; CLASHCOOKIES_PREBUILT=*) prebuilt="${argument#*=}" ;; esac
      if [ "$previous" = --name ]; then name="$argument"; fi
      if [ "$previous" = -v ]; then
          case "$argument" in *:/app/dist*) dist_volume="${argument%%:/app/dist*}" ;; *:/app/node_modules*) node_volume="${argument%%:/app/node_modules*}" ;; esac
      fi
      previous="$argument"
    done
    printf 'ACTIVE_RUN name=%s revision=%s prebuilt=%s\n' "$name" "$revision" "$prebuilt" >> "$DEPLOY_TEST_LOG"
    printf 'active:%s\n' "$revision" > "$DEPLOY_TEST_STATE"
    : > "$DEPLOY_TEST_MOUNTS"
    [ -n "$dist_volume" ] && printf '%s\n' "$dist_volume" >> "$DEPLOY_TEST_MOUNTS"
    [ -n "$node_volume" ] && printf '%s\n' "$node_volume" >> "$DEPLOY_TEST_MOUNTS"
    printf 'MOUNTS dist=%s node=%s\n' "$dist_volume" "$node_volume" >> "$DEPLOY_TEST_LOG"
    printf 'container-%s\n' "$revision"
    ;;
  rm) printf '%s\n' none > "$DEPLOY_TEST_STATE"; : > "$DEPLOY_TEST_MOUNTS"; : > "$DEPLOY_TEST_PROBE_FILE" ;;
  inspect)
    if [[ "$*" == *".Mounts"* ]]; then
      if [[ "$*" == *"/app/dist"* ]]; then
        sed -n '1p' "$DEPLOY_TEST_MOUNTS"
      fi
      if [[ "$*" == *"/app/node_modules"* ]]; then
        sed -n '2p' "$DEPLOY_TEST_MOUNTS"
      fi
    else
      printf 'running|0||2026-11-20T00:00:00Z||0\n'
    fi
    ;;
  logs) printf '[fixture] diagnostic log\n' ;;
esac
EOF

cat > "$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$DEPLOY_TEST_PROBE_FILE")"; count=$((count + 1)); printf '%s\n' "$count" > "$DEPLOY_TEST_PROBE_FILE"
state="$(cat "$DEPLOY_TEST_STATE")"
if { [ "$DEPLOY_TEST_SCENARIO" = cold-start ] || [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ]; } && [ "$count" -le 3 ]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = sequence ] && [ "${DEPLOY_TEST_PASS:-1}" = 3 ] && [[ "$state" != active:release-b ]]; then exit 1; fi
if { [ "$DEPLOY_TEST_SCENARIO" = health-failure ] || [ "$DEPLOY_TEST_SCENARIO" = legacy-rollback ]; } && [[ "$state" != active:old-reviewed-sha ]]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ] && [[ "$state" != active:old-reviewed-sha ]]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = promotion-timeout-rollback-slow ]; then
  [[ "$state" = active:old-reviewed-sha ]] || exit 1
  [ "$count" -gt 3 ] || exit 1
fi
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
if [ "$scenario" = diagnostic-permissions ]; then mkdir -m 755 "${root}/diagnostics"; fi

export PATH="$bin_dir:$PATH"
export APP_DIR="$app_dir" TEMP_WORKTREE="$replacement_dir" DEPLOY_LOCK_PATH="${root}/deploy.lock"
export DEPLOY_DIAGNOSTIC_DIR="${root}/diagnostics" DEPLOY_TEST_LOG="$log_file" DEPLOY_TEST_STATE="$state_file"
export DEPLOY_TEST_PROBE_FILE="$probe_file" DEPLOY_TEST_MOUNTS="$mounts_file" DEPLOY_TEST_VOLUME_DIR="$volume_dir"
candidate_timeout=1500
artifact_timeout=600
promotion_timeout=1
rollback_timeout=1
cleanup_overhead=300
deployment_overhead=900
outer_timeout=10800
case "$scenario" in
  slow-candidate-build)
    candidate_timeout=1
    ;;
  cold-start)
    promotion_timeout=601
    ;;
  rollback-cold-start)
    rollback_timeout=601
    ;;
  promotion-timeout-rollback-slow)
    candidate_timeout=1
    artifact_timeout=1
    rollback_timeout=601
    cleanup_overhead=1
    deployment_overhead=1
    outer_timeout=1000
    ;;
  unsafe-deadlines)
    outer_timeout=10
    ;;
esac
export DEPLOY_TEST_SCENARIO="$scenario" CANDIDATE_BUILD_TIMEOUT_SECONDS="$candidate_timeout" ARTIFACT_STAGE_TIMEOUT_SECONDS="$artifact_timeout"
export PROMOTION_HEALTH_TIMEOUT_SECONDS="$promotion_timeout" ROLLBACK_HEALTH_TIMEOUT_SECONDS="$rollback_timeout"
export CLEANUP_OVERHEAD_SECONDS="$cleanup_overhead" DEPLOYMENT_OVERHEAD_SECONDS="$deployment_overhead" DEPLOY_OUTER_TIMEOUT_SECONDS="$outer_timeout"
export HEALTH_POLL_INTERVAL_SECONDS=0 HEALTH_REQUEST_TIMEOUT_SECONDS=1 TARGET_REF=origin/main

set +e
if [ "$scenario" = sequence ]; then
  for pass in 1 2 3 4; do
    DEPLOY_TEST_PASS="$pass" bash "$deploy_script" >> "$output_file" 2>&1
    printf 'PASS=%s STATUS=%s\n' "$pass" "$?" >> "$output_file"
  done
  status=0
else
  bash "$deploy_script" > "$output_file" 2>&1
  status=$?
fi
set -e

printf 'STATUS=%s\n' "$status"
printf 'OUTPUT_BEGIN\n'; cat "$output_file"; printf 'OUTPUT_END\n'
printf 'LOG_BEGIN\n'; cat "$log_file"; printf 'LOG_END\n'
printf 'STATE=%s\n' "$(cat "$state_file")"
if [ -d "${root}/diagnostics" ]; then find "${root}/diagnostics" -maxdepth 1 -type f -printf 'DIAGNOSTIC=%f MODE=%m\n' | sort; fi
printf 'VOLUMES_BEGIN\n'; find "$volume_dir" -maxdepth 1 -name '*.meta' -printf '%f\n' | sed 's/\.meta$//' | sort; printf 'VOLUMES_END\n'
exit 0
