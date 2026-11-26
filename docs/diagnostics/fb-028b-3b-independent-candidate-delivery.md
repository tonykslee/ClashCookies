# FB-028B-3b independent candidate-delivery diagnostic

This diagnostic describes the owner-local boundary for a production-shaped runtime candidate. It is an evidence and custody procedure only; it does not issue production authority, activate a release, consume authorization, merge a pull request, or deploy.

## Owner-local intake

1. Read the exact development or main-push run ID and attempt number from the supplied handoff. Query `actions/runs/{run_id}/attempts/{run_attempt}` and the paginated `actions/runs/{run_id}/attempts/{run_attempt}/jobs` route. The attempt response is authoritative for `updated_at`; GitHub does not provide a run-level `completed_at` on this route. Job `completed_at` values must be inside the run window, bound to the same run, attempt, and source SHA, and the latest mandatory job completion becomes the retained completion boundary.
2. Retrieve every artifact-service page and select only the exact attempt-qualified artifact name. Verify the service ZIP digest and byte count from the API against the downloaded ZIP, then verify the inner runtime archive digest and byte count. Do not use a latest-by-name lookup.
3. Download the exact attestation upload and its JSON bundle. Run the pinned official GitHub attestation verifier against the exact archive and bundle, then run the repository hardened archive validator against the same bytes. The verification context records the run, job, mandatory-step, artifact, attestation, and archive evidence but remains non-authoritative.

The owner signs only the canonical authorization record prepared from the identity and the SHA-256 of the canonical verification-context bytes. The record is signed as the exact bytes emitted by `--prepare-authorization`; that file has no implicit newline. The envelope is assembled and independently verified before it is handed to the receiver.

Example disposable owner-local signing sequence:

```bash
python scripts/runtime_artifact_provenance.py \
  --prepare-authorization \
  --authorization-identity /owner-custody/candidate-identity.json \
  --authorization-output /owner-custody/authorization-record.json \
  --authorization-id candidate-2026-11-26-001 \
  --authorization-issued-at 2026-11-26T12:00:00Z \
  --authorization-expires-at 2026-11-27T12:00:00Z \
  --authorization-key-id owner-ed25519-2026 \
  --verification-context-sha256 <context-sha256>
openssl pkeyutl -sign -rawin -inkey /owner-custody/owner-private.pem \
  -in /owner-custody/authorization-record.json \
  -out /owner-custody/authorization-record.sig
python scripts/runtime_artifact_provenance.py \
  --assemble-authorization \
  --authorization-record /owner-custody/authorization-record.json \
  --authorization-signature /owner-custody/authorization-record.sig \
  --authorization-output /owner-custody/authorization-envelope.json \
  --authorization-identity /owner-custody/candidate-identity.json \
  --authorization-public-key /owner-custody/owner-public.pem \
  --authorization-repository-root /owner-checkout \
  --authorization-key-id owner-ed25519-2026 \
  --authorization-key-fingerprint <sha256-of-public-key-der> \
  --authorization-allowlist /owner-custody/revision-allowlist.json
```

## Receiver-owned custody

The receiver accepts only a policy path selected by its own `CC_RECEIVER_AUTHORIZATION_POLICY` environment variable. The policy binds the repository, publication destination, candidate class, owner-approved authorization context, external Ed25519 public key, immutable producer/signer revision allowlist, and external replay-journal directory. These paths must not overlap the checkout, receiving workspace, publication root, or policy file. Sender-supplied key paths, fingerprints, allowlists, and journal paths are not accepted.

Candidate frames contain exactly `artifact-service.zip`, `attestation-bundle.json`, `authorization-envelope.json`, and `independent-verification-context.json`. The receiver verifies the ZIP and archive, runs the official verifier offline with its configured trust root, validates the hardened archive contract, verifies the external signature and context digest, reserves the exact authorization in the durable replay journal, and atomically publishes the complete retained evidence. Retries require byte-identical identity and evidence; a missing or conflicting reservation fails closed.

## Historical offline verification

Retention reopens the retained ZIP and attestation bundle and re-runs the official offline verifier against the independently supplied trusted-root snapshot. For candidates it also verifies the signed authorization at its historical issuance time and rebinds it to the retained context. This operation does not reserve, consume, refresh, or mutate replay state. Its diagnostic distinguishes historical signature/lifecycle validity from delivery-time validity and replay status, which are deliberately reported as not evaluated.

The fixture tests use synthetic provenance only where stated. They exercise real Ed25519/OpenSSL signing, receiver publication, immutable evidence matching, durable replay reservation, retry behavior, and historical retention composition. They are not evidence of a completed main-push candidate or production authorization. Genuine GitHub attestation and Linux/OpenSSH evidence remains a separate CI requirement.
