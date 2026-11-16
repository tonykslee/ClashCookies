# Production release migration preflight — 2026-11-16

**Scope:** operator-reported Windows PostgreSQL 17.12 representative restore and release regression snapshot for [draft release PR #1983](https://github.com/tonykslee/ClashCookies/pull/1983). This is a documentation checkpoint, not a newly executed database or GitHub CI test. All statements below derive from operator-shared handoff evidence; the GitHub connector independently confirmed the listed dev and release-PR refs at the checkpoint.

## Source revisions and regression evidence

- `dev`: `ae748503bbd7760c4da2b87706e83dd7eabf4dfd`; historical `main`: `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad`. The historical client compatibility check below used that `main` commit; it has not been independently verified as the exact live production deployment.
- Release PR #1983 remained draft and unmerged. PR #2009 deployment safeguards and PR #2011 Compo fallback were reported merged to dev; PR #2007 closed as superseded after parity review.
- Operator-reported regression baseline against dev: **371 test files passed; 5,721 tests passed; TypeScript passed; ESLint zero errors / 67 warnings; production build passed; `git diff --check` passed**. This establishes code-health evidence only, not approval to release.

## M1a — representative existing-schema restore: PASS (operator-reported)

- Source: November 13 production backup, stored outside repository at `C:\Users\tonyk\Backups\ClashCookies\clashcookies-prod-20261113T215300Z.dump`; **29,660,211 bytes**; SHA-256 `6E426AC3A58D8F771CF31978780911E6183E6F8EFFD1ADA9ACE12021C4D34796`.
- `pg_restore --list`: PASS, **841 entries**.
- Restore: PostgreSQL **17.12** isolated loopback cluster, **127.0.0.1:55433**, database `clashcookies_m1a_baseline`, role `m1a_migration_admin`, SCRAM authentication, isolated data directory under `%LOCALAPPDATA%\ClashCookies\M1a-pg17-test\data`.
- Restore command used `--no-owner --no-acl --exit-on-error --single-transaction` and exited successfully.
- **119** public tables; **44** enums; **183** Prisma migration records, comprising **178 completed** and **5 historically rolled back**; zero incomplete migration records.
- Representative restored counts: TrackedClan **8**, PlayerLink **3,248**, TrackedMessage **2,057**, ClanWarHistory **1,050**, CurrentWar **8**, SyncCycle **69**.
- **Neither of the two target migrations was applied**. Cluster remains running and deliberately retained as an immutable test baseline. Do not modify, drop, truncate, migrate, or destroy it.

## M1b — combined migration validation: PASS (operator-reported)

The following results were reported by the operator on November 16, 2026. This documentation update did not connect to or mutate any database.

### Validation environment

- Isolated local PostgreSQL **17.12** at `127.0.0.1:55433`.
- Original production-derived restore: `clashcookies_m1a_baseline`, preserved without modification.
- Successful combined migration database: `clashcookies_m1b_validation`.
- Synthetic migration-failure recovery database: `clashcookies_m1b_failure_test`.
- Prisma application compatibility database: `clashcookies_m1b_compat_test`.
- Source `dev` commit: `ae748503`; historical `main` commit: `0d2a49bb`.

### Verified outcomes

Target migrations were applied in order:

1. `20261112120000_add_dusk_wallet_ledger_foundation`
2. `20261115120000_add_sync_reaction_history`

- Combined deployment passed; repeat `prisma migrate deploy` reported no pending migrations.
- All **183** original Prisma migration-history records matched, including metadata fingerprints.
- All **118** existing application tables matched exact row counts and order-independent row-content fingerprints.
- All **1,462** original column definitions matched after excluding database-specific catalog names; all **154** original constraints, **447** original indexes, and **16** original sequences matched. Sequences matched by reported definitions and last values.
- The migrations added **eight** new tables without losing existing tables.
- Safeguards passed: negative wallet balances were rejected; ledger UPDATE and DELETE were rejected by append-only protection; duplicate ledger idempotency keys and duplicate wallet/source-event identities were rejected; sync reaction-history ADD/REMOVE inserts were accepted; invalid action and observation-phase enum values were rejected; synthetic transactions rolled back and cleanup was verified.
- Synthetic migration-failure recovery passed for the tested scenario: a temporary `SELECT 1/0;` migration produced `P3018`, a second deployment produced `P3009`, the failed state was inspected, `prisma migrate resolve --rolled-back` was used after confirming no SQL changes had been made, the temporary migration file was removed, and deployment resumed successfully. Both legitimate migrations completed, the synthetic rollback history remained recorded, and no unresolved migrations remained.
- Six focused Vitest suites passed **81/81** tests. Some service tests mock Prisma and are not real database-integration evidence.
- The current Prisma Client passed isolated reads and synthetic wallet, ledger, and reaction-history writes/readbacks. A zero-amount ledger entry correctly violated `DuskLedgerEntry_amount_nonzero`; all synthetic transactions rolled back with no synthetic records retained.
- A Prisma Client **5.22.0** generated from historical `main` performed representative reads against the migrated database: `PlayerLink` **3,248**, `ClanWarHistory` **1,050**, `TrackedClan` **8**, and `SyncCycle` **69**. It correctly lacked the new M1b models.

### Limitations and remaining release blockers

- Synthetic failure recovery is **PASS only for the tested no-change failure scenario**. It does not establish recovery from every possible partially applied migration or arbitrary production failure.
- Historical-client compatibility is **representative read compatibility only**. Do not claim full old-version runtime compatibility; the historical `main` commit has not been independently verified as the exact live production deployment.
- The validation used disposable databases. It does not authorize production migration execution, issuance of Duskits, rewards, transfers, historical backfills, or any production data mutation. Code rollback alone cannot undo committed database migrations.
- Staging is decommissioned; an independent staging gate or explicit reviewed waiver remains **OPEN**.
- Deployment identity/checkout verification and the live health/monitoring release gate remain **OPEN**.
- Backup evidence remains governed by the [production backup readiness roadmap](../roadmaps/production-backup-readiness.md): the timer is **disabled**, unattended success and independent expected-object freshness monitoring remain open, and disaster-recovery key retrieval/escrow checks remain open.
- Remaining release authorization is **OPEN**. Draft release PR #1983 must remain blocked and unmerged.

No production promotion, deployment, data mutation, ledger issuance, historical backfill, automatic rewards, or `dev` to `main` merge is authorized by this checkpoint.

## M1c — partial migration failure recovery validation: PASS (operator-executed)

This section records a separate validation run against the disposable `clashcookies_m1c_partial_failure` database on PostgreSQL **17.12** at `127.0.0.1:55433`, using Prisma **5.22.0** from `dev` commit `9ad83270d647ad7cef71cab8737a9148903816d7`. The primary checkout, protected M1a/M1b databases, historical compatibility worktree, production systems, backup services, and release PR #1983 were not modified.

### Observed results

- The explicit database identity was `clashcookies_m1c_partial_failure`, user `m1a_migration_admin`, server `127.0.0.1:55433`. Authentication reused the single matching local `pgpass.conf` host/port/user entry; the password was held only in process memory and was not printed, logged, committed, or passed as a command argument.
- Read-only preflight: **119** public tables; **183** migration records (**178** finished, **5** historically rolled back, **0** unresolved); representative counts were `TrackedClan=8`, `PlayerLink=3,248`, `TrackedMessage=2,057`, `ClanWarHistory=1,050`, `CurrentWar=8`, and `SyncCycle=69`.
- `prisma migrate deploy` applied `20261112120000_add_dusk_wallet_ledger_foundation` and `20261115120000_add_sync_reaction_history`, then started `20261116120000_m1c_partial_failure_probe`.
- The probe returned Prisma **P3018** and PostgreSQL **22012** (`division by zero`). The failed migration was recorded as unresolved. A second deploy returned **P3009** and did not apply anything else.
- Inspection before recovery found all eight legitimate M1b tables present and no `M1cPartialFailureProbe` table. The probe's `CREATE TABLE` and `INSERT` were rolled back; no synthetic row persisted. Existing representative counts remained unchanged.

### Tested recovery behavior

- Because the inspected probe had no persisted SQL side effects, the smallest correct recovery was `prisma migrate resolve --rolled-back 20261116120000_m1c_partial_failure_probe`. No `DROP`, `DELETE`, reset, recreate, or change to a legitimate object or historical migration was performed.
- The intentionally invalid, untracked probe migration file and its now-empty directory were then removed from the disposable worktree so Prisma could not replay the test migration. This was test-fixture cleanup, not a production migration rollback.
- Post-recovery state: **186** migration records (**180** finished, **6** rolled back including the probe, **0** unresolved), **127** public tables (`119` original plus the eight legitimate M1b tables), no synthetic table, and unchanged representative counts. `prisma migrate status` reported the schema up to date, and two consecutive `prisma migrate deploy` runs reported no pending migrations.
- Catalog checks still found the relevant safeguards: **4** ledger check constraints, **6** append-only ledger/source triggers, and **5** sync-reaction indexes.

### Commands executed (credentials redacted)

The following commands were run from `C:\Projects\ClashCookies-M1c-Partial-Failure`; the connection password was supplied from the verified local `pgpass.conf` entry in memory and is represented here as `<redacted>`:

```text
psql --no-password --host=127.0.0.1 --port=55433 --username=m1a_migration_admin --dbname=clashcookies_m1c_partial_failure --set=ON_ERROR_STOP=1 --command="<read-only identity, migration, object, and representative-count queries>"
prisma migrate status --schema=C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\schema.prisma
prisma migrate deploy --schema=C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\schema.prisma
prisma migrate deploy --schema=C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\schema.prisma
prisma migrate resolve --rolled-back 20261116120000_m1c_partial_failure_probe --schema=C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\schema.prisma
apply_patch (delete prisma/migrations/20261116120000_m1c_partial_failure_probe/migration.sql)
[System.IO.Directory]::Delete('C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\migrations\20261116120000_m1c_partial_failure_probe', $false)  # after verifying the directory was empty
prisma migrate status --schema=C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\schema.prisma
prisma migrate deploy --schema=C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\schema.prisma
prisma migrate deploy --schema=C:\Projects\ClashCookies-M1c-Partial-Failure\prisma\schema.prisma
```

### Untested production scenarios and remaining blockers

- This PASS is limited to a PostgreSQL-transactional failure after `CREATE TABLE` and `INSERT`, where both side effects rolled back. It does not validate a migration that commits earlier statements, uses non-transactional DDL, times out, loses its connection, encounters a lock/deadlock, is interrupted by an operator, or is run concurrently by multiple deployers. `migrate resolve --rolled-back` does not undo committed SQL statements.
- No production database, production account, SSH/VM/Docker process, backup timer, issuance/reward/transfer/backfill path, or deployment was touched. Production failure recovery, backup restore/recovery during migration, and the exact production deploy identity remain untested.
- M1c closes the tested partial-failure case but does not authorize release. Independent staging/waiver, deployment identity/checkout, live health/monitoring, backup freshness and recovery-key custody, full historical-client compatibility, broader partial-migration recovery, and release approval remain open. Draft PR #1983 must remain blocked and unmerged.

## Release blockers and evidence limitations

- M1b combined migration chain: **PASS for the operator-reported disposable existing-schema validation**. Production migration execution remains unauthorized.
- Failure-path migration recovery: **PASS for the tested transactional side-effect probe in M1c and the earlier no-change M1b scenario; broader partially-applied recovery OPEN**. Irreversible schema effects remain a release consideration; code rollback alone cannot revert committed migrations.
- Application compatibility: **PASS for current-client focused reads/writes and representative historical-client reads; full old-version runtime compatibility OPEN**.
- Staging environment: decommissioned; independent gate or explicit waiver **OPEN**.
- Deployment identity/checkout and live health/monitoring release gate: **OPEN**.
- Backup: November 15 controlled encrypted daily+weekly manual run and independent restore of an earlier encrypted daily object are documented in the [backup readiness roadmap](../roadmaps/production-backup-readiness.md); timer **disabled**, unattended success and independent object-freshness monitoring **OPEN**.
- Off-host disaster recovery key retrieval/escrow checks and remaining release authorization: **OPEN**.
- **No production promotion, deployment, data mutation, ledger issuance, historical backfill, automatic rewards, or `dev` to `main` merge is authorized.** PR #1983 must remain draft.

## Next safe step

Treat M1b and M1c as completed disposable validation inputs to the remaining release review, not as release approval. Resolve the independent staging/waiver, deployment identity/checkout, live health/monitoring, backup freshness, disaster-recovery custody, broader migration-failure recovery, and full old-version compatibility gates before considering PR #1983. Preserve the untracked `C:\Projects\ClashCookies\powershell` file.
