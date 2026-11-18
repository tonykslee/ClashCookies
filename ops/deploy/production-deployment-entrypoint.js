#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const childProcess = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");
const orchestrator = require("./migration-aware-deploy");
const adapter = require("./direct-docker-adapter");
const migrationRunner = require("./migration-runner");

const CONFIG_VERSION = 1;
const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,96}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const SHA1 = /^[0-9a-f]{40}$/i;
const REQUIRED_MODULES = Object.freeze([
  "migration-aware-deploy.js",
  "direct-docker-adapter.js",
  "migration-runner.js",
  "deployment-lock.js",
]);

const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  FAILED: 1,
  LOCKED: 75,
  BLOCKED: 78,
  AMBIGUOUS: 70,
});

class ProductionEntrypointError extends Error {
  constructor(message, exitCode = EXIT_CODES.BLOCKED, classification = "integration_blocked") {
    super(message);
    this.name = "ProductionEntrypointError";
    this.exitCode = exitCode;
    this.classification = classification;
  }
}

function requireAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n]/.test(value)) {
    throw new ProductionEntrypointError(`invalid_${name}`);
  }
  return path.resolve(value);
}

function requireSha(value, name, pattern = SHA256) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProductionEntrypointError(`invalid_${name}`);
  }
  return value.toLowerCase();
}

function requireToken(value, name) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new ProductionEntrypointError(`invalid_${name}`);
  }
  return value;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateActivation(input) {
  const activation = input.activation;
  if (!activation || activation.authorizationStatus !== "PASS"
    || activation.scope !== "production-deployment-entrypoint") {
    throw new ProductionEntrypointError("activation_authorization_required", EXIT_CODES.BLOCKED, "activation_required");
  }
  return Object.freeze({
    authorizationStatus: "PASS",
    scope: activation.scope,
    authorizationDigest: requireSha(activation.authorizationDigest, "activation_authorization_digest"),
    approvedBy: requireToken(activation.approvedBy, "activation_approved_by"),
    reviewedCommit: requireSha(activation.reviewedCommit, "activation_reviewed_commit", SHA1),
  });
}

/**
 * Validate the proposed installation contract without touching a VM.
 * Paths are intentionally configuration-bound; this function does not claim
 * that any proposed resource is installed.
 */
function validateProductionManifest(input = {}) {
  if (!input || input.schemaVersion !== CONFIG_VERSION) {
    throw new ProductionEntrypointError("deployment_manifest_version_invalid");
  }
  const appDir = requireAbsolute(input.appDir, "app_dir");
  const candidateWorktreePath = requireAbsolute(input.candidateWorktreePath, "candidate_worktree_path");
  if (isInside(appDir, candidateWorktreePath)) {
    throw new ProductionEntrypointError("candidate_worktree_must_be_outside_checkout");
  }
  const preflightEvidencePath = requireAbsolute(input.preflightEvidencePath, "preflight_evidence_path");
  if (isInside(appDir, preflightEvidencePath)) {
    throw new ProductionEntrypointError("preflight_evidence_must_be_outside_checkout");
  }
  const promotionArtifactRoot = requireAbsolute(input.promotionArtifactRoot, "promotion_artifact_root");
  if (isInside(appDir, promotionArtifactRoot)) {
    throw new ProductionEntrypointError("promotion_artifact_must_be_outside_checkout");
  }

  const adapterConfig = adapter.validateAdapterConfig({
    ...input,
    adapterEnabled: true,
    appDir,
    allowMutations: false,
    allowMigrationExecution: false,
  });
  const activation = validateActivation(input);
  const runtimeCredential = input.runtimeCredential || {};
  if (runtimeCredential.format !== "docker-env"
    || runtimeCredential.verified !== true
    || typeof runtimeCredential.databaseUser !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(runtimeCredential.databaseUser)
    || runtimeCredential.databaseUser === String(input.databaseIdentity?.user || "")) {
    throw new ProductionEntrypointError("least_privilege_runtime_credential_required");
  }
  const moduleBundleInput = input.moduleBundle || {};
  const moduleBundleRoot = requireAbsolute(moduleBundleInput.root, "module_bundle_root");
  if (moduleBundleInput.verified !== true
    || moduleBundleRoot !== path.dirname(adapterConfig.executor.path)
    || !Array.isArray(moduleBundleInput.files)
    || moduleBundleInput.files.length !== REQUIRED_MODULES.length) {
    throw new ProductionEntrypointError("module_bundle_contract_invalid");
  }
  const moduleBundleFiles = moduleBundleInput.files.map((file) => {
    if (!file || typeof file.relativePath !== "string" || !REQUIRED_MODULES.includes(file.relativePath)
      || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)
      || !Number.isInteger(file.ownerUid) || !Number.isInteger(file.ownerGid)
      || !Number.isInteger(file.mode) || file.verified !== true) {
      throw new ProductionEntrypointError("module_bundle_file_contract_invalid");
    }
    return Object.freeze({
      relativePath: file.relativePath,
      sha256: file.sha256.toLowerCase(),
      ownerUid: file.ownerUid,
      ownerGid: file.ownerGid,
      mode: file.mode,
      verified: true,
    });
  });
  const nonMigrationHelper = input.nonMigrationHelper || {};
  const helperPath = requireAbsolute(nonMigrationHelper.path, "non_migration_helper_path");
  const helper = Object.freeze({
    path: helperPath,
    sha256: requireSha(nonMigrationHelper.sha256, "non_migration_helper_sha256"),
    ownerUid: nonMigrationHelper.ownerUid,
    ownerGid: nonMigrationHelper.ownerGid,
    mode: nonMigrationHelper.mode,
    verified: nonMigrationHelper.verified === true,
  });
  if (!helper.verified || !Number.isInteger(helper.ownerUid) || !Number.isInteger(helper.ownerGid)
    || !Number.isInteger(helper.mode)) {
    throw new ProductionEntrypointError("non_migration_helper_identity_required");
  }

  return Object.freeze({
    schemaVersion: CONFIG_VERSION,
    targetEnvironment: "production",
    appDir,
    candidateWorktreePath,
    preflightEvidencePath,
    promotionArtifactRoot,
    activation,
    moduleBundle: Object.freeze({
      root: moduleBundleRoot,
      files: Object.freeze(moduleBundleFiles),
      verified: true,
    }),
    adapter: adapterConfig,
    nonMigrationHelper: helper,
  });
}

