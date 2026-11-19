#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const broker = require("./rootful-deployment-broker");
const entrypoint = require("./production-deployment-entrypoint");
const orchestrator = require("./migration-aware-deploy");
const { createPrivilegedOperations } = require("./rootful-deployment-broker-privileged-operations");

const INSTALLATION_MANIFEST = "/etc/clashcookies/production-deployment.json";
const BROKER_SERVICE_MODULES = Object.freeze([
  "rootful-deployment-broker-service.js",
  "rootful-deployment-broker-privileged-operations.js",
  "production-deployment-entrypoint.js",
  "migration-aware-deploy.js",
  "direct-docker-adapter.js",
  "migration-runner.js",
  "deployment-lock.js",
  "rootful-deployment-broker.js",
]);

function validateBrokerServiceBundle(bundleRoot = __dirname, fsImpl = fs) {
  if (typeof bundleRoot !== "string" || !path.isAbsolute(bundleRoot)) {
    throw new broker.BrokerError("broker_service_bundle_root_invalid", "broker_configuration_invalid");
  }
  for (const relativePath of BROKER_SERVICE_MODULES) {
    const target = path.join(bundleRoot, relativePath);
    let stat;
    try { stat = fsImpl.lstatSync(target); } catch { throw new broker.BrokerError("broker_service_bundle_incomplete", "broker_configuration_invalid"); }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new broker.BrokerError("broker_service_bundle_identity_invalid", "broker_configuration_invalid");
    }
  }
  return Object.freeze({ root: path.resolve(bundleRoot), files: BROKER_SERVICE_MODULES });
}

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
function createRootfulBrokerService({
  installation,
  socketBoundary,
  peerIdentityResolver,
  fsImpl = fs,
  dependencies = {},
} = {}) {
  if (!installation?.manifest || !installation.publicKey) {
    throw new broker.BrokerError("broker_service_handlers_required", "broker_configuration_invalid");
  }
  if (!socketBoundary || socketBoundary.verified !== true
    || socketBoundary.socketPath !== installation.manifest.broker.socketPath
    || socketBoundary.ownerUid !== installation.manifest.broker.operator.uid
    || socketBoundary.ownerGid !== installation.manifest.broker.operator.gid
    || socketBoundary.mode !== 0o600
    || socketBoundary.activationVerified !== true
    || socketBoundary.exclusiveIdentity !== true
    || !socketBoundary.peerIdentity) {
    throw new broker.BrokerError("broker_socket_boundary_required", "broker_configuration_invalid");
  }
  validateBrokerServiceBundle(__dirname, fsImpl);
  const manifest = installation.manifest;
  const privileged = (dependencies.createPrivilegedOperations || createPrivilegedOperations)(manifest, dependencies);
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
    classifyReleaseDiff: (_payload, context) => privileged.classifyReleaseDiff(
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
    writeReleaseRecord: ({ event }, context) => privileged.writeReleaseRecord(
      manifest.adapter.releaseRecord.path,
      broker.createReleaseRecordLine(context, event),
    ),
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
        DEPLOY_LOCK_ALREADY_HELD: "1",
        DEPLOY_LOCK_OWNER_RELEASE_ID: context.release.releaseId,
      };
      return entrypoint.checkedCommand(helperPath, [], { cwd: manifest.appDir, env, label: "non_migration_deploy" });
    },
  };
  // The default identity is backed by the verified SocketUser/SocketMode=0600
  // activation contract, not by a client-supplied claim. A custom resolver is
  // accepted only for tests or a separately reviewed OS-credential adapter.
  const peerResolver = peerIdentityResolver || (() => socketBoundary.peerIdentity);
  if (typeof peerResolver !== "function") {
    throw new broker.BrokerError("broker_peer_identity_resolver_required", "broker_configuration_invalid");
  }
  const releaseConfig = (release) => ({
    releaseId: release.releaseId,
    oldSha: release.oldSha,
    newSha: release.newSha,
    migrationDiffDigest: release.migrationDiffDigest,
    migrationManifestDigest: release.migrationManifestDigest,
    authorizationDigest: release.authorizationDigest,
    approvedBy: release.approvedBy,
  });
  const phaseValidators = {
    readPreflightEvidence: (evidence, context) => orchestrator.verifyPreflightEvidence(releaseConfig(context.release), evidence),
    inspectCheckout: (checkout, context) => {
      if (!checkout || checkout.currentSha !== context.release.oldSha || checkout.trackedChanges || checkout.stagedChanges
        || !Array.isArray(checkout.unknownPaths)) {
        throw new broker.BrokerError("broker_checkout_evidence_invalid", "phase_evidence_invalid");
      }
      return checkout;
    },
    computeReleaseDiff: (diff, context, session) => {
      const verified = diff;
      if (!session.checkout || !Array.isArray(verified?.paths)) throw new broker.BrokerError("broker_checkout_evidence_missing", "phase_evidence_invalid");
      orchestrator.assertCheckoutSafety(session.checkout, verified.paths, context.release.oldSha);
      return verified;
    },
    classifyReleaseDiff: (diff, context, session) => {
      const verified = diff;
      if (!Array.isArray(verified?.paths)) throw new broker.BrokerError("broker_diff_evidence_invalid", "phase_evidence_invalid");
      if (session.checkout) orchestrator.assertCheckoutSafety(session.checkout, verified.paths, context.release.oldSha);
      return verified;
    },
    inspectRuntime: (runtime, context) => {
      const snapshot = orchestrator.assertRuntimeSingleton(runtime, {
        runtimeName: manifest.adapter.runtime.name,
        runtimeLabel: manifest.adapter.runtime.label,
        runtimeEnvironment: manifest.adapter.runtime.environment,
      });
      const expectedRevision = context.session.runtimeStarted ? context.release.newSha : context.release.oldSha;
      if (snapshot.revision !== expectedRevision) throw new broker.BrokerError("broker_runtime_revision_invalid", "phase_evidence_invalid");
      return snapshot;
    },
    runMigrationRunner: (result) => {
      orchestrator.assertMigrationRunnerResult(result);
      return result;
    },
    verifyMigration: (status) => {
      orchestrator.assertPostMigrationStatus(status);
      return status;
    },
    healthCheck: (health) => {
      orchestrator.assertHealthResult(health);
      return health;
    },
  };
  let stateStat;
  try {
    stateStat = fsImpl.lstatSync(manifest.broker.statePath);
    if (stateStat.isSymbolicLink() || !stateStat.isFile()
      || stateStat.uid !== 0 || stateStat.gid !== 0 || (stateStat.mode & 0o7777) !== 0o600) {
      throw new Error("broker_state_metadata_mismatch");
    }
  } catch {
    throw new broker.BrokerError("broker_state_target_unavailable", "broker_configuration_invalid");
  }
  const stateStore = broker.createDurableBrokerStateStore({ statePath: manifest.broker.statePath, fsImpl });
  const createServer = dependencies.createRootfulBrokerServer || broker.createRootfulBrokerServer;
  const createListener = dependencies.createUnixBrokerListener || broker.createUnixBrokerListener;
  const server = createServer({
    config: { ...manifest.broker, appDir: manifest.appDir },
    peerIdentitySource: () => socketBoundary.peerIdentity,
    approvalVerifierFactory: (consumedNonces) => broker.createEd25519ApprovalVerifier({
      publicKey: installation.publicKey,
      consumedNonces,
    }),
    handlers: fixedHandlers,
    phaseValidators,
    stateStore,
    deadlinePolicy: dependencies.deadlinePolicy,
  });
  const listener = createListener({
    server,
    socketPath: manifest.broker.socketPath,
    peerIdentityResolver: peerResolver,
    socketBoundary,
    deadlinePolicy: dependencies.deadlinePolicy,
  });
  return Object.freeze({ server, listener });
}

module.exports = {
  BROKER_SERVICE_MODULES,
  INSTALLATION_MANIFEST,
  createRootfulBrokerService,
  loadBrokerInstallation,
  validateBrokerServiceBundle,
};

if (require.main === module) {
  try {
    const installation = loadBrokerInstallation();
    const fd = Number(process.env.LISTEN_FDS) === 1 && Number(process.env.LISTEN_PID) === process.pid ? 3 : null;
    if (fd === null) throw new broker.BrokerError("broker_socket_activation_required", "broker_configuration_invalid");
    const socketBoundary = broker.verifySocketActivationBoundary({
      fd,
      socketPath: installation.manifest.broker.socketPath,
      operator: installation.manifest.broker.operator,
      activation: {
        listenPid: Number(process.env.LISTEN_PID),
        listenFds: Number(process.env.LISTEN_FDS),
        listenFd: fd,
      },
    });
    createRootfulBrokerService({ installation, socketBoundary });
  } catch {
    process.exitCode = 78;
  }
}
