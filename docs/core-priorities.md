Project handoff and priorities for this repo (`ClashCookies`):

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
- Keep startup and deploy behavior stable (`prisma migrate deploy`, health endpoints, command registration, scheduler boot).
- Preserve current droplet deployment assumptions unless intentionally migrating again:
  - yarn-based container start
  - dependency-cache guard
  - localhost-only ops surfaces by default
- Highlight operational risks when schema, deployment, or runtime assumptions change.

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
