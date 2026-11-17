"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { acquireExclusiveHostLock, LockCoordinationError } = require("./deployment-lock");

const DEFAULT_RUNTIME = Object.freeze({
  name: "clashcookies-app",
  label: "active",
  environment: "prod",
  hostPort: 8085,
  containerPort: 8080,
  image: "node:20-bookworm",
  network: "clashcookies-prod_default",
});

const ORCHESTRATOR_OPERATION_NAMES = Object.freeze([
  "readPreflightEvidence",
  "acquireExclusiveLock",
  "computeReleaseDiff",
  "inspectCheckout",
  "inspectRuntime",
  "createCandidate",
  "buildCandidate",
  "runMigrationRunner",
  "verifyMigration",
  "stopRuntime",
  "checkoutRelease",
  "startRuntime",
  "healthCheck",
  "cleanupCandidate",
  "writeReleaseRecord",
  "now",
]);

const MUTATING_OPERATION_NAMES = new Set([
  "acquireExclusiveLock",
  "createCandidate",
  "buildCandidate",
  "runMigrationRunner",
  "stopRuntime",
  "checkoutRelease",
  "startRuntime",
  "cleanupCandidate",
  "writeReleaseRecord",
]);

const SAFE_NPM_ENVIRONMENT = Object.freeze({
  NODE_ENV: "production",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_GLOBALCONFIG: "/dev/null",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_USERCONFIG: "/dev/null",
});

// Phase 1 supplies the contract and validators only. No production-dependent
// operation may execute until a separately reviewed VM primitive is wired in.
const PHASE1_EXECUTION_ENABLED = false;

class AdapterError extends Error {
  constructor(message, code = "adapter_blocked") {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

/** Return true when candidate is inside parent, including the parent itself. */
function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === ""
    || (relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

/** Validate an absolute path that must remain outside the mutable checkout. */
function requireExternalPath(value, name, appDir) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new AdapterError(`invalid_${name}`, "invalid_path");
  }
  const resolved = path.resolve(value);
  if (isPathInside(appDir, resolved)) {
    throw new AdapterError(`${name}_must_be_outside_checkout`, "unsafe_path");
  }
  return resolved;
}

/** Reject symlinked path components before any protected file is opened. */
function assertNoSymlinkComponents(filePath, fsImpl = fs, label = "path") {
  if (typeof fsImpl.lstatSync !== "function") {
    throw new AdapterError(`${label}_lstat_unavailable`, "unsafe_path");
  }
  const absolutePath = path.resolve(filePath);
  const root = path.parse(absolutePath).root;
  const relative = path.relative(root, absolutePath);
  let current = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch {
      throw new AdapterError(`${label}_component_missing`, "unsafe_path");
    }
    if (stat.isSymbolicLink()) {
      throw new AdapterError(`${label}_symlink_component`, "unsafe_path");
    }
  }
}

/** Resolve an existing protected path and reject checkout aliases. */
function resolveVerifiedExternalPath(value, name, appDir, fsImpl = fs) {
  const lexicalPath = requireExternalPath(value, name, appDir);
  assertNoSymlinkComponents(appDir, fsImpl, "app_dir");
  assertNoSymlinkComponents(lexicalPath, fsImpl, name);
  if (typeof fsImpl.realpathSync !== "function") {
    throw new AdapterError(`${name}_realpath_unavailable`, "unsafe_path");
  }
  let appRealPath;
  let targetRealPath;
  try {
    appRealPath = fsImpl.realpathSync(path.resolve(appDir));
    targetRealPath = fsImpl.realpathSync(lexicalPath);
  } catch {
    throw new AdapterError(`${name}_realpath_failed`, "unsafe_path");
  }
  if (isPathInside(appRealPath, targetRealPath)) {
    throw new AdapterError(`${name}_must_be_outside_checkout`, "unsafe_path");
  }
  return path.resolve(targetRealPath);
}

