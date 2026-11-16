"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const HEALTH_URL = "http://127.0.0.1:8085/healthz";
const RUNTIME_NAME = "clashcookies-app";
const RUNTIME_LABEL = "active";
const RUNTIME_ENVIRONMENT = "prod";
const MAX_RECORD_LINE = 2048;

const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FAILED: 1,
  LOCKED: 75,
  BLOCKED: 78,
  AMBIGUOUS: 70,
});

const REQUIRED_PREFLIGHT_GATES = Object.freeze([
  "releaseApproval",
  "targetIdentity",
  "migrationScope",
  "operatorIdentity",
  "checkoutSafety",
  "runtimeSingleton",
  "databaseIdentity",
  "migrationBaseline",
  "backupRestore",
  "diskCapacity",
  "healthMonitoring",
  "stagingOrWaiver",
  "historicalCompatibility",
]);

class OrchestratorError extends Error {
  constructor(message, exitCode = EXIT_CODES.BLOCKED, classification = "blocked", phase = "preflight", preserveState = false) {
    super(message);
    this.name = "OrchestratorError";
    this.exitCode = exitCode;
    this.classification = classification;
    this.phase = phase;
    this.preserveState = preserveState;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeValue(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[A-Za-z0-9._:/-]{1,96}$/.test(value)) return value;
  return fallback;
}

function writeBoundedLog(log, event, fields = {}) {
  const line = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value).replace(/[^A-Za-z0-9._:/-]/g, "_")}`)
    .join(" ");
  log(`[migration-aware-deploy] ${event} ${line}`.trim().slice(0, MAX_RECORD_LINE));
}

function requireText(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new OrchestratorError(`missing_or_malformed_${name.toLowerCase()}`);
  }
  return value;
}

function requireSafeToken(env, name, pattern = /^[A-Za-z0-9._:-]{1,96}$/) {
  const value = requireText(env, name);
  if (!pattern.test(value)) throw new OrchestratorError(`invalid_${name.toLowerCase()}`);
  return value;
}

function requireSha(env, name, length) {
  return requireSafeToken(env, name, new RegExp(`^[0-9a-f]{${length}}$`, "i")).toLowerCase();
}

function requireAbsolutePath(env, name) {
  const value = requireText(env, name);
  if (!path.isAbsolute(value) || value.endsWith("\\") || value.endsWith("/")) {
    throw new OrchestratorError(`invalid_${name.toLowerCase()}`);
  }
  return path.resolve(value);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function parseConfig(env = process.env, repoRoot = REPO_ROOT) {
  if (env.DEPLOY_EXECUTION_AUTHORIZED !== "1") {
    throw new OrchestratorError("deployment_execution_not_authorized", EXIT_CODES.BLOCKED, "unauthorized_release");
  }

  const targetEnvironment = requireSafeToken(env, "DEPLOY_TARGET_ENV", /^production$/);
  const releaseId = requireSafeToken(env, "DEPLOY_RELEASE_ID");
  const oldSha = requireSha(env, "DEPLOY_OLD_SHA", 40);
  const newSha = requireSha(env, "DEPLOY_NEW_SHA", 40);
  if (oldSha === newSha) throw new OrchestratorError("old_and_new_sha_must_differ");

  const migrationDiffDigest = requireSha(env, "DEPLOY_EXPECTED_MIGRATION_DIFF_DIGEST", 64);
  const migrationManifestDigest = requireSha(env, "DEPLOY_EXPECTED_MIGRATION_MANIFEST_DIGEST", 64);
  const authorizationDigest = requireSha(env, "DEPLOY_AUTHORIZATION_DIGEST", 64);
  const approvedBy = requireSafeToken(env, "DEPLOY_APPROVED_BY");
  const lockPath = requireAbsolutePath(env, "DEPLOY_LOCK_PATH");
  const releaseRecordPath = requireAbsolutePath(env, "DEPLOY_RELEASE_RECORD_PATH");
  const preflightEvidencePath = requireAbsolutePath(env, "DEPLOY_PREFLIGHT_EVIDENCE_PATH");
  const candidateWorktreePath = requireAbsolutePath(env, "DEPLOY_CANDIDATE_WORKTREE_PATH");

  if (isPathInside(repoRoot, releaseRecordPath) || isPathInside(repoRoot, preflightEvidencePath)) {
    throw new OrchestratorError("release_evidence_must_be_outside_checkout");
  }
  if (candidateWorktreePath === path.resolve(repoRoot) || isPathInside(repoRoot, candidateWorktreePath)) {
    throw new OrchestratorError("candidate_worktree_must_be_outside_checkout");
  }
  return Object.freeze({
    targetEnvironment,
    releaseId,
    oldSha,
    newSha,
    migrationDiffDigest,
    migrationManifestDigest,
    authorizationDigest,
    approvedBy,
    lockPath,
    releaseRecordPath,
    preflightEvidencePath,
    candidateWorktreePath,
    healthUrl: HEALTH_URL,
    runtimeName: RUNTIME_NAME,
    runtimeLabel: RUNTIME_LABEL,
    runtimeEnvironment: RUNTIME_ENVIRONMENT,
  });
}

function acquireExclusiveLock(lockPath, owner = {}) {
  try {
    fs.mkdirSync(lockPath);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new OrchestratorError("deployment_lock_already_held", EXIT_CODES.LOCKED, "already_locked");
    }
    throw new OrchestratorError("deployment_lock_unavailable", EXIT_CODES.BLOCKED, "lock_unavailable");
  }

  try {
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, ...owner }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    try { fs.rmdirSync(lockPath); } catch { /* fail closed; never remove recursively */ }
    throw new OrchestratorError("deployment_lock_initialization_failed", EXIT_CODES.BLOCKED, "lock_unavailable");
  }

  let released = false;
  return () => {
    if (released) return true;
    released = true;
    try {
      fs.unlinkSync(path.join(lockPath, "owner.json"));
      fs.rmdirSync(lockPath);
      return true;
    } catch {
      return false;
    }
  };
}

function readPreflightEvidence(evidencePath) {
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  } catch {
    throw new OrchestratorError("preflight_evidence_unavailable", EXIT_CODES.BLOCKED, "missing_preflight_evidence");
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new OrchestratorError("preflight_evidence_malformed");
  }
  return evidence;
}

function verifyPreflightEvidence(config, evidence) {
  if (evidence.releaseId !== config.releaseId
    || String(evidence.oldSha).toLowerCase() !== config.oldSha
    || String(evidence.newSha).toLowerCase() !== config.newSha
    || String(evidence.migrationDiffDigest).toLowerCase() !== config.migrationDiffDigest
    || String(evidence.migrationManifestDigest).toLowerCase() !== config.migrationManifestDigest
    || evidence.approvedBy !== config.approvedBy
    || evidence.authorizationDigest !== config.authorizationDigest
    || evidence.authorizationStatus !== "PASS") {
    throw new OrchestratorError("release_authorization_or_target_evidence_mismatch", EXIT_CODES.BLOCKED, "authorization_mismatch");
  }

  if (!evidence.gates || typeof evidence.gates !== "object") {
    throw new OrchestratorError("preflight_gates_missing", EXIT_CODES.BLOCKED, "missing_preflight_gate");
  }
  const blockedGate = REQUIRED_PREFLIGHT_GATES.find((gate) => evidence.gates[gate] !== "PASS");
  if (blockedGate) {
    throw new OrchestratorError(`preflight_gate_blocked_${blockedGate}`, EXIT_CODES.BLOCKED, "preflight_gate_blocked");
  }
  return Object.freeze({
    evidenceId: safeValue(String(evidence.evidenceId || "unknown")),
    gates: Object.freeze({ ...evidence.gates }),
  });
}

function runGit(repoRoot, args, spawnSyncImpl = childProcess.spawnSync) {
  const result = spawnSyncImpl("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (!result || result.status !== 0 || typeof result.stdout !== "string") {
    throw new OrchestratorError("git_operation_failed", EXIT_CODES.BLOCKED, "git_verification_failed");
  }
  return result.stdout;
}

function computeReleaseDiff(repoRoot, oldSha, newSha, spawnSyncImpl = childProcess.spawnSync) {
  const verifiedOldSha = runGit(repoRoot, ["rev-parse", "--verify", `${oldSha}^{commit}`], spawnSyncImpl).trim().toLowerCase();
  const verifiedNewSha = runGit(repoRoot, ["rev-parse", "--verify", `${newSha}^{commit}`], spawnSyncImpl).trim().toLowerCase();
  if (verifiedOldSha !== oldSha || verifiedNewSha !== newSha) {
    throw new OrchestratorError("release_sha_verification_mismatch", EXIT_CODES.BLOCKED, "release_identity_mismatch");
  }
  const names = runGit(
    repoRoot,
    ["diff", "--name-only", "--no-ext-diff", oldSha, newSha, "--", "prisma/schema.prisma", "prisma/migrations"],
    spawnSyncImpl,
  ).split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new OrchestratorError("no_prisma_changes_for_migration_aware_deploy", EXIT_CODES.BLOCKED, "non_migration_release");
  }
  const rawDiff = runGit(
    repoRoot,
    ["diff", "--binary", "--no-ext-diff", oldSha, newSha, "--", "prisma/schema.prisma", "prisma/migrations"],
    spawnSyncImpl,
  );
  return Object.freeze({ oldSha, newSha, paths: Object.freeze(names), digest: sha256(rawDiff) });
}

function assertCheckoutSafety(checkout, targetPaths, expectedSha) {
  if (!checkout || checkout.trackedChanges || checkout.stagedChanges || checkout.currentSha !== expectedSha) {
    throw new OrchestratorError("tracked_or_staged_changes_present", EXIT_CODES.BLOCKED, "checkout_not_clean");
  }
  const unknownPaths = Array.isArray(checkout.unknownPaths) ? checkout.unknownPaths : [];
  const collisions = unknownPaths.filter((unknownPath) => targetPaths.some((targetPath) => (
    targetPath === unknownPath
    || targetPath.startsWith(`${unknownPath}/`)
    || unknownPath.startsWith(`${targetPath}/`)
  )));
  if (collisions.length > 0) {
    throw new OrchestratorError("target_would_overwrite_unknown_files", EXIT_CODES.BLOCKED, "unknown_file_collision");
  }
}

function assertRuntimeSingleton(runtime, config) {
  if (!runtime || !Array.isArray(runtime.candidates) || runtime.candidates.length !== 1) {
    throw new OrchestratorError("active_runtime_singleton_required", EXIT_CODES.BLOCKED, "runtime_singleton_failed");
  }
  const candidate = runtime.candidates[0];
  if (candidate.name !== config.runtimeName
    || candidate.label !== config.runtimeLabel
    || candidate.environment !== config.runtimeEnvironment
    || candidate.port !== 8085
    || candidate.recognized !== true
    || typeof candidate.revision !== "string") {
    throw new OrchestratorError("active_runtime_identity_mismatch", EXIT_CODES.BLOCKED, "runtime_identity_failed");
  }
  return Object.freeze({ ...candidate });
}

function assertMigrationRunnerResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new OrchestratorError("migration_runner_result_missing", EXIT_CODES.AMBIGUOUS, "ambiguous_migration", "migration", true);
  }

  const hasExitCode = Object.prototype.hasOwnProperty.call(result, "exitCode");
  const hasStatus = Object.prototype.hasOwnProperty.call(result, "status");
  const hasSignal = Object.prototype.hasOwnProperty.call(result, "signal")
    && result.signal !== null
    && result.signal !== undefined
    && result.signal !== "";
  const hasError = Object.prototype.hasOwnProperty.call(result, "error")
    && result.error !== null
    && result.error !== undefined
    && result.error !== "";

  if (!hasExitCode || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
    || (hasStatus && (!Number.isInteger(result.status) || result.status < 0 || result.status > 255))
    || (hasStatus && result.status !== result.exitCode)
    || result.ambiguous === true
    || hasSignal
    || hasError) {
    throw new OrchestratorError("migration_result_ambiguous", EXIT_CODES.AMBIGUOUS, "ambiguous_migration", "migration", true);
  }
  if (result.exitCode === EXIT_CODES.BLOCKED) {
    throw new OrchestratorError(
      "migration_runner_blocked",
      EXIT_CODES.BLOCKED,
      safeValue(result.classification, "migration_runner_blocked"),
      "migration",
      true,
    );
  }
  if (result.exitCode === EXIT_CODES.AMBIGUOUS) {
    throw new OrchestratorError("migration_result_ambiguous", EXIT_CODES.AMBIGUOUS, "ambiguous_migration", "migration", true);
  }
  if (result.exitCode === 0) return;
  throw new OrchestratorError("migration_runner_failed", result.exitCode, "migration_failed", "migration", true);
}

function assertPostMigrationStatus(status) {
  if (!status || status.ambiguous === true || status.unresolved !== 0 || status.targetApplied !== true) {
    throw new OrchestratorError("post_migration_verification_failed", EXIT_CODES.AMBIGUOUS, "ambiguous_migration", "post_migration", true);
  }
}

function assertHealthResult(result) {
  if (!result || result.status !== 200) {
    throw new OrchestratorError("health_check_failed", EXIT_CODES.FAILED, "health_failed", "health", true);
  }
}

function defaultUnsupportedOperation(name) {
  throw new OrchestratorError(`${name}_requires_reviewed_vm_adapter`, EXIT_CODES.BLOCKED, "vm_adapter_unconfigured");
}

async function runReviewedMigrationRunner({ repoRoot, targetSha, migrationManifestDigest, releaseId }) {
  const runnerPath = path.join(repoRoot, "ops", "deploy", "migration-runner.js");
  if (!fs.existsSync(runnerPath)) {
    throw new OrchestratorError("migration_runner_missing_from_reviewed_checkout", EXIT_CODES.BLOCKED, "runner_contract_failed", "migration");
  }
  let runner;
  try {
    runner = require(runnerPath);
  } catch {
    throw new OrchestratorError("migration_runner_unavailable", EXIT_CODES.BLOCKED, "runner_contract_failed", "migration");
  }
  if (!runner || typeof runner.runMigrationRunner !== "function") {
    throw new OrchestratorError("migration_runner_contract_missing", EXIT_CODES.BLOCKED, "runner_contract_failed", "migration");
  }

  const result = await runner.runMigrationRunner({
    repoRoot,
    env: {
      ...process.env,
      MIGRATION_RELEASE_ID: releaseId,
      MIGRATION_TARGET_SHA: targetSha,
      MIGRATION_EXPECTED_MIGRATION_DIGEST: migrationManifestDigest,
    },
    // The migration runner owns its own bounded logging. Do not replay child
    // output or database errors through the deployment log.
    log: () => undefined,
  });
  return Object.freeze({ exitCode: result });
}

function createDefaultOperations() {
  return {
    readPreflightEvidence,
    acquireExclusiveLock,
    computeReleaseDiff,
    inspectCheckout: () => defaultUnsupportedOperation("checkout_inspection"),
    inspectRuntime: () => defaultUnsupportedOperation("runtime_inspection"),
    createCandidate: () => defaultUnsupportedOperation("candidate_creation"),
    buildCandidate: () => defaultUnsupportedOperation("candidate_build"),
    runMigrationRunner: runReviewedMigrationRunner,
    verifyMigration: () => defaultUnsupportedOperation("migration_verification"),
    stopRuntime: () => defaultUnsupportedOperation("runtime_stop"),
    checkoutRelease: () => defaultUnsupportedOperation("release_checkout"),
    startRuntime: () => defaultUnsupportedOperation("runtime_start"),
    healthCheck: () => defaultUnsupportedOperation("health_check"),
    cleanupCandidate: () => defaultUnsupportedOperation("candidate_cleanup"),
    writeReleaseRecord: (recordPath, line) => {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.writeFileSync(recordPath, `${line}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
    },
    now: () => new Date().toISOString(),
  };
}

