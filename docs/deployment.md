# Deployment and Install Links

## Current Deployment Model

The current production and staging deployments are droplet-based containerized app runtimes.

Important runtime assumptions:

- Production runs with `POLLING_MODE=active`.
- Staging runs with `POLLING_MODE=mirror`, `MIRROR_SOURCE_DATABASE_URL` set to production, and `POLLING_ENV=staging`.
- Command registration still happens at startup as guild commands using `GUILD_ID`.
- Application startup still relies on `prisma migrate deploy` through the normal start command.

## Build And Start Path

The current droplet/container path is:

1. Base image setup installs required fonts from `nixpacks.toml`.
2. Container entrypoint runs `ops/deploy/container-start.sh`.
3. The entrypoint calls `ops/deploy/ensure-yarn-deps.sh`.
4. If dependency manifests changed, it runs `yarn install --frozen-lockfile`.
5. The container then runs `yarn build` and `yarn start`.

Relevant files:

- `nixpacks.toml`
- `ops/deploy/container-start.sh`
- `ops/deploy/ensure-yarn-deps.sh`

## Active vs Mirror Runtime Ownership

Production owns upstream background work:

- activity observe loop
- war-event polling and refresh loops
- FWA feed scheduler loops
- reminder schedulers
- user-activity reminder scheduler

Staging mirror mode does not duplicate those upstream pollers. Instead it runs guarded prod-to-staging snapshot sync for the runtime allowlist.

Mirror mode safety expectations:

- never point source and target at the same database
- never run mirror sync in production
- treat mirrored tables as full-overwrite runtime copies

## Health Endpoints

The app exposes:

- `/livez` for process liveness
- `/healthz` for readiness

Default health server behavior:

- host: `0.0.0.0`
- port: `8080`
- enabled by default

Environment overrides:

- `HEALTHCHECK_ENABLED`
- `HEALTHCHECK_HOST`
- `HEALTHCHECK_PORT`
- `HEALTHCHECK_LIVE_PATH`
- `HEALTHCHECK_READY_PATH`

Recommended localhost-only port mapping on the droplet:

- Production app: `127.0.0.1:8085:8080`
- Staging app: `127.0.0.1:8086:8080`
## Deployment Notes
- Commands are registered as guild commands using `GUILD_ID` on startup.
- If commands are missing, verify environment (`DISCORD_TOKEN`, `GUILD_ID`) and restart.
- Polling ownership:
  - Prod: `POLLING_MODE=active`
  - Staging: `POLLING_MODE=mirror` with `MIRROR_SOURCE_DATABASE_URL` set to prod DB and `POLLING_ENV=staging`
- Observability is documented separately in `docs/observability.md` and is intended to stay localhost-only by default on the droplet.
- Droplet app deploys use the Yarn path (`yarn.lock`) for deterministic installs.
- Current localhost-only app health port mappings on the droplet:
  - Production app: `127.0.0.1:8085:8080`
  - Staging app: `127.0.0.1:8086:8080`
- The app health server defaults are:
  - `HEALTHCHECK_ENABLED=true`
  - `HEALTHCHECK_HOST=0.0.0.0`
  - `HEALTHCHECK_PORT=8080`
  - `HEALTHCHECK_LIVE_PATH=/livez`
  - `HEALTHCHECK_READY_PATH=/healthz`
- These defaults are currently relied on directly; no extra env overrides are required unless you intentionally want non-default paths or ports.

## Droplet Dependency Cache

- The droplet app containers use persistent `node_modules` and Yarn cache state so code-only deploys can skip a full reinstall.
- `ops/deploy/ensure-yarn-deps.sh` hashes `package.json` and `yarn.lock` and only runs `yarn install --frozen-lockfile` when the manifest hash changed or the dependency volume is missing.
- Deploys still run `yarn build` and `yarn start` after the dependency check, so runtime startup and migration ownership stay unchanged.

Operator note:

- The dependency cache is invalidated by changes to `package.json` or `yarn.lock`, by deleting the `node_modules` volume, or by losing `.yarn-integrity` / the stored manifest hash file inside that volume.

## Observability

External droplet observability is documented in `docs/observability.md`.

The current intended model is:

- app-level structured logs and telemetry inside ClashCookies
- localhost-only Uptime Kuma / Dozzle / Netdata on the droplet
- optional HTTP readiness monitoring through the app health endpoint
## Health Endpoint Validation
- From the droplet host, use:
  - `curl http://127.0.0.1:8085/livez`
  - `curl http://127.0.0.1:8085/healthz`
  - `curl http://127.0.0.1:8086/livez`
  - `curl http://127.0.0.1:8086/healthz`
- `/livez` is liveness only and does not require Discord readiness.
- `/healthz` should return success only when the Discord client is ready and the database probe succeeds.

## Install Links

Prod guild install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=0&scope=bot+applications.commands

Prod user install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=1&scope=bot+applications.commands

Staging guild install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=0&scope=bot+applications.commands

Staging user install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=1&scope=bot+applications.commands