/** Normalize and validate the explicit adapter configuration boundary. */
function validateAdapterConfig(input = {}) {
  const runtime = Object.freeze({ ...DEFAULT_RUNTIME, ...(input.runtime || {}) });
  const disabled = input.adapterEnabled !== true;

  if (disabled) {
    return Object.freeze({
      enabled: false,
      verificationStatus: String(input.verificationStatus || "BLOCKED"),
      targetEnvironment: "production",
      appDir: typeof input.appDir === "string" ? path.resolve(input.appDir) : null,
      runtime,
      executor: Object.freeze({}),
      credential: Object.freeze({}),
      locks: Object.freeze({}),
      releaseRecord: Object.freeze({}),
      allowMutations: false,
      allowMigrationExecution: false,
    });
  }

  if (input.verificationStatus !== "PASS") {
    throw new AdapterError("adapter_verification_status_required", "verification_required");
  }
  if (input.targetEnvironment !== "production") {
    throw new AdapterError("production_target_required", "target_mismatch");
  }
  validateCanonicalRuntime(runtime);
  if (typeof input.appDir !== "string" || !path.isAbsolute(input.appDir)) {
    throw new AdapterError("absolute_app_dir_required", "invalid_path");
  }

  const appDir = path.resolve(input.appDir);
  const executorInput = input.executor || {};
  const credentialInput = input.credential || {};
  const locksInput = input.locks || {};
  const recordInput = input.releaseRecord || {};

  const executorPath = requireExternalPath(executorInput.path, "executor_path", appDir);
  const credentialPath = requireExternalPath(credentialInput.path, "credential_path", appDir);
  const releaseLockPath = requireExternalPath(locksInput.releasePath, "release_lock_path", appDir);
  const runnerLockPath = requireExternalPath(locksInput.runnerPath, "runner_lock_path", appDir);
  const releaseRecordPath = requireExternalPath(recordInput.path, "release_record_path", appDir);

  validateSha256(executorInput.sha256, "executor_sha256");
  validateOwner(executorInput.ownerUid, "executor_owner_uid");
  validateOwner(executorInput.ownerGid, "executor_owner_gid");
  validateMode(executorInput.mode, "executor_mode");
  validateOwner(credentialInput.ownerUid, "credential_owner_uid");
  validateOwner(credentialInput.ownerGid, "credential_owner_gid");
  validateMode(credentialInput.mode, "credential_mode");
  validateOwner(recordInput.ownerUid, "release_record_owner_uid");
  validateOwner(recordInput.ownerGid, "release_record_owner_gid");
  validateMode(recordInput.mode, "release_record_mode");
  validateDatabaseIdentity(input.databaseIdentity);
  validateLockCoordination({ releaseLockPath, runnerLockPath, appDir });

  if (executorInput.verified !== true
    || credentialInput.verified !== true
    || locksInput.verified !== true
    || recordInput.verified !== true
    || recordInput.appendOnlyVerified !== true) {
    throw new AdapterError("all_adapter_identity_checks_must_be_verified", "verification_required");
  }

  return Object.freeze({
    enabled: true,
    verificationStatus: "PASS",
    targetEnvironment: "production",
    appDir,
    runtime,
    executor: Object.freeze({
      path: executorPath,
      sha256: executorInput.sha256.toLowerCase(),
      ownerUid: executorInput.ownerUid,
      ownerGid: executorInput.ownerGid,
      mode: executorInput.mode,
    }),
    credential: Object.freeze({
      path: credentialPath,
      ownerUid: credentialInput.ownerUid,
      ownerGid: credentialInput.ownerGid,
      mode: credentialInput.mode,
    }),
    locks: Object.freeze({
      releasePath: releaseLockPath,
      runnerPath: runnerLockPath,
    }),
    releaseRecord: Object.freeze({
      path: releaseRecordPath,
      ownerUid: recordInput.ownerUid,
      ownerGid: recordInput.ownerGid,
      mode: recordInput.mode,
      appendOnlyVerified: true,
    }),
    databaseIdentity: Object.freeze({ ...input.databaseIdentity }),
    allowMutations: input.allowMutations === true,
    allowMigrationExecution: input.allowMigrationExecution === true,
  });
}

/** Validate a SHA-256 value without exposing any associated artifact. */
function validateSha256(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new AdapterError(`invalid_${name}`, "invalid_identity");
  }
}

