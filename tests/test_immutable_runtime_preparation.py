from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT / "scripts"))


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


prep = load_module("immutable_runtime_preparation_test", "immutable_runtime_preparation.py")
retention = load_module("durable_artifact_retention_preparation_test", "durable_artifact_retention.py")


class ImmutableRuntimePreparationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / "checkout"
        self.repo.mkdir(mode=0o700)
        self.sources = self.root / "legacy-sources"
        self.sources.mkdir(mode=0o700)
        self.destination = self.root / "prepared"
        self.destination.mkdir(mode=0o700)
        if os.name == "posix":
            self.repo.chmod(0o700)
            self.sources.chmod(0o700)
            self.destination.chmod(0o700)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def source_evidence(self) -> tuple[dict[str, object], dict[str, Path]]:
        source_sha = "a" * 40
        runtime = self.sources / "runtime"
        if runtime.exists():
            shutil.rmtree(runtime)
        (runtime / "dist").mkdir(parents=True)
        (runtime / "node_modules").mkdir()
        (runtime / "prisma").mkdir()
        (runtime / "startup").mkdir()
        (runtime / "dist" / "ClashCookies.js").write_text("compiled\n", encoding="utf-8")
        (runtime / "node_modules" / "@prisma" / "client").mkdir(parents=True)
        (runtime / "node_modules" / ".prisma" / "client").mkdir(parents=True)
        (runtime / "node_modules" / "prisma" / "build").mkdir(parents=True)
        (runtime / "node_modules" / ".bin").mkdir()
        (runtime / "node_modules" / "@prisma" / "client" / "default.js").write_text("module.exports = {};\n", encoding="utf-8")
        (runtime / "node_modules" / ".prisma" / "client" / "index.js").write_text("module.exports = {};\n", encoding="utf-8")
        native = runtime / "node_modules" / ".prisma" / "client" / "libquery_engine-debian-openssl-3.0.x.so.node"
        native.write_bytes(b"native-engine")
        (runtime / "node_modules" / "prisma" / "build" / "index.js").write_text("#!/usr/bin/env node\n", encoding="utf-8")
        (runtime / "node_modules" / "prisma" / "build" / "index.js").chmod(0o755)
        try:
            (runtime / "node_modules" / ".bin" / "prisma").symlink_to("../prisma/build/index.js")
            self.symlink_fixture_available = True
        except OSError:
            # Windows developer workstations commonly lack SeCreateSymbolicLinkPrivilege;
            # the production Linux contract still requires and verifies this symlink.
            (runtime / "node_modules" / ".bin" / "prisma").write_text("symlink unavailable\n", encoding="utf-8")
            self.symlink_fixture_available = False
        (runtime / "prisma" / "schema.prisma").write_text("datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\n", encoding="utf-8")
        (runtime / "prisma" / "migrations" / "0001").mkdir(parents=True)
        (runtime / "prisma" / "migrations" / "0001" / "migration.sql").write_text("-- fixture\n", encoding="utf-8")
        (runtime / "package.json").write_text(json.dumps({"scripts": {"start:runtime": "prisma migrate deploy && node dist/ClashCookies.js"}}) + "\n", encoding="utf-8")
        (runtime / "yarn.lock").write_text("# lock\n", encoding="utf-8")
        (runtime / "startup" / "container-start.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        (runtime / "startup" / "container-start.sh").chmod(0o755)
        marker = f"revision={source_sha}\ndist_digest={prep._wrapper_tree_digest(runtime / 'dist')}\nnode_modules_digest={prep._wrapper_tree_digest(runtime / 'node_modules')}\n"
        (runtime / "dist" / ".clashcookies-artifact").write_text(marker, encoding="ascii")
        (runtime / "node_modules" / ".clashcookies-artifact").write_text(marker, encoding="ascii")
        components = {name: runtime / name for name in ("dist", "node_modules", "prisma", "package.json", "yarn.lock")}
        components["startup/container-start.sh"] = runtime / "startup" / "container-start.sh"
        source: dict[str, object] = {
            "contract": prep.LEGACY_SOURCE_CONTRACT,
            "version": prep.LEGACY_SOURCE_VERSION,
            "container_id": "fixture-container",
            "checkout_revision": source_sha,
            "image": "node:20-bookworm@sha256:" + "b" * 64,
            "image_digest": "sha256:" + "b" * 64,
            "platform": "linux/amd64",
            "startup": {"entrypoint": "startup/container-start.sh", "prebuilt": True, "migrations": "deferred"},
            "components": {name: str(path) for name, path in components.items()},
        }
        return source, components

    def test_legacy_capture_preserves_complete_runtime_and_is_identity_bound(self) -> None:
        source, _ = self.source_evidence()
        if not self.symlink_fixture_available:
            self.skipTest("runtime symlink fixture requires Linux or Windows symlink privilege")
        target = self.destination / "legacy-runtime-baseline"
        integrity = prep._copy_legacy_runtime(source, target, self.repo, durable=False, verify_docker=False)
        self.assertEqual(prep._integrity(target, maximum_bytes=prep.MAX_LEGACY_BYTES, maximum_entries=prep.MAX_LEGACY_ENTRIES), integrity)
        marker = (target / "dist" / ".clashcookies-artifact").read_text(encoding="ascii")
        self.assertIn(f"revision={'a' * 40}\n", marker)
        self.assertIn("dist_digest=", marker)
        self.assertIn("node_modules_digest=", marker)
        self.assertTrue((target / "startup" / "container-start.sh").exists())

    def test_legacy_capture_rejects_source_mutation_during_copy(self) -> None:
        source, components = self.source_evidence()
        if not self.symlink_fixture_available:
            self.skipTest("runtime symlink fixture requires Linux or Windows symlink privilege")
        before = prep._mapped_integrity(components)
        changed = dict(before)
        changed["tree_sha256"] = "c" * 64
        target = self.destination / "legacy-runtime-baseline"
        with patch.object(prep, "_mapped_integrity", side_effect=[before, changed]):
            with self.assertRaisesRegex(prep.PreparationError, "changed"):
                prep._copy_legacy_runtime(source, target, self.repo, durable=False, verify_docker=False)
        self.assertFalse(target.exists())

    def test_legacy_capture_rejects_unpinned_or_incomplete_image_identity(self) -> None:
        source, _ = self.source_evidence()
        source["image"] = "node:20-bookworm"
        with self.assertRaisesRegex(prep.PreparationError, "digest-pinned"):
            prep._legacy_components(source, self.repo)

    def test_operational_legacy_capture_requires_correlated_docker_evidence(self) -> None:
        source, _ = self.source_evidence()
        target = self.destination / "legacy-runtime-baseline"
        with self.assertRaisesRegex(prep.PreparationError, "checkout path"):
            prep._copy_legacy_runtime(source, target, self.repo, durable=False)

    def test_legacy_revision_claim_without_both_observed_markers_is_rejected(self) -> None:
        source, _ = self.source_evidence()
        if not self.symlink_fixture_available:
            self.skipTest("runtime symlink fixture requires Linux or Windows symlink privilege")
        (self.sources / "runtime" / "node_modules" / ".clashcookies-artifact").unlink()
        with self.assertRaisesRegex(prep.PreparationError, "identity marker"):
            prep._copy_legacy_runtime(source, self.destination / "legacy-runtime-baseline", self.repo, durable=False, verify_docker=False)

    def test_legacy_wrapper_markers_require_exact_agreement_and_digest_contract(self) -> None:
        source, _ = self.source_evidence()
        if not self.symlink_fixture_available:
            self.skipTest("runtime symlink fixture requires Linux or Windows symlink privilege")
        marker = self.sources / "runtime" / "node_modules" / ".clashcookies-artifact"
        marker.write_text(marker.read_text(encoding="ascii") + "revision=" + str(source["checkout_revision"]) + "\n", encoding="ascii")
        with self.assertRaisesRegex(prep.PreparationError, "malformed|contradict"):
            prep._copy_legacy_runtime(source, self.destination / "legacy-runtime-baseline", self.repo, durable=False, verify_docker=False)
        source, _ = self.source_evidence()
        marker = self.sources / "runtime" / "node_modules" / ".clashcookies-artifact"
        lines = marker.read_text(encoding="ascii").splitlines()
        lines[1] = "dist_digest=" + "f" * 64
        marker.write_text("\n".join(lines) + "\n", encoding="ascii")
        with self.assertRaisesRegex(prep.PreparationError, "contradict|digest"):
            prep._copy_legacy_runtime(source, self.destination / "legacy-runtime-baseline", self.repo, durable=False, verify_docker=False)

    def test_legacy_custody_conflicts_are_rejected_without_replacement(self) -> None:
        observation = {"image_id": "sha256:" + "a" * 64, "image_digest": "sha256:" + "b" * 64, "image_bytes": 1234}
        protected_ref = prep._legacy_custody_ref(observation["image_digest"])
        commands: list[list[str]] = []

        def inspect_conflict(command, **_kwargs):
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, json.dumps({"Id": "sha256:" + "c" * 64}), "")

        with patch.object(prep.subprocess, "run", side_effect=inspect_conflict):
            with self.assertRaisesRegex(prep.PreparationError, "conflicts"):
                prep._protect_legacy_image_custody(observation)
        self.assertFalse(any(command[0:3] == ["docker", "image", "tag"] for command in commands))
        self.assertEqual(commands[0][-1], protected_ref)

    @unittest.skipUnless(os.name == "posix", "FB-027 descriptor locking requires POSIX")
    def test_operation_lock_requires_canonical_identity_and_real_contention(self) -> None:
        lock = self.root / "app-deploy.lock.flock"
        arbitrary = self.root / "arbitrary.lock"
        with patch.dict(os.environ, {"APP_DIR": str(self.root / "app")}, clear=True):
            with self.assertRaisesRegex(prep.PreparationError, "canonical FB-027"):
                with prep._operation_lock(arbitrary, timeout_seconds=0.1):
                    pass
            with prep._operation_lock(lock, timeout_seconds=0.1):
                self.assertTrue(lock.is_file())

        holder = subprocess.Popen([
            sys.executable,
            "-c",
            "import fcntl,sys,time; f=open(sys.argv[1],'a+'); fcntl.flock(f, fcntl.LOCK_EX); print('ready',flush=True); time.sleep(2)",
            str(lock),
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "ready")
            with patch.dict(os.environ, {"DEPLOY_LOCK_FILE": str(lock)}, clear=True):
                with self.assertRaisesRegex(prep.PreparationError, "deadline exceeded"):
                    with prep._operation_lock(lock, timeout_seconds=0.1):
                        pass
        finally:
            holder.terminate()
            holder.wait(timeout=5)

    def test_existing_legacy_baseline_is_not_overwritten(self) -> None:
        source, _ = self.source_evidence()
        if not self.symlink_fixture_available:
            self.skipTest("runtime symlink fixture requires Linux or Windows symlink privilege")
        target = self.destination / "legacy-runtime-baseline"
        integrity = prep._copy_legacy_runtime(source, target, self.repo, durable=False, verify_docker=False)
        record = {"contract": "clashcookies.legacy-runtime-baseline", "version": 1, "id": retention.LEGACY_BASELINE_ID, "authenticated": False, "protected": True, "status": "preserved-verified", "runtime_path": str(target), "integrity": integrity, "identity": {"container_id": source["container_id"], "checkout_revision": source["checkout_revision"], "image": source["image"], "image_digest": source["image_digest"], "platform": source["platform"], "startup": source["startup"]}}
        publication = self.root / "publication"
        publication.mkdir(mode=0o700)
        store = retention.RetentionStore(publication, repository_root=self.repo, require_durable=False)
        store.initialize()
        store.register_legacy_baseline(record)
        with self.assertRaisesRegex(retention.RetentionError, "conflicts"):
            store.register_legacy_baseline({**record, "identity": {**record["identity"], "container_id": "different"}})
        self.assertEqual(store.legacy_baseline_status(), record)

    def test_runtime_integrity_detects_mode_and_symlink_substitution(self) -> None:
        runtime = self.destination / "runtime"
        runtime.mkdir()
        if os.name == "posix":
            runtime.chmod(0o700)
        (runtime / "file").write_text("data", encoding="utf-8")
        initial = prep._integrity(runtime)
        if os.name == "posix":
            (runtime / "file").chmod(0o755)
            self.assertNotEqual(prep._integrity(runtime), initial)
        (runtime / "file").write_text("changed", encoding="utf-8")
        self.assertNotEqual(prep._integrity(runtime), initial)

    def test_storage_admission_accounts_for_candidate_and_legacy_overlap(self) -> None:
        assessment = retention.assess_storage([self.destination, self.destination], temporary_bytes=100, persistent_bytes=200, preserved_runtime_bytes=300, incremental_preservation_bytes=400, temporary_inodes=2, persistent_inodes=3, headroom_inodes=4)
        self.assertEqual(len(assessment.filesystems), 1)
        self.assertEqual(assessment.required_bytes, 700)
        self.assertEqual(assessment.required_inodes, 9)

    def test_custody_roots_must_be_symmetric_disjoint_paths(self) -> None:
        nested = self.destination / "nested"
        with self.assertRaisesRegex(prep.PreparationError, "custody roots overlap"):
            prep._require_disjoint(self.destination, nested, "prepared and nested custody roots")

    def test_development_identity_is_rejected_at_operational_boundary(self) -> None:
        publication = self.root / "publication"
        publication.mkdir(mode=0o700)
        store = retention.RetentionStore(publication, repository_root=self.repo, require_durable=False)
        store.initialize()
        identity = {
            "repository": "tonykslee/ClashCookies", "repository_id": 668452496, "repository_owner_id": 18295450,
            "source_ref": "refs/heads/dev", "source_sha": "a" * 40, "event": "push",
            "producer_workflow": ".github/workflows/runtime-artifact.yml", "producer_revision": "b" * 40,
            "signer_workflow": ".github/workflows/runtime-artifact.yml", "signer_revision": "c" * 40,
            "run_id": 1, "run_attempt": 1, "artifact_id": 1, "artifact_name": "runtime-artifact-1-1",
            "artifact_class": "development-runtime-evidence", "artifact_service_zip_sha256": "d" * 64, "artifact_service_zip_bytes": 1,
            "archive_name": "runtime.tar.gz", "archive_sha256": "e" * 64, "archive_bytes": 1, "platform": "linux/amd64", "image": "node:20-bookworm", "image_digest": "f" * 64, "authorization_context": "development",
        }
        digest = retention.identity_digest(identity)
        path = publication / f"release-{digest}"
        path.mkdir(mode=0o700)
        (path / "identity.json").write_text(json.dumps(identity, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        (path / "artifact-service.zip").write_bytes(b"x")
        class FakeStore:
            root = publication

            def load(self):
                return {"releases": {digest: {"identity": identity, "publication_name": f"release-{digest}", "evidence": {}}}}

            def _verify_owned_release(self, _path, _record):
                return {"st_dev": 0, "st_ino": 0, "st_uid": 0}

        with self.assertRaisesRegex(prep.PreparationError, "development"):
            prep._candidate_record(FakeStore(), digest, None)


if __name__ == "__main__":
    unittest.main()
