#!/usr/bin/env python3
"""Authenticated runtime-artifact provenance and release eligibility contracts."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
import queue
import re
import stat
import subprocess
import threading
import time
from pathlib import Path
from typing import Any


PROVENANCE_CONTRACT_VERSION = 1
PROVENANCE_CONTRACT = "clashcookies.runtime-artifact-provenance"
SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1"
ACTIONS_WORKFLOW_BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1"
GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
GITHUB_HOSTED_RUNNER = "github-hosted"
PRODUCTION_ARTIFACT_CLASS = "production-runtime-release"
DEVELOPMENT_ARTIFACT_CLASS = "development-runtime-evidence"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_VERIFIER_OUTPUT_BYTES = 4 * 1024 * 1024
SUPPORTED_GH_VERSION = "2.89.0"


class ProvenanceError(RuntimeError):
    """Raised when authenticated provenance or release eligibility is invalid."""


@dataclass(frozen=True)
class VerificationReceipt:
    """Non-serializable evidence that the official verifier authenticated a subject."""

    tool: str
    version: str
    subject_digest: str
    certificate_verified: bool
    certificate_identity: str
    run_invocation_uri: str


@dataclass(frozen=True)
class AuthenticatedProvenance:
    """Typed in-process provenance; serialized output is diagnostic only."""

    archive_name: str
    archive_sha256: str
    archive_bytes: int
    artifact_class: str
    repository: str
    repository_id: str
    source_ref: str
    source_sha: str
    event: str
    signer_workflow: str
    signer_revision: str
    run_id: int
    run_attempt: int
    platform: str
    image: str
    image_digest: str
    pull_request: dict[str, Any] | None
    receipt: VerificationReceipt

    def diagnostic_json(self) -> dict[str, Any]:
        """Return explicitly non-authoritative diagnostic output."""
        return {
            "contract": PROVENANCE_CONTRACT,
            "contractVersion": PROVENANCE_CONTRACT_VERSION,
            "status": "verified-provenance-only",
            "authenticated": True,
            "acceptance": {"contentValidated": False, "extractedAndPublished": False},
            "subject": {"name": self.archive_name, "sha256": self.archive_sha256, "bytes": self.archive_bytes, "artifactClass": self.artifact_class},
            "source": {"repository": self.repository, "repositoryId": self.repository_id, "ref": self.source_ref, "gitSha": self.source_sha, "testMergeSha": self.source_sha, "event": self.event, "pullRequest": self.pull_request},
            "signer": {"workflow": self.signer_workflow, "revision": self.signer_revision, "certificateIdentity": self.receipt.certificate_identity, "runner": GITHUB_HOSTED_RUNNER},
            "run": {"id": self.run_id, "attempt": self.run_attempt},
            "build": {"platform": self.platform, "image": self.image, "imageDigest": self.image_digest},
            "verification": {"tool": self.receipt.tool, "version": self.receipt.version, "predicateType": SLSA_PROVENANCE_V1, "subjectDigestAuthenticated": True, "certificateClaimsAuthenticated": self.receipt.certificate_verified, "predicateClaimsWorkflowControlled": True, "runMetadataIndependentlyChecked": True},
        }


@dataclass(frozen=True)
class TrustedReleaseIdentity:
    """Non-serializable expected identity supplied by a future release authority."""

    repository: str
    repository_id: str
    signer_workflow: str
    signer_revision: str
    run_id: int
    run_attempt: int
    approved_release_sha: str
    archive_sha256: str
    archive_bytes: int
    platform: str
    image_digest: str
    authorization_context: str


@dataclass(frozen=True)
class IndependentReleaseAuthorization:
    """Independent, non-artifact authorization input reserved for a future producer."""

    context: str
    approved_release_sha: str
    source: str = "independent-release-authority"


@dataclass(frozen=True)
class EligibilityResult:
    """Structured policy result that distinguishes refusal from operational failure."""

    eligible: bool
    reason_code: str
    authoritative: bool
    detail: str

    def diagnostic_json(self) -> dict[str, Any]:
        """Return policy diagnostics without making them an authorization token."""
        return {"eligible": self.eligible, "reasonCode": self.reason_code, "authoritative": self.authoritative, "detail": self.detail}


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


def _gh_executable() -> str:
    """Return the workflow-pinned executable when validation supplies one."""
    executable = os.environ.get("GH_ATTESTATION_CLI", "gh")
    require(isinstance(executable, str) and executable != "", "official GitHub CLI executable is missing")
    return executable


def run_bounded(command: list[str], *, timeout_seconds: int, max_output_bytes: int, label: str) -> subprocess.CompletedProcess[str]:
    """Run a command with bounded reader queues, output buffers, and a deadline."""
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        raise
    assert process.stdout is not None and process.stderr is not None
    streams = (process.stdout, process.stderr)
    queues = (queue.Queue(maxsize=1), queue.Queue(maxsize=1))
    cancelled = threading.Event()

    def drain(stream: Any, output_queue: queue.Queue[bytes | None]) -> None:
        try:
            while not cancelled.is_set():
                chunk = stream.read(min(65536, max_output_bytes + 1))
                if not chunk:
                    break
                while not cancelled.is_set():
                    try:
                        output_queue.put(chunk, timeout=0.05)
                        break
                    except queue.Full:
                        continue
        finally:
            while not cancelled.is_set():
                try:
                    output_queue.put(None, timeout=0.05)
                    break
                except queue.Full:
                    continue

    readers = [threading.Thread(name=f"runtime-artifact-reader-{index}", target=drain, args=(stream, output_queue), daemon=True) for index, (stream, output_queue) in enumerate(zip(streams, queues))]
    for reader in readers:
        reader.start()
    buffers = [bytearray(), bytearray()]
    finished = [False, False]
    deadline = time.monotonic() + timeout_seconds

    def stop_process() -> None:
        cancelled.set()
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

    try:
        while True:
            if time.monotonic() > deadline:
                stop_process()
                raise subprocess.TimeoutExpired(command, timeout_seconds)
            progress = False
            for index, output_queue in enumerate(queues):
                while True:
                    try:
                        item = output_queue.get_nowait()
                    except queue.Empty:
                        break
                    progress = True
                    if item is None:
                        finished[index] = True
                        break
                    buffers[index].extend(item)
                    if len(buffers[index]) > max_output_bytes:
                        stop_process()
                        raise ProvenanceError(f"{label} output exceeds the limit during execution")
            if all(finished):
                remaining = max(0.0, deadline - time.monotonic())
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    stop_process()
                    raise
                break
            if not progress:
                time.sleep(0.005)
        return subprocess.CompletedProcess(command, process.returncode, bytes(buffers[0]).decode("utf-8", "replace"), bytes(buffers[1]).decode("utf-8", "replace"))
    finally:
        if process.poll() is None:
            stop_process()
        cancelled.set()
        for stream in streams:
            try:
                stream.close()
            except OSError:
                pass
        for reader in readers:
            reader.join(timeout=2)


def verify_gh_version(expected_version: str = SUPPORTED_GH_VERSION, timeout_seconds: int = 10) -> str:
    """Require the recorded official GitHub CLI version before accepting evidence."""
    try:
        result = run_bounded([_gh_executable(), "version"], timeout_seconds=timeout_seconds, max_output_bytes=4096, label="official GitHub CLI version")
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"official GitHub CLI version check unavailable or timed out: {error}")
    require(result.returncode == 0, "official GitHub CLI version check failed")
    require(len(result.stdout) <= 4096 and len(result.stderr) <= 4096, "official GitHub CLI version output exceeds the limit")
    match = re.search(r"gh version (\d+\.\d+\.\d+)", result.stdout)
    require(match is not None and match.group(1) == expected_version, f"unsupported GitHub CLI version; expected {expected_version}")
    return match.group(1)


def require_regular_bounded(path: Path, maximum: int, label: str) -> None:
    """Reject missing, symlinked, non-regular, or oversized verifier inputs."""
    try:
        metadata = os.lstat(path)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    require(not stat.S_ISLNK(metadata.st_mode) and stat.S_ISREG(metadata.st_mode), f"{label} must be a regular non-symlink file")
    require(metadata.st_size <= maximum, f"{label} exceeds the size limit")


def run_gh_attestation_verify(
    archive: Path,
    *,
    bundle: Path | None,
    repository: str,
    signer_workflow: str,
    signer_revision: str,
    source_ref: str,
    source_sha: str,
    verifier_version: str = SUPPORTED_GH_VERSION,
    timeout_seconds: int = 90,
) -> dict[str, Any]:
    """Run the official GitHub CLI verifier against the immutable archive snapshot."""
    require_regular_bounded(archive, MAX_ARCHIVE_BYTES, "immutable archive snapshot")
    if bundle is not None:
        require_regular_bounded(bundle, MAX_BUNDLE_BYTES, "attestation bundle")
    verified_version = verify_gh_version(verifier_version)
    cli_signer_workflow = signer_workflow if "/" in signer_workflow.split(".github/", 1)[0] else f"{repository}/{signer_workflow}"
    command = [
        _gh_executable(),
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
        result = run_bounded(command, timeout_seconds=timeout_seconds, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="official GitHub attestation verifier")
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"official GitHub attestation verifier unavailable or timed out: {error}")
    require(len(result.stdout) <= MAX_VERIFIER_OUTPUT_BYTES and len(result.stderr) <= MAX_VERIFIER_OUTPUT_BYTES, "official GitHub attestation verifier output exceeds the limit")
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
    document[0]["_verifierVersion"] = verified_version
    return document[0]


def fetch_run_metadata(repository: str, run_id: int, timeout_seconds: int = 30) -> dict[str, Any]:
    """Read authenticated GitHub Actions run metadata for independent correlation."""
    try:
        result = run_bounded([_gh_executable(), "api", f"repos/{repository}/actions/runs/{run_id}"], timeout_seconds=timeout_seconds, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="authenticated GitHub Actions run metadata")
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"authenticated GitHub Actions run metadata unavailable or timed out: {error}")
    require(len(result.stdout) <= MAX_VERIFIER_OUTPUT_BYTES and len(result.stderr) <= MAX_VERIFIER_OUTPUT_BYTES, "authenticated GitHub Actions run metadata output exceeds the limit")
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "no API detail"
        fail(f"authenticated GitHub Actions run metadata request failed: {detail[:400]}")
    try:
        metadata = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        fail(f"authenticated GitHub Actions run metadata is malformed: {error}")
    require(isinstance(metadata, dict), "authenticated GitHub Actions run metadata must be an object")
    return metadata


def validate_run_metadata(metadata: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any] | None:
    """Validate PR head/base or dev-push run semantics without confusing them with GITHUB_SHA."""
    require(metadata.get("id") in (expected["run_id"], str(expected["run_id"])), "GitHub run metadata ID mismatch")
    require(metadata.get("event") == expected["event"], "GitHub run metadata event mismatch")
    require(metadata.get("run_attempt") in (expected["run_attempt"], str(expected["run_attempt"])), "GitHub run metadata attempt mismatch")
    require(metadata.get("path") == expected["signer_workflow"], "GitHub run metadata workflow path mismatch")
    repository_data = metadata.get("repository")
    require(isinstance(repository_data, dict), "GitHub run metadata repository evidence is missing")
    require(repository_data.get("full_name") == expected["repository"], "GitHub run metadata repository mismatch")
    require(str(repository_data.get("id")) == str(expected["repository_id"]), "GitHub run metadata repository ID mismatch")
    owner_data = repository_data.get("owner")
    if expected.get("repository_owner_id") is not None:
        require(isinstance(owner_data, dict) and str(owner_data.get("id")) == str(expected["repository_owner_id"]), "GitHub run metadata repository owner ID mismatch")
    if expected["event"] == "pull_request":
        require(metadata.get("head_sha") == expected["pr_head_sha"], "GitHub run metadata PR head SHA mismatch")
        require(metadata.get("head_branch") == expected["pr_head_ref"], "GitHub run metadata PR head ref mismatch")
        pull_requests = metadata.get("pull_requests")
        require(isinstance(pull_requests, list) and len(pull_requests) == 1, "GitHub run metadata PR association is missing or ambiguous")
        pull_request = pull_requests[0]
        require(isinstance(pull_request, dict) and pull_request.get("number") == expected["pr_number"], "GitHub run metadata PR number mismatch")
        head = pull_request.get("head")
        base = pull_request.get("base")
        require(isinstance(head, dict) and isinstance(base, dict), "GitHub run metadata PR head/base evidence is incomplete")
        require(head.get("sha") == expected["pr_head_sha"] and head.get("ref") == expected["pr_head_ref"], "GitHub run metadata PR head association mismatch")
        require(base.get("sha") == expected["pr_base_sha"] and base.get("ref") == expected["pr_base_ref"], "GitHub run metadata PR base association mismatch")
        return {"number": expected["pr_number"], "headSha": expected["pr_head_sha"], "headRef": expected["pr_head_ref"], "baseSha": expected["pr_base_sha"], "baseRef": expected["pr_base_ref"]}
    require(metadata.get("head_sha") == expected["source_sha"], "GitHub run metadata dev-push SHA mismatch")
    expected_branch = expected["source_ref"].removeprefix("refs/heads/")
    require(metadata.get("head_branch") == expected_branch, "GitHub run metadata dev-push ref mismatch")
    return None


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
) -> AuthenticatedProvenance:
    """Validate verified certificate claims and bind them to one artifact contract."""
    verification = result.get("verificationResult")
    require(isinstance(verification, dict), "attestation verification result is missing")
    require(verification.get("mediaType") == "application/vnd.dev.sigstore.verificationresult+json;version=0.1", "unsupported official verifier result media type")
    statement = verification.get("statement")
    require(isinstance(statement, dict), "attestation statement is missing")
    require(statement.get("_type") == "https://in-toto.io/Statement/v1", "unsupported attestation statement type")
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
    owner, _ = repository.split("/", 1)
    repository_uri = f"https://github.com/{repository}"
    owner_uri = f"https://github.com/{owner}"
    workflow_uri = f"{repository_uri}/{expected['signer_workflow']}"
    expected_run_id = require_int(expected["run_id"], "expected.run_id", 1)
    expected_attempt = require_int(expected["run_attempt"], "expected.run_attempt", 1)
    run_uri = f"{repository_uri}/actions/runs/{expected_run_id}/attempts/{expected_attempt}"
    expected_certificate_fields = {
        "certificateIssuer": "CN=sigstore-intermediate,O=sigstore.dev",
        "sourceRepositoryURI": repository_uri,
        "sourceRepositoryIdentifier": str(expected["repository_id"]),
        "sourceRepositoryOwnerIdentifier": str(expected["repository_owner_id"]),
        "sourceRepositoryOwnerURI": owner_uri,
        "sourceRepositoryRef": expected["source_ref"],
        "sourceRepositoryDigest": expected["source_sha"],
        "githubWorkflowTrigger": expected["event"],
        "githubWorkflowSHA": expected["signer_revision"],
        "githubWorkflowName": expected["workflow_name"],
        "githubWorkflowRepository": repository,
        "githubWorkflowRef": expected["source_ref"],
        "buildTrigger": expected["event"],
        "buildSignerURI": f"{workflow_uri}@{expected['source_ref']}",
        "buildSignerDigest": expected["signer_revision"],
        "buildConfigURI": f"{workflow_uri}@{expected['source_ref']}",
        "buildConfigDigest": expected["signer_revision"],
        "runInvocationURI": run_uri,
        "runnerEnvironment": GITHUB_HOSTED_RUNNER,
        "issuer": GITHUB_OIDC_ISSUER,
        "sourceRepositoryVisibilityAtSigning": expected["repository_visibility"],
    }
    for field, value in expected_certificate_fields.items():
        require(certificate.get(field) == value, f"attestation certificate {field} mismatch or missing")
    san = require_string(certificate.get("subjectAlternativeName"), "certificate.subjectAlternativeName")
    require(san == f"{workflow_uri}@{expected['source_ref']}", "attestation certificate signer workflow identity mismatch")

    predicate = statement.get("predicate")
    require(isinstance(predicate, dict), "attestation predicate is missing")
    build_definition = predicate.get("buildDefinition")
    require(isinstance(build_definition, dict), "attestation buildDefinition is missing")
    require(build_definition.get("buildType") == ACTIONS_WORKFLOW_BUILD_TYPE, "attestation build type mismatch")
    external = build_definition.get("externalParameters")
    require(isinstance(external, dict), "attestation externalParameters is missing")
    workflow = external.get("workflow")
    require(isinstance(workflow, dict), "attestation workflow parameters are missing")
    require(workflow.get("path") == expected["signer_workflow"] and workflow.get("ref") == expected["source_ref"] and workflow.get("repository") == repository_uri, "attestation workflow parameters mismatch")
    internal = build_definition.get("internalParameters")
    require(isinstance(internal, dict), "attestation internalParameters are missing")
    github_internal = internal.get("github")
    require(isinstance(github_internal, dict), "attestation GitHub internal parameters are missing")
    require(github_internal.get("event_name") == expected["event"], "attestation internal event mismatch")
    require(str(github_internal.get("repository_id")) == str(expected["repository_id"]), "attestation internal repository ID mismatch")
    require(str(github_internal.get("repository_owner_id")) == str(expected["repository_owner_id"]), "attestation internal repository owner ID mismatch")
    require(github_internal.get("runner_environment") == GITHUB_HOSTED_RUNNER, "attestation internal runner mismatch")
    dependencies = build_definition.get("resolvedDependencies")
    require(isinstance(dependencies, list) and len(dependencies) == 1, "attestation resolved dependency is missing or ambiguous")
    dependency = dependencies[0]
    require(isinstance(dependency, dict) and dependency.get("uri") == f"git+{repository_uri}@{expected['source_ref']}", "attestation source dependency URI mismatch")
    dependency_digest = dependency.get("digest")
    require(isinstance(dependency_digest, dict) and dependency_digest.get("gitCommit") == expected["source_sha"], "attestation source dependency SHA mismatch")
    run_details = predicate.get("runDetails")
    require(isinstance(run_details, dict), "attestation runDetails are missing")
    builder = run_details.get("builder")
    require(isinstance(builder, dict) and builder.get("id") == f"{workflow_uri}@{expected['source_ref']}", "attestation builder identity mismatch")
    metadata = run_details.get("metadata")
    require(isinstance(metadata, dict) and metadata.get("invocationId") == run_uri, "attestation predicate run invocation mismatch")
    require(isinstance(verification.get("verifiedTimestamps"), list) and verification["verifiedTimestamps"], "attestation has no verified timestamp evidence")

    pull_request = validate_run_metadata(run_metadata, expected) if run_metadata is not None else None
    require(run_metadata is not None, "authenticated GitHub Actions run metadata is required")
    return AuthenticatedProvenance(
        archive_name=archive_name,
        archive_sha256=archive_digest,
        archive_bytes=archive_bytes,
        artifact_class=expected["artifact_class"],
        repository=repository,
        repository_id=str(expected["repository_id"]),
        source_ref=expected["source_ref"],
        source_sha=expected["source_sha"],
        event=expected["event"],
        signer_workflow=expected["signer_workflow"],
        signer_revision=expected["signer_revision"],
        run_id=expected_run_id,
        run_attempt=expected_attempt,
        platform=expected["platform"],
        image=expected["image"],
        image_digest=expected["image_digest"],
        pull_request=pull_request,
        receipt=VerificationReceipt("gh attestation verify", result.get("_verifierVersion", SUPPORTED_GH_VERSION), archive_digest, True, san, run_uri),
    )


def evaluate_production_eligibility(
    provenance: object,
    expected: object,
    authorization: object | None,
) -> EligibilityResult:
    """Evaluate future production eligibility from typed, independently supplied inputs only."""
    if not isinstance(provenance, AuthenticatedProvenance):
        return EligibilityResult(False, "unverifiable-provenance", False, "serialized or unverified provenance cannot authorize production")
    if provenance.artifact_class != PRODUCTION_ARTIFACT_CLASS:
        return EligibilityResult(False, "development-artifact-class", False, "development artifact is not production eligible")
    if not isinstance(expected, TrustedReleaseIdentity):
        return EligibilityResult(False, "missing-trusted-release-identity", False, "trusted expected release identity is not available")
    if not isinstance(authorization, IndependentReleaseAuthorization):
        return EligibilityResult(False, "missing-independent-authorization", False, "independent release authorization is required")
    return EligibilityResult(False, "production-producer-unavailable", False, "no authorized production provenance producer exists in this slice")


def evaluate_synthetic_production_policy_fixture(fixture: dict[str, Any]) -> EligibilityResult:
    """Evaluate an explicitly synthetic policy fixture without making it authoritative."""
    if fixture.get("fixtureKind") != "synthetic-production-policy" or fixture.get("synthetic") is not True:
        return EligibilityResult(False, "invalid-synthetic-fixture", False, "production fixtures must be explicitly synthetic")
    return EligibilityResult(True, "synthetic-policy-fixture", False, "synthetic policy result is non-authoritative and cannot authorize production")


def parse_args() -> argparse.Namespace:
    """Parse the synthetic policy-fixture command-line interface."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluate-synthetic-policy", action="store_true")
    parser.add_argument("--fixture")
    return parser.parse_args()


def main() -> int:
    """Evaluate only an explicitly synthetic policy fixture for diagnostics."""
    args = parse_args()
    if not args.evaluate_synthetic_policy or not args.fixture:
        raise SystemExit("--evaluate-synthetic-policy and --fixture are required")
    fixture = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
    result = evaluate_synthetic_production_policy_fixture(fixture)
    print(json.dumps(result.diagnostic_json(), indent=2))
    return 0 if result.eligible and not result.authoritative else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError, ProvenanceError) as error:
        print(f"[runtime-artifact-provenance] failed: {error}")
        raise SystemExit(1)
