> **Established automatic deployment restored:** The GitHub Actions `main` push workflow invokes the existing droplet `~/deploy-prod.sh` via SSH. The withdrawn broker, replacement executor, new privileged operator and separate systemd installation are not used. Only explicitly owner-approved merges of reviewed production-ready `dev` code into `main` should trigger this deployment. The legacy runtime runs `prisma migrate deploy` at startup; schema-bearing changes require representative testing before merging to `dev` and current backup/recovery and production health checks at release time. No production deployment occurs merely by merging this workflow PR into `dev`.

# Deployment and Install Links

## Deployment Model

> **Deployment-state caveat (operator-observed 2026-11-14):** The design below documents how production and optional staging/mirror deployments are intended to work. **Staging containers, database volumes and checkout have been explicitly decommissioned** to reclaim disk space, and staging is **not currently deployed**. Production app/database containers remain active and healthy. Do not assume staging exists, automatically recreate it, or claim staging-gate coverage without an explicit reviewed release decision/waiver. See [backup/droplet preflight](diagnostics/backup-operator-preflight-2026-11-14.md).

The mirror schema gate is intentionally strict for FB-002 P2: the production source must already be migrated with `HeatMapRefBucketTarget` before a staging mirror can read or copy the parent/child projection. A pre-migration source fails the gate before target writes. Staging remains decommissioned; do not provision or access infrastructure for this correction.

Production and staging *when provisioned* use droplet-hosted containers with health-gated promotion.

Runtime expectations:

- Production runs with `POLLING_MODE=active`.
- Staging runs with `POLLING_MODE=mirror`, `POLLING_ENV=staging`, and a production mirror source URL.
- The app exposes `/livez` and `/healthz`.
- `/healthz` is the readiness gate for deploy promotion.
- Docker container running status is not used as readiness.

## Deploy Modes

### Non-migration deploy

Non-migration deploys are near-zero downtime, not true zero downtime. The
version-controlled procedure is `ops/deploy/deploy-prod.sh`; the live
`~/deploy-prod.sh` wrapper remains a separately approved VM artifact.

Flow:

1. Capture `OLD_SHA` from the current checkout.
2. Fetch the target branch tip into `NEW_SHA`.
3. Diff `OLD_SHA..NEW_SHA` for `prisma/migrations/**` and `prisma/schema.prisma`.
4. If no Prisma files changed, create a temporary worktree and build the target in a build-only container.
5. The candidate build receives no production env file, database URL, production network, Discord credentials, active polling mode or startup helper; it cannot log in, register commands, run migrations or start schedulers.
6. Stop the old app only after the candidate build succeeds and the singleton guard still observes exactly one active runtime.
7. Before stopping the old app, copy its exact `dist` and dependency artifacts into owner-labeled rollback volumes. Start the canonical app on the normal port with the candidate's immutable dependency and `dist` volumes, using the normal production env and active polling mode.
8. Verify the canonical app returns HTTP 200 from `/healthz` before reporting success.
9. If canonical start or health fails, retain bounded diagnostics, remove only the deployment-owned failed container, reset to `OLD_SHA`, and restore the old app through the same readiness gate. Rollback uses a deployment-owned prebuilt launcher, so it does not depend on whether the old checkout understands `CLASHCOOKIES_PREBUILT`; it verifies the mounted artifacts, skips compilation, and runs the old checkout's `npm run start:runtime` so Prisma startup behavior is preserved.

The default promotion and rollback readiness budget is 1,500 seconds (25
minutes), calibrated above the observed 12–13 minute cold start. Every probe
has a five-second `curl --max-time` bound. The budget and per-request bound
are overrideable for an operator rehearsal through environment variables, and
the procedure logs both values. The build-only candidate compiles with the
worktree's real `/app/dist` path and copies the verified result into a
separate artifact volume; this avoids deleting a Docker mountpoint while
preserving clean-build behavior. The generated dependency and `dist` volumes
are reused by promotion, so the canonical container does not rebuild the
identical target source. Rollback uses the exact artifact snapshot captured
from the previously running container and verifies its release SHA before
starting it.

