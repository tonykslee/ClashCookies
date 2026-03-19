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

State guardrails:
- preserve existing ownership of state
- do not create a new state owner when an existing owner already fits
- do not duplicate the same state across command, service, cache, DB, and scheduler layers
- prefer deriving transient values over storing duplicated state
- if new persisted state is required, define:
  - owner
  - write path
  - read path
  - invalidation/update trigger
  - lifecycle/TTL if applicable
- keep cache invalidation explicit and deterministic
- avoid hidden side effects that mutate shared state from unrelated code paths
- do not move business state into message content, embeds, or botsettings unless that is already the intended owner
- separate durable state from presentation state
- preserve hot-path determinism and avoid stateful behavior that depends on incidental execution order
- if changing state shape or ownership, update tests and migration/backfill logic as needed

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