#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
hook_path="$repo_root/.githooks"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/clashcookies-git-hooks.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

for hook_name in pre-commit commit-msg; do
  if [ ! -x "$hook_path/$hook_name" ]; then
    echo "Tracked hook is not executable: .githooks/$hook_name" >&2
    exit 1
  fi
done

git_in() {
  local repo="$1"
  shift
  git -C "$repo" "$@"
}

configure_repo() {
  local repo="$1"
  git_in "$repo" config user.name "Git Hook Test"
  git_in "$repo" config user.email "git-hook-test@example.invalid"
  git_in "$repo" config core.hooksPath .githooks
}

configure_identity() {
  local repo="$1"
  git_in "$repo" config user.name "Git Hook Test"
  git_in "$repo" config user.email "git-hook-test@example.invalid"
}

new_case() {
  local name="$1"
  case_root="$test_root/$name"
  origin="$case_root/origin.git"
  seed="$case_root/seed"
  repo="$case_root/repo"
  mkdir -p "$case_root"

  git init --bare -q "$origin"
  git init -q "$seed"
  configure_identity "$seed"
  mkdir -p "$seed/docs"
  printf '%s\n' '# test backlog' > "$seed/docs/feature-backlog.md"
  git_in "$seed" add docs/feature-backlog.md
  git_in "$seed" commit -q -m 'chore(test): initialize hook fixture'
  git_in "$seed" branch -M dev
  git_in "$seed" remote add origin "$origin"
  git_in "$seed" push -q -u origin dev

  git clone -q --branch dev "$origin" "$repo"
  # Model a fresh clone after this change has been published: tracked hooks
  # are present before start-feature.sh installs the relative hook path.
  cp -R "$hook_path" "$repo/.githooks"
  configure_repo "$repo"
  git_in "$repo" switch -q -c feature/test
}

push_seed_commit() {
  local message="$1"
  git_in "$seed" add -A
  git_in "$seed" commit -q -m "$message"
  git_in "$seed" push -q origin dev
}

expect_commit_allowed() {
  local output="$case_root/commit.log"
  if ! git_in "$repo" commit -q -m 'feat(test): local change' >"$output" 2>&1; then
    cat "$output"
    echo "Expected commit to be allowed in $case_name" >&2
    exit 1
  fi
}

expect_commit_blocked() {
  local output="$case_root/commit.log"
  if git_in "$repo" commit -q -m 'feat(test): local change' >"$output" 2>&1; then
    cat "$output"
    echo "Expected commit to be blocked in $case_name" >&2
    exit 1
  fi
  if ! grep -Eq '❌|origin/dev|upstream|history' "$output"; then
    cat "$output"
    echo "Blocked commit did not show tracked pre-commit guard output in $case_name" >&2
    exit 1
  fi
}

stage_local_change() {
  printf '%s\n' "$case_name" > "$repo/local-change.txt"
  git_in "$repo" add local-change.txt
}

case_name='git-executes-tracked-hooks'
new_case "$case_name"
stage_local_change
if git_in "$repo" commit -q -m 'not conventional' >"$case_root/commit.log" 2>&1; then
  cat "$case_root/commit.log"
  echo 'Git did not execute the tracked hooks: invalid commit unexpectedly succeeded' >&2
  exit 1
fi
if ! grep -q 'Branch is based on the latest origin/dev.' "$case_root/commit.log" || \
   ! grep -q 'Commit message must follow Conventional Commit format.' "$case_root/commit.log"; then
  cat "$case_root/commit.log"
  echo 'Git did not execute both tracked hooks' >&2
  exit 1
fi

case_name='fresh-branch-uses-exact-latest-dev'
new_case "$case_name"
printf '%s\n' 'application change on latest dev' > "$seed/src-app.ts"
push_seed_commit 'feat(test): advance application before branch start'
if ! (cd "$repo" && bash "$repo_root/scripts/start-feature.sh" 'fresh exact') >"$case_root/start.log" 2>&1; then
  cat "$case_root/start.log"
  echo 'Expected start-feature.sh to create a branch from latest origin/dev' >&2
  exit 1
fi
if [ "$(git_in "$repo" branch --show-current)" != 'feature/fresh-exact' ] || \
   [ "$(git_in "$repo" rev-parse HEAD)" != "$(git_in "$repo" rev-parse origin/dev)" ]; then
  echo 'start-feature.sh did not create the branch at exact origin/dev' >&2
  exit 1
fi

case_name='outdated-new-branch-blocked'
new_case "$case_name"
printf '%s\n' 'application change' > "$seed/src-app.ts"
push_seed_commit 'feat(test): advance application'
stage_local_change
expect_commit_blocked

