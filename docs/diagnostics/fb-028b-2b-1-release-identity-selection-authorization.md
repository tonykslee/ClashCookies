# FB-028B-2b-1 — Release Identity, Exact Selection, and Authorization Foundation

Status: identity/selection contract merged; authorization-only verifier boundary implemented on the feature branch; production authority unavailable

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

GitHub protected environments can express approval for a job, but the available upstream evidence does not by itself provide durable offline proof bound to this exact artifact-service ZIP and inner archive. The authorization-only branch now verifies a versioned canonical record with the installed OpenSSL Ed25519 verifier. The signed record binds the exact main-push SHA, producer and signer workflow revisions, run/attempt, artifact-service and inner-archive IDs/digests/sizes, platform/image digest, scope, issuance/expiry, retry key, signing-key ID, and recovery context.

The verifier requires an owner-supplied immutable producer/signer revision allowlist plus an independently expected trusted key ID and Ed25519 SPKI fingerprint. It snapshots the inspected public key into a bounded private file, checks the parsed OpenSSL key type, and verifies against that snapshot; the trust configuration must include an existing checkout-exclusion root. Forward records are exactly 24 hours, and recovery records are separate signed records with non-empty recovery context; a recovery record cannot authorize a forward release. The replay journal is an explicitly supplied directory outside the checkout. It re-verifies the signed envelope before mutation and parses only the private canonical bytes verified by OpenSSL. It binds the canonical record digest, key fingerprint, full identity, operation, scope, recovery context, issuance, and expiry, and uses a verified directory identity, a bounded five-second serialized lock acquisition, private files, atomic no-replace reservation, unique transition files, and fail-closed durability errors. Identical retries re-fsync the existing reservation file and directory before success. Linux requires owner/private directory state and file/directory fsync; Windows development tests use an explicit non-production development mode and do not claim those Linux durability guarantees. Tests use disposable Ed25519 keys and temporary replay directories only.

No production key, trust root, allowlist, replay store, producer, production environment, or production secret is provisioned. The evaluator remains unconditionally disabled for production in this authorization-only slice. Dataclass constructors, serialized envelopes, fixtures, environment variables, and booleans cannot establish authoritative eligibility. The delivery-only SSH boundary is implemented separately for development evidence and synthetic authorization tests; deployment workflows, the live wrapper, and VM state remain unchanged.

## Producer and validation contract

The existing pinned off-host builder, legacy development manifest, hardened validator, official `gh` v2.89.0 verifier, GitHub-native attestation, safe extraction, and disposable PostgreSQL/native-engine probe remain unchanged in their development-evidence role. `production-candidate-runtime-evidence-v1` is reserved as an explicit future class; this workflow does not emit it, and no development artifact is relabeled. The common producer/validator path now exercises exact run-attempt and artifact-service selection in real Linux GitHub Actions evidence while preserving the existing development rejection and attestation-negative tests.

## Evidence classification and remaining gates

- Authentication: official GitHub verifier and certificate claims authenticate the inner archive subject.
- Content acceptance: the hardened validator checks archive structure, manifests, checksums, per-file content, and safe extraction.
- Authorization: independent approval of the complete immutable identity; unavailable here.
- Deployment: existing SSH workflow and live VM consumption; unchanged and out of scope.

Remaining credential-free VM verification includes current image/native ABI, filesystem and inode primitives, disk/memory/swap/cgroup headroom, active health and singleton state, artifact retention/offline custody, restart behavior, migration-bearing release behavior, rollback baseline, and durable authorization replay evidence. Production activation still requires owner decisions on the producer workflow, signer revision policy, authorization root and custody, protected-environment versus signed-record design, expiry/retry windows, recovery authorization, artifact retention, and explicit deployment gates.

## B-2b-2 delivery boundary implemented on this branch

The focused delivery helper is `scripts/trusted_ssh_artifact_delivery.py`. It uses standard OpenSSH with strict host-key checking, a dedicated owner-controlled known-hosts file, an explicit disposable identity, noninteractive authentication, no agent forwarding, fixed receiver arguments, and bounded deadlines/output. The receiver uses an explicit length/digest-framed protocol and private Linux roots outside the mutable checkout. It verifies the original artifact-service ZIP and inner archive from the same descriptor-backed snapshot, extracts only the required archive/checksum/manifest entries, invokes the existing hardened validator, and publishes an immutable identity directory with Linux no-replacement rename and fsync. Interrupted, truncated, substituted, oversized, conflicting, or ambiguous inputs fail closed.

The operational receiver accepts development evidence only. The synthetic authorized-delivery test seam verifies the existing Ed25519 signed record and immutable revision/key bindings, reserves the existing `AuthorizationReplayJournal`, publishes only after reservation, and never consumes authorization. Production eligibility remains unconditionally disabled.

Offline attestation support is explicit in the existing pinned `gh` verifier boundary. It requires the original attestation bundle plus an independently configured `trusted_root.jsonl`, snapshots the root privately outside the checkout, removes GitHub tokens and cached CLI configuration, and marks API correlation separately. The official CLI documents `gh attestation trusted-root` as the acquisition path and `--custom-trusted-root` as the offline input; root custody, refresh, rotation, expiry and revocation remain external operational limitations. The branch does not provision a production root, key, credential, receiver, or producer.
