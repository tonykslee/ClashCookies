"""Deterministic contract tests for authenticated runtime-artifact provenance."""

from __future__ import annotations

import copy
import importlib.util
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch


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
        identity = provenance.TrustedReleaseIdentity(REPOSITORY, REPOSITORY_ID, SIGNER_WORKFLOW, SIGNER_SHA, RUN_ID, RUN_ATTEMPT, SOURCE_SHA, ARCHIVE_SHA, 101, "linux/amd64", "sha256:" + "f" * 64, "owner-approved-main-release")
        result = provenance.evaluate_production_eligibility(relabelled, identity, None)
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "unverifiable-provenance")

    def test_missing_independent_authorization_is_rejected(self) -> None:
        evidence = replace(validate(), artifact_class=provenance.PRODUCTION_ARTIFACT_CLASS)
        identity = provenance.TrustedReleaseIdentity(REPOSITORY, REPOSITORY_ID, SIGNER_WORKFLOW, SIGNER_SHA, RUN_ID, RUN_ATTEMPT, SOURCE_SHA, ARCHIVE_SHA, 101, "linux/amd64", "sha256:" + "f" * 64, "owner-approved-main-release")
        result = provenance.evaluate_production_eligibility(evidence, identity, None)
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "missing-independent-authorization")

    def test_production_remains_unavailable_even_with_mutable_positive_fields(self) -> None:
        evidence = replace(validate(), artifact_class=provenance.PRODUCTION_ARTIFACT_CLASS, source_ref="refs/heads/main", event="push")
        identity = provenance.TrustedReleaseIdentity(REPOSITORY, REPOSITORY_ID, SIGNER_WORKFLOW, SIGNER_SHA, RUN_ID, RUN_ATTEMPT, SOURCE_SHA, ARCHIVE_SHA, 101, "linux/amd64", "sha256:" + "f" * 64, "owner-approved-main-release")
        authorization = provenance.IndependentReleaseAuthorization("owner-approved-main-release", SOURCE_SHA)
        result = provenance.evaluate_production_eligibility(evidence, identity, authorization)
        self.assertFalse(result.eligible)
        self.assertEqual(result.reason_code, "production-producer-unavailable")

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
