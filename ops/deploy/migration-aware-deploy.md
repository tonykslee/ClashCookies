# Migration-aware deployment orchestrator

This is an implementation-only state machine for a future reviewed production deployment adapter. It does not install or modify the VM wrapper, contact production, access a protected database, start Docker, or replace `ops/deploy/deploy-prod.sh`.

The entry point is:

```text
npm run deploy:migration-aware
```

The command requires explicit protected-runtime configuration:

- `DEPLOY_EXECUTION_AUTHORIZED=1`
- `DEPLOY_TARGET_ENV=production`
- `DEPLOY_RELEASE_ID`, `DEPLOY_APPROVED_BY`, and `DEPLOY_AUTHORIZATION_DIGEST`
- `DEPLOY_OLD_SHA` and `DEPLOY_NEW_SHA` (exact 40-character commits)
- `DEPLOY_EXPECTED_MIGRATION_DIFF_DIGEST` (SHA-256 of the exact `OLD_SHA..NEW_SHA` Prisma diff)
- `DEPLOY_EXPECTED_MIGRATION_MANIFEST_DIGEST` (the digest expected by `migration-runner.js`)
- absolute `DEPLOY_LOCK_PATH`, `DEPLOY_RELEASE_RECORD_PATH`, `DEPLOY_PREFLIGHT_EVIDENCE_PATH`, and `DEPLOY_CANDIDATE_WORKTREE_PATH`

The preflight evidence file is outside the mutable checkout and must bind the exact release ID, old/new SHAs, both migration digests, approver, authorization digest, `authorizationStatus=PASS`, and `PASS` for every required runbook gate. Missing or mismatched evidence blocks before candidate creation or runtime inspection.

Execution is serialized and fail-closed:

1. acquire the host-level atomic lock;
2. append a bounded release record outside the checkout;
3. verify authorization, all preflight gates, exact old/new commits, migration diff, clean checkout, unknown-file collision safety, and the one canonical `clashcookies-app` runtime;
4. create and build a candidate at `NEW_SHA` with no production secrets, Discord credentials, active polling, startup command, or migration command;
5. invoke the reviewed checkout's separate `migration-runner.js` exactly once using its protected credential and database-identity contract;
6. require read-only post-migration verification with no unresolved Prisma state;
7. stop the old runtime, check out `NEW_SHA` without deleting unknown files, start exactly one active production runtime, and require HTTP 200 from `http://127.0.0.1:8085/healthz`; and
8. clean only the orchestrator-owned candidate after successful health verification.

Migration runner results use one canonical `exitCode` field. A missing, malformed, conflicting, signal-bearing, error-bearing, or otherwise ambiguous result is treated as `AMBIGUOUS`; only an exact, internally consistent success is promotable. Migration failure, ambiguous completion, interrupted state, unresolved post-migration status, startup failure, and health failure stop the state machine. No automatic retry, `migrate resolve`, reset, destructive cleanup, database rollback, blind SQL replay, or old-runtime restart is performed. After a committed migration, health failure leaves the release record recovery-required for a separately reviewed VM recovery procedure.

This implementation slice never invokes `startOldRuntime`. A future VM integration must first stop the new runtime, verify singleton absence, restore the exact old artifact, prove database/schema compatibility, and health-check the recovered runtime before any manually authorized old-runtime start is considered.

The default CLI adapter intentionally fails closed for VM-specific checkout, runtime, candidate, and post-migration operations. A future VM wrapper must supply a separately reviewed adapter that verifies its own pinned path/hash, canonical production identity, protected credential delivery, database identity, runtime labels, and release-record ownership. It must not reconstruct production Compose from repository assumptions or alter the legacy wrapper in this change.

The existing non-migration helper remains separate and continues to reject Prisma changes before stopping production. This orchestrator is not an implicit fallback for that helper.
