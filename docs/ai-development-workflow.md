# ClashCookies — Canonical AI Development Workflow

**Owner:** Rising Dawn / Dusk development
**Repository:** `tonykslee/ClashCookies` · **base branch:** `dev`
**Local operator environment:** Windows **Command Prompt** at `C:\Projects\ClashCookies>`
**Applies to:** ChatGPT, Codex, and other AI-assisted development and PR review.

> This is the versioned, **unabridged AI collaboration workflow**. A short ChatGPT Project-instructions bootstrap points here. It does **not** supersede domain architecture, security boundaries, or roadmap decisions. Read the latest `dev` version, not a stale copy. The GitHub URL is a pointer, not an automatic import: explicitly retrieve and read this file each new development session. If GitHub access is unavailable, disclose that and request the current document rather than claiming it was read.

## 1. Source of truth and diagnosis

- **Before proposing code changes**, inspect the relevant implementation and latest `dev` copies of `docs/project-brain.md`, `docs/architecture-contract.md`, `docs/core-priorities.md`, and `docs/observability.md`. Check focused documents/tests and verify shipped behavior.
- For **Duskits, rewards, or alliance transfers**, first read `docs/roadmaps/dusk-economy.md` from GitHub `dev`, then `docs/diagnostics/dusk-reward-evidence.md`, `docs/diagnostics/dusk-historical-earnings-simulation.md`, and newer relevant diagnostics. The roadmap governs priorities and status. Clearly separate **agreed**, **proposed**, **observed**, and **implemented**.
- Diagnose **state ownership, evidence provenance, and edge cases**. Prefer the smallest change with targeted regression tests.
- After merged code, reconcile the roadmap and decision log against what actually shipped; planned work is not shipped work. Preserve unresolved evidence and operational caveats.

## 2. Development and PR workflow

1. Identify the existing local branch, working-tree status, related PRs and current `dev`. Reuse an appropriate existing branch/PR; **never create a duplicate**. Start a feature branch from current `dev` only if needed. Never rerun `start-feature.sh` on an existing feature branch.
2. Give Codex **one focused task** containing: **goal; verified diagnosis; files to inspect; required changes; architecture/safety constraints; acceptance criteria; targeted validation; branch state; commit/push/PR steps**.
3. Implement one task without unrelated refactoring. Preserve idempotency, state ownership, active/mirror boundaries, production stability, and existing behavior.
4. Before committing, check branch, working-tree status, staged diff and validation. Commit only after checks pass. Push and create **one PR targeting `dev`**; reuse a PR already opened by Codex or scripts.
5. Review the **actual GitHub PR diff through the GitHub connector**, not only Codex summaries, local diffs, or test reports. Inspect risk paths and missing regression cases; post actionable findings on the **same PR** and re-review amended commits. Never require the user to paste lengthy diffs.
6. Check final PR commit SHA, mergeability, CI and review threads. **Never auto-merge code.** Merge only after explicit user approval. Confirm what merged, then reconcile roadmap milestones through an appropriate docs PR.
7. **Do not automatically merge `dev` into `main`.** Release promotion is a separate reviewed decision: check divergent histories, diff, migrations, deployment risk, CI and health-gated rollout first.
8. **Standing documentation-only merge approval:** For docs-only roadmap/vision/priorities, policy decisions, or shipped-progress reconciliation, a reviewed PR targeting `dev` may be merged without separate user approval. Check actual diff, consistency, CI/mergeability and review state. This does **not** authorize schema/migration/code/runtime/deploy/issuance changes. Do not commit directly to `dev`.

## 3. Validation: fast and proportional

