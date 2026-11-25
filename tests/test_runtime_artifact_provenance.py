"""Deterministic contract tests for authenticated runtime-artifact provenance."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
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
    }
    if context["event"] == "pull_request":
        metadata["pull_requests"] = [{
            "number": 2188,
            "head": {"sha": PR_HEAD_SHA, "ref": context["pr_head_ref"]},
            "base": {"sha": PR_BASE_SHA, "ref": "dev"},
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
        result = provenance.evaluate_production_eligibility(evidence, identity, authorization)
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "production-producer-unavailable")

    def test_authenticated_provenance_identity_conflict_is_rejected_before_production(self) -> None:
        identity = trusted_identity()
        with self.assertRaises(provenance.ProvenanceError):
            provenance.validate_authenticated_provenance_binding(validate(), identity)

    def test_exact_artifact_selection_binds_run_attempt_and_zip_and_inner_archive(self) -> None:
        identity = trusted_identity()
        with TemporaryDirectory() as directory:
            service_zip = Path(directory) / "artifact.zip"
            with ZipFile(service_zip, "w") as archive:
                archive.writestr(identity.archive_name, b"runtime-bytes")
            archive_bytes = service_zip.read_bytes()
            identity = replace(identity, artifact_service_zip_sha256=hashlib.sha256(archive_bytes).hexdigest(), artifact_service_zip_bytes=len(archive_bytes), archive_sha256=hashlib.sha256(b"runtime-bytes").hexdigest(), archive_bytes=len(b"runtime-bytes"))
            metadata = {
                "id": identity.artifact_id,
                "name": identity.artifact_name,
                "digest": "sha256:" + identity.artifact_service_zip_sha256,
                "size_in_bytes": identity.artifact_service_zip_bytes,
                "expired": False,
                "created_at": "2026-11-25T00:00:00Z",
                "expires_at": "2026-11-26T00:00:00Z",
                "workflow_run": {"id": identity.run_id, "repository_id": identity.repository_id, "head_sha": identity.source_sha},
            }
            selected = provenance.select_exact_artifact([metadata], identity, service_zip=service_zip, now=datetime(2026, 11, 25, tzinfo=timezone.utc))
            self.assertEqual(selected.artifact_id, identity.artifact_id)
            self.assertEqual(selected.archive_sha256, identity.archive_sha256)

    def test_exact_artifact_selection_rejects_expiry_wrong_attempt_and_conflicts(self) -> None:
        identity = trusted_identity()
        metadata = {
            "id": identity.artifact_id,
            "name": identity.artifact_name,
            "digest": "sha256:" + identity.artifact_service_zip_sha256,
            "size_in_bytes": identity.artifact_service_zip_bytes,
            "expired": False,
            "created_at": "2026-11-25T00:00:00Z",
            "expires_at": "2026-11-26T00:00:00Z",
            "workflow_run": {"id": identity.run_id, "repository_id": identity.repository_id, "head_sha": identity.source_sha},
        }
        for mutation in (
            {"expired": True},
            {"name": provenance.expected_artifact_name(RUN_ID, RUN_ATTEMPT + 1)},
            {"size_in_bytes": identity.artifact_service_zip_bytes + 1},
        ):
            candidate = dict(metadata)
            candidate.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(provenance.ProvenanceError):
                provenance.select_exact_artifact([candidate], identity, now=datetime(2026, 11, 25, tzinfo=timezone.utc))
        with self.assertRaises(provenance.ProvenanceError):
            provenance.select_exact_artifact([metadata, dict(metadata)], identity, now=datetime(2026, 11, 25, tzinfo=timezone.utc))

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
