# Production backup readiness roadmap

**Repository:** `tonykslee/ClashCookies` · **base:** `dev` · **operator checkpoint:** November 14, 2026  
**Status:** isolated backup runner prepared; service **inactive**, timer **disabled**; no real encrypted off-site production DB backup/restore verified. **Production release remains blocked.**

This roadmap tracks **observed** progress and open authorization gates. It does not authorize actions. The detailed activation runbook is [`ops/backup/README.md`](../../ops/backup/README.md); primary terminal evidence is [the 2026-11-14 operator preflight and continuation](../diagnostics/backup-operator-preflight-2026-11-14.md). Follow the [canonical development workflow](../ai-development-workflow.md). The earlier `docs/roadmaps/dusk-economy.md` is unrelated and must not be modified for backup work.

## Milestones and evidence

| Stage | Status | Observed evidence / residual gate |
| --- | --- | --- |
| M0 — Backup implementation and safeguards | **Merged on `dev`** | Encrypted PostgreSQL 17 backup implementation PR #1984; release/recovery workflow PR #1985; docs preflight PR #1988; reviewed host-path/SSL/region code PR [#1989](https://github.com/tonykslee/ClashCookies/pull/1989) merged at `15677f03`, CI green |
| M1 — B2 bucket and harmless key recovery | **Operator-verified; escrow PARTIAL** | Private B2 bucket in `us-west-004`; Governance Object Lock and lifecycle rules; restricted upload and separate read-only recovery credentials; harmless encrypted object independently recovered with both off-host age private keys. Durable off-host admin recovery and independent escrow retrieval still open |
| M2 — Least-privilege database + host identities | **Operator-verified** | Dedicated `clashcookies_backup` SCRAM login, scoped read-only `CONNECT`/`USAGE`/`SELECT` including 119 tables, 16 sequences and owner-scoped defaults; write test rejected. Non-login `clashcookies-backup` OS account; `.pgpass` owner/mode 0600, `backup.env` root-only 0600; controlled staging directory |
| M3 — Isolated runner and inactive units | **Operator-verified** | Clean `dev` clone at `/opt/clashcookies`, commit `15677f03`; Node 24.22.3 / npm 11.19.1; 310 packages installed with lifecycle scripts disabled; Prisma Client 5.22.0 generated; backup JS compiled; restricted-account permissions/tools/syntax validated; systemd units installed root-owned, **service static/inactive, timer disabled/inactive** |
| M4 — Monitoring transport and failure alert | **Partially verified** | Healthchecks.io check with cron `15 2 * * *` UTC; TLS 1.3; harmless `/log` and simulated `/fail` POSTs HTTP 200; event history and failure email verified. Check reported paused again; backup-success event and independent expected-object monitoring **not** verified |
| M5 — First controlled production DB backup | **BLOCKED — explicit approval required** | One read-only custom-format `pg_dump` through restricted identity, encrypted to both age recipients and uploaded to B2, then verify object checksum/retention/cleanup. **Not executed or authorized** at this checkpoint |
| M6 — Real off-host disposable restore | **BLOCKED** | Use off-host recovery credential/age private identity to retrieve M5 object, validate checksum, decrypt, inspect `pg_restore --list`, restore into disposable PostgreSQL 17, and verify schema/data; never live DB |
| M7 — Automated timer and end-to-end monitoring | **BLOCKED — separate approval required** | After M5/M6 and custody/monitoring closure, independently authorize enabling timer; verify schedule, external alerts, object freshness, retry/cleanup behavior. No automation enabled now |
| M8 — Production release | **BLOCKED** | [Draft PR #1983](https://github.com/tonykslee/ClashCookies/pull/1983) must not be merged. Resolve staging absence/waiver, deployment identity/checkout, migration-failure recovery and remaining production release gates independently |

## Last verified safety snapshot

- Operator showed `clashcookies-backup.service` **inactive**; `clashcookies-backup.timer` **disabled/inactive**; production `/healthz` **HTTP 200**; root filesystem **7.2 GB free of 24 GB (70% used)**. Recheck shortly before any real dump.
- PostgreSQL production server `17.9`, backup client `17.12`. Production checkout is separately maintained on `main` at `/home/tilo/apps/clashcookies-prod`; isolated runner is `/opt/clashcookies` on reviewed `dev`. Do not copy app Discord credentials, start the bot, or run migrations.
- Staging and Netdata were deliberately removed; Uptime Kuma and Dozzle retained. Do not indiscriminately redeploy old Compose configurations.
- The earlier local Windows PostgreSQL 17 dump/restore and the harmless B2 text-object recovery are useful **partial evidence** but **do not satisfy M6**.
- No private SSH identity, password, monitoring ping URL, AWS secret, B2 recovery key or age private identity may appear in repository, chat, or command output.

## Immediate next decision

The operator requested a **Windows CMD SSH tunnel** for further development and a handoff, **not approval** for the requested first real backup. The tunnel maps local `127.0.0.1:15432` to the server's localhost-only `127.0.0.1:5432` and is not evidence of database or backup authorization.

**Before M5:** Recheck service/timer inactivity, production health, available space for both temporary archives, service-account isolation, scoped credentials, recipient custody, B2 Object Lock policy, and off-host admin recovery access. Obtain **explicit authorization for exactly one controlled production PostgreSQL backup/encryption/B2 upload**. Record resulting actual object metadata and recovery proof only after they occur. Keep the Healthchecks.io check paused until the authorized schedule is ready; avoid sending a synthetic success ping.

**After M5:** Carry out M6 only in a separate isolated recovery environment; require separately explicit authorization for M7 and production release. All host operations are operator-run one safe step at a time; GitHub access does not grant SSH/DB privileges.
