#!/usr/bin/env python3
"""Authenticated runtime-artifact provenance and release eligibility contracts."""

from __future__ import annotations

import argparse
import base64
import binascii
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
import posixpath
import queue
import re
import stat
import struct
import subprocess
import threading
import time
import tempfile
import shutil
import signal
import sys
import uuid
from zipfile import BadZipFile, ZipFile
from pathlib import Path
from typing import Any

if os.name == "posix":
    import fcntl
else:
    import msvcrt


PROVENANCE_CONTRACT_VERSION = 1
PROVENANCE_CONTRACT = "clashcookies.runtime-artifact-provenance"
AUTHORIZATION_CONTRACT_VERSION = 1
AUTHORIZATION_CONTRACT = "clashcookies.release-authorization"
AUTHORIZATION_SIGNATURE_ALGORITHM = "ed25519"
AUTHORIZATION_VERIFIER = "openssl-pkeyutl"
AUTHORIZATION_FORWARD_VALIDITY_SECONDS = 24 * 60 * 60
MAX_AUTHORIZATION_RECORD_BYTES = 256 * 1024
MAX_AUTHORIZATION_PUBLIC_KEY_BYTES = 64 * 1024
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
MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
MAX_VERIFIER_OUTPUT_BYTES = 4 * 1024 * 1024
SUPPORTED_GH_VERSION = "2.89.0"
# GitHub's run-attempt API can report created_at one second after run_started_at.
# This tolerance applies only to that field ordering; all other chronology and
# exact-attempt window checks remain strict.
MAX_RUN_CREATION_START_INVERSION_SECONDS = 1
RELEASE_REPOSITORY = "tonykslee/ClashCookies"
RELEASE_REPOSITORY_ID = 668452496
RELEASE_REPOSITORY_OWNER_ID = 18295450
RELEASE_SOURCE_REF = "refs/heads/main"
RELEASE_EVENT = "push"
RELEASE_SIGNER_WORKFLOW = ".github/workflows/runtime-artifact.yml"
RELEASE_PRODUCER_WORKFLOW = ".github/workflows/runtime-artifact.yml"
RELEASE_PLATFORM = "linux/amd64"
RELEASE_IMAGE = "node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5"
PRODUCTION_CANDIDATE_ARTIFACT_CLASS = "production-candidate-runtime-evidence-v1"
PRODUCTION_CANDIDATE_PROFILE = "production-candidate-main-push-v1"
CANDIDATE_EVIDENCE_CONTRACT = "clashcookies.production-candidate-evidence"
CANDIDATE_EVIDENCE_VERSION = 1
CANDIDATE_EVIDENCE_AUTHORIZATION_CONTEXT = "production-candidate-selection-only"
PRODUCTION_CANDIDATE_AUTHORIZATION_CONTEXT = CANDIDATE_EVIDENCE_AUTHORIZATION_CONTEXT
OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT = "owner-approved-production-candidate-delivery-v1"
ARTIFACT_NAME_TEMPLATE = "runtime-artifact-{run_id}-{run_attempt}"
ATTESTATION_ARTIFACT_NAME_TEMPLATE = "runtime-artifact-attestation-{run_id}-{run_attempt}"
MAX_ARTIFACT_ENTRIES = 64
MAX_INNER_ARCHIVE_BYTES = MAX_ARCHIVE_BYTES
MAX_ARTIFACT_JSON_BYTES = 4 * 1024 * 1024
MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 1024 * 1024
MAX_ZIP_ENTRY_NAME_BYTES = 4096
MAX_ZIP_EXTRA_BYTES = 4096
MAX_ZIP_COMMENT_BYTES = 4096
MAX_ZIP_EXPANDED_BYTES = MAX_ARTIFACT_BYTES
ZIP_EOCD_BYTES = 22
ZIP_EOCD_SEARCH_BYTES = 65557
MAX_ACTIONS_JOBS = 256
MAX_ACTIONS_JOB_PAGES = 16
CANDIDATE_VERIFICATION_CONTEXT_CONTRACT = "clashcookies.independent-candidate-verification"
CANDIDATE_VERIFICATION_CONTEXT_VERSION = 1
CANDIDATE_REQUIRED_JOBS = {
    "Build SHA-bound runtime artifact": {
        "Build runtime artifact in pinned Linux environment",
        "Publish development validation artifact",
    },
    "Generate authenticated runtime artifact attestation": {
        "Download built artifact into the signer job",
        "Generate GitHub-native provenance attestation",
        "Publish attestation bundle for independent verification",
    },
    "Retrieve and validate runtime artifact": {
        "Download published artifact into a fresh job",
        "Download authenticated attestation bundle into a fresh job",
        "Select exact artifact-service ZIP and inner archive",
        "Exercise real API and ZIP negative mutations",
        "Validate retrieved bytes and safely extract",
        "Produce non-authoritative production-candidate evidence",
        "Publish non-authoritative production-candidate evidence",
        "Run candidate authorization and custody fixture regressions",
        "Exercise extracted runtime without install, compile, or Prisma regeneration",
    },
}


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
class AuthorizationVerificationReceipt:
    """Evidence from a future independent authorization-record verifier.

    This type is deliberately not emitted by the current workflow. A caller
    cannot turn a serialized record or a boolean into production authority.
    The production policy remains unavailable until an approved verifier and
    durable replay store are integrated.
    """

    verifier: str
    record_sha256: str
    verified_at: str
    key_reference: str
    algorithm: str = AUTHORIZATION_SIGNATURE_ALGORITHM
    key_fingerprint: str = ""


@dataclass(frozen=True)
class AuthorizationTrustConfig:
    """Owner-supplied trust root metadata; no production defaults are permitted."""

    public_key_path: Path
    expected_key_id: str
    expected_public_key_sha256: str
    repository_root: Path


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
    run_metadata_independently_checked: bool = True

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
            "verification": {"tool": self.receipt.tool, "version": self.receipt.version, "predicateType": SLSA_PROVENANCE_V1, "subjectDigestAuthenticated": True, "certificateClaimsAuthenticated": self.receipt.certificate_verified, "predicateClaimsWorkflowControlled": True, "runMetadataIndependentlyChecked": self.run_metadata_independently_checked},
        }


@dataclass(frozen=True)
class TrustedReleaseIdentity:
    """Complete immutable identity supplied by an independent release authority."""

    repository: str
    repository_id: int
    repository_owner_id: int
    source_ref: str
    source_sha: str
    event: str
    producer_workflow: str
    producer_revision: str
    signer_workflow: str
    signer_revision: str
    run_id: int
    run_attempt: int
    artifact_id: int
    artifact_name: str
    artifact_class: str
    artifact_service_zip_sha256: str
    artifact_service_zip_bytes: int
    archive_name: str
    archive_sha256: str
    archive_bytes: int
    platform: str
    image: str
    image_digest: str
    authorization_context: str


def validate_expectation_identity_binding(identity: Any, expectation: dict[str, Any]) -> None:
    """Bind delivery/retention expectation fields to one immutable identity."""
    require(isinstance(expectation, dict), "provenance expectation must be an object")
    required = (
        "repository", "repository_id", "repository_owner_id", "source_ref", "source_sha", "event",
        "producer_workflow", "producer_revision", "signer_workflow", "signer_revision", "run_id", "run_attempt",
        "artifact_class", "platform", "image", "image_digest",
    )
    optional = (
        "archive_name", "archive_sha256", "archive_bytes", "artifact_service_zip_sha256", "artifact_service_zip_bytes",
        "artifact_id", "artifact_name", "authorization_context",
    )
    for field in required:
        require(field in expectation, f"provenance expectation omits delivery identity field {field}")
        require(str(expectation[field]) == str(getattr(identity, field, object())), f"provenance expectation {field} does not match the delivery identity")
    for field in optional:
        if field in expectation:
            require(str(expectation[field]) == str(getattr(identity, field, object())), f"provenance expectation {field} does not match the delivery identity")


@dataclass(frozen=True)
class IndependentReleaseAuthorization:
    """Externally verified authorization record reserved for a future producer."""

    authorization_id: str
    context: str
    scope: str
    repository: str
    repository_id: int
    repository_owner_id: int
    source_ref: str
    source_sha: str
    event: str
    producer_workflow: str
    producer_revision: str
    signer_workflow: str
    signer_revision: str
    run_id: int
    run_attempt: int
    artifact_id: int
    artifact_name: str
    artifact_class: str
    artifact_service_zip_sha256: str
    artifact_service_zip_bytes: int
    archive_name: str
    archive_sha256: str
    archive_bytes: int
    platform: str
    image: str
    image_digest: str
    issued_at: str
    expires_at: str
    retry_key: str
    recovery_context: str | None
    signing_key_id: str
    verification: AuthorizationVerificationReceipt
    verification_context_sha256: str | None = None
    delivery_destination: str | None = None


@dataclass(frozen=True)
class AuthorizationRevisionAllowlist:
    """Explicit immutable producer and signer revisions supplied by an owner."""

    producer_workflow: str
    producer_revisions: tuple[str, ...]
    signer_workflow: str
    signer_revisions: tuple[str, ...]


@dataclass(frozen=True)
class ExactArtifactSelection:
    """The two distinct identities selected from GitHub's artifact service."""

    artifact_id: int
    artifact_name: str
    artifact_service_zip_sha256: str
    artifact_service_zip_bytes: int
    archive_name: str
    archive_sha256: str | None
    archive_bytes: int | None
    byte_verified: bool


@dataclass(frozen=True)
class ArtifactSelectionRequest:
    """Non-authoritative request used to drive exact API selection in CI."""

    repository: str
    repository_id: int
    repository_owner_id: int
    source_ref: str
    source_sha: str
    event: str
    signer_workflow: str
    signer_revision: str
    run_id: int
    run_attempt: int
    artifact_name: str
    artifact_class: str
    archive_name: str
    platform: str
    image: str
    image_digest: str
    authorization_context: str
    run_head_repository: str
    run_head_repository_id: int
    run_head_repository_owner_id: int
    run_head_ref: str
    run_head_sha: str
    pull_request_number: int | None
    pull_request_head_sha: str | None
    pull_request_head_ref: str | None
    pull_request_base_sha: str | None
    pull_request_base_ref: str | None
    producer_revision: str | None = None


@dataclass
class ZipSnapshot:
    """Private descriptor-backed ZIP snapshot used by both hash and parser."""

    fd: int
    path: Path
    size: int
    sha256: str


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


