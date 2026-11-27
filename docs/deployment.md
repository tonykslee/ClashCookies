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

### FB-028B-3a production-candidate producer boundary

The same workflow also runs on an exact `push` to `refs/heads/main`. Only that fixed event, the approved repository and stable repository/owner IDs, the immutable workflow revision, the pinned `linux/amd64` image, and the exact checked-out `GITHUB_SHA` produce the versioned `production-candidate-runtime-evidence-v1` profile. PRs, `dev` pushes, local builds, and unsupported contexts remain development evidence or are rejected. The candidate remains `nonProductionEvidence=true`, `deployableRelease=false`, unauthenticated in its legacy manifest, and credential-free with respect to production; it never starts the runtime, accesses a production database, invokes SSH, or changes production eligibility.

Candidate validation receives the expected class independently of the delivered manifests. It binds both manifests, the authenticated archive subject digest, source/ref/event, repository IDs, signer workflow and immutable revision, runner, run invocation, exact run attempt, and the pinned image. A development attestation cannot be relabeled as a candidate because the independently supplied main-push expectation and official verifier source claims must both match. The shared descriptor-backed archive preflight, checksum, extraction, file, migration, and native-engine validation boundary remains the only archive parser.

After byte-verified exact selection, the workflow emits a bounded candidate evidence record containing the main-push SHA, producer/signer revisions, run and attempt, exact artifact-service ZIP ID/name/digest/size, inner archive digest/size, platform/image, authenticated provenance, and validation measurements. It is explicitly non-authoritative, is not a trusted-root input or bearer credential, and does not issue or consume authorization. Subsequent authorization and delivery must independently verify successful completion of the exact producer and validation run; the current workflow must not be required to observe its own completed run. Main-push candidate runs skip the existing development-only SSH receiver and retention integration path.

The candidate producer does not coordinate the existing `deploy-prod.yml` main-push deployment workflow. Before any future production promotion, an independently authorized consumer must select and verify this exact candidate, coordinate with the existing wrapper under the shared FB-027 protections, and perform the separate readiness, migration, rollback, authorization-consumption, and owner-approval gates. No genuine production-candidate issuance, main-push attestation, production delivery, promotion, or deployment is claimed by local validation; Docker/Linux/GitHub-native evidence remains an exact-head CI requirement.

### FB-028B-3b independently authorized candidate delivery boundary

Owner-local candidate intake is an independently bounded procedure. It queries the exact `actions/runs/{run_id}/attempts/{run_attempt}` metadata route, retrieves every page from the exact-attempt jobs route, rejects incomplete/duplicate/unbounded pagination, and requires a completed successful main-push attempt with the named build, GitHub-native signing, and retrieval/validation jobs plus their successful mandatory steps. Only then does it select the exact artifact-service ZIP and derive the exact inner archive identity. The resulting verification context is canonical, size-bounded, SHA-bound to that identity, explicitly non-authoritative, and retained as evidence; candidate selection evidence is never treated as approval.

Owner approval uses a separate external Ed25519 signing procedure. The owner reviews the canonical record prepared from the exact candidate identity and independent verification-context digest, signs it outside CI, and supplies the detached signature, immutable key ID/fingerprint, and explicit producer/signer revision allowlist. Candidate authorization uses the distinct `owner-approved-production-candidate-delivery-v1` context, has exactly the bounded forward-release validity window, and is rejected if its context, revisions, key, identity, or lifecycle do not match. No private signing key, production credential, or production default is read by the repository workflow.

The candidate SSH receiver fails closed unless the owner explicitly configures the external authorization public key, key ID/fingerprint, revision allowlist, durable replay journal, offline trusted root, and offline expectation. It requires the original ZIP, attestation bundle, canonical authorization envelope, canonical independent verification context, and canonical retained verification evidence; it verifies all of them offline before admission. Under the existing receiver-lock then shared-retention-lock order, it reserves replay state durably before atomic no-replacement publication and retention registration. Retries are identity- and evidence-matched; conflicts fail closed. Delivery never consumes authorization or activates production.

