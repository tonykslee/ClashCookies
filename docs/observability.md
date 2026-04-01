# Observability

This project supports a self-hosted observability stack on the droplet using:

- Uptime Kuma for status pages, checks, and Discord alerts
- Dozzle for live Docker logs
- Netdata for host and container metrics

The stack is intentionally private by default:

- Uptime Kuma binds to `127.0.0.1:3001`
- Dozzle binds to `127.0.0.1:8080`
- Netdata binds to `127.0.0.1:19999`

Use SSH port forwarding to access the UIs from your machine instead of exposing them publicly:

```bash
ssh -i C:\Projects\clashcookies_codex ^
  -L 3001:127.0.0.1:3001 ^
  -L 8080:127.0.0.1:8080 ^
  -L 19999:127.0.0.1:19999 ^
  codex@64.23.164.95
```

After the tunnel is open:

- Uptime Kuma: `http://127.0.0.1:3001`
- Dozzle: `http://127.0.0.1:8080`
- Netdata: `http://127.0.0.1:19999`

## Files

- Compose stack: `ops/observability/docker-compose.yml`
- Runtime env template: `ops/observability/.env.example`
- Dozzle auth bootstrap script: `ops/observability/scripts/generate-dozzle-users.sh`
- Netdata local-only bind config: `ops/observability/netdata/netdata.conf`

## First-Time Setup

1. Copy `ops/observability/.env.example` to `ops/observability/.env`.
2. Generate a Dozzle user file:

```bash
cd ops/observability
./scripts/generate-dozzle-users.sh ops-admin '<strong-password>' ops@example.com 'ClashCookies Ops'
```

3. Start the stack:

```bash
docker compose -f ops/observability/docker-compose.yml up -d
```

4. Open Uptime Kuma through the SSH tunnel and create the first admin account.
5. In Uptime Kuma, add a Discord notification endpoint using your Discord webhook URL.

## Recommended Uptime Kuma Monitors

### Current droplet-safe default

Use Docker Container monitors from inside Uptime Kuma:

- Production: monitor container `clashcookies-app`
- Staging: monitor container `clashcookies-staging-app`

This works immediately with the localhost-only Uptime Kuma deployment because the Kuma container mounts the Docker socket privately.

### HTTP readiness monitors to add alongside container monitors

Keep the Docker Container monitors above, and add HTTP monitors for app readiness:

- Production URL: `http://host.docker.internal:8085/healthz`
- Staging URL: `http://host.docker.internal:8086/healthz`
- Expected status: `200`

If `host.docker.internal` is not available in your Docker runtime, use the droplet host gateway IP from inside the Uptime Kuma container instead.

Result:

- container monitors tell you whether the container is up
- HTTP monitors tell you whether the bot is actually ready

## Bot Health Endpoint

The bot exposes:

- `/livez` for process liveness
- `/healthz` for readiness

Readiness returns HTTP `200` only when:

- the Discord client is ready
- the database probe succeeds

Recommended container port mapping on the droplet:

- Production app: `127.0.0.1:8085:8080`
- Staging app: `127.0.0.1:8086:8080`

## Secrets And Manual Inputs

- Discord webhook URL for Uptime Kuma notifications
- Dozzle username/password generated into `ops/observability/dozzle/users.yml`
- Optional custom bind ports in `ops/observability/.env`

Do not commit `ops/observability/.env` or `ops/observability/dozzle/users.yml`.

## Update And Restart Workflow

Refresh observability images and restart the stack:

```bash
docker compose -f ops/observability/docker-compose.yml pull
docker compose -f ops/observability/docker-compose.yml up -d
```

Restart without image updates:

```bash
docker compose -f ops/observability/docker-compose.yml restart
```

Check status:

```bash
docker compose -f ops/observability/docker-compose.yml ps
```

Check logs:

```bash
docker compose -f ops/observability/docker-compose.yml logs --tail=100
```

## Notes

- Dozzle reads the Docker socket, so keep it localhost-only or put it behind strong auth if you ever expose it.
- Netdata is configured for local-only access in `ops/observability/netdata/netdata.conf`.
- The existing bot and database deployment flow stays separate from this stack.