Deployment-owned artifact volumes carry explicit labels for release and role.
After a successful promotion or rollback, only detached, verified volumes
owned by this deployment are eligible for cleanup. The live release and the
known-good rollback release are retained. Diagnostic state and bounded logs
are kept in a `0700` directory with `0600` files; preexisting paths are
validated for ownership, type and symlink safety.

No pre-promotion application container is started. This is intentional:
`/healthz` remains the full Discord-plus-database readiness gate for the
canonical production runtime, while the build-only validation cannot be
mistaken for application readiness.

### Candidate lifecycle safety (FB-027 / issue #2177)

The version-controlled procedure now treats each invocation as a distinct
deployment attempt. Candidate-build and artifact-processing containers receive
attempt-scoped names and labels, do not use `--rm`, and are waited on as
daemon-managed containers. A timeout, nonzero exit, `TERM`, `INT`, `HUP`, or
cleanup path runs bounded `stop`, verifies the container is no longer running,
uses bounded `kill` if needed, removes the exact owned container, and verifies
that Docker no longer reports it. Docker CLI timeout status alone is never
treated as proof of termination; exit status 137 is reported as an exit status
unless the wrapper itself observed its deadline.

The version-controlled wrapper first acquires a kernel-backed exclusive
`flock` lock, which is released by the kernel on process death. It then checks
the older directory lock used by the live wrapper; that transition guard is
never recovered concurrently with another version-controlled attempt. The
already-installed `~/deploy-prod.sh` is not retroactively made race-free until
the reviewed wrapper is installed. Startup reconciliation enumerates Docker
resources with bounded queries and distinguishes a successful empty result
from query failure. Complete owner, environment, deployment kind, role,
revision, and attempt identity are required before removal; legacy names,
partial labels, failed inspection, and ambiguous attachments are refused.

Candidate and artifact creation write a durable attempt intent before Docker
is invoked. Bounded create, wait, inspect, log, stop/kill, remove, and
post-removal enumeration operations reconcile a container that was created
before Docker returned its ID. Cleanup failures retain ownership evidence and
block the next attempt. The lock and intent journal can support recovery after
an untrappable interruption such as SIGKILL or power loss on the next start;
they do not claim that SIGKILL itself can be handled.

Before candidate preparation, the procedure records an attempt identity,
requires one active production runtime, checks production `/healthz`, and
performs host admission. The conservative default policy reserves 1,536 MiB
for the production application, database, and essential host services; admits
the candidate only with at least that reservation plus its 1,024 MiB memory
limit; disallows candidate swap by setting the memory-swap limit equal to the
memory limit; limits the candidate to 1 CPU and 512 processes; and refuses
hosts over 25% swap use, over 75% load per online CPU, or below 1,024 free
process IDs. These are admission policy thresholds, not evidence that the
current droplet can safely compile. If the current host cannot demonstrate
the configured headroom, deployment preparation is refused without stopping
production. PID admission uses `pid_max` and the applicable cgroup PID limit,
not `/proc/loadavg`; cgroup and Docker restriction measurements must be
valid, consistent, and enforceable. Increasing timeouts or swap is not a
recovery strategy.

During candidate and artifact preparation, repeated failed health probes are
treated as confirmed production degradation after three consecutive failures;
the owned preparation container is aborted and production remains untouched.
Diagnostics record the attempt, owned container IDs, admission observations,
phase, timeout versus container exit classification, health-abort reason, and
cleanup verification. Logs are bounded and written under the existing private
diagnostics directory; credentials, env-file contents, and production
environment contents are not collected.

