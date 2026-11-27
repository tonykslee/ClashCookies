from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
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
        (runtime / "dist").mkdir(parents=True)
        (runtime / "node_modules").mkdir()
        (runtime / "prisma").mkdir()
        (runtime / "startup").mkdir()
        (runtime / "dist" / "ClashCookies.js").write_text("compiled\n", encoding="utf-8")
        (runtime / "dist" / ".clashcookies-artifact").write_text(f"revision={source_sha}\n", encoding="ascii")
        (runtime / "node_modules" / ".clashcookies-artifact").write_text(f"revision={source_sha}\n", encoding="ascii")
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
        components = {name: runtime / name for name in ("dist", "node_modules", "prisma", "package.json", "yarn.lock")}
        components["startup/container-start.sh"] = runtime / "startup" / "container-start.sh"
        source: dict[str, object] = {
            "contract": prep.LEGACY_SOURCE_CONTRACT,
            "version": prep.LEGACY_SOURCE_VERSION,
            "container_id": "fixture-container",
            "checkout_revision": source_sha,
            "runtime_revision": source_sha,
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
        self.assertEqual((target / "dist" / ".clashcookies-artifact").read_text(encoding="ascii").strip(), f"revision={'a' * 40}")
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
