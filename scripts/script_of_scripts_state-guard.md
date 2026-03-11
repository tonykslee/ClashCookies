# Step 1 — Load Project Context

Run this first and read the output before implementing anything:

./scripts/codex-task.sh

This will load:

* PROJECT BRAIN
* ARCHITECTURE CONTRACT
* CORE PRIORITIES
* COMMAND SYSTEM

Follow these rules while implementing the task.

---

# Step 2 — Task Description

(Write the implementation request here)

GOAL
WHAT EXISTS TODAY
WHAT NEEDS TO CHANGE
SUCCESS CRITERIA

---

Important constraints:

* Follow the architecture rules defined in the loaded context
* Avoid monolithic files
* Prefer reusing existing helpers/services before adding command-level logic
* Extract reusable services when it cleanly reduces duplication
* Keep files small and focused
* New features should be designed to support unit testing
* Keep database logic separated from command logic
* Do not break existing commands
* Do not introduce new state owners unless the task explicitly requires it
* Preserve hot-path performance and determinism where relevant

STATE SEPARATION GUARDRAILS

For any feature that mixes interactive UI state with persisted/runtime
state, the implementation must explicitly define these layers before
writing code:

1) Authoritative live state
2) Confirmed persisted baseline
3) Temporary draft / interaction-only state

For each layer, the implementation must state:

* owner
* storage location
* allowed writers
* allowed readers
* when the state is created
* when the state is discarded

Additional required guardrails:

* UI-only draft state must never be written into authoritative tables
  or persisted message tracking before explicit confirmation.
* Background refresh flows, pollers, reopened commands, and event/log
  refresh buttons must reconstruct from authoritative persisted owners,
  never from ephemeral in-memory interaction payloads.
* If the feature compares "draft vs confirmed" to enable actions,
  the comparison key must be explicitly defined and limited to
  business-defining fields only.
* Dynamic/render-only fields such as timers, counters, points, sync
  values, and live stats must not be used as draft/confirmed equality
  inputs unless the task explicitly requires it.
* Any draft state must be scoped to the correct lifecycle identity
  (for example warId/opponentTag/startTime). If that identity changes,
  the draft must be discarded.
* A new lifecycle instance must never inherit a prior draft as an
  editable baseline.
* If a feature includes "confirm" behavior, the prompt must state
  exactly which persistence writes are allowed before confirm and which
  are allowed only after confirm.
* If a feature includes refresh behavior, the prompt must state whether
  refresh uses live state, confirmed baseline, or both, and for which
  fields.

Required tests for this class of change:

* draft state does not persist across exit/dismiss/reopen
* refresh flows ignore unconfirmed draft state
* confirm action promotes draft state to confirmed state correctly
* deleted/superseded lifecycle behavior still works
* lifecycle identity changes discard stale draft state
* authoritative tables are unchanged until confirm
* action enablement/disablement keys off only the intended comparison
  fields

If these boundaries cannot be stated clearly, stop and resolve the
state ownership model before implementing.

If the task changes command behavior, also update any affected:

* `/help` docs/examples
* `docs/commands.md`
* command coverage/tests
* `/permission` targets where applicable

---

# Step 3 — Feature Branch

Before making any code changes, run:

./scripts/start-feature.sh <short-feature-name>

Example:

./scripts/start-feature.sh fwa-sync-validation

---

# Step 4 — Implementation

Implement the task described above.

When making changes:

* Follow existing architectural patterns
* Prefer reusable services over command-level logic
* Avoid code duplication
* Keep files small and focused
* Keep database logic separated from command logic
* Refactor only where needed to support the feature cleanly
* Preserve existing behavior outside the defined task scope

Before considering the task complete:

* Run relevant validation commands (lint/tests) for the affected scope
* Fix CI-blocking lint errors
* Do not leave touched files with avoidable lint issues

---

# Step 5 — Generate Conventional Commit Message

After implementing the changes:

Generate a Conventional Commit message summarizing the changes.

Format:

type(scope): short summary

Example:

feat(sync): implement ClanPointsSync war validation

Optional body (recommended for PR context):

feat(sync): implement ClanPointsSync war validation

- add lifecycle-based fetch gating after clan-mail confirmation
- add reason-coded points API call logging
- add tests for validation triggers and timestamp ownership

Rules:

* Use feat / fix / refactor / test / docs when appropriate
* Keep summary under 72 characters
* You may include a blank line plus bullet-point body details

Save the commit message to:

.git/AI_COMMIT_MSG

---

# Step 6 — Commit and Push

After the commit message file is created, run:

./scripts/commit-feature.sh

Notes:

- `commit-feature.sh` auto-generates `.git/AI_PR_BODY.md` from branch commits/files.
- If GitHub CLI (`gh`) is available and authenticated, it may create/update the PR description automatically.