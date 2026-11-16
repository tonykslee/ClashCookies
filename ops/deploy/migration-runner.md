# Isolated Prisma migration runner

This is an implementation-only runner for a future reviewed deployment workflow. It is not invoked by `ops/deploy/container-start.sh`, `npm start`, `npm run start:runtime`, or `ops/deploy/deploy-prod.sh`, and it does not activate production migration or deployment behavior by itself.

The entry point is:

```text
npm run migrate:runner
```

The runner requires all of the following through the protected runtime environment. `DATABASE_URL` is never accepted as a command-line argument or printed. The remaining values are an authorization record for the exact target and must not be inferred from the connection string.

- `MIGRATION_EXECUTION_AUTHORIZED=1`
- `MIGRATION_TARGET_ENV` (`disposable` or `production`)
- `MIGRATION_RELEASE_ID`
- `MIGRATION_TARGET_SHA` (exact 40-character checkout SHA)
- `MIGRATION_EXPECTED_MIGRATION_DIGEST` (SHA-256 manifest digest for `prisma/schema.prisma` and every file under `prisma/migrations`)
- `MIGRATION_LOCK_PATH` (absolute, access-controlled lock-directory path)
- `DATABASE_URL` (protected PostgreSQL URL with explicit host, port, database and user)
- `MIGRATION_ALLOWED_DB_HOST`, `MIGRATION_ALLOWED_DB_PORT`, `MIGRATION_ALLOWED_DB_NAME`, `MIGRATION_ALLOWED_DB_USER`, `MIGRATION_ALLOWED_DB_SCHEMA`
- `MIGRATION_ALLOWED_DB_SERVER_ADDRESS`, `MIGRATION_ALLOWED_DB_SERVER_PORT`, `MIGRATION_ALLOWED_DB_MAJOR`

Execution order is fail-closed: acquire the atomic lock, verify the checkout SHA and exact `migrate:deploy` package-script contract, verify the migration manifest, query PostgreSQL identity through Prisma, then invoke `npm run migrate:deploy` exactly once. The child output is captured but never replayed. A nonzero child exit code is returned unchanged; a missing or signal-only result returns the explicit ambiguous-result code. No retry or Prisma resolve/reset operation is performed.

The runner logs only bounded release SHA, migration identity, identity digest, timestamps, exit code, and sanitized classification fields. It does not log connection URLs, passwords, environment contents, SQL output, or application logs.

Before any production integration, a separate reviewed VM wrapper must supply protected credentials, acquire the host-level release lock, perform the backup/release/migration gates in the recovery runbook, invoke this runner from the exact reviewed checkout, and keep normal runtime promotion separate from migration execution.