def _parse_timestamp(value: Any, path: str) -> datetime:
    """Parse an API timestamp as an aware UTC instant."""
    text = require_string(value, path)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        fail(f"provenance field {path} must be an RFC3339 timestamp: {error}")
    require(parsed.tzinfo is not None, f"provenance field {path} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def expected_artifact_name(run_id: int, run_attempt: int) -> str:
    """Return the versioned exact artifact name; never choose latest-by-name."""
    require_int(run_id, "run_id", 1)
    require_int(run_attempt, "run_attempt", 1)
    return ARTIFACT_NAME_TEMPLATE.format(run_id=run_id, run_attempt=run_attempt)


def validate_trusted_release_identity(identity: TrustedReleaseIdentity) -> None:
    """Validate every immutable field of a future production release identity."""
    require(isinstance(identity, TrustedReleaseIdentity), "trusted release identity has an unsupported type")
    require(identity.repository == RELEASE_REPOSITORY, "release repository is not the approved repository")
    require(identity.repository_id == RELEASE_REPOSITORY_ID, "release repository ID is not the approved stable ID")
    require(identity.repository_owner_id == RELEASE_REPOSITORY_OWNER_ID, "release owner ID is not the approved stable ID")
    require(identity.source_ref == RELEASE_SOURCE_REF, "release source ref must be refs/heads/main")
    require_sha(identity.source_sha, "release.source_sha")
    require(identity.event == RELEASE_EVENT, "release event must be a main push")
    require(identity.producer_workflow == RELEASE_PRODUCER_WORKFLOW, "release producer workflow is not approved")
    require_sha(identity.producer_revision, "release.producer_revision")
    require(identity.signer_workflow == RELEASE_SIGNER_WORKFLOW, "release signer workflow is not approved")
    require_sha(identity.signer_revision, "release.signer_revision")
    require_int(identity.run_id, "release.run_id", 1)
    require_int(identity.run_attempt, "release.run_attempt", 1)
    require_int(identity.artifact_id, "release.artifact_id", 1)
    require(identity.artifact_name == expected_artifact_name(identity.run_id, identity.run_attempt), "release artifact name is not attempt-qualified")
    require(identity.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "release artifact class is not the versioned production-candidate contract")
    require_digest(identity.artifact_service_zip_sha256, "release.artifact_service_zip_sha256")
    _require_bounded_int(identity.artifact_service_zip_bytes, "release.artifact_service_zip_bytes", 1, MAX_ARTIFACT_BYTES)
    _require_canonical_archive_name(identity.archive_name, identity.source_sha, "release.archive_name")
    require_digest(identity.archive_sha256, "release.archive_sha256")
    _require_bounded_int(identity.archive_bytes, "release.archive_bytes", 1, MAX_ARCHIVE_BYTES)
    require(identity.platform == RELEASE_PLATFORM, "release platform is unsupported")
    require(identity.image == RELEASE_IMAGE, "release runtime image is not the approved pinned image")
    require_digest(identity.image_digest, "release.image_digest")
    require(identity.image_digest == RELEASE_IMAGE.split("@", 1)[1], "release image digest is inconsistent with image")
    require_string(identity.authorization_context, "release.authorization_context")


def verify_artifact_selection_against_identity(selection: ExactArtifactSelection, identity: TrustedReleaseIdentity) -> None:
    """Verify discovered, non-authoritative selection against independent identity evidence."""
    validate_trusted_release_identity(identity)
    require(isinstance(selection, ExactArtifactSelection), "artifact selection has an unsupported type")
    require(selection.byte_verified, "artifact selection has not consumed verified ZIP bytes")
    for field in ("artifact_id", "artifact_name", "artifact_service_zip_sha256", "artifact_service_zip_bytes", "archive_name", "archive_sha256", "archive_bytes"):
        require(getattr(selection, field) == getattr(identity, field), f"artifact selection {field} does not match independent release identity")


def _require_bounded_int(value: Any, path: str, minimum: int, maximum: int) -> int:
    """Require an exact integer inside a security-relevant bound."""
    result = require_int(value, path, minimum)
    require(result <= maximum, f"provenance field {path} exceeds the limit")
    return result


def _require_canonical_ref(value: Any, path: str, prefix: str) -> str:
    """Require a canonical Git ref without path ambiguity."""
    ref = require_string(value, path)
    require(ref.startswith(prefix) and ref == ref.replace("\\", "/") and ".." not in ref.split("/"), f"provenance field {path} is not a canonical ref")
    return ref


def _require_canonical_archive_name(value: Any, source_sha: str, path: str = "archive_name") -> str:
    """Require the producer's only supported archive naming contract."""
    name = require_string(value, path)
    require(name == f"clashcookies-runtime-{source_sha}.tar.gz", f"provenance field {path} is not canonical")
    require("/" not in name and "\\" not in name and len(name.encode("utf-8")) <= MAX_ZIP_ENTRY_NAME_BYTES, f"provenance field {path} is unsafe or oversized")
    return name


def validate_selection_request(request: ArtifactSelectionRequest) -> None:
    """Validate the non-authoritative inputs used by the exact selector."""
    require(isinstance(request, ArtifactSelectionRequest), "artifact selection request has an unsupported type")
    require(request.repository == RELEASE_REPOSITORY, "selection repository is not the approved repository")
    require(request.repository_id == RELEASE_REPOSITORY_ID, "selection repository ID is not the approved stable ID")
    require(request.repository_owner_id == RELEASE_REPOSITORY_OWNER_ID, "selection owner ID is not the approved stable ID")
    require(request.event in {"pull_request", "push"}, "selection event is unsupported")
    source_ref = _require_canonical_ref(request.source_ref, "selection.source_ref", "refs/")
    source_sha = require_sha(request.source_sha, "selection.source_sha")
    require(request.signer_workflow == RELEASE_SIGNER_WORKFLOW, "selection signer workflow is not approved")
    require_sha(request.signer_revision, "selection.signer_revision")
    if request.producer_revision is not None:
        require_sha(request.producer_revision, "selection.producer_revision")
    require_int(request.run_id, "selection.run_id", 1)
    require_int(request.run_attempt, "selection.run_attempt", 1)
    require(request.artifact_name == expected_artifact_name(request.run_id, request.run_attempt), "selection artifact name is not attempt-qualified")
    require(request.artifact_class in {DEVELOPMENT_ARTIFACT_CLASS, PRODUCTION_CANDIDATE_ARTIFACT_CLASS}, "selection artifact class is unsupported")
    _require_canonical_archive_name(request.archive_name, source_sha)
    require(request.platform == RELEASE_PLATFORM and request.image == RELEASE_IMAGE, "selection runtime contract is unsupported")
    require_digest(request.image_digest, "selection.image_digest")
    require(request.image_digest == RELEASE_IMAGE.split("@", 1)[1], "selection image digest is inconsistent with image")
    require_string(request.authorization_context, "selection.authorization_context")
    require(request.run_head_repository == request.repository, "selection head repository must be the approved repository")
    require(request.run_head_repository_id == request.repository_id, "selection head repository ID mismatch")
    require(request.run_head_repository_owner_id == request.repository_owner_id, "selection head repository owner ID mismatch")
    _require_canonical_ref(request.run_head_ref, "selection.run_head_ref", "refs/heads/")
    require_sha(request.run_head_sha, "selection.run_head_sha")
    if request.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS:
        require(request.event == RELEASE_EVENT, "production candidate selection event must be push")
        require(source_ref == RELEASE_SOURCE_REF, "production candidate selection must use the exact main ref")
        require(request.run_head_ref == RELEASE_SOURCE_REF, "production candidate selection head ref must be main")
        require(request.authorization_context == CANDIDATE_EVIDENCE_AUTHORIZATION_CONTEXT, "production candidate selection authorization context is invalid")
    elif request.event == RELEASE_EVENT and source_ref == RELEASE_SOURCE_REF:
        require(False, "main push cannot be selected as development evidence")
    if request.event == "push":
        require(source_ref == request.run_head_ref and source_sha == request.run_head_sha, "main/development push source and head identity mismatch")
        for value in (request.pull_request_number, request.pull_request_head_sha, request.pull_request_head_ref, request.pull_request_base_sha, request.pull_request_base_ref):
            require(value is None, "push selection must not carry PR correlation")
    else:
        require(type(request.pull_request_number) is int and request.pull_request_number >= 1, "PR selection number is invalid")
        require(request.source_ref == f"refs/pull/{request.pull_request_number}/merge", "PR selection source ref is not canonical")
        require(request.pull_request_head_sha == request.run_head_sha, "PR head SHA does not match run head SHA")
        require(request.pull_request_head_ref == request.run_head_ref, "PR head ref does not match run head ref")
        require_sha(request.pull_request_head_sha, "selection.pull_request_head_sha")
        _require_canonical_ref(request.pull_request_head_ref, "selection.pull_request_head_ref", "refs/heads/")
        require_sha(request.pull_request_base_sha, "selection.pull_request_base_sha")
        _require_canonical_ref(request.pull_request_base_ref, "selection.pull_request_base_ref", "refs/heads/")


def _read_bounded_json(path: Path, label: str) -> Any:
    """Read a bounded non-symlink JSON input without trusting its path twice."""
    descriptor, expected_size = _open_nofollow_regular(path, MAX_ARTIFACT_JSON_BYTES, label)
    try:
        chunks: list[bytes] = []
        remaining = MAX_ARTIFACT_JSON_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        final_size = os.fstat(descriptor).st_size
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    finally:
        os.close(descriptor)
    require(final_size == expected_size, f"{label} changed during read")
    require(len(data) <= MAX_ARTIFACT_JSON_BYTES, f"{label} exceeds the size limit")
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is malformed: {error}")


def _read_bounded_bytes(path: Path, maximum: int, label: str) -> bytes:
    """Read one bounded private input from a stable non-symlink descriptor."""
    descriptor, expected_size = _open_nofollow_regular(path, maximum, label)
    try:
        payload = bytearray()
        while len(payload) <= maximum:
            chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        final_size = os.fstat(descriptor).st_size
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    finally:
        os.close(descriptor)
    require(final_size == expected_size and len(payload) == expected_size, f"{label} changed during read")
    require(len(payload) <= maximum, f"{label} exceeds the size limit")
    return bytes(payload)


def validate_artifact_api_response(response: Any) -> list[dict[str, Any]]:
    """Validate the complete list-artifacts response shared by API and CLI paths."""
    require(isinstance(response, dict), "artifact API response must be an object")
    total_count = response.get("total_count")
    require(type(total_count) is int and 0 <= total_count <= 100, "artifact API total_count is invalid or unbounded")
    artifacts = response.get("artifacts")
    require(isinstance(artifacts, list) and len(artifacts) == total_count and len(artifacts) <= 100, "artifact API pagination is incomplete or malformed")
    require(all(isinstance(artifact, dict) for artifact in artifacts), "artifact API contains a malformed entry")
    artifact_ids: set[int] = set()
    for artifact in artifacts:
        require(type(artifact.get("id")) is int and artifact["id"] >= 1, "artifact API contains a malformed artifact ID")
        require(artifact["id"] not in artifact_ids, "artifact API contains a duplicate artifact ID")
        artifact_ids.add(artifact["id"])
    return artifacts


def validate_exact_run_attempt_request_metadata(metadata: dict[str, Any], request: ArtifactSelectionRequest, *, now: datetime | None = None) -> None:
    """Correlate the exact attempt response with source, branch, owner, and PR identity."""
    validate_selection_request(request)
    require(isinstance(metadata, dict), "exact run-attempt metadata must be an object")
    require(type(metadata.get("id")) is int and metadata["id"] == request.run_id, "exact run-attempt ID mismatch")
    require(type(metadata.get("run_attempt")) is int and metadata["run_attempt"] == request.run_attempt, "exact run-attempt number mismatch")
    require(metadata.get("event") == request.event, "exact run-attempt event mismatch")
    require(metadata.get("path") == request.signer_workflow, "exact run-attempt workflow path mismatch")
    repository = metadata.get("repository")
    require(isinstance(repository, dict), "exact run-attempt repository evidence is missing")
    require(repository.get("full_name") == request.repository and repository.get("id") == request.repository_id, "exact run-attempt repository mismatch")
    owner = repository.get("owner")
    require(isinstance(owner, dict) and owner.get("id") == request.repository_owner_id, "exact run-attempt owner mismatch")
    head_repository = metadata.get("head_repository")
    require(isinstance(head_repository, dict), "exact run-attempt head repository evidence is missing")
    head_owner = head_repository.get("owner")
    require(head_repository.get("full_name") == request.run_head_repository and head_repository.get("id") == request.run_head_repository_id and isinstance(head_owner, dict) and head_owner.get("id") == request.run_head_repository_owner_id, "exact run-attempt head repository mismatch")
    head_sha = metadata.get("head_sha")
    head_branch = metadata.get("head_branch")
    require(isinstance(head_sha, str) and GIT_SHA_RE.fullmatch(head_sha), "exact run-attempt head SHA is malformed")
    require(isinstance(head_branch, str) and head_branch == request.run_head_ref.removeprefix("refs/heads/"), "exact run-attempt head branch mismatch")
    created = _parse_timestamp(metadata.get("created_at"), "run.created_at")
    started = _parse_timestamp(metadata.get("run_started_at"), "run.run_started_at")
    updated = _parse_timestamp(metadata.get("updated_at"), "run.updated_at")
    current = (now or _now_utc()).astimezone(timezone.utc)
    require(created <= started + timedelta(seconds=MAX_RUN_CREATION_START_INVERSION_SECONDS), "run-attempt creation/start chronology is contradictory")
    require(created <= updated and started <= updated <= current, "run-attempt chronology is contradictory or future-dated")
    if request.event == "push":
        require(head_sha == request.source_sha, "main/development push source SHA mismatch")
        require(request.source_ref == f"refs/heads/{head_branch}", "main/development push source ref mismatch")
        require(metadata.get("pull_requests") in (None, []), "push attempt unexpectedly carries PR correlation")
        return
    pull_requests = metadata.get("pull_requests")
    require(isinstance(pull_requests, list) and len(pull_requests) == 1, "exact PR association is missing or ambiguous")
    pull_request = pull_requests[0]
    require(isinstance(pull_request, dict) and pull_request.get("number") == request.pull_request_number, "exact PR number mismatch")
    pr_head = pull_request.get("head")
    pr_base = pull_request.get("base")
    require(isinstance(pr_head, dict) and isinstance(pr_base, dict), "exact PR head/base evidence is incomplete")
    require(pr_head.get("sha") == request.pull_request_head_sha and pr_head.get("ref") == request.pull_request_head_ref.removeprefix("refs/heads/") and pr_head.get("repo", {}).get("id") == request.run_head_repository_id, "exact PR head correlation mismatch")
    require(pr_base.get("sha") == request.pull_request_base_sha and pr_base.get("ref") == request.pull_request_base_ref.removeprefix("refs/heads/") and pr_base.get("repo", {}).get("id") == request.repository_id, "exact PR base correlation mismatch")
    require(head_sha == request.pull_request_head_sha and head_branch == request.pull_request_head_ref.removeprefix("refs/heads/"), "exact PR run head mismatch")
    require(request.source_sha != request.pull_request_head_sha, "PR test-merge SHA was confused with PR head SHA")


def validate_authorization_revision_allowlist(allowlist: AuthorizationRevisionAllowlist) -> None:
    """Validate an owner-supplied immutable producer/signer revision allowlist."""
    require(isinstance(allowlist, AuthorizationRevisionAllowlist), "authorization revision allowlist has an unsupported type")
    require(allowlist.producer_workflow == RELEASE_PRODUCER_WORKFLOW, "authorization producer workflow is not approved")
    require(allowlist.signer_workflow == RELEASE_SIGNER_WORKFLOW, "authorization signer workflow is not approved")
    for path, revisions in (("producer_revisions", allowlist.producer_revisions), ("signer_revisions", allowlist.signer_revisions)):
        require(isinstance(revisions, tuple) and len(revisions) > 0, f"authorization {path} must be an explicit non-empty tuple")
        require(len(set(revisions)) == len(revisions), f"authorization {path} must not contain duplicates")
        for revision in revisions:
            require_sha(revision, f"authorization.{path}")


def authorization_revision_allowlist_from_json(value: Any) -> AuthorizationRevisionAllowlist:
    """Parse the exact owner-supplied immutable revision policy shape."""
    require(isinstance(value, dict) and set(value) == {"producer_workflow", "producer_revisions", "signer_workflow", "signer_revisions"}, "authorization revision allowlist is malformed")
    try:
        allowlist = AuthorizationRevisionAllowlist(
            producer_workflow=value["producer_workflow"],
            producer_revisions=tuple(value["producer_revisions"]),
            signer_workflow=value["signer_workflow"],
            signer_revisions=tuple(value["signer_revisions"]),
        )
    except (TypeError, KeyError) as error:
        fail(f"authorization revision allowlist is malformed: {error}")
    validate_authorization_revision_allowlist(allowlist)
    return allowlist


def _authorization_identity_payload(identity: TrustedReleaseIdentity) -> dict[str, Any]:
    """Return the exact identity fields carried by a signed authorization."""
    return {
        "repository": identity.repository,
        "repository_id": identity.repository_id,
        "repository_owner_id": identity.repository_owner_id,
        "source_ref": identity.source_ref,
        "source_sha": identity.source_sha,
        "event": identity.event,
        "producer_workflow": identity.producer_workflow,
        "producer_revision": identity.producer_revision,
        "signer_workflow": identity.signer_workflow,
        "signer_revision": identity.signer_revision,
        "run_id": identity.run_id,
        "run_attempt": identity.run_attempt,
        "artifact_id": identity.artifact_id,
        "artifact_name": identity.artifact_name,
        "artifact_class": identity.artifact_class,
        "artifact_service_zip_sha256": identity.artifact_service_zip_sha256,
        "artifact_service_zip_bytes": identity.artifact_service_zip_bytes,
        "archive_name": identity.archive_name,
        "archive_sha256": identity.archive_sha256,
        "archive_bytes": identity.archive_bytes,
        "platform": identity.platform,
        "image": identity.image,
        "image_digest": identity.image_digest,
        "authorization_context": identity.authorization_context,
    }


def _canonical_json(value: Any) -> bytes:
    """Serialize a contract object with one deterministic JSON representation."""
    try:
        serialized = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        fail(f"authorization record is not canonically serializable: {error}")
    require(len(serialized) <= MAX_AUTHORIZATION_RECORD_BYTES, "authorization record exceeds the size limit")
    return serialized


def authorization_record_payload(authorization: IndependentReleaseAuthorization) -> dict[str, Any]:
    """Return the versioned signed payload; verification evidence is never signed into it."""
    require(isinstance(authorization, IndependentReleaseAuthorization), "authorization record has an unsupported type")
    return {
        "contract": AUTHORIZATION_CONTRACT,
        "version": AUTHORIZATION_CONTRACT_VERSION,
        "authorization": {
            "authorization_id": authorization.authorization_id,
            "context": authorization.context,
            "scope": authorization.scope,
            "issued_at": authorization.issued_at,
            "expires_at": authorization.expires_at,
            "retry_key": authorization.retry_key,
            "recovery_context": authorization.recovery_context,
            "signing_key_id": authorization.signing_key_id,
            "verification_context_sha256": authorization.verification_context_sha256,
            "destination": authorization.delivery_destination,
        },
        "release": _authorization_identity_payload(TrustedReleaseIdentity(
            repository=authorization.repository,
            repository_id=authorization.repository_id,
            repository_owner_id=authorization.repository_owner_id,
            source_ref=authorization.source_ref,
            source_sha=authorization.source_sha,
            event=authorization.event,
            producer_workflow=authorization.producer_workflow,
            producer_revision=authorization.producer_revision,
            signer_workflow=authorization.signer_workflow,
            signer_revision=authorization.signer_revision,
            run_id=authorization.run_id,
            run_attempt=authorization.run_attempt,
            artifact_id=authorization.artifact_id,
            artifact_name=authorization.artifact_name,
            artifact_class=authorization.artifact_class,
            artifact_service_zip_sha256=authorization.artifact_service_zip_sha256,
            artifact_service_zip_bytes=authorization.artifact_service_zip_bytes,
            archive_name=authorization.archive_name,
            archive_sha256=authorization.archive_sha256,
            archive_bytes=authorization.archive_bytes,
            platform=authorization.platform,
            image=authorization.image,
            image_digest=authorization.image_digest,
            authorization_context=authorization.context,
        )),
    }


def canonical_authorization_record(authorization: IndependentReleaseAuthorization) -> bytes:
    """Return the exact bytes that an owner signs with Ed25519."""
    return _canonical_json(authorization_record_payload(authorization))


def prepare_owner_authorization_record(
    identity: TrustedReleaseIdentity,
    *,
    authorization_id: str,
    issued_at: str,
    expires_at: str,
    signing_key_id: str,
    scope: str = "forward-release",
    recovery_context: str | None = None,
    verification_context_sha256: str | None = None,
    delivery_destination: str | None = None,
    verification_completed_at: str | None = None,
) -> dict[str, Any]:
    """Prepare the exact record bytes an owner may explicitly approve and sign.

    This function never reads a private key, invokes a signer, or treats CI
    success/diagnostic JSON as approval.  The returned payload is the only
    object the external Ed25519 signing step should receive.
    """
    validate_trusted_release_identity(identity)
    require_string(authorization_id, "authorization_id")
    require_string(signing_key_id, "signing_key_id")
    require(scope in {"forward-release", "recovery-release"}, "authorization scope is unsupported")
    issued = _parse_timestamp(issued_at, "issued_at")
    expires = _parse_timestamp(expires_at, "expires_at")
    require(expires > issued, "authorization expiry must be after issuance")
    if scope == "forward-release":
        require(recovery_context is None, "forward authorization must not carry recovery context")
        require((expires - issued).total_seconds() == AUTHORIZATION_FORWARD_VALIDITY_SECONDS, "forward authorization validity must be exactly 24 hours")
    else:
        require(isinstance(recovery_context, str) and recovery_context != "", "recovery authorization requires recovery context")
    if verification_context_sha256 is not None:
        require_digest(verification_context_sha256, "verification_context_sha256")
    authorization_context = OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT if identity.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS else identity.authorization_context
    if identity.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS:
        require(scope == "forward-release", "candidate owner authorization must be a forward authorization")
        require(verification_context_sha256 is not None, "candidate owner authorization must bind an independent verification context")
        require(isinstance(delivery_destination, str) and delivery_destination.startswith("/") and posixpath.normpath(delivery_destination) == delivery_destination, "candidate owner authorization must bind an approved absolute destination")
        require(isinstance(verification_completed_at, str), "candidate owner authorization must bind independent verification chronology")
        require(issued >= _parse_timestamp(verification_completed_at, "verification_completed_at"), "authorization approval predates independent verification")
    record = {
        "contract": AUTHORIZATION_CONTRACT,
        "version": AUTHORIZATION_CONTRACT_VERSION,
        "authorization": {
            "authorization_id": authorization_id,
            "context": authorization_context,
            "scope": scope,
            "issued_at": issued_at,
            "expires_at": expires_at,
            "retry_key": authorization_id,
            "recovery_context": recovery_context,
            "signing_key_id": signing_key_id,
            "verification_context_sha256": verification_context_sha256,
            "destination": delivery_destination,
        },
        "release": _authorization_identity_payload(replace(identity, authorization_context=authorization_context)),
    }
    _canonical_json(record)
    return record


def assemble_owner_authorization_envelope(record: Any, signature: bytes, key_id: str) -> dict[str, Any]:
    """Assemble detached signature bytes supplied by an external owner signer."""
    require(isinstance(record, dict), "authorization record must be an object")
    require(isinstance(signature, bytes) and len(signature) == 64, "Ed25519 detached signature must be 64 bytes")
    require_string(key_id, "authorization signing key ID")
    return {"contract": AUTHORIZATION_CONTRACT, "version": AUTHORIZATION_CONTRACT_VERSION, "record": record, "signature": {"algorithm": AUTHORIZATION_SIGNATURE_ALGORITHM, "key_id": key_id, "value": base64.b64encode(signature).decode("ascii")}}


def authorization_record_envelope(authorization: IndependentReleaseAuthorization, signature: bytes) -> dict[str, Any]:
    """Construct a detached-signature envelope without generating a key or signature."""
    require(isinstance(signature, bytes) and len(signature) == 64, "Ed25519 detached signature must be 64 bytes")
    return {
        "contract": AUTHORIZATION_CONTRACT,
        "version": AUTHORIZATION_CONTRACT_VERSION,
        "record": authorization_record_payload(authorization),
        "signature": {"algorithm": AUTHORIZATION_SIGNATURE_ALGORITHM, "key_id": authorization.signing_key_id, "value": base64.b64encode(signature).decode("ascii")},
    }


def _validate_authorization_envelope(envelope: Any) -> tuple[dict[str, Any], bytes, str]:
    """Validate envelope shape and canonical payload bytes before cryptographic verification."""
    require(isinstance(envelope, dict), "authorization envelope must be an object")
    require(set(envelope) == {"contract", "version", "record", "signature"}, "authorization envelope has missing or unexpected fields")
    require(envelope["contract"] == AUTHORIZATION_CONTRACT and envelope["version"] == AUTHORIZATION_CONTRACT_VERSION, "authorization contract version is unsupported")
    record = envelope["record"]
    require(isinstance(record, dict), "authorization record must be an object")
    canonical = _canonical_json(record)
    signature = envelope["signature"]
    require(isinstance(signature, dict) and set(signature) == {"algorithm", "key_id", "value"}, "authorization signature envelope is malformed")
    require(signature["algorithm"] == AUTHORIZATION_SIGNATURE_ALGORITHM, "authorization signature algorithm is unsupported")
    key_id = require_string(signature["key_id"], "authorization.signature.key_id")
    encoded = require_string(signature["value"], "authorization.signature.value")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        fail(f"authorization signature is not valid base64: {error}")
    require(len(decoded) == 64 and base64.b64encode(decoded).decode("ascii") == encoded, "authorization signature has an invalid Ed25519 encoding")
    return record, decoded, key_id


def _authorization_from_payload(record: dict[str, Any], verification: AuthorizationVerificationReceipt) -> IndependentReleaseAuthorization:
    """Parse a strict canonical payload into the typed authorization object."""
    require(set(record) == {"contract", "version", "authorization", "release"}, "authorization record has missing or unexpected fields")
    authorization = record["authorization"]
    release = record["release"]
    lifecycle_fields = {"authorization_id", "context", "scope", "issued_at", "expires_at", "retry_key", "recovery_context", "signing_key_id"}
    require(isinstance(authorization, dict) and set(authorization).issubset(lifecycle_fields | {"verification_context_sha256", "destination"}) and lifecycle_fields.issubset(authorization), "authorization lifecycle fields are malformed")
    require(isinstance(release, dict), "authorization release identity is malformed")
    require(authorization.get("context") == release.get("authorization_context"), "authorization context is not consistently bound")
    identity_fields = ("repository", "repository_id", "repository_owner_id", "source_ref", "source_sha", "event", "producer_workflow", "producer_revision", "signer_workflow", "signer_revision", "run_id", "run_attempt", "artifact_id", "artifact_name", "artifact_class", "artifact_service_zip_sha256", "artifact_service_zip_bytes", "archive_name", "archive_sha256", "archive_bytes", "platform", "image", "image_digest", "authorization_context")
    require(set(release) == set(identity_fields), "authorization release identity has missing or unexpected fields")
    try:
        return IndependentReleaseAuthorization(
            authorization_id=authorization["authorization_id"], context=authorization["context"], scope=authorization["scope"],
            repository=release["repository"], repository_id=release["repository_id"], repository_owner_id=release["repository_owner_id"],
            source_ref=release["source_ref"], source_sha=release["source_sha"], event=release["event"],
            producer_workflow=release["producer_workflow"], producer_revision=release["producer_revision"],
            signer_workflow=release["signer_workflow"], signer_revision=release["signer_revision"], run_id=release["run_id"], run_attempt=release["run_attempt"],
            artifact_id=release["artifact_id"], artifact_name=release["artifact_name"], artifact_class=release["artifact_class"],
            artifact_service_zip_sha256=release["artifact_service_zip_sha256"], artifact_service_zip_bytes=release["artifact_service_zip_bytes"],
            archive_name=release["archive_name"], archive_sha256=release["archive_sha256"], archive_bytes=release["archive_bytes"],
            platform=release["platform"], image=release["image"], image_digest=release["image_digest"],
            issued_at=authorization["issued_at"], expires_at=authorization["expires_at"], retry_key=authorization["retry_key"],
            recovery_context=authorization["recovery_context"], signing_key_id=authorization["signing_key_id"], verification=verification,
            verification_context_sha256=authorization.get("verification_context_sha256"), delivery_destination=authorization.get("destination"),
        )
    except (KeyError, TypeError) as error:
        fail(f"authorization record fields are malformed: {error}")


def _require_external_path(path: Path, repository_root: Path, label: str) -> None:
    """Require a trusted input to be absolute, real, and outside the mutable checkout."""
    require(isinstance(path, Path) and path.is_absolute(), f"{label} must be an absolute path")
    require(isinstance(repository_root, Path) and repository_root.is_absolute(), "mutable repository root must be an absolute path")
    try:
        root_metadata = os.lstat(repository_root)
    except OSError as error:
        fail(f"mutable repository root is unavailable: {error}")
    require(stat.S_ISDIR(root_metadata.st_mode) and not stat.S_ISLNK(root_metadata.st_mode), "mutable repository root must be a real directory")
    try:
        path.resolve().relative_to(repository_root.resolve())
    except ValueError:
        return
    fail(f"{label} must be outside the mutable checkout")


def _validate_trust_config(trust: AuthorizationTrustConfig) -> None:
    """Require complete external trust policy before inspecting any key material."""
    require(isinstance(trust, AuthorizationTrustConfig), "authorization trust configuration is required")
    _require_external_path(trust.public_key_path, trust.repository_root, "trusted public key")
    require_string(trust.expected_key_id, "authorization trust expected_key_id")
    require_digest(trust.expected_public_key_sha256, "authorization trust expected_public_key_sha256")
    try:
        key_metadata = os.lstat(trust.public_key_path)
        parent_metadata = os.lstat(trust.public_key_path.parent)
    except OSError as error:
        fail(f"trusted public-key custody is unavailable: {error}")
    require(stat.S_ISREG(key_metadata.st_mode) and not stat.S_ISLNK(key_metadata.st_mode), "trusted public key must be a regular non-symlink file")
    require(stat.S_ISDIR(parent_metadata.st_mode) and not stat.S_ISLNK(parent_metadata.st_mode), "trusted public-key parent must be a real directory")
    if os.name == "posix":
        require(key_metadata.st_uid == os.geteuid() and parent_metadata.st_uid == os.geteuid(), "trusted public-key custody is not owned by the current user")
        require(stat.S_IMODE(key_metadata.st_mode) & 0o077 == 0 and stat.S_IMODE(parent_metadata.st_mode) & 0o077 == 0, "trusted public-key custody is not private")


def _write_private_bytes(path: Path, payload: bytes, label: str) -> None:
    """Write a private temporary file completely and durably."""
    descriptor = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        descriptor = os.open(path, flags, 0o600)
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(payload):
            written += os.write(descriptor, payload[written:])
        os.fsync(descriptor)
    except OSError as error:
        fail(f"{label} write failed: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _private_snapshot(source: Path, directory: Path, label: str, *, maximum: int = MAX_AUTHORIZATION_PUBLIC_KEY_BYTES, filename: str = "trusted-public-key.pem") -> Path:
    """Copy one bounded regular input and use only that private snapshot thereafter."""
    source_descriptor, source_size = _open_nofollow_regular(source, maximum, label)
    snapshot = directory / filename
    try:
        chunks: list[bytes] = []
        remaining = source_size
        while remaining:
            chunk = os.read(source_descriptor, min(64 * 1024, remaining))
            require(chunk, f"{label} changed while snapshotting")
            chunks.append(chunk)
            remaining -= len(chunk)
        metadata = os.fstat(source_descriptor)
        require(metadata.st_size == source_size, f"{label} changed during snapshot")
        _write_private_bytes(snapshot, b"".join(chunks), f"{label} snapshot")
        return snapshot
    finally:
        os.close(source_descriptor)


def _openssl_executable() -> str:
    executable = shutil.which("openssl")
    require(executable is not None, "established Ed25519 tooling is unavailable: openssl was not found")
    return executable


def _inspect_ed25519_key(snapshot: Path, directory: Path) -> str:
    """Use OpenSSL's parsed key type and SPKI DER to identify an Ed25519 public key."""
    openssl = _openssl_executable()
    text_result = run_bounded([openssl, "pkey", "-pubin", "-in", str(snapshot), "-text", "-noout"], timeout_seconds=10, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="Ed25519 public-key inspection")
    require(text_result.returncode == 0 and "ED25519" in text_result.stdout.upper(), "trusted public key is not an Ed25519 public key")
    der_path = directory / "trusted-public-key.der"
    der_result = run_bounded([openssl, "pkey", "-pubin", "-in", str(snapshot), "-outform", "DER", "-out", str(der_path)], timeout_seconds=10, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="public-key fingerprint derivation")
    require(der_result.returncode == 0, "trusted public-key fingerprint derivation failed")
    fingerprint, _ = _sha256_file(der_path, MAX_AUTHORIZATION_PUBLIC_KEY_BYTES, "trusted public-key DER snapshot")
    return fingerprint


def _read_verified_canonical_record(path: Path, expected: bytes) -> dict[str, Any]:
    """Decode only the private bytes that were handed to OpenSSL for verification."""
    decoded = _read_bounded_json(path, "verified authorization record snapshot")
    require(isinstance(decoded, dict), "verified authorization record snapshot must be an object")
    require(_canonical_json(decoded) == expected, "verified authorization record snapshot changed during verification")
    return decoded


def verify_signed_authorization_record(
    envelope: Any,
    trust: AuthorizationTrustConfig,
    identity: TrustedReleaseIdentity,
    revision_allowlist: AuthorizationRevisionAllowlist,
    *,
    now: datetime | None = None,
    historical: bool = False,
) -> IndependentReleaseAuthorization:
    """Verify an owner-signed Ed25519 record from one bounded trusted-key snapshot."""
    _validate_trust_config(trust)
    record, signature, key_id = _validate_authorization_envelope(envelope)
    require(key_id == trust.expected_key_id, "authorization signing key is not the independently trusted key")
    canonical = _canonical_json(record)
    with tempfile.TemporaryDirectory(prefix="clashcookies-auth-verify-") as directory_name:
        directory = Path(directory_name)
        snapshot = _private_snapshot(trust.public_key_path, directory, "trusted public key")
        key_fingerprint = _inspect_ed25519_key(snapshot, directory)
        require(key_fingerprint == trust.expected_public_key_sha256, "trusted public-key fingerprint does not match policy")
        record_path = directory / "record.json"
        signature_path = directory / "record.sig"
        _write_private_bytes(record_path, canonical, "authorization record snapshot")
        _write_private_bytes(signature_path, signature, "authorization signature snapshot")
        openssl = _openssl_executable()
        try:
            result = run_bounded([openssl, "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(snapshot), "-in", str(record_path), "-sigfile", str(signature_path)], timeout_seconds=10, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="Ed25519 authorization verification")
        except (OSError, subprocess.TimeoutExpired) as error:
            fail(f"Ed25519 authorization verification failed to run: {error}")
        require(result.returncode == 0, f"Ed25519 authorization signature is invalid: {result.stderr.strip() or result.stdout.strip()}")
        verified_record = _read_verified_canonical_record(record_path, canonical)
    require(verified_record.get("contract") == AUTHORIZATION_CONTRACT and verified_record.get("version") == AUTHORIZATION_CONTRACT_VERSION, "authorization record contract version is unsupported")
    payload_auth = verified_record.get("authorization")
    require(isinstance(payload_auth, dict) and payload_auth.get("signing_key_id") == key_id, "authorization signing key is not bound to the record")
    verification = AuthorizationVerificationReceipt(AUTHORIZATION_VERIFIER, hashlib.sha256(canonical).hexdigest(), (now or _now_utc()).astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), key_id, AUTHORIZATION_SIGNATURE_ALGORITHM, key_fingerprint)
    authorization = _authorization_from_payload(verified_record, verification)
    validation_now = now
    if historical:
        validation_now = _parse_timestamp(authorization.issued_at, "authorization.issued_at")
    validate_independent_authorization(authorization, identity, revision_allowlist=revision_allowlist, now=validation_now)
    return authorization


def _identity_fingerprint(identity: TrustedReleaseIdentity) -> str:
    return hashlib.sha256(_canonical_json(_authorization_identity_payload(identity))).hexdigest()


def _fsync_directory(path: Path, *, required: bool, descriptor: int | None = None) -> None:
    """Fsync a journal directory, failing closed when Linux durability is promised."""
    if os.name != "posix":
        if required:
            fail("directory fsync durability is unavailable on this platform")
        return
    if descriptor is not None:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if required:
                fail(f"authorization replay directory fsync failed: {error}")
        return
    descriptor = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        descriptor = os.open(path, flags)
        os.fsync(descriptor)
    except OSError as error:
        if required:
            fail(f"authorization replay directory fsync failed: {error}")
    finally:
        if descriptor is not None:
            os.close(descriptor)


class AuthorizationReplayJournal:
    """Serialized replay state kept outside the mutable checkout."""

    def __init__(self, root: Path, *, repository_root: Path, development_mode: bool = False, lock_timeout_seconds: float = 5.0) -> None:
        _require_external_path(root, repository_root, "authorization replay journal")
        try:
            metadata = os.lstat(root)
        except OSError as error:
            fail(f"authorization replay journal is unavailable: {error}")
        require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), "authorization replay journal must be a real directory")
        self.root = root
        self.development_mode = development_mode
        self.durable = os.name == "posix"
        if not self.durable:
            require(development_mode, "durable authorization replay storage is unsupported on Windows without explicit development mode")
        self._validate_private_directory()
        self._root_fd = self._open_root_directory()
        root_stat = os.fstat(self._root_fd) if self._root_fd is not None else os.stat(self.root)
        self._root_identity = (root_stat.st_dev, root_stat.st_ino, root_stat.st_mode, root_stat.st_uid)
        require(lock_timeout_seconds > 0, "authorization replay lock timeout must be positive")
        self.lock_timeout_seconds = lock_timeout_seconds
        self.lock_path = self.root / ".journal.lock"

    def _open_root_directory(self) -> int | None:
        if os.name != "posix":
            return None
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        try:
            descriptor = os.open(self.root, flags)
            metadata = os.fstat(descriptor)
        except OSError as error:
            fail(f"authorization replay journal directory cannot be opened safely: {error}")
        require(stat.S_ISDIR(metadata.st_mode), "authorization replay journal root descriptor is not a directory")
        return descriptor

    def _assert_root_identity(self) -> None:
        try:
            path_metadata = os.lstat(self.root)
            descriptor_metadata = os.fstat(self._root_fd) if self._root_fd is not None else path_metadata
        except OSError as error:
            fail(f"authorization replay journal directory identity is unavailable: {error}")
        require(stat.S_ISDIR(path_metadata.st_mode) and not stat.S_ISLNK(path_metadata.st_mode), "authorization replay journal directory was substituted")
        require((path_metadata.st_dev, path_metadata.st_ino, path_metadata.st_mode, path_metadata.st_uid) == self._root_identity, "authorization replay journal directory identity changed")
        require((descriptor_metadata.st_dev, descriptor_metadata.st_ino, descriptor_metadata.st_mode, descriptor_metadata.st_uid) == self._root_identity, "authorization replay journal directory descriptor changed")

    def close(self) -> None:
        descriptor = getattr(self, "_root_fd", None)
        if descriptor is not None:
            self._root_fd = None
            os.close(descriptor)

    def __del__(self) -> None:
        try:
            self.close()
        except OSError:
            pass

    def _validate_private_directory(self) -> None:
        metadata = os.stat(self.root)
        if os.name == "posix":
            require(metadata.st_uid == os.geteuid(), "authorization replay journal owner is not the current user")
            require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "authorization replay journal directory is not private")

    def _validate_private_file(self, path: Path, label: str) -> None:
        metadata = os.lstat(path)
        require(stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"{label} must be a private regular file")
        if os.name == "posix":
            require(metadata.st_uid == os.geteuid(), f"{label} owner is not the current user")
            require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{label} is not private")

    @contextmanager
    def _locked(self):
        descriptor = None
        acquired = False
        try:
            self._assert_root_identity()
            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            if hasattr(os, "O_BINARY"):
                flags |= os.O_BINARY
            if os.name == "posix":
                descriptor = os.open(".journal.lock", flags, 0o600, dir_fd=self._root_fd)
            else:
                descriptor = os.open(self.lock_path, flags, 0o600)
            metadata = os.fstat(descriptor)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "authorization replay lock must be a single regular file")
            if os.name == "posix":
                require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0 and stat.S_IMODE(metadata.st_mode) & 0o600 == 0o600, "authorization replay lock ownership or permissions are unsafe")
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"0")
                os.fsync(descriptor)
            self._assert_root_identity()
            deadline = time.monotonic() + self.lock_timeout_seconds
            if os.name == "posix":
                while True:
                    try:
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            fail("authorization replay lock acquisition deadline exceeded")
                        time.sleep(0.01)
            else:
                while True:
                    try:
                        os.lseek(descriptor, 0, os.SEEK_SET)
                        msvcrt.locking(descriptor, getattr(msvcrt, "LK_NBLCK", msvcrt.LK_LOCK), 1)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            fail("authorization replay lock acquisition deadline exceeded")
                        time.sleep(0.01)
            acquired = True
            self._assert_root_identity()
            yield
        except OSError as error:
            fail(f"authorization replay journal lock failed: {error}")
        finally:
            if descriptor is not None:
                try:
                    if acquired and os.name == "posix":
                        fcntl.flock(descriptor, fcntl.LOCK_UN)
                    elif acquired:
                        os.lseek(descriptor, 0, os.SEEK_SET)
                        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                finally:
                    os.close(descriptor)

    def _path(self, authorization: IndependentReleaseAuthorization) -> Path:
        token = hashlib.sha256(authorization.authorization_id.encode("utf-8")).hexdigest()
        return self.root / f"{token}.json"

    def _name(self, path: Path) -> str:
        require(path.parent == self.root and path.name not in {"", ".", ".."}, "authorization replay path escaped its verified directory")
        return path.name

    def _open_relative(self, name: str, flags: int, mode: int = 0) -> int:
        self._assert_root_identity()
        if os.name == "posix":
            return os.open(name, flags, mode, dir_fd=self._root_fd)
        return os.open(self.root / name, flags, mode)

    def _unlink_relative(self, path: Path) -> None:
        self._assert_root_identity()
        if os.name == "posix":
            os.unlink(self._name(path), dir_fd=self._root_fd)
        else:
            path.unlink()

    def _fsync_file(self, path: Path, label: str) -> None:
        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        descriptor = None
        try:
            descriptor = self._open_relative(self._name(path), flags)
            metadata = os.fstat(descriptor)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, f"{label} is not a single regular file")
            if os.name == "posix":
                require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0, f"{label} ownership or permissions are unsafe")
            os.fsync(descriptor)
        except OSError as error:
            fail(f"{label} fsync failed: {error}")
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _entry_exists(self, path: Path) -> bool:
        self._assert_root_identity()
        try:
            if os.name == "posix":
                os.stat(self._name(path), dir_fd=self._root_fd, follow_symlinks=False)
            else:
                os.lstat(path)
            return True
        except FileNotFoundError:
            return False
        except OSError as error:
            fail(f"authorization replay entry lookup failed: {error}")

    def _state(self, authorization: IndependentReleaseAuthorization, identity: TrustedReleaseIdentity, operation: str, state: str) -> dict[str, Any]:
        verification = authorization.verification
        return {"contract": AUTHORIZATION_CONTRACT, "version": AUTHORIZATION_CONTRACT_VERSION, "authorization_id": authorization.authorization_id, "retry_key": authorization.retry_key, "record_sha256": verification.record_sha256, "key_fingerprint": verification.key_fingerprint, "identity_sha256": _identity_fingerprint(identity), "scope": authorization.scope, "operation": operation, "recovery_context": authorization.recovery_context, "issued_at": authorization.issued_at, "expires_at": authorization.expires_at, "state": state}

    def _sync_directory(self) -> None:
        self._assert_root_identity()
        _fsync_directory(self.root, required=self.durable, descriptor=self._root_fd)

    def _write_temp(self, value: dict[str, Any], prefix: str) -> Path:
        payload = _canonical_json(value)
        descriptor = None
        path = None
        for _ in range(20):
            candidate = self.root / f"{prefix}{uuid.uuid4().hex}.tmp"
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            if hasattr(os, "O_BINARY"):
                flags |= os.O_BINARY
            try:
                descriptor = self._open_relative(candidate.name, flags, 0o600)
                path = candidate
                break
            except FileExistsError:
                continue
        require(descriptor is not None and path is not None, "authorization replay temporary name allocation failed")
        failure: Exception | None = None
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(descriptor, 0o600)
            written = 0
            while written < len(payload):
                written += os.write(descriptor, payload[written:])
            os.fsync(descriptor)
            self._validate_private_file(path, "authorization replay temporary file")
            return path
        except (OSError, ProvenanceError) as error:
            failure = error
        finally:
            os.close(descriptor)
        self._remove_owned_temp(path)
        if isinstance(failure, ProvenanceError):
            raise failure
        fail(f"authorization replay temporary write failed: {failure}")

    def _remove_owned_temp(self, path: Path) -> None:
        try:
            self._unlink_relative(path)
        except FileNotFoundError:
            pass
        except OSError as error:
            fail(f"authorization replay temporary cleanup failed: {error}")

    def _publish_no_replace(self, temporary: Path, destination: Path) -> None:
        self._assert_root_identity()
        try:
            if os.name == "posix":
                os.link(self._name(temporary), self._name(destination), src_dir_fd=self._root_fd, dst_dir_fd=self._root_fd)
            else:
                os.link(temporary, destination)
        except FileExistsError:
            raise
        except OSError as error:
            self._remove_owned_temp(temporary)
            fail(f"authorization replay reservation publication failed: {error}")
        self._remove_owned_temp(temporary)
        self._fsync_file(destination, "authorization replay reservation")
        self._sync_directory()

    def _read(self, path: Path) -> dict[str, Any]:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        descriptor = None
        try:
            descriptor = self._open_relative(self._name(path), flags)
            metadata = os.fstat(descriptor)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, "authorization replay entry must be a single regular file")
            if os.name == "posix":
                require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "authorization replay entry ownership or permissions are unsafe")
            require(0 < metadata.st_size <= MAX_ARTIFACT_JSON_BYTES, "authorization replay entry is empty or oversized")
            chunks: list[bytes] = []
            remaining = metadata.st_size
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                require(chunk, "authorization replay entry changed during read")
                chunks.append(chunk)
                remaining -= len(chunk)
            require(os.fstat(descriptor).st_size == metadata.st_size, "authorization replay entry changed during read")
            try:
                value = json.loads(b"".join(chunks).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                fail(f"authorization replay entry is malformed: {error}")
            require(isinstance(value, dict), "authorization replay entry is malformed")
            return value
        except OSError as error:
            fail(f"authorization replay entry is unavailable: {error}")
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _check_existing(self, existing: dict[str, Any], expected: dict[str, Any], now: datetime) -> None:
        for field, value in expected.items():
            if field != "state":
                require(existing.get(field) == value, "authorization replay record does not exactly match the signed authorization")
        require(existing.get("state") == "reserved", "authorization replay detected")
        require(_parse_timestamp(existing.get("expires_at"), "authorization replay expires_at") > now, "authorization replay entry is expired")

    def _reestablish_existing_durability(self, path: Path) -> None:
        self._assert_root_identity()
        self._fsync_file(path, "authorization replay reservation retry")
        self._sync_directory()

    def _verify_operation(self, envelope: Any, identity: TrustedReleaseIdentity, revision_allowlist: AuthorizationRevisionAllowlist, trust: AuthorizationTrustConfig, operation: str, now: datetime | None) -> IndependentReleaseAuthorization:
        require(operation in {"forward-release", "recovery-release"}, "authorization operation context is required")
        authorization = verify_signed_authorization_record(envelope, trust, identity, revision_allowlist, now=now)
        require(authorization.scope == operation, "authorization scope does not match the explicit operation context")
        return authorization

    def reserve(self, envelope: Any, identity: TrustedReleaseIdentity, revision_allowlist: AuthorizationRevisionAllowlist, trust: AuthorizationTrustConfig, *, operation: str, now: datetime | None = None) -> None:
        """Verify and reserve an authorization; retries require exact signed-record equality."""
        with self._locked():
            authorization = self._verify_operation(envelope, identity, revision_allowlist, trust, operation, now)
            current = (now or _now_utc()).astimezone(timezone.utc)
            path = self._path(authorization)
            expected = self._state(authorization, identity, operation, "reserved")
            try:
                temporary = self._write_temp(expected, ".authorization-reservation-")
                try:
                    self._publish_no_replace(temporary, path)
                except FileExistsError:
                    self._remove_owned_temp(temporary)
                    self._check_existing(self._read(path), expected, current)
                    self._reestablish_existing_durability(path)
            except FileExistsError:
                self._check_existing(self._read(path), expected, current)
                self._reestablish_existing_durability(path)

    def consume(self, envelope: Any, identity: TrustedReleaseIdentity, revision_allowlist: AuthorizationRevisionAllowlist, trust: AuthorizationTrustConfig, *, operation: str, now: datetime | None = None) -> None:
        """Verify and atomically consume a reservation under the same serialized lock."""
        with self._locked():
            authorization = self._verify_operation(envelope, identity, revision_allowlist, trust, operation, now)
            current = (now or _now_utc()).astimezone(timezone.utc)
            path = self._path(authorization)
            require(self._entry_exists(path), "authorization replay reservation is missing")
            expected = self._state(authorization, identity, operation, "reserved")
            self._check_existing(self._read(path), expected, current)
            temporary = self._write_temp(self._state(authorization, identity, operation, "consumed"), ".authorization-consume-")
            try:
                self._assert_root_identity()
                if os.name == "posix":
                    os.replace(self._name(temporary), self._name(path), src_dir_fd=self._root_fd, dst_dir_fd=self._root_fd)
                else:
                    os.replace(temporary, path)
                self._fsync_file(path, "authorization replay consumed entry")
                self._sync_directory()
            except OSError as error:
                fail(f"authorization replay journal commit failed: {error}")
            finally:
                self._remove_owned_temp(temporary)

    def assert_reserved(self, envelope: Any, identity: TrustedReleaseIdentity, revision_allowlist: AuthorizationRevisionAllowlist, trust: AuthorizationTrustConfig, *, operation: str, now: datetime | None = None) -> None:
        """Prove that the exact signed authorization already has a durable reservation."""
        with self._locked():
            authorization = self._verify_operation(envelope, identity, revision_allowlist, trust, operation, now)
            current = (now or _now_utc()).astimezone(timezone.utc)
            path = self._path(authorization)
            require(self._entry_exists(path), "authorization replay reservation is missing")
            self._check_existing(self._read(path), self._state(authorization, identity, operation, "reserved"), current)


def validate_independent_authorization(authorization: IndependentReleaseAuthorization, identity: TrustedReleaseIdentity, *, revision_allowlist: AuthorizationRevisionAllowlist | None = None, now: datetime | None = None) -> None:
    """Check binding, explicit revisions, and lifecycle semantics for a verified record."""
    validate_trusted_release_identity(identity)
    require(isinstance(authorization, IndependentReleaseAuthorization), "independent authorization has an unsupported type")
    require(revision_allowlist is not None, "authorization revision allowlist is required")
    validate_authorization_revision_allowlist(revision_allowlist)
    require_string(authorization.authorization_id, "authorization.authorization_id")
    allowed_contexts = {identity.authorization_context}
    if identity.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS:
        allowed_contexts.add(OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT)
    require(authorization.context in allowed_contexts, "authorization context does not match release identity")
    if authorization.context == OWNER_APPROVED_CANDIDATE_AUTHORIZATION_CONTEXT:
        require(isinstance(authorization.delivery_destination, str) and authorization.delivery_destination.startswith("/") and posixpath.normpath(authorization.delivery_destination) == authorization.delivery_destination, "owner-approved candidate authorization destination is invalid")
    require(authorization.scope in {"forward-release", "recovery-release"}, "authorization scope is unsupported")
    if authorization.scope == "forward-release":
        require(authorization.recovery_context is None, "forward authorization must not carry recovery context")
    else:
        require(isinstance(authorization.recovery_context, str) and authorization.recovery_context != "", "recovery authorization requires recovery context")
    require(authorization.retry_key == authorization.authorization_id, "authorization retry key must be stable and identity-bound")
    require(authorization.repository == identity.repository, "authorization repository mismatch")
    require(authorization.repository_id == identity.repository_id, "authorization repository ID mismatch")
    require(authorization.repository_owner_id == identity.repository_owner_id, "authorization owner ID mismatch")
    for field in ("source_ref", "source_sha", "event", "producer_workflow", "producer_revision", "signer_workflow", "signer_revision", "run_id", "run_attempt", "artifact_id", "artifact_name", "artifact_class", "artifact_service_zip_sha256", "artifact_service_zip_bytes", "archive_name", "archive_sha256", "archive_bytes", "platform", "image", "image_digest"):
        require(getattr(authorization, field) == getattr(identity, field), f"authorization {field} does not match release identity")
    require(authorization.producer_revision in revision_allowlist.producer_revisions, "authorization producer revision is not allowlisted")
    require(authorization.signer_revision in revision_allowlist.signer_revisions, "authorization signer revision is not allowlisted")
    require(authorization.producer_workflow == revision_allowlist.producer_workflow and authorization.signer_workflow == revision_allowlist.signer_workflow, "authorization workflow is not allowlisted")
    require_string(authorization.signing_key_id, "authorization.signing_key_id")
    if authorization.verification_context_sha256 is not None:
        require_digest(authorization.verification_context_sha256, "authorization.verification_context_sha256")
    issued = _parse_timestamp(authorization.issued_at, "authorization.issued_at")
    expires = _parse_timestamp(authorization.expires_at, "authorization.expires_at")
    require(expires > issued, "authorization expiry must be after issuance")
    if authorization.scope == "forward-release":
        require((expires - issued).total_seconds() == AUTHORIZATION_FORWARD_VALIDITY_SECONDS, "forward authorization validity must be exactly 24 hours")
    current = (now or _now_utc()).astimezone(timezone.utc)
    require(issued <= current < expires, "authorization is stale or not yet valid")
    verification = authorization.verification
    require(isinstance(verification, AuthorizationVerificationReceipt), "authorization verification evidence is missing")
    require_string(verification.verifier, "authorization.verification.verifier")
    require_digest(verification.record_sha256, "authorization.verification.record_sha256")
    _parse_timestamp(verification.verified_at, "authorization.verification.verified_at")
    require_string(verification.key_reference, "authorization.verification.key_reference")
    require(verification.algorithm == AUTHORIZATION_SIGNATURE_ALGORITHM, "authorization verification algorithm is unsupported")
    require_digest(verification.key_fingerprint, "authorization.verification.key_fingerprint")


def validate_authenticated_provenance_binding(provenance: AuthenticatedProvenance, identity: TrustedReleaseIdentity) -> None:
    """Require authenticated inner-archive evidence to equal the approved identity."""
    validate_trusted_release_identity(identity)
    fields = ("repository", "source_ref", "source_sha", "event", "signer_workflow", "signer_revision", "run_id", "run_attempt", "archive_name", "archive_sha256", "archive_bytes", "platform", "image", "image_digest")
    for field in fields:
        expected_value = getattr(identity, field)
        actual_value = getattr(provenance, field)
        if field == "repository":
            require(actual_value == expected_value, "authenticated provenance repository mismatch")
        else:
            require(actual_value == expected_value, f"authenticated provenance {field} mismatch")
    require(str(provenance.repository_id) == str(identity.repository_id), "authenticated provenance repository ID mismatch")
    require(provenance.artifact_class == identity.artifact_class, "authenticated provenance artifact class mismatch")
    require(provenance.receipt.subject_digest == identity.archive_sha256, "authenticated provenance receipt digest mismatch")
    require(provenance.receipt.run_invocation_uri.endswith(f"/actions/runs/{identity.run_id}/attempts/{identity.run_attempt}"), "authenticated provenance receipt run mismatch")


def _gh_executable(environment: dict[str, str] | None = None) -> str:
    """Return the explicitly configured verifier, never an implicit offline fallback."""
    source = os.environ if environment is None else environment
    executable = source.get("GH_ATTESTATION_CLI")
    if executable is None and environment is None:
        executable = "gh"
    require(isinstance(executable, str) and executable != "", "official GitHub CLI executable is missing from the verifier environment")
    if environment is not None:
        require(Path(executable).is_absolute(), f"offline verifier executable must be an absolute configured path: {executable}")
    return executable


def run_bounded(command: list[str], *, timeout_seconds: int, max_output_bytes: int, label: str, environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run a command with bounded reader queues, output buffers, and a deadline."""
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, start_new_session=(os.name == "posix"))
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
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
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


def verify_gh_version(expected_version: str = SUPPORTED_GH_VERSION, timeout_seconds: int = 10, environment: dict[str, str] | None = None) -> str:
    """Require the recorded official GitHub CLI version before accepting evidence."""
    executable = _gh_executable(environment)
    try:
        result = run_bounded([executable, "version"], timeout_seconds=timeout_seconds, max_output_bytes=4096, label="official GitHub CLI version", environment=environment)
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"official GitHub CLI version check unavailable or timed out: {error}")
    require(result.returncode == 0, "official GitHub CLI version check failed")
    require(len(result.stdout) <= 4096 and len(result.stderr) <= 4096, "official GitHub CLI version output exceeds the limit")
    match = re.search(r"gh version (\d+\.\d+\.\d+)", result.stdout)
    observed = match.group(1) if match is not None else (result.stdout.strip()[:120] or "unreported")
    require(match is not None and match.group(1) == expected_version, f"unsupported GitHub CLI version; expected {expected_version}, observed {observed}, executable {executable}")
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
    custom_trusted_root: Path | None = None,
    offline: bool = False,
    repository_root: Path | None = None,
    excluded_roots: tuple[Path, ...] = (),
    deadline: float | None = None,
) -> dict[str, Any]:
    """Run the official GitHub CLI verifier against the immutable archive snapshot.

    ``offline`` is deliberately explicit.  It requires a caller-supplied root
    outside the checkout and runs the pinned official verifier with GitHub
    authentication/configuration removed.  API correlation remains a separate
    operation performed by ``validate_verified_result`` when metadata is
    available at intake.
    """
    require_regular_bounded(archive, MAX_ARCHIVE_BYTES, "immutable archive snapshot")
    if bundle is not None:
        require_regular_bounded(bundle, MAX_BUNDLE_BYTES, "attestation bundle")
    if offline:
        require(bundle is not None, "offline attestation verification requires the original attestation bundle")
        require(custom_trusted_root is not None, "offline attestation verification requires an independently supplied trusted root")
    if custom_trusted_root is not None:
        require_regular_bounded(custom_trusted_root, MAX_BUNDLE_BYTES, "custom trusted root")
        if repository_root is not None:
            _require_external_path(custom_trusted_root, repository_root, "custom trusted root")
        for excluded_root in excluded_roots:
            _require_external_path(custom_trusted_root, excluded_root, "custom trusted root")
        root_metadata = os.lstat(custom_trusted_root)
        root_parent_metadata = os.lstat(custom_trusted_root.parent)
        require(stat.S_ISDIR(root_parent_metadata.st_mode) and not stat.S_ISLNK(root_parent_metadata.st_mode), "custom trusted root parent is unsafe")
        if os.name == "posix":
            require(root_metadata.st_uid == os.geteuid() and root_parent_metadata.st_uid == os.geteuid(), "custom trusted root is not owner-controlled")
            require(stat.S_IMODE(root_metadata.st_mode) & 0o077 == 0 and stat.S_IMODE(root_parent_metadata.st_mode) & 0o077 == 0, "custom trusted root is not private")
    environment = None
    root_snapshot = None
    if offline:
        environment = dict(os.environ)
        for name in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"):
            environment.pop(name, None)
        # A private empty configuration directory prevents a cached login or
        # extension from becoming an implicit source of authenticated evidence.
        config_dir = tempfile.mkdtemp(prefix="clashcookies-gh-offline-")
        environment["GH_CONFIG_DIR"] = config_dir
        environment["GH_PROMPT_DISABLED"] = "true"
        try:
            root_snapshot = _private_snapshot(custom_trusted_root, Path(config_dir), "custom trusted root", maximum=MAX_BUNDLE_BYTES, filename="trusted-root.jsonl")
        except Exception:
            shutil.rmtree(config_dir, ignore_errors=True)
            raise
    remaining_timeout = timeout_seconds
    if deadline is not None:
        remaining = deadline - time.monotonic()
        require(remaining > 0, "attestation verification deadline already expired")
        remaining_timeout = max(1, min(timeout_seconds, int(remaining)))
    try:
        verified_version = verify_gh_version(verifier_version, timeout_seconds=remaining_timeout, environment=environment)
    except Exception:
        if environment is not None:
            shutil.rmtree(environment["GH_CONFIG_DIR"], ignore_errors=True)
        raise
    cli_signer_workflow = signer_workflow if "/" in signer_workflow.split(".github/", 1)[0] else f"{repository}/{signer_workflow}"
    executable = _gh_executable(environment)
    command = [
        executable,
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
    if custom_trusted_root is not None:
        command.extend(["--custom-trusted-root", str(root_snapshot or custom_trusted_root)])
    trusted_root_digest = None
    trusted_root_bytes = None
    if root_snapshot is not None:
        trusted_root_digest, trusted_root_bytes = _sha256_file(root_snapshot, MAX_BUNDLE_BYTES, "custom trusted root snapshot")
    try:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "attestation verification deadline already expired")
            remaining_timeout = max(1, min(timeout_seconds, int(remaining)))
        result = run_bounded(command, timeout_seconds=remaining_timeout, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="official GitHub attestation verifier", environment=environment)
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"official GitHub attestation verifier unavailable or timed out: {error}")
    finally:
        if environment is not None:
            shutil.rmtree(environment["GH_CONFIG_DIR"], ignore_errors=True)
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
    if trusted_root_digest is not None and trusted_root_bytes is not None:
        document[0]["_trustedRootSha256"] = trusted_root_digest
        document[0]["_trustedRootBytes"] = trusted_root_bytes
    return document[0]


def _run_gh_api_json(endpoint: str, *, label: str, timeout_seconds: int = 30) -> Any:
    """Run one bounded authenticated GitHub API request and parse JSON."""
    try:
        result = run_bounded([_gh_executable(), "api", endpoint], timeout_seconds=timeout_seconds, max_output_bytes=MAX_ARTIFACT_JSON_BYTES, label=label)
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"{label} unavailable or timed out: {error}")
    require(len(result.stdout) <= MAX_ARTIFACT_JSON_BYTES and len(result.stderr) <= MAX_ARTIFACT_JSON_BYTES, f"{label} output exceeds the limit")
    require(result.returncode == 0, f"{label} request failed")
    try:
        return json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        fail(f"{label} returned malformed JSON: {error}")


def fetch_run_metadata(repository: str, run_id: int, run_attempt: int | None = None, timeout_seconds: int = 30) -> dict[str, Any]:
    """Read authenticated GitHub Actions run metadata for independent correlation."""
    try:
        endpoint = f"repos/{repository}/actions/runs/{run_id}" if run_attempt is None else f"repos/{repository}/actions/runs/{run_id}/attempts/{run_attempt}"
        result = run_bounded([_gh_executable(), "api", endpoint], timeout_seconds=timeout_seconds, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="authenticated GitHub Actions run metadata")
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


def fetch_run_artifacts(repository: str, run_id: int, timeout_seconds: int = 30) -> dict[str, Any]:
    """Read and validate one complete bounded artifact page for one run."""
    require_string(repository, "repository")
    require_int(run_id, "run_id", 1)
    try:
        result = run_bounded([_gh_executable(), "api", f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"], timeout_seconds=timeout_seconds, max_output_bytes=MAX_VERIFIER_OUTPUT_BYTES, label="authenticated GitHub Actions artifact metadata")
    except (OSError, subprocess.TimeoutExpired) as error:
        fail(f"authenticated GitHub Actions artifact metadata unavailable or timed out: {error}")
    require(len(result.stdout) <= MAX_ARTIFACT_JSON_BYTES and len(result.stderr) <= MAX_ARTIFACT_JSON_BYTES, "authenticated GitHub Actions artifact metadata output exceeds the limit")
    require(result.returncode == 0, "authenticated GitHub Actions artifact metadata request failed")
    try:
        response = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        fail(f"authenticated GitHub Actions artifact metadata is malformed: {error}")
    validate_artifact_api_response(response)
    return response


def fetch_exact_run_attempt_jobs(repository: str, run_id: int, run_attempt: int, timeout_seconds: int = 30) -> list[dict[str, Any]]:
    """Fetch every job from the exact attempt-scoped Actions API route.

    The ordinary ``runs/{id}/jobs`` route is latest-attempt scoped and is not
    acceptable for authorization.  Pagination is validated against
    ``total_count`` before any job is considered evidence.
    """
    require_string(repository, "repository")
    require_int(run_id, "run_id", 1)
    require_int(run_attempt, "run_attempt", 1)
    jobs: list[dict[str, Any]] = []
    seen: set[int] = set()
    expected_total: int | None = None
    for page in range(1, MAX_ACTIONS_JOB_PAGES + 1):
        response = _run_gh_api_json(
            f"repos/{repository}/actions/runs/{run_id}/attempts/{run_attempt}/jobs?per_page=100&page={page}",
            label=f"authenticated exact-attempt job metadata page {page}",
            timeout_seconds=timeout_seconds,
        )
        require(isinstance(response, dict), "exact-attempt job response must be an object")
        total = response.get("total_count")
        page_jobs = response.get("jobs")
        require(type(total) is int and 0 <= total <= MAX_ACTIONS_JOBS, "exact-attempt job total_count is invalid or unbounded")
        require(isinstance(page_jobs, list) and len(page_jobs) <= 100, "exact-attempt job page is malformed")
        if expected_total is None:
            expected_total = total
        require(total == expected_total, "exact-attempt job pagination total changed")
        for job in page_jobs:
            require(isinstance(job, dict) and type(job.get("id")) is int and job["id"] > 0, "exact-attempt job entry is malformed")
            require(job["id"] not in seen, "exact-attempt job pagination contains a duplicate")
            seen.add(job["id"])
            jobs.append(job)
        if len(jobs) == expected_total:
            return jobs
        require(page_jobs, "exact-attempt job pagination ended before total_count")
    fail("exact-attempt job pagination exceeded its bound")


def _validate_job_chronology(job: dict[str, Any], run_metadata: dict[str, Any]) -> datetime:
    """Keep job evidence inside the exact-attempt run/update window.

    GitHub's attempt endpoint does not expose a run-level ``completed_at``.
    The independently observable completion boundary is the latest mandatory
    job completion, which must be no later than the run's ``updated_at``.
    """
    run_created = _parse_timestamp(run_metadata.get("created_at"), "run.created_at")
    run_started = _parse_timestamp(run_metadata.get("run_started_at"), "run.run_started_at")
    run_updated = _parse_timestamp(run_metadata.get("updated_at"), "run.updated_at")
    started = _parse_timestamp(job.get("started_at"), "job.started_at")
    completed = _parse_timestamp(job.get("completed_at"), "job.completed_at")
    require(run_created <= run_started <= started <= completed <= run_updated, "exact-attempt job chronology is contradictory")
    require(type(job.get("run_id")) is int and job.get("run_id") == run_metadata.get("id"), "job is not bound to the exact run")
    require(type(job.get("run_attempt")) is int and job.get("run_attempt") == run_metadata.get("run_attempt"), "job is not bound to the exact run attempt")
    return completed


def validate_completed_candidate_run(request: ArtifactSelectionRequest, run_metadata: dict[str, Any], jobs: list[dict[str, Any]], *, now: datetime | None = None) -> dict[str, Any]:
    """Independently prove that one exact main-push candidate attempt completed."""
    validate_selection_request(request)
    require(request.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "completed-run verification requires the candidate artifact class")
    require(request.event == RELEASE_EVENT and request.source_ref == RELEASE_SOURCE_REF and request.run_head_ref == RELEASE_SOURCE_REF, "completed candidate run is not the approved main push")
    require(request.producer_revision is not None, "completed candidate verification requires an independent producer revision")
    require(request.producer_revision == request.signer_revision, "candidate producer and signer revisions are not the same immutable workflow revision")
    validate_exact_run_attempt_request_metadata(run_metadata, request, now=now)
    require(run_metadata.get("status") == "completed", "candidate workflow attempt is not completed")
    require(run_metadata.get("conclusion") == "success", "candidate workflow attempt did not succeed")
    require("completed_at" not in run_metadata, "candidate workflow attempt uses an unsupported run-level completed_at field")
    updated_at = _parse_timestamp(run_metadata.get("updated_at"), "run.updated_at")
    require(isinstance(jobs, list) and 0 < len(jobs) <= MAX_ACTIONS_JOBS, "candidate exact-attempt jobs are missing or unbounded")
    by_name: dict[str, dict[str, Any]] = {}
    job_completion_times: list[datetime] = []
    for job in jobs:
        require(isinstance(job, dict), "candidate exact-attempt job is malformed")
        require(type(job.get("id")) is int and job["id"] > 0, "candidate exact-attempt job ID is malformed")
        require(job["id"] not in {existing.get("id") for existing in by_name.values()}, "candidate exact-attempt job ID is duplicated")
        name = require_string(job.get("name"), "job.name")
        require(name in CANDIDATE_REQUIRED_JOBS, f"unexpected or ambiguous candidate job: {name}")
        require(name not in by_name, f"candidate job is duplicated: {name}")
        require(job.get("status") == "completed" and job.get("conclusion") == "success", f"candidate mandatory job did not succeed: {name}")
        require(job.get("head_sha") == request.source_sha, f"candidate job head SHA does not match the exact main-push source: {name}")
        job_completion_times.append(_validate_job_chronology(job, run_metadata))
        steps = job.get("steps")
        require(isinstance(steps, list) and len(steps) <= 128, f"candidate job steps are missing or unbounded: {name}")
        step_by_name: dict[str, dict[str, Any]] = {}
        for step in steps:
            require(isinstance(step, dict), f"candidate job step is malformed: {name}")
            step_name = require_string(step.get("name"), "job.step.name")
            require(step_name not in step_by_name, f"candidate job step is duplicated: {name}/{step_name}")
            step_by_name[step_name] = step
            if step.get("name") in CANDIDATE_REQUIRED_JOBS[name]:
                require(step.get("status") == "completed" and step.get("conclusion") == "success", f"candidate mandatory step did not succeed: {name}/{step_name}")
        for step_name in CANDIDATE_REQUIRED_JOBS[name]:
            step = step_by_name.get(step_name)
            require(step is not None, f"candidate mandatory step is missing: {name}/{step_name}")
            require(step.get("status") == "completed" and step.get("conclusion") == "success", f"candidate mandatory step was skipped: {name}/{step_name}")
        by_name[name] = job
    require(set(by_name) == set(CANDIDATE_REQUIRED_JOBS), "candidate build, signing, and validation jobs are incomplete")
    return {
        "contract": CANDIDATE_VERIFICATION_CONTEXT_CONTRACT,
        "version": CANDIDATE_VERIFICATION_CONTEXT_VERSION,
        "authoritative": False,
        "independentlyCompleted": True,
        "run": {
            "id": request.run_id,
            "attempt": request.run_attempt,
            "status": run_metadata["status"],
            "conclusion": run_metadata["conclusion"],
            "createdAt": run_metadata["created_at"],
            "startedAt": run_metadata["run_started_at"],
            "updatedAt": run_metadata["updated_at"],
            "jobCompletionBoundary": max(job_completion_times).isoformat().replace("+00:00", "Z"),
        },
        "jobs": [
            {
                "id": job["id"],
                "runId": job["run_id"],
                "runAttempt": job["run_attempt"],
                "headSha": job["head_sha"],
                "name": job["name"],
                "status": job["status"],
                "conclusion": job["conclusion"],
                "startedAt": job["started_at"],
                "completedAt": job["completed_at"],
                "steps": [{"name": step["name"], "status": step["status"], "conclusion": step["conclusion"]} for step in job["steps"] if step["name"] in CANDIDATE_REQUIRED_JOBS[job["name"]]],
            }
            for job in sorted(by_name.values(), key=lambda item: item["name"])
        ],
    }


def _validate_candidate_workflow_identity(value: Any, identity: TrustedReleaseIdentity) -> None:
    """Bind retained producer/signer paths and revisions to the approved identity."""
    require(isinstance(value, dict) and set(value) == {"producerWorkflow", "producerRevision", "signerWorkflow", "signerRevision", "policy"}, "candidate verification context workflow identity is missing or malformed")
    require(value["producerWorkflow"] == identity.producer_workflow and value["signerWorkflow"] == identity.signer_workflow, "candidate verification context workflow path is contradictory")
    require(value["producerRevision"] == identity.producer_revision and value["signerRevision"] == identity.signer_revision, "candidate verification context workflow revision is contradictory")
    require(value["policy"] == "immutable-owner-allowlist", "candidate verification context workflow policy is contradictory")


def validate_candidate_verification_context(context: Any, identity: TrustedReleaseIdentity) -> None:
    """Validate retained completed-run context without treating it as authority."""
    validate_trusted_release_identity(identity)
    require(isinstance(context, dict), "candidate verification context must be an object")
    allowed_keys = {"contract", "version", "authoritative", "independentlyCompleted", "identitySha256", "sourceSha", "artifactClass", "run", "jobs", "attestation", "archiveValidation", "workflowIdentity", "verificationCompletedAt"}
    require(set(context).issubset(allowed_keys), "candidate verification context has unexpected evidence")
    require(context.get("contract") == CANDIDATE_VERIFICATION_CONTEXT_CONTRACT and context.get("version") == CANDIDATE_VERIFICATION_CONTEXT_VERSION, "candidate verification context contract is unsupported")
    require(context.get("authoritative") is False and context.get("independentlyCompleted") is True, "candidate verification context is not independent completed-run evidence")
    require(context.get("identitySha256") == _identity_fingerprint(identity) and context.get("sourceSha") == identity.source_sha and context.get("artifactClass") == identity.artifact_class, "candidate verification context is not bound to the exact candidate identity")
    run = context.get("run")
    require(isinstance(run, dict) and set(run) == {"id", "attempt", "status", "conclusion", "createdAt", "startedAt", "updatedAt", "jobCompletionBoundary"}, "candidate verification context run evidence is missing or malformed")
    require(type(run["id"]) is int and run["id"] == identity.run_id and type(run["attempt"]) is int and run["attempt"] == identity.run_attempt and run["status"] == "completed" and run["conclusion"] == "success", "candidate verification context run identity or completion is invalid")
    run_created = _parse_timestamp(run["createdAt"], "context.run.createdAt")
    run_started = _parse_timestamp(run["startedAt"], "context.run.startedAt")
    run_updated = _parse_timestamp(run["updatedAt"], "context.run.updatedAt")
    boundary = _parse_timestamp(run["jobCompletionBoundary"], "context.run.jobCompletionBoundary")
    require(run_created <= run_started <= run_updated, "candidate verification context run timestamp chronology is contradictory")
    jobs = context.get("jobs")
    require(isinstance(jobs, list) and len(jobs) == len(CANDIDATE_REQUIRED_JOBS), "candidate verification context jobs are incomplete")
    names: set[str] = set()
    job_ids: set[int] = set()
    completion_times: list[datetime] = []
    for job in jobs:
        require(isinstance(job, dict) and set(job) == {"id", "runId", "runAttempt", "headSha", "name", "status", "conclusion", "startedAt", "completedAt", "steps"}, "candidate verification context job evidence is missing or malformed")
        job_id = job["id"]
        require(type(job_id) is int and job_id > 0 and job_id not in job_ids, "candidate verification context job ID is duplicated or malformed")
        job_ids.add(job_id)
        name = require_string(job["name"], "context.job.name")
        require(name in CANDIDATE_REQUIRED_JOBS and name not in names, f"candidate verification context job is duplicated or unexpected: {name}")
        names.add(name)
        require(type(job["runId"]) is int and job["runId"] == identity.run_id and type(job["runAttempt"]) is int and job["runAttempt"] == identity.run_attempt and job["headSha"] == identity.source_sha and job["status"] == "completed" and job["conclusion"] == "success", f"candidate verification context job identity or completion is invalid: {name}")
        job_started = _parse_timestamp(job["startedAt"], f"context.jobs.{name}.startedAt")
        job_completed = _parse_timestamp(job["completedAt"], f"context.jobs.{name}.completedAt")
        require(run_created <= run_started <= job_started <= job_completed <= run_updated, f"candidate verification context job timestamp chronology is contradictory: {name}")
        completion_times.append(job_completed)
        steps = job["steps"]
        require(isinstance(steps, list) and len(steps) == len(CANDIDATE_REQUIRED_JOBS[name]), f"candidate verification context steps are missing or unbounded: {name}")
        step_names: set[str] = set()
        for step in steps:
            require(isinstance(step, dict) and set(step) == {"name", "status", "conclusion"}, f"candidate verification context step evidence is malformed: {name}")
            step_name = require_string(step["name"], f"context.jobs.{name}.step.name")
            require(step_name not in step_names, f"candidate verification context step is duplicated: {name}/{step_name}")
            step_names.add(step_name)
            require(step_name in CANDIDATE_REQUIRED_JOBS[name] and step["status"] == "completed" and step["conclusion"] == "success", f"candidate verification context mandatory step is contradictory: {name}/{step_name}")
        require(step_names == set(CANDIDATE_REQUIRED_JOBS[name]), f"candidate verification context mandatory steps are incomplete: {name}")
    require(names == set(CANDIDATE_REQUIRED_JOBS), "candidate verification context job set is incomplete")
    require(boundary == max(completion_times), "candidate verification context job completion boundary is not the exact maximum")
    if "workflowIdentity" in context:
        _validate_candidate_workflow_identity(context["workflowIdentity"], identity)
    if "verificationCompletedAt" in context:
        verification_completed = _parse_timestamp(context["verificationCompletedAt"], "context.verificationCompletedAt")
        require(verification_completed >= boundary, "candidate verification context verification completion is before mandatory job completion")


def independent_candidate_verification_context(context: dict[str, Any], identity: TrustedReleaseIdentity) -> tuple[dict[str, Any], str]:
    """Return canonical retained context bytes' digest for owner approval binding."""
    enriched = dict(context)
    enriched.update({"identitySha256": _identity_fingerprint(identity), "sourceSha": identity.source_sha, "artifactClass": identity.artifact_class})
    validate_candidate_verification_context(enriched, identity)
    encoded = _canonical_json(enriched)
    return enriched, hashlib.sha256(encoded + b"\n").hexdigest()


def load_owner_approval_context(path: Path, identity: TrustedReleaseIdentity) -> tuple[dict[str, Any], str, str]:
    """Load the exact retained context that is eligible for owner signing."""
    raw = _read_bounded_bytes(path, MAX_BUNDLE_BYTES, "independent candidate verification context")
    try:
        context = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"independent candidate verification context is malformed: {error}")
    require(raw == _canonical_json(context) + b"\n", "independent candidate verification context is not canonical")
    validate_candidate_verification_context(context, identity)
    require(set(context) == {"contract", "version", "authoritative", "independentlyCompleted", "identitySha256", "sourceSha", "artifactClass", "run", "jobs", "attestation", "archiveValidation", "workflowIdentity", "verificationCompletedAt"}, "independent candidate verification context has missing or unexpected evidence")
    attestation = context.get("attestation")
    require(isinstance(attestation, dict) and set(attestation) == {"status", "authenticated", "verifier", "verifierVersion", "subjectDigest"} and attestation.get("status") == "official-verifier-authenticated" and attestation.get("authenticated") is True and attestation.get("subjectDigest") == identity.archive_sha256, "independent context lacks authenticated official provenance")
    require_string(attestation["verifier"], "context.attestation.verifier")
    require_string(attestation["verifierVersion"], "context.attestation.verifierVersion")
    archive_validation = context.get("archiveValidation")
    require(isinstance(archive_validation, dict) and set(archive_validation) == {"status", "archiveName", "archiveSha256", "archiveBytes", "extracted"} and archive_validation.get("status") == "hardened-validated" and archive_validation.get("archiveName") == identity.archive_name and archive_validation.get("archiveSha256") == identity.archive_sha256 and archive_validation.get("archiveBytes") == identity.archive_bytes and archive_validation.get("extracted") is True, "independent context lacks hardened archive validation")
    require(type(archive_validation["archiveBytes"]) is int and archive_validation["archiveBytes"] > 0, "independent context archive validation bytes are malformed")
    _validate_candidate_workflow_identity(context.get("workflowIdentity"), identity)
    verification_completed_at = require_string(context.get("verificationCompletedAt"), "verificationCompletedAt")
    verified_at = _parse_timestamp(verification_completed_at, "verificationCompletedAt")
    boundary = _parse_timestamp(context["run"]["jobCompletionBoundary"], "run.jobCompletionBoundary")
    require(verified_at >= boundary, "independent verification chronology is before mandatory job completion")
    return context, hashlib.sha256(raw).hexdigest(), verification_completed_at


def verify_completed_candidate_selection(request: ArtifactSelectionRequest, *, service_zip_output: Path, attestation_bundle_output: Path, revision_allowlist: AuthorizationRevisionAllowlist, now: datetime | None = None) -> tuple[TrustedReleaseIdentity, ExactArtifactSelection, dict[str, Any], str]:
    """Owner-local intake: verify completion, provenance, archive contents, then retain context."""
    require(request.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "independent candidate intake requires the candidate artifact class")
    require(request.producer_revision is not None, "independent candidate intake requires an explicit producer revision")
    validate_authorization_revision_allowlist(revision_allowlist)
    require(request.producer_revision in revision_allowlist.producer_revisions and request.signer_revision in revision_allowlist.signer_revisions, "candidate workflow revisions are not in the immutable owner policy")
    require(revision_allowlist.producer_workflow == request.signer_workflow and revision_allowlist.signer_workflow == request.signer_workflow, "candidate workflow identity is not in the immutable owner policy")
    run_metadata = fetch_run_metadata(request.repository, request.run_id, request.run_attempt)
    jobs = fetch_exact_run_attempt_jobs(request.repository, request.run_id, request.run_attempt)
    completed_context = validate_completed_candidate_run(request, run_metadata, jobs, now=now)
    selection = select_artifact_request(request, service_zip_output=service_zip_output, now=now)
    identity = _candidate_identity_from_selection(request, selection)
    require(isinstance(run_metadata.get("name"), str) and run_metadata["name"] != "", "candidate workflow name is missing from exact run metadata")
    repository_metadata = run_metadata.get("repository")
    repository_visibility = ("private" if repository_metadata.get("private") is True else "public") if isinstance(repository_metadata, dict) else None
    require(repository_visibility in {"public", "private", "internal"}, "candidate repository visibility is missing from exact run metadata")
    with tempfile.TemporaryDirectory(prefix="clashcookies-candidate-intake-") as directory_name:
        directory = Path(directory_name)
        artifact_response = fetch_run_artifacts(request.repository, request.run_id)
        attestation_metadata = _select_attestation_artifact_metadata(artifact_response, request, run_metadata, now=(now or _now_utc()).astimezone(timezone.utc))
        attestation_zip = directory / "attestation-artifact.zip"
        _download_artifact_service_zip(request.repository, attestation_metadata["id"], attestation_zip, maximum_bytes=MAX_BUNDLE_BYTES, label="candidate attestation artifact")
        attestation_digest, attestation_bytes = _sha256_file(attestation_zip, MAX_BUNDLE_BYTES, "candidate attestation artifact")
        require(attestation_digest == require_digest(attestation_metadata["digest"], "attestation artifact.digest") and attestation_bytes == attestation_metadata["size_in_bytes"], "downloaded candidate attestation artifact does not match API identity")
        bundle = _extract_attestation_bundle(attestation_zip, directory / "attestation-bundle.json")
        _write_private_bytes(attestation_bundle_output, _read_bounded_bytes(bundle, MAX_BUNDLE_BYTES, "candidate attestation bundle"), "candidate attestation bundle output")
        expected = {
            "repository": request.repository,
            "repository_id": request.repository_id,
            "repository_owner_id": request.repository_owner_id,
            "repository_visibility": repository_visibility,
            "signer_workflow": request.signer_workflow,
            "signer_revision": request.signer_revision,
            "source_ref": request.source_ref,
            "source_sha": request.source_sha,
            "event": request.event,
            "workflow_name": run_metadata["name"],
            "run_id": request.run_id,
            "run_attempt": request.run_attempt,
            "pr_number": 0,
            "pr_head_sha": "",
            "pr_head_ref": "",
            "pr_base_sha": "",
            "pr_base_ref": "",
            "artifact_class": request.artifact_class,
            "platform": request.platform,
            "image": request.image,
            "image_digest": request.image_digest,
        }
        archive, _, _ = _extract_candidate_service_entries(service_zip_output, identity, directory)
        verified = run_gh_attestation_verify(
            archive,
            bundle=bundle,
            repository=request.repository,
            signer_workflow=request.signer_workflow,
            signer_revision=request.signer_revision,
            source_ref=request.source_ref,
            source_sha=request.source_sha,
        )
        authenticated = validate_verified_result(verified, archive_name=identity.archive_name, archive_digest=identity.archive_sha256, archive_bytes=identity.archive_bytes, expected=expected, run_metadata=run_metadata)
        validate_authenticated_provenance_binding(authenticated, identity)
        archive_workspace = directory / "archive-validation"
        archive_workspace.mkdir(mode=0o700)
        archive_validation = validate_candidate_archive_contents(service_zip_output, identity, run_metadata, workspace=archive_workspace)
        completed_context["attestation"] = {"status": "official-verifier-authenticated", "authenticated": True, "verifier": authenticated.receipt.tool, "verifierVersion": authenticated.receipt.version, "subjectDigest": authenticated.receipt.subject_digest}
        completed_context["archiveValidation"] = archive_validation
        completed_context["workflowIdentity"] = {"producerWorkflow": revision_allowlist.producer_workflow, "producerRevision": request.producer_revision, "signerWorkflow": revision_allowlist.signer_workflow, "signerRevision": request.signer_revision, "policy": "immutable-owner-allowlist"}
        completed_context["verificationCompletedAt"] = (now or _now_utc()).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    context, context_digest = independent_candidate_verification_context(completed_context, identity)
    return identity, selection, context, context_digest


def _sha256_file(path: Path, maximum: int, label: str) -> tuple[str, int]:
    """Hash a bounded regular file without following a symlink."""
    require_regular_bounded(path, maximum, label)
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            require(size <= maximum, f"{label} exceeds the size limit")
            digest.update(chunk)
    return digest.hexdigest(), size


def _open_nofollow_regular(path: Path, maximum: int, label: str) -> tuple[int, int]:
    """Open a bounded regular file without following symlinks where supported."""
    try:
        path_metadata = os.lstat(path)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    require(not stat.S_ISLNK(path_metadata.st_mode) and stat.S_ISREG(path_metadata.st_mode), f"{label} must be a regular non-symlink file")
    flags = os.O_RDONLY
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags)
        metadata = os.fstat(descriptor)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        fail(f"{label} is unavailable: {error}")
    try:
        require(metadata.st_dev == path_metadata.st_dev and metadata.st_ino == path_metadata.st_ino, f"{label} changed during open")
        require(stat.S_ISREG(metadata.st_mode), f"{label} must be a regular file")
        require(metadata.st_size > 0 and metadata.st_size <= maximum, f"{label} is empty or oversized")
    except Exception:
        os.close(descriptor)
        raise
    return descriptor, metadata.st_size


