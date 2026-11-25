#!/usr/bin/env bash
set -u

scenario="${1:?scenario required}"
deploy_script="${2:?deployment script required}"
root="${DEPLOY_TEST_ROOT:-$(mktemp -d)}"
app_dir="${root}/app"
replacement_dir="${app_dir}-replacement"
bin_dir="${root}/bin"
volume_dir="${root}/volumes"
container_dir="${root}/containers"
state_file="${root}/state"
mounts_file="${root}/mounts"
log_file="${root}/commands.log"
output_file="${root}/output.log"
probe_file="${root}/probes"
resource_file="${root}/resources"
mkdir -p "$app_dir/dist" "$app_dir/node_modules" "$bin_dir" "$volume_dir" "$container_dir"
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
printf 'mem_available_mib=8192\nswap_total_mib=2048\nswap_free_mib=2048\nload_per_cpu_percent=0\nhost_pid_max=50000\nhost_pid_count=100\n' > "$resource_file"
if [ "$scenario" = insufficient-resources ]; then
  printf 'mem_available_mib=512\nswap_total_mib=2048\nswap_free_mib=0\nload_per_cpu_percent=99\nhost_pid_max=100\nhost_pid_count=95\n' > "$resource_file"
fi
if [ "$scenario" = malformed-resources ]; then
  printf 'mem_available_mib=8192\nswap_total_mib=2048\nswap_free_mib=2048\nload_per_cpu_percent=0\nhost_pid_max=not-a-number\nhost_pid_count=100\n' > "$resource_file"
fi
if [ "$scenario" = contradictory-resources ]; then
  printf 'mem_available_mib=8192\nswap_total_mib=2048\nswap_free_mib=4096\nload_per_cpu_percent=0\nhost_pid_max=100\nhost_pid_count=101\n' > "$resource_file"
fi

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
      if [ "$DEPLOY_TEST_SCENARIO" = cleanup-failure ]; then
        log worktree-remove-failure
        exit 1
      fi
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
container_meta() { printf '%s/%s.meta' "$DEPLOY_TEST_CONTAINER_DIR" "$1"; }
volume_field() { sed -n "s/^$2=//p" "$(volume_meta "$1")"; }
container_field() { sed -n "s/^$2=//p" "$(container_meta "$1")"; }
set_volume_ready() {
  local volume="$1" revision="$2"
  [ -f "$(volume_meta "$volume")" ] || return 1
  sed -i "s/^ready=.*/ready=1/; s/^content_revision=.*/content_revision=${revision}/" "$(volume_meta "$volume")"
}

