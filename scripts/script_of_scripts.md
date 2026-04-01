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

Immediately verify:
- `git branch --show-current` matches the new feature branch
- `git status --short --branch` shows the new branch
- if the branch did not change, stop and fix it before any edits

Do not continue to Step 3 until the branch is confirmed.


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