function readJsonConfig(configPath, fsImpl = fs) {
  const filePath = requireAbsolute(configPath, "deployment_config_path");
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    throw new ProductionEntrypointError("deployment_manifest_unavailable");
  }
  return validateProductionManifest(parsed);
}

function ensureExplicitActivation(manifest, env) {
  if (env.DEPLOYMENT_ACTIVATION_AUTHORIZED !== "1") {
    throw new ProductionEntrypointError("deployment_activation_not_authorized", EXIT_CODES.BLOCKED, "activation_required");
  }
  if (env.DEPLOYMENT_ACTIVATION_DIGEST !== manifest.activation.authorizationDigest) {
    throw new ProductionEntrypointError("deployment_activation_digest_mismatch", EXIT_CODES.BLOCKED, "activation_mismatch");
  }
}

function validateProtectedArtifact(spec, appDir, fsImpl = fs) {
  if (!spec || spec.verified !== true) {
    throw new ProductionEntrypointError("protected_artifact_verification_required");
  }
  const artifactPath = requireAbsolute(spec.path, "protected_artifact_path");
  if (isInside(appDir, artifactPath)) {
    throw new ProductionEntrypointError("protected_artifact_must_be_outside_checkout");
  }
  if (typeof fsImpl.lstatSync !== "function" || typeof fsImpl.realpathSync !== "function") {
    throw new ProductionEntrypointError("protected_artifact_filesystem_unavailable");
  }
  let stat;
  try {
    stat = fsImpl.lstatSync(artifactPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not_regular_file");
    if (fsImpl.realpathSync(artifactPath) !== artifactPath) throw new Error("noncanonical");
  } catch {
    throw new ProductionEntrypointError("protected_artifact_identity_unavailable");
  }
  if (stat.uid !== spec.ownerUid || stat.gid !== spec.ownerGid || (stat.mode & 0o7777) !== spec.mode) {
    throw new ProductionEntrypointError("protected_artifact_metadata_mismatch");
  }
  const digest = crypto.createHash("sha256").update(fsImpl.readFileSync(artifactPath)).digest("hex");
  if (digest !== spec.sha256.toLowerCase()) {
    throw new ProductionEntrypointError("protected_artifact_checksum_mismatch");
  }
  return artifactPath;
}

function validateProtectedDirectoryTarget(directoryPath, appDir, fsImpl = fs) {
  const target = requireAbsolute(directoryPath, "protected_directory_path");
  if (isInside(appDir, target)
    || typeof fsImpl.lstatSync !== "function"
    || typeof fsImpl.realpathSync !== "function") {
    throw new ProductionEntrypointError("protected_directory_target_invalid");
  }
  let stat;
  try {
    stat = fsImpl.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fsImpl.realpathSync(target) !== target) {
      throw new Error("noncanonical_directory");
    }
  } catch {
    throw new ProductionEntrypointError("protected_directory_target_unavailable");
  }
  return target;
}

