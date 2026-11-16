# Production release migration preflight — 2026-11-16

**Scope:** operator-reported Windows PostgreSQL 17.12 representative restore and release regression snapshot for [draft release PR #1983](https://github.com/tonykslee/ClashCookies/pull/1983). This is a documentation checkpoint, not a newly executed database or GitHub CI test. All statements below derive from operator-shared handoff evidence; the GitHub connector independently confirmed the listed dev and release-PR refs at the checkpoint.

## Source revisions and regression evidence

- `dev`: `00648c561e5c0ac84d69490fd5b66b692fd6459e`; `main`: `0d2a49bbc33fe42bfbac56a2583e7d114b71cfad`; merge base `94ad2c94188565e970e906ca4499858cb3714de6` (merge-base observation from handoff, not independently recalculated).
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

## M1b — combined migration validation: NOT RUN / authorization required

Target migration directories, order:
1. `20261112120000_add_dusk_wallet_ledger_foundation`
2. `20261115120000_add_sync_reaction_history`

On separately authorized **dedicated disposable copies** of the M1a baseline (never on the baseline itself): verify first deployment applies both in order; a second `prisma migrate deploy` is idempotent; existing data and migration history remain intact; wallet/ledger constraints and immutable accounting triggers enforce intended behavior; reaction-history objects, indexes and semantics work; synthetic failure recovery is explored separately; and old/new application compatibility and irreversibility limitations are recorded. Validate old/current application paths without issuing real Duskits, sending messages, or connecting to production.

Prior authorization covered **M1a restore only**. Do not execute migrations on any database—including disposable copies—without the operator's separate explicit authorization. Production DB tunnel `15432` and pre-existing local PG service `5434` are excluded; do not connect to them. Do not touch production, staging mirror, or backup timers.

## Release blockers and evidence limitations

- M1b combined migration chain: **BLOCKED / not yet run**.
- Failure-path migration recovery, irreversible schema effects, old/new compatibility: **OPEN**. Code rollback alone cannot revert committed migrations.
- Staging environment: decommissioned; independent gate or explicit waiver **OPEN**.
- Deployment identity/checkout and live health/monitoring release gate: **OPEN**.
- Backup: November 15 controlled encrypted daily+weekly manual run and independent restore of an earlier encrypted daily object are documented in the [backup readiness roadmap](../roadmaps/production-backup-readiness.md); timer **disabled**, unattended success and independent object-freshness monitoring **OPEN**.
- Off-host disaster recovery key retrieval/escrow checks and remaining release authorization: **OPEN**.
- **No production promotion, deployment, data mutation, ledger issuance, historical backfill, automatic rewards, or `dev` to `main` merge is authorized.** PR #1983 must remain draft.

## Next safe step

Confirm local git status and inspect both migration SQL files / Prisma schema **read-only**, then prepare isolated-copy and validation commands; obtain operator approval before creating or migrating disposable M1b databases. Preserve the untracked `C:\Projects\ClashCookies\powershell` file.
