# ClashCookies production backup automation

This directory contains a disabled-by-default implementation for daily PostgreSQL 17 custom-format backups. It does not provision B2, create credentials, install systemd units, upload the existing Windows backup, alter the production VM, run Prisma migrations, or start a timer.

## Architecture

The service runs the explicitly configured PostgreSQL 17 `pg_dump` binary with `--format=custom` through a PostgreSQL service file. Startup verifies that the selected binary reports major version 17 and fails closed for any other version. The service selects the libpq service as `service=clashcookies_backup`, so the `dbname=clashcookies` value in `pg_service.conf` remains authoritative. The database password is delivered through a service-account-owned `.pgpass`; no database URL is placed in process arguments. `PGOPTIONS=-c default_transaction_read_only=on` is applied to the dump session.

The completed archive is encrypted locally with `age` to both public recipients. Only public recipient strings are present on the VM. Private identities remain off-host in the operator password manager and emergency escrow.

The encrypted bytes are uploaded to a private Backblaze B2 S3-compatible bucket with Governance Object Lock. A single daily run writes to `daily/`; on the configured UTC weekday it also writes the same encrypted bytes to `weekly/`, and on the configured monthly day it writes to `monthly/`. Each object has a unique key, checksum metadata, and an explicit retention date:

- daily: 14 days
- weekly: 56 days
- monthly: 186 days

The service calculates each Object Lock deadline immediately before its upload, not when database capture begins. It adds a one-hour safety margin to the 14/56/186 full-day periods. The B2 lifecycle rules in `b2-lifecycle.json` hide objects one full day after those periods have elapsed (15/57/187 days), leaving additional safety margin. They delete one day after hiding. B2 lifecycle processing is periodic, so deletion can be delayed; it must never occur earlier than the Object Lock retention. B2 lifecycle rules cannot delete an actively locked object.

The production upload key must not have `bypassGovernance`, `deleteFiles`, bucket-configuration, or lifecycle-rule permissions. It needs only bucket/prefix-scoped list/read/write and per-object retention read/write capabilities required by the chosen B2 API client. Keep a separate read-only recovery key and an off-host administrative key.

## Manual Backblaze setup

An authorized operator must perform these steps in Backblaze before activation:

1. Create a private bucket in the selected region.
2. Enable Object Lock and set a 14-day default retention safety floor. Do not set a 180-day default for every object.
3. Apply `b2-lifecycle.json` to the bucket. Review each prefix and confirm that `daysFromUploadingToHiding` is not less than its retention period.
4. Create a bucket-scoped production key without `bypassGovernance`, delete, lifecycle, or bucket-management capabilities.
5. Create a bucket-scoped read-only recovery key and keep it off the VM.
6. Record the bucket endpoint, bucket name, region, key identifiers, and capability review without recording secret values in Git.
7. Create the primary and emergency age key pairs off-host. Install only the two public recipients in `/etc/clashcookies/backup.env`.
8. Store the private identities in separate off-host recovery locations.
9. Configure an external heartbeat and failure-alert destination that accepts only the non-sensitive event payload documented below.

Do not grant the production key `bypassGovernance`. In Governance mode, that capability is what permits shortening retention or deleting a locked object.

## Provisioning evidence and open recovery gates (operator session, 2026-11-14 UTC)

Detailed VM inspection, authorized cleanup, installed tools, production DB roles/objects/authentication, and the pending approved-but-unexecuted DB role creation are recorded in [`docs/diagnostics/backup-operator-preflight-2026-11-14.md`](../../docs/diagnostics/backup-operator-preflight-2026-11-14.md). Treat it as an operator-observed snapshot, **not** a validated backup or deployment. The `ops/backup/README.md` checklist remains the canonical backup activation checklist.

This is an **operator-reported setup and harmless test-object recovery record**, not a production database backup or a production release authorization. Evidence was checked from the operator's displayed B2/AWS/age command results; GitHub CI did not independently inspect the provider account or private key custody. Do not commit key identifiers, credentials, private age identities, or authentication output.

### Completed and observed

