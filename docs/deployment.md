# Deployment and Install Links

## Deployment Model

Production and staging deploy to droplet-hosted containers with health-gated promotion.

Runtime expectations:

- Production runs with `POLLING_MODE=active`.
- Staging runs with `POLLING_MODE=mirror`, `POLLING_ENV=staging`, and a production mirror source URL.
- The app exposes `/livez` and `/healthz`.
- `/healthz` is the readiness gate for deploy promotion.
- Docker container running status is not used as readiness.

## Deploy Modes

### Non-migration deploy

Non-migration deploys are near-zero downtime, not true zero downtime.

Flow:

1. Capture `OLD_SHA` from the current checkout.
2. Fetch the target branch tip into `NEW_SHA`.
3. Diff `OLD_SHA..NEW_SHA` for `prisma/migrations/**` and `prisma/schema.prisma`.
4. If no Prisma files changed, create a temporary worktree and start a replacement container in parallel.
5. Wait for the replacement container to return HTTP 200 from `/healthz`.
6. Stop the old app only after replacement health passes.
7. Start the canonical app on the normal port.
8. Verify the canonical app returns HTTP 200 from `/healthz`.
9. If the canonical app fails health, roll back to `OLD_SHA` and restore the old app.

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

## Operational Notes

- Build happens inside the replacement container before `/healthz` is available.
- A cold deploy can take a long time, so deploy scripts allow a long replacement health timeout.
- The replacement container may be running while it is still building, but that does not count as ready.
- Promotion is gated on app-level `/healthz`, not Docker status.
- The final handoff still includes a brief restart window when the old app is stopped and the canonical app is started.

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
