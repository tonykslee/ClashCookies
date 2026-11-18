#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const broker = require("./rootful-deployment-broker");
const entrypoint = require("./production-deployment-entrypoint");
const { createPrivilegedOperations } = require("./rootful-deployment-broker-privileged-operations");

const INSTALLATION_MANIFEST = "/etc/clashcookies/production-deployment.json";

/**
 * Load only the non-secret installation contract. The broker service must be
 * started by the root-owned service manager; clients cannot select this path.
 */
function loadBrokerInstallation(manifestPath = INSTALLATION_MANIFEST, fsImpl = fs) {
  if (manifestPath !== INSTALLATION_MANIFEST) {
    throw new broker.BrokerError("broker_manifest_path_not_allowlisted", "broker_configuration_invalid");
  }
  const manifest = entrypoint.readJsonConfig(manifestPath, fsImpl);
  const publicKeyPem = fsImpl.readFileSync(manifest.broker.approval.publicKeyPath, "utf8");
  return Object.freeze({
    manifest,
    publicKey: crypto.createPublicKey(publicKeyPem),
  });
}

/**
 * Construct the privileged broker side. Privileged operation handlers are
 * supplied by the separately reviewed adapter bundle; this module never
 * accepts a handler path or client-provided executable.
 */
function createRootfulBrokerService({ installation, peerIdentityResolver } = {}) {
  if (!installation?.manifest || !installation.publicKey) {
    throw new broker.BrokerError("broker_service_handlers_required", "broker_configuration_invalid");
  }
  const manifest = installation.manifest;
  const privileged = createPrivilegedOperations(manifest);
  const lockReleasers = new Map();
  const fixedHandlers = {
    readPreflightEvidence: () => privileged.readPreflightEvidence(manifest.preflightEvidencePath),
    acquireExclusiveLock: (_payload, context) => {
      const release = privileged.acquireExclusiveLock(manifest.adapter.locks.releasePath, {
        releaseId: context.release.releaseId,
        startedAt: new Date().toISOString(),
      });
      if (typeof release !== "function") throw new broker.BrokerError("broker_lock_release_unavailable", "broker_unavailable");
      lockReleasers.set(context.sessionId, release);
      return { acquired: true };
    },
    releaseExclusiveLock: (_payload, context) => {
      const release = lockReleasers.get(context.sessionId);
      if (typeof release !== "function") throw new broker.BrokerError("broker_lock_release_unavailable", "broker_unavailable");
      const released = release();
      if (released !== true) throw new broker.BrokerError("broker_lock_release_failed", "broker_unavailable");
      lockReleasers.delete(context.sessionId);
      return { released: true };
    },
    computeReleaseDiff: (_payload, context) => privileged.computeReleaseDiff(
      manifest.appDir,
      context.release.oldSha,
      context.release.newSha,
    ),
    inspectCheckout: () => privileged.inspectCheckout(manifest.appDir),
    inspectRuntime: () => privileged.inspectRuntime(),
    createCandidate: ({ sha }) => privileged.createCandidate(manifest.candidateWorktreePath, sha),
    buildCandidate: ({ sha }) => privileged.buildCandidate({ candidatePath: manifest.candidateWorktreePath, sha }),
    runMigrationRunner: ({ releaseId, targetSha, migrationManifestDigest, migrationNames }) => privileged.runMigrationRunner({
      repoRoot: manifest.candidateWorktreePath,
      releaseId,
      targetSha,
      migrationManifestDigest,
      migrationNames,
    }),
    verifyMigration: ({ targetSha, migrationNames }) => privileged.verifyMigration({
      repoRoot: manifest.candidateWorktreePath,
      targetSha,
      migrationNames,
    }),
    verifyPromotedArtifact: ({ sha }) => privileged.verifyPromotedArtifact({ sha }),
    stopRuntime: () => privileged.stopRuntime(),
    checkoutRelease: ({ sha }) => privileged.checkoutRelease({ sha }),
    startRuntime: ({ sha }) => privileged.startRuntime({ sha }),
    healthCheck: () => privileged.healthCheck(`http://127.0.0.1:${manifest.adapter.runtime.hostPort}/healthz`),
    cleanupCandidate: ({ sha }) => privileged.cleanupCandidate({ path: manifest.candidateWorktreePath, sha }),
    writeReleaseRecord: ({ line }) => privileged.writeReleaseRecord(manifest.adapter.releaseRecord.path, line),
    runNonMigration: (_payload, context) => {
      const helperPath = entrypoint.validateProtectedArtifact(manifest.nonMigrationHelper, manifest.appDir);
      const env = {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        DEPLOYMENT_ACTIVATION_AUTHORIZED: "1",
        DEPLOY_EXECUTION_AUTHORIZED: "1",
        DEPLOY_RELEASE_ID: context.release.releaseId,
        DEPLOY_OLD_SHA: context.release.oldSha,
        DEPLOY_NEW_SHA: context.release.newSha,
        DEPLOY_EXPECTED_MIGRATION_DIFF_DIGEST: context.release.migrationDiffDigest,
        DEPLOY_EXPECTED_MIGRATION_MANIFEST_DIGEST: context.release.migrationManifestDigest,
        DEPLOY_AUTHORIZATION_DIGEST: context.release.authorizationDigest,
        DEPLOY_APPROVED_BY: context.release.approvedBy,
        TARGET_REF: context.release.newSha,
        APP_DIR: manifest.appDir,
      };
      return entrypoint.checkedCommand(helperPath, [], { cwd: manifest.appDir, env, label: "non_migration_deploy" });
    },
  };
  const peerResolver = peerIdentityResolver || (() => manifest.broker.operator);
  const server = broker.createRootfulBrokerServer({
    config: { ...manifest, appDir: manifest.appDir },
    peerIdentitySource: () => manifest.broker.operator,
    approvalVerifier: broker.createEd25519ApprovalVerifier({ publicKey: installation.publicKey }),
    handlers: fixedHandlers,
  });
  const listener = broker.createUnixBrokerListener({
    server,
    socketPath: manifest.broker.socketPath,
    peerIdentityResolver: peerResolver,
  });
  return Object.freeze({ server, listener });
}

module.exports = {
  INSTALLATION_MANIFEST,
  createRootfulBrokerService,
  loadBrokerInstallation,
};

if (require.main === module) {
  try {
    const installation = loadBrokerInstallation();
    createRootfulBrokerService({ installation });
  } catch {
    process.exitCode = 78;
  }
}
