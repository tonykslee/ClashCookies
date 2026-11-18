# Production deployment integration — installation manifest

Status: proposed offline contract. None of the paths below are claimed to be installed.

| Resource | Proposed path | Owner / mode | Offline source SHA-256 | Offline contract | Facts to verify before installation |
| --- | --- | --- | --- | --- | --- |
| Immutable deployment entrypoint | `/home/tilo/deploy-assets/clashcookies-production-entrypoint` | protected administrative owner; `0755` | `ddce1bb8dd2c523c31f44df71ca552e899c8e3b0421fa01343f9916f9061fdb1` | Regular, canonical file; SHA-256 pinned in the manifest and `executor.authorization`; operator cannot write the file or any parent | Actual operator UID/GID/groups; installer owner; parent ownership/modes; final SHA-256; Node runtime/shebang availability |
| Reviewed non-migration helper | `/home/tilo/deploy-assets/deploy-prod.sh` | protected administrative owner; `0755` | `b76b350f2a477d91da1d56453372932139cc49b411d2eca2790c95e7f0972c83` | Regular, canonical file; SHA-256 pinned; argument-free invocation; legacy wrapper remains untouched | Exact helper artifact/hash; runtime PATH; Docker topology; checkout path; existing `.env` use for application startup |
| Outer deployment lock | `/run/lock/clashcookies-prod-deploy.lock` | deployment owner/group; directory `0700`, owner record `0600` | N/A — live directory identity | One atomic exclusive directory; acquired before checkout/runtime inspection; no stale cleanup or retry | Canonical lock parent; ownership/mode; whether another deployment mechanism already owns the lock |
| Inner migration lock | `/run/lock/clashcookies-prod-migration.lock` | migration owner/group; directory `0700`, owner record `0600` | N/A — live directory identity | Distinct from outer lock; acquired once around the migration runner only | Canonical lock parent; ownership/mode; runner/operator boundary |
| Protected migration credential | `/etc/clashcookies/production-db.env` | protected administrative owner; `0600` | N/A — secret not stored in repository | Regular, canonical, no-follow file; migration-capable database role; read only inside runner; never logged | Credential source and privilege boundary; database host/port/name/user/schema/server address/major; proof it is not the `0664` app `.env` or read-only role |
| Append-only release record | `/var/lib/clashcookies/release-record.ndjson` | protected owner/group; non-group/world-writable | N/A — target is created/verified at install | Pre-created regular file; bounded sanitized lines; append-only provider/retention control; terminal record while outer lock is held | Exact target; parent ownership/mode; append-only/retention mechanism; recovery access and custody |
| Per-release preflight evidence | `/var/lib/clashcookies/preflight.json` | protected owner/group; `0640` or stricter | N/A — release-bound evidence | Explicit release-bound evidence for migration gates; outside the checkout; no secrets | Exact producer, ownership/mode, retention, gate authority, and release/digest binding |
| Candidate worktree | `/home/tilo/apps/clashcookies-prod-replacement` | deployment owner; created and removed only when identity is proven | N/A — transient worktree | Outside checkout; must be absent before create; no unknown-file overwrite | Checkout topology and filesystem capacity; existing path absence; recovery cleanup authority |
| Deployment manifest | `/etc/clashcookies/production-deployment.json` | protected administrative owner; `0640` or stricter | N/A — contains approved hashes, not secrets | No secrets; contains only validated paths, identities, hashes, runtime and database identity contract | Exact config path; owner/group/mode; review of every hash and identity field |

The repository implementation validates these contracts and uses synthetic paths in tests. It does not create, install, or verify any proposed production resource.

## Installation prerequisites

Before activation, independently verify and record:

1. The deployment operator identity and effective UID/GID/group permissions, including proof it cannot modify the executor, helper, credential, lock parents, manifest, or release record.
2. The actual production checkout, Docker/network/port topology, active runtime name and labels, candidate-worktree location, and startup artifact.
3. That the application startup path cannot apply Prisma migrations implicitly; only the reviewed migration runner may request production migration.
4. The protected credential source, database identity, migration-capable privilege boundary, baseline migration state, backup/restore evidence, disk capacity, health monitoring, and recovery authority.
5. Exact installed artifact hashes, owner/group/mode, canonical parent paths, lock ownership, release-record append-only control, and the activation authorization digest.

## One-time installation procedure

1. Review the offline diff, focused tests, full CI evidence, and this manifest. Approve exact paths, identities, modes, hashes, operator, recovery authority, and handoff conditions.
2. Revalidate the existing VM facts read-only. Do not read the existing application `.env`; provision a separate `0600` migration credential through the approved secret-delivery process.
3. Install the immutable entrypoint, helper, manifest, lock directories, credential source, and release-record target only at separately approved paths. Leave `/home/tilo/deploy-prod.sh` unchanged.
4. Re-read every installed artifact with no-follow identity checks and compare the approved hashes/metadata. Confirm the new entrypoint fails closed when activation, identity, lock, credential, or preflight evidence is absent.
5. Run one separately approved non-migration rehearsal. Confirm one runtime, health/revision verification, and candidate cleanup without invoking the legacy wrapper; validate release-record handling separately on the migration-aware path.
6. After startup-migration separation and migration preflight are independently approved, run one approved migration-bearing release through the production environment gate. Do not retry an ambiguous migration; retain the recovery-required state.
7. Only after successful handoff, rollback rehearsal, and owner confirmation may a separate change make the legacy command an argument-free `exec` handoff. This implementation does not replace or modify it.

No step above is an instruction to perform production work in this repository task. Installation, rehearsal, handoff, rollback, migration, and release approval remain separate authorized actions.
