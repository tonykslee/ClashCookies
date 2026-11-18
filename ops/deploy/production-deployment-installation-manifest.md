# Production deployment integration — installation manifest

Status: proposed offline contract. None of the paths below are claimed to be installed.

| Resource | Proposed path | Owner / mode | Offline source SHA-256 | Offline contract | Facts to verify before installation |
| --- | --- | --- | --- | --- | --- |
| Immutable deployment entrypoint | `/home/tilo/deploy-assets/clashcookies-production/production-deployment-entrypoint.js` | protected administrative owner; `0755` | `ce0e75f57f417b984523e8b1cbab978a676c4570510813e9ba8ec27481c97b35` | Regular, canonical file; SHA-256 pinned in the manifest and `executor.authorization`; operator cannot write the file or any parent | Actual operator UID/GID/groups; installer owner; parent ownership/modes; final SHA-256; Node 20 runtime/shebang availability |
| Reviewed non-migration helper | `/home/tilo/deploy-assets/deploy-prod.sh` | protected administrative owner; `0755` | `16306f59209f705f311fbac844f6e7b194dfba2c6241432c7e0aa843701e9f2c` | Regular, canonical file; SHA-256 pinned; argument-free invocation; legacy wrapper remains untouched | Exact helper artifact/hash; runtime PATH; Docker topology; checkout path; protected runtime env source |
| Immutable module bundle | `/home/tilo/deploy-assets/clashcookies-production/` | protected administrative owner; files `0644`, parent `0755` | See bundle hashes below | Must contain exactly the four hash-pinned sibling modules required by the executor; no external npm dependency is loaded by the executor boundary | Complete file set, hashes, owners/modes, canonical parent chain, Node 20 runtime, and installed-layout module load |
| Outer deployment lock | `/run/lock/clashcookies-prod-deploy.lock` | deployment owner/group; directory `0700`, owner record `0600` | N/A — live directory identity | One atomic exclusive directory; acquired before checkout/runtime inspection; no stale cleanup or retry | Canonical lock parent; ownership/mode; whether another deployment mechanism already owns the lock |
| Inner migration lock | `/run/lock/clashcookies-prod-migration.lock` | migration owner/group; directory `0700`, owner record `0600` | N/A — live directory identity | Distinct from outer lock; acquired once around the migration runner only | Canonical lock parent; ownership/mode; runner/operator boundary |
| Protected migration credential | `/etc/clashcookies/production-db.env` | protected administrative owner; `0600` | N/A — secret not stored in repository | Regular, canonical, no-follow file; migration-capable database role; read only inside runner; never logged | Credential source and privilege boundary; database host/port/name/user/schema/server address/major; proof it is not the `0664` app `.env` or read-only role |
| Protected runtime environment | `/etc/clashcookies/production-runtime.env` | protected administrative owner; `0600` | N/A — secret not stored in repository | Docker env-file containing the least-privileged application DB role and required app runtime settings; passed by path, never as `DATABASE_URL=...` arguments; distinct from migration credential and `.env` | Actual runtime role, grants, contents/format, owner/mode, and proof it is not migration-capable |
| Append-only release record | `/var/lib/clashcookies/release-record.ndjson` | protected owner/group; non-group/world-writable | N/A — target is created/verified at install | Pre-created regular file; bounded sanitized lines; append-only provider/retention control; terminal record while outer lock is held | Exact target; parent ownership/mode; append-only/retention mechanism; recovery access and custody |
| Per-release preflight evidence | `/var/lib/clashcookies/preflight.json` | protected owner/group; `0640` or stricter | N/A — release-bound evidence | Explicit release-bound evidence for migration gates; outside the checkout; no secrets | Exact producer, ownership/mode, retention, gate authority, and release/digest binding |
| Candidate worktree | `/home/tilo/apps/clashcookies-prod-replacement` | deployment owner; created and removed only when identity is proven | N/A — transient worktree | Outside checkout; must be absent before create; no unknown-file overwrite | Checkout topology and filesystem capacity; existing path absence; recovery cleanup authority |
| Promoted build artifact root | `/home/tilo/apps/clashcookies-prod-artifacts/` | deployment owner; root `0750`, per-release artifact restricted | N/A — per-release artifact | Candidate build is copied here before migration/promotion; runtime mounts the exact SHA artifact read-only and starts `start:runtime` without rebuilding; retained for recovery/rollback classification | Parent ownership/mode, capacity, artifact cleanup/retention, and exact release-to-artifact mapping |
| Deployment manifest | `/etc/clashcookies/production-deployment.json` | protected administrative owner; `0640` or stricter | N/A — contains approved hashes, not secrets | No secrets; contains only validated paths, identities, hashes, runtime and database identity contract | Exact config path; owner/group/mode; review of every hash and identity field |

