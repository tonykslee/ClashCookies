from __future__ import annotations

import importlib.util
from contextlib import nullcontext
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock


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
activation = load("activation_transaction_boundary_test", "durable_activation_transaction.py")


class DurableActivationBoundaryTests(unittest.TestCase):
    """Low-level boundary checks; coordinator guarantees live in the Linux suite."""

    def test_caller_fabricated_authority_is_not_a_transition_api(self) -> None:
        with self.assertRaises(TypeError):
            retention.RetentionStore.begin_activation(None, authority_proof={})  # type: ignore[call-arg]

    def test_transition_active_test_bypass_was_removed(self) -> None:
        self.assertFalse(hasattr(retention.RetentionStore, "transition_active_for_test"))

    def test_advance_validates_forward_authority_before_delivery_consumption(self) -> None:
        tx = object.__new__(activation.ActivationTransaction)
        operation = {
            "operation_id": "ordering-test",
            "phase": "authorization-consumed",
            "intent": {},
            "rollback_consumption": None,
        }
        tx.store = Mock()
        tx.store.load.return_value = {"activation_operations": {"ordering-test": operation}}
        tx._locked = lambda: nullcontext()  # type: ignore[method-assign]
        delivery_calls: list[dict[str, object]] = []
        tx._ensure_delivery_consumed = lambda value, **_kwargs: delivery_calls.append(value)  # type: ignore[method-assign]
        tx._consumed_authority = Mock(side_effect=retention.RetentionError("missing forward authority"))

        with self.assertRaises(retention.RetentionError):
            tx.advance("ordering-test", "incumbent-stop-intent")

        self.assertEqual(delivery_calls, [])
        tx._consumed_authority.assert_called_once_with(operation, recovery=False, assume_locked=True)

    def test_rollback_reconciliation_revalidates_durability_on_terminal_retry(self) -> None:
        tx = object.__new__(activation.ActivationTransaction)
        operation = {
            "operation_id": "rollback-durability-test",
            "phase": "successful-rollback",
        }
        tx.store = Mock()
        tx.store.load.return_value = {"activation_operations": {operation["operation_id"]: operation}}
        tx._locked = lambda: nullcontext()  # type: ignore[method-assign]

        result = tx.reconcile_rollback(operation["operation_id"], {})

        self.assertIs(result, operation)
        tx.store._reestablish_state_durability.assert_called_once_with()

    def test_successful_activation_terminal_retry_does_not_reconsume_or_republish(self) -> None:
        tx = object.__new__(activation.ActivationTransaction)
        operation = {
            "operation_id": "activation-terminal-retry",
            "phase": "successful-activation",
            "intent": {},
            "rollback_consumption": None,
            "delivery_consumption": {},
        }
        tx.store = Mock()
        tx.store.load.return_value = {"activation_operations": {operation["operation_id"]: operation}}
        tx._locked = lambda: nullcontext()  # type: ignore[method-assign]
        tx._consumed_authority = Mock(return_value=object())
        tx._ensure_delivery_consumed = Mock()

        result = tx.advance(operation["operation_id"], "successful-activation")

        self.assertIs(result, operation)
        tx._ensure_delivery_consumed.assert_not_called()
        tx.store._reestablish_state_durability.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
