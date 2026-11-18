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
const ARTIFACT_MANIFEST_FILE = ".clashcookies-artifact-manifest.json";
const REQUIRED_ARTIFACT_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "dist/ClashCookies.js",
  "node_modules/@prisma/client/index.js",
  "node_modules/.prisma/client/default.js",
  "prisma/schema.prisma",
]);
const CREDENTIAL_ACCESS_STRATEGY = "operator-owned-immutable-read-only";

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

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function artifactFilePath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0
    || path.isAbsolute(relativePath) || relativePath.includes("\\")
    || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ProductionEntrypointError("artifact_relative_path_invalid");
  }
  const result = path.resolve(root, ...relativePath.split("/"));
  if (!isInside(root, result)) throw new ProductionEntrypointError("artifact_path_invalid");
  return result;
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
 * The current SSH entrypoint and Docker env-file paths must read both
 * credentials in the non-root operator process. Keep that read capability
 * narrow: the files remain 0600, are immutable after installation, their
 * parent is not operator-writable, and the operator has no root-equivalent
 * Docker/sudo authority that could clear the immutable bit or replace them.
 */
function validateCredentialAccessContract(input, adapterConfig) {
  const access = input.credentialAccess || {};
  const authorization = input.executor?.authorization || {};
  const operatorGids = Array.isArray(access.operatorGids)
    ? [...new Set(access.operatorGids)].sort((left, right) => left - right)
    : [];
  const authorizedGids = Array.isArray(authorization.operatorGids)
    ? [...new Set(authorization.operatorGids)].sort((left, right) => left - right)
    : [];
  const parentMode = access.parentMode;
  const operatorGroupOverlap = operatorGids.some((gid) => gid === access.parentOwnerGid);
  const credentialPaths = [input.credential, input.runtimeCredential];
  if (access.strategy !== CREDENTIAL_ACCESS_STRATEGY
    || access.verified !== true
    || access.immutableFlagVerified !== true
    || access.rootEquivalentAccess !== "none"
    || access.dockerAccess !== "rootless"
    || !Number.isInteger(access.operatorUid) || access.operatorUid < 1
    || access.operatorUid !== authorization.operatorUid
    || operatorGids.length === 0
    || JSON.stringify(operatorGids) !== JSON.stringify(authorizedGids)
    || !Number.isInteger(access.parentOwnerUid) || access.parentOwnerUid < 0
    || !Number.isInteger(access.parentOwnerGid) || access.parentOwnerGid < 0
    || access.parentOwnerUid === access.operatorUid
    || operatorGroupOverlap
    || !Number.isInteger(parentMode) || parentMode < 0 || parentMode > 0o7777
    || (parentMode & 0o022) !== 0
    || (parentMode & 0o005) !== 0o005
    || credentialPaths.some((credential) => !credential
      || credential.ownerUid !== access.operatorUid
      || credential.mode !== 0o600)) {
    throw new ProductionEntrypointError("credential_access_contract_invalid");
  }
  if (!adapterConfig || typeof adapterConfig.runtimeCredential?.path !== "string") {
    throw new ProductionEntrypointError("credential_access_runtime_boundary_invalid");
  }
  return Object.freeze({
    strategy: CREDENTIAL_ACCESS_STRATEGY,
    operatorUid: access.operatorUid,
    operatorGids: Object.freeze(operatorGids),
    parentOwnerUid: access.parentOwnerUid,
    parentOwnerGid: access.parentOwnerGid,
    parentMode,
    immutableFlagVerified: true,
    rootEquivalentAccess: "none",
    dockerAccess: "rootless",
    verified: true,
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
  const credentialAccess = validateCredentialAccessContract(input, adapterConfig);
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
    credentialAccess,
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

function readArtifactEntry(root, relativePath, fsImpl = fs) {
  const absolutePath = artifactFilePath(root, relativePath);
  let stat;
  try {
    stat = fsImpl.lstatSync(absolutePath);
    if (!stat.isSymbolicLink() && (!stat.isFile() && !stat.isDirectory())) {
      throw new Error("artifact_identity_invalid");
    }
    if (stat.isSymbolicLink()) {
      const resolvedTarget = fsImpl.realpathSync(absolutePath);
      if (!isInside(root, resolvedTarget)) throw new Error("artifact_symlink_escape");
    } else if (fsImpl.realpathSync(absolutePath) !== absolutePath) {
      throw new Error("artifact_noncanonical");
    }
  } catch {
    throw new ProductionEntrypointError("promoted_artifact_identity_unavailable");
  }
  const entry = {
    path: normalizeRelativePath(relativePath),
    type: stat.isSymbolicLink() ? "symlink" : (stat.isDirectory() ? "directory" : "file"),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
    dev: stat.dev,
    ino: stat.ino,
  };
  if (![entry.uid, entry.gid, entry.mode, entry.dev, entry.ino].every(Number.isInteger)) {
    throw new ProductionEntrypointError("promoted_artifact_metadata_unavailable");
  }
  if (entry.type === "symlink") {
    let resolvedTarget;
    try {
      resolvedTarget = path.relative(root, fsImpl.realpathSync(absolutePath));
    } catch {
      throw new ProductionEntrypointError("promoted_artifact_identity_unavailable");
    }
    entry.target = normalizeRelativePath(resolvedTarget);
  } else if (entry.type === "file") {
    entry.sha256 = crypto.createHash("sha256").update(fsImpl.readFileSync(absolutePath)).digest("hex");
  }
  return Object.freeze(entry);
}

function collectArtifactEntries(root, fsImpl = fs, relativeDirectory = "") {
  const directoryPath = relativeDirectory ? artifactFilePath(root, relativeDirectory) : root;
  let directoryEntries;
  try {
    directoryEntries = fsImpl.readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    throw new ProductionEntrypointError("promoted_artifact_listing_unavailable");
  }
  const entries = [];
  for (const directoryEntry of directoryEntries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${directoryEntry.name}`
      : directoryEntry.name;
    if (!relativeDirectory && relativePath === ARTIFACT_MANIFEST_FILE) continue;
    const entry = readArtifactEntry(root, relativePath, fsImpl);
    entries.push(entry);
    if (entry.type === "directory") {
      entries.push(...collectArtifactEntries(root, fsImpl, relativePath));
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function sourceFilesForCandidate(candidatePath, spawnSyncImpl, fsImpl = fs) {
  const trackedOutput = safeGit(candidatePath, ["ls-files", "-z"], spawnSyncImpl);
  return trackedOutput.split("\0").filter(Boolean).map((relativePath) => {
    const normalizedPath = normalizeRelativePath(relativePath);
    const absolutePath = path.resolve(candidatePath, ...normalizedPath.split("/"));
    let stat;
    try {
      stat = fsImpl.lstatSync(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile() || fsImpl.realpathSync(absolutePath) !== absolutePath) {
        throw new Error("candidate_source_invalid");
      }
    } catch {
      throw new ProductionEntrypointError("candidate_source_identity_unavailable");
    }
    return Object.freeze({
      path: normalizedPath,
      sha256: crypto.createHash("sha256").update(fsImpl.readFileSync(absolutePath)).digest("hex"),
    });
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function createArtifactManifest(artifactPath, releaseSha, sourceFiles, appDir, fsImpl = fs) {
  const root = validateProtectedDirectoryTarget(artifactPath, appDir, fsImpl);
  const entries = collectArtifactEntries(root, fsImpl);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const requiredPath of [...REQUIRED_ARTIFACT_FILES, "prisma/migrations"]) {
    if (!byPath.has(requiredPath)) throw new ProductionEntrypointError("promoted_artifact_incomplete");
    if (requiredPath !== "prisma/migrations" && byPath.get(requiredPath).type !== "file") {
      throw new ProductionEntrypointError("promoted_artifact_required_file_missing");
    }
  }
  for (const sourceFile of sourceFiles) {
    const entry = byPath.get(sourceFile.path);
    if (!entry || entry.type !== "file" || entry.sha256 !== sourceFile.sha256) {
      throw new ProductionEntrypointError("promoted_artifact_candidate_mismatch");
    }
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    releaseSha,
    requiredFiles: Object.freeze([...REQUIRED_ARTIFACT_FILES]),
    sourceFiles: Object.freeze(sourceFiles),
    entries: Object.freeze(entries),
  });
  const manifestPath = artifactFilePath(root, ARTIFACT_MANIFEST_FILE);
  const serialized = `${JSON.stringify(manifest)}\n`;
  try {
    fsImpl.writeFileSync(manifestPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o640 });
  } catch {
    throw new ProductionEntrypointError("promoted_artifact_manifest_write_failed");
  }
  const manifestStat = readArtifactEntry(root, ARTIFACT_MANIFEST_FILE, fsImpl);
  return Object.freeze({
    path: manifestPath,
    sha256: manifestStat.sha256,
    uid: manifestStat.uid,
    gid: manifestStat.gid,
    mode: manifestStat.mode,
    dev: manifestStat.dev,
    ino: manifestStat.ino,
  });
}

function validateArtifactManifest(artifactPath, releaseSha, identity, appDir, fsImpl = fs) {
  const root = validateProtectedDirectoryTarget(artifactPath, appDir, fsImpl);
  const manifestPath = artifactFilePath(root, ARTIFACT_MANIFEST_FILE);
  const manifestStat = readArtifactEntry(root, ARTIFACT_MANIFEST_FILE, fsImpl);
  if (manifestStat.sha256 !== identity.sha256
    || manifestStat.uid !== identity.uid
    || manifestStat.gid !== identity.gid
    || manifestStat.mode !== identity.mode
    || manifestStat.dev !== identity.dev
    || manifestStat.ino !== identity.ino) {
    throw new ProductionEntrypointError("promoted_artifact_manifest_changed");
  }
  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new ProductionEntrypointError("promoted_artifact_manifest_invalid");
  }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.releaseSha !== releaseSha
    || !Array.isArray(manifest.requiredFiles)
    || JSON.stringify(manifest.requiredFiles) !== JSON.stringify([...REQUIRED_ARTIFACT_FILES])
    || !Array.isArray(manifest.sourceFiles)
    || !Array.isArray(manifest.entries)) {
    throw new ProductionEntrypointError("promoted_artifact_manifest_invalid");
  }
  const actualEntries = collectArtifactEntries(root, fsImpl);
  const expectedEntries = manifest.entries;
  if (actualEntries.length !== expectedEntries.length
    || actualEntries.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(expectedEntries[index]))) {
    throw new ProductionEntrypointError("promoted_artifact_content_changed");
  }
  const byPath = new Map(actualEntries.map((entry) => [entry.path, entry]));
  for (const requiredPath of [...REQUIRED_ARTIFACT_FILES, "prisma/migrations"]) {
    if (!byPath.has(requiredPath)
      || (requiredPath !== "prisma/migrations" && byPath.get(requiredPath).type !== "file")) {
      throw new ProductionEntrypointError("promoted_artifact_incomplete");
    }
  }
  for (const sourceFile of manifest.sourceFiles) {
    if (!sourceFile || typeof sourceFile.path !== "string" || !SHA256.test(sourceFile.sha256)
      || byPath.get(sourceFile.path)?.sha256 !== sourceFile.sha256.toLowerCase()) {
      throw new ProductionEntrypointError("promoted_artifact_candidate_mismatch");
    }
  }
  return root;
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

function verifyArtifactPrismaClient(artifactPath) {
  const requireFromArtifact = createRequire(path.join(artifactPath, "package.json"));
  let PrismaClient;
  try {
    ({ PrismaClient } = requireFromArtifact("@prisma/client"));
  } catch {
    throw new ProductionEntrypointError("promoted_artifact_prisma_client_unavailable");
  }
  if (typeof PrismaClient !== "function") {
    throw new ProductionEntrypointError("promoted_artifact_prisma_client_invalid");
  }
}

function executeMigrationInArtifact(config, artifactPath, runtime, credentialPath, spawnSyncImpl) {
  const result = spawnSyncImpl("docker", [
    "run", "--rm", "--name", "clashcookies-prod-migration-runner",
    "--label", "com.clashcookies.deploy=migration-runner",
    "--network", runtime.network,
    "--mount", `type=bind,source=${credentialPath},target=/run/secrets/migration-url,readonly`,
    "-v", `${artifactPath}:/app:ro`, "-w", "/app", runtime.image,
    "bash", "-lc", "DATABASE_URL=\"$(cat /run/secrets/migration-url)\" exec npm run migrate:deploy",
  ], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 128 * 1024,
  });
  return Object.freeze({
    status: typeof result?.status === "number" ? result.status : null,
    signal: result?.signal || null,
    error: result?.error || null,
    classification: result?.status === 0 ? "success" : "prisma_migration_failed",
  });
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
  const verifyArtifactPrismaClientImpl = dependencies.verifyArtifactPrismaClient || verifyArtifactPrismaClient;
  const createArtifactManifestImpl = dependencies.createArtifactManifest || createArtifactManifest;
  const validateArtifactManifestImpl = dependencies.validateArtifactManifest || validateArtifactManifest;
  let promotedArtifactPath = null;
  let promotedArtifactIdentity = null;
  let candidateSourceFiles = [];

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
  const requirePromotedArtifact = (sha) => {
    const expectedPath = artifactPathFor(sha);
    if (promotedArtifactPath !== expectedPath || !promotedArtifactIdentity) {
      throw new ProductionEntrypointError("promoted_artifact_revision_mismatch", EXIT_CODES.BLOCKED, "artifact_identity_failed");
    }
    return expectedPath;
  };
  const runMigration = dependencies.runMigrationRunner || (async ({ repoRoot, releaseId, targetSha, migrationManifestDigest }) => {
    const credential = readCredential();
    const artifactPath = requirePromotedArtifact(targetSha);
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
        dependencies: {
          prismaFactory: createCandidatePrismaFactory(artifactPath, credential),
          executeMigration: (config) => executeMigrationInArtifact(
            config,
            artifactPath,
            manifest.adapter.runtime,
            manifest.adapter.credential.path,
            spawnSyncImpl,
          ),
        },
      }),
    };
  });
  const verifyMigration = dependencies.verifyAppliedMigrations || (async ({ targetSha, migrationNames }) => {
    const credential = readCredential();
    const artifactPath = requirePromotedArtifact(targetSha);
    return migrationRunner.verifyAppliedMigrations({
      databaseUrl: credential,
      identity: manifest.adapter.databaseIdentity,
      migrationNames,
      prismaFactory: createCandidatePrismaFactory(artifactPath, credential),
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
      candidateSourceFiles = sourceFilesForCandidate(candidatePath, spawnSyncImpl, fsImpl);
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
        verifyArtifactPrismaClientImpl(artifactPath);
        promotedArtifactIdentity = createArtifactManifestImpl(
          artifactPath,
          sha,
          candidateSourceFiles,
          manifest.appDir,
          fsImpl,
        );
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
    verifyPromotedArtifact: ({ sha }) => {
      const artifactPath = requirePromotedArtifact(sha);
      validateArtifactManifestImpl(artifactPath, sha, promotedArtifactIdentity, manifest.appDir, fsImpl);
      verifyArtifactPrismaClientImpl(artifactPath);
    },
    stopRuntime: () => {
      checkedCommand("docker", ["rm", "-f", manifest.adapter.runtime.name], { label: "runtime_stop" }, spawnSyncImpl);
    },
    checkoutRelease: ({ sha }) => {
      checkedCommand("git", ["-c", `safe.directory=${manifest.appDir}`, "-C", manifest.appDir, "checkout", "--quiet", "--detach", sha], { label: "release_checkout" }, spawnSyncImpl);
    },
    startRuntime: ({ sha }) => {
      const artifactPath = requirePromotedArtifact(sha);
      validateArtifactManifestImpl(artifactPath, sha, promotedArtifactIdentity, manifest.appDir, fsImpl);
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
        "-v", `${artifactPath}:/app:ro`, manifest.adapter.runtime.image, "bash", "-lc", "npm run start:runtime",
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
  CREDENTIAL_ACCESS_STRATEGY,
  EXIT_CODES,
  ProductionEntrypointError,
  createProductionOperations,
  createArtifactManifest,
  ensureExplicitActivation,
  executeMigrationInArtifact,
  readJsonConfig,
  runProductionDeployment,
  validateArtifactManifest,
  validateCredentialAccessContract,
  validateModuleBundle,
  validateProductionManifest,
  verifyArtifactPrismaClient,
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
