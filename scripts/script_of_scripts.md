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

---

GOAL
WHAT EXISTS TODAY
WHAT NEEDS TO CHANGE
SUCCESS CRITERIA

---

Important constraints:

* Follow the architecture rules defined in the loaded context
* Avoid monolithic files
* Extract reusable services when possible
* New features should be designed to support unit testing
* Do not break existing commands

---

STATE SEPARATION GUARDRAILS

This feature must not redesign or extend the existing draft/confirm/refresh lifecycle; it must only consume the existing effective displayed state for embed color rendering.

The implementation must preserve the existing separation between:

1. authoritative live state
2. confirmed persisted baseline
3. temporary draft / interaction-only state

Additional required guardrails:

* UI-only draft state must never be written into authoritative tables or persisted message tracking before explicit confirmation.
* Background refresh flows, pollers, reopened commands, and event/log refresh buttons must continue reconstructing from authoritative persisted owners, not ephemeral interaction payloads.
* If action enablement depends on draft-vs-confirmed comparison, it must continue to key off only the intended business-defining fields.
* Dynamic/render-only fields must not become draft/confirmed equality inputs unless the implementation already requires them.
* If lifecycle identity changes, any old draft state must not be treated as the editable baseline for the new lifecycle.

Regression-test expectation for this task:

* No new tests are required for draft persistence, refresh, confirm-promotion, supersede/delete lifecycle, or lifecycle-identity discard behavior unless the implementation touches those paths.
* If the implementation touches any of those lifecycle paths, add regression coverage for the affected behavior and prove authoritative tables remain unchanged until confirm where applicable.

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

* Prefer reusable services over command-level logic
* Keep files small and focused
* Follow existing architectural patterns
* Avoid code duplication
* Keep database logic separated from command logic

If necessary, refactor existing code to support the new feature.

Before considering the task complete:
* Run relevant validation commands (lint/tests) for the affected scope
* Fix CI-blocking lint errors
* Do not leave touched files with avoidable lint issues

---

# Step 5 — Generate Conventional Commit Message

After implementing the changes:

Generate a **Conventional Commit message** summarizing the changes.

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
- `commit-feature.sh` now auto-generates `.git/AI_PR_BODY.md` from branch commits/files.
- If GitHub CLI (`gh`) is available and authenticated, it will create/update the PR description automatically.