def open_zip_snapshot(path: Path, *, directory: Path | None = None) -> ZipSnapshot:
    """Copy a ZIP into a private file, then retain one descriptor for all reads."""
    source_fd, source_size = _open_nofollow_regular(path, MAX_ARTIFACT_BYTES, "artifact service ZIP")
    snapshot_path: Path | None = None
    snapshot_fd: int | None = None
    try:
        snapshot_fd, snapshot_name = tempfile.mkstemp(prefix=".runtime-artifact-zip-snapshot-", dir=str(directory) if directory is not None else None)
        snapshot_path = Path(snapshot_name)
        digest = hashlib.sha256()
        remaining = source_size
        while remaining:
            chunk = os.read(source_fd, min(1024 * 1024, remaining))
            require(chunk, "artifact service ZIP changed while snapshotting")
            written = 0
            while written < len(chunk):
                written += os.write(snapshot_fd, chunk[written:])
            digest.update(chunk)
            remaining -= len(chunk)
        os.fsync(snapshot_fd)
        os.fchmod(snapshot_fd, 0o600) if hasattr(os, "fchmod") else None
        snapshot_metadata = os.fstat(snapshot_fd)
        require(stat.S_ISREG(snapshot_metadata.st_mode) and snapshot_metadata.st_size == source_size, "artifact service ZIP snapshot identity mismatch")
        os.lseek(snapshot_fd, 0, os.SEEK_SET)
        return ZipSnapshot(snapshot_fd, snapshot_path, source_size, digest.hexdigest())
    except Exception:
        if snapshot_fd is not None:
            try:
                os.close(snapshot_fd)
            except OSError:
                pass
        if snapshot_path is not None:
            try:
                snapshot_path.unlink()
            except OSError:
                pass
        raise
    finally:
        os.close(source_fd)


