#!/usr/bin/env python3
"""Trusted, bounded Docker lifecycle for a prepared immutable runtime.

This is deliberately a consumer of the provenance, retention, preparation,
and activation transaction owners.  It does not issue authority, select a
release, or own active/previous pointers.  Docker is inspected through
argument-vector subprocesses only; a privileged host actor remains outside
this boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import durable_activation_transaction as activation
import durable_artifact_retention as retention
import immutable_runtime_preparation as preparation
import runtime_artifact_provenance as provenance


LIFECYCLE_CONTRACT = "clashcookies.immutable-runtime-lifecycle"
LIFECYCLE_VERSION = 1
MAX_DOCKER_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_HEALTH_BYTES = 256 * 1024
DEFAULT_DOCKER_TIMEOUT_SECONDS = 30.0
DEFAULT_STOP_TIMEOUT_SECONDS = 20.0
DEFAULT_HEALTH_TIMEOUT_SECONDS = 30.0
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class LifecycleError(RuntimeError):
    """Raised when exact runtime identity or bounded lifecycle safety fails."""


def _fail(message: str) -> None:
    raise LifecycleError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _canonical(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as error:
        _fail(f"lifecycle evidence is not canonical JSON: {error}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256_file(path: Path) -> str:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        os.close(descriptor)
        return digest.hexdigest()
    except OSError as error:
        _fail(f"runtime configuration cannot be read safely: {error}")


def _verify_owned_tree(root: Path) -> None:
    """Recheck ownership and symlink safety immediately before every run."""
    _require(root.is_absolute() and root.is_dir() and not root.is_symlink(), "prepared runtime root is unavailable")
    expected_uid = os.geteuid() if hasattr(os, "geteuid") else None
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        metadata = os.lstat(current_path)
        _require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode), f"prepared runtime directory is unsafe: {current_path}")
        if expected_uid is not None:
            _require(metadata.st_uid == expected_uid, f"prepared runtime ownership changed: {current_path}")
        for name in [*directories, *files]:
            path = current_path / name
            item = os.lstat(path)
            if expected_uid is not None:
                _require(item.st_uid == expected_uid, f"prepared runtime ownership changed: {path}")
            if stat.S_ISLNK(item.st_mode):
                target = os.readlink(path)
                _require(target and not os.path.isabs(target) and "\\" not in target, f"prepared runtime symlink is unsafe: {path}")
            else:
                _require(stat.S_ISREG(item.st_mode) or stat.S_ISDIR(item.st_mode), f"prepared runtime entry is unsafe: {path}")


def _safe_env_file(path: Path | None, tx: activation.ActivationTransaction) -> tuple[Path | None, str]:
    if path is None:
        return None, hashlib.sha256(b"{}").hexdigest()
    _require(path.is_absolute() and path.is_file() and not path.is_symlink(), "runtime configuration file is unavailable")
    for root, label in ((tx.prepared_root, "prepared runtime"), (tx.store.root, "retention"), (tx.store.repository_root, "mutable checkout"), (tx.trusted_root, "trusted root")):
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError:
            continue
        _fail(f"runtime configuration must remain outside the {label}")
    if os.name == "posix":
        metadata = os.lstat(path)
        _require(metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "runtime configuration file is not private")
    return path, _sha256_file(path)


@dataclass(frozen=True)
class LifecycleConfig:
    """External runtime configuration; no secrets are copied into artifacts."""

    container_name: str
    network: str
    host_port: int
    env_file: Path | None = None
    health_host: str = "127.0.0.1"
    health_path: str = "/healthz"
    health_provenance: str = "application"
    allow_fixture_commit: bool = False
    stop_timeout_seconds: float = DEFAULT_STOP_TIMEOUT_SECONDS
    docker_timeout_seconds: float = DEFAULT_DOCKER_TIMEOUT_SECONDS
    health_timeout_seconds: float = DEFAULT_HEALTH_TIMEOUT_SECONDS
    poll_interval_seconds: float = 0.05

    def validate(self) -> None:
        _require(_NAME_RE.fullmatch(self.container_name) is not None, "lifecycle container name is invalid")
        _require(bool(self.network) and not any(character in self.network for character in "\r\n"), "lifecycle network is invalid")
        _require(type(self.host_port) is int and 1 <= self.host_port <= 65535, "lifecycle host port is invalid")
        _require(self.health_path.startswith("/") and "?" not in self.health_path and "#" not in self.health_path, "lifecycle health path is invalid")
        for value, label in ((self.stop_timeout_seconds, "stop"), (self.docker_timeout_seconds, "Docker"), (self.health_timeout_seconds, "health"), (self.poll_interval_seconds, "poll")):
            _require(type(value) in {int, float} and 0 < value <= 300, f"{label} timeout is out of bounds")
        _require(self.health_provenance in {"application", "fixture"}, "health provenance is invalid")
        _require(type(self.allow_fixture_commit) is bool, "fixture commit policy is invalid")


@dataclass(frozen=True)
class RuntimeExecutionContract:
    operation_id: str
    release_id: str
    preparation_metadata_sha256: str | None
    runtime_root: Path
    runtime_integrity: dict[str, Any]
    image: str
    image_digest: str
    image_id: str
    platform: str
    configuration_sha256: str
    env_file: Path | None
    command: tuple[str, ...] = ("node", "/app/dist/ClashCookies.js")


class DockerClient:
    """Small, sanitised Docker CLI adapter with no shell interpolation."""

    def __init__(self, *, executable: str = "docker", runner: Callable[..., subprocess.CompletedProcess[str]] | None = None):
        self.executable = executable
        self.runner = runner or subprocess.run

    def run(self, arguments: list[str], *, timeout: float) -> subprocess.CompletedProcess[str]:
        _require(all(isinstance(argument, str) and "\x00" not in argument and "\r" not in argument and "\n" not in argument for argument in arguments), "Docker argument vector is malformed")
        try:
            result = self.runner([self.executable, *arguments], capture_output=True, text=True, timeout=timeout, check=False, shell=False)
        except subprocess.TimeoutExpired as error:
            _fail(f"Docker operation timed out: {arguments[:3]}")
        except OSError as error:
            _fail(f"Docker operation is unavailable: {error}")
        _require(isinstance(result.stdout, str) and len(result.stdout) <= MAX_DOCKER_OUTPUT_BYTES, "Docker output exceeded its bound")
        _require(isinstance(result.stderr, str) and len(result.stderr) <= MAX_DOCKER_OUTPUT_BYTES, "Docker error output exceeded its bound")
        return result

    def json(self, arguments: list[str], *, timeout: float) -> dict[str, Any]:
        result = self.run(arguments, timeout=timeout)
        _require(result.returncode == 0, f"Docker inspection failed: {arguments[:4]}")
        try:
            value = json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            _fail(f"Docker inspection is malformed: {error}")
        _require(isinstance(value, dict), "Docker inspection is not an object")
        return value

    def inspect_container(self, container: str, *, timeout: float) -> dict[str, Any]:
        return self.json(["container", "inspect", "--format", "{{json .}}", container], timeout=timeout)

    def inspect_image(self, image: str, *, platform: str | None, timeout: float) -> dict[str, Any]:
        arguments = ["image", "inspect"]
        if platform:
            arguments.extend(["--platform", platform])
        arguments.extend(["--format", "{{json .}}", image])
        return self.json(arguments, timeout=timeout)

    def container_ids(self, *, name: str | None = None, timeout: float) -> list[str]:
        arguments = ["container", "ls", "-aq", "--no-trunc"]
        if name is not None:
            arguments.extend(["--filter", f"name=^{name}$"])
        result = self.run(arguments, timeout=timeout)
        _require(result.returncode == 0, "Docker container discovery failed")
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

    def stop(self, container_id: str, seconds: int, *, timeout: float) -> subprocess.CompletedProcess[str]:
        return self.run(["container", "stop", "--time", str(seconds), container_id], timeout=timeout)


def _image_identity(client: DockerClient, identity: dict[str, Any], *, expected_id: str | None, timeout: float) -> dict[str, Any]:
    _require(identity.get("image") == provenance.RELEASE_IMAGE and identity.get("platform") == provenance.RELEASE_PLATFORM, "candidate image or platform is not the approved pinned contract")
    expected_digest = provenance.RELEASE_IMAGE.split("@", 1)[1]
    _require(identity.get("image_digest") == expected_digest, "candidate image digest is not bound to the approved image")
    # Resolve the exact pinned local reference without asking Docker to select
    # a manifest-list child again.  Docker can return a platform-qualified
    # inspection ID that differs from the image ID recorded on a container
    # started from the already-pulled digest reference.  The explicit
    # architecture/OS checks below retain the platform boundary.
    inspected = client.inspect_image(provenance.RELEASE_IMAGE, platform=None, timeout=timeout)
    image_id = inspected.get("Id")
    _require(isinstance(image_id, str) and image_id.startswith("sha256:"), "local pinned image ID is unavailable")
    if expected_id is not None:
        _require(image_id == expected_id, "local pinned image ID changed")
    repo_digests = inspected.get("RepoDigests")
    _require(isinstance(repo_digests, list) and any(isinstance(item, str) and item.endswith("@" + expected_digest) for item in repo_digests), "local image is not bound to the approved digest")
    _require(inspected.get("Architecture") == "amd64" and inspected.get("Os") == "linux", "local pinned image platform is incompatible")
    return {"image": provenance.RELEASE_IMAGE, "image_id": image_id, "image_digest": expected_digest, "platform": provenance.RELEASE_PLATFORM}


class ImmutableRuntimeLifecycle:
    """Execute one exact activation operation under the existing transaction."""

    def __init__(self, transaction: activation.ActivationTransaction, config: LifecycleConfig, *, docker: DockerClient | None = None):
        config.validate()
        self.transaction = transaction
        self.config = config
        self.docker = docker or DockerClient()
        self._env_file, self._configuration_sha256 = _safe_env_file(config.env_file, transaction)

    def _operation(self, operation_id: str) -> dict[str, Any]:
        operation = self.transaction.store.load()["activation_operations"].get(operation_id)
        _require(isinstance(operation, dict), "activation operation is unknown")
        return operation

    def _candidate_contract(self, operation_id: str, *, expected_image_id: str | None = None) -> RuntimeExecutionContract:
        operation = self._operation(operation_id)
        identity, _, evidence, metadata = self.transaction._read_prepared_candidate_evidence(operation["candidate_release"], operation["preparation_metadata_sha256"])
        preparation._verify_existing_preparation(evidence.preparation_path.parent, identity, operation["candidate_release"], self.transaction.store.root / f"release-{operation['candidate_release']}" / "artifact-service.zip", self.transaction.run_metadata, expected_metadata_sha256=operation["preparation_metadata_sha256"], durable=self.transaction.store.require_durable)
        runtime_root = evidence.preparation_path.parent / "runtime"
        _verify_owned_tree(runtime_root)
        actual_integrity = preparation._integrity(runtime_root)
        _require(actual_integrity == evidence.runtime_integrity, "prepared runtime integrity changed immediately before execution")
        for required in (runtime_root / "dist" / "ClashCookies.js", runtime_root / "node_modules", runtime_root / "prisma" / "schema.prisma"):
            _require(required.exists() and not required.is_symlink(), f"prepared compiled runtime component is missing: {required.name}")
        image = _image_identity(self.docker, identity, expected_id=expected_image_id, timeout=self.config.docker_timeout_seconds)
        return RuntimeExecutionContract(operation_id=operation_id, release_id=operation["candidate_release"], preparation_metadata_sha256=operation["preparation_metadata_sha256"], runtime_root=runtime_root, runtime_integrity=actual_integrity, image=image["image"], image_digest=image["image_digest"], image_id=image["image_id"], platform=image["platform"], configuration_sha256=self._configuration_sha256, env_file=self._env_file)

    def _legacy_contract(self, operation_id: str) -> RuntimeExecutionContract:
        operation = self._operation(operation_id)
        baseline = self.transaction.store.legacy_baseline_status()
        _require(baseline.get("status") == "preserved-verified" and baseline.get("authenticated") is False, "preserved unauthenticated legacy baseline is unavailable")
        runtime_root = Path(str(baseline["runtime_path"]))
        _verify_owned_tree(runtime_root)
        integrity = preparation._integrity(runtime_root, maximum_bytes=preparation.MAX_LEGACY_BYTES, maximum_entries=preparation.MAX_LEGACY_ENTRIES)
        _require(integrity == baseline["integrity"], "preserved legacy runtime integrity changed")
        image_observation = preparation._verify_legacy_image_available(baseline["identity"])
        return RuntimeExecutionContract(operation_id=operation_id, release_id=retention.LEGACY_BASELINE_ID, preparation_metadata_sha256=None, runtime_root=runtime_root, runtime_integrity=integrity, image=str(image_observation["image"]), image_digest=str(image_observation["digest"]), image_id=str(image_observation["image_id"]), platform=str(image_observation["platform"]), configuration_sha256=self._configuration_sha256, env_file=self._env_file)

    def _run_arguments(self, contract: RuntimeExecutionContract) -> list[str]:
        arguments = ["run", "--detach", "--pull=never", "--platform", contract.platform, "--name", self.config.container_name, "--restart", "no", "--init", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--network", self.config.network, "--label", "com.clashcookies.runtime=immutable", "--label", f"com.clashcookies.activation-operation={contract.operation_id}", "--label", f"com.clashcookies.release={contract.release_id}", "--label", f"com.clashcookies.preparation={contract.preparation_metadata_sha256 or 'legacy'}", "--publish", f"127.0.0.1:{self.config.host_port}:8080", "--env", f"BUILD_SHA={contract.release_id}", "--env", f"CLASHCOOKIES_RUNTIME_IDENTITY_SHA256={contract.release_id}", "--env", f"CLASHCOOKIES_PREPARATION_METADATA_SHA256={contract.preparation_metadata_sha256 or 'legacy'}", "--env", f"CLASHCOOKIES_ACTIVATION_OPERATION_ID={contract.operation_id}", "--env", f"CLASHCOOKIES_HEALTH_PROVENANCE={self.config.health_provenance}"]
        if contract.env_file is not None:
            arguments.extend(["--env-file", str(contract.env_file)])
        arguments.extend(["--workdir", "/app", "--volume", f"{contract.runtime_root}:/app:ro", contract.image, *contract.command])
        return arguments

    def _mounts(self, inspected: dict[str, Any]) -> list[dict[str, Any]]:
        mounts = inspected.get("Mounts")
        _require(isinstance(mounts, list), "container mount inventory is unavailable")
        result: list[dict[str, Any]] = []
        for mount in mounts:
            _require(isinstance(mount, dict) and isinstance(mount.get("Destination"), str), "container mount evidence is malformed")
            destination = mount["Destination"]
            _require(destination in {"/app", "/tmp", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf"}, "container has an unauthorized mount")
            if destination == "/app":
                _require(mount.get("Type") == "bind" and mount.get("RW") is False, "runtime artifact mount is not read-only")
            result.append({key: mount.get(key) for key in ("Type", "Source", "Destination", "RW", "Name") if key in mount})
        app_mounts = [item for item in result if item.get("Destination") == "/app"]
        _require(len(app_mounts) == 1, "runtime artifact mount is missing or ambiguous")
        return sorted(result, key=lambda item: str(item.get("Destination")))

    def _inspect_exact(self, container_id: str, contract: RuntimeExecutionContract, *, require_running: bool) -> tuple[dict[str, Any], dict[str, Any]]:
        inspected = self.docker.inspect_container(container_id, timeout=self.config.docker_timeout_seconds)
        _require(inspected.get("Id") == container_id or str(inspected.get("Id", "")).startswith(container_id), "container identity is not exact")
        _require(inspected.get("Image") == contract.image_id, "container image ID is not the approved local image")
        state = inspected.get("State")
        _require(isinstance(state, dict), "container state is unavailable")
        if require_running:
            _require(state.get("Running") is True and state.get("Restarting") is not True, "candidate container is not running")
        config = inspected.get("Config")
        _require(isinstance(config, dict), "container configuration is unavailable")
        labels = config.get("Labels") or inspected.get("Config", {}).get("Labels") or {}
        _require(isinstance(labels, dict) and labels.get("com.clashcookies.runtime") == "immutable" and labels.get("com.clashcookies.activation-operation") == contract.operation_id and labels.get("com.clashcookies.release") == contract.release_id, "container labels are not the exact lifecycle binding")
        _require(list(config.get("Cmd") or []) == list(contract.command) and not (config.get("Entrypoint") or []), "container command is not the migration-independent compiled entry point")
        mounts = self._mounts(inspected)
        app_mount = next(item for item in mounts if item.get("Destination") == "/app")
        _require(Path(str(app_mount.get("Source"))).resolve() == contract.runtime_root.resolve(), "container runtime mount source is substituted")
        restart_name = str((inspected.get("HostConfig") or {}).get("RestartPolicy", {}).get("Name", ""))
        _require(restart_name in {"", "no"}, "candidate automatic restart policy is not disabled")
        pid = int(state.get("Pid", 0))
        started_at = state.get("StartedAt")
        _require(isinstance(started_at, str) and started_at, "container process incarnation is unavailable")
        return inspected, {"container_id": str(inspected.get("Id")), "image_id": contract.image_id, "process_incarnation": {"pid": pid, "started_at": started_at}, "mounts": mounts, "configuration_sha256": contract.configuration_sha256}

    def _evidence(self, phase: str, subject: str, subject_release: str, contract: RuntimeExecutionContract, container: dict[str, Any], *, health: dict[str, Any]) -> dict[str, Any]:
        _require(subject in {"candidate", "rollback-target"} and isinstance(subject_release, str), "runtime evidence subject is invalid")
        return {"contract": "clashcookies.immutable-runtime-observation", "version": 1, "operation_id": contract.operation_id, "phase": phase, "candidate_release": self._operation(contract.operation_id)["candidate_release"], "subject": subject, "subject_release": subject_release, "preparation_metadata_sha256": self._operation(contract.operation_id)["preparation_metadata_sha256"], "target_preparation_metadata_sha256": contract.preparation_metadata_sha256 if subject == "rollback-target" else None, "runtime_integrity": contract.runtime_integrity, "container_id": container["container_id"], "image_id": container["image_id"], "image_digest": contract.image_digest, "platform": contract.platform, "process_incarnation": container["process_incarnation"], "mounts": container["mounts"], "configuration_sha256": container["configuration_sha256"], "health": health, "observed_at": _now()}

    def _health(self, contract: RuntimeExecutionContract, expected_container: dict[str, Any]) -> dict[str, Any]:
        url = f"http://{self.config.health_host}:{self.config.host_port}{self.config.health_path}"
        deadline = time.monotonic() + self.config.health_timeout_seconds
        last_error: Exception | None = None
        raw = b""
        status = 0
        payload: Any = None
        while time.monotonic() < deadline:
            request = Request(url, method="GET", headers={"Accept": "application/json"})
            try:
                with urlopen(request, timeout=min(2.0, max(0.1, deadline - time.monotonic()))) as response:
                    raw = response.read(MAX_HEALTH_BYTES + 1)
                    status = response.status
                _require(len(raw) <= MAX_HEALTH_BYTES, "runtime health response exceeded its bound")
                payload = json.loads(raw.decode("utf-8"))
                if status == 200 and isinstance(payload, dict) and payload.get("status") == "ok":
                    break
                last_error = LifecycleError("runtime reported not-ready")
            except (HTTPError, URLError, TimeoutError, OSError, UnicodeDecodeError, json.JSONDecodeError, LifecycleError) as error:
                last_error = error
            time.sleep(min(self.config.poll_interval_seconds, max(0.0, deadline - time.monotonic())))
        _require(status == 200 and isinstance(payload, dict) and payload.get("status") == "ok", f"runtime health is not fresh and healthy: {last_error}")
        runtime = payload.get("runtime")
        expected_preparation = contract.preparation_metadata_sha256 or "legacy"
        _require(isinstance(runtime, dict) and runtime.get("runtime_identity_sha256") == contract.release_id and runtime.get("preparation_metadata_sha256") == expected_preparation and runtime.get("operation_id") == contract.operation_id, "health response is not bound to the exact runtime operation")
        return {"provenance": self.config.health_provenance, "status": "healthy", "http_status": status, "response_sha256": hashlib.sha256(raw).hexdigest(), "runtime": {"runtime_identity_sha256": runtime.get("runtime_identity_sha256"), "preparation_metadata_sha256": runtime.get("preparation_metadata_sha256"), "operation_id": runtime.get("operation_id")}, "checked_at": _now()}

    def _active_containers(self) -> list[dict[str, Any]]:
        containers: list[dict[str, Any]] = []
        for container_id in self.docker.container_ids(timeout=self.config.docker_timeout_seconds):
            try:
                inspected = self.docker.inspect_container(container_id, timeout=self.config.docker_timeout_seconds)
            except LifecycleError:
                _fail("container inventory changed during singleton inspection")
            state = inspected.get("State") or {}
            config = inspected.get("Config") or {}
            labels = config.get("Labels") or {}
            ports = ((inspected.get("NetworkSettings") or {}).get("Ports") or {})
            has_target_port = any(isinstance(values, list) and any(str(item.get("HostPort")) == str(self.config.host_port) for item in values if isinstance(item, dict)) for values in ports.values())
            if state.get("Running") is True or state.get("Restarting") is True or labels.get("com.clashcookies.runtime") in {"active", "immutable"} or has_target_port:
                containers.append(inspected)
        return containers

    def _expected_incumbent_id(self, operation: dict[str, Any]) -> str:
        release = operation["incumbent_release"] or retention.LEGACY_BASELINE_ID
        if release == retention.LEGACY_BASELINE_ID:
            baseline = self.transaction.store.legacy_baseline_status()
            observation = (baseline.get("identity") or {}).get("container_observation") or {}
            value = observation.get("container_id")
        else:
            value = None
            state = self.transaction.store.load()
            for item in state["activation_operations"].values():
                if item.get("candidate_release") == release and item.get("phase") == "successful-activation":
                    evidence = (item.get("observations") or {}).get("candidate-health-verified", {}).get("evidence", {})
                    value = evidence.get("container_id")
        _require(isinstance(value, str) and value, "exact incumbent container identity is not durably known")
        return value

    def _stop_exact(self, container_id: str, *, expected_release: str) -> dict[str, Any]:
        candidates = self._active_containers()
        exact = [item for item in candidates if str(item.get("Id", "")).startswith(container_id)]
        _require(len(exact) == 1, "active incumbent is missing, multiple, or unknown")
        inspected = exact[0]
        labels = ((inspected.get("Config") or {}).get("Labels") or {})
        if expected_release != retention.LEGACY_BASELINE_ID:
            _require(labels.get("com.clashcookies.release") == expected_release, "incumbent release identity conflicts with the pointer")
        restart_policy = str(((inspected.get("HostConfig") or {}).get("RestartPolicy") or {}).get("Name", ""))
        if restart_policy not in {"", "no"}:
            result = self.docker.run(["container", "update", "--restart", "no", container_id], timeout=self.config.docker_timeout_seconds)
            _require(result.returncode == 0, "incumbent automatic resurrection could not be disabled")
        state = inspected.get("State") or {}
        if state.get("Running") is True or state.get("Restarting") is True:
            try:
                result = self.docker.stop(container_id, max(1, int(self.config.stop_timeout_seconds)), timeout=self.config.stop_timeout_seconds + self.config.docker_timeout_seconds)
            except LifecycleError:
                result = None
            if result is not None and result.returncode != 0:
                # A non-zero Docker result is recoverable only when a fresh
                # inspection proves the exact container is absent from active state.
                pass
            refreshed = self.docker.inspect_container(container_id, timeout=self.config.docker_timeout_seconds)
            refreshed_state = refreshed.get("State") or {}
            _require(refreshed_state.get("Running") is not True and refreshed_state.get("Restarting") is not True, "incumbent stop outcome is ambiguous")
        refreshed = self.docker.inspect_container(container_id, timeout=self.config.docker_timeout_seconds)
        refreshed_state = refreshed.get("State") or {}
        _require(refreshed_state.get("Running") is not True and refreshed_state.get("Restarting") is not True, "incumbent remains active after bounded stop")
        return {"container_id": str(refreshed.get("Id")), "image_id": str(refreshed.get("Image")), "process_incarnation": {"pid": int(refreshed_state.get("Pid", 0)), "started_at": str(refreshed_state.get("StartedAt", ""))}, "mounts": [], "configuration_sha256": self._configuration_sha256}

    def _run_candidate(self, operation_id: str, contract: RuntimeExecutionContract) -> tuple[str, dict[str, Any]]:
        existing = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
        if existing:
            _require(len(existing) == 1, "candidate container name has multiple occupants")
            try:
                inspected, evidence = self._inspect_exact(existing[0], contract, require_running=False)
            except LifecycleError:
                _fail("candidate container name is occupied by an unknown container")
            if (inspected.get("State") or {}).get("Running") is not True:
                started = self.docker.run(["container", "start", str(inspected["Id"])], timeout=self.config.docker_timeout_seconds)
                _require(started.returncode == 0, "exact interrupted candidate could not be started")
                inspected, evidence = self._inspect_exact(str(inspected["Id"]), contract, require_running=True)
            return str(inspected["Id"]), evidence
        try:
            result = self.docker.run(self._run_arguments(contract), timeout=self.config.docker_timeout_seconds)
        except LifecycleError as error:
            possible = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
            _require(len(possible) == 1, f"candidate start outcome is ambiguous and no safe adoption is possible: {error}")
            try:
                inspected, evidence = self._inspect_exact(possible[0], contract, require_running=False)
            except LifecycleError:
                _fail(f"candidate start outcome is ambiguous and the partial container is not exact: {error}")
            if (inspected.get("State") or {}).get("Running") is not True:
                started = self.docker.run(["container", "start", str(inspected["Id"])], timeout=self.config.docker_timeout_seconds)
                _require(started.returncode == 0, "exact partial candidate could not be reconciled")
                inspected, evidence = self._inspect_exact(str(inspected["Id"]), contract, require_running=True)
            return str(inspected["Id"]), evidence
        container_id = result.stdout.strip() if result.returncode == 0 else ""
        if not container_id:
            possible = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
            _require(len(possible) == 1, "candidate start outcome is ambiguous and no safe adoption is possible")
            container_id = possible[0]
        inspected, evidence = self._inspect_exact(container_id, contract, require_running=True)
        return str(inspected["Id"]), evidence

    def activate(self, operation_id: str, *, activation_envelope: dict[str, Any] | None = None) -> dict[str, Any]:
        """Run a forward activation already bound by ActivationTransaction.begin()."""
        operation = self._operation(operation_id)
        if operation["phase"] in {"validated-intent", "authorization-consumption-pending"}:
            _require(activation_envelope is not None, "forward activation authorization is required")
            if operation["phase"] == "validated-intent":
                self.transaction.consume(operation_id, activation_envelope)
            else:
                self.transaction.reconcile(operation_id, activation_envelope)
            operation = self._operation(operation_id)
        with self.transaction.lifecycle_lock():
            operation = self._operation(operation_id)
            _require(operation["phase"] in {"authorization-consumed", "incumbent-stop-intent", "incumbent-stop-observed", "candidate-start-intent", "candidate-start-observed", "candidate-health-verified"}, "activation is not at a resumable lifecycle phase")
            if operation["phase"] == "authorization-consumed":
                self.transaction.advance(operation_id, "incumbent-stop-intent", assume_locked=True)
                operation = self._operation(operation_id)
            incumbent_release = operation["incumbent_release"] or retention.LEGACY_BASELINE_ID
            incumbent_id = self._expected_incumbent_id(operation)
            if operation["phase"] == "incumbent-stop-intent":
                stopped = self._stop_exact(incumbent_id, expected_release=incumbent_release)
                incumbent_evidence = {}
                if incumbent_release == retention.LEGACY_BASELINE_ID:
                    baseline = self.transaction.store.legacy_baseline_status()
                    incumbent_evidence = (baseline.get("identity") or {}).get("container_observation") or {}
                    incumbent_integrity = baseline.get("integrity")
                    incumbent_digest = (baseline.get("identity") or {}).get("image_digest")
                else:
                    for prior in self.transaction.store.load()["activation_operations"].values():
                        if prior.get("candidate_release") == incumbent_release and prior.get("phase") == "successful-activation":
                            incumbent_evidence = (prior.get("observations") or {}).get("candidate-health-verified", {}).get("evidence", {})
                    incumbent_integrity = incumbent_evidence.get("runtime_integrity")
                    incumbent_digest = incumbent_evidence.get("image_digest")
                _require(isinstance(incumbent_integrity, dict) and set(incumbent_integrity) == {"tree_sha256", "bytes", "entries"}, "incumbent runtime integrity evidence is unavailable")
                _require(isinstance(incumbent_digest, str) and incumbent_digest.startswith("sha256:"), "incumbent image digest evidence is unavailable")
                evidence = {"contract": "clashcookies.immutable-runtime-observation", "version": 1, "operation_id": operation_id, "phase": "incumbent-stop-observed", "candidate_release": operation["candidate_release"], "subject": "incumbent", "subject_release": incumbent_release, "preparation_metadata_sha256": operation["preparation_metadata_sha256"], "target_preparation_metadata_sha256": None, "runtime_integrity": incumbent_integrity, "container_id": stopped["container_id"], "image_id": stopped["image_id"], "image_digest": incumbent_digest, "platform": "linux/amd64", "process_incarnation": stopped["process_incarnation"], "mounts": [], "configuration_sha256": stopped["configuration_sha256"], "health": {"provenance": "docker-inspection", "status": "stopped"}, "observed_at": _now()}
                self.transaction.observe_runtime(operation_id, phase="incumbent-stop-observed", outcome="stopped", evidence=evidence, assume_locked=True)
                operation = self._operation(operation_id)
            if operation["phase"] == "incumbent-stop-observed":
                self.transaction.advance(operation_id, "candidate-start-intent", assume_locked=True)
                operation = self._operation(operation_id)
            contract = self._candidate_contract(operation_id)
            if operation["phase"] == "candidate-start-intent":
                container_id, started = self._run_candidate(operation_id, contract)
                evidence = self._evidence("candidate-start-observed", "candidate", operation["candidate_release"], contract, started, health={"provenance": "docker-inspection", "status": "started"})
                self.transaction.observe_runtime(operation_id, phase="candidate-start-observed", outcome="started", evidence=evidence, assume_locked=True)
                operation = self._operation(operation_id)
            if operation["phase"] in {"candidate-start-observed", "candidate-health-verified"}:
                expected = contract
                ids = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
                _require(len(ids) == 1, "candidate container identity is missing or ambiguous before health")
                container, inspected = self._inspect_exact(ids[0], expected, require_running=True)
                health = self._health(expected, inspected)
                container_after = self.docker.inspect_container(ids[0], timeout=self.config.docker_timeout_seconds)
                _require(container_after.get("Id") == container.get("Id") and container_after.get("Image") == expected.image_id and (container_after.get("State") or {}).get("StartedAt") == (container.get("State") or {}).get("StartedAt"), "candidate identity changed between health and commit")
                evidence = self._evidence("candidate-health-verified", "candidate", operation["candidate_release"], expected, inspected, health=health)
                self.transaction.observe_runtime(operation_id, phase="candidate-health-verified", outcome="healthy", evidence=evidence, assume_locked=True)
                _require(self.config.health_provenance == "application" or self.config.allow_fixture_commit, "fixture health cannot publish an activation pointer without explicit test policy")
                self.transaction.advance(operation_id, "successful-activation", assume_locked=True)
            return self._operation(operation_id)

    def restart_committed(self, operation_id: str) -> dict[str, Any]:
        """Explicitly restart the exact committed runtime; automatic restart is disabled."""
        with self.transaction.lifecycle_lock():
            operation = self._operation(operation_id)
            _require(operation["phase"] == "successful-activation" and self.transaction.store.load()["active_release"] == operation["candidate_release"], "restart requires the exact committed active operation")
            prior = (operation["observations"] or {}).get("candidate-health-verified", {}).get("evidence", {})
            expected_image_id = prior.get("image_id")
            contract = self._candidate_contract(operation_id, expected_image_id=expected_image_id)
            ids = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
            _require(len(ids) == 1, "committed runtime container is missing or ambiguous")
            current, _ = self._inspect_exact(ids[0], contract, require_running=True)
            self._stop_exact(str(current["Id"]), expected_release=operation["candidate_release"])
            result = self.docker.run(["container", "rm", str(current["Id"])], timeout=self.config.docker_timeout_seconds)
            _require(result.returncode == 0, "exact committed runtime could not be removed after bounded stop")
            _, started = self._run_candidate(operation_id, contract)
            ids = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
            _require(len(ids) == 1, "restarted committed runtime identity is ambiguous")
            _, inspected = self._inspect_exact(ids[0], contract, require_running=True)
            health = self._health(contract, inspected)
            evidence = self._evidence("candidate-health-verified", "candidate", operation["candidate_release"], contract, inspected, health=health)
            self.transaction.observe_runtime(operation_id, phase="candidate-health-verified", outcome="healthy", evidence=evidence, assume_locked=True)
            return self._operation(operation_id)

    def rollback(self, operation_id: str, recovery_envelope: dict[str, Any]) -> dict[str, Any]:
        """Execute separately authorized compensation or post-activation recovery."""
        self.transaction.begin_rollback(operation_id, recovery_envelope)
        self.transaction.consume_rollback(operation_id, recovery_envelope)
        with self.transaction.lifecycle_lock():
            operation = self._operation(operation_id)
            _require(operation["phase"] == "rollback-intent", "rollback is not at its durable intent boundary")
            candidate = self._candidate_contract(operation_id)
            ids = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
            _require(len(ids) == 1, "displaced candidate container is missing or ambiguous")
            current, _ = self._inspect_exact(ids[0], candidate, require_running=True)
            self._stop_exact(str(current["Id"]), expected_release=operation["candidate_release"])
            removed = self.docker.run(["container", "rm", str(current["Id"])], timeout=self.config.docker_timeout_seconds)
            _require(removed.returncode == 0, "displaced candidate containment is incomplete")
            target_release = operation["rollback_target"] or retention.LEGACY_BASELINE_ID
            target = self._legacy_contract(operation_id) if target_release == retention.LEGACY_BASELINE_ID else self._authenticated_target_contract(operation_id, target_release)
            _, started = self._run_candidate(operation_id, target)
            ids = self.docker.container_ids(name=self.config.container_name, timeout=self.config.docker_timeout_seconds)
            _require(len(ids) == 1, "rollback target container identity is ambiguous")
            _, inspected = self._inspect_exact(ids[0], target, require_running=True)
            health = self._health(target, inspected)
            evidence = self._evidence("rollback-observed", "rollback-target", target_release, target, inspected, health=health)
            self.transaction.observe_runtime(operation_id, phase="rollback-observed", outcome="healthy", evidence=evidence, assume_locked=True)
            self.transaction.advance(operation_id, "successful-rollback", assume_locked=True)
            return self._operation(operation_id)

    def _authenticated_target_contract(self, operation_id: str, release_id: str) -> RuntimeExecutionContract:
        state = self.transaction.store.load()
        record = state["releases"].get(release_id)
        _require(isinstance(record, dict), "authenticated rollback target is not retained")
        operations = [item for item in state["operations"].values() if item.get("release_sha256") == release_id and item.get("kind") == "immutable-runtime-preparation" and item.get("phase") == "completed" and isinstance(item.get("metadata_sha256"), str)]
        _require(len(operations) == 1, "authenticated rollback preparation evidence is missing or ambiguous")
        identity, _, evidence, _ = self.transaction._read_prepared_candidate_evidence(release_id, operations[0]["metadata_sha256"])
        _verify_owned_tree(evidence.preparation_path.parent / "runtime")
        integrity = preparation._integrity(evidence.preparation_path.parent / "runtime")
        _require(integrity == evidence.runtime_integrity, "authenticated rollback runtime integrity changed")
        image = _image_identity(self.docker, identity, expected_id=None, timeout=self.config.docker_timeout_seconds)
        return RuntimeExecutionContract(operation_id=operation_id, release_id=release_id, preparation_metadata_sha256=operations[0]["metadata_sha256"], runtime_root=evidence.preparation_path.parent / "runtime", runtime_integrity=integrity, image=image["image"], image_digest=image["image_digest"], image_id=image["image_id"], platform=image["platform"], configuration_sha256=self._configuration_sha256, env_file=self._env_file)


def main() -> int:
    raise SystemExit("immutable runtime lifecycle is an integration API; production wrapper activation remains disabled")


if __name__ == "__main__":
    main()
