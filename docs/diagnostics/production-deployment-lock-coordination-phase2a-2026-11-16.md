# Production deployment lock coordination — Phase 2A

**Status:** repository implementation and isolated regression evidence only. No VM file, production app, database, backup timer, staging resource, migration, or deployment was touched.

## Verified diagnosis

- `ops/deploy/deploy-prod.sh` used a `flock` file descriptor.
- `ops/deploy/migration-aware-deploy.js`, `ops/deploy/migration-runner.js`, and the Phase 1 adapter used separate directory-lock implementations.
- The Node release functions removed `owner.json` and the lock directory without proving that the path and owner record were still the objects acquired by that process.
- The live `/home/tilo/deploy-prod.sh` was not inspected. Its operator-reported SHA-256 is not evidence of lock cooperation, so this change does not rely on it.

## Implemented repository contract

The repository-side entry points now share the atomic directory-lock contract in [deployment-lock.md](../../ops/deploy/deployment-lock.md):

```text
DEPLOY_LOCK_PATH
  ├─ deploy-prod.sh / migration-aware-deploy.js acquire first
  ├─ checkout, runtime, evidence, build and promotion work
  └─ release only after the entry point completes

DEPLOY_MIGRATION_LOCK_PATH
  └─ migration-runner.js acquire only during migration execution
```

The outer and inner paths are required to differ and remain outside the checkout. Existing or stale-looking state is bounded `already_locked` handling; no retry or stale cleanup is attempted. Release verifies directory identity, owner-file identity, exact owner content, symlink state, emptiness, and final removal. Any mismatch, replacement, corruption, or cleanup error leaves state for review and fails closed.

The orchestrator passes only `MIGRATION_LOCK_PATH` to the nested runner, so the runner does not recursively acquire the outer release lock. The Phase 1 adapter uses the same primitive but its unconditional mutation and migration gates remain disabled.

## Remaining VM evidence

Before any production use, an authorized operator must read-only verify the actual wrapper control flow, exact deploy account and permissions, canonical shared lock path and parent ownership, release-record ownership, protected database credential source, runtime singleton/PID correlation, database identity, health/monitoring, backup/recovery, staging waiver, and release authorization. Installing or replacing the VM wrapper is a separate reviewed change and remains blocked.
