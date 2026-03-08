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