def close_zip_snapshot(snapshot: ZipSnapshot) -> None:
    """Close and remove a private ZIP snapshot exactly once."""
    try:
        os.close(snapshot.fd)
    finally:
        try:
            snapshot.path.unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            fail(f"artifact service ZIP snapshot cleanup failed: {error}")


def _preflight_zip_snapshot(snapshot: ZipSnapshot) -> None:
    """Bound the ZIP central directory before constructing ZipFile."""
    read_size = min(snapshot.size, ZIP_EOCD_SEARCH_BYTES)
    tail = os.pread(snapshot.fd, read_size, snapshot.size - read_size) if hasattr(os, "pread") else _read_snapshot_bytes(snapshot, snapshot.size - read_size, read_size)
    offset = tail.rfind(b"PK\x05\x06")
    require(offset >= 0 and len(tail) - offset >= ZIP_EOCD_BYTES, "artifact service ZIP end record is missing")
    require(b"PK\x06\x06" not in tail and b"PK\x06\x07" not in tail, "ZIP64 records are unsupported")
    fields = struct.unpack_from("<4s4H2LH", tail, offset)
    _, disk, central_disk, entries_disk, entries_total, central_size, central_offset, comment_size = fields
    eocd_offset = snapshot.size - len(tail) + offset
    require(eocd_offset + ZIP_EOCD_BYTES + comment_size == snapshot.size, "artifact service ZIP EOCD placement or comment length is invalid")
    require(disk == 0 and central_disk == 0 and entries_disk == entries_total, "multi-disk or contradictory ZIP metadata is unsupported")
    require(entries_total <= MAX_ARTIFACT_ENTRIES, "artifact service ZIP entry count exceeds the limit")
    require(central_size <= MAX_ZIP_CENTRAL_DIRECTORY_BYTES, "artifact service ZIP central directory exceeds the limit")
    require(comment_size <= MAX_ZIP_COMMENT_BYTES, "artifact service ZIP comment exceeds the limit")
    require(entries_total != 0xFFFF and central_size != 0xFFFFFFFF and central_offset != 0xFFFFFFFF, "ZIP64 metadata is unsupported")
    require(central_offset + central_size == eocd_offset, "artifact service ZIP central directory placement is unsupported")
    central = _read_snapshot_bytes(snapshot, central_offset, central_size)
    position = 0
    for _ in range(entries_total):
        require(position + 46 <= len(central), "artifact service ZIP central directory is truncated")
        require(central[position:position + 4] == b"PK\x01\x02", "artifact service ZIP central directory header is invalid")
        name_size = int.from_bytes(central[position + 28:position + 30], "little")
        extra_size = int.from_bytes(central[position + 30:position + 32], "little")
        entry_comment_size = int.from_bytes(central[position + 32:position + 34], "little")
        require(name_size <= MAX_ZIP_ENTRY_NAME_BYTES, "artifact service ZIP entry name exceeds the limit")
        require(extra_size <= MAX_ZIP_EXTRA_BYTES and entry_comment_size <= MAX_ZIP_COMMENT_BYTES, "artifact service ZIP metadata exceeds the limit")
        record_size = 46 + name_size + extra_size + entry_comment_size
        require(position + record_size <= len(central), "artifact service ZIP central directory entry is truncated")
        position += record_size
    require(position == len(central), "artifact service ZIP central directory header count is contradictory")


