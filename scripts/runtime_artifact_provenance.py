#!/usr/bin/env python3
"""Authenticated runtime-artifact provenance and release eligibility contracts."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any


PROVENANCE_CONTRACT_VERSION = 1
PROVENANCE_CONTRACT = "clashcookies.runtime-artifact-provenance"
SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1"
GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
GITHUB_HOSTED_RUNNER = "github-hosted"
PRODUCTION_ARTIFACT_CLASS = "production-runtime-release"
DEVELOPMENT_ARTIFACT_CLASS = "development-runtime-evidence"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)


class ProvenanceError(RuntimeError):
    """Raised when authenticated provenance or release eligibility is invalid."""


def fail(message: str) -> None:
    """Raise a bounded, user-facing provenance failure."""
    raise ProvenanceError(message)


def require(condition: bool, message: str) -> None:
    """Stop on a missing, malformed, conflicting, or unsupported contract value."""
    if not condition:
        fail(message)


def require_string(value: Any, path: str) -> str:
    """Return a non-empty string contract field."""
    require(isinstance(value, str) and value != "", f"provenance field {path} must be a non-empty string")
    return value


def require_int(value: Any, path: str, minimum: int = 0) -> int:
    """Return a bounded integer contract field."""
    require(type(value) is int and value >= minimum, f"provenance field {path} must be an integer >= {minimum}")
    return value


def require_sha(value: Any, path: str) -> str:
    """Return a normalized full Git SHA."""
    value = require_string(value, path).lower()
    require(bool(GIT_SHA_RE.fullmatch(value)), f"provenance field {path} must be a full Git SHA")
    return value


def require_digest(value: Any, path: str) -> str:
    """Return a normalized SHA-256 digest without an algorithm prefix."""
    value = require_string(value, path).lower()
    if value.startswith("sha256:"):
        value = value[7:]
    require(bool(SHA256_RE.fullmatch(value)), f"provenance field {path} must be a SHA-256 digest")
    return value


def nested_values(value: Any, keys: set[str]) -> list[Any]:
    """Collect exact-key values from a bounded JSON document for predicate correlation."""
    found: list[Any] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in keys:
                found.append(child)
            found.extend(nested_values(child, keys))
    elif isinstance(value, list):
        for child in value:
            found.extend(nested_values(child, keys))
    return found


def one_matching(values: list[Any], expected: Any, path: str) -> Any:
    """Require at least one matching value and reject conflicting values."""
    require(values, f"provenance predicate is missing {path}")
    normalized = {json.dumps(value, sort_keys=True) for value in values}
    require(len(normalized) == 1 and expected in values, f"provenance predicate {path} is conflicting or mismatched")
    return values[0]


def run_invocation_values(predicate: dict[str, Any]) -> tuple[list[Any], list[Any]]:
    """Extract workflow run IDs and attempts from workflow-controlled predicate metadata."""
    run_ids = nested_values(predicate, {"run_id", "runId"})
    attempts = nested_values(predicate, {"run_attempt", "runAttempt", "attempt"})
    for invocation in nested_values(predicate, {"invocationId", "invocation_id"}):
        if isinstance(invocation, str):
            match = re.search(r"/actions/runs/(\d+)(?:/attempts/(\d+))?", invocation)
            if match:
                run_ids.append(int(match.group(1)))
                if match.group(2) is not None:
                    attempts.append(int(match.group(2)))
    return run_ids, attempts


def run_gh_attestation_verify(
    archive: Path,
    *,
    bundle: Path | None,
    repository: str,
    signer_workflow: str,
    signer_revision: str,
    source_ref: str,
    source_sha: str,
    timeout_seconds: int = 90,
) -> dict[str, Any]:
    """Run the official GitHub CLI verifier against the immutable archive snapshot."""
    cli_signer_workflow = signer_workflow if "/" in signer_workflow.split(".github/", 1)[0] else f"{repository}/{signer_workflow}"
    command = [
        "gh",
        "attestation",
        "verify",
        str(archive),
        "--repo",
        repository,
        "--signer-workflow",
        cli_signer_workflow,
        "--signer-digest",
        signer_revision,
        "--source-ref",
        source_ref,
        "--source-digest",
        source_sha,
        "--predicate-type",
        SLSA_PROVENANCE_V1,
        "--format",
        "json",
    ]
    if bundle is not None:
        command.extend(["--bundle", str(bundle)])
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout_seconds)
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"official GitHub attestation verifier unavailable or timed out: {error}")
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "no verifier detail"
        fail(f"official GitHub attestation verification failed: {detail[:400]}")
    try:
        document = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        fail(f"official GitHub attestation verifier returned malformed JSON: {error}")
    require(isinstance(document, list), "official GitHub attestation verifier output must be an array")
    require(len(document) == 1, "attestation selection is missing or ambiguous")
    require(isinstance(document[0], dict), "official GitHub attestation verifier returned an invalid result")
    return document[0]


def fetch_run_metadata(repository: str, run_id: int, timeout_seconds: int = 30) -> dict[str, Any]:
    """Read authenticated GitHub Actions run metadata for independent correlation."""
    command = ["gh", "api", f"repos/{repository}/actions/runs/{run_id}"]
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout_seconds)
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"authenticated GitHub Actions run metadata unavailable or timed out: {error}")
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "no API detail"
        fail(f"authenticated GitHub Actions run metadata request failed: {detail[:400]}")
    try:
        metadata = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        fail(f"authenticated GitHub Actions run metadata is malformed: {error}")
    require(isinstance(metadata, dict), "authenticated GitHub Actions run metadata must be an object")
    return metadata


def _certificate(result: dict[str, Any]) -> dict[str, Any]:
    """Return the cryptographically verified certificate claims from gh output."""
    verification = result.get("verificationResult")
    require(isinstance(verification, dict), "attestation verification result is missing")
    signature = verification.get("signature")
    require(isinstance(signature, dict), "attestation signature is missing")
    certificate = signature.get("certificate")
    require(isinstance(certificate, dict), "attestation certificate claims are missing")
    return certificate


def validate_verified_result(
    result: dict[str, Any],
    *,
    archive_name: str,
    archive_digest: str,
    archive_bytes: int,
    expected: dict[str, Any],
    run_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate verified certificate claims and bind them to one artifact contract."""
    verification = result.get("verificationResult")
    require(isinstance(verification, dict), "attestation verification result is missing")
    statement = verification.get("statement")
    require(isinstance(statement, dict), "attestation statement is missing")
    require(statement.get("predicateType") == SLSA_PROVENANCE_V1, "unsupported attestation predicate type")
    subjects = statement.get("subject")
    require(isinstance(subjects, list) and len(subjects) == 1, "attestation subject is missing or ambiguous")
    subject = subjects[0]
    require(isinstance(subject, dict), "attestation subject is malformed")
    require(subject.get("name") == archive_name, "attestation subject name does not match the archive")
    subject_digest = subject.get("digest")
    require(isinstance(subject_digest, dict) and subject_digest.get("sha256") == archive_digest, "attestation subject digest does not match the immutable archive snapshot")

    certificate = _certificate(result)
    repository = require_string(expected["repository"], "expected.repository")
    owner, name = repository.split("/", 1)
    require(certificate.get("sourceRepositoryOwner") == owner, "attestation certificate repository owner mismatch")
    require(certificate.get("sourceRepository") == name, "attestation certificate repository name mismatch")
    require(certificate.get("sourceRepositoryIdentifier") == str(expected["repository_id"]), "attestation certificate repository ID mismatch")
    require(certificate.get("sourceRepositoryURI") == f"https://github.com/{repository}", "attestation certificate repository URI mismatch")
    require(certificate.get("sourceRepositoryRef") == expected["source_ref"], "attestation certificate source ref mismatch")
    require(certificate.get("sourceRepositoryDigest") == expected["source_sha"], "attestation certificate source digest mismatch")
    require(certificate.get("buildSignerDigest") == expected["signer_revision"], "attestation certificate signer revision mismatch")
    require(certificate.get("runnerEnvironment") == GITHUB_HOSTED_RUNNER, "attestation certificate runner is not GitHub-hosted")
    require(certificate.get("issuer") == GITHUB_OIDC_ISSUER, "attestation certificate issuer is not GitHub Actions OIDC")
    expected_san = f"https://github.com/{repository}/{expected['signer_workflow']}"
    san = require_string(certificate.get("subjectAlternativeName"), "certificate.subjectAlternativeName")
    require(san == expected_san or san == f"{expected_san}@{expected['signer_revision']}" or san == f"{expected_san}@{expected['source_ref']}", "attestation certificate signer workflow identity mismatch")

    predicate = statement.get("predicate")
    require(isinstance(predicate, dict), "attestation predicate is missing")
    run_ids, attempts = run_invocation_values(predicate)
    expected_run_id = require_int(expected["run_id"], "expected.run_id", 1)
    expected_attempt = require_int(expected["run_attempt"], "expected.run_attempt", 1)
    require(run_ids and {str(value) for value in run_ids} == {str(expected_run_id)}, "attestation run ID is missing, conflicting, or mismatched")
    require(attempts and {str(value) for value in attempts} == {str(expected_attempt)}, "attestation run attempt is missing, conflicting, or mismatched")
    event_values = nested_values(predicate, {"event", "event_name", "eventName"})
    if event_values:
        one_matching(event_values, expected["event"], "event")

    if run_metadata is not None:
        require(run_metadata.get("id") in (expected_run_id, str(expected_run_id)), "GitHub run metadata ID mismatch")
        require(run_metadata.get("head_sha") == expected["source_sha"], "GitHub run metadata source SHA mismatch")
        require(run_metadata.get("event") == expected["event"], "GitHub run metadata event mismatch")
        require(run_metadata.get("run_attempt") in (expected_attempt, str(expected_attempt)), "GitHub run metadata attempt mismatch")
        require(run_metadata.get("path") == f"/{expected['signer_workflow']}" or run_metadata.get("path") == expected["signer_workflow"], "GitHub run metadata workflow path mismatch")

    return {
        "contract": PROVENANCE_CONTRACT,
        "contractVersion": PROVENANCE_CONTRACT_VERSION,
        "authenticated": True,
        "subject": {"name": archive_name, "sha256": archive_digest, "bytes": archive_bytes, "artifactClass": expected["artifact_class"]},
        "source": {"repository": repository, "repositoryId": str(expected["repository_id"]), "ref": expected["source_ref"], "gitSha": expected["source_sha"], "event": expected["event"]},
        "signer": {"workflow": expected["signer_workflow"], "revision": expected["signer_revision"], "certificateIdentity": san, "runner": GITHUB_HOSTED_RUNNER},
        "run": {"id": expected_run_id, "attempt": expected_attempt},
        "build": {"platform": expected["platform"], "image": expected["image"], "imageDigest": expected["image_digest"]},
        "verification": {"tool": "gh attestation verify", "predicateType": SLSA_PROVENANCE_V1, "subjectDigestAuthenticated": True, "certificateClaimsAuthenticated": True, "predicateClaimsWorkflowControlled": True, "runMetadataIndependentlyChecked": run_metadata is not None},
    }