- **Bucket:** `clashcookies-prod-backups` in B2 US West `us-west-004` (`https://s3.us-west-004.backblazeb2.com`), private, SSE-B2 AES-256. B2 `bucket get` reported Object Lock enabled, default **Governance / 14 days**, and revision 5.
- **Lifecycle:** `b2-lifecycle.json` was applied and read back from B2: `clashcookies-prod/daily/` hides after 15 days, `weekly/` after 57 days, `monthly/` after 187 days; all delete one day after hiding and cancel unfinished large uploads after one day. Actual future lifecycle expiration/deletion has **not** been observed.
- **Production upload key:** provider key metadata showed one-bucket and `clashcookies-prod/` prefix restrictions, S3 support, no expiry, and exactly `listBuckets`, `listFiles`, `readFiles`, `writeFiles`, `readFileRetentions`, `writeFileRetentions`. It has no delete, Governance-bypass, or bucket-management capabilities. A scoped S3 list and actual test upload succeeded.
- **Recovery key:** a separate bucket/prefix-restricted, no-expiry S3 key showed exactly `listBuckets`, `listFiles`, `readFiles`, `readFileRetentions`; read-only Object Lock inspection and an actual download succeeded.
- **Encryption custody:** the operator generated independent primary and emergency age v1.3.2 identities off-server and reported storing backup copies separately. Only public age recipients belong on the eventual backup runner. Independent escrow/permissions audit is still pending.
- **Harmless test-object recovery:** an age-encrypted test text object was uploaded with explicit **Governance** retention of 14 days plus one hour. S3 `head-object` and `get-object-retention` verified expected size, SHA-256 metadata, AES-256 encryption, and retain-until **2026-11-28 05:28:14 UTC**. The separate recovery key downloaded the same encrypted bytes; its SHA-256 matched the original; **both** off-server age identities independently decrypted to the original text byte-for-byte. This did **not** execute the production backup script, upload database data, or test PostgreSQL restore.
- **Temporary access cleanup:** temporary administrative bootstrap credentials were reported revoked; three temporary local AWS profiles were removed, and ten named test/authentication files were deleted. Permanent key secrets remain in the operator's password manager, not in Git. The protected test object remains until its retention/lifecycle rules permit cleanup.

### Preflight and activation checklist — still BLOCKED

- [x] B2 bucket, Governance retention, lifecycle rules, scoped keys, and harmless encrypted-object recovery verified from operator CLI output.
- [ ] Verify a durable **off-host administrative recovery path** consistent with the runbook (the temporary bootstrap key was revoked), plus independent key/escrow retrieval and local storage protections.
- [x] Operator inspection verified host PostgreSQL **17** `pg_dump`, `age`, AWS CLI, isolated Node **24.22.3**, and **7.6 GB** available storage after authorized staging/Netdata cleanup (dated snapshot; recheck immediately before any dump). Production `/healthz` remained HTTP 200. See the [detailed preflight](../../docs/diagnostics/backup-operator-preflight-2026-11-14.md).
- [ ] Verify external network connectivity from the final, least-privileged service context and ensure available space for both plaintext and encrypted temporary dumps.
- [ ] Operator **approved** creating the least-privilege `clashcookies_backup` database role and scoped `CONNECT`/`USAGE`/`SELECT` grants including defaults for future tables/sequences, but **role creation/grants have NOT happened**. Verify exact SQL, secure password handling, effective permissions and a read-only host connection. Separately provision/verify non-login OS identity, service-file authority, `.pgpass` 0600 ownership/mode, root-only env file and absence of bot/production credentials in diagnostic output.
- [ ] Verify the B2 signing region from the **operator-populated** backup environment: the corrected template requires `AWS_DEFAULT_REGION=us-west-004` alongside the matching `s3.us-west-004.backblazeb2.com` endpoint, and runtime configuration fails closed if the region is absent. An operator-reported scoped B2 list succeeded with that region, but verify under the final service identity before activation.
- [ ] Configure and verify external heartbeat, failure alerts, and expected-object monitoring with only non-sensitive payload fields.
- [ ] Obtain separate authorization to install the service and perform one controlled production PostgreSQL 17 dump/encrypted off-site upload; verify the resulting object-specific Governance retention and checksum.
- [ ] Retrieve that **actual database backup** using recovery credentials, verify checksum and age decryption, and restore/validate it into isolated disposable PostgreSQL 17.
- [ ] Obtain separate approval before enabling the systemd timer; keep production release and PR #1983 blocked pending all release/recovery gates in `docs/ai-development-workflow.md`.

### Provider/Windows setup lessons

- The initial bucket-console 14-day default appeared as **Compliance**, not Governance. Always inspect actual default mode with the S3 API, and explicitly set/verify **Governance** before relying on the bucket. Object Lock itself remains enabled.
- On the tested Windows B2 CLI **v5.0.2**, `bucket update --lifecycle-rules` failed in its local JSON parser (`GenericAlias` / `__pydantic_config__`) before the update. The operator instead applied the repo's exact native B2 lifecycle JSON using the B2 Native API with an `ifRevisionIs` precondition, then verified the rules through `b2 bucket get`. Do not treat a failed CLI invocation as an applied lifecycle update.
- Time-limited bootstrap keys may expire during setup. Minimize their lifetime and privileges, verify capabilities instead of assuming them, revoke them after setup, and remove temporary plaintext AWS credential profiles. Never paste secrets or private age identities into tickets, chat, logs, or Git.