def _read_snapshot_bytes(snapshot: ZipSnapshot, offset: int, size: int) -> bytes:
    """Read an exact range from the retained snapshot descriptor."""
    os.lseek(snapshot.fd, offset, os.SEEK_SET)
    chunks = []
    remaining = size
    while remaining:
        chunk = os.read(snapshot.fd, min(1024 * 1024, remaining))
        require(chunk, "artifact service ZIP snapshot ended unexpectedly")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _validate_artifact_metadata(artifact: dict[str, Any], request: ArtifactSelectionRequest, run_metadata: dict[str, Any], *, now: datetime) -> None:
    """Validate strict artifact fields and correlate them to the exact attempt."""
    require(type(artifact.get("id")) is int and artifact["id"] >= 1, "artifact ID is malformed")
    require(isinstance(artifact.get("name"), str), "artifact name is malformed")
    require(artifact.get("name") == request.artifact_name, "artifact name mismatch")
    require(require_digest(artifact.get("digest"), "artifact.digest"), "artifact digest is malformed")
    _require_bounded_int(artifact.get("size_in_bytes"), "artifact.size_in_bytes", 1, MAX_ARTIFACT_BYTES)
    require(artifact.get("expired") is False, "artifact is expired")
    created = _parse_timestamp(artifact.get("created_at"), "artifact.created_at")
    expires = _parse_timestamp(artifact.get("expires_at"), "artifact.expires_at")
    require(created <= expires and created <= now < expires, "artifact retention is stale, future-dated, or contradictory")
    run = artifact.get("workflow_run")
    require(isinstance(run, dict), "artifact workflow run metadata is missing")
    require(type(run.get("id")) is int and run["id"] == request.run_id, "artifact workflow run ID mismatch")
    require(type(run.get("repository_id")) is int and run["repository_id"] == request.repository_id, "artifact workflow repository ID mismatch")
    require(type(run.get("head_repository_id")) is int and run["head_repository_id"] == request.run_head_repository_id, "artifact head repository ID mismatch")
    require(run.get("head_branch") == request.run_head_ref.removeprefix("refs/heads/"), "artifact head branch mismatch")
    require(run.get("head_sha") == request.run_head_sha, "artifact head SHA mismatch")
    require(type(run_metadata.get("id")) is int and run_metadata["id"] == request.run_id, "artifact attempt correlation ID mismatch")
    run_started = _parse_timestamp(run_metadata.get("run_started_at"), "run.run_started_at")
    run_updated = _parse_timestamp(run_metadata.get("updated_at"), "run.updated_at")
    require(run_started <= created <= run_updated, "artifact creation time is outside the exact attempt window")


