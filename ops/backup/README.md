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

## Manual VM setup

This section is an operator runbook, not an activation performed by this repository change.

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