Retention owns the original ZIP, attestation, canonical authorization, independent verification context, offline expectation, verification receipt, and trusted-root snapshot. Historical offline verification rechecks the signed authorization at its issuance time and the retained context without opening the replay journal, reserving, consuming, contacting GitHub, or relying on fresh authority. Candidate delivery remains non-authoritative and production remains `NO-GO`; no deploy, activation, promotion, or production default is changed.

### Trusted SSH artifact-delivery boundary (FB-028B-2b-2)

The repository now contains a delivery-only boundary in `scripts/trusted_ssh_artifact_delivery.py`. It transfers the original exact artifact-service ZIP and bounded attestation/authorization evidence through standard OpenSSH with `-F none`, `StrictHostKeyChecking=yes`, an explicitly supplied owner-controlled `known_hosts`, global-known-hosts and proxy/multiplexing/forwarding disabled, an explicit disposable identity, `BatchMode=yes`, and no shell command interpolation. Sender pipe drains, writer cleanup, subprocess reaping, receiver frame reads, validation, and publication share bounded deadlines. The receiver accepts a length- and digest-framed stream into a private owner-checked Linux workspace outside the mutable checkout, rejects trailing bytes, and returns a structured acknowledgment bound to the requested identity and retained publication bytes. It rejects symlinked transport inputs, unsafe extracted links, path traversal, special files, substitutions, oversized or truncated inputs, incomplete ZIP evidence, and unsafe publication roots; it never executes received contents.

The receiving verifier checks the same private ZIP snapshot for the expected outer ZIP and inner archive digest/size, extracts only the named archive plus its checksum and manifest into a destination that did not previously exist, and reuses the hardened validator before atomic no-replacement publication. Receiving, publication, and trust inputs are independently configured and non-overlapping; existing ancestors, descriptor identity, temporary bytes, sidecars, and receiving elapsed time are bounded and checked. Published ZIP and attestation bytes are reverified before a new or identical-retry acknowledgment; conflicting, substituted, incomplete, or stale content is rejected. The synthetic authorization test seam reuses the existing signed-record verifier and `AuthorizationReplayJournal.reserve()` only; delivery never consumes authorization and never enables production eligibility.

Offline GitHub attestation verification is explicit and separate from online API correlation. The pinned `gh` v2.89.0 verifier receives the original bundle plus an independently acquired `trusted_root.jsonl` through `--custom-trusted-root`; the root is required to be external to the mutable checkout, privately snapshotted, owner-controlled and bounded. Offline execution removes GitHub tokens and uses an empty private `GH_CONFIG_DIR`. Root custody, acquisition, refresh, rotation, expiry and revocation remain operational responsibilities: a root must be acquired from the official `gh attestation trusted-root` path or an independently reviewed out-of-band mirror, hash-recorded, access-controlled, refreshed deliberately, and never accepted from the transferred payload. Offline certificate verification does not prove current repository-name ownership; authenticated GitHub API correlation at intake remains required for that claim. If those independent materials are unavailable, delivery fails closed.

FB-028B-2b-2b is development-evidence and test-only authorization machinery. FB-028B-2b-3 adds the repository foundation for durable retention, bounded explicit GC, shared storage admission, interrupted-operation protection, custody documentation, and a sanitized repository-local readiness collector. It still does not alter `deploy-prod.yml`, `deploy-staging.yml`, the production wrapper, runtime activation, VM state, production credentials, or production eligibility, which remains unconditionally disabled.

### FB-028B-2b-3 durable retention and readiness foundation

`scripts/durable_artifact_retention.py` is the single owner of the durable retention state contract. Its canonical JSON state is tied to the exact SHA-256 identity-directory name and retains the original artifact-service ZIP, attestation evidence, and authorization evidence where present. It distinguishes active and previous-known-good pointers, pending/reserved/in-flight/recovery-protected roles, and explicitly retired releases. The first legacy runtime rollback baseline is represented as `legacy-runtime-baseline` with `authenticated=false`; it is always protected and is never relabeled as a release.