def _select_artifact_metadata(response: Any, request: ArtifactSelectionRequest, run_metadata: dict[str, Any], *, now: datetime) -> dict[str, Any]:
    """Select by exact identity only after complete response validation."""
    artifacts = validate_artifact_api_response(response)
    matches = [artifact for artifact in artifacts if artifact.get("name") == request.artifact_name]
    require(len(matches) == 1, "exact attempt-qualified artifact name is missing or ambiguous")
    artifact = matches[0]
    _validate_artifact_metadata(artifact, request, run_metadata, now=now)
    return artifact


def expected_attestation_artifact_name(run_id: int, run_attempt: int) -> str:
    """Return the exact workflow artifact carrying the published bundle."""
    require_int(run_id, "run_id", 1)
    require_int(run_attempt, "run_attempt", 1)
    return ATTESTATION_ARTIFACT_NAME_TEMPLATE.format(run_id=run_id, run_attempt=run_attempt)


def _select_attestation_artifact_metadata(response: Any, request: ArtifactSelectionRequest, run_metadata: dict[str, Any], *, now: datetime) -> dict[str, Any]:
    """Select the exact attestation upload from the same run/attempt."""
    artifacts = validate_artifact_api_response(response)
    expected_name = expected_attestation_artifact_name(request.run_id, request.run_attempt)
    matches = [artifact for artifact in artifacts if artifact.get("name") == expected_name]
    require(len(matches) == 1, "exact candidate attestation artifact is missing or ambiguous")
    artifact = matches[0]
    require(require_digest(artifact.get("digest"), "attestation artifact.digest"), "attestation artifact digest is malformed")
    require(type(artifact.get("size_in_bytes")) is int and 0 < artifact["size_in_bytes"] <= MAX_BUNDLE_BYTES, "attestation artifact size is invalid or oversized")
    require(artifact.get("expired") is False, "exact candidate attestation artifact is expired")
    workflow_run = artifact.get("workflow_run")
    require(isinstance(workflow_run, dict), "candidate attestation artifact workflow binding is missing")
    require(workflow_run.get("id") == request.run_id and workflow_run.get("repository_id") == request.repository_id and workflow_run.get("head_repository_id") == request.run_head_repository_id and workflow_run.get("head_sha") == request.run_head_sha, "candidate attestation artifact is not bound to the exact run")
    require(workflow_run.get("head_branch") == request.run_head_ref.removeprefix("refs/heads/"), "candidate attestation artifact head branch mismatch")
    created = _parse_timestamp(artifact.get("created_at"), "attestation artifact.created_at")
    updated = _parse_timestamp(run_metadata.get("updated_at"), "run.updated_at")
    require(created <= updated <= (now or _now_utc()).astimezone(timezone.utc), "candidate attestation artifact is outside the exact run/update boundary")
    return artifact