/** Validate a numeric Unix owner identity. */
function validateOwner(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AdapterError(`invalid_${name}`, "invalid_identity");
  }
}

/** Validate a Unix permission mode supplied by the reviewed install record. */
function validateMode(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0o7777) {
    throw new AdapterError(`invalid_${name}`, "invalid_identity");
  }
}

/** Pin the adapter to the reviewed production runtime identity. */
function validateCanonicalRuntime(runtime) {
  const stringFields = ["name", "label", "environment", "image", "network"];
  for (const key of stringFields) {
    if (runtime[key] !== DEFAULT_RUNTIME[key]) {
      throw new AdapterError(`canonical_runtime_${key}_mismatch`, "runtime_identity_invalid");
    }
  }
  for (const key of ["hostPort", "containerPort"]) {
    if (!Number.isInteger(runtime[key]) || runtime[key] !== DEFAULT_RUNTIME[key]) {
      throw new AdapterError(`canonical_runtime_${key}_mismatch`, "runtime_identity_invalid");
    }
  }
}

/** Validate the non-secret database identity contract required by the runner. */
function validateDatabaseIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    throw new AdapterError("database_identity_contract_required", "invalid_identity");
  }
  const required = ["host", "port", "name", "user", "schema", "serverAddress", "serverPort", "major"];
  for (const key of required) {
    if (identity[key] === undefined || identity[key] === null || String(identity[key]).length === 0) {
      throw new AdapterError(`database_identity_${key}_required`, "invalid_identity");
    }
  }
}

/** Ensure the outer release lock and inner runner lock cannot deadlock each other. */
function validateLockCoordination({ releaseLockPath, runnerLockPath, appDir }) {
  if (path.resolve(releaseLockPath) === path.resolve(runnerLockPath)) {
    throw new AdapterError("release_and_runner_locks_must_differ", "lock_contract_invalid");
  }
  if (isPathInside(appDir, releaseLockPath) || isPathInside(appDir, runnerLockPath)) {
    throw new AdapterError("lock_paths_must_be_outside_checkout", "unsafe_path");
  }
  return Object.freeze({ releaseLockPath, runnerLockPath });
}

/** Split one Docker metadata row while preserving empty fields. */
function splitDockerRecord(line, expectedFields, recordType) {
  if (typeof line !== "string") {
    throw new AdapterError(`${recordType}_metadata_missing`, "docker_metadata_invalid");
  }
  const fields = line.split("|");
  if (fields.length !== expectedFields) {
    throw new AdapterError(`${recordType}_metadata_ambiguous`, "docker_metadata_invalid");
  }
  return fields;
}

/** Parse selected container fields without reading environments or full labels. */
function parseDockerContainerListing(stdout) {
  if (typeof stdout !== "string") {
    throw new AdapterError("docker_container_listing_missing", "docker_metadata_invalid");
  }
  return stdout.split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [id, name, image, ports, composeProject, composeService, runtime, environment, revision, pid] =
        splitDockerRecord(line, 10, "container");
      return Object.freeze({
        id,
        name,
        image,
        ports,
        composeProject,
        composeService,
        runtime,
        environment,
        revision,
        pid,
      });
    });
}

/** Parse selected volume fields without reading volume environment-like data. */
function parseDockerVolumeListing(stdout) {
  if (typeof stdout !== "string") {
    throw new AdapterError("docker_volume_listing_missing", "docker_metadata_invalid");
  }
  return stdout.split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, driver] = splitDockerRecord(line, 2, "volume");
      return Object.freeze({ name, driver });
    });
}

/** Parse selected network ownership fields while preserving empty labels. */
function parseDockerNetworkListing(stdout) {
  if (typeof stdout !== "string") {
    throw new AdapterError("docker_network_listing_missing", "docker_metadata_invalid");
  }
  return stdout.split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, driver, composeProject, composeNetwork] = splitDockerRecord(line, 4, "network");
      return Object.freeze({ name, driver, composeProject, composeNetwork });
    });
}

