# FB-028B-2b-1 — Release Identity, Exact Selection, and Authorization Foundation

Status: implemented repository contract; production authority unavailable

## Scope

This slice establishes the typed release-identity and exact artifact-selection boundary needed before trusted SSH artifact delivery. It does not change `deploy-prod.yml`, `ops/deploy/deploy-prod.sh`, `ops/deploy/container-start.sh`, runtime startup, live wrapper installation, production credentials, production approval, promotion, deployment, or issue #2178 status.

## Release identity ownership

`scripts/runtime_artifact_provenance.py` remains the single owner of the release identity contract. A future production identity must bind:

- `tonykslee/ClashCookies`, repository ID `668452496`, owner ID `18295450`;
- `refs/heads/main`, the exact full main-push event SHA, and `push` classification;
- `.github/workflows/runtime-artifact.yml` and a full immutable signer revision;
- exact workflow run ID and attempt;
- artifact-service artifact ID/name, ZIP SHA-256 and byte count;
- inner runtime archive name, SHA-256 and byte count;
- `linux/amd64`, the approved pinned Node 20 Bookworm image and digest; and
- an independent authorization context.

Malformed, contradictory, unsupported, missing, stale, or ambiguous fields are rejected. Development and pull-request provenance remains `development-runtime-evidence`; it cannot be relabeled into a production release.

## Exact GitHub selection

The verified upstream API behavior is:

1. Fetch `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}`. This exposes the exact attempt and retains the original event SHA/ref on reruns.
2. Fetch `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts?per_page=100` through the bounded CLI path. The complete response is run-scoped and includes artifact ID, name, `size_in_bytes`, `digest`, expiry, and `workflow_run`, but no artifact attempt field.
3. Correlate the exact attempt's source SHA/branch/repository/owner and PR head/base/test-merge identity with the artifact's head SHA/branch/repository. Require the exact artifact ID, exact attempt-qualified name `runtime-artifact-{run_id}-{run_attempt}`, API digest/size, valid retention, coherent attempt chronology, and exactly one match.
4. Retrieve that exact artifact ID through the bounded CLI, copy it into a private descriptor-backed snapshot, and hash/parse the same snapshot. Require exactly one expected inner `tar.gz` whose digest and byte count match the release identity.

The service ZIP digest is not the inner archive digest. Latest-by-name lookup, a moving branch tip, a duplicate/ambiguous match, a different run or attempt, an expired/missing artifact, a stale API page, or a partial rerun that cannot bind both identities is rejected. No fallback artifact is selected.

The `--selection-request` command exercised by the non-production workflow emits `authoritative: false` and distinguishes `byteVerified: false` metadata-only selection from `byteVerified: true` selection after consuming the exact ZIP bytes. It is a selection diagnostic, not authorization. Snapshot or parser failures remove the temporary downloaded ZIP and never extract arbitrary ZIP paths.

## Authorization trust boundary

The implementation defines the future authorization binding and lifecycle fields: forward versus recovery scope, exact identity binding, issuance/expiry, stable retry key, recovery context, and verification evidence. A retry may reuse only the same still-valid authorization and exact identity. An expired forward authorization cannot authorize rollback; rollback needs a separately approved recovery context. Durable replay state is required to reject a consumed authorization across retries.

GitHub protected environments can express approval for a job, but the available upstream evidence does not by itself provide durable offline proof bound to this exact artifact-service ZIP and inner archive. The separately approved signed authorization-record alternative is documented but not implemented. No trusted key root, signed-record verifier, replay store, production producer, production environment, or production secret is provisioned. Dataclass constructors, serialized envelopes, fixtures, environment variables, and booleans cannot establish authoritative eligibility. The evaluator remains fail-closed with production authority unavailable.

## Producer and validation contract

The existing pinned off-host builder, legacy development manifest, hardened validator, official `gh` v2.89.0 verifier, GitHub-native attestation, safe extraction, and disposable PostgreSQL/native-engine probe remain unchanged in their development-evidence role. `production-candidate-runtime-evidence-v1` is reserved as an explicit future class; this workflow does not emit it, and no development artifact is relabeled. The common producer/validator path now exercises exact run-attempt and artifact-service selection in real Linux GitHub Actions evidence while preserving the existing development rejection and attestation-negative tests.

## Evidence classification and remaining gates

- Authentication: official GitHub verifier and certificate claims authenticate the inner archive subject.
- Content acceptance: the hardened validator checks archive structure, manifests, checksums, per-file content, and safe extraction.
- Authorization: independent approval of the complete immutable identity; unavailable here.
- Deployment: existing SSH workflow and live VM consumption; unchanged and out of scope.

Remaining credential-free VM verification includes current image/native ABI, filesystem and inode primitives, disk/memory/swap/cgroup headroom, active health and singleton state, artifact retention/offline custody, restart behavior, migration-bearing release behavior, rollback baseline, and durable authorization replay evidence. Production activation still requires owner decisions on the producer workflow, signer revision policy, authorization root and custody, protected-environment versus signed-record design, expiry/retry windows, recovery authorization, artifact retention, and explicit deployment gates.
