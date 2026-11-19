"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const broker = require(process.env.BROKER_MODULE_PATH);
const entrypoint = require(process.env.BROKER_ENTRYPOINT_PATH);
const service = require(process.env.BROKER_SERVICE_PATH);

const manifest = entrypoint.validateProductionManifest(JSON.parse(fs.readFileSync(process.env.BROKER_MANIFEST_PATH, "utf8")));
const socketPath = manifest.broker.socketPath;
const statePath = manifest.broker.statePath;
const publicKey = crypto.createPublicKey(fs.readFileSync(manifest.broker.approval.publicKeyPath, "utf8"));
const delayMs = Number(process.env.BROKER_DELAY_MS || 0);
const deadlinePolicy = process.env.BROKER_DEADLINE_POLICY ? JSON.parse(process.env.BROKER_DEADLINE_POLICY) : undefined;
const operator = manifest.broker.operator;
const socketBoundary = broker.verifySocketActivationBoundary({
  fd: 3,
  socketPath,
  operator,
  activation: { listenPid: process.pid, listenFds: 1, listenFd: 3 },
});

const releaseEvidence = () => ({
  evidenceId: "synthetic-evidence",
  releaseId: process.env.BROKER_RELEASE_ID,
  oldSha: process.env.BROKER_OLD_SHA,
  newSha: process.env.BROKER_NEW_SHA,
  migrationDiffDigest: process.env.BROKER_DIFF_DIGEST,
  migrationManifestDigest: process.env.BROKER_MANIFEST_DIGEST,
  authorizationDigest: process.env.BROKER_AUTH_DIGEST,
  approvedBy: process.env.BROKER_APPROVED_BY,
  authorizationStatus: "PASS",
  gates: {
    releaseApproval: "PASS", targetIdentity: "PASS", migrationScope: "PASS", operatorIdentity: "PASS",
    checkoutSafety: "PASS", runtimeSingleton: "PASS", databaseIdentity: "PASS", migrationBaseline: "PASS",
    backupRestore: "PASS", diskCapacity: "PASS", healthMonitoring: "PASS", stagingOrWaiver: "PASS", historicalCompatibility: "PASS",
  },
});

const delay = () => new Promise((resolve) => setTimeout(resolve, delayMs));
const privileged = {
  readPreflightEvidence: () => releaseEvidence(),
  acquireExclusiveLock: () => () => true,
  releaseExclusiveLock: () => true,
  inspectCheckout: () => ({ currentSha: "a".repeat(40), trackedChanges: false, stagedChanges: false, unknownPaths: [] }),
  computeReleaseDiff: (_appDir, oldSha, newSha) => ({ oldSha, newSha, digest: "c".repeat(64), paths: ["prisma/migrations/synthetic/migration.sql"], migrationNames: ["synthetic"] }),
  inspectRuntime: () => ({ candidates: [{ name: "clashcookies-app", label: "active", environment: "prod", port: 8085, recognized: true, revision: "a".repeat(40) }] }),
  createCandidate: () => undefined,
  buildCandidate: () => undefined,
  runMigrationRunner: async () => { await delay(); return { exitCode: 0 }; },
  verifyMigration: () => ({ unresolved: 0, targetApplied: true }),
  verifyPromotedArtifact: () => undefined,
  stopRuntime: () => undefined,
  checkoutRelease: () => undefined,
  startRuntime: () => undefined,
  healthCheck: () => ({ status: 200 }),
  cleanupCandidate: () => undefined,
  writeReleaseRecord: () => undefined,
};

const fsImpl = Object.create(fs);
const originalLstat = fs.lstatSync.bind(fs);
fsImpl.lstatSync = (target) => {
  const stat = originalLstat(target);
  if (target === statePath) return Object.assign(stat, { uid: 0, gid: 0 });
  return stat;
};

const result = service.createRootfulBrokerService({
  installation: { manifest, publicKey },
  socketBoundary,
  fsImpl,
  dependencies: { createPrivilegedOperations: () => privileged, deadlinePolicy },
});
result.listener.once("error", () => process.exit(92));
result.listener.once("listening", () => process.stdout.write("ready\n"));