/** Return whether a selected Docker port field exposes the canonical app port. */
function hasPublishedCanonicalPort(ports, runtime) {
  return typeof ports === "string"
    && ports.includes(`${runtime.hostPort}->${runtime.containerPort}`);
}

/** Return whether a container is a potential bot runtime candidate. */
function isPotentialRuntimeCandidate(container, runtime) {
  return container.name === runtime.name
    || container.runtime === runtime.label
    || hasPublishedCanonicalPort(container.ports, runtime)
    || container.image === runtime.image;
}

/** Return whether a candidate fully proves the direct-Docker canonical identity. */
function isCanonicalRuntimeCandidate(container, networks, runtime) {
  const validContainerId = /^[0-9a-f]{12,64}$/i.test(container.id);
  const validContainerPid = /^(?:[1-9][0-9]*)$/.test(String(container.pid));
  const validRevision = /^[0-9a-f]{40}$/i.test(container.revision);
  const directOwned = container.composeProject === "" && container.composeService === "";
  const optionalLabelsMatch = (container.runtime === "" || container.runtime === runtime.label)
    && (container.environment === "" || container.environment === runtime.environment);
  return container.name === runtime.name
    && container.image === runtime.image
    && hasPublishedCanonicalPort(container.ports, runtime)
    && networks.includes(runtime.network)
    && directOwned
    && optionalLabelsMatch
    && validContainerId
    && validContainerPid
    && validRevision;
}

/** Return true only for a verified host PID/cgroup identity match. */
function isCorrelatedContainerProcess(processInfo, container) {
  return /^(?:[1-9][0-9]*)$/.test(String(container.pid))
    && processInfo.pid === String(container.pid)
    && /^[0-9a-f]{12,64}$/i.test(processInfo.containerId)
    && processInfo.containerId.toLowerCase() === container.id.toLowerCase();
}

/** Parse host process metadata into potential, never conclusive, bot candidates. */
function parseHostProcessListing(stdout) {
  if (typeof stdout !== "string") {
    throw new AdapterError("host_process_listing_missing", "process_metadata_invalid");
  }
  return stdout.split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pid, uid, comm, state, cwdScope, containerId] = splitDockerRecord(line, 6, "host_process");
      return Object.freeze({ pid, uid, comm, state, cwdScope, containerId });
    })
    .filter((processInfo) => /^(?:node|nodejs|npm|yarn)$/.test(processInfo.comm));
}

/** Validate the pinned immutable executor file and its recorded digest. */
function validateImmutableExecutor(spec, appDir, fsImpl = fs) {
  const executorPath = resolveVerifiedExternalPath(spec.path, "executor_path", appDir, fsImpl);
  validateSha256(spec.sha256, "executor_sha256");
  const stat = readProtectedStat(executorPath, fsImpl, "executor");
  validateExpectedStat(stat, spec, "executor");
  const contents = readVerifiedFile(executorPath, stat, fsImpl, "executor");
  const digest = crypto.createHash("sha256").update(contents).digest("hex");
  if (digest !== spec.sha256.toLowerCase()) {
    throw new AdapterError("executor_checksum_mismatch", "executor_identity_invalid");
  }
  return Object.freeze({
    path: executorPath,
    sha256: digest,
    ownerUid: stat.uid,
    ownerGid: stat.gid,
    mode: stat.mode & 0o7777,
  });
}

/** Validate the protected credential file without returning its contents. */
function validateProtectedCredentialSource(spec, appDir, fsImpl = fs) {
  const credentialPath = resolveVerifiedExternalPath(spec.path, "credential_path", appDir, fsImpl);
  const stat = readProtectedStat(credentialPath, fsImpl, "credential");
  validateExpectedStat(stat, spec, "credential");
  if ((stat.mode & 0o7777) !== 0o600) {
    throw new AdapterError("credential_file_must_be_private", "credential_source_invalid");
  }
  return Object.freeze({
    path: credentialPath,
    ownerUid: stat.uid,
    ownerGid: stat.gid,
    mode: stat.mode & 0o7777,
  });
}

