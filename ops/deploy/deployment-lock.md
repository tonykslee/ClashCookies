# Deployment lock coordination contract

This repository-side contract is implemented for isolated tests and future reviewed VM integration. It does not install a lock directory or change the live VM.

## Ownership and order

`DEPLOY_LOCK_PATH` is one exclusive host-level directory lock shared by the version-controlled non-migration helper and the migration-aware orchestrator. Each entry point must acquire it before inspecting or mutating checkout, worktree, runtime, Compose, or release state.

The migration-aware orchestrator owns the release lock for the whole deployment. During its migration stage it invokes the runner with `MIGRATION_LOCK_PATH`, a different directory owned only by that runner. The runner never acquires `DEPLOY_LOCK_PATH`, so the nested call has a fixed order and cannot recursively wait on the outer lock:

```text
legacy VM wrapper (unverified) ─┐
versioned deploy-prod.sh       ├─ acquire DEPLOY_LOCK_PATH
migration-aware orchestrator   ┘          │
                                         ├─ inspect / build / preflight
                                         ├─ acquire MIGRATION_LOCK_PATH
                                         │    verify / run migrate:deploy once
                                         ├─ release MIGRATION_LOCK_PATH
                                         ├─ promote / health-check
                                         ├─ append terminal release record while still held
                                         └─ release DEPLOY_LOCK_PATH
```

The repository helper uses an atomic `mkdir` of the lock directory. The directory contains one `owner.json` record written with exclusive-create semantics. An existing path is `already_locked`; no stale-lock deletion, retry, or owner guessing is permitted. Release verifies the original directory and owner-file identities and exact owner record before removing anything. Corrupt, replaced, symlinked, extra-content, or cleanup-failed state remains in place and returns failure.

The orchestrator appends the terminal `end` record before attempting to release the outer lock. A release-record write failure changes the outcome to `AMBIGUOUS` and emits a bounded sanitized diagnostic. A lock-release failure also changes the outcome to `AMBIGUOUS` and emits only a bounded external diagnostic; it never appends to the release record after ownership may have been lost. Recovery-required migration outcomes remain preserved in the records already written while the final process result remains non-success.

The shell helper and Node helpers use the same directory-path contract. `DEPLOY_LOCK_FILE` remains an input alias for the non-migration helper only; a future VM wrapper must pass the canonical shared path explicitly. The runner requires only `MIGRATION_LOCK_PATH` and does not accept or infer an outer release lock.

## VM boundary

The actual VM-owned `/home/tilo/deploy-prod.sh` was not inspected by this repository change. Its reported SHA-256 is not evidence of its control flow or lock behavior. Until an authorized read-only inspection proves that it participates in this exact shared lock contract, the legacy wrapper is not considered coordinated and no wrapper installation or replacement is authorized.

The Phase 1 direct-Docker adapter remains unconditionally mutation-disabled. Its lock validator and operation surface are test infrastructure only.
