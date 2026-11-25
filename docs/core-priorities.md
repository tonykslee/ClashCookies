Project handoff and priorities for this repo (`ClashCookies`):

> **Owner deployment decision — 2026-11-19:** The replacement broker/immutable-executor/systemd deployment project was withdrawn; the existing SSH `~/deploy-prod.sh` workflow was restored by [PR #2086](https://github.com/tonykslee/ClashCookies/pull/2086) (`f98b2c4`). A reviewed and explicitly owner-approved `dev` → `main` merge automatically deploys through this established workflow. Feature code and migrations should be production-ready before merging into `dev`; current backup/recovery/runtime checks remain release-time operator verification, not a second infrastructure project. Historical Gate 1/broker proposals below are superseded.

1) Git workflow and commit standards
- For new feature work, the owner creates the feature branch before edits using:
  - `bash ./scripts/start-feature.sh "short feature description"`
- Reuse the assigned branch/PR for review corrections.
- Never commit directly to `main` or `dev`.
- Keep commits small, scoped, and conventional (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`).
- Codex completes and publishes each assigned feature slice without a separate owner publication handoff, following the [canonical workflow](ai-development-workflow.md):
  - run applicable local typecheck/tests and report any unavailable CI-only evidence
  - write `.git/AI_COMMIT_MSG` and `.git/AI_PR_BODY_CUSTOM.md`
  - run `bash ./scripts/commit-feature.sh && gh pr edit --body-file .git/AI_PR_BODY_CUSTOM.md` (use the verified actual PR number in `gh pr edit` when needed)
  - verify and report the PR URL, pushed SHA, custom description and validation status; do not bypass freshness/hooks or merge/deploy
- Avoid destructive git operations unless explicitly requested.
- **Standing documentation-only merge approval (2026-11-12):** For changes strictly limited to documentation, roadmap/vision/priorities, policy decisions, or roadmap-progress reconciliation, reuse an appropriate feature branch/PR or create one targeting `dev`, review the actual GitHub diff and mergeability/CI/review state, and **merge without requesting separate user approval**. Keep the PR audit trail; never commit directly to `dev` or `main`. Validate doc formatting and agreement vs proposal vs shipped status; do not run unrelated code tests.
- **Code-changing boundary:** That standing approval does not extend to application code, database schema/migrations, runtime configuration, deployment/infrastructure, or any production/currency issuance/fulfillment operation. These still require explicit user approval to merge or execute. Never promote `dev` to `main` implicitly.

2) Bot architecture expectations
- Preserve clear service boundaries:
  - command layer
  - domain/services
  - persistence (Prisma)
  - integrations (Discord, CoC, points site, sheets)
  - background schedulers/pollers
- Favor single ownership of state (no duplicate source-of-truth fields).
- Preserve active-vs-mirror runtime ownership:
  - active instances own upstream polling and schedulers
  - mirror instances only run guarded snapshot sync
- Prefer deterministic, idempotent flows for war events, mail, notify posts, reminders, and tracked messages.


3) Dependencies and runtime safety
- Introduce new dependencies only when justified.
- Prefer existing helpers/services before adding new abstractions.
- Keep the established production startup and deployment workflow stable; the legacy `start:runtime` applies `prisma migrate deploy` before the bot starts. Preserve health endpoints, command registration, and scheduler boot.
- Preserve current droplet deployment assumptions unless intentionally migrating again:
  - yarn-based container start
  - dependency-cache guard
  - localhost-only ops surfaces by default
- Highlight operational risks when schema, deployment, or runtime assumptions change.
- For migration-bearing releases through the original wrapper, verify representative existing-schema compatibility, backup recovery, production singleton and health behavior, and explicitly authorize the migration/restart. A code rollback does not undo committed migrations. The withdrawn broker/VM adapter is not a prerequisite for use of the existing deployment workflow.

4) Database design
- Use normalized tables over fragile JSON blobs for core logic.
- Add indexes for hot query paths and polling loops.
- Keep migrations backward-safe and explicit.
- Include pragmatic backfill/repair strategy when schema ownership changes.
- Avoid nullable/duplicate ownership fields unless intentionally transitional.

5) API/web call efficiency
- Minimize duplicate CoC, points.fwafarm, and FWAStats calls.
- Prefer cache/reuse and DB-backed reads for repeated command rendering.
- Make expensive operations explicit (`force` commands) rather than default behavior.
- Keep polling loops bounded and efficient.

6) Telemetry and observability
- Instrument key command, poller, and scheduler paths with actionable logs and telemetry rollups.
- Track API/web/cache sources and key job durations.
- Keep error paths informative (include context and reason codes).
- Keep `/livez` and `/healthz` cheap and side-effect free.
- Keep internal telemetry docs and the external droplet observability runbook aligned.

7) Unit testing requirements
- Add/update tests for all behavior changes, especially:
  - war transitions
  - idempotency guards
  - command coverage
  - parsing/validation logic
  - scheduler logic when behavior changes
- Keep tests deterministic and isolated from external APIs.
- Ensure `npm test` and `npx tsc --noEmit` pass before handoff when code changes warrant them.

8) Code quality and comments
- Add descriptive function-level comments for all functions (purpose-oriented, concise).
- Prioritize code reuse over copy/paste logic.
- Refactor duplicated business rules into shared helpers/services.
- Keep implementations efficient and easy to trace.

9) Documentation expectations
- Update `README.md` for every user-facing feature or major architectural, runtime, or platform change.
- Keep setup, deploy, and observability runbooks accurate when migrations, scheduler ownership, or health endpoints change.
- Update `docs/architecture-contract.md` and `docs/project-brain.md` when ownership boundaries or runtime flows change.
- Always update `/help` docs, permission targets, and command references when command behavior changes.
- Keep `docs/commands.md` and command coverage tests in sync.

10) Command discoverability and access control
- Always update `/help` docs when adding or changing command behavior.
- Always update permission targets (`/permission`) for new commands/subcommands.
- Keep `docs/commands.md` and command coverage tests in sync.

Working style:
- Be pragmatic, concise, and explicit about assumptions/tradeoffs.
- Implement changes end-to-end (code + tests + docs + command/help/permissions updates).
- If architecture drift or inconsistency is detected, call it out and propose the cleanest path forward.

11) Context transfer rule

Before implementing changes:

- Read `architecture-contract.md`
- Read `core-priorities.md`
- Verify the proposed change does not violate the architecture contract.

If a conflict exists:
- Explain the conflict
- Propose alternatives
- Wait for approval before proceeding.
