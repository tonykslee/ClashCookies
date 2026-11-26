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
from datetime import datetime
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
import runtime_artifact_provenance as provenance


READINESS_CONTRACT = "clashcookies.vm-readiness"
READINESS_VERSION = 1
MAX_CONFIG_BYTES = 128 * 1024
MAX_EVIDENCE_BYTES = 128 * 1024
MAX_COMMAND_OUTPUT = 4096
SAFE_VERSION_RE = re.compile(r"[^\x20-\x7e]+")
URL_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)


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
    value = URL_RE.sub("[redacted-url]", value)
    value = SAFE_VERSION_RE.sub("", value).replace("\r", " ").replace("\n", " ")
    if "PRIVATE KEY" in value.upper() or "BEGIN " in value.upper():
        return "[redacted-sensitive-output]"
    return value[:256]


def _command(executable: str, *arguments: str) -> tuple[bool, str]:
    path = shutil.which(executable)
    if path is None:
        return False, "not found"
    try:
        result = provenance.run_bounded([path, *arguments], timeout_seconds=2, max_output_bytes=MAX_COMMAND_OUTPUT, label="readiness tool probe", environment={"PATH": str(Path(path).parent)})
    except Exception:
        return False, "probe unavailable"
    output = result.stdout or result.stderr or ""
    if isinstance(output, bytes):
        output = output.decode("utf-8", errors="replace")
    text = _safe_text(output.strip())
    return result.returncode == 0, text or "version unavailable"


def _read_proc(path: Path, maximum: int = MAX_EVIDENCE_BYTES) -> str | None:
    try:
        data = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    return data[:maximum]


def _read_private_file(path: Path, maximum: int, label: str) -> bytes:
    try:
        expected = os.lstat(path)
    except OSError as error:
        raise ReadinessError(f"{label} is unavailable") from error
    if not stat.S_ISREG(expected.st_mode) or stat.S_ISLNK(expected.st_mode) or expected.st_nlink != 1:
        raise ReadinessError(f"{label} is not a single regular file")
    if os.name == "posix" and (expected.st_uid != os.geteuid() or stat.S_IMODE(expected.st_mode) & 0o077):
        raise ReadinessError(f"{label} is not private")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = None
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino, opened.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
            raise ReadinessError(f"{label} changed during inspection")
        if opened.st_size > maximum:
            raise ReadinessError(f"{label} exceeds the inspection limit")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                raise ReadinessError(f"{label} changed during inspection")
            chunks.append(chunk)
            remaining -= len(chunk)
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
            raise ReadinessError(f"{label} changed during inspection")
        return b"".join(chunks)
    except OSError as error:
        raise ReadinessError(f"{label} is unavailable") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


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
    private = os.name != "posix" or (metadata.st_uid == os.geteuid() and stat.S_IMODE(metadata.st_mode) & 0o077 == 0 and (directory or metadata.st_nlink == 1))
    if not private:
        return _finding(name, "BLOCKED", "path-permissions", "owner-controlled private permissions are required")
    return _finding(name, "PASS", "path-ready", "owner-controlled path is present", {"bytes": int(metadata.st_size), "mode_private": True})


