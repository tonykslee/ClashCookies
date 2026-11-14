# Production backup infrastructure preflight — operator record (2026-11-14 UTC)

**Repository:** `tonykslee/ClashCookies` · **base:** `dev`  
**Status:** operator-observed initial preflight plus subsequent same-day provisioning; **NOT** evidence of a real encrypted off-site production database backup, restored recovery, active backup schedule, or production application release.  
**Companion checklist/runbook:** [`ops/backup/README.md`](../../ops/backup/README.md). **Backup readiness roadmap:** [`docs/roadmaps/production-backup-readiness.md`](../roadmaps/production-backup-readiness.md). **Canonical workflow:** [`docs/ai-development-workflow.md`](../ai-development-workflow.md).

> This record preserves results displayed by the human operator in a live Linux SSH session, plus the matching repository configuration inspected on `dev`. It is not an independent SSH/DB inspection by ChatGPT or GitHub CI. All measurements are a dated snapshot and must be rechecked before production changes. Never place production passwords, B2 secrets, private age identities, Discord tokens, or SSH keys in Git, chat, command output, or PR comments.

> **Reading guide:** Sections below titled original preflight/handoff preserve the earlier snapshot before backup role creation. The [continuation section](#2026-11-14-operator-continuation--subsequent-verified-results) supersedes stale pending-action statements. No step should be repeated merely because it appears as pending in the historical baseline.

## Boundaries and outcome

- **Release and backup activation remain BLOCKED.** PR #1984 (encrypted backup implementation) and #1985 (workflow/recovery safeguards) were reported merged; release PR #1983 remains **draft**. Production has **no activated backup timer** and **no verified real encrypted off-site database backup/restoration**.
- Operator explicitly **approved creating a new `clashcookies_backup` PostgreSQL role with minimal read-only privileges**, including future-table/sequence defaults, at the end of this session. **The role was NOT created and no grants were applied.** Approval does not authorize running a backup, uploading production database contents, activating timers, restarting containers, deploying code, or merging a code-changing PR.
- Keep the active application, PostgreSQL container, existing records, external monitoring and Docker resources safe. The operator works step by step through an existing `tilo@clashcookies` Linux SSH shell, and uses Windows CMD (`C:\Projects\ClashCookies>`) for local repository operations. `tilo` can run `sudo docker`; the `codex` SSH account cannot be assumed to have sudo/Docker/database access.
- A previous **local** PostgreSQL 17 restore was reported successful. This does **not** satisfy the off-host encrypted-backup recovery gate. An encrypted **harmless test text** upload/download/decryption from B2 succeeded; this also does **not** satisfy the real production data recovery gate.

## Verified operator snapshot — droplet and deployment

| Area | Reported observation | Operational consequence |
| --- | --- | --- |
| VM | Ubuntu 24.04 on a 24 GB root filesystem; latest `df -h /` **16 GB used, 7.6 GB available, 68%** | Recheck available space before backup; allow for unencrypted and encrypted temporary dump files |
| Production app | Docker container `clashcookies-app`, image/runtime Node **20.20.1**, host-bound on `127.0.0.1:8085` | `curl http://127.0.0.1:8085/healthz` returned **HTTP 200** after provisioning changes |
| Production DB | Docker container `clashcookies-db`, PostgreSQL server **17.9** (Debian), host-published `127.0.0.1:5432` | Do not touch database container data/volumes |
| Database sizes | `clashcookies` approximately **354 MB**; `postgres` approximately **7.2 MB** | Sizes change; don't infer compressed dump size from DB size |
| Production checkout | `/home/tilo/apps/clashcookies-prod` on `main`, observed commit **`0d2a49bb`**; seven untracked audit/config files preserved | Do not overwrite or update live checkout as part of isolated runner setup; production may lag `dev` |
| Backup runner | Proposed isolated application copy: `/opt/clashcookies` | `dist/scripts/backup.js` and `ops/backup` were absent from the live production checkout; runner must be built/reviewed separately |
| Monitoring | **Uptime Kuma** (127.0.0.1:3001) and **Dozzle** (127.0.0.1:8080) preserved | Verify monitors after infrastructure work; Netdata was removed |
| Staging | Staging app/database containers and five staging Docker volumes removed by explicit operator authorization; the staging app checkout removed | Staging is **not running** and must not be automatically recreated; separate release-gate decision/waiver still needs recording |
| Netdata | Container, two named volumes (`observability_netdata_cache`, `observability_netdata_lib`) and image removed with explicit authorization | Current `ops/observability/docker-compose.yml` may still declare Netdata; don't run blanket `docker compose up` until configuration is reconciled |
| Legacy dumps | Two older staging checkout dumps preserved in root-only `/var/lib/clashcookies-legacy-dumps`, with restrictive directory/file modes and byte-for-byte `cmp` verification | `clashcookies-from-prod.dump` (~191 KB) and `clashcookies-staging-railway.dump` (~2.9 MB), both dated March 24, 2026; **not current recovery evidence** |
| Space reclamation | Before cleanup: roughly 22/24 GB used (92%, ~2 GB free). After authorized staging/Netdata removal: ~16 GB used, initially 8.1 GB free; after tool installations: **7.6 GB free** | Journal (~1.8 GB) deliberately left unchanged; no need to resize VM based only on this snapshot |

The operator removed staging and Netdata specifically to recover disk space; production app/database containers and monitoring Kuma/Dozzle were preserved. Current repo architecture/deployment docs still describe staging mirror and Netdata configurations; **distinguish implemented capabilities from actually deployed services**. Running a generic compose command using stale infrastructure files could re-create retired services.

## Host tools installed for the isolated backup runner

All installations were explicitly approved, verified by operator console output and accompanied by production `/healthz` checks where shown. No production container restart, backup invocation, credential configuration, or timer activation occurred.

| Tool | Verified version / path | Notes |
| --- | --- | --- |
| PostgreSQL client | `pg_dump` **17.12**, `/usr/lib/postgresql/17/bin/pg_dump` | Installed PGDG PostgreSQL-17 **client**, compatible major with server 17.9; existing host PG16 tools were superseded only where required |
| `age` | **1.1.1** | Ubuntu package; only **public** age recipients will eventually be stored on VM |
| AWS CLI | **2.40.3**, `/usr/local/bin/aws` | Official AWS CLI v2 distribution verified with refreshed AWS PGP signer; no production AWS credentials configured |
| Node.js | **24.22.3**, `/opt/clashcookies-node24/bin/node` | Official Linux x64 archive, signed `SHASUMS256.txt.asc` verified using Node release keyring, archive SHA-256 matched; temporary `~/node24-preflight` removed |
| Host `node` | `command -v node` returned **not installed** | The committed systemd service currently uses **`/usr/bin/node`**: **MUST update through a reviewed code/config PR** to the dedicated Node 24 path and validate compatibility before installing/starting service |
| Backup-related SSH downloads | AWS/Node temporary installer directories removed after installation | Nothing is running as a scheduled backup |

Additional operational note: Ubuntu `needrestart` reported a newer installed kernel than the running kernel. **Do not reboot production incidentally.** Any maintenance/reboot requires a separate change plan.

## Production PostgreSQL discovery (read-only)

- Roles shown by `pg_roles` for `clashcookies%`: `clashcookies` (login + superuser + create DB/role + bypass RLS) and `clashcookies_dusk_readonly` (login, not superuser, no create DB/role, no bypass RLS). **`clashcookies_backup` did not exist** at inspection time.
- `clashcookies` has one application schema: `public` (owner `pg_database_owner`).
- In `public`, **119 ordinary tables**, **16 sequences**, **447 indexes** were reported, all owned by `clashcookies`; **0 relations with row-level security enabled**. Counts are a snapshot, not future guarantees.
- `pg_hba_file_rules` showed `trust` for local Unix sockets and container-internal `127.0.0.1`/`::1`; non-loopback TCP uses **`scram-sha-256`**. **These localhost rules are inside the database container, not the same address context as the host.**
- Host-level `psql` to published `127.0.0.1:5432` as proposed backup role with password prompts disabled returned **`fe_sendauth: no password supplied`**. This confirms that the actual tested host-to-container connection requires password authentication; it did not reveal/verify role existence.
- Server `SHOW ssl;` was **off**. The example `ops/backup/pg_service.conf.example` still says `sslmode=require`, which cannot work as-is. For the **local host-only published loopback** connection, propose `sslmode=disable` with `host=127.0.0.1`; validate exact Docker topology and keep the port bound to localhost. Do **not** weaken authentication rules globally or expose PostgreSQL publicly.
- `pg_dump` runner uses PostgreSQL service name `clashcookies_backup` and `PGOPTIONS=-c default_transaction_read_only=on`. `pg_service.conf` contains no password, while the `clashcookies-backup` OS identity must own a 0600 `.pgpass`.

### Original role authorization (subsequently executed; historical)

Operator explicitly approved a new account that can **log in using its own SCRAM password**, with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, and the minimum necessary `CONNECT` on the `clashcookies` database, `USAGE` on `public`, and `SELECT` on existing `public` tables and sequences. Include `ALTER DEFAULT PRIVILEGES FOR ROLE clashcookies IN SCHEMA public` to grant `SELECT` on future tables and sequences created by that owner. Scope future grants to the current owner/schema; separately reassess when new owners/schemas are introduced.

**The authorization is for that database role/grant operation only.** Prepare and review the exact SQL/credential handling before execution; use an interactive secret-input procedure that does not expose the password in chat, shell history, commands, process arguments, logs or Git. Verify effective permissions, a read-only database connection, default privileges, and that writing/DDL are denied. Do not grant `pg_read_all_data`, superuser, `BYPASSRLS`, owner membership or create privileges merely for convenience. Do not modify `pg_hba.conf` or production application credentials.

## B2 recovery evidence already collected (prior operator steps)

See `ops/backup/README.md` for provider evidence and caveats. Verified from user-supplied CLI results: private `clashcookies-prod-backups` in `us-west-004`, endpoint `https://s3.us-west-004.backblazeb2.com`; Governance Object Lock 14-day default; `clashcookies-prod/daily/`, `weekly/`, `monthly/` hide after 15/57/187 days and delete later; scoped production upload key without delete/bypass capability; separate off-host read-only recovery key; two off-host age identities independently decrypted a retrieved encrypted harmless test object. Temporary administrative bootstrap credentials were revoked. Off-host durable administrative recovery and independent escrow validation **still require attention**.

**Not tested:** real production database dump/encryption/upload, actual retained B2 database object verification, remote retrieval/decryption/restore of real production data, unattended timer and monitoring behavior, or application/migration recovery from a real failure.

## Original remaining-gates handoff (historical; superseded below)

1. **Next approved operation:** create the specifically authorized, least-privilege PostgreSQL `clashcookies_backup` role and scoped grants with secure interactive password entry. Verify effective grants, defaults, host TCP SCRAM login and read-only behavior; do not show secrets.
2. Provision the non-login, no-sudo `clashcookies-backup` **OS** account and isolated directories; establish root-only `/etc/clashcookies/backup.env`, root-owned public `pg_service.conf`, service-account-only `0600` `.pgpass`, and owned temporary staging directory. This is distinct from DB role creation and should be separately approved before changes.
3. Review runtime/config compatibility in `dev`: `/usr/bin/node` in `ops/backup/systemd/clashcookies-backup.service` needs explicit dedicated Node 24 path; `sslmode=require` example needs correction for verified local no-SSL PostgreSQL; `AWS_DEFAULT_REGION=us-east-1` example requires provider verification for B2 `us-west-004`. Use a code/config PR to `dev`, check actual diffs/CI, and obtain **explicit merge/deployment approval**.
4. Build/review an isolated backup runner at `/opt/clashcookies` rather than update the active production `main` checkout. Never copy production Discord tokens or active app environment into the runner; do not invoke normal application startup, Prisma migration deployment, or pollers.
5. Confirm separate host/service account privileges, no secret leakage, B2 signing/retention/lifecycle, off-host admin recovery key escrow, alert endpoints and expected-object monitoring. Install systemd **disabled**; neither execute backup nor start timer without separate authorization.
6. After specific operator authorization, perform one controlled read-only `pg_dump`/dual-age-encrypted production backup and B2 upload. Verify checksums, size and object-specific retention via the restricted recovery key.
7. Retrieve the **real** encrypted database object onto an isolated recovery host, validate SHA-256, independently decrypt with off-host identity, inspect with PostgreSQL 17 `pg_restore`, restore into **disposable** PostgreSQL 17, and validate schema/data/integrity. Never restore into production.
8. Explicitly resolve release-gate decisions for staging absence/waiver, Netdata/monitoring architecture, deployment identity, live checkout hygiene and migration-failure recovery. Only then consider timer approval and the separate `dev` → `main` release review. **Never auto-promote** and **never merge runtime/code changes without approval**.

**Operator interaction convention:** one safe, clearly labeled command per step; user has an existing Linux `tilo@clashcookies` SSH session; Windows local commands must be one physical CMD-compatible line. Stop on unexpected results, preserve existing resources, and do not request credentials in chat.


## 2026-11-14 operator continuation — subsequent verified results

This section supersedes the originally pending role/configuration and host-installation tasks above. All host/DB evidence here was supplied through the operator's displayed Linux terminal output, **not** independently inspected by GitHub or ChatGPT. Do not repeat creation or installation operations without checking current state.

### PostgreSQL identity and protected configuration — COMPLETE for preflight

- Operator created the dedicated login role `clashcookies_backup` with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT` and SCRAM password. Granted scoped `CONNECT` to `clashcookies`, `USAGE` on `public`, and `SELECT` on **119 existing tables and 16 sequences**, with `ALTER DEFAULT PRIVILEGES FOR ROLE clashcookies IN SCHEMA public` covering future tables and sequences from that owner. Effective privileges and a forbidden `DELETE ... WHERE FALSE` were tested; write was denied. No existing rows were modified.
- Linux `clashcookies-backup` is non-login, password-locked, non-sudo. `/var/lib/clashcookies-backup` is owned by this account, mode `0700`.
- `/etc/clashcookies/pg_service.conf` is root-owned `0644`, points to host-only `127.0.0.1:5432` with `sslmode=disable` on a verified SSL-disabled PostgreSQL server. `/etc/clashcookies/.pgpass` is backup-account-owned `0600`. The operator rotated the backup role password to a strong unique value and verified password-based, read-only login as the service account (`clashcookies_backup|clashcookies|on`).
- `/etc/clashcookies/backup.env` is root-owned `0600`; protected values include a bucket/prefix-scoped B2 upload credential, both distinct age **public** recipients, and Healthchecks.io success/failure URLs. Private age identities, recovery key, and operator secrets remain off-host; no secret values are recorded here.
- Manual age encryption from these two configured recipients produced a **336-byte encrypted harmless message**. Both private identities had previously independently decrypted a separate harmless B2 test object off-host. This is **not** evidence of a production dump recovery.

### Reviewed source and isolated backup runner — COMPLETE for preparation

- PR [#1989](https://github.com/tonykslee/ClashCookies/pull/1989) was merged into `dev` as `15677f03796f14c098af8d7dad22888bd691acde` after successful CI. It corrected systemd Node to `/opt/clashcookies-node24/bin/node`, localhost-only PostgreSQL `sslmode=disable` template, and B2 signing region to `us-west-004` with a fail-closed required setting.
- The operator created `/opt/clashcookies` owned by `tilo` with mode `0755`, cloned `dev` via unauthenticated HTTPS after SSH-key authentication failed, and verified exact revision `15677f03` and a clean working tree. This is **not** the production `main` checkout.
- Using Node `24.22.3`/npm `11.19.1`, `npm ci --ignore-scripts --no-audit --no-fund` installed 310 packages; `prisma generate` generated Prisma Client `5.22.0`; `node scripts/compile-typescript.js` created `dist/scripts/backup.js`. No `npm start`, `prisma migrate deploy`, Discord bot, database backup, or data upload was run.
- As `clashcookies-backup`, checks passed for Node, compiled-runner and PostgreSQL configuration readability, `.pgpass` access, staging-directory write permission, inability to modify source/compiled runner, `age`/AWS CLI/`pg_dump` executability, and JavaScript syntax. Backup-account access to root-only `backup.env` was denied as designed.
- `systemd-analyze verify` passed. With separate operator approval, both units were installed root-owned `0644`, then `daemon-reload` ran. `clashcookies-backup.service` is **loaded/static/inactive**; `clashcookies-backup.timer` is **loaded/disabled/inactive**. No backup service start or timer enablement has been authorized.

### B2 and monitoring — transport verified, real backup NOT tested

- The restricted backup account received only runtime-exported credentials from a root read of `backup.env` and successfully completed an AWS S3 **list-only** operation against the private B2 bucket at `us-west-004` (output `1`). This does **not** prove the real production upload, object verification, or retention path.
- External Healthchecks.io check `ClashCookies Production Backup` uses UTC cron `15 2 * * *` (02:15 UTC). The operator configured HTTPS POST success and `/fail` endpoints and verified protected paired URLs without revealing them.
- Under the restricted backup account, TLS to the endpoint negotiated **TLSv1.3**. A harmless `/log` POST returned **HTTP 200** and appeared as a **Log** event; a simulated JSON `/fail` POST returned **HTTP 200**, appeared as a **Failure** event and generated an **email alert** reported received by the operator. The check was reported **paused again** after the test. The success endpoint has not been tested end-to-end; a real successful backup has not occurred; independent expected-object monitoring remains unverified.
- The latest operator preflight showed `clashcookies-backup.service` inactive, timer inactive/disabled, production `http://127.0.0.1:8085/healthz` **HTTP 200**, root filesystem **24 GB total, 17 GB used, 7.2 GB free (70%)**. Available space must be rechecked before dumping.

### Next gates and explicit approval boundaries

1. **NOT AUTHORIZED YET:** First controlled PostgreSQL 17 custom-format dump of the live database, temporary restricted staging, dual-age encryption, and B2 upload of the encrypted archive. The assistant requested explicit authorization; the operator instead asked to reopen the Windows SSH tunnel and hand off documentation. Do **not** infer approval. Check current service configuration, plaintext temporary-file handling, disk headroom, B2 permissions/retention requirements and live health before requesting this authorization again. Starting `clashcookies-backup.service` executes a real backup and upload; it is not a harmless test.
2. **Recovery evidence still BLOCKED:** After authorized upload, independently retrieve the **real** encrypted object with off-host read-only recovery credentials, verify its SHA-256/size and Governance retention, decrypt using an off-host private identity, inspect `pg_restore --list`, restore into isolated disposable **PostgreSQL 17**, and validate schema/data/integrity; never restore over production.
3. **Key/monitoring remaining:** Verify durable off-host admin recovery key access and independent age key escrow; confirm expected-object alerts, success-path notifications, and final unattended behavior. Do not commit real key material, private monitoring URLs or emails into documentation.
4. **Timer and release remain separate:** Timer remains disabled/inactive pending recovery and separate explicit approval. Production `main`/draft [PR #1983](https://github.com/tonykslee/ClashCookies/pull/1983) remain blocked; resolve staging absence/waiver, removed Netdata config vs actual deployment, deploy identity, live checkout hygiene, and migration-failure rollback before release.

**Windows CMD development tunnel:** operator-managed `127.0.0.1:15432` → server `127.0.0.1:5432` over SSH. Keep the tunnel in a dedicated CMD window and never store SSH private keys in Git. The separate SSH `codex` identity should not be assumed to have sudo/Docker; all privileged host actions require operator approval.