The repository implementation validates these contracts and uses synthetic paths in tests. It does not create, install, or verify any proposed production resource.

## Immutable module bundle hashes

These are the offline source hashes for the four sibling modules required beside the executor. Install them unchanged under the proposed bundle directory and record final owner/group/mode and canonical-path evidence:

| Module | SHA-256 |
| --- | --- |
| `migration-aware-deploy.js` | `be453778eb941e3e41f33fe08644a7bec129b31782564b693c77ea83f6dafdeb` |
| `direct-docker-adapter.js` | `13c95bd792c15283abee3de3bdd5bccb052dd8775185bb0b1836c65cfcb41381` |
| `migration-runner.js` | `6b7478bc45ac42bc76957b28091f87eb4b88b529573927ebb5b76a927e79166e` |
| `deployment-lock.js` | `44022a36f324905223177881b1c4b4bb09591e7e94d58e42931f6e81f10241f3` |

## Installation prerequisites

Before activation, independently verify and record:

1. The deployment operator identity and effective UID/GID/group permissions, including proof it cannot modify the executor, helper, credential, lock parents, manifest, or release record.
2. The actual production checkout, Docker/network/port topology, active runtime name and labels, candidate-worktree location, and startup artifact.
3. That the application startup path cannot apply Prisma migrations implicitly; only the reviewed migration runner may request production migration.
4. The protected credential source, database identity, migration-capable privilege boundary, baseline migration state, backup/restore evidence, disk capacity, health monitoring, and recovery authority.
5. Exact installed artifact hashes, owner/group/mode, canonical parent paths, lock ownership, release-record append-only control, and the activation authorization digest.

## One-time installation procedure

1. Review the offline diff, focused tests, full CI evidence, and this manifest. Approve exact paths, identities, modes, hashes, operator, recovery authority, and handoff conditions.
2. Revalidate the existing VM facts read-only. Do not read the existing application `.env`; provision separate `0600` migration and least-privileged runtime environment sources through the approved secret-delivery process.
3. Install the immutable entrypoint/module bundle, helper, manifest, lock directories, credential sources, release-record target, and promoted-artifact root only at separately approved paths. Leave `/home/tilo/deploy-prod.sh` unchanged.
4. Re-read every installed artifact with no-follow identity checks and compare the approved hashes/metadata. Confirm the new entrypoint fails closed when activation, identity, lock, credential, module bundle, artifact root, or preflight evidence is absent.
5. Run one separately approved non-migration rehearsal. Confirm one runtime launches the verified per-release artifact with the least-privileged runtime environment, health/revision verification succeeds, and candidate cleanup does not remove the launched artifact; validate release-record handling separately on the migration-aware path.
6. After startup-migration separation and migration preflight are independently approved, run one approved migration-bearing release through the production environment gate. Do not retry an ambiguous migration; retain the recovery-required state.
7. Only after successful handoff, rollback rehearsal, and owner confirmation may a separate change make the legacy command an argument-free `exec` handoff. This implementation does not replace or modify it.

No step above is an instruction to perform production work in this repository task. Installation, rehearsal, handoff, rollback, migration, and release approval remain separate authorized actions.
