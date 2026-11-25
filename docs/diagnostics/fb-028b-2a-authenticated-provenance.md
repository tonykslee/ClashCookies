# FB-028B-2a — Authenticated Runtime Artifact Provenance

Status: implemented in the feature branch; production delivery and authorization remain out of scope.

## Contract

The legacy `runtime-artifact-manifest.json` remains a version-1, explicitly unauthenticated development manifest. Its `artifactClass` is `development-runtime-evidence`, `nonProductionEvidence` is true, and `deployableRelease` is false. It is content-bound to the archive by the existing embedded/external-manifest comparison and checksum validation, but it is never treated as proof of producer identity.

The separate `clashcookies.runtime-artifact-provenance` version-1 envelope is created only after the official GitHub verifier has authenticated the subject. It binds:

- the exact archive subject digest and size;
- repository name and stable repository ID;
- source ref, full source SHA, and event classification;
- signer workflow and signer revision;
- workflow run ID and attempt;
- artifact class, `linux/amd64`, and the pinned Node image digest.

The archive is first copied into the validator's private descriptor-backed snapshot. `gh attestation verify` runs against that snapshot, then the same snapshot is parsed, content-hashed, checked against the manifest/checksum, and safely extracted. This prevents a pathname replacement between attestation verification and archive validation from selecting different bytes. The external sidecar is accepted only when it equals the embedded manifest and the checksum names and hashes the same archive; no self-reported checksum is used as an authentication substitute.

## Trust model

Cryptographically established claims are the subject digest, certificate identity, repository identity claims, source ref/SHA, signer digest, runner environment, OIDC issuer, and verified timestamps supplied by GitHub/Sigstore and checked by the official CLI. The certificate's signer workflow identity is checked against the exact expected workflow path and the workflow digest is checked against the expected signer revision.

The SLSA predicate is workflow-controlled metadata. Its run ID, attempt, and event are accepted only as correlation values and are checked against authenticated GitHub Actions run metadata (`head_sha`, `event`, `run_attempt`, and workflow path). Run metadata proves the GitHub run facts independently; it does not turn arbitrary predicate text into certificate claims. The implementation rejects missing, malformed, conflicting, ambiguous, unsupported, or unavailable evidence.

The isolated production evaluator is intentionally separate from provenance validity. It also requires an externally supplied approved release SHA, exact `refs/heads/main`, an authorized main release context, explicit production artifact classification, exact run/attempt and digest/size, supported platform/image, and independent release authorization. A development attestation cannot satisfy it. The evaluator is not used by the existing deployment wrapper.

## Evidence and limitations

The non-production workflow now contains separate build, signer, and validation jobs. It publishes the archive and attestation bundle, retrieves them independently, performs real `gh attestation verify`, checks modified-subject and mismatched-source negative cases, binds the authenticated digest to the hardened FB-028B-1 validator, extracts safely, and preserves the Linux/Prisma/native-engine probe. A valid development envelope is checked against the production evaluator and rejected. Exact final-head GitHub CI is required evidence; local Windows tests cannot establish Sigstore, GitHub runner, Docker, or PostgreSQL integration.

Attestation generation can be unavailable for fork or restricted-runner workflows because GitHub permissions are intentionally not expanded. Such a run is a merge blocker and must be reported as unavailable evidence. No production credentials, `pull_request_target`, signing keys, custom certificate verification, or custom transparency-log verification is introduced.

## B-2b design boundary

The subsequent delivery slice must use the existing SSH deployment architecture and verified SSH host identity. It must carry exact run/attempt/artifact selection, transfer into a private bounded receiving workspace, independently verify the digest after transfer, and publish atomically without replacement. It must retain active and previous known-good artifacts durably outside Actions retention, define offline trusted-root material and rotation if selected, and handle the first rollback to the legacy runtime explicitly. Before activation it must recheck current VM runtime image, native ABI, filesystem/inode behavior, disk, memory, swap, cgroup limits, live health, and singleton state, while preserving FB-027 lock, ownership, deadlines, and cleanup. None of those delivery, discovery, installation, promotion, or deployment actions are implemented here.
