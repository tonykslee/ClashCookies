"""Deterministic contract tests for authenticated runtime-artifact provenance."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
import unittest
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
SIGNER_SHA = "c" * 40
REPOSITORY = "tonykslee/ClashCookies"
REPOSITORY_ID = "123456789"
SIGNER_WORKFLOW = ".github/workflows/runtime-artifact.yml"
SOURCE_REF = "refs/heads/dev"


def expected() -> dict[str, object]:
    """Return an explicit development verification context."""
    return {
        "repository": REPOSITORY,
        "repository_id": REPOSITORY_ID,
        "signer_workflow": SIGNER_WORKFLOW,
        "signer_revision": SIGNER_SHA,
        "source_ref": SOURCE_REF,
        "source_sha": SOURCE_SHA,
        "event": "push",
        "run_id": 45506759751,
        "run_attempt": 2,
        "artifact_class": provenance.DEVELOPMENT_ARTIFACT_CLASS,
        "platform": "linux/amd64",
        "image": "node:20-bookworm@sha256:" + "d" * 64,
        "image_digest": "sha256:" + "d" * 64,
    }


def verified_result() -> dict[str, object]:
    """Return a synthetic gh output shape with explicit test provenance."""
    return {
        "verificationResult": {
            "signature": {
                "certificate": {
                    "sourceRepositoryOwner": "tonykslee",
                    "sourceRepository": "ClashCookies",
                    "sourceRepositoryIdentifier": REPOSITORY_ID,
                    "sourceRepositoryURI": "https://github.com/" + REPOSITORY,
                    "sourceRepositoryRef": SOURCE_REF,
                    "sourceRepositoryDigest": SOURCE_SHA,
                    "buildSignerDigest": SIGNER_SHA,
                    "runnerEnvironment": "github-hosted",
                    "issuer": provenance.GITHUB_OIDC_ISSUER,
                    "subjectAlternativeName": "https://github.com/" + REPOSITORY + "/" + SIGNER_WORKFLOW + "@" + SIGNER_SHA,
                }
            },
            "statement": {
                "predicateType": provenance.SLSA_PROVENANCE_V1,
                "subject": [{"name": "clashcookies-runtime-" + SOURCE_SHA + ".tar.gz", "digest": {"sha256": ARCHIVE_SHA}}],
                "predicate": {
                    "buildDefinition": {"externalParameters": {"event": "push"}},
                    "internalParameters": {"github": {"run_id": str(45506759751), "run_attempt": 2, "event_name": "push"}},
                    "runDetails": {"metadata": {"invocationId": "https://github.com/tonykslee/ClashCookies/actions/runs/45506759751/attempts/2"}},
                },
            },
        }
    }


class RuntimeArtifactProvenanceTests(unittest.TestCase):
    """Exercise valid, invalid, and future-policy provenance paths."""

    def test_authenticated_development_artifact_is_valid(self) -> None:
        evidence = provenance.validate_verified_result(
            verified_result(),
            archive_name="clashcookies-runtime-" + SOURCE_SHA + ".tar.gz",
            archive_digest=ARCHIVE_SHA,
            archive_bytes=101,
            expected=expected(),
            run_metadata={"id": 45506759751, "head_sha": SOURCE_SHA, "event": "push", "run_attempt": 2, "path": SIGNER_WORKFLOW},
        )
        self.assertTrue(evidence["authenticated"])
        self.assertEqual(evidence["subject"]["artifactClass"], provenance.DEVELOPMENT_ARTIFACT_CLASS)
        self.assertTrue(evidence["verification"]["runMetadataIndependentlyChecked"])

    def test_development_artifact_is_refused_by_production_policy(self) -> None:
        evidence = provenance.validate_verified_result(
            verified_result(),
            archive_name="clashcookies-runtime-" + SOURCE_SHA + ".tar.gz",
            archive_digest=ARCHIVE_SHA,
            archive_bytes=101,
            expected=expected(),
        )
        policy_expected = {**expected(), "approved_release_sha": SOURCE_SHA, "archive_sha256": ARCHIVE_SHA, "archive_bytes": 101, "authorization_context": "owner-approved-main-release"}
        eligible, reason = provenance.evaluate_production_eligibility(evidence, policy_expected)
        self.assertFalse(eligible)
        self.assertIn("development artifact", reason)

    def test_valid_isolated_synthetic_production_fixture_is_eligible(self) -> None:
        evidence = provenance.validate_verified_result(
            verified_result(),
            archive_name="clashcookies-runtime-" + SOURCE_SHA + ".tar.gz",
            archive_digest=ARCHIVE_SHA,
            archive_bytes=101,
            expected=expected(),
        )
        evidence["subject"]["artifactClass"] = provenance.PRODUCTION_ARTIFACT_CLASS
        evidence["source"]["ref"] = "refs/heads/main"
        evidence["source"]["event"] = "push"
        evidence["signer"]["workflow"] = SIGNER_WORKFLOW
        evidence["authorization"] = {"authorized": True, "context": "owner-approved-main-release"}
        policy_expected = {**expected(), "approved_release_sha": SOURCE_SHA, "archive_sha256": ARCHIVE_SHA, "archive_bytes": 101, "authorization_context": "owner-approved-main-release"}
        eligible, reason = provenance.evaluate_production_eligibility(evidence, policy_expected)
        self.assertTrue(eligible, reason)

    def test_missing_or_conflicting_identity_is_rejected(self) -> None:
        for field in ("sourceRepositoryIdentifier", "sourceRepositoryRef", "buildSignerDigest", "runnerEnvironment"):
            result = copy.deepcopy(verified_result())
            result["verificationResult"]["signature"]["certificate"].pop(field)
            with self.subTest(field=field), self.assertRaises(provenance.ProvenanceError):
                provenance.validate_verified_result(result, archive_name="clashcookies-runtime-" + SOURCE_SHA + ".tar.gz", archive_digest=ARCHIVE_SHA, archive_bytes=101, expected=expected())

    def test_wrong_source_signer_run_and_subject_are_rejected(self) -> None:
        mutations = (
            ("source", "sourceRepositoryDigest", "0" * 40),
            ("signer", "buildSignerDigest", "0" * 40),
            ("run", "run_attempt", 99),
            ("subject", "sha256", "0" * 64),
        )
        for label, field, value in mutations:
            result = copy.deepcopy(verified_result())
            if label == "source":
                result["verificationResult"]["signature"]["certificate"][field] = value
            elif label == "signer":
                result["verificationResult"]["signature"]["certificate"][field] = value
            elif label == "run":
                result["verificationResult"]["statement"]["predicate"]["internalParameters"]["github"][field] = value
            else:
                result["verificationResult"]["statement"]["subject"][0]["digest"][field] = value
            with self.subTest(label=label), self.assertRaises(provenance.ProvenanceError):
                provenance.validate_verified_result(result, archive_name="clashcookies-runtime-" + SOURCE_SHA + ".tar.gz", archive_digest=ARCHIVE_SHA, archive_bytes=101, expected=expected())

    def test_official_verifier_command_is_required_and_bounded(self) -> None:
        with patch.object(provenance.subprocess, "run", side_effect=FileNotFoundError("gh")):
            with self.assertRaises(provenance.ProvenanceError):
                provenance.run_gh_attestation_verify(Path("artifact.tar.gz"), bundle=None, repository=REPOSITORY, signer_workflow=SIGNER_WORKFLOW, signer_revision=SIGNER_SHA, source_ref=SOURCE_REF, source_sha=SOURCE_SHA)

    def test_missing_malformed_or_ambiguous_official_result_is_rejected(self) -> None:
        for stdout in ("not-json", "[]", "[{}, {}]"):
            with self.subTest(stdout=stdout), patch.object(provenance.subprocess, "run", return_value=provenance.subprocess.CompletedProcess([], 0, stdout, "")):
                with self.assertRaises(provenance.ProvenanceError):
                    provenance.run_gh_attestation_verify(Path("artifact.tar.gz"), bundle=None, repository=REPOSITORY, signer_workflow=SIGNER_WORKFLOW, signer_revision=SIGNER_SHA, source_ref=SOURCE_REF, source_sha=SOURCE_SHA)

    def test_unsupported_contract_is_rejected(self) -> None:
        evidence = {"contract": provenance.PROVENANCE_CONTRACT, "contractVersion": 99, "authenticated": True}
        eligible, reason = provenance.evaluate_production_eligibility(evidence, expected())
        self.assertFalse(eligible)
        self.assertIn("version", reason)

    def test_wrong_platform_or_image_digest_is_rejected(self) -> None:
        evidence = provenance.validate_verified_result(
            verified_result(),
            archive_name="clashcookies-runtime-" + SOURCE_SHA + ".tar.gz",
            archive_digest=ARCHIVE_SHA,
            archive_bytes=101,
            expected=expected(),
        )
        evidence["subject"]["artifactClass"] = provenance.PRODUCTION_ARTIFACT_CLASS
        evidence["source"]["ref"] = "refs/heads/main"
        evidence["authorization"] = {"authorized": True, "context": "owner-approved-main-release"}
        policy_expected = {**expected(), "approved_release_sha": SOURCE_SHA, "archive_sha256": ARCHIVE_SHA, "archive_bytes": 101, "authorization_context": "owner-approved-main-release"}
        evidence["build"]["platform"] = "linux/arm64"
        eligible, reason = provenance.evaluate_production_eligibility(evidence, policy_expected)
        self.assertFalse(eligible)
        self.assertIn("platform", reason)


if __name__ == "__main__":
    unittest.main()
