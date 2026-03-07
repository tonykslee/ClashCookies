# ClashCookies
Discord bot for Clash of Clans activity tooling.

## What It Does
- Tracks configured clans and updates player activity records.
- Supports last seen and inactivity queries.
- Manages tracked clans and roster/sheet integrations.
- Provides FWA points and matchup tooling.
- Uses cached `/fwa match` rendering with processing indicators for faster button interactions.
- Supports tracked-clan mail channel config via `/tracked-clan configure` and send-preview flow via `/fwa mail send`.
- Supports configurable war plans by match type/outcome via `/warplan set|show|reset`; these templates are used in posted war mail content (including line breaks, emoji, and media links).

## Quick Start
```bash
npm install
npx prisma migrate deploy
npm run build
npm start
```
## Documentation
- [Setup and Environment](docs/setup.md)
- [Commands Reference](docs/commands.md)
- [Command Access and Permissions](docs/permissions.md)
- [Deployment and Install Links](docs/deployment.md)

## Development
See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and architecture documentation.
