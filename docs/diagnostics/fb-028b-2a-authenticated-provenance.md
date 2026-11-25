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

The SLSA predicate is workflow-controlled metadata. Its run ID, attempt, and event are accepted only as correlation values and are checked against authenticated GitHub Actions run metadata (`head_sha`, `event`, `run_attempt`, and workflow path). For pull requests, the API `head_sha` is the PR head commit, while the attested source dependency and `GITHUB_SHA` are the exact checked-out test-merge commit; the PR base SHA and ref are checked separately. Push validation uses the pushed commit and branch semantics independently. Run metadata proves the GitHub run facts independently; it does not turn arbitrary predicate text into certificate claims. The implementation rejects missing, malformed, conflicting, ambiguous, unsupported, or unavailable evidence.

The isolated production evaluator is intentionally separate from provenance validity. A serialized envelope is never accepted as authority, and editing a development envelope cannot relabel it into production evidence. The current slice leaves eligibility unavailable until an actual authorized producer supplies independently verified release identity, run correlation, and release authorization; its synthetic policy fixture is explicitly non-authoritative and exists only for policy-shape regression coverage. The evaluator is not used by the existing deployment wrapper.

## Evidence and limitations

The non-production workflow now contains separate build, signer, and validation jobs with only job-scoped read permissions needed for retrieval and run correlation. It downloads the official `gh` v2.89.0 Linux distribution, verifies SHA-256 `d0422caade520530e76c1c558da47daebaa8e1203d6b7ff10ad7d6faba3490d8`, and uses that executable consistently. The verifier schema is checked against the real pinned output from signing run `45679130601`, including the exact verification media type, in-toto statement type, Actions workflow build type, certificate issuer/owner/visibility fields, repository owner ID, predicate paths, merge SHA, and run invocation URI. It publishes the archive and attestation bundle, requires exactly one of each, retrieves them independently, records the supported verifier version, performs real `gh attestation verify`, checks modified-subject and mismatched-source negative cases, binds the authenticated digest to the hardened FB-028B-1 validator, extracts safely, and preserves the Linux/Prisma/native-engine probe. Operational errors, malformed output, missing correlation, and ambiguous selection fail rather than counting as expected rejection. The modified-subject test uses positive/negative/positive verification with the same bundle and trust context because upstream gh v2.89.0 reports a generic issuer-verification error for underlying verification failures; the independently confirmed digest difference and recovered positive verification establish the controlled input change, and this CLI limitation is recorded. The synthetic validator CLI now has a Linux shebang and a Windows launcher; its extraction-failure regression verifies the existing destination is unchanged and private snapshot/staging paths are cleaned. A valid development envelope is checked against the production evaluator and rejected. Exact final-head GitHub CI is required evidence; local Windows tests cannot establish Sigstore, GitHub runner, Docker, or PostgreSQL integration.

Attestation generation can be unavailable for fork or restricted-runner workflows because GitHub permissions are intentionally not expanded. Such a run is a merge blocker and must be reported as unavailable evidence. No production credentials, `pull_request_target`, signing keys, custom certificate verification, or custom transparency-log verification is introduced.

## B-2b design boundary

The subsequent delivery slice must use the existing SSH deployment architecture and verified SSH host identity. It must carry exact run/attempt/artifact selection, transfer into a private bounded receiving workspace, independently verify the digest after transfer, and publish atomically without replacement. It must retain active and previous known-good artifacts durably outside Actions retention, define offline trusted-root material and rotation if selected, and handle the first rollback to the legacy runtime explicitly. Before activation it must recheck current VM runtime image, native ABI, filesystem/inode behavior, disk, memory, swap, cgroup limits, live health, and singleton state, while preserving FB-027 lock, ownership, deadlines, and cleanup. None of those delivery, discovery, installation, promotion, or deployment actions are implemented here.