case "${1:-}" in
  volume)
    case "${2:-}" in
      create)
        deploy= owner= environment= attempt= revision= role= name=""
        shift 2
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --label) value="$2"; shift 2; case "$value" in com.clashcookies.deploy=*) deploy="${value#*=}" ;; com.clashcookies.deploy.owner=*) owner="${value#*=}" ;; com.clashcookies.deploy.environment=*) environment="${value#*=}" ;; com.clashcookies.deploy.attempt=*) attempt="${value#*=}" ;; com.clashcookies.revision=*) revision="${value#*=}" ;; com.clashcookies.role=*) role="${value#*=}" ;; esac ;;
            *) name="$1"; shift ;;
          esac
        done
        : "${name:=fixture-volume}"
        printf 'deploy=%s\nowner=%s\nenvironment=%s\nattempt=%s\nrevision=%s\nrole=%s\nready=0\ncontent_revision=\n' "$deploy" "$owner" "$environment" "$attempt" "$revision" "$role" > "$(volume_meta "$name")"
        printf '%s\n' "$name"
        ;;
      inspect)
        name="${@: -1}"
        [ -f "$(volume_meta "$name")" ] || exit 1
        if [[ "$*" == *".Mounts"* ]]; then
          state="$(cat "$DEPLOY_TEST_STATE")"
          if [[ "$state" == active:* ]] && [ -s "$DEPLOY_TEST_MOUNTS" ]; then cat "$DEPLOY_TEST_MOUNTS"; fi
        elif [[ " $* " == *" .Labels "* ]]; then
          if [[ "$*" == *"deploy.attempt"* ]]; then
            printf '%s|%s|%s|%s|%s|%s\n' "$(volume_field "$name" deploy)" "$(volume_field "$name" owner)" "$(volume_field "$name" environment)" "$(volume_field "$name" revision)" "$(volume_field "$name" role)" "$(volume_field "$name" attempt)"
          else
            printf '%s|%s|%s|%s|%s\n' "$(volume_field "$name" deploy)" "$(volume_field "$name" owner)" "$(volume_field "$name" environment)" "$(volume_field "$name" revision)" "$(volume_field "$name" role)"
          fi
        else
          printf '[{"Name":"%s"}]\n' "$name"
        fi
        ;;
      ls)
        for meta in "$DEPLOY_TEST_VOLUME_DIR"/*.meta; do
          [ -f "$meta" ] || continue
          if [[ " $* " == *" label=com.clashcookies.deploy.owner="* ]]; then
            [ "$(sed -n 's/^owner=//p' "$meta")" = clashcookies-deploy ] || continue
          else
            [ "$(sed -n 's/^deploy=//p' "$meta")" = artifact ] || continue
          fi
          basename "$meta" .meta
        done
        ;;
      rm)
        shift 2
        for name in "$@"; do
          if [ "$DEPLOY_TEST_SCENARIO" = workspace-cleanup-failure ] && [[ "$name" == *build-workspace* ]]; then
            log volume-remove-failure "$name"
            exit 1
          fi
          rm -f "$(volume_meta "$name")"
        done
        ;;
    esac
    ;;
  ps)
    if [ "$DEPLOY_TEST_SCENARIO" = docker-enumeration-failure ] && [[ " $* " == *" -a "* ]] && [[ " $* " == *" --format "* ]]; then
      exit 2
    fi
    if [[ " $* " == *" --filter name="* ]]; then
      requested=""
      for argument in "$@"; do case "$argument" in name=*) requested="${argument#name=}" ;; esac; done
      for meta in "$DEPLOY_TEST_CONTAINER_DIR"/*.meta; do
        [ -f "$meta" ] || continue
        name="$(sed -n 's/^name=//p' "$meta")"
        if [[ "$requested" = "^/${name}$" ]] || [ "$requested" = "$name" ]; then basename "$meta" .meta; fi
      done
    elif [[ " $* " == *" --filter id="* ]]; then
      requested=""
      for argument in "$@"; do case "$argument" in id=*) requested="${argument#id=}" ;; esac; done
      if [ -f "$(container_meta "$requested")" ]; then printf '%s\n' "$requested"; fi
    elif [[ " $* " == *" -a "* ]] && [[ " $* " == *" --format "* ]] && [[ " $* " != *" --filter volume="* ]]; then
      for meta in "$DEPLOY_TEST_CONTAINER_DIR"/*.meta; do
        [ -f "$meta" ] || continue
        container_id="$(basename "$meta" .meta)"
        printf '%s|%s|%s|%s|%s|%s|%s|%s\n' "$container_id" "$(sed -n 's/^name=//p' "$meta")" "$(sed -n 's/^deploy=//p' "$meta")" "$(sed -n 's/^owner=//p' "$meta")" "$(sed -n 's/^environment=//p' "$meta")" "$(sed -n 's/^role=//p' "$meta")" "$(sed -n 's/^attempt=//p' "$meta")" "$(sed -n 's/^revision=//p' "$meta")"
      done
    elif [[ " $* " == *" --filter volume="* ]]; then
      volume=""
      for argument in "$@"; do case "$argument" in volume=*) volume="${argument#volume=}" ;; esac; done
      state="$(cat "$DEPLOY_TEST_STATE")"
      if grep -qx "$volume" "$DEPLOY_TEST_MOUNTS" 2>/dev/null || { [[ "$state" == active:* ]] && [[ "$volume" == *"${state#active:}" ]]; }; then
        printf '%s\n' clashcookies-app
      fi
    elif [[ " $* " == *" label=com.clashcookies.deploy.owner="* ]]; then
      for meta in "$DEPLOY_TEST_CONTAINER_DIR"/*.meta; do
        [ -f "$meta" ] || continue
        [ "$(sed -n 's/^owner=//p' "$meta")" = clashcookies-deploy ] || continue
        [ "$(sed -n 's/^environment=//p' "$meta")" = prod ] || continue
        container_id="$(basename "$meta" .meta)"
        if [[ " $* " == *" -q "* ]]; then
          printf '%s\n' "$container_id"
        else
          printf '%s|%s|%s|%s|%s|%s|%s\n' "$container_id" "$(sed -n 's/^name=//p' "$meta")" "$(sed -n 's/^deploy=//p' "$meta")" "$(sed -n 's/^owner=//p' "$meta")" "$(sed -n 's/^environment=//p' "$meta")" "$(sed -n 's/^role=//p' "$meta")" "$(sed -n 's/^attempt=//p' "$meta")"
        fi
      done
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
    if [[ " $* " == *" -d "* ]] && [[ "$*" == *"com.clashcookies.deploy.owner="* ]]; then
      name=unknown; owner=; environment=; role=; attempt=; revision=unknown; memory=0; reservation=0; swap=0; cpus=0; pids=0; previous=""; dist_volume=""; node_volume=""; target_dist=""; target_node=""; expected=""
      for argument in "$@"; do
        case "$argument" in
          --name) previous=--name; continue ;;
          --label) previous=--label; continue ;;
          --memory) previous=memory; continue ;;
          --memory-reservation) previous=reservation; continue ;;
          --memory-swap) previous=swap; continue ;;
          --cpus) previous=cpus; continue ;;
          --pids-limit) previous=pids; continue ;;
          com.clashcookies.deploy.owner=*) owner="${argument#*=}" ;;
          com.clashcookies.deploy.environment=*) environment="${argument#*=}" ;;
          com.clashcookies.deploy.role=*) role="${argument#*=}" ;;
          com.clashcookies.deploy.attempt=*) attempt="${argument#*=}" ;;
          com.clashcookies.revision=*) revision="${argument#*=}" ;;
          BUILD_SHA=*) revision="${argument#*=}" ;;
          EXPECTED_BUILD_SHA=*) expected="${argument#*=}"; [ "$revision" = unknown ] && revision="${argument#*=}" ;;
        esac
        if [ "$previous" = --name ]; then name="$argument"; fi
        if [ "$previous" = memory ]; then memory="$argument"; fi
        if [ "$previous" = reservation ]; then reservation="$argument"; fi
        if [ "$previous" = swap ]; then swap="$argument"; fi
        if [ "$previous" = cpus ]; then cpus="$argument"; fi
        if [ "$previous" = pids ]; then pids="$argument"; fi
        if [ "$previous" = -v ]; then
          case "$argument" in *:/build-dist) dist_volume="${argument%%:/build-dist}" ;; *:/app/node_modules) node_volume="${argument%%:/app/node_modules}" ;; *:/target-dist) target_dist="${argument%%:/target-dist}" ;; *:/target-node-modules) target_node="${argument%%:/target-node-modules}" ;; *:/dist) target_dist="${argument%%:/dist}" ;; *:/node_modules) target_node="${argument%%:/node_modules}" ;; esac
        fi
        [ "$argument" = -v ] && previous=-v || { [ "$argument" != --name ] && [ "$argument" != --label ] && [ "$previous" != --name ] && [ "$previous" != --label ] && previous="$argument"; }
      done
      id="container-${name}"
      memory_bytes="$(case "$memory" in *g|*G) printf '%s' "$(( ${memory%?} * 1073741824 ))" ;; *m|*M) printf '%s' "$(( ${memory%?} * 1048576 ))" ;; *) printf '%s' "$memory" ;; esac)"
      reservation_bytes="$(case "$reservation" in *g|*G) printf '%s' "$(( ${reservation%?} * 1073741824 ))" ;; *m|*M) printf '%s' "$(( ${reservation%?} * 1048576 ))" ;; *) printf '%s' "$reservation" ;; esac)"
      swap_bytes="$(case "$swap" in *g|*G) printf '%s' "$(( ${swap%?} * 1073741824 ))" ;; *m|*M) printf '%s' "$(( ${swap%?} * 1048576 ))" ;; *) printf '%s' "$swap" ;; esac)"
      nano_cpus="$(awk -v value="$cpus" 'BEGIN { printf "%.0f", value * 1000000000 }')"
      printf 'name=%s\nowner=%s\nenvironment=%s\nrole=%s\nattempt=%s\ndeploy=%s\nrevision=%s\nrunning=true\nexit=0\nmemory=%s\nreservation=%s\nswap=%s\nnano_cpus=%s\npids=%s\n' "$name" "$owner" "$environment" "$role" "$attempt" "$( [ "$role" = candidate-build ] && printf candidate-build-only || printf artifact-stage )" "$revision" "$memory_bytes" "$reservation_bytes" "$swap_bytes" "$nano_cpus" "$pids" > "$(container_meta "$id")"
      if [[ "$*" == *" npm run build "* ]]; then
        printf 'BUILD %s\n' "$*" >> "$DEPLOY_TEST_LOG"
        [ "$DEPLOY_TEST_SCENARIO" != build-failure ] || { sed -i 's/^exit=.*/exit=1/' "$(container_meta "$id")"; printf '%s\n' "$id"; exit 0; }
        [ "$DEPLOY_TEST_SCENARIO" != candidate-exit-137 ] || sed -i 's/^exit=.*/exit=137/' "$(container_meta "$id")"
        [ "$DEPLOY_TEST_SCENARIO" != candidate-exit-124 ] || sed -i 's/^exit=.*/exit=124/' "$(container_meta "$id")"
        set_volume_ready "$dist_volume" "$revision" || true
        set_volume_ready "$node_volume" "$revision" || true
      elif [[ " $* " == *" /target-dist "* ]] && [[ " $* " == *" /source-dist "* ]]; then
        set_volume_ready "$target_dist" "$revision" || true
        set_volume_ready "$target_node" "$revision" || true
      elif [[ " $* " == *" EXPECTED_BUILD_SHA="* ]] && [[ " $* " != *":ro"* ]] && [[ " $* " == *" /dist "* ]]; then
        set_volume_ready "$target_dist" "$expected" || true
        set_volume_ready "$target_node" "$expected" || true
      fi
      printf '%s\n' "$id"
      if [ "$DEPLOY_TEST_SCENARIO" = interrupted-creation ] && [ "$role" = candidate-build ]; then exit 1; fi
      exit 0
    fi
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
  wait)
    id="$2"
    [ -f "$(container_meta "$id")" ] || exit 1
    if { [ "$DEPLOY_TEST_SCENARIO" = slow-candidate-build ] || [ "$DEPLOY_TEST_SCENARIO" = health-degradation ] || [ "$DEPLOY_TEST_SCENARIO" = signal-term ] || [ "$DEPLOY_TEST_SCENARIO" = signal-int ] || [ "$DEPLOY_TEST_SCENARIO" = signal-hup ]; } && [[ "$id" == *candidate* ]]; then /usr/bin/sleep 5; fi
    if [ "$DEPLOY_TEST_SCENARIO" = signal-rollback-artifact ] && [[ "$id" == *artifact* ]]; then /usr/bin/sleep 5; fi
    sed -i 's/^running=.*/running=false/' "$(container_meta "$id")"
    printf '%s\n' "$(sed -n 's/^exit=//p' "$(container_meta "$id")")"
    ;;
  stop|kill)
    id="${@: -1}"
    [ -f "$(container_meta "$id")" ] || exit 1
    sed -i 's/^running=.*/running=false/' "$(container_meta "$id")"
    ;;
  rm)
    id="${@: -1}"
    if [ "$DEPLOY_TEST_SCENARIO" = candidate-container-cleanup-failure ] && [ -f "$(container_meta "$id")" ]; then exit 1; fi
    managed_container=0
    [ -f "$(container_meta "$id")" ] && managed_container=1
    rm -f "$(container_meta "$id")"
    if [ "$id" = clashcookies-app ] || { [[ "$id" == container-* ]] && [ "$managed_container" -eq 0 ]; }; then printf '%s\n' none > "$DEPLOY_TEST_STATE"; : > "$DEPLOY_TEST_MOUNTS"; fi
    : > "$DEPLOY_TEST_PROBE_FILE" ;;
  inspect)
    name="${@: -1}"
    if [ "$DEPLOY_TEST_SCENARIO" = docker-inspection-failure ] && [[ "$*" == *"Config.Labels"* || "$*" == *"HostConfig"* || "$*" == *"State.Running"* ]]; then
      exit 2
    fi
    if [ ! -f "$(container_meta "$name")" ] && [ "$name" != clashcookies-app ]; then
      exit 1
    elif [ -f "$(container_meta "$name")" ] && [[ "$*" == *".Name"* ]]; then
      printf '/%s|%s|%s|%s|%s|%s|%s\n' "$(sed -n 's/^name=//p' "$(container_meta "$name")")" "$(sed -n 's/^deploy=//p' "$(container_meta "$name")")" "$(sed -n 's/^owner=//p' "$(container_meta "$name")")" "$(sed -n 's/^environment=//p' "$(container_meta "$name")")" "$(sed -n 's/^role=//p' "$(container_meta "$name")")" "$(sed -n 's/^attempt=//p' "$(container_meta "$name")")" "$(sed -n 's/^revision=//p' "$(container_meta "$name")")"
    elif [ -f "$(container_meta "$name")" ] && [[ "$*" == *"HostConfig.Memory"* ]]; then
      printf '%s|%s|%s|%s|%s\n' "$(sed -n 's/^memory=//p' "$(container_meta "$name")")" "$(sed -n 's/^reservation=//p' "$(container_meta "$name")")" "$(sed -n 's/^swap=//p' "$(container_meta "$name")")" "$(sed -n 's/^nano_cpus=//p' "$(container_meta "$name")")" "$(sed -n 's/^pids=//p' "$(container_meta "$name")")"
    elif [ -f "$(container_meta "$name")" ] && [[ "$*" == *"Config.Labels"* ]]; then
      printf '%s|%s|%s|%s\n' "$(sed -n 's/^owner=//p' "$(container_meta "$name")")" "$(sed -n 's/^environment=//p' "$(container_meta "$name")")" "$(sed -n 's/^role=//p' "$(container_meta "$name")")" "$(sed -n 's/^attempt=//p' "$(container_meta "$name")")"
    elif [ -f "$(container_meta "$name")" ] && [[ "$*" == *"State.Running"* ]]; then
      printf '%s\n' "$(sed -n 's/^running=//p' "$(container_meta "$name")")"
    elif [ -f "$(container_meta "$name")" ] && [[ "$*" == *"State.Status"* ]]; then
      printf '%s|%s||||0\n' "$( [ "$(sed -n 's/^running=//p' "$(container_meta "$name")")" = true ] && printf running || printf exited )" "$(sed -n 's/^exit=//p' "$(container_meta "$name")")"
    elif [[ "$*" == *".Mounts"* ]]; then
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
  if { [ "$DEPLOY_TEST_SCENARIO" = cold-start ] || [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ]; } && { [[ "$state" != active:OLD ]] || [ "$count" -ne 1 ]; } && [ "$count" -le 3 ]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = sequence ] && [ "${DEPLOY_TEST_PASS:-1}" = 3 ] && [[ "$state" != active:release-b ]]; then exit 1; fi