function recordLine(event, fields) {
  return JSON.stringify({ event, ...fields }).slice(0, MAX_RECORD_LINE);
}

async function runMigrationAwareDeployment({
  env = process.env,
  repoRoot = REPO_ROOT,
  log = console.log,
  operations = {},
} = {}) {
  const ops = { ...createDefaultOperations(), ...operations };
  const startedAt = ops.now();
  let config;
  let releaseLock = null;
  let phase = "preflight";
  let exitCode = EXIT_CODES.BLOCKED;
  let classification = "blocked";
  let candidateCreated = false;
  let migrationStarted = false;
  let releaseRecordStarted = false;

  const appendRecord = (event, fields = {}) => {
    if (!config || typeof ops.writeReleaseRecord !== "function") return;
    ops.writeReleaseRecord(config.releaseRecordPath, recordLine(event, {
      releaseId: config.releaseId,
      oldSha: config.oldSha,
      newSha: config.newSha,
      migrationDiffDigest: config.migrationDiffDigest,
      migrationManifestDigest: config.migrationManifestDigest,
      phase,
      at: ops.now(),
      ...fields,
    }));
  };

  try {
    config = (operations.parseConfig || parseConfig)(env, repoRoot);
    releaseLock = (ops.acquireExclusiveLock || acquireExclusiveLock)(config.lockPath, {
      releaseId: config.releaseId,
      startedAt,
    });
    writeBoundedLog(log, "start", {
      release_id: safeValue(config.releaseId),
      old_sha: safeValue(config.oldSha),
      new_sha: safeValue(config.newSha),
      migration_diff_digest: safeValue(config.migrationDiffDigest),
      migration_manifest_digest: safeValue(config.migrationManifestDigest),
      started_at: startedAt,
    });
    releaseRecordStarted = true;
    appendRecord("lock_acquired");

    const evidence = ops.readPreflightEvidence(config.preflightEvidencePath);
    const verifiedEvidence = verifyPreflightEvidence(config, evidence);
    appendRecord("preflight_authorized", { evidenceId: verifiedEvidence.evidenceId });

    const checkout = await ops.inspectCheckout(repoRoot);
    const diff = await ops.computeReleaseDiff(repoRoot, config.oldSha, config.newSha);
    if (diff.oldSha !== config.oldSha || diff.newSha !== config.newSha) {
      throw new OrchestratorError("migration_diff_release_identity_mismatch", EXIT_CODES.BLOCKED, "release_identity_mismatch");
    }
    if (diff.digest !== config.migrationDiffDigest) {
      throw new OrchestratorError("migration_diff_digest_mismatch", EXIT_CODES.BLOCKED, "migration_identity_mismatch");
    }
    assertCheckoutSafety(checkout, diff.paths, config.oldSha);

    const runtimeBefore = assertRuntimeSingleton(await ops.inspectRuntime(), config);
    if (runtimeBefore.revision !== config.oldSha) {
      throw new OrchestratorError("observed_runtime_is_not_old_release", EXIT_CODES.BLOCKED, "runtime_identity_failed");
    }
    appendRecord("preflight_passed", {
      migration_paths: diff.paths.length,
      runtime_revision: runtimeBefore.revision,
    });

    phase = "candidate_build";
    await ops.createCandidate(config.candidateWorktreePath, config.newSha);
    candidateCreated = true;
    await ops.buildCandidate({
      candidatePath: config.candidateWorktreePath,
      sha: config.newSha,
      environment: Object.freeze({
        NODE_ENV: "production",
        POLLING_MODE: "disabled",
        POLLING_ENV: "build",
      }),
    });
    appendRecord("candidate_build_passed");

    phase = "migration";
    migrationStarted = true;
    const runnerResult = await ops.runMigrationRunner({
      repoRoot: config.candidateWorktreePath,
      targetSha: config.newSha,
      migrationDiffDigest: config.migrationDiffDigest,
      migrationManifestDigest: config.migrationManifestDigest,
      releaseId: config.releaseId,
    });
    assertMigrationRunnerResult(runnerResult);
    appendRecord("migration_passed", { runner_exit_code: 0 });

    phase = "post_migration";
    const migrationStatus = await ops.verifyMigration({
      repoRoot: config.candidateWorktreePath,
      targetSha: config.newSha,
      migrationDiffDigest: config.migrationDiffDigest,
      migrationManifestDigest: config.migrationManifestDigest,
    });
    assertPostMigrationStatus(migrationStatus);
    appendRecord("migration_verified");

    phase = "promotion";
    const runtimeDuringPromotion = assertRuntimeSingleton(await ops.inspectRuntime(), config);
    if (runtimeDuringPromotion.revision !== runtimeBefore.revision) {
      throw new OrchestratorError("runtime_changed_before_promotion", EXIT_CODES.BLOCKED, "runtime_identity_failed", phase, true);
    }
    await ops.stopRuntime({ expected: runtimeBefore });
    await ops.checkoutRelease({ repoRoot, sha: config.newSha, preserveUnknownFiles: true });
    await ops.startRuntime({
      sha: config.newSha,
      name: config.runtimeName,
      label: config.runtimeLabel,
      environment: config.runtimeEnvironment,
      pollingMode: "active",
    });
    const runtimeAfterStart = assertRuntimeSingleton(await ops.inspectRuntime(), config);
    if (runtimeAfterStart.revision !== config.newSha) {
      throw new OrchestratorError("started_runtime_revision_mismatch", EXIT_CODES.FAILED, "runtime_identity_failed", phase, true);
    }

    phase = "health";
    const health = await ops.healthCheck(config.healthUrl);
    assertHealthResult(health);
    appendRecord("promotion_passed", { health_status: 200 });
    if (candidateCreated) {
      await ops.cleanupCandidate({ path: config.candidateWorktreePath, sha: config.newSha });
      candidateCreated = false;
      appendRecord("candidate_cleaned");
    }
    exitCode = EXIT_CODES.SUCCESS;
    classification = "success";
  } catch (error) {
    const normalized = error instanceof OrchestratorError
      ? error
      : new OrchestratorError("unclassified_orchestrator_failure", EXIT_CODES.AMBIGUOUS, "ambiguous_failure", phase, true);
    exitCode = normalized.exitCode;
    classification = normalized.classification;
    phase = normalized.phase || phase;
    if (releaseRecordStarted) appendRecord("failure", { classification, exit_code: exitCode });

    if (candidateCreated && !migrationStarted && typeof ops.cleanupCandidate === "function") {
      try {
        await ops.cleanupCandidate({ path: config.candidateWorktreePath, sha: config.newSha });
        appendRecord("candidate_cleaned");
        candidateCreated = false;
      } catch {
        appendRecord("candidate_cleanup_preserved", { classification: "cleanup_failed" });
      }
    }

    if (migrationStarted && phase === "health") {
      appendRecord("old_runtime_rollback_blocked", { classification: "manual_recovery_required" });
    }
  } finally {
    const lockReleased = releaseLock ? releaseLock() : true;
    if (!lockReleased && exitCode === EXIT_CODES.SUCCESS) {
      exitCode = EXIT_CODES.AMBIGUOUS;
      classification = "lock_release_failed";
    }
    if (releaseRecordStarted && !lockReleased) appendRecord("lock_release_failed", { classification });
    if (releaseRecordStarted) appendRecord("end", { exit_code: exitCode, classification });
    writeBoundedLog(log, "end", {
      release_id: safeValue(config?.releaseId),
      old_sha: safeValue(config?.oldSha),
      new_sha: safeValue(config?.newSha),
      migration_diff_digest: safeValue(config?.migrationDiffDigest),
      migration_manifest_digest: safeValue(config?.migrationManifestDigest),
      ended_at: ops.now(),
      exit_code: exitCode,
      failure_class: classification,
    });
  }

  return exitCode;
}

module.exports = {
  EXIT_CODES,
  HEALTH_URL,
  REQUIRED_PREFLIGHT_GATES,
  RUNTIME_NAME,
  OrchestratorError,
  acquireExclusiveLock,
  assertCheckoutSafety,
  assertMigrationRunnerResult,
  assertPostMigrationStatus,
  assertRuntimeSingleton,
  computeReleaseDiff,
  parseConfig,
  readPreflightEvidence,
  runMigrationAwareDeployment,
  verifyPreflightEvidence,
};

if (require.main === module) {
  runMigrationAwareDeployment().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = EXIT_CODES.AMBIGUOUS;
  });
}