def _filesystem_findings(config: dict[str, Any]) -> list[Finding]:
    configured = config.get("storage_paths", [])
    if not isinstance(configured, list):
        return [_finding("filesystem", "BLOCKED", "storage-paths-invalid", "storage paths must be an explicit list")]
    paths = [Path(value) for value in configured if isinstance(value, str) and Path(value).is_absolute()]
    if not paths:
        return [_finding("filesystem", "UNKNOWN", "storage-paths-missing", "filesystem admission paths require an authorized probe")]
    if len(paths) != len(configured):
        return [_finding("filesystem", "BLOCKED", "storage-paths-invalid", "all storage paths must be explicit absolute paths")]
    database_headroom = config.get("database_headroom_bytes")
    host_headroom = config.get("host_headroom_bytes")
    if type(database_headroom) is not int or database_headroom < 0 or type(host_headroom) is not int or host_headroom < 0:
        return [_finding("filesystem", "UNKNOWN", "operating-reserve-policy-missing", "explicit database and host operating reserves are required")]
    try:
        assessment = retention.assess_storage(
            paths,
            temporary_bytes=int(config.get("temporary_bytes", 0)),
            persistent_bytes=int(config.get("persistent_bytes", 0)),
            preserved_runtime_bytes=int(config.get("preserved_runtime_bytes", 0)),
            database_headroom_bytes=database_headroom,
            host_headroom_bytes=host_headroom,
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
    aliases = {"x86_64": {"x86_64", "amd64"}, "amd64": {"x86_64", "amd64"}, "aarch64": {"aarch64", "arm64"}, "arm64": {"aarch64", "arm64"}}
    expected_arches = aliases.get(expected_arch, {expected_arch})
    findings = [_finding("os", "PASS" if platform.system() == expected_system else "BLOCKED", "os-compatibility", "OS compatibility evaluated", {"system": platform.system()})]
    findings.append(_finding("architecture", "PASS" if actual_arch in expected_arches else "BLOCKED", "architecture-compatibility", "native architecture evaluated", {"architecture": actual_arch}))
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
    descriptor = None
    try:
        descriptor = os.open(probe, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        os.fsync(descriptor)
    except OSError:
        return [_finding("atomic-publication", "UNKNOWN", "directory-fsync-unverified", "directory durability could not be verified")]
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return [_finding("directory-fsync", "PASS", "directory-fsync-available", "directory fsync succeeded on the supplied probe path"), _finding("atomic-publication", "UNKNOWN", "no-replacement-unproven", "renameat2 availability was observed but no destructive-free no-replacement probe was authorized")]


def _resource_findings(config: dict[str, Any]) -> list[Finding]:
    findings: list[Finding] = []
    meminfo = _read_proc(Path("/proc/meminfo"))
    if meminfo is None:
        findings.append(_finding("memory", "UNKNOWN", "memory-evidence-missing", "memory evidence requires a Linux probe"))
    else:
        values = {key: int(value) for key, value in re.findall(r"^(MemAvailable|SwapFree|SwapTotal):\s+(\d+)\s+kB$", meminfo, re.MULTILINE)}
        minimum_memory = config.get("minimum_memory_available_kib")
        if minimum_memory is None:
            memory_status = "UNKNOWN"
            memory_code = "memory-threshold-missing"
        elif type(minimum_memory) is not int or minimum_memory < 0:
            memory_status = "BLOCKED"
            memory_code = "memory-threshold-invalid"
        else:
            memory_status = "PASS" if values.get("MemAvailable", 0) >= minimum_memory else "BLOCKED"
            memory_code = "memory-headroom"
        findings.append(_finding("memory", memory_status, memory_code, "bounded memory evidence observed", {"available_kib": values.get("MemAvailable", 0)}))
        minimum_swap = config.get("minimum_swap_free_kib")
        if values.get("SwapTotal", 0) == 0 and config.get("allow_no_swap") is True:
            swap_status, swap_code = "PASS", "swap-not-required"
        elif minimum_swap is None:
            swap_status, swap_code = "UNKNOWN", "swap-threshold-missing"
        elif type(minimum_swap) is not int or minimum_swap < 0:
            swap_status, swap_code = "BLOCKED", "swap-threshold-invalid"
        else:
            swap_status, swap_code = ("PASS", "swap-headroom") if values.get("SwapFree", 0) >= minimum_swap else ("BLOCKED", "swap-headroom")
        findings.append(_finding("swap", swap_status, swap_code, "bounded swap evidence observed", {"free_kib": values.get("SwapFree", 0), "total_kib": values.get("SwapTotal", 0)}))
    try:
        load = os.getloadavg()[0]
        maximum_load = config.get("maximum_load_1m")
        if maximum_load is None:
            load_status, load_code = "UNKNOWN", "load-threshold-missing"
        elif not isinstance(maximum_load, (int, float)) or maximum_load < 0:
            load_status, load_code = "BLOCKED", "load-threshold-invalid"
        else:
            load_status, load_code = ("PASS", "load-headroom") if load <= maximum_load else ("BLOCKED", "load-headroom")
        findings.append(_finding("load", load_status, load_code, "bounded load evidence observed", {"load_1m": round(load, 2)}))
    except (AttributeError, OSError):
        findings.append(_finding("load", "UNKNOWN", "load-evidence-missing", "load evidence requires an authorized probe"))
    pid_max = _read_proc(Path("/proc/sys/kernel/pid_max"))
    pid_limit = int(pid_max.strip()) if pid_max and pid_max.strip().isdigit() else 0
    process_count = len([entry for entry in Path("/proc").iterdir() if entry.name.isdigit()]) if Path("/proc").is_dir() else 0
    minimum_pid_headroom = config.get("minimum_pid_headroom")
    if not pid_limit:
        pid_status, pid_code = "UNKNOWN", "pid-limit-missing"
    elif type(minimum_pid_headroom) is not int or minimum_pid_headroom < 0:
        pid_status, pid_code = "UNKNOWN", "pid-headroom-threshold-missing"
    else:
        pid_status, pid_code = ("PASS", "pid-headroom") if pid_limit - process_count >= minimum_pid_headroom else ("BLOCKED", "pid-headroom")
    findings.append(_finding("pid-headroom", pid_status, pid_code, "bounded PID headroom observed", {"pid_max": pid_limit, "processes": process_count}))
    configured_cgroup = config.get("cgroup_path")
    cgroup = Path(configured_cgroup) if isinstance(configured_cgroup, str) and Path(configured_cgroup).is_absolute() else None
    if cgroup is None:
        findings.append(_finding("cgroup-headroom", "UNKNOWN", "cgroup-path-missing", "an explicit applicable cgroup path is required"))
        return findings
    memory_max = _read_proc(cgroup / "memory.max") if cgroup.is_dir() else None
    memory_current = _read_proc(cgroup / "memory.current") if cgroup.is_dir() else None
    pids_max = _read_proc(cgroup / "pids.max") if cgroup.is_dir() else None
    pids_current = _read_proc(cgroup / "pids.current") if cgroup.is_dir() else None
    if not all(value is not None for value in (memory_max, memory_current, pids_max, pids_current)):
        findings.append(_finding("cgroup-headroom", "UNKNOWN", "cgroup-evidence-missing", "cgroup memory and PID headroom evidence is unavailable"))
    else:
        def _limit(value: str) -> int | None:
            return None if value.strip() == "max" else int(value.strip()) if value.strip().isdigit() else -1
        memory_limit, pids_limit = _limit(memory_max), _limit(pids_max)
        memory_used, pids_used = int(memory_current.strip()) if memory_current.strip().isdigit() else -1, int(pids_current.strip()) if pids_current.strip().isdigit() else -1
        memory_headroom = -1 if memory_limit is None else max(memory_limit - memory_used, 0)
        pid_headroom = -1 if pids_limit is None else max(pids_limit - pids_used, 0)
        required_memory = config.get("minimum_cgroup_memory_headroom_bytes")
        required_pids = config.get("minimum_cgroup_pid_headroom")
        thresholds_valid = type(required_memory) is int and required_memory >= 0 and type(required_pids) is int and required_pids >= 0
        unlimited = memory_limit is None or pids_limit is None
        cgroup_ok = thresholds_valid and not unlimited and memory_limit != -1 and pids_limit != -1 and memory_used >= 0 and pids_used >= 0 and memory_headroom >= required_memory and pid_headroom >= required_pids
        code = "cgroup-headroom" if cgroup_ok else "cgroup-policy-missing" if not thresholds_valid or unlimited else "cgroup-headroom"
        findings.append(_finding("cgroup-headroom", "PASS" if cgroup_ok else "UNKNOWN" if not thresholds_valid or unlimited else "BLOCKED", code, "cgroup headroom meets the explicit policy" if cgroup_ok else "cgroup headroom cannot be proven against the explicit policy", {"memory_headroom_bytes": memory_headroom, "pid_headroom": pid_headroom}))
    return findings


def _tool_findings() -> list[Finding]:
    findings = []
    for label, executable, argument in (("python", "python3", "--version"), ("openssl", "openssl", "version"), ("github-cli", "gh", "--version"), ("ssh", "ssh", "-V")):
        ok, version = _command(executable, argument)
        findings.append(_finding(label, "PASS" if ok else "BLOCKED", "tool-available" if ok else "tool-missing", "required native tooling is available" if ok else "required native tooling is unavailable", {"version": version}))
    return findings


def _wrapper_findings(config: dict[str, Any]) -> list[Finding]:
    value = config.get("wrapper_path")
    finding = _path_finding("deployment-wrapper", value, required=True, directory=False)
    if finding.status != "PASS":
        return [finding]
    try:
        payload = _read_private_file(Path(value), MAX_EVIDENCE_BYTES, "deployment wrapper")
    except ReadinessError:
        return [_finding("deployment-wrapper", "UNKNOWN", "wrapper-unavailable", "deployment wrapper could not be inspected")]
    digest = hashlib.sha256(payload).hexdigest()
    expected = config.get("expected_wrapper_sha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        identity = _finding("deployment-wrapper", "UNKNOWN", "wrapper-identity-unverified", "an explicit expected wrapper digest is required")
    elif digest != expected:
        identity = _finding("deployment-wrapper", "BLOCKED", "wrapper-identity-mismatch", "installed wrapper identity does not match the expected FB-027-compatible identity")
    else:
        identity = _finding("deployment-wrapper", "PASS", "wrapper-identity", "installed wrapper digest matches the explicit expected identity", {"sha256": digest})
    text = payload.decode("utf-8", errors="replace")
    compatible = all(marker in text for marker in ("DEPLOY_ATTEMPT_ID", "reconcile_abandoned_resources", "assert_production_health_ready"))
    compatibility = _finding("deployment-wrapper-compatibility", "UNKNOWN", "wrapper-control-flow-unverified", "marker presence is diagnostic only; controlled wrapper review or authorized evidence is required", {"fb027_markers": compatible})
    evidence_path = config.get("wrapper_compatibility_evidence_path")
    if evidence_path is not None:
        compatibility = _evidence_finding("deployment-wrapper-compatibility", evidence_path, required=True)
    return [identity, compatibility]


def _evidence_finding(name: str, value: Any, *, required: bool) -> Finding:
    if not isinstance(value, str) or not Path(value).is_absolute():
        return _finding(name, "BLOCKED" if required else "UNKNOWN", "evidence-path-missing", "explicit evidence path is required" if required else "additional authorized evidence is required")
    path = Path(value)
    try:
        payload = json.loads(_read_private_file(path, MAX_EVIDENCE_BYTES, name).decode("utf-8"))
    except (ReadinessError, UnicodeDecodeError, json.JSONDecodeError):
        return _finding(name, "UNKNOWN", "evidence-unavailable", "sanitized evidence could not be read")
    if not isinstance(payload, dict) or payload.get("contract") != "clashcookies.vm-readiness-evidence" or payload.get("version") != 1:
        return _finding(name, "UNKNOWN", "evidence-unbound", "evidence is not bound to the readiness evidence contract")
    if not isinstance(payload.get("subject_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", payload["subject_sha256"]):
        return _finding(name, "UNKNOWN", "evidence-unbound", "evidence subject binding is missing or malformed")
    observed_at = payload.get("observed_at")
    try:
        observed = datetime.fromisoformat(str(observed_at).replace("Z", "+00:00"))
        fresh = abs(time.time() - observed.timestamp()) <= 300
    except (TypeError, ValueError, OverflowError):
        fresh = False
    if not fresh or payload.get("authenticated") is not True or not isinstance(payload.get("source"), str) or not payload["source"].startswith("clashcookies:"):
        return _finding(name, "UNKNOWN", "evidence-stale-or-untrusted", "evidence freshness or source binding is not acceptable")
    status = payload.get("status")
    if status not in {"PASS", "BLOCKED", "UNKNOWN"}:
        return _finding(name, "UNKNOWN", "evidence-ambiguous", "evidence status is missing or ambiguous")
    return _finding(name, "UNKNOWN", "evidence-authenticity-unavailable", "independent authenticity and finding-specific subject correspondence are not established by this collector")


def collect(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise ReadinessError("readiness configuration must be an object")
    findings = []
    findings.extend(_platform_findings(config))
    findings.extend(_filesystem_findings(config))
    findings.extend(_durability_findings(config))
    findings.extend(_resource_findings(config))
    findings.extend(_tool_findings())
    findings.extend(_wrapper_findings(config))
    findings.append(_path_finding("legacy-rollback", config.get("legacy_runtime_path"), required=True))
    findings.append(_path_finding("independent-trust-material", config.get("trust_root"), required=True, directory=False))
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