def evaluate_production_eligibility(evidence: dict[str, Any], expected: dict[str, Any]) -> tuple[bool, str]:
    """Evaluate a future production release envelope without authorizing deployment."""
    try:
        require(evidence.get("contract") == PROVENANCE_CONTRACT, "unsupported provenance contract")
        require(evidence.get("contractVersion") == PROVENANCE_CONTRACT_VERSION, "unsupported provenance contract version")
        require(evidence.get("authenticated") is True, "artifact provenance is not authenticated")
        subject = evidence.get("subject")
        source = evidence.get("source")
        signer = evidence.get("signer")
        run = evidence.get("run")
        build = evidence.get("build")
        authorization = evidence.get("authorization")
        require(isinstance(subject, dict) and isinstance(source, dict) and isinstance(signer, dict) and isinstance(run, dict) and isinstance(build, dict), "production eligibility evidence is incomplete")
        require(subject.get("artifactClass") == PRODUCTION_ARTIFACT_CLASS, "development artifact is not production eligible")
        require(source.get("repository") == expected["repository"], "production source repository mismatch")
        require(str(source.get("repositoryId")) == str(expected["repository_id"]), "production source repository ID mismatch")
        require(source.get("ref") == "refs/heads/main", "production source ref is not exact main")
        require(source.get("event") == "push", "production event is not an authorized main push")
        require(require_sha(source.get("gitSha"), "source.gitSha") == require_sha(expected["approved_release_sha"], "expected.approved_release_sha"), "production source SHA is not the approved release SHA")
        require(signer.get("workflow") == expected["signer_workflow"], "production signer workflow mismatch")
        require(require_sha(signer.get("revision"), "signer.revision") == require_sha(expected["signer_revision"], "expected.signer_revision"), "production signer revision mismatch")
        require(require_int(run.get("id"), "run.id", 1) == require_int(expected["run_id"], "expected.run_id", 1) and require_int(run.get("attempt"), "run.attempt", 1) == require_int(expected["run_attempt"], "expected.run_attempt", 1), "production run or attempt mismatch")
        require(require_digest(subject.get("sha256"), "subject.sha256") == require_digest(expected["archive_sha256"], "expected.archive_sha256"), "production artifact digest mismatch")
        require(require_int(subject.get("bytes"), "subject.bytes", 1) == require_int(expected["archive_bytes"], "expected.archive_bytes", 1), "production artifact size mismatch")
        require(build.get("platform") == expected["platform"] and build.get("imageDigest") == expected["image_digest"], "production platform or image contract mismatch")
        require(isinstance(authorization, dict), "production release authorization is missing")
        require(authorization.get("authorized") is True and authorization.get("context") == expected["authorization_context"], "production release authorization is missing or stale")
    except ProvenanceError as error:
        return False, str(error)
    return True, "eligible evidence only; deployment authorization remains separate"


def parse_args() -> argparse.Namespace:
    """Parse the synthetic policy-fixture command-line interface."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluate-production", action="store_true")
    parser.add_argument("--evidence")
    parser.add_argument("--expected", required=False)
    return parser.parse_args()


def main() -> int:
    """Evaluate a future production-policy fixture and fail closed on rejection."""
    args = parse_args()
    if not args.evaluate_production or not args.evidence or not args.expected:
        raise SystemExit("--evaluate-production, --evidence and --expected are required")
    evidence = json.loads(Path(args.evidence).read_text(encoding="utf-8"))
    expected = json.loads(Path(args.expected).read_text(encoding="utf-8"))
    eligible, reason = evaluate_production_eligibility(evidence, expected)
    print(json.dumps({"eligible": eligible, "reason": reason}, indent=2))
    return 0 if eligible else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, ProvenanceError) as error:
        print(f"[runtime-artifact-provenance] failed: {error}")
        raise SystemExit(1)
