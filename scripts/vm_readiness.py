#!/usr/bin/env python3
"""Bounded, sanitized repository-local VM readiness assessment.

The collector is diagnostic only.  It does not install tools, invoke
privileged operations, inspect Docker, start containers, change permissions,
or contact a production VM.  Missing evidence is UNKNOWN and any blocked
condition makes the aggregate result BLOCKED.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import time
from typing import Any

import durable_artifact_retention as retention


READINESS_CONTRACT = "clashcookies.vm-readiness"
READINESS_VERSION = 1
MAX_CONFIG_BYTES = 128 * 1024
MAX_EVIDENCE_BYTES = 128 * 1024
MAX_COMMAND_OUTPUT = 4096
SAFE_VERSION_RE = re.compile(r"[^\x20-\x7e]+")


class ReadinessError(RuntimeError):
    pass


@dataclass(frozen=True)
class Finding:
    name: str
    status: str
    code: str
    detail: str
    metrics: dict[str, int | str | bool]


def _finding(name: str, status: str, code: str, detail: str, metrics: dict[str, int | str | bool] | None = None) -> Finding:
    if status not in {"PASS", "BLOCKED", "UNKNOWN"}:
        raise ReadinessError("invalid readiness status")
    return Finding(name, status, code, detail, metrics or {})


def _safe_text(value: str) -> str:
    value = SAFE_VERSION_RE.sub("", value).replace("\r", " ").replace("\n", " ")
    return value[:256]


def _command(executable: str, *arguments: str) -> tuple[bool, str]:
    path = shutil.which(executable)
    if path is None:
        return False, "not found"
    try:
        result = subprocess.run([path, *arguments], shell=False, capture_output=True, text=True, timeout=2, check=False, env={"PATH": str(Path(path).parent)})
    except (OSError, subprocess.TimeoutExpired):
        return False, "probe unavailable"
    text = _safe_text((result.stdout or result.stderr or "").strip())
    return result.returncode == 0, text or "version unavailable"


def _read_proc(path: Path, maximum: int = MAX_EVIDENCE_BYTES) -> str | None:
    try:
        data = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    return data[:maximum]


def _path_finding(name: str, path_value: Any, *, required: bool, directory: bool = True) -> Finding:
    if not isinstance(path_value, str) or not path_value or not Path(path_value).is_absolute():
        return _finding(name, "BLOCKED" if required else "UNKNOWN", "path-invalid", "explicit absolute path is required" if required else "path was not supplied")
    path = Path(path_value)
    try:
        metadata = os.lstat(path)
    except OSError:
        return _finding(name, "BLOCKED" if required else "UNKNOWN", "path-missing", "required path is unavailable" if required else "optional evidence path is unavailable")
    is_expected = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if not is_expected or stat.S_ISLNK(metadata.st_mode):
        return _finding(name, "BLOCKED", "path-unsafe", "path type or symlink state is unsafe")
    private = os.name != "posix" or (metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0)
    if not private:
        return _finding(name, "BLOCKED", "path-permissions", "owner-controlled private permissions are required")
    return _finding(name, "PASS", "path-ready", "owner-controlled path is present", {"bytes": int(metadata.st_size), "mode_private": True})


def _filesystem_findings(config: dict[str, Any]) -> list[Finding]:
    paths = [Path(value) for value in config.get("storage_paths", []) if isinstance(value, str) and Path(value).is_absolute()]
    if not paths:
        return [_finding("filesystem", "UNKNOWN", "storage-paths-missing", "filesystem admission paths require an authorized probe")]
    if len(paths) != len(config.get("storage_paths", [])):
        return [_finding("filesystem", "BLOCKED", "storage-paths-invalid", "all storage paths must be explicit absolute paths")]
    try:
        assessment = retention.assess_storage(
            paths,
            temporary_bytes=int(config.get("temporary_bytes", 0)),
            persistent_bytes=int(config.get("persistent_bytes", 0)),
            preserved_runtime_bytes=int(config.get("preserved_runtime_bytes", 0)),
            database_headroom_bytes=int(config.get("database_headroom_bytes", 0)),
            host_headroom_bytes=int(config.get("host_headroom_bytes", 0)),
        )
    except (retention.RetentionError, OSError, ValueError):
        return [_finding("filesystem", "UNKNOWN", "storage-probe-unavailable", "filesystem admission evidence is unavailable")]
    findings = [_finding("filesystem", assessment.status, "capacity-admission", "shared-filesystem admission evaluated", {"required_bytes": assessment.required_bytes, "required_inodes": assessment.required_inodes})]
    for index, item in enumerate(assessment.filesystems):
        findings.append(_finding(f"filesystem-{index}", item["status"], "capacity-observed", "bounded bytes and inode headroom observed", {"free_bytes": item["free_bytes"], "free_inodes": item["free_inodes"], "paths": item["paths"]}))
    return findings


def _platform_findings(config: dict[str, Any]) -> list[Finding]:
    expected_system = config.get("expected_system", "Linux")
    expected_arch = config.get("expected_architecture", "x86_64")
    actual_arch = platform.machine()
    findings = [_finding("os", "PASS" if platform.system() == expected_system else "BLOCKED", "os-compatibility", "OS compatibility evaluated", {"system": platform.system()})]
    findings.append(_finding("architecture", "PASS" if actual_arch in {expected_arch, "amd64"} else "BLOCKED", "architecture-compatibility", "native architecture evaluated", {"architecture": actual_arch}))
    return findings


def _durability_findings(config: dict[str, Any]) -> list[Finding]:
    if os.name != "posix":
        return [_finding("atomic-publication", "UNKNOWN", "linux-probe-required", "Linux filesystem durability requires a Linux probe")]
    if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        return [_finding("atomic-publication", "BLOCKED", "filesystem-primitives-missing", "required no-follow directory primitives are unavailable")]
    try:
        libc = ctypes.CDLL(None)
        getattr(libc, "renameat2")
    except (AttributeError, OSError):
        return [_finding("atomic-publication", "UNKNOWN", "renameat2-unverified", "no-replacement rename support requires an authorized Linux probe")]
    probe = config.get("durability_probe_path")
    if not isinstance(probe, str) or not Path(probe).is_absolute():
        return [_finding("atomic-publication", "UNKNOWN", "durability-path-missing", "a writable-path-free durability probe was not supplied")]
    try:
        descriptor = os.open(probe, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        os.fsync(descriptor)
        os.close(descriptor)
    except OSError:
        return [_finding("atomic-publication", "UNKNOWN", "directory-fsync-unverified", "directory durability could not be verified")]
    return [_finding("atomic-publication", "PASS", "linux-durability-primitives", "no-replacement and directory-fsync primitives are available")]


def _resource_findings() -> list[Finding]:
    findings: list[Finding] = []
    meminfo = _read_proc(Path("/proc/meminfo"))
    if meminfo is None:
        findings.append(_finding("memory", "UNKNOWN", "memory-evidence-missing", "memory evidence requires a Linux probe"))
    else:
        values = {key: int(value) for key, value in re.findall(r"^(MemAvailable|SwapFree|SwapTotal):\s+(\d+)\s+kB$", meminfo, re.MULTILINE)}
        findings.append(_finding("memory", "PASS" if values.get("MemAvailable", 0) > 0 else "UNKNOWN", "memory-headroom", "bounded memory evidence observed", {"available_kib": values.get("MemAvailable", 0)}))
        findings.append(_finding("swap", "PASS" if values.get("SwapTotal", 0) == 0 or values.get("SwapFree", 0) > 0 else "BLOCKED", "swap-headroom", "bounded swap evidence observed", {"free_kib": values.get("SwapFree", 0), "total_kib": values.get("SwapTotal", 0)}))
    try:
        load = os.getloadavg()[0]
        findings.append(_finding("load", "PASS", "load-observed", "bounded load evidence observed", {"load_1m": round(load, 2)}))
    except (AttributeError, OSError):
        findings.append(_finding("load", "UNKNOWN", "load-evidence-missing", "load evidence requires an authorized probe"))
    pid_max = _read_proc(Path("/proc/sys/kernel/pid_max"))
    findings.append(_finding("pid-headroom", "PASS" if pid_max and pid_max.strip().isdigit() and int(pid_max.strip()) > 1024 else "UNKNOWN", "pid-limit", "bounded PID limit evidence observed" if pid_max else "PID limit evidence unavailable", {"pid_max": int(pid_max.strip()) if pid_max and pid_max.strip().isdigit() else 0}))
    cgroup = Path("/sys/fs/cgroup")
    findings.append(_finding("cgroup-headroom", "PASS" if cgroup.exists() else "UNKNOWN", "cgroup-evidence", "cgroup root is visible" if cgroup.exists() else "cgroup evidence unavailable"))
    return findings


def _tool_findings() -> list[Finding]:
    findings = []
    for label, executable, argument in (("python", "python3", "--version"), ("openssl", "openssl", "version"), ("github-cli", "gh", "--version"), ("ssh", "ssh", "-V")):
        ok, version = _command(executable, argument)
        findings.append(_finding(label, "PASS" if ok else "BLOCKED", "tool-available" if ok else "tool-missing", "required native tooling is available" if ok else "required native tooling is unavailable", {"version": version}))
    return findings


def _wrapper_finding(config: dict[str, Any]) -> Finding:
    value = config.get("wrapper_path")
    finding = _path_finding("deployment-wrapper", value, required=True, directory=False)
    if finding.status != "PASS":
        return finding
    path = Path(value)
    try:
        if path.stat().st_size > MAX_EVIDENCE_BYTES:
            return _finding("deployment-wrapper", "BLOCKED", "wrapper-oversized", "deployment wrapper exceeds the bounded inspection limit")
    except OSError:
        return _finding("deployment-wrapper", "UNKNOWN", "wrapper-unavailable", "deployment wrapper could not be inspected")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    expected = config.get("expected_wrapper_sha256")
    if expected is not None and (not isinstance(expected, str) or digest != expected):
        return _finding("deployment-wrapper", "BLOCKED", "wrapper-identity-mismatch", "installed wrapper identity does not match the expected FB-027-compatible identity")
    text = path.read_text(encoding="utf-8", errors="replace")[:MAX_EVIDENCE_BYTES]
    compatible = all(marker in text for marker in ("DEPLOY_ATTEMPT_ID", "reconcile_abandoned_resources", "assert_production_health_ready"))
    return _finding("deployment-wrapper", "PASS" if compatible else "UNKNOWN", "wrapper-identity" if compatible else "wrapper-compatibility-unverified", "wrapper identity and FB-027 lifecycle markers evaluated", {"sha256": digest, "fb027_markers": compatible})


def _evidence_finding(name: str, value: Any, *, required: bool) -> Finding:
    if not isinstance(value, str) or not Path(value).is_absolute():
        return _finding(name, "BLOCKED" if required else "UNKNOWN", "evidence-path-missing", "explicit evidence path is required" if required else "additional authorized evidence is required")
    path = Path(value)
    try:
        metadata = os.lstat(path)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o077:
            return _finding(name, "BLOCKED", "evidence-permissions", "evidence path is not a private regular file")
        payload = json.loads(path.read_text(encoding="utf-8")[:MAX_EVIDENCE_BYTES])
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return _finding(name, "UNKNOWN", "evidence-unavailable", "sanitized evidence could not be read")
    status = payload.get("status") if isinstance(payload, dict) else None
    if status not in {"PASS", "BLOCKED", "UNKNOWN"}:
        return _finding(name, "UNKNOWN", "evidence-ambiguous", "evidence status is missing or ambiguous")
    return _finding(name, status, "evidence-status", "sanitized status evidence accepted")


def collect(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ReadinessError("readiness configuration must be an object")
    findings = []
    findings.extend(_platform_findings(config))
    findings.extend(_filesystem_findings(config))
    findings.extend(_durability_findings(config))
    findings.extend(_resource_findings())
    findings.extend(_tool_findings())
    findings.append(_wrapper_finding(config))
    findings.append(_path_finding("legacy-rollback", config.get("legacy_runtime_path"), required=True))
    findings.append(_path_finding("independent-trust-material", config.get("trust_root"), required=True))
    findings.append(_path_finding("authorization-replay-journal", config.get("authorization_journal"), required=True))
    findings.append(_evidence_finding("runtime-health", config.get("health_evidence_path"), required=False))
    findings.append(_evidence_finding("scheduler-singleton", config.get("scheduler_evidence_path"), required=False))
    statuses = {finding.status for finding in findings}
    overall = "BLOCKED" if "BLOCKED" in statuses else "UNKNOWN" if "UNKNOWN" in statuses else "PASS"
    return {"contract": READINESS_CONTRACT, "version": READINESS_VERSION, "overall": overall, "production_eligible": False, "findings": [asdict(finding) for finding in findings]}


def main() -> int:
    parser = argparse.ArgumentParser(description="sanitized repository-local VM readiness assessment")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        path = Path(args.config)
        if not path.is_file() or path.stat().st_size > MAX_CONFIG_BYTES:
            raise ReadinessError("readiness configuration is unavailable or oversized")
        config = json.loads(path.read_text(encoding="utf-8"))
        print(json.dumps(collect(config), sort_keys=True))
        return 0
    except (ReadinessError, OSError, ValueError) as error:
        print(f"[vm-readiness] blocked: {error}", file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