case_name='backlog-only-stale-branch-allowed'
new_case "$case_name"
printf '%s\n' 'backlog-only change' >> "$seed/docs/feature-backlog.md"
push_seed_commit 'docs(backlog): update feature backlog'
stage_local_change
expect_commit_allowed

case_name='application-change-stale-branch-blocked'
new_case "$case_name"
printf '%s\n' 'application change' > "$seed/src-app.ts"
push_seed_commit 'feat(test): advance application'
stage_local_change
expect_commit_blocked

case_name='mixed-backlog-and-code-blocked'
new_case "$case_name"
printf '%s\n' 'backlog change' >> "$seed/docs/feature-backlog.md"
push_seed_commit 'docs(backlog): update feature backlog'
printf '%s\n' 'application change' > "$seed/src-app.ts"
push_seed_commit 'fix(test): advance application'
stage_local_change
expect_commit_blocked

case_name='reverted-code-change-blocked'
new_case "$case_name"
printf '%s\n' 'application change' > "$seed/src-app.ts"
push_seed_commit 'feat(test): add application change'
git_in "$seed" revert --no-edit HEAD >/dev/null
git_in "$seed" push -q origin dev
stage_local_change
expect_commit_blocked

case_name='merge-commit-application-change-blocked'
new_case "$case_name"
git_in "$seed" switch -q -c upstream-side
printf '%s\n' 'application change from merged branch' > "$seed/src-app.ts"
git_in "$seed" add src-app.ts
git_in "$seed" commit -q -m 'feat(test): change application on side branch'
git_in "$seed" switch -q dev
git_in "$seed" merge -q --no-ff --no-edit upstream-side
git_in "$seed" push -q origin dev
stage_local_change
expect_commit_blocked

case_name='older-merged-side-branch-code-revert-blocked'
new_case "$case_name"
initial_sha="$(git_in "$seed" rev-parse dev)"
printf '%s\n' 'backlog change before older side branch merge' >> "$seed/docs/feature-backlog.md"
push_seed_commit 'docs(backlog): advance feature backlog before side branch'
git_in "$seed" switch -q -c older-side "$initial_sha"
printf '%s\n' 'older application change' > "$seed/src-app.ts"
git_in "$seed" add src-app.ts
git_in "$seed" commit -q -m 'feat(test): add older side branch application change'
git_in "$seed" revert --no-edit HEAD >/dev/null
git_in "$seed" switch -q dev
git_in "$seed" merge -q --no-ff --no-edit older-side
git_in "$seed" push -q origin dev
stage_local_change
expect_commit_blocked

case_name='unverifiable-history-blocked'
new_case "$case_name"
git_in "$repo" remote set-url origin "$case_root/missing-origin.git"
stage_local_change
expect_commit_blocked

case_name='custom-hooks-path-preserved'
new_case "$case_name"
custom_hooks_path="$case_root/custom-hooks"
mkdir -p "$custom_hooks_path"
git_in "$repo" config core.hooksPath "$custom_hooks_path"
custom_hooks_before="$(git_in "$repo" config --get core.hooksPath)"
if (cd "$repo" && bash "$repo_root/scripts/install-git-hooks.sh") >"$case_root/install.log" 2>&1; then
  cat "$case_root/install.log"
  echo 'Installer unexpectedly replaced a custom core.hooksPath' >&2
  exit 1
fi
if [ "$(git_in "$repo" config --get core.hooksPath)" != "$custom_hooks_before" ]; then
  echo 'Installer changed the custom core.hooksPath after refusing installation' >&2
  exit 1
fi

case_name='legitimate-dev-merge-completes'
new_case "$case_name"
printf '%s\n' 'local feature change' > "$repo/feature.txt"
git_in "$repo" add feature.txt
git_in "$repo" commit -q -m 'feat(test): add feature change'
printf '%s\n' 'application change from dev' > "$seed/src-app.ts"
push_seed_commit 'feat(test): advance application on dev'
git_in "$repo" fetch -q origin dev
if ! git_in "$repo" merge --no-edit origin/dev >"$case_root/merge.log" 2>&1; then
  cat "$case_root/merge.log"
  echo "Expected legitimate origin/dev merge to complete" >&2
  exit 1
fi

case_name='ordinary-commit-message-enforced'
new_case "$case_name"
stage_local_change
if git_in "$repo" commit -q -m 'not conventional' >"$case_root/commit.log" 2>&1; then
  cat "$case_root/commit.log"
  echo 'Expected non-Conventional ordinary commit to be blocked' >&2
  exit 1
fi
if ! git_in "$repo" commit -q -m 'feat(test): conventional message' >"$case_root/commit-valid.log" 2>&1; then
  cat "$case_root/commit-valid.log"
  echo 'Expected Conventional ordinary commit to be allowed' >&2
  exit 1
fi

echo 'Git hook regression scenarios passed.'
