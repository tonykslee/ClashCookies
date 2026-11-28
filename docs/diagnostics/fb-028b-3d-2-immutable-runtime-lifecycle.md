# FB-028B-3d-2 — Immutable runtime lifecycle

Status: implemented on the feature branch; production remains **NO-GO**. The
runtime boundary is not wired into `deploy-prod.sh`, `deploy-prod.yml`, or a
production release path.

## Ownership and execution contract

`scripts/immutable_runtime_lifecycle.py` consumes `ActivationTransaction` and
`RetentionStore`; it does not create a pointer registry, issue authorization,
select a release, or own retention. The lifecycle contract is derived from the
exact retained candidate, one completed preparation record, and its metadata
digest. Immediately before each Docker side effect it rechecks archive-bound
runtime integrity, effective-UID ownership, the exact pinned
`linux/amd64` image, the local image ID, and the external configuration digest.

Docker is invoked through bounded argument vectors with `--pull=never`,
`--read-only`, `--restart=no`, one read-only `/app` bind of the prepared
runtime, and a bounded `/tmp` tmpfs. The mutable checkout, Docker socket,
authorization/trust roots, replay journals, and prepared/retained metadata are
never mounted. The command is the compiled entry point
`node /app/dist/ClashCookies.js`; it does not run npm, dependency installation,
TypeScript compilation, Prisma generation, migrations, checkout sync, or
artifact regeneration. Runtime secrets remain in an external env file.

The trusted-host assumption is explicit: a privileged host or same-UID actor
able to replace trusted ancestors, Docker state, or the private custody roots
is outside this boundary. Ownership and inode checks are defense in depth, not
a claim against that actor.

## Durable lifecycle and evidence

The coordinator holds the existing deployment-lock → retention-lock order
across bounded Docker inspection and lifecycle side effects where needed. It
persists intent through the existing activation phases before stop/start,
revalidates the operation and replay proof, and reconciles Docker state by
exact container ID, image ID, labels, process start time, command, mounts,
configuration digest, and restart policy. Names, labels, ports, and process
patterns are discovery hints only. Multiple or unknown active containers,
restart-enabled incumbents, stop ambiguity, Docker timeout, name collision,
partial creation, and identity changes fail closed without candidate startup.

Operational observations use a strict version-2 observation contract generated
only by the lifecycle inspection path. They bind operation, phase subject,
release, candidate/preparation digests, runtime tree digest, container/image
IDs, process incarnation, effective mounts, configuration digest, and fresh
bounded HTTP health evidence. The existing version-1 isolated-harness evidence
remains valid for historical tests and is not relabeled as operational proof.
Health responses expose the runtime identity only when the lifecycle binding
environment is present; the existing Discord/database readiness semantics are
unchanged. A generic HTTP 200, stale response, wrong container, or wrong
incarnation cannot authorize pointer publication.

Automatic Docker restart is disabled. Explicit restart of a committed runtime
must rediscover the exact committed operation, reverify the same preparation
digest/runtime tree and prior local image ID, stop only the exact container,
start with the same immutable contract, and obtain fresh identity-bound health.
No new forward authorization is consumed for that exact committed-runtime
restart. If those checks cannot be established, the behavior remains disabled
and the operation is recovery-required rather than rebuilding or adopting an
unknown container.

## Rollback and limits

Rollback reuses the existing recovery authorization and replay journal. Failed
candidate compensation targets the exact incumbent. Post-activation recovery
targets the explicitly bound previous-known-good release. Authenticated targets
independently reverify their own retained identity, preparation record, runtime
integrity, and local image. The first legacy target uses only preserved
unauthenticated custody and its protected exact image/runtime evidence; it is
never relabeled as an authenticated release. Rollback never runs migrations,
uses a checkout, regenerates material, or mints authority. Displaced candidates
are stopped and contained before target startup, and failed/ambiguous rollback
remains recovery-required with known-good pointers unchanged.

Resource and timeout bounds are in `LifecycleConfig`; Docker output, health
payloads, and lifecycle evidence are size bounded. The new mandatory Linux
integration uses a disposable runtime and the pinned local image with a real
container and HTTP observation. It uses no production credentials, Discord,
production database, or live VM. Fixture health is explicitly marked
`fixture`; it is not genuine Discord readiness or main-push attestation.

Remaining release blockers are production wrapper integration, live VM/host
readiness and native compatibility, real production trust/authorization
custody, migration policy, bounded activation-history retirement, and an
owner-approved controlled release. No production operational integration is
enabled by this slice.
