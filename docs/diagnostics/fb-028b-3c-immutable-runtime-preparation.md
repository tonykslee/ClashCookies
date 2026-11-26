# FB-028B-3c — Immutable runtime preparation

Status: implemented repository boundary, production `NO-GO`.

This milestone adds `scripts/immutable_runtime_preparation.py`. It is a
preparation-only consumer of an exact candidate already retained by
`durable_artifact_retention.py`. It does not select GitHub artifacts, issue or
consume authorization, change active/previous pointers, start Docker, run
Prisma, run migrations, or activate a candidate.

## Candidate contract

The entry point requires the SHA-256 identity of one retained candidate, an
independently configured authorization policy, the independently acquired
offline trusted root and exact root version, and a legacy-runtime source
evidence file. The identity is read from the retention record; an optional
identity file must be canonical and byte-equal to that retained identity.

Preparation performs all of the following before publication:

1. Re-checks retained ownership and complete evidence through the retention
   store and re-runs the existing official `gh` verifier boundary through
   `verify_retained_offline`.
2. Verifies the current signed owner authorization, exact destination and
   verification-context binding, and the existing durable replay reservation.
   The reservation remains `reserved`; preparation never reserves, renews,
   releases, or consumes it.
3. Reuses `validate_candidate_archive_contents`, including the descriptor-backed
   ZIP snapshot and hardened runtime archive validator. No dependency install,
   compilation, Prisma generation, application start, or migration occurs.
4. Publishes `candidate-<identity-sha256>/runtime` outside the checkout with
   no-replacement publication and versioned `preparation.json`. The runtime
   contains only the packaged `dist`, `node_modules`, `prisma`, `package.json`,
   `yarn.lock`, and manifest contract accepted by the existing validator. A
   tree integrity record covers regular-file contents, modes, directory modes,
   executable bits, symlink targets, sizes, and entry count.

The candidate image is accepted only when the retained identity and manifest
carry the existing exact `linux/amd64` and digest-pinned Node 20 Bookworm
contract. A mutable tag is not an equivalent image identity.

## First legacy baseline

The source evidence contract is intentionally unauthenticated and separate
from candidate provenance. It must describe the observed running container
identity, exact checkout revision, digest-pinned image identity, platform,
prebuilt startup/migration boundary, and a complete bounded component map:
`dist`, `node_modules`, `prisma`, `package.json`, `yarn.lock`, and
`startup/container-start.sh`. Components are read-only sources; credentials,
environment files, database contents, and unrelated checkout paths are not
accepted.

The source is measured before and after copying. Regular files are read through
stable descriptors, entry types and relative symlinks are checked, and the
runtime identity markers in the existing `dist`/`node_modules` artifact stamps
must agree with the observed checkout revision. The staged runtime is fsynced
and published without replacement as `legacy-runtime-baseline/`. Its exact
unauthenticated integrity record is registered through the retention store's
separate `legacy-runtime-baseline.json` custody record. An existing preserved
baseline is never overwritten; a conflict, mutation, incomplete source, or
missing exact identity blocks preparation.

The baseline is deliberately not an authenticated release and is not an
active/previous pointer. If the source is unavailable after a genuine baseline
has been captured, retries verify the preserved runtime and metadata directly;
they do not infer a new source identity.

## Locking, admission, and recovery

When a deployment lock file is supplied, the order is:

`FB-027 deployment lock` → `activity_lock(publication-root)` → `authorization replay journal`.

The preparation code never acquires the FB-027 lock implicitly from a guessed
production path. Docker/runtime discovery or legacy capture must be invoked by
the owner-controlled caller with the canonical FB-027 lock file.

Admission is rechecked under the retention lock and accounts for retained
evidence, bounded ZIP/archive snapshots, candidate extracted material, legacy
material, publication metadata, inode reserves, overlapping filesystems, and
the existing retention/host/database reserves. Failure leaves protected
evidence and the running application untouched.

The stable operation id is `prepare-<identity-sha256>`. Repeated identical
preparation reuses verified material. A process interruption before extraction,
after publication, during legacy capture, or during retention metadata
publication leaves the operation/material protected and is reported as
recovery-required; an ambiguous or partially published directory is never
adopted or replaced automatically.

## Handoff to FB-028B-3d

`preparation.json` is evidence of durable preparation only. The later activation
consumer must independently revalidate the exact candidate identity, runtime
tree integrity, pinned image/platform, current authorization and replay state,
legacy baseline usability, current VM/Docker/native ABI/resource facts, FB-027
lock ownership, migration policy, health/singleton state, and owner approval.
It must decide activation and authorization consumption separately. A successful
preparation record is not production eligibility or activation readiness.

## Evidence classification

The Python regression suite exercises bounded copy, source mutation, image and
development-artifact rejection, no-overwrite baseline custody, integrity
substitution, and shared-filesystem admission. Existing provenance, hardened
archive, SSH delivery, and retention suites remain required. Windows results
are development checks only; Linux directory-fsync, `renameat2`, Docker mount,
native Prisma, and disposable PostgreSQL evidence must come from the applicable
Linux CI workflow. No live VM, wrapper, production image store, credential,
database, or WSL distribution was accessed or modified for this milestone.

