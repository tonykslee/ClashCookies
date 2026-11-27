from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


retention = load("activation_retention_boundary_test", "durable_artifact_retention.py")


class DurableActivationBoundaryTests(unittest.TestCase):
    """Low-level boundary checks; coordinator guarantees live in the Linux suite."""

    def test_caller_fabricated_authority_is_not_a_transition_api(self) -> None:
        with self.assertRaises(TypeError):
            retention.RetentionStore.begin_activation(None, authority_proof={})  # type: ignore[call-arg]

    def test_transition_active_test_bypass_was_removed(self) -> None:
        self.assertFalse(hasattr(retention.RetentionStore, "transition_active_for_test"))


if __name__ == "__main__":
    unittest.main()
