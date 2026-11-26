# FB-028B-3 — Durable Retention, Garbage Collection, and VM Readiness

Status: implemented on the feature branch; repository foundation only. Production remains NO-GO.

## Implemented contract

`scripts/durable_artifact_retention.py` is the single retention owner. The state file is canonical JSON and is tied to the exact immutable `release-<sha256(identity.json)>` directory. A publication retains the original artifact-service ZIP, authenticated attestation evidence, and authorization evidence when supplied. Successful delivery records `pending`; it never implies active or known-good status.

The state distinguishes active and previous-known-good pointers from `pending`, `reserved`, `in-flight`, `recovery-protected`, and `retired` roles. The first legacy rollback material is the distinct protected `legacy-runtime-baseline` record with `authenticated=false`; it cannot be relabeled. Any missing, malformed, substituted, conflicting, or ambiguous metadata is UNKNOWN/protected and cannot be collected.

Delivery, retention, garbage collection, and future activation use the publication-root `.artifact-retention.lock`. Metadata updates write a unique private temporary file, fsync its contents, atomically replace the state, and fsync the directory on Linux. Future health-gated activation pointer transitions are exercised only through an explicit test seam; no operational activation consumer exists in this milestone.

## Garbage collection and recovery

`python scripts/durable_artifact_retention.py --publication-root <root> --repository-root <checkout>` emits a bounded dry-run inventory. `--execute` is separately required and is limited to 16 entries. Before each deletion, the lock, exact state role, active/previous pointers, identity digest, owner-controlled directory, allowed evidence set, and retained artifact/evidence digests are revalidated. Active, previous, pending, reserved, in-flight, recovery-protected, unknown, and crash-abandoned temporary material is preserved. The command never touches Docker, database storage, detached volumes, independent trust material, or the authorization replay journal.

If publication succeeds before metadata registration, the identity directory is not an owned GC candidate until an explicit registration/recovery pass records matching metadata. If cleanup or metadata persistence is interrupted, stale protected state or unknown material is retained; no filename or directory age is treated as ownership proof. Future coordination with FB-027 detached-volume cleanup must use exact deployment labels and durable ownership evidence, with the two systems sharing the deployment lock during activation but never widening each other's cleanup scope.

## Storage admission

Delivery rechecks bytes and inodes while holding the shared lock. Admission accounts for bounded temporary verification/extraction, persistent artifact and evidence retention, shared-filesystem overlap, preserved runtime/rollback accounting, and configured database/host headroom. Capacity failure blocks safely before destructive work. Existing conservative artifact limits remain unchanged.

## Trust and authorization custody

Authorization private keys remain outside the VM and workflows. Public verification keys, Sigstore roots, revision allowlists, root fingerprints, and rotation/revocation policy are independent inputs; delivered artifacts cannot supply trust roots. The replay journal remains outside the checkout, durable, and protected from GC. Retained evidence is historical verification material, not a bearer credential and not a new authorization. Expired and replayed authorization remain rejected by the existing provenance verifier. No production keys, credentials, roots, or allowlists were generated or installed.

## Readiness procedure

`scripts/vm_readiness.py` accepts an explicit bounded JSON configuration and emits sanitized `PASS`, `BLOCKED`, or `UNKNOWN` findings plus `production_eligible=false`. It evaluates OS/architecture, filesystem bytes/inodes and durability primitives, memory/swap/load/PID/cgroup evidence, Python/OpenSSL/GitHub CLI/SSH availability, wrapper identity and FB-027 markers, legacy rollback path, trust/replay custody paths, and separately supplied health/scheduler evidence. It does not install tools, pull images, start containers, change permissions, inspect Docker, invoke privileged commands, or contact production. It must be run only in a repository-local or disposable Linux environment after owner authorization for any host-specific probe.

Missing or ambiguous evidence never produces PASS. Current live VM image/native ABI, filesystem behavior, resource headroom, wrapper installation/parity, runtime health, scheduler singleton state, trust-root custody, authorization custody, and legacy rollback preservation remain unverified here.

## FB-028B-2b-3 to FB-028B-3 integration boundary

FB-028B-3 must consume the exact retained release identity and independently verified authorization, reserve/consume replay state under its existing contract, and perform health-gated activation with the shared lock. It must preserve the active and previous known-good artifacts and the legacy baseline, coordinate with FB-027 attempt ownership and detached-volume cleanup, and re-run storage/readiness admission immediately before activation. It must not use latest-by-name selection, GitHub Actions availability as retention, delivered trust roots, or an authorization recovered from retained evidence.

Repository tests cover exact pointer protection, pending/recovery retention, atomic metadata failure, malformed/substituted ownership, bounded GC, shared-filesystem accounting, lock contention on Linux, readiness sanitization, and continued production-eligibility rejection. The mandatory real Linux workflow additionally runs the retention/readiness test module; Windows tests are development-only and do not claim Linux fsync or locking guarantees.