/** Read a validated credential source without printing or logging its contents. */
function readProtectedCredential(spec, appDir, fsImpl = fs) {
  const source = validateProtectedCredentialSource(spec, appDir, fsImpl);
  const stat = readProtectedStat(source.path, fsImpl, "credential");
  validateExpectedStat(stat, spec, "credential");
  const value = String(readVerifiedFile(source.path, stat, fsImpl, "credential", "utf8")).trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new AdapterError("credential_file_empty_or_multiline", "credential_source_invalid");
  }
  return value;
}

/** Build the strict environment passed to the one-shot migration runner. */
function buildMigrationChildEnvironment({
  config,
  releaseId,
  targetSha,
  migrationManifestDigest,
  databaseUrl,
  baseEnv = process.env,
}) {
  if (!config || !config.enabled || !config.databaseIdentity) {
    throw new AdapterError("verified_adapter_config_required", "adapter_blocked");
  }
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    throw new AdapterError("protected_database_credential_required", "credential_source_invalid");
  }

  const identity = config.databaseIdentity;
  const environment = {
    ...SAFE_NPM_ENVIRONMENT,
    PATH: typeof baseEnv.PATH === "string" && baseEnv.PATH.length > 0
      ? baseEnv.PATH
      : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    DATABASE_URL: databaseUrl,
    MIGRATION_EXECUTION_AUTHORIZED: "1",
    MIGRATION_TARGET_ENV: config.targetEnvironment,
    MIGRATION_RELEASE_ID: releaseId,
    MIGRATION_TARGET_SHA: targetSha,
    MIGRATION_EXPECTED_MIGRATION_DIGEST: migrationManifestDigest,
    MIGRATION_LOCK_PATH: config.locks.runnerPath,
    MIGRATION_ALLOWED_DB_HOST: String(identity.host),
    MIGRATION_ALLOWED_DB_PORT: String(identity.port),
    MIGRATION_ALLOWED_DB_NAME: String(identity.name),
    MIGRATION_ALLOWED_DB_USER: String(identity.user),
    MIGRATION_ALLOWED_DB_SCHEMA: String(identity.schema),
    MIGRATION_ALLOWED_DB_SERVER_ADDRESS: String(identity.serverAddress),
    MIGRATION_ALLOWED_DB_SERVER_PORT: String(identity.serverPort),
    MIGRATION_ALLOWED_DB_MAJOR: String(identity.major),
  };

  return Object.freeze(environment);
}

/** Reject release-record lines that could contain credentials or unbounded output. */
function validateReleaseRecordLine(line, maxLength = 2048) {
  if (typeof line !== "string" || line.length === 0 || line.length > maxLength) {
    throw new AdapterError("release_record_line_invalid", "release_record_invalid");
  }
  if (/DATABASE_URL|postgres(?:ql)?:\/\/|password|token|secret|private[_-]?key/i.test(line)) {
    throw new AdapterError("release_record_secret_detected", "release_record_invalid");
  }
  if (/[\r\n]/.test(line)) {
    throw new AdapterError("release_record_line_multiline", "release_record_invalid");
  }
  return line;
}

/** Validate an existing append-only release-record target without creating it. */
function validateReleaseRecordTarget(spec, appDir, fsImpl = fs) {
  const recordPath = resolveVerifiedExternalPath(spec.path, "release_record_path", appDir, fsImpl);
  if (spec.appendOnlyVerified !== true) {
    throw new AdapterError("append_only_release_record_required", "release_record_invalid");
  }
  const stat = readProtectedStat(recordPath, fsImpl, "release_record");
  validateExpectedStat(stat, spec, "release_record");
  if ((stat.mode & 0o022) !== 0) {
    throw new AdapterError("release_record_must_not_be_group_or_world_writable", "release_record_invalid");
  }
  return Object.freeze({
    path: recordPath,
    ownerUid: stat.uid,
    ownerGid: stat.gid,
    mode: stat.mode & 0o7777,
  });
}

