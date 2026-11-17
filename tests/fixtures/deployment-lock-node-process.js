"use strict";

const fs = require("node:fs");
const path = require("node:path");
const orchestrator = require("../../ops/deploy/migration-aware-deploy.js");

const [mode, lockPath, readyPath, releasePath, resultPath] = process.argv.slice(2);
if (!mode || !lockPath || !readyPath || !releasePath || !resultPath) {
  throw new Error("mode, lock, ready, release, and result paths are required");
}

function writeResult(result) {
  fs.writeFileSync(resultPath, JSON.stringify(result), "utf8");
}

function holdLock() {
  const release = orchestrator.acquireExclusiveLock(lockPath, { entrypoint: "node-fixture" });
  fs.writeFileSync(readyPath, "ready", "utf8");

  const waitForRelease = () => {
    if (!fs.existsSync(releasePath)) {
      setTimeout(waitForRelease, 20);
      return;
    }
    const released = release();
    writeResult({ released });
    process.exitCode = released ? 0 : 1;
  };
  waitForRelease();
}

async function attemptDeployment() {
  const root = path.dirname(lockPath);
  const calls = [];
  const env = {
    DEPLOY_EXECUTION_AUTHORIZED: "1",
    DEPLOY_TARGET_ENV: "production",
    DEPLOY_RELEASE_ID: "cross-process-node-attempt",
    DEPLOY_OLD_SHA: "a".repeat(40),
    DEPLOY_NEW_SHA: "b".repeat(40),
    DEPLOY_EXPECTED_MIGRATION_DIFF_DIGEST: "c".repeat(64),
    DEPLOY_EXPECTED_MIGRATION_MANIFEST_DIGEST: "d".repeat(64),
    DEPLOY_AUTHORIZATION_DIGEST: "e".repeat(64),
    DEPLOY_APPROVED_BY: "cross-process-test",
    DEPLOY_LOCK_PATH: lockPath,
    DEPLOY_MIGRATION_LOCK_PATH: path.join(root, "migration.lock"),
    DEPLOY_RELEASE_RECORD_PATH: path.join(root, "record.jsonl"),
    DEPLOY_PREFLIGHT_EVIDENCE_PATH: path.join(root, "preflight.json"),
    DEPLOY_CANDIDATE_WORKTREE_PATH: path.join(root, "candidate"),
  };
  const gates = Object.fromEntries(
    orchestrator.REQUIRED_PREFLIGHT_GATES.map((gate) => [gate, "PASS"]),
  );

  const exitCode = await orchestrator.runMigrationAwareDeployment({
    env,
    repoRoot: process.cwd(),
    log: () => undefined,
    operations: {
      acquireExclusiveLock: orchestrator.acquireExclusiveLock,
      readPreflightEvidence: () => ({
        evidenceId: "cross-process-evidence",
        releaseId: env.DEPLOY_RELEASE_ID,
        oldSha: env.DEPLOY_OLD_SHA,
        newSha: env.DEPLOY_NEW_SHA,
        migrationDiffDigest: env.DEPLOY_EXPECTED_MIGRATION_DIFF_DIGEST,
        migrationManifestDigest: env.DEPLOY_EXPECTED_MIGRATION_MANIFEST_DIGEST,
        approvedBy: env.DEPLOY_APPROVED_BY,
        authorizationDigest: env.DEPLOY_AUTHORIZATION_DIGEST,
        authorizationStatus: "PASS",
        gates,
      }),
      inspectCheckout: () => {
        calls.push("inspect-checkout");
        return {};
      },
      inspectRuntime: () => {
        calls.push("inspect-runtime");
        return {};
      },
    },
  });

  writeResult({ exitCode, calls });
  process.exitCode = exitCode === orchestrator.EXIT_CODES.LOCKED ? 0 : 1;
}

if (mode === "hold") {
  holdLock();
} else if (mode === "attempt") {
  attemptDeployment().catch((error) => {
    writeResult({ error: error instanceof Error ? error.name : "unknown" });
    process.exitCode = 1;
  });
} else {
  throw new Error(`unknown mode=${mode}`);
}