## Manual VM setup

This section is an operator runbook, not an activation performed by this repository change.

**Verified host alignment (2026-11-14 operator preflight):** The service template selects `/opt/clashcookies-node24/bin/node` (Node 24.22.3), not the absent `/usr/bin/node`. The PostgreSQL service example uses `sslmode=disable` only for the verified `127.0.0.1` Docker-published connection (server SSL is off), and the B2 example sets the matching `us-west-004` endpoint/signing region. These are repository configuration changes, **not** proof of installed or working backup services. Before installation, validate actual Node 24 runner compatibility, host-only TCP binding, and the final service identity. Never use the active production checkout as the backup runner.

1. Install PostgreSQL 17 client tools, `age`, Node.js compatible with the application, and the AWS CLI on the host or approved backup runner.
2. Create a non-login `clashcookies-backup` OS account with no sudo access.
3. Create `/etc/clashcookies` with root ownership and mode `0755`. Install `backup.env` as root-owned mode `0600`; systemd reads this file before dropping to the service account. Install `pg_service.conf` as root-owned mode `0644` because it contains no secret. Install `.pgpass` owned by `clashcookies-backup:clashcookies-backup` with mode `0600`, so the service can read it without relaxing password-file permissions:

   ```sh
   sudo install -d -o root -g root -m 0755 /etc/clashcookies
   sudo install -o root -g root -m 0600 backup.env /etc/clashcookies/backup.env
   sudo install -o root -g root -m 0644 pg_service.conf /etc/clashcookies/pg_service.conf
   sudo install -o clashcookies-backup -g clashcookies-backup -m 0600 .pgpass /etc/clashcookies/.pgpass
   stat -c '%U %G %a %n' /etc/clashcookies /etc/clashcookies/backup.env /etc/clashcookies/pg_service.conf /etc/clashcookies/.pgpass
   ```

4. Set `BACKUP_PG_DUMP_PATH` to the installed PostgreSQL 17 binary, normally `/usr/lib/postgresql/17/bin/pg_dump`. Verify it before activation:

   ```sh
   /usr/lib/postgresql/17/bin/pg_dump --version
   ```

   The service repeats this check and refuses to run unless the reported major version is exactly 17.
5. Use a dedicated PostgreSQL role with `CONNECT`, schema usage, and `SELECT` on tables/sequences only. Do not reuse the application role. Configure default privileges for future tables/sequences through a separately approved database operation.
6. Create `/var/lib/clashcookies-backup`, owned by `clashcookies-backup`, with a disk-space alert threshold and enough room for at least two current dumps.
7. Build the repository so `dist/scripts/backup.js` exists.
8. Install the systemd unit and timer from this directory, but leave the timer disabled until the configuration, B2 capabilities, Object Lock metadata, and key custody are reviewed.
9. Perform one operator-approved test run and verify the object metadata and retention with the read-only recovery key.

The service sends only these notification fields:

```json
{"backup_id":"...","event":"backup_succeeded","object_count":2}
```

Failure notifications omit command output, database URLs, credentials, row data, and Discord information.

## Recovery

1. Retrieve the read-only B2 recovery key and the off-host age private identity.
2. List objects and inspect Object Lock retention before selecting a backup.
3. Download a selected `.dump.age` object and its recorded checksum metadata to an isolated recovery host.
4. Compute SHA-256 over the encrypted file and compare it with the immutable object metadata.
5. Decrypt to a temporary file using the age identity. Never decrypt into the production database host unless separately approved.
6. Inspect the archive with PostgreSQL 17 `pg_restore --list`.
7. Create a new disposable PostgreSQL 17 database using UTF-8 and a `C` locale.
8. Restore with `pg_restore --exit-on-error --no-owner --no-privileges`.
9. Validate table and migration counts, representative aggregates, primary/foreign keys, indexes, extensions, triggers, functions, Prisma `SELECT 1`, and application `/healthz` if an isolated application is started.
10. Keep the live database untouched until every validation passes.

An isolated application test must not receive the production `.env`, Discord token, production guild IDs, or production database credentials. Run database-only validation by default. If an application is required, use mirror/test mode, disable all schedulers and pollers, deny Discord API egress at the network boundary, and verify no Discord messages are attempted.

## Tests

The Vitest suite mocks the dump, age, B2 upload, B2 retention, failure, interrupted-upload, retry, checksum, and temporary-cleanup paths. It does not contact production, Backblaze, Discord, or a live PostgreSQL server.