/** Read regular-file metadata while rejecting symlinks and special files. */
function readProtectedStat(filePath, fsImpl, label) {
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch {
    throw new AdapterError(`${label}_missing`, `${label}_invalid`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AdapterError(`${label}_must_be_regular_file`, `${label}_invalid`);
  }
  return stat;
}

/** Open, re-stat, and read a protected file without trusting path identity. */
function readVerifiedFile(filePath, expectedStat, fsImpl = fs, label = "file", encoding) {
  const noFollow = fsImpl.constants && fsImpl.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || typeof fsImpl.openSync !== "function"
    || typeof fsImpl.fstatSync !== "function" || typeof fsImpl.closeSync !== "function"
    || typeof fsImpl.readFileSync !== "function") {
    throw new AdapterError(`${label}_safe_open_unavailable`, "unsafe_path");
  }
  const fd = fsImpl.openSync(filePath, fsImpl.constants.O_RDONLY | noFollow);
  try {
    const openedStat = fsImpl.fstatSync(fd);
    validateSameFile(expectedStat, openedStat, label);
    return fsImpl.readFileSync(fd, encoding);
  } finally {
    fsImpl.closeSync(fd);
  }
}

/** Verify that the file descriptor still refers to the pre-opened file. */
function validateSameFile(expectedStat, actualStat, label) {
  const fields = ["dev", "ino", "uid", "gid"];
  for (const field of fields) {
    if (expectedStat[field] !== undefined && actualStat[field] !== undefined
      && expectedStat[field] !== actualStat[field]) {
      throw new AdapterError(`${label}_replaced_during_open`, "unsafe_path");
    }
  }
  if (!actualStat.isFile() || (actualStat.mode & 0o7777) !== (expectedStat.mode & 0o7777)) {
    throw new AdapterError(`${label}_changed_during_open`, "unsafe_path");
  }
}

/** Compare recorded ownership and permissions against the observed file. */
function validateExpectedStat(stat, spec, label) {
  if (stat.uid !== spec.ownerUid || stat.gid !== spec.ownerGid) {
    throw new AdapterError(`${label}_owner_mismatch`, `${label}_invalid`);
  }
  if ((stat.mode & 0o7777) !== spec.mode) {
    throw new AdapterError(`${label}_mode_mismatch`, `${label}_invalid`);
  }
}

/** Append one already-sanitized bounded release record using append-only flags. */
function appendReleaseRecord(spec, appDir, line, fsImpl = fs) {
  validateReleaseRecordLine(line);
  const recordPath = validateReleaseRecordTarget(spec, appDir, fsImpl).path;
  const expectedStat = readProtectedStat(recordPath, fsImpl, "release_record");
  validateExpectedStat(expectedStat, spec, "release_record");
  if ((expectedStat.mode & 0o022) !== 0) {
    throw new AdapterError("release_record_must_not_be_group_or_world_writable", "release_record_invalid");
  }
  const noFollow = fsImpl.constants && fsImpl.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || typeof fsImpl.fstatSync !== "function") {
    throw new AdapterError("append_only_safe_open_unavailable", "release_record_invalid");
  }
  const flags = fsImpl.constants.O_WRONLY | fsImpl.constants.O_APPEND | noFollow;
  const fd = fsImpl.openSync(recordPath, flags);
  try {
    validateSameFile(expectedStat, fsImpl.fstatSync(fd), "release_record");
    fsImpl.writeSync(fd, `${line}\n`, null, "utf8");
  } finally {
    fsImpl.closeSync(fd);
  }
}

/** Acquire a non-recursive host lock and return an ownership-checked release function. */
function acquireHostLock(lockPath, owner, fsImpl = fs) {
  try {
    return acquireExclusiveHostLock(lockPath, owner, fsImpl);
  } catch (error) {
    if (error instanceof LockCoordinationError && error.reason === "already_held") {
      throw new AdapterError("release_lock_already_held", "already_locked");
    }
    if (error instanceof LockCoordinationError) {
      throw new AdapterError(`release_lock_${error.reason}`, "lock_unavailable");
    }
    throw error;
  }
}

