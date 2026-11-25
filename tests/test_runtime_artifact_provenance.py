"""Deterministic contract tests for authenticated runtime-artifact provenance."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import struct
import sys
import unittest
from datetime import datetime, timezone
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from zipfile import ZipFile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "runtime_artifact_provenance.py"
SPEC = importlib.util.spec_from_file_location("runtime_artifact_provenance", SCRIPT)
assert SPEC and SPEC.loader
provenance = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = provenance
SPEC.loader.exec_module(provenance)


ARCHIVE_SHA = "a" * 64
SOURCE_SHA = "b" * 40
PR_HEAD_SHA = "d" * 40
PR_BASE_SHA = "e" * 40
SIGNER_SHA = "c" * 40
REPOSITORY = "tonykslee/ClashCookies"
REPOSITORY_ID = "123456789"
REPOSITORY_OWNER_ID = "987654321"
SIGNER_WORKFLOW = ".github/workflows/runtime-artifact.yml"
WORKFLOW_NAME = "Runtime Artifact Round Trip"
PR_SOURCE_REF = "refs/pull/2188/merge"
PUSH_SOURCE_REF = "refs/heads/dev"
RUN_ID = 45506759751
RUN_ATTEMPT = 2
MAIN_SOURCE_SHA = "1" * 40
ARTIFACT_ID = 1234567890
ARTIFACT_ZIP_SHA = "9" * 64
ARTIFACT_ZIP_BYTES = 2048
ARCHIVE_NAME = f"clashcookies-runtime-{MAIN_SOURCE_SHA}.tar.gz"


def expected(event: str = "pull_request") -> dict[str, object]:
    """Return an explicit PR or dev-push verification context."""
    return {
        "repository": REPOSITORY,
        "repository_id": REPOSITORY_ID,
        "repository_owner_id": REPOSITORY_OWNER_ID,
        "repository_visibility": "public",
        "signer_workflow": SIGNER_WORKFLOW,
        "signer_revision": SIGNER_SHA,
        "source_ref": PR_SOURCE_REF if event == "pull_request" else PUSH_SOURCE_REF,
        "source_sha": SOURCE_SHA,
        "event": event,
        "workflow_name": WORKFLOW_NAME,
        "run_id": RUN_ID,
        "run_attempt": RUN_ATTEMPT,
        "pr_number": 2188 if event == "pull_request" else 0,
        "pr_head_sha": PR_HEAD_SHA,
        "pr_head_ref": "feature/trusted-artifact-provenance",
        "pr_base_sha": PR_BASE_SHA,
        "pr_base_ref": "dev",
        "artifact_class": provenance.DEVELOPMENT_ARTIFACT_CLASS,
        "platform": "linux/amd64",
        "image": "node:20-bookworm@sha256:" + "f" * 64,
        "image_digest": "sha256:" + "f" * 64,
    }


def verified_result(context: dict[str, object] | None = None) -> dict[str, object]:
    """Return the exact gh attestation verification-result shape observed in CI."""
    context = context or expected()
    source_ref = context["source_ref"]
    event = context["event"]
    run_uri = f"https://github.com/{REPOSITORY}/actions/runs/{RUN_ID}/attempts/{RUN_ATTEMPT}"
    workflow_uri = f"https://github.com/{REPOSITORY}/{SIGNER_WORKFLOW}"
    repository_uri = f"https://github.com/{REPOSITORY}"
    dependency_uri = f"git+{repository_uri}@{source_ref}"
    return {
        "_verifierVersion": provenance.SUPPORTED_GH_VERSION,
        "verificationResult": {
            "mediaType": "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
            "signature": {
                "certificate": {
                    "certificateIssuer": "CN=sigstore-intermediate,O=sigstore.dev",
                    "sourceRepositoryIdentifier": REPOSITORY_ID,
                    "sourceRepositoryOwnerIdentifier": REPOSITORY_OWNER_ID,
                    "sourceRepositoryURI": repository_uri,
                    "sourceRepositoryOwnerURI": "https://github.com/tonykslee",
                    "sourceRepositoryRef": source_ref,
                    "sourceRepositoryDigest": SOURCE_SHA,
                    "githubWorkflowTrigger": event,
                    "githubWorkflowSHA": SIGNER_SHA,
                    "githubWorkflowName": WORKFLOW_NAME,
                    "githubWorkflowRepository": REPOSITORY,
                    "githubWorkflowRef": source_ref,
                    "buildTrigger": event,
                    "buildSignerURI": f"{workflow_uri}@{source_ref}",
                    "buildSignerDigest": SIGNER_SHA,
                    "buildConfigURI": f"{workflow_uri}@{source_ref}",
                    "buildConfigDigest": SIGNER_SHA,
                    "runInvocationURI": run_uri,
                    "runnerEnvironment": "github-hosted",
                    "issuer": provenance.GITHUB_OIDC_ISSUER,
                    "subjectAlternativeName": f"{workflow_uri}@{source_ref}",
                    "sourceRepositoryVisibilityAtSigning": "public",
                }
            },
            "verifiedTimestamps": [{"type": "Tlog"}],
            "statement": {
                "_type": "https://in-toto.io/Statement/v1",
                "predicateType": provenance.SLSA_PROVENANCE_V1,
                "subject": [{"name": f"clashcookies-runtime-{SOURCE_SHA}.tar.gz", "digest": {"sha256": ARCHIVE_SHA}}],
                "predicate": {
                    "buildDefinition": {
                        "buildType": provenance.ACTIONS_WORKFLOW_BUILD_TYPE,
                        "externalParameters": {"workflow": {"path": SIGNER_WORKFLOW, "ref": source_ref, "repository": repository_uri}},
                        "internalParameters": {"github": {"event_name": event, "repository_id": REPOSITORY_ID, "repository_owner_id": REPOSITORY_OWNER_ID, "runner_environment": "github-hosted"}},
                        "resolvedDependencies": [{"uri": dependency_uri, "digest": {"gitCommit": SOURCE_SHA}}],
                    },
                    "runDetails": {"builder": {"id": f"{workflow_uri}@{source_ref}"}, "metadata": {"invocationId": run_uri}},
                },
            },
        },
    }


def run_metadata(context: dict[str, object] | None = None) -> dict[str, object]:
    """Return independent Actions API metadata for a PR or dev push."""
    context = context or expected()
    metadata: dict[str, object] = {
        "id": RUN_ID,
        "head_sha": PR_HEAD_SHA if context["event"] == "pull_request" else SOURCE_SHA,
        "event": context["event"],
        "run_attempt": RUN_ATTEMPT,
        "path": SIGNER_WORKFLOW,
        "head_branch": context["pr_head_ref"] if context["event"] == "pull_request" else "dev",
        "repository": {"full_name": REPOSITORY, "id": REPOSITORY_ID, "owner": {"id": REPOSITORY_OWNER_ID}},
        "head_repository": {"full_name": REPOSITORY, "id": REPOSITORY_ID, "owner": {"id": REPOSITORY_OWNER_ID}},
    }
    if context["event"] == "pull_request":
        metadata["pull_requests"] = [{
            "number": 2188,
            "head": {"sha": PR_HEAD_SHA, "ref": context["pr_head_ref"], "repo": {"id": REPOSITORY_ID}},
            "base": {"sha": PR_BASE_SHA, "ref": "dev", "repo": {"id": REPOSITORY_ID}},
        }]
    return metadata


def validate(context: dict[str, object] | None = None):
    """Validate a synthetic official-verifier result with independent run metadata."""
    context = context or expected()
    return provenance.validate_verified_result(
        verified_result(context),
        archive_name=f"clashcookies-runtime-{SOURCE_SHA}.tar.gz",
        archive_digest=ARCHIVE_SHA,
        archive_bytes=101,
        expected=context,
        run_metadata=run_metadata(context),
    )


def trusted_identity() -> object:
    """Return a complete future main-push identity for selection/policy tests."""
    return provenance.TrustedReleaseIdentity(
        repository=provenance.RELEASE_REPOSITORY,
        repository_id=provenance.RELEASE_REPOSITORY_ID,
        repository_owner_id=provenance.RELEASE_REPOSITORY_OWNER_ID,
        source_ref=provenance.RELEASE_SOURCE_REF,
        source_sha=MAIN_SOURCE_SHA,
        event=provenance.RELEASE_EVENT,
        signer_workflow=provenance.RELEASE_SIGNER_WORKFLOW,
        signer_revision=SIGNER_SHA,
        run_id=RUN_ID,
        run_attempt=RUN_ATTEMPT,
        artifact_id=ARTIFACT_ID,
        artifact_name=provenance.expected_artifact_name(RUN_ID, RUN_ATTEMPT),
        artifact_class=provenance.PRODUCTION_CANDIDATE_ARTIFACT_CLASS,
        artifact_service_zip_sha256=ARTIFACT_ZIP_SHA,
        artifact_service_zip_bytes=ARTIFACT_ZIP_BYTES,
        archive_name=ARCHIVE_NAME,
        archive_sha256=ARCHIVE_SHA,
        archive_bytes=101,
        platform=provenance.RELEASE_PLATFORM,
        image=provenance.RELEASE_IMAGE,
        image_digest=provenance.RELEASE_IMAGE.split("@", 1)[1],
        authorization_context="owner-approved-main-release",
    )


def selection_request() -> object:
    """Return a complete non-authoritative PR selection request."""
    return provenance.ArtifactSelectionRequest(
        repository=provenance.RELEASE_REPOSITORY,
        repository_id=provenance.RELEASE_REPOSITORY_ID,
        repository_owner_id=provenance.RELEASE_REPOSITORY_OWNER_ID,
        source_ref="refs/pull/2190/merge",
        source_sha=MAIN_SOURCE_SHA,
        event="pull_request",
        signer_workflow=provenance.RELEASE_SIGNER_WORKFLOW,
        signer_revision=SIGNER_SHA,
        run_id=RUN_ID,
        run_attempt=RUN_ATTEMPT,
        artifact_name=provenance.expected_artifact_name(RUN_ID, RUN_ATTEMPT),
        artifact_class=provenance.DEVELOPMENT_ARTIFACT_CLASS,
        archive_name=ARCHIVE_NAME,
        platform=provenance.RELEASE_PLATFORM,
        image=provenance.RELEASE_IMAGE,
        image_digest=provenance.RELEASE_IMAGE.split("@", 1)[1],
        authorization_context="ci-selection-only",
        run_head_repository=provenance.RELEASE_REPOSITORY,
        run_head_repository_id=provenance.RELEASE_REPOSITORY_ID,
        run_head_repository_owner_id=provenance.RELEASE_REPOSITORY_OWNER_ID,
        run_head_ref="refs/heads/feature/trusted-artifact-provenance",
        run_head_sha=PR_HEAD_SHA,
        pull_request_number=2190,
        pull_request_head_sha=PR_HEAD_SHA,
        pull_request_head_ref="refs/heads/feature/trusted-artifact-provenance",
        pull_request_base_sha="e" * 40,
        pull_request_base_ref="refs/heads/dev",
    )


def selection_run_metadata(request: object | None = None) -> dict[str, object]:
    """Return an exact-attempt API response shape for selection tests."""
    request = request or selection_request()
    return {
        "id": request.run_id,
        "run_attempt": request.run_attempt,
        "event": request.event,
        "path": request.signer_workflow,
        "created_at": "2026-11-25T19:45:14Z",
        "run_started_at": "2026-11-25T19:45:14Z",
        "updated_at": "2026-11-25T19:48:13Z",
        "head_sha": request.run_head_sha,
        "head_branch": request.run_head_ref.removeprefix("refs/heads/"),
        "repository": {"full_name": request.repository, "id": request.repository_id, "owner": {"id": request.repository_owner_id}},
        "head_repository": {"full_name": request.run_head_repository, "id": request.run_head_repository_id, "owner": {"id": request.run_head_repository_owner_id}},
        "pull_requests": [] if request.event == "push" else [{"number": request.pull_request_number, "head": {"sha": request.pull_request_head_sha, "ref": request.pull_request_head_ref.removeprefix("refs/heads/"), "repo": {"id": request.run_head_repository_id}}, "base": {"sha": request.pull_request_base_sha, "ref": request.pull_request_base_ref.removeprefix("refs/heads/"), "repo": {"id": request.repository_id}}}],
    }


def selection_artifact_metadata(request: object | None = None) -> dict[str, object]:
    """Return one exact artifact API entry correlated to the attempt."""
    request = request or selection_request()
    return {
        "id": ARTIFACT_ID,
        "name": request.artifact_name,
        "size_in_bytes": ARTIFACT_ZIP_BYTES,
        "digest": "sha256:" + ARTIFACT_ZIP_SHA,
        "expired": False,
        "created_at": "2026-11-25T19:47:00Z",
        "expires_at": "2026-11-28T19:46:58Z",
        "workflow_run": {"id": request.run_id, "repository_id": request.repository_id, "head_repository_id": request.run_head_repository_id, "head_branch": request.run_head_ref.removeprefix("refs/heads/"), "head_sha": request.run_head_sha},
    }


def main_selection_request() -> object:
    """Return the canonical main-push request used for independent identity verification."""
    return replace(
        selection_request(),
        source_ref=provenance.RELEASE_SOURCE_REF,
        event="push",
        artifact_name=provenance.expected_artifact_name(RUN_ID, RUN_ATTEMPT),
        archive_name=f"clashcookies-runtime-{MAIN_SOURCE_SHA}.tar.gz",
        run_head_ref=provenance.RELEASE_SOURCE_REF,
        run_head_sha=MAIN_SOURCE_SHA,
        pull_request_number=None,
        pull_request_head_sha=None,
        pull_request_head_ref=None,
        pull_request_base_sha=None,
        pull_request_base_ref=None,
    )


class RuntimeArtifactProvenanceTests(unittest.TestCase):
    """Exercise PR/push semantics, fail-closed verification, and policy boundaries."""

    def test_authenticated_pr_merge_artifact_separates_head_base_and_test_merge(self) -> None:
        evidence = validate()
        diagnostic = evidence.diagnostic_json()
        self.assertTrue(diagnostic["authenticated"])
        self.assertEqual(diagnostic["source"]["testMergeSha"], SOURCE_SHA)
        self.assertEqual(diagnostic["source"]["pullRequest"]["headSha"], PR_HEAD_SHA)
        self.assertEqual(diagnostic["source"]["pullRequest"]["baseSha"], PR_BASE_SHA)

    def test_authenticated_dev_push_context_is_valid(self) -> None:
        context = expected("push")
        evidence = validate(context)
        self.assertEqual(evidence.source_ref, PUSH_SOURCE_REF)
        self.assertIsNone(evidence.pull_request)

    def test_wrong_pr_head_base_or_run_association_is_rejected(self) -> None:
        for field, value in (("head_sha", SOURCE_SHA), ("run_attempt", 99)):
            metadata = run_metadata()
            metadata[field] = value
            with self.subTest(field=field), self.assertRaises(provenance.ProvenanceError):
                provenance.validate_verified_result(verified_result(), archive_name=f"clashcookies-runtime-{SOURCE_SHA}.tar.gz", archive_digest=ARCHIVE_SHA, archive_bytes=101, expected=expected(), run_metadata=metadata)
        metadata = run_metadata()
        metadata["pull_requests"][0]["base"]["sha"] = SOURCE_SHA
        with self.assertRaises(provenance.ProvenanceError):
            provenance.validate_verified_result(verified_result(), archive_name=f"clashcookies-runtime-{SOURCE_SHA}.tar.gz", archive_digest=ARCHIVE_SHA, archive_bytes=101, expected=expected(), run_metadata=metadata)

    def test_missing_independent_run_correlation_is_rejected(self) -> None:
        with self.assertRaises(provenance.ProvenanceError):
            provenance.validate_verified_result(verified_result(), archive_name=f"clashcookies-runtime-{SOURCE_SHA}.tar.gz", archive_digest=ARCHIVE_SHA, archive_bytes=101, expected=expected(), run_metadata=None)

    def test_relabelled_serialized_development_evidence_is_not_authoritative(self) -> None:
        evidence = validate()
        relabelled = evidence.diagnostic_json()
        relabelled["authenticated"] = True
        relabelled["subject"]["artifactClass"] = provenance.PRODUCTION_ARTIFACT_CLASS
        identity = trusted_identity()
        result = provenance.evaluate_production_eligibility(relabelled, identity, None)
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "unverifiable-provenance")

    def test_missing_independent_authorization_is_rejected(self) -> None:
        evidence = replace(validate(), artifact_class=provenance.PRODUCTION_ARTIFACT_CLASS)
        identity = trusted_identity()
        result = provenance.evaluate_production_eligibility(evidence, identity, None)
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "missing-independent-authorization")

    def test_production_remains_unavailable_even_with_mutable_positive_fields(self) -> None:
        identity = trusted_identity()
        evidence = replace(
            validate(),
            artifact_class=identity.artifact_class,
            archive_name=identity.archive_name,
            archive_sha256=identity.archive_sha256,
            archive_bytes=identity.archive_bytes,
            repository=identity.repository,
            repository_id=str(identity.repository_id),
            source_ref=identity.source_ref,
            source_sha=identity.source_sha,
            event=identity.event,
            signer_workflow=identity.signer_workflow,
            signer_revision=identity.signer_revision,
            run_id=identity.run_id,
            run_attempt=identity.run_attempt,
            platform=identity.platform,
            image=identity.image,
            image_digest=identity.image_digest,
            receipt=replace(validate().receipt, subject_digest=identity.archive_sha256, run_invocation_uri=f"https://github.com/{identity.repository}/actions/runs/{identity.run_id}/attempts/{identity.run_attempt}"),
        )
        authorization = provenance.IndependentReleaseAuthorization(
            authorization_id="auth-1",
            context="owner-approved-main-release",
            scope="forward-release",
            repository=identity.repository,
            repository_id=identity.repository_id,
            repository_owner_id=identity.repository_owner_id,
            source_ref=identity.source_ref,
            source_sha=identity.source_sha,
            event=identity.event,
            signer_workflow=identity.signer_workflow,
            signer_revision=identity.signer_revision,
            run_id=identity.run_id,
            run_attempt=identity.run_attempt,
            artifact_id=identity.artifact_id,
            artifact_name=identity.artifact_name,
            artifact_class=identity.artifact_class,
            artifact_service_zip_sha256=identity.artifact_service_zip_sha256,
            artifact_service_zip_bytes=identity.artifact_service_zip_bytes,
            archive_name=identity.archive_name,
            archive_sha256=identity.archive_sha256,
            archive_bytes=identity.archive_bytes,
            platform=identity.platform,
            image=identity.image,
            image_digest=identity.image_digest,
            issued_at="2026-11-25T00:00:00Z",
            expires_at="2026-11-26T00:00:00Z",
            retry_key="auth-1",
            recovery_context=None,
            verification=provenance.AuthorizationVerificationReceipt("test", "7" * 64, "2026-11-25T00:00:00Z", "test-key"),
        )
        result = provenance.evaluate_production_eligibility(evidence, identity, authorization, now=datetime(2026, 11, 25, 12, tzinfo=timezone.utc))
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "production-producer-unavailable")

    def test_authenticated_provenance_identity_conflict_is_rejected_before_production(self) -> None:
        identity = trusted_identity()
        with self.assertRaises(provenance.ProvenanceError):
            provenance.validate_authenticated_provenance_binding(validate(), identity)

    def test_canonical_selection_binds_run_attempt_and_verifies_independent_identity(self) -> None:
        request = main_selection_request()
        identity = trusted_identity()
        with TemporaryDirectory() as directory:
            service_zip = Path(directory) / "artifact.zip"
            with ZipFile(service_zip, "w") as archive:
                archive.writestr(identity.archive_name, b"runtime-bytes")
            archive_bytes = service_zip.read_bytes()
            outer_digest = hashlib.sha256(archive_bytes).hexdigest()
            inner_digest = hashlib.sha256(b"runtime-bytes").hexdigest()
            request = replace(request, archive_name=identity.archive_name)
            metadata = selection_artifact_metadata(request)
            metadata.update({"digest": "sha256:" + outer_digest, "size_in_bytes": len(archive_bytes)})
            run = selection_run_metadata(request)
            with patch.object(provenance, "fetch_run_metadata", return_value=run), patch.object(provenance, "fetch_run_artifacts", return_value={"total_count": 1, "artifacts": [metadata]}):
                selected = provenance.select_artifact_request(request, service_zip=service_zip, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))
            identity = replace(identity, artifact_service_zip_sha256=outer_digest, artifact_service_zip_bytes=len(archive_bytes), archive_sha256=inner_digest, archive_bytes=len(b"runtime-bytes"))
            self.assertEqual(selected.artifact_id, identity.artifact_id)
            self.assertEqual(selected.archive_sha256, identity.archive_sha256)
            provenance.verify_artifact_selection_against_identity(selected, identity)

    def test_canonical_selection_rejects_expiry_wrong_attempt_and_duplicate_ids(self) -> None:
        request = main_selection_request()
        run = selection_run_metadata(request)
        metadata = selection_artifact_metadata(request)
        for mutation in (
            {"expired": True},
            {"name": provenance.expected_artifact_name(RUN_ID, RUN_ATTEMPT + 1)},
            {"size_in_bytes": provenance.MAX_ARTIFACT_BYTES + 1},
        ):
            candidate = copy.deepcopy(metadata)
            candidate.update(mutation)
            with self.subTest(mutation=mutation), patch.object(provenance, "fetch_run_metadata", return_value=run), patch.object(provenance, "fetch_run_artifacts", return_value={"total_count": 1, "artifacts": [candidate]}), self.assertRaises(provenance.ProvenanceError):
                provenance.select_artifact_request(request, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))
        duplicate = copy.deepcopy(metadata)
        duplicate["name"] = "other-artifact-name"
        with self.assertRaisesRegex(provenance.ProvenanceError, "duplicate artifact ID"):
            provenance.validate_artifact_api_response({"total_count": 2, "artifacts": [metadata, duplicate]})

    def test_shared_cli_selection_validates_complete_pr_attempt_and_metadata_response(self) -> None:
        request = selection_request()
        run = selection_run_metadata(request)
        response = {"total_count": 1, "artifacts": [selection_artifact_metadata(request)]}
        with patch.object(provenance, "fetch_run_metadata", return_value=run), patch.object(provenance, "fetch_run_artifacts", return_value=response):
            selected = provenance.select_artifact_request(request, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))
        self.assertFalse(selected.byte_verified)
        self.assertIsNone(selected.archive_sha256)
        self.assertEqual(selected.artifact_id, ARTIFACT_ID)

    def test_attempt_and_artifact_correlation_rejects_source_branch_owner_repo_and_head_mutations(self) -> None:
        request = selection_request()
        base = selection_run_metadata(request)
        mutations = (
            ("head_sha", "0" * 40),
            ("head_branch", "wrong"),
            ("repository", {"full_name": "evil/repo", "id": request.repository_id, "owner": {"id": request.repository_owner_id}}),
            ("head_repository", {"full_name": request.repository, "id": request.repository_id, "owner_id": 999}),
        )
        for field, value in mutations:
            candidate = copy.deepcopy(base)
            candidate[field] = value
            with self.subTest(field=field), self.assertRaises(provenance.ProvenanceError):
                provenance.validate_exact_run_attempt_request_metadata(candidate, request, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))
        artifact = selection_artifact_metadata(request)
        for field, value in (("head_sha", "0" * 40), ("head_branch", "wrong"), ("head_repository_id", 999), ("repository_id", 999)):
            candidate = copy.deepcopy(artifact)
            candidate["workflow_run"][field] = value
            response = {"total_count": 1, "artifacts": [candidate]}
            with self.subTest(artifact_field=field), patch.object(provenance, "fetch_run_metadata", return_value=base), patch.object(provenance, "fetch_run_artifacts", return_value=response), self.assertRaises(provenance.ProvenanceError):
                provenance.select_artifact_request(request, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))

    def test_selection_rejects_incomplete_api_pages_future_artifacts_and_contradictory_time(self) -> None:
        request = selection_request()
        run = selection_run_metadata(request)
        for response in ({"total_count": 2, "artifacts": [selection_artifact_metadata(request)]}, {"total_count": 1, "artifacts": [selection_artifact_metadata(request), selection_artifact_metadata(request)]}):
            with self.subTest(response=response), patch.object(provenance, "fetch_run_metadata", return_value=run), patch.object(provenance, "fetch_run_artifacts", return_value=response), self.assertRaises(provenance.ProvenanceError):
                provenance.select_artifact_request(request, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))
        future = selection_artifact_metadata(request)
        future["created_at"] = "2026-11-25T21:00:00Z"
        with patch.object(provenance, "fetch_run_metadata", return_value=run), patch.object(provenance, "fetch_run_artifacts", return_value={"total_count": 1, "artifacts": [future]}), self.assertRaises(provenance.ProvenanceError):
            provenance.select_artifact_request(request, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))
        previous_attempt = selection_artifact_metadata(request)
        previous_attempt["created_at"] = "2026-11-25T19:45:13Z"
        with patch.object(provenance, "fetch_run_metadata", return_value=run), patch.object(provenance, "fetch_run_artifacts", return_value={"total_count": 1, "artifacts": [previous_attempt]}), self.assertRaisesRegex(provenance.ProvenanceError, "outside the exact attempt window"):
            provenance.select_artifact_request(request, now=datetime(2026, 11, 25, 20, tzinfo=timezone.utc))

    def test_zip_hash_and_parser_use_one_snapshot_and_reject_independent_digest_mutations(self) -> None:
        identity = trusted_identity()
        with TemporaryDirectory() as directory:
            source = Path(directory) / "artifact.zip"
            with ZipFile(source, "w") as archive:
                archive.writestr(identity.archive_name, b"runtime-bytes")
            valid_bytes = source.read_bytes()
            valid_outer_digest = hashlib.sha256(valid_bytes).hexdigest()
            snapshot = provenance.open_zip_snapshot(source)
            try:
                source.write_bytes(b"substituted-after-snapshot")
                digest, size = provenance.inspect_artifact_service_zip_snapshot(snapshot, identity.archive_name)
                self.assertEqual(digest, hashlib.sha256(b"runtime-bytes").hexdigest())
                self.assertEqual(size, len(b"runtime-bytes"))
                with self.assertRaisesRegex(provenance.ProvenanceError, "inner runtime archive digest mismatch"):
                    provenance.inspect_artifact_service_zip_snapshot(snapshot, identity.archive_name, "0" * 64, len(b"runtime-bytes"))
            finally:
                provenance.close_zip_snapshot(snapshot)
            source.write_bytes(valid_bytes)
            identity = replace(identity, artifact_service_zip_sha256="0" * 64, artifact_service_zip_bytes=len(valid_bytes), archive_sha256=hashlib.sha256(b"runtime-bytes").hexdigest(), archive_bytes=len(b"runtime-bytes"))
            with self.assertRaisesRegex(provenance.ProvenanceError, "artifact service ZIP digest mismatch"):
                self.assertEqual(valid_outer_digest, hashlib.sha256(source.read_bytes()).hexdigest())
                provenance.inspect_artifact_service_zip(source, identity)

    def test_zip_metadata_limits_and_nonregular_inputs_fail_closed(self) -> None:
        identity = trusted_identity()
        with TemporaryDirectory() as directory:
            source = Path(directory) / "artifact.zip"
            with ZipFile(source, "w") as archive:
                archive.comment = b"x" * (provenance.MAX_ZIP_COMMENT_BYTES + 1)
                archive.writestr(identity.archive_name, b"runtime-bytes")
            with self.assertRaises(provenance.ProvenanceError):
                provenance.inspect_artifact_service_zip(source, identity)
            directory_path = Path(directory) / "not-a-file"
            directory_path.mkdir()
            with self.assertRaises(provenance.ProvenanceError):
                provenance.open_zip_snapshot(directory_path)

    def test_zip64_and_contradictory_header_count_reject_before_zipfile_parser(self) -> None:
        identity = trusted_identity()
        with TemporaryDirectory() as directory:
            source = Path(directory) / "valid.zip"
            with ZipFile(source, "w") as archive:
                archive.writestr(identity.archive_name, b"runtime-bytes")
            valid = source.read_bytes()
            eocd = valid[-provenance.ZIP_EOCD_BYTES:]
            zip64_locator = struct.pack("<4sLQL", b"PK\x06\x07", 0, 0, 1)
            zip64_path = Path(directory) / "zip64-locator.zip"
            zip64_path.write_bytes(valid[:-provenance.ZIP_EOCD_BYTES] + zip64_locator + eocd)
            zip64_snapshot = provenance.open_zip_snapshot(zip64_path)
            try:
                with patch.object(provenance, "ZipFile", side_effect=AssertionError("ZipFile parser must not be reached")):
                    with self.assertRaisesRegex(provenance.ProvenanceError, "ZIP64 records"):
                        provenance.inspect_artifact_service_zip_snapshot(zip64_snapshot, identity.archive_name)
            finally:
                provenance.close_zip_snapshot(zip64_snapshot)
            contradictory = bytearray(valid)
            eocd_offset = len(contradictory) - provenance.ZIP_EOCD_BYTES
            contradictory[eocd_offset + 8:eocd_offset + 10] = (2).to_bytes(2, "little")
            contradictory[eocd_offset + 10:eocd_offset + 12] = (2).to_bytes(2, "little")
            contradictory_path = Path(directory) / "contradictory-count.zip"
            contradictory_path.write_bytes(contradictory)
            contradictory_snapshot = provenance.open_zip_snapshot(contradictory_path)
            try:
                with patch.object(provenance, "ZipFile", side_effect=AssertionError("ZipFile parser must not be reached")):
                    with self.assertRaisesRegex(provenance.ProvenanceError, "central directory"):
                        provenance.inspect_artifact_service_zip_snapshot(contradictory_snapshot, identity.archive_name)
            finally:
                provenance.close_zip_snapshot(contradictory_snapshot)

    def test_authorization_lifecycle_is_deterministic_and_recovery_is_not_forward_authority(self) -> None:
        identity = trusted_identity()
        authorization = provenance.IndependentReleaseAuthorization(
            authorization_id="auth-1", context=identity.authorization_context, scope="forward-release",
            repository=identity.repository, repository_id=identity.repository_id, repository_owner_id=identity.repository_owner_id,
            source_ref=identity.source_ref, source_sha=identity.source_sha, event=identity.event,
            signer_workflow=identity.signer_workflow, signer_revision=identity.signer_revision, run_id=identity.run_id, run_attempt=identity.run_attempt,
            artifact_id=identity.artifact_id, artifact_name=identity.artifact_name, artifact_class=identity.artifact_class,
            artifact_service_zip_sha256=identity.artifact_service_zip_sha256, artifact_service_zip_bytes=identity.artifact_service_zip_bytes,
            archive_name=identity.archive_name, archive_sha256=identity.archive_sha256, archive_bytes=identity.archive_bytes,
            platform=identity.platform, image=identity.image, image_digest=identity.image_digest,
            issued_at="2026-11-25T12:00:00Z", expires_at="2026-11-25T13:00:00Z", retry_key="auth-1", recovery_context=None,
            verification=provenance.AuthorizationVerificationReceipt("test", "7" * 64, "2026-11-25T12:00:00Z", "test-key"),
        )
        provenance.validate_independent_authorization(authorization, identity, now=datetime(2026, 11, 25, 12, 30, tzinfo=timezone.utc))
        self.assertFalse(provenance.evaluate_production_eligibility("not-authenticated", identity, authorization, now=datetime(2026, 11, 25, 12, 30, tzinfo=timezone.utc)).authoritative)
        for field, value in (("expires_at", "2026-11-25T12:00:00Z"), ("issued_at", "2026-11-25T14:00:00Z"), ("scope", "recovery-release"), ("retry_key", "other")):
            candidate = replace(authorization, **{field: value})
            with self.subTest(field=field), self.assertRaises(provenance.ProvenanceError):
                provenance.validate_independent_authorization(candidate, identity, now=datetime(2026, 11, 25, 12, 30, tzinfo=timezone.utc))

    def test_exact_run_attempt_api_route_is_used(self) -> None:
        response = provenance.subprocess.CompletedProcess([], 0, '{"id": 45506759751, "run_attempt": 2}', "")
        with patch.object(provenance, "run_bounded", return_value=response) as run:
            metadata = provenance.fetch_run_metadata(REPOSITORY, RUN_ID, RUN_ATTEMPT)
        self.assertEqual(metadata["run_attempt"], RUN_ATTEMPT)
        self.assertIn(f"/actions/runs/{RUN_ID}/attempts/{RUN_ATTEMPT}", run.call_args.args[0][2])

    def test_synthetic_positive_policy_fixture_is_non_authoritative(self) -> None:
        result = provenance.evaluate_synthetic_production_policy_fixture({"fixtureKind": "synthetic-production-policy", "synthetic": True})
        self.assertTrue(result.eligible)
        self.assertFalse(result.authoritative)

    def test_missing_or_conflicting_identity_is_rejected(self) -> None:
        for field in ("sourceRepositoryIdentifier", "sourceRepositoryRef", "buildSignerDigest", "runInvocationURI", "runnerEnvironment"):
            result = copy.deepcopy(verified_result())
            result["verificationResult"]["signature"]["certificate"].pop(field)
            with self.subTest(field=field), self.assertRaises(provenance.ProvenanceError):
                provenance.validate_verified_result(result, archive_name=f"clashcookies-runtime-{SOURCE_SHA}.tar.gz", archive_digest=ARCHIVE_SHA, archive_bytes=101, expected=expected(), run_metadata=run_metadata())

    def test_wrong_source_signer_run_and_subject_are_rejected(self) -> None:
        mutations = (("sourceRepositoryDigest", "0" * 40), ("buildSignerDigest", "0" * 40), ("runInvocationURI", "wrong"), ("subject", "0" * 64))
        for field, value in mutations:
            result = copy.deepcopy(verified_result())
            if field == "subject":
                result["verificationResult"]["statement"]["subject"][0]["digest"]["sha256"] = value
            else:
                result["verificationResult"]["signature"]["certificate"][field] = value
            with self.subTest(field=field), self.assertRaises(provenance.ProvenanceError):
                provenance.validate_verified_result(result, archive_name=f"clashcookies-runtime-{SOURCE_SHA}.tar.gz", archive_digest=ARCHIVE_SHA, archive_bytes=101, expected=expected(), run_metadata=run_metadata())

    def test_official_verifier_command_is_required_and_bounded(self) -> None:
        with patch.object(provenance, "run_bounded", side_effect=FileNotFoundError("gh")):
            with self.assertRaises(provenance.ProvenanceError):
                provenance.run_gh_attestation_verify(Path(__file__), bundle=None, repository=REPOSITORY, signer_workflow=SIGNER_WORKFLOW, signer_revision=SIGNER_SHA, source_ref=PR_SOURCE_REF, source_sha=SOURCE_SHA)

    def test_missing_malformed_or_ambiguous_official_result_is_rejected(self) -> None:
        for stdout in ("not-json", "[]", "[{}, {}]"):
            version = provenance.subprocess.CompletedProcess([], 0, "gh version 2.89.0 (test)\n", "")
            verification = provenance.subprocess.CompletedProcess([], 0, stdout, "")
            with self.subTest(stdout=stdout), patch.object(provenance, "run_bounded", side_effect=[version, verification]):
                with self.assertRaises(provenance.ProvenanceError):
                    provenance.run_gh_attestation_verify(Path(__file__), bundle=None, repository=REPOSITORY, signer_workflow=SIGNER_WORKFLOW, signer_revision=SIGNER_SHA, source_ref=PR_SOURCE_REF, source_sha=SOURCE_SHA)

    def test_subprocess_output_is_bounded_during_execution(self) -> None:
        command = [sys.executable, "-c", "import sys; sys.stdout.write('x' * 10000000)"]
        with self.assertRaises(provenance.ProvenanceError):
            provenance.run_bounded(command, timeout_seconds=5, max_output_bytes=1024, label="test command")

    def test_subprocess_waits_for_delayed_success_after_both_streams_close(self) -> None:
        command = [sys.executable, "-c", "import os,time; os.close(1); os.close(2); time.sleep(.1); os._exit(0)"]
        result = provenance.run_bounded(command, timeout_seconds=2, max_output_bytes=1024, label="delayed success")
        self.assertEqual(result.returncode, 0)
        self.assertFalse(any(thread.name.startswith("runtime-artifact-reader-") and thread.is_alive() for thread in provenance.threading.enumerate()))

    def test_subprocess_returns_delayed_nonzero_exit_after_both_streams_close(self) -> None:
        command = [sys.executable, "-c", "import os,time; os.close(1); os.close(2); time.sleep(.1); os._exit(7)"]
        result = provenance.run_bounded(command, timeout_seconds=2, max_output_bytes=1024, label="delayed nonzero")
        self.assertEqual(result.returncode, 7)

    def test_subprocess_timeout_kills_child_and_reader_threads(self) -> None:
        command = [sys.executable, "-c", "import os,time; os.close(1); os.close(2); time.sleep(5)"]
        with self.assertRaises(provenance.subprocess.TimeoutExpired):
            provenance.run_bounded(command, timeout_seconds=0.1, max_output_bytes=1024, label="timeout")
        self.assertFalse(any(thread.name.startswith("runtime-artifact-reader-") and thread.is_alive() for thread in provenance.threading.enumerate()))

    def test_subprocess_overflow_is_rejected_on_each_stream(self) -> None:
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream):
                command = [sys.executable, "-c", f"import sys; sys.{stream}.write('x' * 10000000); sys.{stream}.flush()"]
                with self.assertRaises(provenance.ProvenanceError):
                    provenance.run_bounded(command, timeout_seconds=5, max_output_bytes=1024, label=f"{stream} overflow")
                self.assertFalse(any(thread.name.startswith("runtime-artifact-reader-") and thread.is_alive() for thread in provenance.threading.enumerate()))

    def test_unsupported_contract_is_rejected(self) -> None:
        result = provenance.evaluate_synthetic_production_policy_fixture({"fixtureKind": "wrong", "synthetic": True})
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "invalid-synthetic-fixture")


if __name__ == "__main__":
    unittest.main()