These protections are implemented in the repository procedure only. The live
`~/deploy-prod.sh` wrapper still requires the separately approved operator
update described above, so the transition limitation remains until that
installation occurs. Off-host compilation and restart-safe deployment are
not implemented by this change; production host resizing, wrapper installation,
promotion, and deployment remain out of scope.

### Prisma migration deploy

If the `OLD_SHA..NEW_SHA` diff includes `prisma/migrations/**` or `prisma/schema.prisma`, deploy uses the intentional downtime path.

Flow:

1. Capture `OLD_SHA` and `NEW_SHA`.
2. Detect Prisma changes from the diff.
3. Stop the old app first.
4. Start the new app through the normal startup path so `prisma migrate deploy` runs.
5. Verify the canonical app returns HTTP 200 from `/healthz`.
6. If the startup or health check fails, the deploy exits nonzero after cleanup.

## Environment Matrix

| Environment | Runtime mode | Canonical health | Temporary replacement health |
| --- | --- | --- | --- |
| Staging | `POLLING_MODE=mirror`, `POLLING_ENV=staging` | `127.0.0.1:8086/healthz` | `127.0.0.1:18086/healthz` |
| Production | `POLLING_MODE=active`, `POLLING_ENV=prod` | `127.0.0.1:8085/healthz` | `127.0.0.1:18085/healthz` |

Staging mirror mode must not run the upstream pollers directly. Production continues to own active polling and schedulers.
Mirror sync also carries the finalized war-plan history tables (`WarPlanComplianceEvaluation` and `WarPlanViolation`) so staging reads stay consistent without performing local evaluation.

## Operational Notes

- Build happens inside the replacement container before `/healthz` is available.
- A cold deploy can take a long time, so deploy scripts allow a long replacement health timeout.
- The replacement container may be running while it is still building, but that does not count as ready.
- Promotion is gated on app-level `/healthz`, not Docker status.
- The final handoff still includes a brief restart window when the old app is stopped and the canonical app is started.
- Historical SyncCycle replay is a one-time compiled repair utility. Dry-run is the default and only exact persisted `ScheduledSyncPost` boundaries can be written; prep-derived times are never promoted, and no membership snapshots or Home rows are synthesized. After the normal build, inspect with `docker exec clashcookies-app node dist/scripts/backfillMembershipHistorySyncCycles.js --guild <guild-id> --syncs <range>` and apply explicitly with `docker exec clashcookies-app node dist/scripts/backfillMembershipHistorySyncCycles.js --guild <guild-id> --syncs <range> --apply`.
- Historical participation repair is a separate one-time compiled utility. Review with `docker exec clashcookies-app node dist/scripts/backfillMembershipHistoryParticipation.js --guild <guild-id> --syncs 521-553`; apply only the reviewed scope with the same command plus `--apply`. It appends reconstructable `ClanWarParticipation` rows only, never creates SyncCycles or derived/Home state, and re-reads counts after bounded writes.

## Health Endpoints

From the droplet host, use:

- Staging:
  - `curl http://127.0.0.1:8086/livez`
  - `curl http://127.0.0.1:8086/healthz`
- Production:
  - `curl http://127.0.0.1:8085/livez`
  - `curl http://127.0.0.1:8085/healthz`

`/livez` is process liveness only. `/healthz` should succeed only when the app is ready.

## Deployment Notes

### FB-028A off-host runtime artifact evidence

The separate `Runtime Artifact Round Trip` GitHub Actions workflow builds a clean runtime archive from the exact checked-out commit in the pinned `node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5` image for `linux/amd64`. The build uses Node 20, Yarn Classic 1.22.22, `yarn install --frozen-lockfile`, and the canonical `npm run build`; it retains the complete dependency tree, generated Prisma client/native engine, Prisma CLI, compiled `dist`, schema, and migrations. The legacy manifest records the full Git SHA, workflow run and attempt, package/lockfile/Prisma inputs, toolchain, platform, native-library compatibility, build duration, archive size, extracted footprint, and the SHA-256 sidecar. It remains explicitly unauthenticated development evidence.