function validateModuleBundle(bundle, appDir, executorPath, fsImpl = fs) {
  if (!bundle || bundle.verified !== true || typeof bundle.root !== "string") {
    throw new ProductionEntrypointError("module_bundle_verification_required");
  }
  const root = validateProtectedDirectoryTarget(bundle.root, appDir, fsImpl);
  if (path.resolve(root) !== path.dirname(path.resolve(executorPath))) {
    throw new ProductionEntrypointError("module_bundle_executor_directory_mismatch");
  }
  if (!Array.isArray(bundle.files)
    || bundle.files.length !== REQUIRED_MODULES.length
    || new Set(bundle.files.map((file) => file && file.relativePath)).size !== REQUIRED_MODULES.length
    || REQUIRED_MODULES.some((name) => !bundle.files.some((file) => file.relativePath === name))) {
    throw new ProductionEntrypointError("module_bundle_membership_invalid");
  }
  for (const file of bundle.files) {
    if (typeof file.relativePath !== "string"
      || path.isAbsolute(file.relativePath)
      || file.relativePath === ".."
      || file.relativePath.includes("/")
      || file.relativePath.includes("\\")
      || file.verified !== true) {
      throw new ProductionEntrypointError("module_bundle_path_invalid");
    }
    validateProtectedArtifact({
      path: path.join(root, file.relativePath),
      sha256: file.sha256,
      ownerUid: file.ownerUid,
      ownerGid: file.ownerGid,
      mode: file.mode,
      verified: true,
    }, appDir, fsImpl);
  }
  return root;
}

function createCandidatePrismaFactory(repoRoot, databaseUrl) {
  const requireFromCandidate = createRequire(path.join(repoRoot, "package.json"));
  return () => {
    const { PrismaClient } = requireFromCandidate("@prisma/client");
    return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  };
}

function commandResult(command, args, options = {}, spawnSyncImpl = childProcess.spawnSync) {
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: options.maxBuffer || 128 * 1024,
  });
  if (!result || result.error || result.signal || typeof result.status !== "number") {
    throw new ProductionEntrypointError(`${options.label || command}_ambiguous`, EXIT_CODES.AMBIGUOUS, "ambiguous_execution");
  }
  return Object.freeze({ status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" });
}

function checkedCommand(command, args, options = {}, spawnSyncImpl = childProcess.spawnSync) {
  const result = commandResult(command, args, options, spawnSyncImpl);
  if (result.status !== 0) {
    throw new ProductionEntrypointError(`${options.label || command}_failed`, EXIT_CODES.FAILED, "command_failed");
  }
  return result.stdout;
}

function safeGit(repoRoot, args, spawnSyncImpl) {
  return checkedCommand("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, ...args], {
    label: "git_operation",
  }, spawnSyncImpl);
}

function inspectCheckout(repoRoot, spawnSyncImpl = childProcess.spawnSync) {
  const currentSha = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"], spawnSyncImpl).trim().toLowerCase();
  if (!SHA1.test(currentSha)) throw new ProductionEntrypointError("checkout_sha_invalid");
  const tracked = commandResult("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, "diff", "--quiet"], { label: "git_diff" }, spawnSyncImpl).status === 0;
  const staged = commandResult("git", ["-c", `safe.directory=${repoRoot}`, "-C", repoRoot, "diff", "--cached", "--quiet"], { label: "git_cached_diff" }, spawnSyncImpl).status === 0;
  const unknownPaths = safeGit(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], spawnSyncImpl)
    .split(/\r?\n/).map((entry) => entry.replace(/\/$/, "")).filter(Boolean);
  return Object.freeze({ currentSha, trackedChanges: !tracked, stagedChanges: !staged, unknownPaths });
}

