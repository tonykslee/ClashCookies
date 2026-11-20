> **Established automatic deployment restored:** The GitHub Actions `main` push workflow invokes the existing droplet `~/deploy-prod.sh` via SSH. The withdrawn broker, replacement executor, new privileged operator and separate systemd installation are not used. Only explicitly owner-approved merges of reviewed production-ready `dev` code into `main` should trigger this deployment. The legacy runtime runs `prisma migrate deploy` at startup; schema-bearing changes require representative testing before merging to `dev` and current backup/recovery and production health checks at release time. No production deployment occurs merely by merging this workflow PR into `dev`.

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

Non-migration deploys are near-zero downtime, not true zero downtime. The
version-controlled procedure is `ops/deploy/deploy-prod.sh`; the live
`~/deploy-prod.sh` wrapper remains a separately approved VM artifact.

Flow:

1. Capture `OLD_SHA` from the current checkout.
2. Fetch the target branch tip into `NEW_SHA`.
3. Diff `OLD_SHA..NEW_SHA` for `prisma/migrations/**` and `prisma/schema.prisma`.
4. If no Prisma files changed, create a temporary worktree and build the target in a build-only container.
5. The candidate build receives no production env file, database URL, production network, Discord credentials, active polling mode or startup helper; it cannot log in, register commands, run migrations or start schedulers.
6. Stop the old app only after the candidate build succeeds and the singleton guard still observes exactly one active runtime.
7. Before stopping the old app, copy its exact `dist` and dependency artifacts into owner-labeled rollback volumes. Start the canonical app on the normal port with the candidate's immutable dependency and `dist` volumes, using the normal production env and active polling mode.
8. Verify the canonical app returns HTTP 200 from `/healthz` before reporting success.
9. If canonical start or health fails, retain bounded diagnostics, remove only the deployment-owned failed container, reset to `OLD_SHA`, and restore the old app through the same readiness gate.

The default promotion and rollback readiness budget is 1,500 seconds (25
minutes), calibrated above the observed 12–13 minute cold start. Every probe
has a five-second `curl --max-time` bound. The budget and per-request bound
are overrideable for an operator rehearsal through environment variables, and
the procedure logs both values. The build-only candidate compiles with the
worktree's real `/app/dist` path and copies the verified result into a
separate artifact volume; this avoids deleting a Docker mountpoint while
preserving clean-build behavior. The generated dependency and `dist` volumes
are reused by promotion, so the canonical container does not rebuild the
identical target source. Rollback uses the exact artifact snapshot captured
from the previously running container and verifies its release SHA before
starting it.

Deployment-owned artifact volumes carry explicit labels for release and role.
After a successful promotion or rollback, only detached, verified volumes
owned by this deployment are eligible for cleanup. The live release and the
known-good rollback release are retained. Diagnostic state and bounded logs
are kept in a `0700` directory with `0600` files; preexisting paths are
validated for ownership, type and symlink safety.

No pre-promotion application container is started. This is intentional:
`/healthz` remains the full Discord-plus-database readiness gate for the
canonical production runtime, while the build-only validation cannot be
mistaken for application readiness.

### Prisma migration deploy

If the `OLD_SHA..NEW_SHA` diff includes `prisma/migrations/**` or `prisma/schema.prisma`, deploy uses the intentional downtime path.

Flow:

1. Capture `OLD_SHA` and `NEW_SHA`.
2. Detect Prisma changes from the diff.
3. Stop the old app first.
4. Start the new app through the normal startup path so `prisma migrate deploy` runs.
5. Verify the canonical app returns HTTP 200 from `/healthz`.
6. If the startup or health check fails, the deploy exits nonzero after cleanup.

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

## Deployment Notes

- **Backup release gate (observed Nov 15):** A real encrypted off-host backup and separate disposable PostgreSQL 17 restore were operator-verified. Freshness, recovery custody, staging waiver, and the migration-bearing release still require explicit review/approval. The backup timer remains disabled.

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