- Isolated TypeScript change: focused Vitest file(s), `npx tsc --noEmit`, ESLint on changed TS files, `git diff --check`. Provide **one CMD-copyable physical line** joining checks with `&&`.
- Docs-only: inspect exact diff, formatting and consistency; do not run unrelated code tests.
- High-risk war/CWL/sync/mail, shared infrastructure, migrations, schedulers, active/mirror or deploy work: add focused integration/regression checks.
- **Before merging a code-changing PR:** run full `npm test` once locally or verify green CI, plus full lint/build when warranted. Avoid repeating the full suite; rerun proportionately after amendments.
- Investigate failures: do **not** weaken assertions or increase timeouts merely to force green checks. Distinguish nonfatal warnings from failures. Test *valid* and *fail-closed* edge cases, including mixed evidence within one war.
- For **Prisma ledger** changes, test idempotent replays, source ownership, concurrency, first-row initialization races and rollback boundaries against disposable PostgreSQL where feasible. Mocked unit tests are **not** proof of real database concurrency or trigger behavior.
- For a **new database migration**, validate on a safe representative **existing-schema** database before any production release. A fresh-schema or isolated-migration test does not establish complete deployment-chain compatibility. Record pre-existing historical migration blockers separately; do not silently rewrite them.
- **Production release and recovery gates:** Green CI, mergeability, representative migration tests, and a local dump are necessary evidence, not release authorization. Before promoting to `main`, verify a recent encrypted **off-host** backup by retrieval and disposable restore with compatible PostgreSQL tooling; recovery-key custody and retention/alerting; actual deploy account, script and checkout state; production health/monitoring; staging mirror separation or explicit waiver; and a documented, tested migration-failure recovery path. Code rollback to `OLD_SHA` does **not** undo committed database migrations. Record each PASS/BLOCKED gate and obtain explicit release approval.

## 4. Windows CMD is mandatory

- Default local environment is **CMD**, not PowerShell or Bash. Give **one full command per copyable block**, with combined operations on **one physical line** using `&&`.
- Use `%VARIABLE%`, CMD-compatible quoting and paths. Never provide `$(...)`, `export`, `$env:`, heredocs or multiline paste commands for CMD.
- Run repository `.sh` scripts via `"C:\Program Files\Git\bin\bash.exe" ./scripts/<script>.sh`. Use `start-feature.sh` only when actually creating a new branch.
- Identify commands as **local Windows CMD**, **Codex**, or **remote Linux/psql**. SQL blocks may be multiline if already inside remote `psql`.
- For commit messages, e.g. `echo fix(scope): description > .git\AI_COMMIT_MSG`. Verify branch/status/staged diff/checks **before** invoking commit scripts.

## 5. VM, SSH and historical database access

- Production is an Ubuntu droplet with Docker/PostgreSQL. The bot's **production active** runtime owns polling/writes; **staging mirror** must not poll, issue rewards or mutate production-owned state. Preserve health-gated deployment and rollback.
- **Do not assume ChatGPT or Codex has VM, Docker, SSH or database access.** GitHub access does not imply VM access. Codex may lack keys, networking, environment or a listener; report blockers rather than inventing results.
- Interactive Linux `tilo` may run `sudo docker`; SSH user `codex` has no assumed sudo/Docker privileges. **Never expand VM/DB permissions merely for diagnostics.**
- **Operator-observed production baseline (2026-11-14):** For backup, droplet, PostgreSQL role/authentication, staging decommissioning, Netdata removal, disk cleanup and dedicated backup tools, **read [`docs/diagnostics/backup-operator-preflight-2026-11-14.md`](diagnostics/backup-operator-preflight-2026-11-14.md) and [`ops/backup/README.md`](../ops/backup/README.md)** before proposing host/DB operations. It records a scoped production backup DB-role/grant operation that the user **approved but has not executed**. Treat this as dated operator evidence, not proof of backup/recovery or permission for unrelated production actions; recheck live state.
- **Backup automation activation boundary:** Merged/green backup code does not mean encrypted off-site backups exist or are restorable. Keep backup schedules disabled until an authorized operator validates least-privilege database and OS identities, service-account secret-file access, matching `pg_dump` major version, off-host key custody, object-retention/lifecycle rules, alerting, and a successful retrieval/decrypt/disposable-restore test. Do not upload or alter historical backups, grant credentials, or enable timers based solely on design or code-merge approval.
- The existing `clashcookies_dusk_readonly` PostgreSQL role has narrowly scoped **SELECT-only** grants. Verify role, grants and read-only transaction. The operator executes approved queries; no DB writes, schema changes, backfill, payouts or runtime changes.
- Existing Windows SSH tunnel forwards `127.0.0.1:15432` to localhost-only Postgres; verify it remains active. Keep private `%USERPROFILE%\dusk-simulation.env` **outside** the repo and load with `--env-file="%USERPROFILE%\dusk-simulation.env"`. Never reveal/commit credentials or SSH keys. Do not use the normal bot DB role for simulation.
- Historical samples must specify **guild, complete UTC-week window and fixed `--snapshot`**. Keep aggregate reports only; compare repeat runs and record code commit. Distinguish source updates from proven corrections; classify missing or contradictory evidence **UNKNOWN**. A fixed snapshot does not freeze the database.
- The historical simulator is **manual and read-only**, not a background job. Fixture tests alone are insufficient: run and review a bounded real sample.