function createProductionOperations(manifest, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const spawnSyncImpl = dependencies.spawnSync || childProcess.spawnSync;
  const commandExecutor = dependencies.commandExecutor || adapter.createReadOnlyCommandExecutor({
    spawnImpl: dependencies.spawnImpl || childProcess.spawn,
  });
  const runtimeCollector = dependencies.runtimeEvidenceCollector || adapter.createDockerRuntimeEvidenceCollector({
    executor: commandExecutor,
  });

  const readCredential = () => adapter.readProtectedCredential(manifest.adapter.credential, manifest.appDir, fsImpl);
  let promotedArtifactPath = null;

  const artifactPathFor = (sha) => {
    if (!SHA1.test(String(sha || ""))) throw new ProductionEntrypointError("promotion_artifact_sha_invalid");
    const candidate = path.join(manifest.promotionArtifactRoot, String(sha).toLowerCase());
    if (!isInside(manifest.promotionArtifactRoot, candidate)) {
      throw new ProductionEntrypointError("promotion_artifact_path_invalid");
    }
    return candidate;
  };

  const assertAbsent = (targetPath, label) => {
    try {
      fsImpl.lstatSync(targetPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new ProductionEntrypointError(`${label}_identity_unavailable`);
    }
    throw new ProductionEntrypointError(`${label}_already_exists`);
  };
  const runMigration = dependencies.runMigrationRunner || (async ({ repoRoot, releaseId, targetSha, migrationManifestDigest }) => {
    const credential = readCredential();
    const migrationConfig = {
      enabled: true,
      targetEnvironment: "production",
      databaseIdentity: manifest.adapter.databaseIdentity,
      locks: manifest.adapter.locks,
    };
    const env = adapter.buildMigrationChildEnvironment({
      config: migrationConfig,
      releaseId,
      targetSha,
      migrationManifestDigest,
      databaseUrl: credential,
      baseEnv: dependencies.baseEnv || process.env,
    });
    return {
      exitCode: await migrationRunner.runMigrationRunner({
        env,
        repoRoot,
        log: () => undefined,
        dependencies: { prismaFactory: createCandidatePrismaFactory(repoRoot, credential) },
      }),
    };
  });
  const verifyMigration = dependencies.verifyAppliedMigrations || (async ({ repoRoot, migrationNames }) => {
    const credential = readCredential();
    return migrationRunner.verifyAppliedMigrations({
      databaseUrl: credential,
      identity: manifest.adapter.databaseIdentity,
      migrationNames,
      prismaFactory: createCandidatePrismaFactory(repoRoot, credential),
    });
  });

  return Object.freeze({
    readPreflightEvidence: orchestrator.readPreflightEvidence,
    acquireExclusiveLock: (lockPath, owner) => {
      if (path.resolve(lockPath) !== manifest.adapter.locks.releasePath) {
        throw new ProductionEntrypointError("release_lock_path_mismatch");
      }
      return adapter.acquireHostLock(lockPath, owner, fsImpl);
    },
    computeReleaseDiff: (repoRoot, oldSha, newSha) => orchestrator.computeReleaseDiff(repoRoot, oldSha, newSha, spawnSyncImpl),
    inspectCheckout: (repoRoot) => inspectCheckout(repoRoot, spawnSyncImpl),
    inspectRuntime: async () => adapter.inspectRuntimeSnapshot(await runtimeCollector.collect(), manifest.adapter),
    createCandidate: (candidatePath, sha) => {
      if (path.resolve(candidatePath) !== manifest.candidateWorktreePath) throw new ProductionEntrypointError("candidate_path_mismatch");
      assertAbsent(candidatePath, "candidate_path");
      checkedCommand("git", ["-c", `safe.directory=${manifest.appDir}`, "-C", manifest.appDir, "worktree", "add", "--quiet", "--detach", candidatePath, sha], { label: "candidate_create" }, spawnSyncImpl);
    },
    buildCandidate: ({ candidatePath, sha }) => {
      const artifactPath = artifactPathFor(sha);
      assertAbsent(artifactPath, "promotion_artifact");
      fsImpl.mkdirSync(artifactPath);
      const buildContainer = "clashcookies-prod-candidate-build";
      let buildError = null;
      try {
        checkedCommand("docker", [
          "run", "--name", buildContainer,
          "--label", "com.clashcookies.deploy=candidate-build-only",
          "--network", "bridge", "-w", "/app", "-v", `${candidatePath}:/app`,
          "-v", "clashcookies-prod-candidate_node_modules:/app/node_modules",
          "-v", "clashcookies-prod-candidate_dist:/app/dist",
          manifest.adapter.runtime.image, "bash", "-lc", "./ops/deploy/ensure-yarn-deps.sh && npm run build",
        ], { label: "candidate_build" }, spawnSyncImpl);
        checkedCommand("docker", ["cp", `${buildContainer}:/app/.`, artifactPath], { label: "candidate_artifact_copy" }, spawnSyncImpl);
        promotedArtifactPath = artifactPath;
      } catch (error) {
        buildError = error;
      }
      const cleanup = commandResult("docker", ["rm", "-f", buildContainer], { label: "candidate_build_cleanup" }, spawnSyncImpl);
      if (buildError) throw buildError;
      if (cleanup.status !== 0) {
        throw new ProductionEntrypointError("candidate_build_cleanup_ambiguous", EXIT_CODES.AMBIGUOUS, "ambiguous_execution");
      }
    },
    runMigrationRunner: runMigration,
    verifyMigration,
    stopRuntime: () => {
      checkedCommand("docker", ["rm", "-f", manifest.adapter.runtime.name], { label: "runtime_stop" }, spawnSyncImpl);
    },
    checkoutRelease: ({ sha }) => {
      checkedCommand("git", ["-c", `safe.directory=${manifest.appDir}`, "-C", manifest.appDir, "checkout", "--quiet", "--detach", sha], { label: "release_checkout" }, spawnSyncImpl);
    },
    startRuntime: ({ sha }) => {
      if (promotedArtifactPath !== artifactPathFor(sha)) {
        throw new ProductionEntrypointError("promoted_artifact_revision_mismatch", EXIT_CODES.BLOCKED, "artifact_identity_failed");
      }
      const runtimeEnvironmentPath = manifest.adapter.runtimeCredential.path;
      const args = [
        "run", "-d", "--restart", "unless-stopped", "--name", manifest.adapter.runtime.name,
        "--label", `com.clashcookies.runtime=${manifest.adapter.runtime.label}`,
        "--label", `com.clashcookies.environment=${manifest.adapter.runtime.environment}`,
        "--label", `com.clashcookies.revision=${sha}`,
        "--network", manifest.adapter.runtime.network,
        "-p", `${adapter.CANONICAL_HOST_ADDRESS}:${manifest.adapter.runtime.hostPort}:${manifest.adapter.runtime.containerPort}`,
        "--env-file", runtimeEnvironmentPath,
        "-e", "POLLING_MODE=active", "-e", "POLLING_ENV=prod", "-w", "/app",
        "-v", `${promotedArtifactPath}:/app:ro`, manifest.adapter.runtime.image, "bash", "-lc", "npm run start:runtime",
      ];
      checkedCommand("docker", args, { label: "runtime_start" }, spawnSyncImpl);
    },
    healthCheck: (url) => new Promise((resolve) => {
      const request = http.get(url, { timeout: 5000 }, (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      });
      request.on("error", () => resolve({ status: 0 }));
      request.on("timeout", () => {
        request.destroy();
        resolve({ status: 0 });
      });
    }),
    cleanupCandidate: ({ path: candidatePath, sha }) => {
      if (path.resolve(candidatePath) !== manifest.candidateWorktreePath) throw new ProductionEntrypointError("candidate_path_mismatch");
      const worktrees = safeGit(manifest.appDir, ["worktree", "list", "--porcelain"], spawnSyncImpl);
      if (!worktrees.includes(`worktree ${candidatePath}`) || !worktrees.includes(`HEAD ${sha}`)) {
        throw new ProductionEntrypointError("candidate_ownership_unverified");
      }
      checkedCommand("git", ["-c", `safe.directory=${manifest.appDir}`, "-C", manifest.appDir, "worktree", "remove", candidatePath], { label: "candidate_cleanup" }, spawnSyncImpl);
    },
    writeReleaseRecord: (recordPath, line) => {
      if (path.resolve(recordPath) !== manifest.adapter.releaseRecord.path) throw new ProductionEntrypointError("release_record_path_mismatch");
      return adapter.appendReleaseRecord(manifest.adapter.releaseRecord, manifest.appDir, adapter.validateReleaseRecordLine(line), fsImpl);
    },
    now: () => new Date().toISOString(),
  });
}

function releaseEnvironment(manifest, env) {
  const required = [
    "DEPLOY_EXECUTION_AUTHORIZED", "DEPLOY_RELEASE_ID", "DEPLOY_OLD_SHA", "DEPLOY_NEW_SHA",
    "DEPLOY_EXPECTED_MIGRATION_DIFF_DIGEST", "DEPLOY_EXPECTED_MIGRATION_MANIFEST_DIGEST",
    "DEPLOY_AUTHORIZATION_DIGEST", "DEPLOY_APPROVED_BY",
  ];
  for (const name of required) if (typeof env[name] !== "string" || env[name].length === 0) throw new ProductionEntrypointError(`missing_${name.toLowerCase()}`);
  return Object.freeze({
    ...env,
    DEPLOY_TARGET_ENV: "production",
    DEPLOY_LOCK_PATH: manifest.adapter.locks.releasePath,
    DEPLOY_MIGRATION_LOCK_PATH: manifest.adapter.locks.runnerPath,
    DEPLOY_RELEASE_RECORD_PATH: manifest.adapter.releaseRecord.path,
    DEPLOY_PREFLIGHT_EVIDENCE_PATH: manifest.preflightEvidencePath,
    DEPLOY_CANDIDATE_WORKTREE_PATH: manifest.candidateWorktreePath,
  });
}

async function runProductionDeployment({ manifest, env = process.env, dependencies = {}, log = console.log } = {}) {
  const validated = validateProductionManifest(manifest);
  ensureExplicitActivation(validated, env);
  adapter.validateImmutableExecutor(
    validated.adapter.executor,
    validated.appDir,
    dependencies.fs || fs,
    dependencies.operatorIdentitySource || process,
  );
  validateModuleBundle(
    validated.moduleBundle,
    validated.appDir,
    validated.adapter.executor.path,
    dependencies.fs || fs,
  );
  adapter.validateProtectedCredentialSource(validated.adapter.credential, validated.appDir, dependencies.fs || fs);
  adapter.validateProtectedCredentialSource(validated.adapter.runtimeCredential, validated.appDir, dependencies.fs || fs);
  adapter.validateReleaseRecordTarget(validated.adapter.releaseRecord, validated.appDir, dependencies.fs || fs);
  validateProtectedDirectoryTarget(validated.promotionArtifactRoot, validated.appDir, dependencies.fs || fs);
  const releaseEnv = releaseEnvironment(validated, env);
  const operations = createProductionOperations(validated, dependencies);
  const diffPaths = operations.computeReleaseDiff
    ? (() => {
      const output = checkedCommand("git", ["-c", `safe.directory=${validated.appDir}`, "-C", validated.appDir, "diff", "--name-only", "--no-ext-diff", releaseEnv.DEPLOY_OLD_SHA, releaseEnv.DEPLOY_NEW_SHA, "--", "prisma/schema.prisma", "prisma/migrations"], { label: "release_classification" }, dependencies.spawnSync || childProcess.spawnSync);
      return output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    })()
    : [];

  if (diffPaths.length === 0) {
    const helperPath = validateProtectedArtifact(validated.nonMigrationHelper, validated.appDir, dependencies.fs || fs);
    const result = (dependencies.runNonMigration || ((request) => checkedCommand(helperPath, [], {
      cwd: validated.appDir,
      env: { ...process.env, ...releaseEnv, TARGET_REF: releaseEnv.DEPLOY_NEW_SHA, APP_DIR: validated.appDir },
      label: "non_migration_deploy",
    }, dependencies.spawnSync || childProcess.spawnSync)))({
      oldSha: releaseEnv.DEPLOY_OLD_SHA,
      newSha: releaseEnv.DEPLOY_NEW_SHA,
      releaseEnv,
      helperPath,
    });
    return typeof result === "number" ? result : EXIT_CODES.SUCCESS;
  }

  const exitCode = await orchestrator.runMigrationAwareDeployment({
    env: releaseEnv,
    repoRoot: validated.appDir,
    log,
    operations,
  });
  return exitCode;
}

module.exports = {
  CONFIG_VERSION,
  EXIT_CODES,
  ProductionEntrypointError,
  createProductionOperations,
  ensureExplicitActivation,
  readJsonConfig,
  runProductionDeployment,
  validateModuleBundle,
  validateProductionManifest,
};

if (require.main === module) {
  const configPath = process.env.DEPLOYMENT_CONFIG_PATH;
  try {
    if (!configPath) throw new ProductionEntrypointError("deployment_config_path_required");
    const manifest = readJsonConfig(configPath);
    runProductionDeployment({ manifest }).then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
      process.exitCode = Number.isInteger(error?.exitCode)
        ? error.exitCode
        : error?.name === "AdapterError" ? EXIT_CODES.BLOCKED : EXIT_CODES.AMBIGUOUS;
    });
  } catch (error) {
    process.exitCode = Number.isInteger(error?.exitCode)
      ? error.exitCode
      : error?.name === "AdapterError" ? EXIT_CODES.BLOCKED : EXIT_CODES.AMBIGUOUS;
  }
}
