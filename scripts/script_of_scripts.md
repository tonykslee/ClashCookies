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