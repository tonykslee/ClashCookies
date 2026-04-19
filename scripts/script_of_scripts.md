# 1) Load context
Run first:
./scripts/codex-task.sh

Use loaded context as the source of truth:
- project-brain
- architecture-contract
- core-priorities
- commands

# 2) Start branch
./scripts/start-feature.sh <short-feature-name>

Immediately after Step 2, self-verify the branch before doing any other work.

Required verification output:
- current branch name
- `git status --short --branch`
- `git rev-parse HEAD`
- `git rev-parse origin/dev`

Required verification rule:
- before any file reads, edits, or Step 3 work, `HEAD` must exactly equal `origin/dev`
- do not rely on assumption; verify with the commands above

If verification passes:
- continue automatically to Step 3 without asking me to confirm

If verification fails:
- stop Step 3
- fix it yourself by creating a fresh feature branch from the latest `origin/dev`
- rerun the verification block
- only continue once `HEAD == origin/dev`

Hard rules:
- do not ask me whether to continue if the verification passes
- do not read other files, edit files, or run Step 3 until verification has passed
- do not continue on a branch that is not based exactly on the latest `origin/dev`

# 3) Task
(Paste task here)

Required sections:
- Goal
- Current behavior
- Required change
- Acceptance criteria

Rules:
- follow loaded architecture
- reuse existing services/helpers first
- keep command logic thin
- keep DB logic out of commands
- avoid new state owners unless required
- avoid regressions outside scope
- keep changes testable
- update docs/help/permissions/tests when affected

# 4) Implement
- make the smallest clean change that satisfies acceptance criteria
- refactor only if needed to support the feature cleanly
- run relevant lint/tests for touched scope
- fix CI-blocking issues

# 5) Commit message
Write conventional commit to:
.git/AI_COMMIT_MSG

Format:
type(scope): summary

Optional body:
- key change 1
- key change 2

# 6) Commit/push
./scripts/commit-feature.sh