Delivery, retention, bounded GC, and future activation share the kernel-backed `.artifact-retention.lock` in the publication root. Metadata writes use exclusive temporary files, file fsync, atomic replace, and directory fsync on Linux. Missing state requires explicit initialization on an empty root; missing, malformed, conflicting, substituted, or unknown metadata is retained as ambiguous and blocks deletion. GC is an explicit command with a dry-run inventory by default and a maximum of 16 deletions per execution; each deletion has a durable planned/deleting transaction and is revalidated through descriptor-bound ownership under the lock. It never prunes Docker, database storage, trust material, authorization replay journals, active/previous/pending/reserved/recovery-protected releases, or crash-abandoned temporary directories. Destructive GC is unsupported on non-POSIX hosts.

Delivery admission now rechecks shared-filesystem bytes and inodes under the shared lock, including bounded temporary verification, persistent evidence retention, configured host/database headroom, and preserved runtime accounting. Admission failure leaves the running application and rollback material untouched. The replay journal remains an independent durable authorization boundary: retained evidence does not consume or recreate authorization, and expired or replayed authorization remains rejected by `runtime_artifact_provenance.py`.

`scripts/vm_readiness.py` is a bounded, sanitized collector for later owner-authorized use in repository-local or disposable Linux environments. It reports only `PASS`, `BLOCKED`, or `UNKNOWN`, requires explicit database/host and applicable-cgroup reserve policies, rejects arbitrary private `status=PASS` JSON, never emits credentials, private keys, raw environment values, URLs, process arguments, or unrestricted Docker output, and does not install, pull, start, chmod, or invoke privileged operations. Live VM facts, installed wrapper parity, current health/scheduler state, trust-root custody, native ABI, and resource headroom remain unverified until a separately authorized probe. The collector and retention foundation do not enable production activation.

### FB-028B-3d-1 durable activation transaction foundation

`scripts/durable_activation_transaction.py` adds the non-operational activation contract while `scripts/durable_artifact_retention.py` remains the sole owner of retention metadata and pointer publication. Retention state v2 has an explicit validated upgrade path from v1, a pointer-generation fence, and one bounded `activation_operations` table. An unresolved operation records the exact candidate/runtime identity, archive-bound preparation metadata digest, activation authorization record digest, authorization/retry identities, destination, incumbent, previous-known-good release, actual rollback target, and forward/recovery pointer generations. Forward, delivery, and rollback replay consumption proofs are persisted. Every non-pointer release referenced by an unresolved or historical transaction is protected; terminal operation history fails closed at capacity and GC cannot collect a transaction-protected or ambiguous publication.

The durable phases distinguish intent from observed outcome: validated intent, authorization-consumption pending/consumed, incumbent stop intent/observation, candidate start intent/observation, candidate health verification, failed-candidate compensation authorization pending, successful activation, rollback intent/observation, successful rollback, and recovery required. Failed-candidate compensation is fenced to the actual incumbent; post-activation recovery is separately authorized; failed stop/start/health observations cannot advance as success. Observed outcomes are separate versioned evidence bound to the exact phase subject and runtime identity and, in this slice, require the isolated test-harness source. No Docker command, container replacement, health boolean, migration, wrapper, production default, or production eligibility path is wired to this contract.

Activation authority uses the existing Ed25519 verifier and replay journal with the distinct `owner-approved-production-activation-v1` context and `activation-forward`/`activation-recovery` scopes. The signed verification-context digest covers the exact operation, runtime, destination, pointer-generation, preparation, rollback-target, recovery-kind, and retry binding. Delivery authority remains `owner-approved-production-candidate-delivery-v1`; a delivery envelope cannot establish activation permission. Admission independently verifies the prepared archive-bound candidate, retained delivery reservation, resource headroom derived from retained/prepared material, independent trust custody, and canonical lock. Consumption is journal-first at the boundary and retention publication is reconciled from exact reserved/consumed evidence after interruption, including consumed entries whose authority has since expired; delivery replay consumption is separately reconciled before pointer publication. Forward expiry cannot authorize a new recovery operation, and consumed authority is never reset or substituted.