if { [ "$DEPLOY_TEST_SCENARIO" = health-failure ] || [ "$DEPLOY_TEST_SCENARIO" = legacy-rollback ]; } && [[ "$state" != active:OLD ]] && [[ "$state" != active:old-reviewed-sha ]]; then exit 1; fi
  if [ "$DEPLOY_TEST_SCENARIO" = rollback-cold-start ]; then
    if [[ "$state" = active:OLD ]] && [ "$count" -eq 1 ]; then
      :
    elif [[ "$state" != active:old-reviewed-sha ]]; then
      exit 1
    fi
  fi
if [ "$DEPLOY_TEST_SCENARIO" = promotion-timeout-rollback-slow ]; then
    if [[ "$state" = active:OLD ]] && [ "$count" -eq 1 ]; then
      :
    else
      [[ "$state" = active:old-reviewed-sha ]] || exit 1
      [ "$count" -gt 3 ] || exit 1
    fi
fi
if [ "$DEPLOY_TEST_SCENARIO" = rollback-failure ] && [[ "$state" != active:OLD ]]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = health-timeout ] && [[ "$state" != active:OLD ]] && [[ "$state" != active:old-reviewed-sha ]]; then exit 1; fi
if [ "$DEPLOY_TEST_SCENARIO" = health-degradation ] && [[ "$state" = active:OLD ]] && [ "$count" -ge 3 ]; then exit 1; fi
exit 0
EOF