/** Validate a normalized runtime snapshot before exposing it to the orchestrator. */
function inspectRuntimeSnapshot(snapshot, config) {
  const containers = Array.isArray(snapshot?.containers) ? snapshot.containers : [];
  const hostProcesses = Array.isArray(snapshot?.hostProcesses)
    ? snapshot.hostProcesses.filter((entry) => /^(?:node|nodejs|npm|yarn)$/.test(entry.comm))
    : [];
  const potential = containers.filter((container) => isPotentialRuntimeCandidate(container, config.runtime));

  if (potential.length !== 1) {
    throw new AdapterError("runtime_candidate_count_is_not_one", "runtime_ambiguity");
  }

  const candidate = potential[0];
  const networks = Array.isArray(candidate.networks) ? candidate.networks : [];
  if (!isCanonicalRuntimeCandidate(candidate, networks, config.runtime)) {
    throw new AdapterError("canonical_runtime_identity_not_proven", "runtime_identity_invalid");
  }
  for (const processInfo of hostProcesses) {
    if (!processInfo.containerId) {
      throw new AdapterError("host_process_container_correlation_unknown", "runtime_ambiguity");
    }
    if (!isCorrelatedContainerProcess(processInfo, candidate)) {
      throw new AdapterError("potential_host_bot_process_present", "runtime_ambiguity");
    }
  }

  return Object.freeze({
    candidates: Object.freeze([{
      name: config.runtime.name,
      label: config.runtime.label,
      environment: config.runtime.environment,
      port: config.runtime.hostPort,
      recognized: true,
      revision: candidate.revision.toLowerCase(),
    }]),
  });
}