The FB-028B validation boundary now uses a bounded, private disk-backed snapshot. The source is opened as a non-symlink regular file with nonblocking/no-follow flags where supported, fstat-verified, copied with bounded reads, fsynced, permissioned read-only, and held through an owned descriptor. Checksums, preflight, `tarfile` validation, content hashing, and extraction read that snapshot rather than reopening the external pathname. Every regular entry is hashed during validation; extraction compares the validated entry contract and each content digest, rechecks the snapshot digest before publication, defers symlink creation, and atomically publishes only a complete temporary tree. Every destination ancestor must already be an existing non-symlink directory; on Linux the destination parent must be owned by the effective UID and not group/world-writable. That parent is opened and identity-checked before the private extraction workspace is created, and its descriptor is retained through extraction, cleanup, and publication. The workspace is created through that descriptor, its directory entry is checked against the retained workspace descriptor before publication, and cleanup locates the retained inode if the name was substituted. On Linux publication is descriptor-anchored and requires `renameat2(RENAME_NOREPLACE)`; if that primitive is unavailable, validation fails closed. Existing or ambiguous destinations, unsafe sidecars, source symlinks, non-regular inputs, malformed metadata, and failed extraction/validation fail closed without publishing output.

The snapshot and destination-parent descriptor are process-owned boundaries, not cryptographic protection from a same-UID or root actor with permission to inspect or mutate the validation workspace or trusted ancestor. chmod, stat, and inode checks are defense-in-depth rather than proof against that actor; the Linux production assumption is that all ancestors remain trusted existing directories and the retained destination parent is not replaced or made writable by another actor. The supported runtime is Python 3 with the maintained standard-library `tarfile` implementation on Linux/amd64 CI and Windows development hosts; Linux filesystem permissions and regular-file descriptor semantics are the production-relevant assumption. Validation reports elapsed time, archive/header limits, archive and extracted sizes, an estimated temporary disk requirement, and peak memory only when the host can measure it reliably. These are bounded validation measurements, not droplet compatibility evidence.

These artifacts remain explicitly non-production evidence. The isolated production policy requires an externally supplied approved release SHA, `tonykslee/ClashCookies` (stable repository ID `668452496`, owner ID `18295450`), exact `refs/heads/main` source identity and `push` event, an explicitly allowed signer workflow and immutable signer revision, exact run ID and attempt, the artifact-service ZIP ID/name/digest/byte count, the inner runtime archive name/digest/byte count, the production-candidate contract class, and the supported `linux/amd64` pinned image contract. It rejects dev pushes, PR test-merge revisions, forks, local builds, moving refs, stale or ambiguous contexts, expired artifacts, attempt substitution, ZIP/archive identity confusion, and development classifications. The policy is not called by `deploy-prod.yml`, `ops/deploy/deploy-prod.sh`, or `ops/deploy/container-start.sh`; production delivery remains a later B-2b slice.

The exact-selection contract uses `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}` for the attempt, then the bounded CLI path for `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts?per_page=100`. GitHub's artifact response supplies an artifact-service ZIP digest and size but does not expose an attempt field, so selection must match the exact artifact ID, exact attempt-qualified name `runtime-artifact-{run_id}-{run_attempt}`, API digest/size, non-expired retention, coherent attempt chronology, run source SHA/branch/repository/owner, artifact head SHA/branch/repository, PR head/base/test-merge correlation where applicable, and authenticated inner archive digest/size. A run-scoped latest-by-name query, branch-tip lookup, duplicate match, missing page, rerun substitution, future-created artifact, or partial rerun without those bindings is a refusal. The artifact-service ZIP and inner `tar.gz` are separate identities; byte verification is reported only after the exact ZIP has been consumed from a private descriptor-backed snapshot that is also parsed.