cat > "$bin_dir/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$bin_dir/flock" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mode="$1"; shift
[ "$1" = --no-fork ] && shift
lock_file="$1"; shift
lock_dir="${lock_file}.fixture-lock"
[ "$mode" = -n ] || exit 2
mkdir "$lock_dir" 2>/dev/null || exit 1
cleanup() { rmdir "$lock_dir" >/dev/null 2>&1 || true; }
forward() { signal="$1"; kill -s "$signal" "$child" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP
set +e
"$@" &
child=$!
wait "$child"
status=$?
set -e
exit "$status"
EOF
chmod +x "$bin_dir"/*

start_deploy() {
  # Bash launches asynchronous children with SIGINT ignored.  GNU env resets
  # the inherited disposition before exec so Linux signal-int exercises the
  # wrapper's real INT trap rather than silently continuing.
  if [ "$DEPLOY_TEST_SCENARIO" = signal-int ]; then
    env --default-signal=INT bash "$deploy_script" > "$output_file" 2>&1 &
  else
    bash "$deploy_script" > "$output_file" 2>&1 &
  fi
  deploy_pid=$!
}

if [ "$scenario" = concurrent-active ]; then printf '%s\n' two > "$state_file"; fi
if [ "$scenario" = lock-busy ]; then mkdir -p "${root}/deploy.lock"; fi
if [ "$scenario" = concurrent-stale-lock ]; then
  mkdir -p "${root}/deploy.lock"
  printf 'pid=999999\nattempt=dead-attempt\n' > "${root}/deploy.lock/owner"
fi
if [ "$scenario" = diagnostic-permissions ]; then mkdir -m 755 "${root}/diagnostics"; fi
if [ "$scenario" = abandoned-attempt ]; then
  printf 'name=abandoned-candidate\nowner=clashcookies-deploy\nenvironment=prod\nrole=candidate-build\nattempt=abandoned-attempt\ndeploy=candidate-build-only\nrevision=abandoned-revision\nrunning=true\nexit=0\n' > "$container_dir/abandoned-candidate.meta"
fi
if [ "$scenario" = abandoned-artifact ]; then
  artifact_name="${BUILD_CONTAINER:-clashcookies-prod-candidate-build}-artifact-abandoned-attempt-1"
  printf 'name=%s\nowner=clashcookies-deploy\nenvironment=prod\nrole=artifact-stage\nattempt=abandoned-artifact-attempt\ndeploy=artifact-stage\nrevision=old-reviewed-sha\nrunning=true\nexit=0\n' "$artifact_name" > "$container_dir/abandoned-artifact.meta"
fi
if [ "$scenario" = legacy-candidate ]; then
  printf 'name=%s\nowner=\nenvironment=\nrole=\ncandidate=\nrevision=\nrunning=true\nexit=0\n' "${BUILD_CONTAINER:-clashcookies-prod-candidate-build}" > "$container_dir/legacy-candidate.meta"
fi
if [ "$scenario" = partial-labels ]; then
  printf 'name=%s-partial\nowner=clashcookies-deploy\nenvironment=prod\nrole=candidate-build\nattempt=partial-attempt\ndeploy=candidate-build-only\nrunning=true\nexit=0\n' "${BUILD_CONTAINER:-clashcookies-prod-candidate-build}" > "$container_dir/partial-candidate.meta"
fi
if [ "$scenario" = ambiguous-owned-resource ]; then
  printf 'name=ambiguous-candidate\nowner=clashcookies-deploy\nenvironment=prod\nrole=unknown\nattempt=ambiguous-attempt\ndeploy=unknown\nrunning=true\nexit=0\n' > "$container_dir/ambiguous-candidate.meta"
fi
if [ "$scenario" = unrelated-resource ]; then
  printf 'name=unrelated-candidate\nowner=other-tool\nenvironment=prod\nrole=candidate-build\nattempt=unrelated-attempt\ndeploy=candidate-build-only\nrunning=true\nexit=0\n' > "$container_dir/unrelated-candidate.meta"
fi

export PATH="$bin_dir:$PATH"
export APP_DIR="$app_dir" TEMP_WORKTREE="$replacement_dir" DEPLOY_LOCK_PATH="${root}/deploy.lock"
export DEPLOY_DIAGNOSTIC_DIR="${root}/diagnostics" DEPLOY_TEST_LOG="$log_file" DEPLOY_TEST_STATE="$state_file"
export DEPLOY_TEST_PROBE_FILE="$probe_file" DEPLOY_TEST_MOUNTS="$mounts_file" DEPLOY_TEST_VOLUME_DIR="$volume_dir" DEPLOY_TEST_CONTAINER_DIR="$container_dir" DEPLOY_RESOURCE_ADMISSION_FILE="$resource_file"
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
  health-degradation|signal-term|signal-int|signal-hup|signal-rollback-artifact)
    candidate_timeout=30
    ;;
  cold-start)
    promotion_timeout=601
    ;;
  rollback-cold-start)
    rollback_timeout=601
    ;;
  promotion-timeout-rollback-slow)
    candidate_timeout=3
    artifact_timeout=30
    rollback_timeout=601
    cleanup_overhead=1
    deployment_overhead=1
    outer_timeout=1000
    ;;
  unsafe-deadlines)
    outer_timeout=10
    ;;
  malformed-memory)
    export DEPLOY_CANDIDATE_MEMORY_LIMIT=1024mb
    ;;
esac
export DEPLOY_TEST_SCENARIO="$scenario" CANDIDATE_BUILD_TIMEOUT_SECONDS="$candidate_timeout" ARTIFACT_STAGE_TIMEOUT_SECONDS="$artifact_timeout"
export PROMOTION_HEALTH_TIMEOUT_SECONDS="$promotion_timeout" ROLLBACK_HEALTH_TIMEOUT_SECONDS="$rollback_timeout"
export CLEANUP_OVERHEAD_SECONDS="$cleanup_overhead" DEPLOYMENT_OVERHEAD_SECONDS="$deployment_overhead" DEPLOY_OUTER_TIMEOUT_SECONDS="$outer_timeout"
export HEALTH_POLL_INTERVAL_SECONDS=0 HEALTH_REQUEST_TIMEOUT_SECONDS=1 TARGET_REF=origin/main
export DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS=1 DEPLOY_CONTAINER_POLL_INTERVAL_SECONDS=0

set +e
if [ "$scenario" = sequence ]; then
  for pass in 1 2 3 4; do
    DEPLOY_TEST_PASS="$pass" bash "$deploy_script" >> "$output_file" 2>&1
    printf 'PASS=%s STATUS=%s\n' "$pass" "$?" >> "$output_file"
  done
  status=0
elif [ "$scenario" = cleanup-failure-retry ]; then
  DEPLOY_TEST_SCENARIO=candidate-container-cleanup-failure bash "$deploy_script" > "$output_file" 2>&1
  first_status=$?
  printf 'FIRST_STATUS=%s\n' "$first_status" >> "$output_file"
  DEPLOY_TEST_SCENARIO=candidate-container-cleanup-failure bash "$deploy_script" >> "$output_file" 2>&1
  status=$?
elif [ "$scenario" = concurrent-stale-lock ]; then
  bash "$deploy_script" > "${output_file}.one" 2>&1 & first_pid=$!
  bash "$deploy_script" > "${output_file}.two" 2>&1 & second_pid=$!
  wait "$first_pid"; first_status=$?
  wait "$second_pid"; second_status=$?
  printf 'CONCURRENT_FIRST_STATUS=%s\nCONCURRENT_SECOND_STATUS=%s\n' "$first_status" "$second_status" > "$output_file"
  cat "${output_file}.one" "${output_file}.two" >> "$output_file"
  status=0
elif [[ "$scenario" = signal-term || "$scenario" = signal-int || "$scenario" = signal-hup || "$scenario" = signal-rollback-artifact ]]; then
  export DEPLOY_LOCK_WRAPPED=1
  start_deploy
  found_candidate=0
  poll_attempts=10
  [ "$scenario" != signal-rollback-artifact ] || poll_attempts=60
  for attempt in $(seq 1 "$poll_attempts"); do
    candidate_glob="$container_dir/*candidate*.meta"
    [ "$scenario" != signal-rollback-artifact ] || candidate_glob="$container_dir/*artifact*.meta"
    for candidate_meta in $candidate_glob; do
      [ -f "$candidate_meta" ] || continue
      if [ "$scenario" = signal-rollback-artifact ] && ! grep -qx 'revision=old-reviewed-sha' "$candidate_meta"; then continue; fi
      found_candidate=1
      break
    done
    [ "$found_candidate" -eq 1 ] && break
    /usr/bin/sleep 1
  done
  [ "$found_candidate" -eq 1 ] || {
    printf 'SIGNAL_TARGET_NOT_FOUND=%s\n' "$scenario" >> "$output_file"
    kill -s TERM "$deploy_pid" >/dev/null 2>&1 || true
    wait "$deploy_pid"
    status=$?
    set -e
    printf 'STATUS=%s\n' "$status"
    printf 'OUTPUT_BEGIN\n'; cat "$output_file"; printf 'OUTPUT_END\n'
    exit 0
  }
  /usr/bin/sleep 1
  signal=TERM
  [ "$scenario" != signal-int ] || signal=INT
  [ "$scenario" != signal-hup ] || signal=HUP
  if [ "$signal" = INT ] && [[ "${OSTYPE:-}" == msys* ]]; then
    printf 'SIGNAL_DELIVERY_FALLBACK=INT_TO_TERM_ON_MSYS\n' >> "$output_file"
    signal=TERM
  fi
  kill -s "$signal" "$deploy_pid" >/dev/null 2>&1 || true
  wait "$deploy_pid"
  status=$?
else
  bash "$deploy_script" > "$output_file" 2>&1
  status=$?
fi
set -e

printf 'STATUS=%s\n' "$status"
if [ "$scenario" = signal-int ]; then
  if [ -e "${root}/deploy.lock" ]; then printf 'LOCK_RELEASED=0\n'; else printf 'LOCK_RELEASED=1\n'; fi
fi
printf 'OUTPUT_BEGIN\n'; cat "$output_file"; printf 'OUTPUT_END\n'
printf 'LOG_BEGIN\n'; cat "$log_file"; printf 'LOG_END\n'
printf 'STATE=%s\n' "$(cat "$state_file")"
printf 'CONTAINERS_BEGIN\n'; for meta in "$container_dir"/*.meta; do [ -f "$meta" ] || continue; basename "$meta" .meta; done | sort; printf 'CONTAINERS_END\n'
if [ -f "${root}/diagnostics/candidate-build.log" ]; then printf 'CANDIDATE_LOG_BEGIN\n'; cat "${root}/diagnostics/candidate-build.log"; printf 'CANDIDATE_LOG_END\n'; fi
if [ -d "${root}/diagnostics" ]; then find "${root}/diagnostics" -maxdepth 1 -type f -printf 'DIAGNOSTIC=%f MODE=%m\n' | sort; fi
printf 'VOLUMES_BEGIN\n'; for meta in "$volume_dir"/*.meta; do [ -f "$meta" ] || continue; basename "$meta" .meta; done | sort; printf 'VOLUMES_END\n'
exit 0