/** Build an adapter operation surface that stays fail-closed until verified. */
function createDirectDockerAdapter(input = {}, dependencies = {}) {
  const injectedOperations = dependencies.operations || {};
  const fsImpl = dependencies.fs || fs;
  const initialConfig = validateAdapterConfig(input);
  const config = initialConfig.enabled
    ? Object.freeze({
      ...initialConfig,
      executor: Object.freeze({
        ...initialConfig.executor,
        ...validateImmutableExecutor(initialConfig.executor, initialConfig.appDir, fsImpl),
      }),
      credential: Object.freeze({
        ...initialConfig.credential,
        ...validateProtectedCredentialSource(initialConfig.credential, initialConfig.appDir, fsImpl),
      }),
      releaseRecord: Object.freeze({
        ...initialConfig.releaseRecord,
        ...validateReleaseRecordTarget(initialConfig.releaseRecord, initialConfig.appDir, fsImpl),
      }),
    })
    : initialConfig;

  function requireEnabled(operation) {
    if (!config.enabled) {
      throw new AdapterError(`${operation}_requires_verified_adapter_configuration`, "adapter_blocked");
    }
  }

  function requireMutationEnabled(operation) {
    requireEnabled(operation);
    if (!PHASE1_EXECUTION_ENABLED) {
      throw new AdapterError(`${operation}_disabled_until_reviewed_vm_primitives`, "phase1_execution_disabled");
    }
    if (!config.allowMutations) {
      throw new AdapterError(`${operation}_disabled_in_phase1`, "mutation_disabled");
    }
  }

  function requireMigrationEnabled(operation) {
    requireMutationEnabled(operation);
    if (!config.allowMigrationExecution) {
      throw new AdapterError(`${operation}_disabled_without_migration_authorization`, "migration_disabled");
    }
  }

  function invokeInjected(name, args) {
    if (typeof injectedOperations[name] !== "function") {
      throw new AdapterError(`${name}_requires_reviewed_vm_primitive`, "adapter_primitive_missing");
    }
    return injectedOperations[name](...args);
  }

  const operations = {
    readPreflightEvidence: (...args) => {
      requireEnabled("read_preflight_evidence");
      return invokeInjected("readPreflightEvidence", args);
    },
    acquireExclusiveLock: (lockPath, owner) => {
      requireMutationEnabled("acquire_exclusive_lock");
      if (path.resolve(lockPath) !== config.locks.releasePath) {
        throw new AdapterError("release_lock_path_mismatch", "lock_contract_invalid");
      }
      return dependencies.acquireLock
        ? dependencies.acquireLock(lockPath, owner)
        : acquireHostLock(lockPath, owner, fsImpl);
    },
    computeReleaseDiff: (...args) => {
      requireEnabled("compute_release_diff");
      return invokeInjected("computeReleaseDiff", args);
    },
    inspectCheckout: (...args) => {
      requireEnabled("inspect_checkout");
      return invokeInjected("inspectCheckout", args);
    },
    inspectRuntime: async () => {
      requireEnabled("inspect_runtime");
      if (typeof dependencies.readRuntimeSnapshot !== "function") {
        throw new AdapterError("inspect_runtime_requires_reviewed_vm_snapshot", "adapter_primitive_missing");
      }
      const snapshot = await dependencies.readRuntimeSnapshot();
      return inspectRuntimeSnapshot(snapshot, config);
    },
    createCandidate: (...args) => {
      requireMutationEnabled("create_candidate");
      return invokeInjected("createCandidate", args);
    },
    buildCandidate: (...args) => {
      requireMutationEnabled("build_candidate");
      return invokeInjected("buildCandidate", args);
    },
    runMigrationRunner: async (request) => {
      requireMigrationEnabled("migration_runner");
      const credential = readProtectedCredential(config.credential, config.appDir, fsImpl);
      const env = buildMigrationChildEnvironment({
        config,
        releaseId: request.releaseId,
        targetSha: request.targetSha,
        migrationManifestDigest: request.migrationManifestDigest,
        databaseUrl: credential,
        baseEnv: dependencies.baseEnv || process.env,
      });
      const migrationOperation = dependencies.runMigrationRunner || injectedOperations.runMigrationRunner;
      if (typeof migrationOperation !== "function") {
        throw new AdapterError("migration_runner_primitive_missing", "adapter_primitive_missing");
      }
      return migrationOperation({ ...request, env });
    },
    verifyMigration: (...args) => {
      requireEnabled("verify_migration");
      return invokeInjected("verifyMigration", args);
    },
    stopRuntime: (...args) => {
      requireMutationEnabled("stop_runtime");
      return invokeInjected("stopRuntime", args);
    },
    checkoutRelease: (...args) => {
      requireMutationEnabled("checkout_release");
      return invokeInjected("checkoutRelease", args);
    },
    startRuntime: (...args) => {
      requireMutationEnabled("start_runtime");
      return invokeInjected("startRuntime", args);
    },
    healthCheck: (...args) => {
      requireEnabled("health_check");
      return invokeInjected("healthCheck", args);
    },
    cleanupCandidate: (...args) => {
      requireMutationEnabled("cleanup_candidate");
      return invokeInjected("cleanupCandidate", args);
    },
    writeReleaseRecord: (recordPath, line) => {
      requireMutationEnabled("write_release_record");
      if (path.resolve(recordPath) !== config.releaseRecord.path) {
        throw new AdapterError("release_record_path_mismatch", "release_record_invalid");
      }
      if (typeof dependencies.writeReleaseRecord === "function") {
        return dependencies.writeReleaseRecord(recordPath, validateReleaseRecordLine(line));
      }
      return appendReleaseRecord(config.releaseRecord, config.appDir, line, fsImpl);
    },
    now: () => new Date().toISOString(),
  };

  return Object.freeze({
    config,
    operations: Object.freeze(operations),
  });
}

module.exports = {
  AdapterError,
  DEFAULT_RUNTIME,
  MUTATING_OPERATION_NAMES: Object.freeze([...MUTATING_OPERATION_NAMES]),
  ORCHESTRATOR_OPERATION_NAMES,
  SAFE_NPM_ENVIRONMENT,
  acquireHostLock,
  appendReleaseRecord,
  buildMigrationChildEnvironment,
  createDirectDockerAdapter,
  inspectRuntimeSnapshot,
  isCorrelatedContainerProcess,
  isCanonicalRuntimeCandidate,
  isPotentialRuntimeCandidate,
  parseDockerContainerListing,
  parseDockerNetworkListing,
  parseDockerVolumeListing,
  parseHostProcessListing,
  readProtectedCredential,
  validateAdapterConfig,
  validateCanonicalRuntime,
  validateImmutableExecutor,
  validateLockCoordination,
  validateProtectedCredentialSource,
  validateReleaseRecordLine,
  validateReleaseRecordTarget,
};