Protected GitHub environments can provide human approval for a job, but upstream environment approval evidence does not durably bind an exact artifact-service ZIP and inner archive for offline delivery. The authorization-only feature branch adds a versioned canonical authorization record and detached Ed25519 verification through the installed OpenSSL tooling. The record binds the exact immutable release identity, explicit owner-supplied producer/signer revision allowlists, 24-hour forward validity, stable retry identity, and separate recovery context. The trusted public key and durable replay journal are required as external inputs outside the mutable checkout; the verifier requires an independently expected key ID and Ed25519 SPKI fingerprint, verifies from a bounded private key snapshot, and parses only those verified canonical bytes. Replay state is reverified and bound to the canonical signed-record digest, key fingerprint, full identity, operation, scope, recovery context, issuance, and expiry. The journal maintains verified directory identity, uses a bounded five-second serialized lock acquisition, private owner-checked Linux directories, atomic no-replace reservations, unique transition files, re-fsyncs identical existing reservations before acknowledging retries, and fails closed on file/directory fsync errors. Windows development validation uses an explicit non-production mode and does not claim Linux durability guarantees. Tests use disposable keys and isolated temporary stores.

No production key, trust root, allowlist, replay store, or production authorization consumer is provisioned. Typed constructors, JSON diagnostics, fixtures, environment variables, and caller booleans remain non-authoritative. Forward authorization cannot be reused for rollback: rollback requires a separately signed recovery authorization. Production eligibility remains unconditionally disabled. The delivery-only SSH boundary now exists for isolated development evidence and synthetic authorization tests; deployment workflows, live wrapper, and VM state remain unchanged.

Remaining gates include authenticated production-release authorization and delivery, production VM admission and filesystem/resource compatibility, restart and migration behavior, operator-approved rollback/recovery, and owner-approved promotion. Do not consume artifacts in production, promote releases, deploy, or close issue #2178 from this slice.

Future production B-2b/B-3 consumption must carry the exact main-push event SHA, run ID, attempt, artifact identity, signer revision, and independent authorization from the approved release workflow; it must select that exact run/attempt and artifact digest rather than resolve a newer branch tip or use latest-by-name lookup. FB-028B-2b-3 supplies retention and readiness primitives only. Production use still requires the owner-approved activation consumer, a reviewed offline-root lifecycle, actual external key custody, the first legacy-runtime rollback capture, current VM image/native ABI/filesystem/inode/disk/memory/swap/cgroup facts, live health and singleton checks, and preserved FB-027 lock, attempt ownership, deadlines, and cleanup. Historical VM observations and GitHub-hosted measurements are not current production compatibility evidence.

- **Backup release gate (observed Nov 15):** A real encrypted off-host backup and separate disposable PostgreSQL 17 restore were operator-verified. Freshness, recovery custody, staging waiver, and the migration-bearing release still require explicit review/approval. The backup timer remains disabled.

- Commands are registered as guild commands using `GUILD_ID` on startup.
- If commands are missing, verify environment (`DISCORD_TOKEN`, `GUILD_ID`) and restart.
- Observability is documented separately in `docs/observability.md` and stays localhost-only by default on the droplet.
- Droplet deploys use the Yarn path (`yarn.lock`) for deterministic installs.
- The current container path uses `ops/deploy/container-start.sh`, which runs the dependency guard and then starts the app.
- `yarn start` rebuilds from `src` before launching the compiled `dist` app, and the build step cleans `dist` first so stale artifacts do not survive between deploys.

FB-028B-3c preparation is separate from this activation path. The immutable
preparation entry point creates read-only candidate and legacy runtime material
outside the checkout, but the existing wrapper, active/previous pointers,
migrations, and production workflow remain unchanged until the separately
reviewed FB-028B-3d activation consumer.

## Install Links

Prod guild install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=0&scope=bot+applications.commands

Prod user install:
https://discord.com/oauth2/authorize?client_id=1131335782016237749&permissions=8&integration_type=1&scope=bot+applications.commands

Staging guild install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=0&scope=bot+applications.commands

Staging user install:
https://discord.com/oauth2/authorize?client_id=1474193888146358393&permissions=8&integration_type=1&scope=bot+applications.commands