## 6. Duskits and alliance mobility constraints

- Duskits is a proposed hybrid service/performance currency. **One Discord identity = one wallet across linked CoC accounts.** Operational tables own evidence, **not currency**: separate policy, ledger, redemption and transfers.
- Reward only **verifiable evidence**; missing/ambiguous data remains **UNKNOWN**. Deduplicate by authoritative persisted keys. No retroactive payouts or issuance without explicit approval.
- **Clean-FWA historical rosters are not proven complete** merely because 50 rows exist or timestamps match. Never bypass independent roster completeness, historical identity, evaluation or attribution gates.
- Draft rates, **30-Duskit** cap, **100-Duskit** personal-entry target, sponsorship and transfer incentives must remain **provisional unless explicitly ratified**. Do not inflate rates to compensate for weak participation. Elle's giveaway approval is **in principle only**, not automated-fulfillment approval. For newer agreed details (e.g., giveaway price), read the latest roadmap and distinguish that agreement from provisional reward rates.
- Transfers require consent and verified physical membership/composition. Never force moves, auto-kick or silently alter Home. No staging payouts, automatic redemptions or interference with core war/mail/sync.
- After merged PRs, update roadmap checkboxes, evidence, blockers and decisions based on **verified shipped behavior**, not intent. Detailed specs belong in repo docs.
- **Private wallet / Discord UX:** For commands that must remain private, check **both** slash-command visibility registration and the global interaction response wrapper. Ensure no generic **Post to Channel** button can leak sensitive wallet/history embeds; test the real interaction listener, not only direct command mocks.
- Member self-view uses the invoking Discord identity; never accept arbitrary target-user input on self-view commands. Audit and wallet adjustments are separate admin-only authorization boundaries. A clan leader permitted to consume giveaway roles does not gain wallet-adjustment power.
- Admin technical corrections must be traceable through append-only provenance, with actor/reason/source/transaction identity and fail-closed behavior; never silently edit/delete ledger history.

## 7. Response style and access honesty

- Be concise, practical and precise. Prefer direct GitHub PR review, focused tests, CMD-safe commands and accurate access limitations over speculation.
- Preserve one focused Codex task and one PR per slice. Do not promise background work, deploy, or merge without the required approval.
- If a workflow depends on an unavailable tool/access, state the blocker and give the safe operator next action rather than pretending it ran.
- Treat a ChatGPT Project-instructions link as a **mandatory read instruction**, not as proof that the file was automatically loaded. At the start of each substantive new development session, retrieve the latest `dev` version of this file and the task-relevant source-of-truth docs; if unavailable, disclose the limitation.

---
**Maintenance:** Update this workflow when a **reusable cross-task lesson** is established. Put feature-specific implementation details in their domain docs/tests, not here. Keep the short ChatGPT Project bootstrap minimal and under its character limit; this versioned file is the fuller source of workflow truth.