def _download_artifact_service_zip(repository: str, artifact_id: int, destination: Path, *, timeout_seconds: int = 90, maximum_bytes: int = MAX_ARTIFACT_BYTES, label: str = "artifact service ZIP") -> None:
    """Retrieve one exact Actions artifact ZIP through gh with bounded bytes."""
    require_int(artifact_id, "artifact_id", 1)
    require_int(maximum_bytes, "artifact maximum bytes", 1)
    require(not destination.exists(), "artifact service ZIP destination already exists")
    try:
        parent_metadata = os.lstat(destination.parent)
    except OSError as error:
        fail(f"artifact service ZIP destination parent is unavailable: {error}")
    require(stat.S_ISDIR(parent_metadata.st_mode) and not stat.S_ISLNK(parent_metadata.st_mode), "artifact service ZIP destination parent is unsafe")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    descriptor = os.open(destination, flags, 0o600)
    try:
        process = subprocess.Popen([_gh_executable(), "api", f"repos/{repository}/actions/artifacts/{artifact_id}/zip"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        os.close(descriptor)
        destination.unlink(missing_ok=True)
        raise
    assert process.stdout is not None and process.stderr is not None
    streams = (process.stdout, process.stderr)
    queues = (queue.Queue(maxsize=1), queue.Queue(maxsize=1))
    cancelled = threading.Event()
    readers: list[threading.Thread] = []

    def drain(stream: Any, output_queue: queue.Queue[bytes | None]) -> None:
        try:
            while not cancelled.is_set():
                chunk = stream.read(65536)
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

    for index, stream in enumerate(streams):
        reader = threading.Thread(name=f"runtime-artifact-zip-reader-{index}", target=drain, args=(stream, queues[index]), daemon=True)
        reader.start()
        readers.append(reader)
    deadline = time.monotonic() + timeout_seconds
    total = 0
    overflow = False
    stderr = bytearray()
    finished = [False, False]
    try:
        while True:
            if time.monotonic() > deadline:
                process.kill()
                raise subprocess.TimeoutExpired(process.args, timeout_seconds)
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
                    if index == 0:
                        total += len(item)
                        if total > maximum_bytes:
                            overflow = True
                            process.kill()
                            break
                        written = 0
                        while written < len(item):
                            written += os.write(descriptor, item[written:])
                    else:
                        stderr.extend(item)
                        if len(stderr) > MAX_VERIFIER_OUTPUT_BYTES:
                            process.kill()
                            fail("exact artifact ZIP retrieval stderr exceeds the limit")
                if overflow:
                    break
            if overflow:
                break
            if all(finished):
                break
            if not progress:
                time.sleep(0.005)
        return_code = process.wait(timeout=2)
        require(not overflow and total > 0, f"{label} output exceeded the limit or was empty")
        require(return_code == 0, f"exact {label} retrieval failed: {bytes(stderr).decode('utf-8', 'replace')[-400:]}")
        os.fsync(descriptor)
    except Exception:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=2)
        os.close(descriptor)
        descriptor = -1
        destination.unlink(missing_ok=True)
        raise
    finally:
        cancelled.set()
        if descriptor >= 0:
            os.close(descriptor)
        for stream in streams:
            stream.close()
        for reader in readers:
            reader.join(timeout=2)


def _extract_attestation_bundle(artifact_zip: Path, destination: Path) -> Path:
    """Extract exactly one bounded JSON bundle from the uploaded artifact ZIP."""
    snapshot = open_zip_snapshot(artifact_zip)
    try:
        _preflight_zip_snapshot(snapshot)
        with os.fdopen(os.dup(snapshot.fd), "rb", closefd=True) as stream, ZipFile(stream) as archive:
            candidates = [info for info in archive.infolist() if not info.is_dir() and info.filename.endswith(".json")]
            require(len(candidates) == 1, "candidate attestation artifact must contain exactly one JSON bundle")
            info = candidates[0]
            name = info.filename.replace("\\", "/")
            require(name == info.filename and not name.startswith("/") and ".." not in name.split("/"), "candidate attestation bundle path is unsafe")
            require(info.file_size <= MAX_BUNDLE_BYTES, "candidate attestation bundle exceeds the limit")
            payload = archive.read(info)
            require(len(payload) == info.file_size, "candidate attestation bundle was truncated")
            require(not destination.exists(), "candidate attestation bundle destination already exists")
            _write_private_bytes(destination, payload, "candidate attestation bundle")
            return destination
    finally:
        close_zip_snapshot(snapshot)


def inspect_artifact_service_zip_snapshot(snapshot: ZipSnapshot, archive_name: str, expected_digest: str | None = None, expected_bytes: int | None = None) -> tuple[str, int]:
    """Hash and parse one retained ZIP snapshot, never reopening its pathname."""
    _preflight_zip_snapshot(snapshot)
    try:
        with os.fdopen(os.dup(snapshot.fd), "rb", closefd=True) as stream:
            with ZipFile(stream) as archive:
                infos = archive.infolist()
                require(0 < len(infos) <= MAX_ARTIFACT_ENTRIES, "artifact service ZIP entry count is invalid")
                names: set[str] = set()
                expanded = 0
                inner = []
                for info in infos:
                    name = info.filename.replace("\\", "/")
                    require(name == info.filename and name not in names and not name.startswith("/") and ".." not in name.split("/"), "artifact service ZIP has an unsafe or duplicate path")
                    require(len(name.encode("utf-8")) <= MAX_ZIP_ENTRY_NAME_BYTES, "artifact service ZIP entry name exceeds the limit")
                    require(len(info.extra) <= MAX_ZIP_EXTRA_BYTES and len(info.comment) <= MAX_ZIP_COMMENT_BYTES, "artifact service ZIP metadata exceeds the limit")
                    require(info.file_size <= MAX_INNER_ARCHIVE_BYTES and info.compress_size <= MAX_ARTIFACT_BYTES, "artifact service ZIP entry exceeds the size limit")
                    expanded += info.file_size
                    require(expanded <= MAX_ZIP_EXPANDED_BYTES, "artifact service ZIP expanded size exceeds the limit")
                    names.add(name)
                    if name == archive_name:
                        inner.append(info)
                require(len(inner) == 1, "artifact service ZIP inner runtime archive is missing or ambiguous")
                info = inner[0]
                require(not info.is_dir(), "inner runtime archive is a directory")
                digest = hashlib.sha256()
                size = 0
                with archive.open(info, "r") as inner_stream:
                    while True:
                        chunk = inner_stream.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        require(size <= MAX_INNER_ARCHIVE_BYTES, "inner runtime archive exceeds the limit")
                        digest.update(chunk)
                result = digest.hexdigest()
                require(expected_digest is None or result == expected_digest, "inner runtime archive digest mismatch")
                require(expected_bytes is None or size == expected_bytes, "inner runtime archive byte count mismatch")
                return result, size
    except BadZipFile as error:
        fail(f"artifact service ZIP is malformed: {error}")


def verify_artifact_service_zip_snapshot(snapshot: ZipSnapshot, expected_digest: str, expected_bytes: int) -> None:
    """Verify outer service-ZIP bytes against independently supplied identity evidence."""
    require(snapshot.sha256 == require_digest(expected_digest, "expected artifact service ZIP digest"), "downloaded artifact service ZIP digest mismatch")
    require(snapshot.size == _require_bounded_int(expected_bytes, "expected artifact service ZIP bytes", 1, MAX_ARTIFACT_BYTES), "downloaded artifact service ZIP byte count mismatch")


def select_artifact_request(request: ArtifactSelectionRequest, *, service_zip_output: Path | None = None, service_zip: Path | None = None, now: datetime | None = None) -> ExactArtifactSelection:
    """Fetch, correlate, and optionally byte-verify one exact artifact."""
    validate_selection_request(request)
    run_metadata = fetch_run_metadata(request.repository, request.run_id, request.run_attempt)
    response = fetch_run_artifacts(request.repository, request.run_id)
    current = (now or _now_utc()).astimezone(timezone.utc)
    validate_exact_run_attempt_request_metadata(run_metadata, request, now=current)
    artifact = _select_artifact_metadata(response, request, run_metadata, now=current)
    require(service_zip_output is None or service_zip is None, "artifact service ZIP input and output are mutually exclusive")
    selected_path = service_zip
    downloaded = False
    if service_zip_output is not None:
        _download_artifact_service_zip(request.repository, artifact["id"], service_zip_output)
        selected_path = service_zip_output
        downloaded = True
    if selected_path is None:
        return ExactArtifactSelection(artifact["id"], artifact["name"], require_digest(artifact["digest"], "artifact.digest"), artifact["size_in_bytes"], request.archive_name, None, None, False)
    try:
        snapshot = open_zip_snapshot(selected_path)
    except Exception:
        if downloaded:
            selected_path.unlink(missing_ok=True)
        raise
    verified = False
    try:
        service_digest = snapshot.sha256
        service_bytes = snapshot.size
        verify_artifact_service_zip_snapshot(snapshot, artifact["digest"], artifact["size_in_bytes"])
        inner_digest, inner_bytes = inspect_artifact_service_zip_snapshot(snapshot, request.archive_name)
        verified = True
        return ExactArtifactSelection(artifact["id"], artifact["name"], service_digest, service_bytes, request.archive_name, inner_digest, inner_bytes, True)
    finally:
        close_zip_snapshot(snapshot)
        if downloaded and not verified:
            selected_path.unlink(missing_ok=True)


def inspect_artifact_service_zip(service_zip: Path, identity: TrustedReleaseIdentity) -> tuple[str, int]:
    """Read exactly one inner runtime archive from GitHub's artifact-service ZIP."""
    snapshot = open_zip_snapshot(service_zip)
    try:
        validate_trusted_release_identity(identity)
        verify_artifact_service_zip_snapshot(snapshot, identity.artifact_service_zip_sha256, identity.artifact_service_zip_bytes)
        return inspect_artifact_service_zip_snapshot(snapshot, identity.archive_name, identity.archive_sha256, identity.archive_bytes)
    finally:
        close_zip_snapshot(snapshot)


def _extract_candidate_service_entries(service_zip: Path, identity: TrustedReleaseIdentity, directory: Path) -> tuple[Path, Path, Path]:
    """Extract only the original archive and its two validator sidecars."""
    snapshot = open_zip_snapshot(service_zip, directory=directory)
    try:
        validate_trusted_release_identity(identity)
        verify_artifact_service_zip_snapshot(snapshot, identity.artifact_service_zip_sha256, identity.artifact_service_zip_bytes)
        inspect_artifact_service_zip_snapshot(snapshot, identity.archive_name, identity.archive_sha256, identity.archive_bytes)
        outputs: dict[str, Path] = {}
        with os.fdopen(os.dup(snapshot.fd), "rb", closefd=True) as stream, ZipFile(stream) as archive:
            expected_names = {identity.archive_name, f"{identity.archive_name}.sha256", f"{identity.archive_name}.manifest.json"}
            infos = {info.filename: info for info in archive.infolist()}
            require(expected_names.issubset(infos), "candidate artifact service ZIP is missing hardened-validation sidecars")
            for name in expected_names:
                info = infos[name]
                require(not info.is_dir() and name == name.replace("\\", "/") and not name.startswith("/") and ".." not in name.split("/"), "candidate artifact service ZIP contains an unsafe validator entry")
                maximum = identity.archive_bytes if name == identity.archive_name else MAX_BUNDLE_BYTES
                require(info.file_size <= maximum, "candidate validator entry exceeds its bound")
                target = directory / Path(name).name
                payload = archive.read(info)
                require(len(payload) == info.file_size, "candidate validator entry was truncated")
                _write_private_bytes(target, payload, f"candidate validator entry {name}")
                outputs[name] = target
        return outputs[identity.archive_name], outputs[f"{identity.archive_name}.sha256"], outputs[f"{identity.archive_name}.manifest.json"]
    finally:
        close_zip_snapshot(snapshot)


def _load_hardened_validator() -> Any:
    """Load the repository's hardened archive validator without a second contract."""
    path = Path(__file__).with_name("validate-runtime-artifact.py")
    spec = importlib.util.spec_from_file_location("clashcookies_owner_hardened_validator", path)
    require(spec is not None and spec.loader is not None, "hardened runtime-artifact validator cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def validate_candidate_archive_contents(service_zip: Path, identity: TrustedReleaseIdentity, run_metadata: dict[str, Any], *, workspace: Path) -> dict[str, Any]:
    """Run the existing checksum, manifest, preflight, and safe extraction boundary."""
    archive, checksum, manifest = _extract_candidate_service_entries(service_zip, identity, workspace)
    validator = _load_hardened_validator()
    limits = validator.Limits()
    snapshot = validator.snapshot_source(archive, limits, workspace_root=workspace)
    extraction = workspace / "extracted-runtime"
    try:
        validator.validate_checksum(archive, checksum, snapshot.digest)
        validator.preflight_metadata(snapshot, limits)
        entries, metadata_files, file_hashes = validator.collect_entries(snapshot, limits)
        embedded = validator.read_json_bytes(metadata_files["runtime-artifact-manifest.json"], "embedded manifest")
        external = validator.read_sidecar_json(manifest, limits, "published manifest")
        expected = validator.make_manifest_expectation(
            expected_sha=identity.source_sha,
            expected_platform=identity.platform,
            expected_repository=identity.repository,
            expected_repository_id=str(identity.repository_id),
            expected_repository_owner_id=str(identity.repository_owner_id),
            expected_workflow=run_metadata.get("name"),
            expected_run_id=str(identity.run_id),
            expected_run_attempt=str(identity.run_attempt),
            expected_event=identity.event,
            expected_source_ref=identity.source_ref,
            expected_artifact_class=identity.artifact_class,
            expected_signer_workflow=identity.signer_workflow,
            expected_signer_revision=identity.signer_revision,
            expected_base_image=identity.image,
            expected_base_image_digest=identity.image_digest,
        )
        require(isinstance(expected.expected_workflow, str) and expected.expected_workflow != "", "candidate run workflow name is missing")
        validator.validate_manifest(embedded, archive.name, snapshot.size, snapshot.digest, expected, embedded=True)
        validator.validate_manifest(external, archive.name, snapshot.size, snapshot.digest, expected, embedded=False)
        validator.compare_manifests(embedded, external)
        require(validator.archive_input_hashes(metadata_files, entries) == external["inputs"], "candidate archive input hashes do not match the manifest")
        validator.extract_archive(snapshot, entries, file_hashes, extraction, limits, snapshot.digest)
    finally:
        validator.cleanup_snapshot(snapshot)
    return {"status": "hardened-validated", "archiveName": identity.archive_name, "archiveSha256": identity.archive_sha256, "archiveBytes": identity.archive_bytes, "extracted": True}


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
    head_repository = metadata.get("head_repository")
    require(isinstance(head_repository, dict), "GitHub run metadata head repository evidence is missing")
    head_owner = head_repository.get("owner")
    require(
        str(head_repository.get("id")) == str(expected["repository_id"])
        and head_repository.get("full_name") == expected["repository"]
        and isinstance(head_owner, dict)
        and str(head_owner.get("id")) == str(expected["repository_owner_id"]),
        "GitHub run metadata head repository identity mismatch",
    )
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
        head_repo = head.get("repo")
        base_repo = base.get("repo")
        require(
            head.get("sha") == expected["pr_head_sha"]
            and head.get("ref") == expected["pr_head_ref"]
            and isinstance(head_repo, dict)
            and str(head_repo.get("id")) == str(expected["repository_id"]),
            "GitHub run metadata PR head association mismatch",
        )
        require(
            base.get("sha") == expected["pr_base_sha"]
            and base.get("ref") == expected["pr_base_ref"]
            and isinstance(base_repo, dict)
            and str(base_repo.get("id")) == str(expected["repository_id"]),
            "GitHub run metadata PR base association mismatch",
        )
        return {"number": expected["pr_number"], "headSha": expected["pr_head_sha"], "headRef": expected["pr_head_ref"], "baseSha": expected["pr_base_sha"], "baseRef": expected["pr_base_ref"]}
    require(metadata.get("head_sha") == expected["source_sha"], "GitHub run metadata dev-push SHA mismatch")
    expected_branch = expected["source_ref"].removeprefix("refs/heads/")
    require(metadata.get("head_branch") == expected_branch, "GitHub run metadata dev-push ref mismatch")
    return None


def validate_authenticated_expectation_context(expected: dict[str, Any]) -> None:
    """Reject candidate/dev class substitution before shared attestation verification."""
    require(isinstance(expected, dict), "authenticated provenance expectation must be an object")
    artifact_class = expected.get("artifact_class")
    source_ref = expected.get("source_ref")
    event = expected.get("event")
    require(artifact_class in {DEVELOPMENT_ARTIFACT_CLASS, PRODUCTION_CANDIDATE_ARTIFACT_CLASS}, "authenticated provenance artifact class is unsupported")
    if artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS:
        require(event == RELEASE_EVENT, "production candidate authenticated event must be push")
        require(source_ref == RELEASE_SOURCE_REF, "production candidate authenticated source ref must be main")
        require(expected.get("repository") == RELEASE_REPOSITORY, "production candidate authenticated repository is not approved")
        require(str(expected.get("repository_id")) == str(RELEASE_REPOSITORY_ID), "production candidate authenticated repository ID is not approved")
        require(str(expected.get("repository_owner_id")) == str(RELEASE_REPOSITORY_OWNER_ID), "production candidate authenticated owner ID is not approved")
        require(expected.get("signer_workflow") == RELEASE_SIGNER_WORKFLOW, "production candidate authenticated signer workflow is not approved")
        require(expected.get("platform") == RELEASE_PLATFORM, "production candidate authenticated platform is unsupported")
        require(expected.get("image") == RELEASE_IMAGE, "production candidate authenticated runtime image is not approved")
        require(expected.get("image_digest") == RELEASE_IMAGE.split("@", 1)[1], "production candidate authenticated runtime image digest is not approved")
    elif event == RELEASE_EVENT and source_ref == RELEASE_SOURCE_REF:
        require(False, "main push cannot be authenticated as development evidence")


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
    require_run_metadata: bool = True,
) -> AuthenticatedProvenance:
    """Validate verified certificate claims and bind them to one artifact contract."""
    validate_authenticated_expectation_context(expected)
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
    require(not require_run_metadata or run_metadata is not None, "authenticated GitHub Actions run metadata is required")
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
        run_metadata_independently_checked=run_metadata is not None,
    )


def _candidate_identity_from_selection(request: ArtifactSelectionRequest, selection: ExactArtifactSelection) -> TrustedReleaseIdentity:
    """Build the candidate-shaped identity only after exact byte selection."""
    require(request.artifact_class == PRODUCTION_CANDIDATE_ARTIFACT_CLASS, "candidate evidence requires the production-candidate artifact class")
    require(request.authorization_context == CANDIDATE_EVIDENCE_AUTHORIZATION_CONTEXT, "candidate evidence authorization context is invalid")
    require(type(selection.byte_verified) is bool and selection.byte_verified is True, "candidate evidence requires byte-verified artifact selection")
    require(selection.archive_sha256 is not None and selection.archive_bytes is not None, "candidate evidence selection is missing inner archive identity")
    identity = TrustedReleaseIdentity(
        repository=request.repository,
        repository_id=request.repository_id,
        repository_owner_id=request.repository_owner_id,
        source_ref=request.source_ref,
        source_sha=request.source_sha,
        event=request.event,
        producer_workflow=RELEASE_PRODUCER_WORKFLOW,
        producer_revision=request.producer_revision or request.signer_revision,
        signer_workflow=request.signer_workflow,
        signer_revision=request.signer_revision,
        run_id=request.run_id,
        run_attempt=request.run_attempt,
        artifact_id=selection.artifact_id,
        artifact_name=selection.artifact_name,
        artifact_class=request.artifact_class,
        artifact_service_zip_sha256=selection.artifact_service_zip_sha256,
        artifact_service_zip_bytes=selection.artifact_service_zip_bytes,
        archive_name=selection.archive_name,
        archive_sha256=selection.archive_sha256,
        archive_bytes=selection.archive_bytes,
        platform=request.platform,
        image=request.image,
        image_digest=request.image_digest,
        authorization_context=request.authorization_context,
    )
    validate_trusted_release_identity(identity)
    return identity


