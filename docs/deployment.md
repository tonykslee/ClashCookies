# Deployment and Install Links

## Deployment Notes
- Commands are registered as guild commands using `GUILD_ID` on startup.
- If commands are missing, verify environment (`DISCORD_TOKEN`, `GUILD_ID`) and restart.
- Polling ownership:
  - Prod: `POLLING_MODE=active`
  - Staging: `POLLING_MODE=mirror` with `MIRROR_SOURCE_DATABASE_URL` set to prod DB and `POLLING_ENV=staging`
- Observability is documented separately in `docs/observability.md` and is intended to stay localhost-only by default on the droplet.

## Install Links
Prod guild install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=0&scope=bot+applications.commands

Prod user install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=1&scope=bot+applications.commands

Staging guild install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=0&scope=bot+applications.commands

Staging user install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=1&scope=bot+applications.commands
