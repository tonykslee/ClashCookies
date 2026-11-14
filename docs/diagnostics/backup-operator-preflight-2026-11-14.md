# Production backup infrastructure preflight — operator record (2026-11-14 UTC)

**Repository:** `tonykslee/ClashCookies` · **base:** `dev`  
**Status:** operator-observed infrastructure checks; **NOT** evidence of a completed production backup, restored recovery, deployed backup service, or production release.  
**Companion checklist/runbook:** [`ops/backup/README.md`](../../ops/backup/README.md). **Canonical workflow:** [`docs/ai-development-workflow.md`](../ai-development-workflow.md).

> This record preserves results displayed by the human operator in a live Linux SSH session, plus the matching repository configuration inspected on `dev`. It is not an independent SSH/DB inspection by ChatGPT or GitHub CI. All measurements are a dated snapshot and must be rechecked before production changes. Never place production passwords, B2 secrets, private age identities, Discord tokens, or SSH keys in Git, chat, command output, or PR comments.

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

### Authorized, but not yet executed: create backup DB role

Operator explicitly approved a new account that can **log in using its own SCRAM password**, with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, and the minimum necessary `CONNECT` on the `clashcookies` database, `USAGE` on `public`, and `SELECT` on existing `public` tables and sequences. Include `ALTER DEFAULT PRIVILEGES FOR ROLE clashcookies IN SCHEMA public` to grant `SELECT` on future tables and sequences created by that owner. Scope future grants to the current owner/schema; separately reassess when new owners/schemas are introduced.

**The authorization is for that database role/grant operation only.** Prepare and review the exact SQL/credential handling before execution; use an interactive secret-input procedure that does not expose the password in chat, shell history, commands, process arguments, logs or Git. Verify effective permissions, a read-only database connection, default privileges, and that writing/DDL are denied. Do not grant `pg_read_all_data`, superuser, `BYPASSRLS`, owner membership or create privileges merely for convenience. Do not modify `pg_hba.conf` or production application credentials.

## B2 recovery evidence already collected (prior operator steps)

See `ops/backup/README.md` for provider evidence and caveats. Verified from user-supplied CLI results: private `clashcookies-prod-backups` in `us-west-004`, endpoint `https://s3.us-west-004.backblazeb2.com`; Governance Object Lock 14-day default; `clashcookies-prod/daily/`, `weekly/`, `monthly/` hide after 15/57/187 days and delete later; scoped production upload key without delete/bypass capability; separate off-host read-only recovery key; two off-host age identities independently decrypted a retrieved encrypted harmless test object. Temporary administrative bootstrap credentials were revoked. Off-host durable administrative recovery and independent escrow validation **still require attention**.

**Not tested:** real production database dump/encryption/upload, actual retained B2 database object verification, remote retrieval/decryption/restore of real production data, unattended timer and monitoring behavior, or application/migration recovery from a real failure.

## Remaining gates and operator handoff (in order)

1. **Next approved operation:** create the specifically authorized, least-privilege PostgreSQL `clashcookies_backup` role and scoped grants with secure interactive password entry. Verify effective grants, defaults, host TCP SCRAM login and read-only behavior; do not show secrets.
2. Provision the non-login, no-sudo `clashcookies-backup` **OS** account and isolated directories; establish root-only `/etc/clashcookies/backup.env`, root-owned public `pg_service.conf`, service-account-only `0600` `.pgpass`, and owned temporary staging directory. This is distinct from DB role creation and should be separately approved before changes.
3. Review runtime/config compatibility in `dev`: `/usr/bin/node` in `ops/backup/systemd/clashcookies-backup.service` needs explicit dedicated Node 24 path; `sslmode=require` example needs correction for verified local no-SSL PostgreSQL; `AWS_DEFAULT_REGION=us-east-1` example requires provider verification for B2 `us-west-004`. Use a code/config PR to `dev`, check actual diffs/CI, and obtain **explicit merge/deployment approval**.
4. Build/review an isolated backup runner at `/opt/clashcookies` rather than update the active production `main` checkout. Never copy production Discord tokens or active app environment into the runner; do not invoke normal application startup, Prisma migration deployment, or pollers.
5. Confirm separate host/service account privileges, no secret leakage, B2 signing/retention/lifecycle, off-host admin recovery key escrow, alert endpoints and expected-object monitoring. Install systemd **disabled**; neither execute backup nor start timer without separate authorization.
6. After specific operator authorization, perform one controlled read-only `pg_dump`/dual-age-encrypted production backup and B2 upload. Verify checksums, size and object-specific retention via the restricted recovery key.
7. Retrieve the **real** encrypted database object onto an isolated recovery host, validate SHA-256, independently decrypt with off-host identity, inspect with PostgreSQL 17 `pg_restore`, restore into **disposable** PostgreSQL 17, and validate schema/data/integrity. Never restore into production.
8. Explicitly resolve release-gate decisions for staging absence/waiver, Netdata/monitoring architecture, deployment identity, live checkout hygiene and migration-failure recovery. Only then consider timer approval and the separate `dev` → `main` release review. **Never auto-promote** and **never merge runtime/code changes without approval**.

**Operator interaction convention:** one safe, clearly labeled command per step; user has an existing Linux `tilo@clashcookies` SSH session; Windows local commands must be one physical CMD-compatible line. Stop on unexpected results, preserve existing resources, and do not request credentials in chat.