def _validate_candidate_provenance_diagnostic(value: Any, identity: TrustedReleaseIdentity) -> dict[str, Any]:
    """Check serialized provenance as bounded evidence, never as an authority token."""
    require(isinstance(value, dict), "candidate authenticated provenance evidence must be an object")
    require(value.get("contract") == PROVENANCE_CONTRACT and value.get("contractVersion") == PROVENANCE_CONTRACT_VERSION, "candidate provenance contract is unsupported")
    require(value.get("status") == "verified-provenance-only" and value.get("authenticated") is True, "candidate provenance is not authenticated evidence")
    subject = value.get("subject")
    require(isinstance(subject, dict) and subject.get("name") == identity.archive_name and subject.get("sha256") == identity.archive_sha256 and subject.get("bytes") == identity.archive_bytes and subject.get("artifactClass") == identity.artifact_class, "candidate provenance subject identity mismatch")
    source = value.get("source")
    require(isinstance(source, dict) and source.get("repository") == identity.repository and str(source.get("repositoryId")) == str(identity.repository_id) and source.get("ref") == identity.source_ref and source.get("gitSha") == identity.source_sha and source.get("event") == identity.event, "candidate provenance source identity mismatch")
    signer = value.get("signer")
    require(isinstance(signer, dict) and signer.get("workflow") == identity.signer_workflow and signer.get("revision") == identity.signer_revision and signer.get("runner") == GITHUB_HOSTED_RUNNER, "candidate provenance signer identity mismatch")
    run = value.get("run")
    require(isinstance(run, dict) and run.get("id") == identity.run_id and run.get("attempt") == identity.run_attempt, "candidate provenance run identity mismatch")
    build = value.get("build")
    require(isinstance(build, dict) and build.get("platform") == identity.platform and build.get("image") == identity.image and build.get("imageDigest") == identity.image_digest, "candidate provenance build identity mismatch")
    verification = value.get("verification")
    require(isinstance(verification, dict), "candidate provenance verification evidence is missing")
    for field in ("subjectDigestAuthenticated", "certificateClaimsAuthenticated", "predicateClaimsWorkflowControlled", "runMetadataIndependentlyChecked"):
        require(verification.get(field) is True, f"candidate provenance verification evidence is incomplete: {field}")
    eligibility = value.get("productionEligibility")
    require(isinstance(eligibility, dict) and eligibility.get("eligible") is False and eligibility.get("authoritative") is False, "candidate provenance must remain production-ineligible and non-authoritative")
    return value


def build_candidate_evidence(
    request: ArtifactSelectionRequest,
    selection: ExactArtifactSelection,
    provenance_diagnostic: Any,
    validation_diagnostic: Any,
) -> dict[str, Any]:
    """Return bounded handoff evidence for later independent authorization."""
    identity = _candidate_identity_from_selection(request, selection)
    provenance_evidence = _validate_candidate_provenance_diagnostic(provenance_diagnostic, identity)
    require(isinstance(validation_diagnostic, dict), "candidate validation evidence must be an object")
    require(validation_diagnostic.get("sha256") == identity.archive_sha256 and validation_diagnostic.get("archiveBytes") == identity.archive_bytes and validation_diagnostic.get("sourceSha") == identity.source_sha, "candidate validation evidence identity mismatch")
    authenticated = validation_diagnostic.get("authenticatedProvenance")
    require(isinstance(authenticated, dict), "candidate validation evidence is missing authenticated provenance")
    _validate_candidate_provenance_diagnostic({**authenticated, "productionEligibility": provenance_evidence["productionEligibility"]}, identity)
    measurements = validation_diagnostic.get("measurements")
    require(isinstance(measurements, dict), "candidate validation measurements are missing")
    return {
        "contract": CANDIDATE_EVIDENCE_CONTRACT,
        "version": CANDIDATE_EVIDENCE_VERSION,
        "authoritative": False,
        "productionEligible": False,
        "authorizationRequired": True,
        "bearerCredential": False,
        "authorizationContext": identity.authorization_context,
        "identity": {
            "repository": identity.repository,
            "repositoryId": identity.repository_id,
            "repositoryOwnerId": identity.repository_owner_id,
            "sourceRef": identity.source_ref,
            "sourceSha": identity.source_sha,
            "event": identity.event,
            "producerWorkflow": identity.producer_workflow,
            "producerRevision": identity.producer_revision,
            "signerWorkflow": identity.signer_workflow,
            "signerRevision": identity.signer_revision,
            "runId": identity.run_id,
            "runAttempt": identity.run_attempt,
            "artifactId": identity.artifact_id,
            "artifactName": identity.artifact_name,
            "artifactClass": identity.artifact_class,
            "artifactServiceZipSha256": identity.artifact_service_zip_sha256,
            "artifactServiceZipBytes": identity.artifact_service_zip_bytes,
            "archiveName": identity.archive_name,
            "archiveSha256": identity.archive_sha256,
            "archiveBytes": identity.archive_bytes,
            "platform": identity.platform,
            "image": identity.image,
            "imageDigest": identity.image_digest,
        },
        "selection": {
            "byteVerified": True,
            "artifactId": selection.artifact_id,
            "artifactName": selection.artifact_name,
            "artifactServiceZipSha256": selection.artifact_service_zip_sha256,
            "artifactServiceZipBytes": selection.artifact_service_zip_bytes,
            "archiveName": selection.archive_name,
            "archiveSha256": selection.archive_sha256,
            "archiveBytes": selection.archive_bytes,
        },
        "authenticatedProvenance": provenance_evidence,
        "validation": {
            "sha256": validation_diagnostic["sha256"],
            "archiveBytes": validation_diagnostic["archiveBytes"],
            "sourceSha": validation_diagnostic["sourceSha"],
            "extractedFootprintBytes": validation_diagnostic.get("extractedFootprintBytes"),
            "measurements": measurements,
        },
        "limitations": [
            "This record is non-authoritative evidence, not a trusted-root input or bearer credential.",
            "Subsequent authorization and delivery must independently verify successful completion of the exact producer and validation run.",
            "The current workflow does not observe its own completed run and does not authorize production eligibility.",
        ],
    }


def candidate_evidence_request_from_json(value: Any) -> dict[str, Any]:
    """Parse and validate the bounded inputs used to emit candidate handoff evidence."""
    require(isinstance(value, dict) and set(value) == {"selectionRequest", "selection", "provenance", "validation"}, "candidate evidence request is malformed")
    request = selection_request_from_json(value["selectionRequest"])
    selected = value["selection"]
    require(isinstance(selected, dict), "candidate evidence selection is malformed")
    fields = {"artifactId", "artifactName", "artifactServiceZipSha256", "artifactServiceZipBytes", "archiveName", "archiveSha256", "archiveBytes", "byteVerified"}
    require("byteVerified" in selected, "candidate evidence byteVerified is required")
    require(set(selected) == fields, "candidate evidence selection fields are incomplete")
    require(type(selected["byteVerified"]) is bool and selected["byteVerified"] is True, "candidate evidence byteVerified must be exactly true")
    try:
        selection = ExactArtifactSelection(
            artifact_id=selected["artifactId"], artifact_name=selected["artifactName"],
            artifact_service_zip_sha256=selected["artifactServiceZipSha256"], artifact_service_zip_bytes=selected["artifactServiceZipBytes"],
            archive_name=selected["archiveName"], archive_sha256=selected["archiveSha256"], archive_bytes=selected["archiveBytes"],
            byte_verified=selected["byteVerified"],
        )
    except TypeError as error:
        fail(f"candidate evidence selection is malformed: {error}")
    return {"request": request, "selection": selection, "provenance": value["provenance"], "validation": value["validation"]}


def evaluate_production_eligibility(
    provenance: object,
    expected: object,
    authorization: object | None,
    *,
    revision_allowlist: AuthorizationRevisionAllowlist | None = None,
    now: datetime | None = None,
) -> EligibilityResult:
    """Refuse production unconditionally while the authorization-only boundary is staged."""
    if not isinstance(provenance, AuthenticatedProvenance):
        return EligibilityResult(False, "unverifiable-provenance", False, "serialized or unverified provenance cannot authorize production")
    if provenance.artifact_class not in {PRODUCTION_ARTIFACT_CLASS, PRODUCTION_CANDIDATE_ARTIFACT_CLASS}:
        return EligibilityResult(False, "development-artifact-class", False, "development artifact is not production eligible")
    if not isinstance(expected, TrustedReleaseIdentity):
        return EligibilityResult(False, "missing-trusted-release-identity", False, "trusted expected release identity is not available")
    if not isinstance(authorization, IndependentReleaseAuthorization):
        return EligibilityResult(False, "missing-independent-authorization", False, "independent release authorization is required")
    try:
        validate_trusted_release_identity(expected)
    except ProvenanceError as error:
        return EligibilityResult(False, "invalid-release-identity", False, str(error))
    try:
        validate_independent_authorization(authorization, expected, revision_allowlist=revision_allowlist, now=now)
    except ProvenanceError as error:
        detail = str(error)
        if "recovery authorization" in detail:
            return EligibilityResult(False, "recovery-authorization-required", False, detail)
        if "stale" in detail or "not yet valid" in detail:
            return EligibilityResult(False, "stale-independent-authorization", False, detail)
        return EligibilityResult(False, "invalid-independent-authorization", False, detail)
    if authorization.scope != "forward-release":
        return EligibilityResult(False, "recovery-authorization-required", False, "recovery authorization is separate and cannot authorize a forward release")
    try:
        validate_authenticated_provenance_binding(provenance, expected)
    except ProvenanceError as error:
        return EligibilityResult(False, "provenance-identity-mismatch", False, str(error))
    return EligibilityResult(False, "production-eligibility-disabled", False, "production eligibility is unconditionally disabled in the authorization-only slice")


def evaluate_synthetic_production_policy_fixture(fixture: dict[str, Any]) -> EligibilityResult:
    """Evaluate an explicitly synthetic policy fixture without making it authoritative."""
    if fixture.get("fixtureKind") != "synthetic-production-policy" or fixture.get("synthetic") is not True:
        return EligibilityResult(False, "invalid-synthetic-fixture", False, "production fixtures must be explicitly synthetic")
    return EligibilityResult(True, "synthetic-policy-fixture", False, "synthetic policy result is non-authoritative and cannot authorize production")


def selection_request_from_json(value: Any) -> ArtifactSelectionRequest:
    """Parse a bounded, non-authoritative exact-selection request."""
    require(isinstance(value, dict), "artifact selection request must be an object")
    fields = (
        "repository", "repository_id", "repository_owner_id", "source_ref", "source_sha", "event",
        "signer_workflow", "signer_revision", "run_id", "run_attempt", "artifact_name", "artifact_class",
        "archive_name", "platform", "image", "image_digest", "authorization_context", "run_head_repository",
        "run_head_repository_id", "run_head_repository_owner_id", "run_head_ref", "run_head_sha",
        "pull_request_number", "pull_request_head_sha", "pull_request_head_ref", "pull_request_base_sha", "pull_request_base_ref",
    )
    allowed = set(fields) | {"producer_revision"}
    require(set(value).issubset(allowed) and set(fields).issubset(value), "artifact selection request has missing or unexpected fields")
    try:
        request = ArtifactSelectionRequest(**{field: value[field] for field in fields}, producer_revision=value.get("producer_revision"))
    except TypeError as error:
        fail(f"artifact selection request is malformed: {error}")
    validate_selection_request(request)
    return request


def parse_args() -> argparse.Namespace:
    """Parse the synthetic policy-fixture command-line interface."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluate-synthetic-policy", action="store_true")
    parser.add_argument("--fixture")
    parser.add_argument("--selection-request")
    parser.add_argument("--selection-service-zip")
    parser.add_argument("--selection-download-service-zip")
    parser.add_argument("--candidate-evidence-request")
    parser.add_argument("--candidate-evidence-output")
    parser.add_argument("--verify-completed-candidate", action="store_true")
    parser.add_argument("--candidate-verification-context-output")
    parser.add_argument("--candidate-identity-output")
    parser.add_argument("--candidate-service-zip-output")
    parser.add_argument("--candidate-attestation-bundle-output")
    parser.add_argument("--prepare-authorization", action="store_true")
    parser.add_argument("--authorization-output")
    parser.add_argument("--authorization-identity")
    parser.add_argument("--authorization-id")
    parser.add_argument("--authorization-issued-at")
    parser.add_argument("--authorization-expires-at")
    parser.add_argument("--authorization-key-id")
    parser.add_argument("--authorization-scope", default="forward-release")
    parser.add_argument("--authorization-recovery-context")
    parser.add_argument("--authorization-verification-context")
    parser.add_argument("--authorization-destination")
    parser.add_argument("--authorization-public-key")
    parser.add_argument("--authorization-repository-root")
    parser.add_argument("--authorization-key-fingerprint")
    parser.add_argument("--authorization-allowlist")
    parser.add_argument("--assemble-authorization", action="store_true")
    parser.add_argument("--authorization-record")
    parser.add_argument("--authorization-signature")
    return parser.parse_args()


def main() -> int:
    """Evaluate only an explicitly synthetic policy fixture for diagnostics."""
    args = parse_args()
    if args.prepare_authorization:
        require(args.authorization_output and args.authorization_id and args.authorization_issued_at and args.authorization_expires_at and args.authorization_key_id and args.authorization_identity and args.authorization_verification_context and args.authorization_destination, "authorization preparation requires identity, verified context, approved destination, output, lifecycle, and key fields")
        identity_path = args.authorization_identity
        identity_value = _read_bounded_json(Path(identity_path), "authorization identity")
        require(isinstance(identity_value, dict) and set(identity_value) == set(TrustedReleaseIdentity.__dataclass_fields__), "authorization identity is malformed")
        identity = TrustedReleaseIdentity(**identity_value)
        _context, context_digest, verification_completed_at = load_owner_approval_context(Path(args.authorization_verification_context), identity)
        record = prepare_owner_authorization_record(identity, authorization_id=args.authorization_id, issued_at=args.authorization_issued_at, expires_at=args.authorization_expires_at, signing_key_id=args.authorization_key_id, scope=args.authorization_scope, recovery_context=args.authorization_recovery_context, verification_context_sha256=context_digest, delivery_destination=args.authorization_destination, verification_completed_at=verification_completed_at)
        Path(args.authorization_output).write_bytes(_canonical_json(record))
        print(json.dumps({"prepared": True, "signed": False, "recordSha256": hashlib.sha256(_canonical_json(record)).hexdigest()}, indent=2))
        return 0
    if args.assemble_authorization:
        require(args.authorization_record and args.authorization_signature and args.authorization_output and args.authorization_key_id and args.authorization_identity and args.authorization_public_key and args.authorization_key_fingerprint and args.authorization_allowlist, "authorization assembly requires record, signature, identity, trust key, fingerprint, allowlist, key ID, and output")
        record = _read_bounded_json(Path(args.authorization_record), "authorization record")
        signature = _read_bounded_bytes(Path(args.authorization_signature), 64, "authorization detached signature")
        envelope = assemble_owner_authorization_envelope(record, signature, args.authorization_key_id)
        identity_value = _read_bounded_json(Path(args.authorization_identity), "authorization identity")
        require(isinstance(identity_value, dict) and set(identity_value) == set(TrustedReleaseIdentity.__dataclass_fields__), "authorization identity is malformed")
        identity = TrustedReleaseIdentity(**identity_value)
        allowlist = authorization_revision_allowlist_from_json(_read_bounded_json(Path(args.authorization_allowlist), "authorization revision allowlist"))
        trust = AuthorizationTrustConfig(Path(args.authorization_public_key), args.authorization_key_id, args.authorization_key_fingerprint, Path(args.authorization_repository_root).resolve() if args.authorization_repository_root else Path(args.authorization_identity).resolve().parent)
        verify_signed_authorization_record(envelope, trust, identity, allowlist)
        Path(args.authorization_output).write_bytes(_canonical_json(envelope) + b"\n")
        print(json.dumps({"prepared": False, "assembled": True, "signed": True, "verified": True, "recordSha256": hashlib.sha256(_canonical_json(record)).hexdigest()}, indent=2))
        return 0
    if args.candidate_evidence_request:
        require(args.candidate_evidence_output is not None, "candidate evidence output is required")
        parsed = candidate_evidence_request_from_json(_read_bounded_json(Path(args.candidate_evidence_request), "candidate evidence request"))
        evidence = build_candidate_evidence(parsed["request"], parsed["selection"], parsed["provenance"], parsed["validation"])
        Path(args.candidate_evidence_output).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"authoritative": False, "productionEligible": False, "candidateEvidence": True}, indent=2))
        return 0
    if args.verify_completed_candidate:
        require(args.selection_request and args.candidate_service_zip_output and args.candidate_attestation_bundle_output and args.candidate_verification_context_output and args.candidate_identity_output, "completed candidate verification requires selection request, ZIP, attestation bundle, context output, and identity output")
        request = selection_request_from_json(_read_bounded_json(Path(args.selection_request), "candidate selection request"))
        require(args.authorization_allowlist, "completed candidate verification requires an immutable authorization revision allowlist")
        allowlist = authorization_revision_allowlist_from_json(_read_bounded_json(Path(args.authorization_allowlist), "authorization revision allowlist"))
        identity, selection, context, context_digest = verify_completed_candidate_selection(request, service_zip_output=Path(args.candidate_service_zip_output), attestation_bundle_output=Path(args.candidate_attestation_bundle_output), revision_allowlist=allowlist)
        Path(args.candidate_identity_output).write_bytes(_canonical_json(_authorization_identity_payload(identity)) + b"\n")
        Path(args.candidate_verification_context_output).write_bytes(_canonical_json(context) + b"\n")
        print(json.dumps({"authoritative": False, "independentlyCompleted": True, "identitySha256": _identity_fingerprint(identity), "verificationContextSha256": context_digest, "selection": {"artifactId": selection.artifact_id, "artifactName": selection.artifact_name, "artifactServiceZipSha256": selection.artifact_service_zip_sha256, "artifactServiceZipBytes": selection.artifact_service_zip_bytes, "archiveName": selection.archive_name, "archiveSha256": selection.archive_sha256, "archiveBytes": selection.archive_bytes}}, indent=2))
        return 0
    if args.selection_request:
        request = selection_request_from_json(_read_bounded_json(Path(args.selection_request), "artifact selection request"))
        require(args.selection_service_zip is None or args.selection_download_service_zip is None, "selection ZIP input and download are mutually exclusive")
        selected = select_artifact_request(request, service_zip=Path(args.selection_service_zip) if args.selection_service_zip else None, service_zip_output=Path(args.selection_download_service_zip) if args.selection_download_service_zip else None)
        print(json.dumps({"authoritative": False, "byteVerified": selected.byte_verified, "selection": {"artifactId": selected.artifact_id, "artifactName": selected.artifact_name, "artifactServiceZipSha256": selected.artifact_service_zip_sha256, "artifactServiceZipBytes": selected.artifact_service_zip_bytes, "archiveName": selected.archive_name, "archiveSha256": selected.archive_sha256, "archiveBytes": selected.archive_bytes}}, indent=2))
        return 0
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
