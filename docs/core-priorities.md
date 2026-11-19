Project handoff and priorities for this repo (`ClashCookies`):

> **Owner deployment decision — 2026-11-19:** The replacement broker/immutable-executor/systemd deployment project has been withdrawn. The established SSH `~/deploy-prod.sh` production workflow has been restored on `dev` by merged [PR #2086](https://github.com/tonykslee/ClashCookies/pull/2086) (`f98b2c4`). Any prior Gate 1, rootful broker, installation, restricted operator, or protected-path proposals in dated sections below are historical evidence **not current implementation or release prerequisites**. Production deployment remains disabled pending separate release approval; verify migrations, backups/recovery, current runtime and regression tests before activation.

1) Git workflow and commit standards
- Always create a feature branch before edits using:
  - `./scripts/start-feature.sh <2-4 word description>`
- Never commit directly to `main` or `dev`.
- Keep commits small, scoped, and conventional (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`).
- Before finalizing:
  - run typecheck/tests when code behavior changed
  - generate commit message
  - save to `.git/AI_COMMIT_MSG`
  - run `./scripts/commit-feature.sh`
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
