import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
from types import SimpleNamespace
import tempfile
import unittest
import sys
from unittest.mock import patch
from contextlib import contextmanager


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


lifecycle_module = load("immutable_runtime_lifecycle_test", "immutable_runtime_lifecycle.py")


class ImmutableRuntimeLifecycleTests(unittest.TestCase):
    def _contract(self, root: Path, *, source_sha: str | None = None):
        runtime = root / "runtime"
        runtime.mkdir(exist_ok=True)
        return lifecycle_module.RuntimeExecutionContract(
            operation_id="operation-1",
            release_id="a" * 64,
            preparation_metadata_sha256="b" * 64,
            runtime_root=runtime,
            runtime_integrity={"tree_sha256": "c" * 64, "bytes": 1, "entries": 1},
            image="node:20-bookworm@sha256:" + "d" * 64,
            image_digest="sha256:" + "d" * 64,
            image_id="sha256:" + "e" * 64,
            platform="linux/amd64",
            configuration_sha256="f" * 64,
            env_file=None,
            source_sha=source_sha,
        )

    def test_run_contract_is_prebuilt_direct_and_does_not_mount_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            tx = SimpleNamespace(
                prepared_root=root / "prepared",
                store=SimpleNamespace(root=root / "retention", repository_root=root / "checkout"),
                trusted_root=root / "trusted",
            )
            lifecycle = lifecycle_module.ImmutableRuntimeLifecycle(
                tx,
                lifecycle_module.LifecycleConfig(container_name="cc-candidate", network="cc-test", host_port=18080),
            )
            contract = lifecycle_module.RuntimeExecutionContract(
                operation_id="operation-1",
                release_id="a" * 64,
                preparation_metadata_sha256="b" * 64,
                runtime_root=runtime,
                runtime_integrity={"tree_sha256": "c" * 64, "bytes": 1, "entries": 1},
                image="node:20-bookworm@sha256:" + "d" * 64,
                image_digest="sha256:" + "d" * 64,
                image_id="sha256:" + "e" * 64,
                platform="linux/amd64",
                configuration_sha256="f" * 64,
                env_file=None,
            )
            arguments = lifecycle_module.ImmutableRuntimeLifecycle._run_arguments(lifecycle, contract)

            self.assertIn("--pull=never", arguments)
            self.assertIn("--read-only", arguments)
            self.assertIn("--restart", arguments)
            self.assertEqual(arguments[arguments.index("--restart") + 1], "no")
            self.assertIn(f"{runtime}:/app:ro", arguments)
            self.assertEqual(arguments[-2:], ["node", "/app/dist/ClashCookies.js"])
            self.assertNotIn("npm", arguments)
            self.assertNotIn("migrate", arguments)
            self.assertNotIn("build", arguments)
            self.assertNotIn(str(tx.store.repository_root), arguments)

    def test_config_bounds_reject_unbounded_or_ambiguous_values(self) -> None:
        with self.assertRaisesRegex(lifecycle_module.LifecycleError, "timeout"):
            lifecycle_module.LifecycleConfig(container_name="cc", network="cc", host_port=18080, health_timeout_seconds=301).validate()
        with self.assertRaisesRegex(lifecycle_module.LifecycleError, "container name"):
            lifecycle_module.LifecycleConfig(container_name="bad name", network="cc", host_port=18080).validate()

    def test_health_rejects_unbound_fixture_response(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tx = SimpleNamespace(prepared_root=root / "prepared", store=SimpleNamespace(root=root / "retention", repository_root=root / "checkout"), trusted_root=root / "trusted")
            lifecycle = lifecycle_module.ImmutableRuntimeLifecycle(tx, lifecycle_module.LifecycleConfig(container_name="cc", network="bridge", host_port=18080, health_provenance="fixture"))
            contract = self._contract(root)

            class Response:
                status = 200

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

                def read(self, _limit):
                    return json.dumps({"status": "ok", "timestamp": lifecycle_module._now(), "runtime": {"runtime_identity_sha256": contract.release_id, "preparation_metadata_sha256": contract.preparation_metadata_sha256, "operation_id": contract.operation_id}}).encode()

            with patch.object(lifecycle_module, "urlopen", return_value=Response()):
                with self.assertRaisesRegex(lifecycle_module.LifecycleError, "provenance"):
                    lifecycle._health(contract, {"container_id": "container-1"})

    def test_activate_proves_candidate_before_any_docker_side_effect(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            operation = {"operation_id": "operation-1", "phase": "authorization-consumed", "execution_mode": "operational", "candidate_release": "a" * 64, "preparation_metadata_sha256": "b" * 64, "incumbent_release": None, "observations": {}}

            class Store:
                pass

            Store.root = root / "retention"
            Store.repository_root = root / "checkout"

            def load(self):
                return {"activation_operations": {"operation-1": operation}}

            def legacy_baseline_status(self):
                return {"identity": {"container_observation": {"container_id": "incumbent-1"}}}

            Store.load = load
            Store.legacy_baseline_status = legacy_baseline_status

            class Tx:
                store = Store()

                @contextmanager
                def lifecycle_lock(self):
                    yield

                def advance(self, *_args, **_kwargs):
                    raise AssertionError("durable phase must not advance before candidate admission")

            class Docker:
                def __init__(self):
                    self.calls = []

                def __getattr__(self, name):
                    def call(*_args, **_kwargs):
                        self.calls.append(name)
                        return []
                    return call

            docker = Docker()
            lifecycle = lifecycle_module.ImmutableRuntimeLifecycle(Tx(), lifecycle_module.LifecycleConfig(container_name="cc", network="bridge", host_port=18080), docker=docker)

            def missing_material(_operation_id):
                raise lifecycle_module.LifecycleError("prepared candidate material is missing")

            lifecycle._candidate_contract = missing_material
            with self.assertRaisesRegex(lifecycle_module.LifecycleError, "prepared candidate"):
                lifecycle.activate("operation-1")
            self.assertEqual(docker.calls, [])

    @unittest.skipUnless(os.name == "posix" and os.environ.get("CC_REAL_RUNTIME_LIFECYCLE") == "1", "mandatory Linux immutable lifecycle integration")
    def test_real_pinned_image_prebuilt_start_and_fresh_identity_health(self) -> None:
        image = os.environ.get("RUNTIME_ARTIFACT_IMAGE", lifecycle_module.provenance.RELEASE_IMAGE)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            (runtime / "dist").mkdir(parents=True)
            (runtime / "dist" / "ClashCookies.js").write_text(
                    "const http=require('http'); const r=process.env; http.createServer((q,s)=>{s.setHeader('content-type','application/json'); s.end(JSON.stringify({status:'ok',timestamp:new Date().toISOString(),runtime:{runtime_identity_sha256:r.CLASHCOOKIES_RUNTIME_IDENTITY_SHA256,preparation_metadata_sha256:r.CLASHCOOKIES_PREPARATION_METADATA_SHA256,operation_id:r.CLASHCOOKIES_ACTIVATION_OPERATION_ID,provenance:r.CLASHCOOKIES_HEALTH_PROVENANCE}}));}).listen(8080,'0.0.0.0');\n",
                encoding="utf-8",
            )
            port = 18080
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = int(probe.getsockname()[1])
            config = lifecycle_module.LifecycleConfig(container_name="cc-real-lifecycle", network="bridge", host_port=port, health_provenance="fixture")
            tx = SimpleNamespace(prepared_root=root / "prepared", store=SimpleNamespace(root=root / "retention", repository_root=root / "checkout"), trusted_root=root / "trusted")
            runner = lifecycle_module.DockerClient()
            lifecycle = lifecycle_module.ImmutableRuntimeLifecycle(tx, config, docker=runner)
            image_info = runner.inspect_image(image, platform=None, timeout=30)
            contract = lifecycle_module.RuntimeExecutionContract(
                operation_id="real-lifecycle-operation",
                release_id="a" * 64,
                preparation_metadata_sha256="b" * 64,
                runtime_root=runtime,
                runtime_integrity={"tree_sha256": "c" * 64, "bytes": 1, "entries": 1},
                image=image,
                image_digest=image.split("@", 1)[1],
                image_id=image_info["Id"],
                platform="linux/amd64",
                configuration_sha256="d" * 64,
                env_file=None,
            )
            contract = lifecycle._finalize_contract(contract)
            try:
                container_id, started = lifecycle._run_candidate(contract.operation_id, contract)
                _inspected, evidence = lifecycle._inspect_exact(container_id, contract, require_running=True)
                health = lifecycle._health(contract, evidence)
                self.assertEqual(health["status"], "healthy")
                self.assertEqual(started["image_id"], contract.image_id)
                self.assertEqual(evidence["mounts"][0]["RW"], False)
            finally:
                subprocess.run(["docker", "rm", "-f", config.container_name], check=False, capture_output=True)


if __name__ == "__main__":
    unittest.main()
