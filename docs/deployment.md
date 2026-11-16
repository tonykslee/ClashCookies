# Deployment and Install Links

## Deployment Model

> **Deployment-state caveat (operator-observed 2026-11-14):** The design below documents how production and optional staging/mirror deployments are intended to work. **Staging containers, database volumes and checkout have been explicitly decommissioned** to reclaim disk space, and staging is **not currently deployed**. Production app/database containers remain active and healthy. Do not assume staging exists, automatically recreate it, or claim staging-gate coverage without an explicit reviewed release decision/waiver. See [backup/droplet preflight](diagnostics/backup-operator-preflight-2026-11-14.md).

Production and staging *when provisioned* use droplet-hosted containers with health-gated promotion.

Runtime expectations:

- Production runs with `POLLING_MODE=active`.
- Staging runs with `POLLING_MODE=mirror`, `POLLING_ENV=staging`, and a production mirror source URL.
- The app exposes `/livez` and `/healthz`.
- `/healthz` is the readiness gate for deploy promotion.
- Docker container running status is not used as readiness.

## Deploy Modes

### Non-migration deploy

Non-migration deploys use a build-only candidate followed by a controlled stop/start handoff. They have a brief restart window and are not zero downtime.

Flow:

1. Capture `OLD_SHA` from the current checkout.
2. Fetch the target branch tip into `NEW_SHA`.
3. Diff `OLD_SHA..NEW_SHA` for `prisma/migrations/**` and `prisma/schema.prisma`.
4. If Prisma files changed, fail closed before stopping production. Otherwise create a temporary worktree and run dependency installation plus `npm run build` only, without production credentials, network, pollers, schedulers, startup, or migrations.
5. Refuse dirty tracked changes, unknown-file collisions, stale replacement paths, and anything other than exactly one canonical active runtime.
6. Stop the old app, check out `NEW_SHA` without deleting unknown files, and start exactly one active canonical app on the normal port.
7. Verify the canonical app returns HTTP 200 from `/healthz`.
8. If start or health fails, restore `OLD_SHA`, restart the old app, verify `/healthz`, and return nonzero even when rollback succeeds.

### Prisma migration deploy

The version-controlled procedure refuses any deployment whose `OLD_SHA..NEW_SHA` diff includes `prisma/migrations/**` or `prisma/schema.prisma`.

Flow:

1. Capture `OLD_SHA` and `NEW_SHA`.
2. Detect Prisma changes from the diff and stop with no production state change.
3. Use a separately reviewed migration deployment and recovery procedure. It must explicitly address existing-schema compatibility, migration failure handling, and the fact that code rollback does not undo committed database changes.

## Environment Matrix

| Environment | Runtime mode | Canonical health | Temporary replacement health |
| --- | --- | --- | --- |
| Staging | `POLLING_MODE=mirror`, `POLLING_ENV=staging` | `127.0.0.1:8086/healthz` | `127.0.0.1:18086/healthz` |
| Production | `POLLING_MODE=active`, `POLLING_ENV=prod` | `127.0.0.1:8085/healthz` | `127.0.0.1:18085/healthz` |

Staging mirror mode must not run the upstream pollers directly. Production continues to own active polling and schedulers.
Mirror sync also carries the finalized war-plan history tables (`WarPlanComplianceEvaluation` and `WarPlanViolation`) so staging reads stay consistent without performing local evaluation.

## Operational Notes

- Build happens inside the replacement container before `/healthz` is available.
- A cold deploy can take a long time, so deploy scripts allow a long replacement health timeout.
- The replacement container may be running while it is still building, but that does not count as ready.
- Promotion is gated on app-level `/healthz`, not Docker status.
- The final handoff still includes a brief restart window when the old app is stopped and the canonical app is started.
- Historical SyncCycle replay is a one-time compiled repair utility. Dry-run is the default and only exact persisted `ScheduledSyncPost` boundaries can be written; prep-derived times are never promoted, and no membership snapshots or Home rows are synthesized. After the normal build, inspect with `docker exec clashcookies-app node dist/scripts/backfillMembershipHistorySyncCycles.js --guild <guild-id> --syncs <range>` and apply explicitly with `docker exec clashcookies-app node dist/scripts/backfillMembershipHistorySyncCycles.js --guild <guild-id> --syncs <range> --apply`.
- Historical participation repair is a separate one-time compiled utility. Review with `docker exec clashcookies-app node dist/scripts/backfillMembershipHistoryParticipation.js --guild <guild-id> --syncs 521-553`; apply only the reviewed scope with the same command plus `--apply`. It appends reconstructable `ClanWarParticipation` rows only, never creates SyncCycles or derived/Home state, and re-reads counts after bounded writes.

## Health Endpoints

From the droplet host, use:

- Staging:
  - `curl http://127.0.0.1:8086/livez`
  - `curl http://127.0.0.1:8086/healthz`
- Production:
  - `curl http://127.0.0.1:8085/livez`
  - `curl http://127.0.0.1:8085/healthz`

`/livez` is process liveness only. `/healthz` should succeed only when the app is ready.

## Version-controlled production deployment procedure