The workflow then downloads the archive into a separate least-privilege signer job and creates a GitHub-native Sigstore artifact attestation with the immutable `actions/attest` action. The signer job has no production credentials and executes no artifact contents. A fresh validation job retrieves both the archive and attestation bundle and invokes the official `gh attestation verify` verifier against the private archive snapshot before archive parsing or publication. Certificate claims, rather than self-reported predicate fields, establish the exact repository name/ID, source ref and SHA, signer workflow and signer revision, GitHub-hosted runner, OIDC issuer, and subject digest. Authenticated GitHub Actions run metadata independently checks the run ID, attempt, event, source SHA, and workflow path; predicate run fields are correlation evidence only. The versioned authenticated envelope is separate from the legacy manifest and contains the artifact class, archive digest/size, source, signer, run, platform, and pinned image contract.

Validation downloads the published bytes in a fresh job, rejects malformed or mismatched metadata, unsafe paths, escaping symlinks, missing runtime files, wrong revisions, and incompatible platforms, then extracts safely. The producer explicitly emits GNU tar format. The accepted physical format is intentionally narrow: regular files, directories, symlinks, and bounded GNU long-name/link extension headers (`L`, `K`); PAX local/global headers (`x`, `g`), hardlinks, sparse/special types, Solaris `X`, legacy NUL-type directories, and unsupported metadata variants are rejected. Before Python `tarfile` sees the archive, a bounded gzip/tar preflight accounts for physical header checksums and supported types, zero extension padding, extension recursion, GNU long-name/link payloads, sparse representations, padded sizes, non-regular payload semantics, legacy NUL-type directory framing, and the complete tar/gzip termination. Rejecting PAX before parser dispatch removes global-dictionary amplification and prevents PAX framing or size overrides from exposing hidden headers. The preflight rejects oversized declared metadata before its body is allocated or parsed. The extracted runtime is checked in the same pinned Linux family without dependency installation, compilation, or Prisma regeneration. A disposable PostgreSQL container supplies a bounded Prisma CLI/schema check and a `SELECT 1` native-engine query probe. This does not prove the full migration chain, live VM compatibility, application readiness, or production deployment safety.

Artifacts and attestation bundles are retained for three days and are explicitly marked non-production evidence. The workflow exercises valid cryptographic verification, modified-subject rejection, source-expectation rejection, authenticated digest binding to the hardened validator, safe extraction, the pinned Linux runtime probe, and the disposable PostgreSQL Prisma/native-engine probe. A valid development envelope is explicitly rejected by the isolated production eligibility policy. Forks or restricted runners that cannot mint attestations must fail as unavailable evidence; they must not be reported as passing and must not receive unsafe permission expansion. The workflow does not start the Discord runtime, use production credentials or services, modify the production deployment workflow, install the live wrapper, consume artifacts in production, promote releases, or provide a fallback to local compilation.

The FB-028B validation boundary now uses a bounded, private disk-backed snapshot. The source is opened as a non-symlink regular file with nonblocking/no-follow flags where supported, fstat-verified, copied with bounded reads, fsynced, permissioned read-only, and held through an owned descriptor. Checksums, preflight, `tarfile` validation, content hashing, and extraction read that snapshot rather than reopening the external pathname. Every regular entry is hashed during validation; extraction compares the validated entry contract and each content digest, rechecks the snapshot digest before publication, defers symlink creation, and atomically publishes only a complete temporary tree. Every destination ancestor must already be an existing non-symlink directory; on Linux the destination parent must be owned by the effective UID and not group/world-writable. That parent is opened and identity-checked before the private extraction workspace is created, and its descriptor is retained through extraction, cleanup, and publication. The workspace is created through that descriptor, its directory entry is checked against the retained workspace descriptor before publication, and cleanup locates the retained inode if the name was substituted. On Linux publication is descriptor-anchored and requires `renameat2(RENAME_NOREPLACE)`; if that primitive is unavailable, validation fails closed. Existing or ambiguous destinations, unsafe sidecars, source symlinks, non-regular inputs, malformed metadata, and failed extraction/validation fail closed without publishing output.

