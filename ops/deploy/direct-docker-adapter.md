# Direct-Docker production adapter — Phase 1

**Status:** development/test infrastructure only. The adapter is not installed, wired into the CLI, or authorized to execute against production.

**Source boundary:** `ops/deploy/direct-docker-adapter.js` supplies a fail-closed operation surface compatible with `ops/deploy/migration-aware-deploy.js`. The existing orchestrator default operations remain unsupported for VM-dependent work.

## Purpose

Phase 1 establishes the safety contract needed before a VM wrapper can supply production operations:

- direct-Docker runtime identity for `clashcookies-app`;
- expected production network and port validation;
- rejection of unexpected or ambiguous container and host-process candidates;
- immutable executor, protected credential, lock, and release-record validation;
- separate outer release and inner migration locks;
- strict migration-child environment construction; and
- bounded, secret-rejecting append-only release-record writes.

The module does not reconstruct production Compose, modify the legacy wrapper, start or stop Docker, connect to PostgreSQL, run Prisma, or perform checkout cleanup by itself.

## Adapter activation boundary

`createDirectDockerAdapter()` returns a disabled adapter unless all of the following are explicitly present:

- `adapterEnabled=true`;
- `verificationStatus=PASS`;
- production target identity;
- canonical direct-Docker runtime configuration;
- verified immutable executor metadata and SHA-256;
- verified protected credential metadata;
- verified, distinct release and runner lock paths;
- verified append-only release-record ownership; and
- non-secret database identity metadata.

Even after that configuration is supplied, every production-dependent mutating operation and migration execution remains blocked by a Phase 1 execution gate. The `allowMutations` and `allowMigrationExecution` inputs cannot enable execution. Phase 1 provides no production configuration or VM installation step.

## Direct-Docker runtime contract

The canonical app is validated by name, image, published host/container port, expected network, exact revision SHA, and optional runtime/environment labels. Compose ownership labels must be absent for the app. Database and observability containers may remain Compose-owned.

Docker metadata parsing uses a non-whitespace `|` delimiter and requires an exact field count. Missing labels therefore remain empty fields; malformed rows are rejected rather than shifted. The selected container metadata includes the Docker ID and host PID, while host process metadata includes a sanitized container cgroup ID. A Node/npm/yarn process is accepted only when its PID and container ID both match the canonical container; a separate host process or unknown correlation blocks. The adapter reads only selected ownership labels and never reads container environments or full label maps.

Host `node`, `nodejs`, `npm`, and `yarn` processes are potential candidates only. Process-name inspection is never treated as proof of singleton safety. Any potential host bot process blocks the normalized runtime check until an operator establishes its identity.

## Credential boundary

The credential source must be an existing regular file outside the checkout, owned by the recorded UID/GID, and mode `0600`. Every path component is checked for symlinks and realpath-resolved outside the checkout; protected reads use `O_NOFOLLOW`, descriptor metadata, and a replacement check. Its contents are not read by any executable Phase 1 operation. If a future reviewed primitive enables migration execution, the child must receive a strict allowlist containing the database URL, migration authorization metadata, `PATH`, fixed npm safety settings, and no inherited Discord, cloud, monitoring, or application environment.

The adapter never places the database URL in command arguments, Docker metadata, release records, or logs.

## Lock and release-record boundary

The outer release lock and inner migration-runner lock must be distinct and outside the mutable checkout. The shared implementation is documented in [deployment-lock.md](deployment-lock.md): an atomic lock directory with an exclusive-created owner record, no stale cleanup/retry, and owner/path verification on release. The release record must already exist outside the checkout, match recorded ownership and mode, be verified append-only, and reject multiline, oversized, URL-shaped, password, token, secret, or private-key content. Protected paths reject parent symlinks; release-record appends use `O_NOFOLLOW` and compare descriptor identity after open. The adapter's release-lock and release-record operations remain non-executable in Phase 1.

No recursive lock or release-record cleanup is performed.

## Remaining Phase 2 work

A separately reviewed VM wrapper must still supply concrete read-only and mutating primitives for checkout inspection, Docker inspection, candidate build, migration status, direct runtime promotion, and health/monitoring checks. It must also prove live ownership and permissions on the target VM. Passing these isolated tests is not production deployment readiness.