The reviewed procedure is [ops/deploy/deploy-prod.sh](../ops/deploy/deploy-prod.sh). It keeps the existing argument-free VM contract and defaults (`/home/tilo/apps/clashcookies-prod`, `clashcookies-app`, port `8085`, `origin/main`), but it must be adopted by a separate reviewed VM-wrapper change before it controls production. This task does **not** modify `/home/tilo/deploy-prod.sh` or run a deployment.

The compatibility change for the VM entry point is:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec bash /home/tilo/apps/clashcookies-prod/ops/deploy/deploy-prod.sh "$@"
```

The wrapper change must be reviewed and installed only after this PR is accepted and the target commit is available in the production checkout. The versioned helper uses the tracked `ops/deploy/container-start.sh` and `ops/deploy/ensure-yarn-deps.sh`; it does not copy startup helpers from `/home/tilo/deploy-assets`.

### Safe non-migration rollout

1. Confirm the release is approved for production, `origin/main` is the reviewed target, the current checkout is the expected reviewed `OLD_SHA`, and the production app has exactly one active runtime named `clashcookies-app`.
2. Confirm the working tree has no tracked changes. The procedure inventories unknown files and refuses any target that would overwrite one; it never runs `git reset --hard`, `git clean`, or unconditional recursive cleanup.
3. Run the versioned script through the compatible VM wrapper. It takes an exclusive deploy lock, fetches `origin/main`, and fails closed if `prisma/schema.prisma` or `prisma/migrations/**` changed.
4. It creates a disposable Git worktree and runs only dependency installation plus `npm run build` in a build-only container. The candidate receives no `.env`, database URL, Discord credentials, production network, active polling mode, startup helper, or migration command.
5. After candidate build and safe worktree removal succeed, it stops the one existing active container, checks out `NEW_SHA` without touching unknown files, starts one labeled active production container, and verifies canonical `http://127.0.0.1:8085/healthz`.
6. A failed start or health check stops the candidate, checks out `OLD_SHA`, restarts the prior application, and verifies the same health endpoint. A successful rollback still returns nonzero so the release is visibly failed and requires review.

The script emits only bounded state, revision, container, and health-result lines. It does not print environment contents, credentials, database URLs, or build logs. Build failures are intentionally summarized rather than replaying container output.

### Operator rollback

For a non-migration release, let the script complete its automatic code rollback and confirm `rollback_result=success` plus HTTP 200 from `/healthz`. If it reports `rollback_result=failed`, do not retry blindly or perform a database rollback: keep the bot stopped or in the explicitly observed state, inspect Docker and health logs without exposing secrets, and use the separate reviewed recovery procedure. Code checkout rollback cannot undo a database migration.

Prisma changes are outside this procedure. The script refuses them before stopping production; use a separately reviewed migration deployment and recovery plan that explicitly covers the existing-schema migration chain. Automatic database rollback is not implemented.

### Residual risks and review gates

- Production health is not proven by these fixture tests. `/healthz` requires both Discord readiness and a database probe, so the operator must verify the live endpoint and observability after an approved rollout.
- Staging containers, volumes, and checkout are currently decommissioned. There is no independent staging health gate; an explicit release waiver or a separately restored isolation environment is required.
- The existing `npm run start:runtime` path runs `prisma migrate deploy`. The candidate build never invokes it, and Prisma diffs are fail-closed, but a no-diff production startup still follows the existing startup contract.
- A deploy lock prevents overlapping deploy scripts, and the active-runtime guard refuses zero or multiple active runtimes before promotion and after startup. It does not repair an independently launched process; investigate any singleton violation.
- Unknown and untracked production files are preserved. If a target collides with one, or the replacement path already exists, deployment stops for operator review rather than deleting data.
- Until the compatibility wrapper is installed, `/home/tilo/deploy-prod.sh` remains the legacy live procedure. This PR intentionally changes no VM script, application, database, credentials, timer, or backup service.

### Existing deployment notes

- **Backup release gate:** The B2 bucket, scoped credentials, and harmless encrypted test-object recovery were verified from operator CLI results on 2026-11-14 UTC, but **no actual PostgreSQL off-site restore** was performed. The backup timer remains disabled and production release stays blocked. See `ops/backup/README.md` for the provisioning evidence and preflight checklist.

- Commands are registered as guild commands using `GUILD_ID` on startup.
- If commands are missing, verify environment (`DISCORD_TOKEN`, `GUILD_ID`) and restart.
- Observability is documented separately in `docs/observability.md` and stays localhost-only by default on the droplet.
- Droplet deploys use the Yarn path (`yarn.lock`) for deterministic installs.
- The current container path uses `ops/deploy/container-start.sh`, which runs the dependency guard and then starts the app.
- `yarn start` rebuilds from `src` before launching the compiled `dist` app, and the build step cleans `dist` first so stale artifacts do not survive between deploys.

## Install Links

Prod guild install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=0&scope=bot+applications.commands

Prod user install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=1&scope=bot+applications.commands

Staging guild install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=0&scope=bot+applications.commands

Staging user install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=1&scope=bot+applications.commands