The snapshot and destination-parent descriptor are process-owned boundaries, not cryptographic protection from a same-UID or root actor with permission to inspect or mutate the validation workspace or trusted ancestor. chmod, stat, and inode checks are defense-in-depth rather than proof against that actor; the Linux production assumption is that all ancestors remain trusted existing directories and the retained destination parent is not replaced or made writable by another actor. The supported runtime is Python 3 with the maintained standard-library `tarfile` implementation on Linux/amd64 CI and Windows development hosts; Linux filesystem permissions and regular-file descriptor semantics are the production-relevant assumption. Validation reports elapsed time, archive/header limits, archive and extracted sizes, an estimated temporary disk requirement, and peak memory only when the host can measure it reliably. These are bounded validation measurements, not droplet compatibility evidence.

These artifacts remain explicitly non-production evidence. The isolated production policy requires an externally supplied approved release SHA, `tonykslee/ClashCookies` and its stable repository ID, exact `refs/heads/main` source identity, an explicitly allowed signer workflow and revision, an authorized main-release event context, matching run/attempt and authenticated digest/size, the production artifact class, and the supported platform/image contract. It rejects dev pushes, PR test-merge revisions, forks, local builds, moving refs, stale or ambiguous contexts, and development classifications. The policy is not called by `deploy-prod.yml`, `ops/deploy/deploy-prod.sh`, or `ops/deploy/container-start.sh`; production delivery remains a later B-2b slice. Remaining gates include authenticated production-release authorization and delivery, production VM admission and filesystem/resource compatibility, restart and migration behavior, operator-approved rollback/recovery, and owner-approved promotion. Do not consume artifacts in production, promote releases, deploy, or close issue #2178 from this slice.

Future B-2b delivery must carry the exact main-push event SHA, run ID, attempt, artifact identity, and signer revision from the approved release workflow; it must select that exact run/attempt and artifact digest rather than resolve a newer branch tip or use latest-by-name lookup. Delivery must use the existing SSH architecture with verified host identity, bounded transfer into a private receiving workspace, independent post-transfer digest verification, atomic no-replacement acceptance, and durable active/previous known-good retention independent of Actions expiration. It must document offline verification roots and lifecycle if offline verification is selected, the first legacy-runtime rollback baseline, current VM image/native ABI/filesystem/inode/disk/memory/swap/cgroup facts, live health and singleton checks, and preserve FB-027 lock, attempt ownership, deadlines, and cleanup. Historical VM observations and GitHub-hosted measurements are not current production compatibility evidence.

- **Backup release gate (observed Nov 15):** A real encrypted off-host backup and separate disposable PostgreSQL 17 restore were operator-verified. Freshness, recovery custody, staging waiver, and the migration-bearing release still require explicit review/approval. The backup timer remains disabled.

- Commands are registered as guild commands using `GUILD_ID` on startup.
- If commands are missing, verify environment (`DISCORD_TOKEN`, `GUILD_ID`) and restart.
- Observability is documented separately in `docs/observability.md` and stays localhost-only by default on the droplet.
- Droplet deploys use the Yarn path (`yarn.lock`) for deterministic installs.
- The current container path uses `ops/deploy/container-start.sh`, which runs the dependency guard and then starts the app.
- `yarn start` rebuilds from `src` before launching the compiled `dist` app, and the build step cleans `dist` first so stale artifacts do not survive between deploys.

## Install Links

Prod guild install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=0&scope=bot+applications.commands

Prod user install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=1&scope=bot+applications.commands

Staging guild install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=0&scope=bot+applications.commands

Staging user install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=1&scope=bot+applications.commands
