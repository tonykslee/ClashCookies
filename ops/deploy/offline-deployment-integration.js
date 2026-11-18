"use strict";

const path = require("node:path");
const directAdapter = require("./direct-docker-adapter");
const orchestrator = require("./migration-aware-deploy");

/**
 * Convert an adapter failure into the orchestrator's fail-closed preflight
 * contract without exposing filesystem, credential, or identity details.
 */
function integrationError(message, cause) {
  if (cause instanceof orchestrator.OrchestratorError) return cause;
  return new orchestrator.OrchestratorError(
    message,
    orchestrator.EXIT_CODES.BLOCKED,
    "integration_trust_failed",
  );
}

function requireSamePath(left, right, name) {
  if (path.resolve(left) !== path.resolve(right)) {
    throw new orchestrator.OrchestratorError(
      `${name}_mismatch`,
      orchestrator.EXIT_CODES.BLOCKED,
      "integration_contract_mismatch",
    );
  }
}

/**
 * Keep the returned integration result bounded and free of credentials or
 * caller-supplied group claims. The result is evidence, not authorization to
 * execute a deployment.
 */
function summarizeVerifiedBoundary(adapterConfig, deploymentConfig, evidence) {
  return Object.freeze({
    status: "PASS",
    productionExecutionEnabled: false,
    adapter: Object.freeze({
      targetEnvironment: adapterConfig.targetEnvironment,
      appDir: adapterConfig.appDir,
      executor: Object.freeze({
        path: adapterConfig.executor.path,
        sha256: adapterConfig.executor.sha256,
        ownerUid: adapterConfig.executor.ownerUid,
        ownerGid: adapterConfig.executor.ownerGid,
        mode: adapterConfig.executor.mode,
        authorizationStatus: adapterConfig.executor.authorization.authorizationStatus,
        independentOperatorIdentity: "os-backed-process-identity",
      }),
      credential: Object.freeze({
        path: adapterConfig.credential.path,
        ownerUid: adapterConfig.credential.ownerUid,
        ownerGid: adapterConfig.credential.ownerGid,
        mode: adapterConfig.credential.mode,
      }),
      locks: Object.freeze({
        releasePath: adapterConfig.locks.releasePath,
        runnerPath: adapterConfig.locks.runnerPath,
      }),
      releaseRecord: Object.freeze({
        path: adapterConfig.releaseRecord.path,
        ownerUid: adapterConfig.releaseRecord.ownerUid,
        ownerGid: adapterConfig.releaseRecord.ownerGid,
        mode: adapterConfig.releaseRecord.mode,
        appendOnlyVerified: true,
      }),
    }),
    deployment: Object.freeze({
      targetEnvironment: deploymentConfig.targetEnvironment,
      releaseId: deploymentConfig.releaseId,
      oldSha: deploymentConfig.oldSha,
      newSha: deploymentConfig.newSha,
      migrationDiffDigest: deploymentConfig.migrationDiffDigest,
      migrationManifestDigest: deploymentConfig.migrationManifestDigest,
      lockPath: deploymentConfig.lockPath,
      migrationLockPath: deploymentConfig.migrationLockPath,
      releaseRecordPath: deploymentConfig.releaseRecordPath,
      evidenceId: evidence.evidenceId,
      gates: evidence.gates,
    }),
  });
}

/**
 * Create the offline-only integration guard shared by the direct adapter and
 * migration-aware orchestrator. The guard is intentionally not an operation
 * surface: it returns verification evidence only. When supplied through the
 * orchestrator's optional hook, the orchestrator rejects that offline-only
 * result before sampling its clock or invoking any deployment operation.
 */
function createOfflineDeploymentIntegration({ adapterConfig, dependencies = {} } = {}) {
  const guard = async ({ config, readPreflightEvidence } = {}) => {
    if (!config || typeof config !== "object") {
      throw new orchestrator.OrchestratorError(
        "integration_deployment_config_missing",
        orchestrator.EXIT_CODES.BLOCKED,
        "integration_contract_mismatch",
      );
    }
    if (typeof readPreflightEvidence !== "function") {
      throw new orchestrator.OrchestratorError(
        "integration_preflight_reader_missing",
        orchestrator.EXIT_CODES.BLOCKED,
        "integration_contract_mismatch",
      );
    }

    let adapterInstance;
    try {
      // Only the filesystem and explicitly marked synthetic identity seam may
      // be injected. The adapter itself rejects unmarked synthetic identity.
      adapterInstance = directAdapter.createDirectDockerAdapter(adapterConfig, {
        fs: dependencies.fs,
        operatorIdentitySource: dependencies.operatorIdentitySource,
        testOnlyOperatorIdentityEvidence: dependencies.testOnlyOperatorIdentityEvidence,
      });
    } catch (error) {
      throw integrationError("offline_integration_adapter_trust_failed", error);
    }

    if (!adapterInstance.config.enabled
      || adapterInstance.config.verificationStatus !== "PASS") {
      throw new orchestrator.OrchestratorError(
        "offline_integration_adapter_not_verified",
        orchestrator.EXIT_CODES.BLOCKED,
        "integration_trust_failed",
      );
    }
    if (adapterInstance.config.allowMutations || adapterInstance.config.allowMigrationExecution) {
      throw new orchestrator.OrchestratorError(
        "offline_integration_execution_flags_must_remain_disabled",
        orchestrator.EXIT_CODES.BLOCKED,
        "phase1_execution_disabled",
      );
    }

    try {
      if (adapterInstance.config.targetEnvironment !== config.targetEnvironment) {
        throw new orchestrator.OrchestratorError(
          "integration_target_environment_mismatch",
          orchestrator.EXIT_CODES.BLOCKED,
          "integration_contract_mismatch",
        );
      }
      requireSamePath(adapterInstance.config.locks.releasePath, config.lockPath, "integration_release_lock");
      requireSamePath(adapterInstance.config.locks.runnerPath, config.migrationLockPath, "integration_runner_lock");
      requireSamePath(adapterInstance.config.releaseRecord.path, config.releaseRecordPath, "integration_release_record");
    } catch (error) {
      throw integrationError("offline_integration_contract_mismatch", error);
    }

    let evidence;
    try {
      evidence = await readPreflightEvidence(config.preflightEvidencePath);
      // This check remains in the orchestrator as well after the lock is held.
      // The early copy prevents missing or invalid trust evidence from even
      // acquiring the deployment lock; the second check detects replacement.
      orchestrator.verifyPreflightEvidence(config, evidence);
    } catch (error) {
      throw integrationError("offline_integration_preflight_evidence_invalid", error);
    }

    return summarizeVerifiedBoundary(
      adapterInstance.config,
      config,
      orchestrator.verifyPreflightEvidence(config, evidence),
    );
  };

  return Object.freeze({
    status: "OFFLINE_ONLY",
    productionExecutionEnabled: false,
    guard,
  });
}

module.exports = {
  createOfflineDeploymentIntegration,
};
