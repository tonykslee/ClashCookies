"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PROTOCOL_VERSION = 1;
const BROKER_STRATEGY = "rootful-docker-broker";
const BROKER_APPROVAL_SCOPE = "rootful-docker-broker-deployment";
const BROKER_MIGRATION_APPROVAL_SCOPE = "rootful-docker-broker-migration";
const BROKER_APPROVAL_SCOPES = Object.freeze([BROKER_APPROVAL_SCOPE, BROKER_MIGRATION_APPROVAL_SCOPE]);
const BROKER_APPROVERS = Object.freeze({
  [BROKER_APPROVAL_SCOPE]: "github-main-merge",
  [BROKER_MIGRATION_APPROVAL_SCOPE]: "github-environment-production-migration",
});
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const OPERATION_NAMES = Object.freeze([
  "readPreflightEvidence",
  "acquireExclusiveLock",
  "releaseExclusiveLock",
  "computeReleaseDiff",
  "classifyReleaseDiff",
  "inspectCheckout",
  "inspectRuntime",
  "createCandidate",
  "buildCandidate",
  "runMigrationRunner",
  "verifyMigration",
  "verifyPromotedArtifact",
  "stopRuntime",
  "checkoutRelease",
  "startRuntime",
  "healthCheck",
  "cleanupCandidate",
  "writeReleaseRecord",
  "runNonMigration",
]);

const READ_ONLY_OPERATIONS = new Set([
  "readPreflightEvidence",
  "computeReleaseDiff",
  "classifyReleaseDiff",
  "inspectCheckout",
  "inspectRuntime",
  "verifyMigration",
  "verifyPromotedArtifact",
  "healthCheck",
]);

const MIGRATION_OPERATIONS = new Set([
  "createCandidate",
  "buildCandidate",
  "runMigrationRunner",
  "verifyMigration",
  "verifyPromotedArtifact",
  "stopRuntime",
  "checkoutRelease",
  "startRuntime",
  "cleanupCandidate",
]);

const MUTATING_OPERATIONS = new Set(OPERATION_NAMES.filter((operation) => !READ_ONLY_OPERATIONS.has(operation)));
const RELEASE_RECORD_EVENTS = Object.freeze([
  "lock_acquired",
  "preflight_authorized",
  "preflight_passed",
  "candidate_build_passed",
  "migration_passed",
  "migration_verified",
  "promotion_passed",
  "candidate_cleaned",
  "candidate_cleanup_preserved",
  "old_runtime_rollback_blocked",
  "failure",
  "end",
]);

class BrokerError extends Error {
  constructor(message, code = "broker_blocked") {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

/** Return a deterministic JSON representation for approval and request binding. */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Validate the fixed broker installation contract without touching the host. */
function validateBrokerConfig(input = {}, appDir) {
  if (!input || input.strategy !== BROKER_STRATEGY || input.verified !== true) {
    throw new BrokerError("broker_configuration_required", "broker_configuration_invalid");
  }
  if (typeof input.socketPath !== "string" || !path.isAbsolute(input.socketPath)
    || path.resolve(input.socketPath) === path.resolve(appDir)
    || path.resolve(input.socketPath).startsWith(`${path.resolve(appDir)}${path.sep}`)) {
    throw new BrokerError("broker_socket_path_invalid", "broker_configuration_invalid");
  }
  if (typeof input.statePath !== "string" || !path.isAbsolute(input.statePath)
    || path.resolve(input.statePath) === path.resolve(appDir)
    || path.resolve(input.statePath).startsWith(`${path.resolve(appDir)}${path.sep}`)) {
    throw new BrokerError("broker_state_path_invalid", "broker_configuration_invalid");
  }
  const operator = input.operator || {};
  if (!Number.isInteger(operator.uid) || operator.uid < 1
    || !Number.isInteger(operator.gid) || operator.gid < 1
    || !Array.isArray(operator.supplementaryGids)
    || !Array.isArray(operator.groupNames)
    || operator.groupNames.some((name) => typeof name !== "string" || !TOKEN.test(name))
    || operator.groupNames.some((name) => ["sudo", "docker"].includes(name.toLowerCase()))
    || operator.supplementaryGids.some((gid) => !Number.isInteger(gid) || gid < 1)) {
    throw new BrokerError("broker_operator_identity_invalid", "broker_configuration_invalid");
  }
  const service = input.service || {};
  if (service.uid !== 0 || service.gid !== 0 || service.dockerAccess !== "rootful-socket-only"
    || typeof service.dockerSocket !== "string" || !path.isAbsolute(service.dockerSocket)) {
    throw new BrokerError("broker_service_boundary_invalid", "broker_configuration_invalid");
  }
  const approval = input.approval || {};
  if (!Array.isArray(approval.scopes)
    || approval.scopes.length !== BROKER_APPROVAL_SCOPES.length
    || approval.scopes.some((scope) => !BROKER_APPROVAL_SCOPES.includes(scope))
    || typeof approval.publicKeyPath !== "string" || !path.isAbsolute(approval.publicKeyPath)
    || typeof approval.keyId !== "string" || !TOKEN.test(approval.keyId)) {
    throw new BrokerError("broker_approval_boundary_invalid", "broker_configuration_invalid");
  }
  return Object.freeze({
    strategy: BROKER_STRATEGY,
    verified: true,
    socketPath: path.resolve(input.socketPath),
    statePath: path.resolve(input.statePath),
    operator: Object.freeze({
      uid: operator.uid,
      gid: operator.gid,
      supplementaryGids: Object.freeze([...new Set(operator.supplementaryGids)].sort((a, b) => a - b)),
      groupNames: Object.freeze([...operator.groupNames].sort()),
    }),
    service: Object.freeze({ uid: 0, gid: 0, dockerAccess: "rootful-socket-only", dockerSocket: service.dockerSocket }),
    approval: Object.freeze({
      scopes: Object.freeze([...approval.scopes]),
      publicKeyPath: path.resolve(approval.publicKeyPath),
      keyId: approval.keyId,
    }),
  });
}

/** Validate a release identity that is safe to bind to an approval. */
function validateReleaseIdentity(release) {
  if (!release || typeof release !== "object"
    || !TOKEN.test(release.sessionId || "")
    || !TOKEN.test(release.releaseId || "")
    || !SHA1.test(release.oldSha || "")
    || !SHA1.test(release.newSha || "")
    || !SHA256.test(release.migrationDiffDigest || "")
    || !SHA256.test(release.migrationManifestDigest || "")
    || !SHA256.test(release.authorizationDigest || "")
    || !TOKEN.test(release.approvedBy || "")) {
    throw new BrokerError("broker_release_identity_invalid", "broker_request_invalid");
  }
  return Object.freeze({
    sessionId: release.sessionId,
    releaseId: release.releaseId,
    oldSha: release.oldSha.toLowerCase(),
    newSha: release.newSha.toLowerCase(),
    migrationDiffDigest: release.migrationDiffDigest.toLowerCase(),
    migrationManifestDigest: release.migrationManifestDigest.toLowerCase(),
    authorizationDigest: release.authorizationDigest.toLowerCase(),
    approvedBy: release.approvedBy,
  });
}

/** Build the exact release-bound data that the approval signer must authorize. */
function approvalPayload(approval, release, scope = BROKER_APPROVAL_SCOPE) {
  return canonicalize({
    scope: approval.scope || scope,
    keyId: approval.keyId,
    nonce: approval.nonce,
    approvedBy: approval.approvedBy,
    reviewedCommit: approval.reviewedCommit,
    release,
  });
}

/** Validate the signed approval envelope without trusting client identity claims. */
function validateApproval(approval, release, config) {
  if (!approval || typeof approval !== "object"
    || !TOKEN.test(approval.keyId || "")
    || approval.keyId !== config.approval.keyId
    || !TOKEN.test(approval.nonce || "")
    || !BASE64.test(approval.signature || "")
    || !config.approval.scopes.includes(approval.scope)
    || !TOKEN.test(approval.approvedBy || "")
    || approval.approvedBy !== release.approvedBy
    || BROKER_APPROVERS[approval.scope] !== approval.approvedBy
    || !SHA1.test(approval.reviewedCommit || "")
    || approval.reviewedCommit.toLowerCase() !== release.newSha) {
    throw new BrokerError("broker_approval_invalid", "approval_invalid");
  }
  return Object.freeze({
    keyId: approval.keyId,
    nonce: approval.nonce,
    signature: approval.signature,
    scope: approval.scope,
    approvedBy: approval.approvedBy,
    reviewedCommit: approval.reviewedCommit.toLowerCase(),
    payload: approvalPayload(approval, release),
  });
}

/** Bind a request to the authenticated peer credentials supplied by the socket layer. */
function validatePeerIdentity(peer, operator) {
  if (!peer || peer.uid !== operator.uid || peer.gid !== operator.gid
    || !Array.isArray(peer.supplementaryGids)
    || JSON.stringify([...new Set(peer.supplementaryGids)].sort((a, b) => a - b))
      !== JSON.stringify(operator.supplementaryGids)
    || !Array.isArray(peer.groupNames)
    || JSON.stringify([...new Set(peer.groupNames)].sort()) !== JSON.stringify(operator.groupNames)) {
    throw new BrokerError("broker_peer_identity_mismatch", "identity_invalid");
  }
}

function emptyBrokerState() {
  return {
    version: 1,
    consumedNonces: [],
    requestIds: [],
    sessions: {},
    lockOwnerSession: null,
    recoveryRequired: false,
  };
}

function validateBrokerState(state) {
  if (!state || state.version !== 1
    || !Array.isArray(state.consumedNonces)
    || !Array.isArray(state.requestIds)
    || !state.sessions || typeof state.sessions !== "object"
    || (state.lockOwnerSession !== null && typeof state.lockOwnerSession !== "string")
    || typeof state.recoveryRequired !== "boolean") {
    throw new BrokerError("broker_state_invalid", "broker_state_invalid");
  }
  return state;
}

function syncFile(fsImpl, filePath) {
  if (typeof fsImpl.openSync !== "function"
    || typeof fsImpl.fsyncSync !== "function"
    || typeof fsImpl.closeSync !== "function") {
    throw new BrokerError("broker_state_fsync_unavailable", "broker_state_unavailable");
  }
  let fd;
  try {
    fd = fsImpl.openSync(filePath, fsImpl.constants.O_RDONLY);
    fsImpl.fsyncSync(fd);
  } catch {
    throw new BrokerError("broker_state_fsync_failed", "broker_state_unavailable");
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* preserve the original failure */ }
    }
  }
}

function syncDirectory(fsImpl, directoryPath) {
  if (typeof fsImpl.openSync !== "function"
    || typeof fsImpl.fsyncSync !== "function"
    || typeof fsImpl.closeSync !== "function") {
    throw new BrokerError("broker_state_directory_fsync_unavailable", "broker_state_unavailable");
  }
  let fd;
  try {
    fd = fsImpl.openSync(directoryPath, fsImpl.constants.O_RDONLY);
    fsImpl.fsyncSync(fd);
  } catch {
    throw new BrokerError("broker_state_directory_fsync_failed", "broker_state_unavailable");
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* preserve the original failure */ }
    }
  }
}

/** Persist broker replay and recovery state with an atomic same-directory rename. */
function createDurableBrokerStateStore({ statePath, fsImpl = fs, platform = process.platform } = {}) {
  if (typeof statePath !== "string" || !path.isAbsolute(statePath)) {
    throw new BrokerError("broker_state_path_invalid", "broker_configuration_invalid");
  }
  const read = () => {
    try {
      return validateBrokerState(JSON.parse(fsImpl.readFileSync(statePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyBrokerState();
      if (error instanceof BrokerError) throw error;
      throw new BrokerError("broker_state_read_failed", "broker_state_invalid");
    }
  };
  const save = (state) => {
    const validated = validateBrokerState(state);
    const tempPath = `${statePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    try {
      fsImpl.writeFileSync(tempPath, `${JSON.stringify(validated)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (typeof fsImpl.chmodSync === "function") fsImpl.chmodSync(tempPath, 0o600);
      if (platform === "linux") syncFile(fsImpl, tempPath);
      fsImpl.renameSync(tempPath, statePath);
      if (platform === "linux") syncDirectory(fsImpl, path.dirname(statePath));
    } catch {
      try { fsImpl.unlinkSync(tempPath); } catch { /* best effort cleanup */ }
      throw new BrokerError("broker_state_write_failed", "broker_state_unavailable");
    }
  };
  return Object.freeze({ load: read, save });
}

/** Verify a systemd/socket-activation fd and an exclusive operator-owned socket path. */
function verifySocketActivationBoundary({ fd, socketPath, operator, activation, fsImpl = fs } = {}) {
  if (!Number.isInteger(fd) || fd < 0 || typeof socketPath !== "string" || !path.isAbsolute(socketPath)
    || !operator || !Number.isInteger(operator.gid) || operator.gid < 1
    || !Number.isInteger(operator.uid) || operator.uid < 1
    || !activation || activation.listenPid !== process.pid || activation.listenFds !== 1
    || activation.listenFd !== fd
    || typeof fsImpl.fstatSync !== "function" || typeof fsImpl.lstatSync !== "function") {
    throw new BrokerError("broker_socket_boundary_invalid", "broker_configuration_invalid");
  }
  let fdStat;
  let pathStat;
  try {
    fdStat = fsImpl.fstatSync(fd);
    pathStat = fsImpl.lstatSync(socketPath);
  } catch {
    throw new BrokerError("broker_socket_boundary_unavailable", "broker_configuration_invalid");
  }
  if (typeof fdStat.isSocket !== "function" || !fdStat.isSocket()
    || typeof pathStat.isSocket !== "function" || !pathStat.isSocket()
    || pathStat.uid !== operator.uid || pathStat.gid !== operator.gid
    || (pathStat.mode & 0o7777) !== 0o600) {
    throw new BrokerError("broker_socket_boundary_mismatch", "broker_configuration_invalid");
  }
  return Object.freeze({
    verified: true,
    fd,
    socketPath: path.resolve(socketPath),
    ownerUid: operator.uid,
    ownerGid: operator.gid,
    mode: 0o600,
    activationVerified: true,
    exclusiveIdentity: true,
    peerIdentity: Object.freeze({
      uid: operator.uid,
      gid: operator.gid,
      supplementaryGids: [...operator.supplementaryGids],
      groupNames: [...operator.groupNames],
    }),
  });
}

/** Validate the narrow operation payload; clients never provide commands, paths, or environments. */
function validatePayload(operation, payload, release) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BrokerError("broker_payload_invalid", "broker_request_invalid");
  }
  const schemas = {
    readPreflightEvidence: [],
    acquireExclusiveLock: [],
    releaseExclusiveLock: [],
    computeReleaseDiff: ["oldSha", "newSha"],
    classifyReleaseDiff: ["oldSha", "newSha"],
    inspectCheckout: [],
    inspectRuntime: [],
    createCandidate: ["sha"],
    buildCandidate: ["sha"],
    runMigrationRunner: ["releaseId", "targetSha", "migrationManifestDigest", "migrationNames"],
    verifyMigration: ["targetSha", "migrationNames"],
    verifyPromotedArtifact: ["sha"],
    stopRuntime: [],
    checkoutRelease: ["sha"],
    startRuntime: ["sha"],
    healthCheck: [],
    cleanupCandidate: ["sha"],
    writeReleaseRecord: ["event"],
    runNonMigration: ["oldSha", "newSha"],
  };
  if (!Object.prototype.hasOwnProperty.call(schemas, operation)) {
    throw new BrokerError("broker_operation_not_allowlisted", "operation_invalid");
  }
  const allowed = new Set(schemas[operation]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new BrokerError("broker_payload_field_not_allowlisted", "broker_request_invalid");
  }
  for (const key of schemas[operation]) if (!Object.prototype.hasOwnProperty.call(payload, key)) {
    throw new BrokerError(`broker_payload_${key}_required`, "broker_request_invalid");
  }
  if ("oldSha" in payload && payload.oldSha !== release.oldSha) throw new BrokerError("broker_old_sha_mismatch", "release_mismatch");
  if ("newSha" in payload && payload.newSha !== release.newSha) throw new BrokerError("broker_new_sha_mismatch", "release_mismatch");
  if ("targetSha" in payload && payload.targetSha !== release.newSha) throw new BrokerError("broker_target_sha_mismatch", "release_mismatch");
  if ("sha" in payload && payload.sha !== release.newSha) throw new BrokerError("broker_artifact_sha_mismatch", "release_mismatch");
  if ("releaseId" in payload && payload.releaseId !== release.releaseId) throw new BrokerError("broker_release_id_mismatch", "release_mismatch");
  if ("migrationManifestDigest" in payload && payload.migrationManifestDigest !== release.migrationManifestDigest) {
    throw new BrokerError("broker_manifest_digest_mismatch", "release_mismatch");
  }
  if ("migrationNames" in payload && (!Array.isArray(payload.migrationNames)
    || payload.migrationNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(name)))) {
    throw new BrokerError("broker_migration_names_invalid", "broker_request_invalid");
  }
  if (operation === "writeReleaseRecord" && !RELEASE_RECORD_EVENTS.includes(payload.event)) {
    throw new BrokerError("broker_release_record_event_invalid", "broker_request_invalid");
  }
  return Object.freeze({ ...payload });
}

/** Create a verifier for an Ed25519 approval key held by the privileged service. */
function createEd25519ApprovalVerifier({ publicKey, consumedNonces = new Set() } = {}) {
  if (!publicKey || !(consumedNonces instanceof Set)) throw new BrokerError("broker_approval_verifier_invalid");
  return ({ approval, release }) => {
    const nonceKey = `${approval.keyId}:${approval.nonce}`;
    if (consumedNonces.has(nonceKey)) return false;
    let valid = false;
    try {
      valid = crypto.verify(null, Buffer.from(approvalPayload(approval, release)), publicKey, Buffer.from(approval.signature, "base64"));
    } catch {
      valid = false;
    }
    if (valid) consumedNonces.add(nonceKey);
    return valid;
  };
}

/** Validate one broker request and return the sanitized operation context. */
function validateBrokerRequest(request, { config, peerIdentity, sessions, requestIds, approvalVerifier }) {
  const allowedRequestKeys = new Set(["protocolVersion", "requestId", "sessionId", "operation", "release", "approval", "payload"]);
  if (!request || typeof request !== "object"
    || request.protocolVersion !== PROTOCOL_VERSION
    || !TOKEN.test(request.requestId || "")
    || !TOKEN.test(request.sessionId || "")
    || !OPERATION_NAMES.includes(request.operation)
    || Object.keys(request).some((key) => !allowedRequestKeys.has(key))) {
    throw new BrokerError("broker_request_invalid", "broker_request_invalid");
  }
  if (requestIds.has(request.requestId)) throw new BrokerError("broker_request_replayed", "replay_rejected");
  requestIds.add(request.requestId);
  const release = validateReleaseIdentity(request.release);
  if (release.sessionId !== request.sessionId) throw new BrokerError("broker_session_mismatch", "release_mismatch");
  validatePeerIdentity(peerIdentity, config.operator);
  const approval = validateApproval(request.approval, release, config);
  const existing = sessions.get(request.sessionId);
  if (existing) {
    if (existing.releaseFingerprint !== canonicalize(release)
      || existing.approvalFingerprint !== canonicalize({ ...approval, payload: undefined })) {
      throw new BrokerError("broker_session_binding_mismatch", "replay_rejected");
    }
    if (existing.terminal) throw new BrokerError("broker_session_terminal", "replay_rejected");
  } else {
    if (typeof approvalVerifier !== "function") throw new BrokerError("broker_approval_verifier_unavailable", "approval_unavailable");
    if (approvalVerifier({ approval, release, payload: approval.payload }) !== true) {
      throw new BrokerError("broker_approval_signature_invalid", "approval_invalid");
    }
    sessions.set(request.sessionId, {
      releaseFingerprint: canonicalize(release),
      approvalFingerprint: canonicalize({ ...approval, payload: undefined }),
      approvalNonce: approval.nonce,
      acquired: false,
      terminal: false,
      phase: "new",
      diffKind: null,
      diff: null,
      preflightVerified: false,
      checkoutInspected: false,
      runtimeBeforeVerified: false,
      promotionRuntimeVerified: false,
      candidateCreated: false,
      candidateBuilt: false,
      migrationRan: false,
      migrationVerified: false,
      artifactVerified: false,
      runtimeStopped: false,
      releaseCheckedOut: false,
      runtimeStarted: false,
      runtimeAfterVerified: false,
      healthy: false,
      nonMigrationExecuted: false,
      candidateCleaned: false,
      diffClassified: false,
      diffComputed: false,
      recordEvents: [],
      inFlight: null,
    });
  }
  const payload = validatePayload(request.operation, request.payload, release);
  const session = sessions.get(request.sessionId);
  if (request.operation === "acquireExclusiveLock") {
    if (session.acquired) throw new BrokerError("broker_lock_already_acquired", "lock_conflict");
  }
  if (request.operation === "releaseExclusiveLock") {
    if (!session.acquired) throw new BrokerError("broker_lock_not_owned", "lock_conflict");
  }
  return Object.freeze({
    requestId: request.requestId,
    sessionId: request.sessionId,
    operation: request.operation,
    payload,
    release,
    approval,
    approvalScope: approval.scope,
    session,
    peerIdentity: Object.freeze({ ...peerIdentity }),
    readOnly: READ_ONLY_OPERATIONS.has(request.operation),
  });
}

function requiredApprovalScope(operation) {
  if (operation === "runNonMigration") return BROKER_APPROVAL_SCOPE;
  if (MIGRATION_OPERATIONS.has(operation) || operation === "computeReleaseDiff" || operation === "writeReleaseRecord") return BROKER_MIGRATION_APPROVAL_SCOPE;
  return null;
}

function assertRecordEventAllowed(event, session) {
  if (!RELEASE_RECORD_EVENTS.includes(event) || !Array.isArray(session.recordEvents)) {
    throw new BrokerError("broker_release_record_event_invalid", "phase_invalid");
  }
  if (session.recordEvents.includes(event)) {
    throw new BrokerError("broker_release_record_event_repeated", "phase_invalid");
  }
  const allowed = {
    lock_acquired: session.acquired,
    preflight_authorized: session.preflightVerified,
    preflight_passed: session.runtimeBeforeVerified,
    candidate_build_passed: session.candidateBuilt,
    migration_passed: session.migrationRan,
    migration_verified: session.migrationVerified,
    promotion_passed: session.healthy,
    candidate_cleaned: session.candidateCleaned,
    candidate_cleanup_preserved: session.recoveryRequired,
    old_runtime_rollback_blocked: session.recoveryRequired,
    failure: session.failureObserved === true,
    end: session.healthy || session.nonMigrationExecuted || session.failureObserved === true,
  };
  if (allowed[event] !== true) {
    throw new BrokerError("broker_release_record_phase_invalid", "phase_invalid");
  }
  if (event === "lock_acquired" && session.recordEvents.length !== 0) {
    throw new BrokerError("broker_release_record_order_invalid", "phase_invalid");
  }
  const previous = {
    preflight_authorized: "lock_acquired",
    preflight_passed: "preflight_authorized",
    candidate_build_passed: "preflight_passed",
    migration_passed: "candidate_build_passed",
    migration_verified: "migration_passed",
    promotion_passed: "migration_verified",
    candidate_cleaned: "promotion_passed",
    candidate_cleanup_preserved: "failure",
    old_runtime_rollback_blocked: "failure",
  }[event];
  if (previous && !session.recordEvents.includes(previous)) {
    throw new BrokerError("broker_release_record_order_invalid", "phase_invalid");
  }
  if (event === "end"
    && !["failure", "candidate_cleanup_preserved", "candidate_cleaned"].some((value) => session.recordEvents.includes(value))) {
    throw new BrokerError("broker_release_record_order_invalid", "phase_invalid");
  }
}

function validateDiffResult(result, release) {
  if (!result || result.oldSha !== release.oldSha || result.newSha !== release.newSha
    || result.digest !== release.migrationDiffDigest || !Array.isArray(result.paths)
    || !Array.isArray(result.migrationNames)) {
    throw new BrokerError("broker_diff_evidence_invalid", "phase_evidence_invalid");
  }
  return result;
}

function createReleaseRecordLine(context, event) {
  if (!context?.release || !RELEASE_RECORD_EVENTS.includes(event)) {
    throw new BrokerError("broker_release_record_event_invalid", "phase_invalid");
  }
  return JSON.stringify({
    event,
    releaseId: context.release.releaseId,
    oldSha: context.release.oldSha,
    newSha: context.release.newSha,
    migrationDiffDigest: context.release.migrationDiffDigest,
    migrationManifestDigest: context.release.migrationManifestDigest,
    authorizationDigest: context.release.authorizationDigest,
    approvedBy: context.release.approvedBy,
    phase: context.session?.phase || "unknown",
    at: new Date().toISOString(),
  });
}

function serializeBrokerState({ sessions, requestIds, consumedNonces, lockOwnerSession, recoveryRequired }) {
  return {
    version: 1,
    consumedNonces: [...consumedNonces].sort(),
    requestIds: [...requestIds].sort(),
    sessions: Object.fromEntries([...sessions.entries()].map(([key, value]) => [key, { ...value }])),
    lockOwnerSession,
    recoveryRequired,
  };
}

function restoreSessions(rawSessions) {
  const sessions = new Map();
  for (const [key, value] of Object.entries(rawSessions || {})) {
    sessions.set(key, {
      ...value,
      recordEvents: Array.isArray(value.recordEvents) ? [...value.recordEvents] : [],
      failureObserved: value.failureObserved === true,
    });
  }
  return sessions;
}

function assertSessionOperation(context, session, lockOwnerSession, recoveryRequired) {
  const recoverySafeOperation = context.operation === "releaseExclusiveLock" || context.operation === "writeReleaseRecord";
  if (recoveryRequired && !recoverySafeOperation) {
    throw new BrokerError("broker_recovery_required", "broker_recovery_required");
  }
  if (session.terminal) throw new BrokerError("broker_session_terminal", "replay_rejected");
  if (session.inFlight) throw new BrokerError("broker_session_busy", "concurrent_request");
  if (session.recoveryRequired && !recoverySafeOperation) {
    throw new BrokerError("broker_session_recovery_required", "broker_recovery_required");
  }
  const requiredScope = requiredApprovalScope(context.operation);
  if (requiredScope && context.approvalScope !== requiredScope) {
    throw new BrokerError("broker_approval_authority_insufficient", "approval_scope_invalid");
  }
  if (context.operation === "acquireExclusiveLock") {
    if (session.acquired) throw new BrokerError("broker_lock_already_acquired", "lock_conflict");
    if (lockOwnerSession !== null && lockOwnerSession !== context.sessionId) {
      throw new BrokerError("broker_lock_conflict", "lock_conflict");
    }
    return;
  }
  if (context.operation === "releaseExclusiveLock") {
    if (!session.acquired) throw new BrokerError("broker_lock_not_owned", "lock_conflict");
    if (lockOwnerSession !== context.sessionId) throw new BrokerError("broker_lock_owner_mismatch", "lock_conflict");
    return;
  }
  if (context.operation === "classifyReleaseDiff") {
    if (session.diffClassified) throw new BrokerError("broker_diff_already_classified", "phase_invalid");
    return;
  }
  if (!session.acquired || lockOwnerSession !== context.sessionId) {
    throw new BrokerError("broker_lock_required", "lock_conflict");
  }
  if (MUTATING_OPERATIONS.has(context.operation) && lockOwnerSession !== context.sessionId) {
    throw new BrokerError("broker_lock_required", "lock_conflict");
  }
  if (context.operation === "readPreflightEvidence" && session.preflightVerified) {
    throw new BrokerError("broker_preflight_already_read", "phase_invalid");
  }
  if (context.operation === "inspectCheckout" && session.checkoutInspected) {
    throw new BrokerError("broker_checkout_already_inspected", "phase_invalid");
  }
  if (context.operation === "inspectCheckout" && !session.preflightVerified) {
    throw new BrokerError("broker_preflight_required", "phase_invalid");
  }
  if (context.operation === "computeReleaseDiff" && session.diffComputed) {
    throw new BrokerError("broker_diff_already_computed", "phase_invalid");
  }
  if (context.operation === "computeReleaseDiff" && !session.checkoutInspected) {
    throw new BrokerError("broker_checkout_required", "phase_invalid");
  }
  if (context.operation === "inspectRuntime"
    && ((session.runtimeStarted && session.runtimeAfterVerified)
      || (session.migrationVerified && session.promotionRuntimeVerified && !session.runtimeStarted)
      || (!session.migrationVerified && !session.runtimeStarted && session.runtimeBeforeVerified))) {
    throw new BrokerError("broker_runtime_already_inspected", "phase_invalid");
  }
  if (context.operation === "inspectRuntime"
    && !session.diffKind
    && !session.migrationVerified
    && !session.runtimeStarted) {
    throw new BrokerError("broker_diff_required", "phase_invalid");
  }
  if (context.operation === "createCandidate"
    && (session.diffKind !== "migration" || !session.runtimeBeforeVerified)) {
    throw new BrokerError("broker_runtime_preflight_required", "phase_invalid");
  }
  if (context.operation === "createCandidate" && session.candidateCreated) {
    throw new BrokerError("broker_candidate_already_created", "phase_invalid");
  }
  if (context.operation === "buildCandidate" && !session.candidateCreated) {
    throw new BrokerError("broker_candidate_required", "phase_invalid");
  }
  if (context.operation === "buildCandidate" && session.candidateBuilt) {
    throw new BrokerError("broker_candidate_already_built", "phase_invalid");
  }
  if (context.operation === "runMigrationRunner" && (!session.candidateBuilt || session.diffKind !== "migration")) {
    throw new BrokerError("broker_candidate_build_required", "phase_invalid");
  }
  if (context.operation === "runMigrationRunner" && session.migrationRan) {
    throw new BrokerError("broker_migration_already_run", "phase_invalid");
  }
  if (context.operation === "verifyMigration" && !session.migrationRan) {
    throw new BrokerError("broker_migration_required", "phase_invalid");
  }
  if (context.operation === "verifyMigration" && session.migrationVerified) {
    throw new BrokerError("broker_migration_already_verified", "phase_invalid");
  }
  if (context.operation === "verifyPromotedArtifact"
    && (!session.migrationVerified || !session.promotionRuntimeVerified)) {
    throw new BrokerError("broker_promotion_preflight_required", "phase_invalid");
  }
  if (context.operation === "verifyPromotedArtifact" && session.artifactVerified) {
    throw new BrokerError("broker_artifact_already_verified", "phase_invalid");
  }
  if (context.operation === "stopRuntime" && !session.artifactVerified) {
    throw new BrokerError("broker_artifact_verification_required", "phase_invalid");
  }
  if (context.operation === "stopRuntime" && session.runtimeStopped) {
    throw new BrokerError("broker_runtime_already_stopped", "phase_invalid");
  }
  if (context.operation === "checkoutRelease" && !session.runtimeStopped) {
    throw new BrokerError("broker_runtime_stop_required", "phase_invalid");
  }
  if (context.operation === "checkoutRelease" && session.releaseCheckedOut) {
    throw new BrokerError("broker_release_already_checked_out", "phase_invalid");
  }
  if (context.operation === "startRuntime" && !session.releaseCheckedOut) {
    throw new BrokerError("broker_checkout_release_required", "phase_invalid");
  }
  if (context.operation === "startRuntime" && session.runtimeStarted) {
    throw new BrokerError("broker_runtime_already_started", "phase_invalid");
  }
  if (context.operation === "healthCheck" && !session.runtimeAfterVerified) {
    throw new BrokerError("broker_runtime_start_verification_required", "phase_invalid");
  }
  if (context.operation === "healthCheck" && session.healthy) {
    throw new BrokerError("broker_health_already_checked", "phase_invalid");
  }
  if (context.operation === "cleanupCandidate" && !session.healthy) {
    throw new BrokerError("broker_health_check_required", "phase_invalid");
  }
  if (context.operation === "cleanupCandidate" && session.candidateCleaned) {
    throw new BrokerError("broker_candidate_already_cleaned", "phase_invalid");
  }
  if (context.operation === "runNonMigration"
    && (context.approvalScope !== BROKER_APPROVAL_SCOPE
      || session.diffKind !== "non-migration"
      || !session.preflightVerified
      || !session.checkoutInspected
      || !session.runtimeBeforeVerified)) {
    throw new BrokerError("broker_non_migration_preflight_required", "phase_invalid");
  }
  if (context.operation === "runNonMigration" && session.nonMigrationExecuted) {
    throw new BrokerError("broker_non_migration_already_executed", "phase_invalid");
  }
  if (context.operation === "writeReleaseRecord") assertRecordEventAllowed(context.payload.event, session);
}

function applySessionTransition(context, result, session, phaseValidators = {}) {
  const validator = phaseValidators[context.operation];
  if (validator !== undefined && typeof validator !== "function") {
    throw new BrokerError("broker_phase_validator_invalid", "broker_configuration_invalid");
  }
  const verifiedResult = typeof validator === "function"
    ? validator(result, context, session)
    : result;
  if (context.operation === "readPreflightEvidence") {
    if (typeof validator !== "function") throw new BrokerError("broker_preflight_validator_required", "phase_evidence_invalid");
    session.preflightVerified = true;
    session.preflightEvidence = verifiedResult;
    session.phase = "preflight";
  } else if (context.operation === "inspectCheckout") {
    session.checkoutInspected = true;
    session.checkout = verifiedResult;
    session.phase = "checkout";
  } else if (context.operation === "computeReleaseDiff" || context.operation === "classifyReleaseDiff") {
    const diff = validateDiffResult(verifiedResult, context.release);
    session.diff = Object.freeze({ oldSha: diff.oldSha, newSha: diff.newSha, digest: diff.digest });
    session.diffKind = diff.paths.length === 0 ? "non-migration" : "migration";
    if (context.operation === "computeReleaseDiff") session.diffComputed = true;
    if (context.operation === "classifyReleaseDiff") session.diffClassified = true;
    session.phase = "diff";
  } else if (context.operation === "inspectRuntime") {
    session.runtime = verifiedResult;
    if (session.runtimeStarted) {
      session.runtimeAfterVerified = true;
      session.phase = "runtime_after";
    } else if (session.migrationVerified) {
      session.promotionRuntimeVerified = true;
      session.phase = "promotion_runtime";
    } else {
      session.runtimeBeforeVerified = true;
      session.phase = "runtime_before";
    }
  } else if (context.operation === "acquireExclusiveLock") {
    session.acquired = true;
    session.phase = session.diffKind ? "locked_after_diff" : "locked";
  } else if (context.operation === "createCandidate") {
    session.candidateCreated = true;
    session.phase = "candidate_created";
  } else if (context.operation === "buildCandidate") {
    session.candidateBuilt = true;
    session.phase = "candidate_built";
  } else if (context.operation === "runMigrationRunner") {
    session.migrationRan = true;
    session.phase = "migration_ran";
  } else if (context.operation === "verifyMigration") {
    session.migrationVerified = true;
    session.phase = "migration_verified";
  } else if (context.operation === "verifyPromotedArtifact") {
    session.artifactVerified = true;
    session.phase = "artifact_verified";
  } else if (context.operation === "stopRuntime") {
    session.runtimeStopped = true;
    session.phase = "runtime_stopped";
  } else if (context.operation === "checkoutRelease") {
    session.releaseCheckedOut = true;
    session.phase = "release_checked_out";
  } else if (context.operation === "startRuntime") {
    session.runtimeStarted = true;
    session.phase = "runtime_started";
  } else if (context.operation === "healthCheck") {
    session.healthy = true;
    session.phase = "healthy";
  } else if (context.operation === "cleanupCandidate") {
    session.candidateCleaned = true;
    session.phase = "cleaned";
  } else if (context.operation === "runNonMigration") {
    session.nonMigrationExecuted = true;
    session.phase = "non_migration_executed";
  } else if (context.operation === "writeReleaseRecord") {
    session.recordEvents.push(context.payload.event);
  }
  return verifiedResult;
}

/** Create the privileged-side request handler; Docker and credentials stay behind this boundary. */
function createRootfulBrokerServer({
  config,
  peerIdentitySource,
  approvalVerifier,
  approvalVerifierFactory,
  handlers = {},
  phaseValidators = {},
  state = {},
  stateStore,
} = {}) {
  const validatedConfig = validateBrokerConfig(config, config?.appDir || "/");
  for (const operation of ["readPreflightEvidence", "inspectCheckout", "computeReleaseDiff", "classifyReleaseDiff", "inspectRuntime", "runMigrationRunner", "verifyMigration", "healthCheck"]) {
    if (typeof phaseValidators[operation] !== "function") {
      throw new BrokerError("broker_phase_validator_required", "broker_configuration_invalid");
    }
  }
  const persisted = stateStore ? stateStore.load() : emptyBrokerState();
  const sessions = state.sessions instanceof Map
    ? state.sessions
    : restoreSessions(persisted.sessions);
  const requestIds = state.requestIds instanceof Set
    ? state.requestIds
    : new Set(persisted.requestIds);
  const consumedNonces = state.consumedNonces instanceof Set
    ? state.consumedNonces
    : new Set(persisted.consumedNonces);
  const verifier = typeof approvalVerifierFactory === "function"
    ? approvalVerifierFactory(consumedNonces)
    : approvalVerifier;
  let lockOwnerSession = state.lockOwnerSession || persisted.lockOwnerSession || null;
  let recoveryRequired = state.recoveryRequired === true || persisted.recoveryRequired === true;
  if (stateStore && (lockOwnerSession !== null || [...sessions.values()].some((session) => !session.terminal))) {
    recoveryRequired = true;
  }
  const persist = () => {
    if (!stateStore) return;
    stateStore.save(serializeBrokerState({ sessions, requestIds, consumedNonces, lockOwnerSession, recoveryRequired }));
  };
  if (stateStore && recoveryRequired !== persisted.recoveryRequired) persist();

  return Object.freeze({
    async handle(request, peerIdentityOverride) {
      const peerIdentity = peerIdentityOverride
        || (typeof peerIdentitySource === "function" ? peerIdentitySource() : peerIdentitySource);
      const context = validateBrokerRequest(request, {
        config: validatedConfig,
        peerIdentity,
        sessions,
        requestIds,
        approvalVerifier: verifier,
      });
      const session = context.session;
      assertSessionOperation(context, session, lockOwnerSession, recoveryRequired);
      const handler = handlers[context.operation];
      if (typeof handler !== "function") throw new BrokerError("broker_operation_unavailable", "broker_unavailable");
      const mutating = MUTATING_OPERATIONS.has(context.operation);
      if (context.operation === "acquireExclusiveLock") lockOwnerSession = context.sessionId;
      session.inFlight = context.operation;
      try {
        persist();
      } catch (error) {
        session.inFlight = null;
        if (context.operation === "acquireExclusiveLock" && lockOwnerSession === context.sessionId) lockOwnerSession = null;
        throw error;
      }
      let result;
      try {
        result = await handler(context.payload, context);
        result = applySessionTransition(context, result, session, phaseValidators);
        session.inFlight = null;
        if (context.operation === "releaseExclusiveLock") {
          session.terminal = true;
          session.acquired = false;
          lockOwnerSession = null;
        }
        persist();
      } catch (error) {
        session.inFlight = null;
        if (context.operation === "acquireExclusiveLock" && lockOwnerSession === context.sessionId) lockOwnerSession = null;
        const ambiguousPhaseFailure = mutating
          || session.migrationRan
          || session.runtimeStarted
          || ["runMigrationRunner", "verifyMigration", "verifyPromotedArtifact", "healthCheck"].includes(context.operation);
        if (ambiguousPhaseFailure) {
          session.recoveryRequired = true;
          recoveryRequired = true;
        }
        session.failureObserved = true;
        try { persist(); } catch { recoveryRequired = true; }
        throw error;
      }
      return Object.freeze({ ok: true, requestId: context.requestId, result: result === undefined ? null : result });
    },
    sessions,
    requestIds,
    get lockOwnerSession() { return lockOwnerSession; },
    get recoveryRequired() { return recoveryRequired; },
  });
}

/** Bind the broker protocol to a pre-created, service-owned Unix socket. */
function createUnixBrokerListener({
  server,
  socketPath,
  peerIdentityResolver,
  socketBoundary,
  maxRequestBytes = 128 * 1024,
  requestTimeoutMs = 5000,
} = {}) {
  if (!server || typeof server.handle !== "function"
    || typeof socketPath !== "string" || !path.isAbsolute(socketPath)
    || typeof peerIdentityResolver !== "function"
    || !socketBoundary || socketBoundary.verified !== true
    || socketBoundary.socketPath !== path.resolve(socketPath)
    || !Number.isInteger(socketBoundary.fd)
    || !Number.isInteger(maxRequestBytes) || maxRequestBytes <= 0
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new BrokerError("broker_listener_configuration_invalid", "broker_configuration_invalid");
  }
  const listener = net.createServer({ allowHalfOpen: true }, (socket) => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    socket.setTimeout(requestTimeoutMs, () => {
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    });
    socket.on("error", () => {
      settled = true;
    });
    socket.on("data", async (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxRequestBytes) {
        socket.destroy();
        settled = true;
        return;
      }
      chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const newline = raw.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      let request;
      try {
        request = JSON.parse(raw.slice(0, newline));
        const peerIdentity = peerIdentityResolver(socket);
        const result = await server.handle(request, peerIdentity);
        socket.end(`${JSON.stringify(result)}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({
          ok: false,
          requestId: request?.requestId || null,
          error: { code: error?.code || "broker_failed", message: "broker request rejected" },
        })}\n`);
      }
    });
  });
  listener.listen({ fd: socketBoundary.fd });
  return listener;
}

/** Create an in-process transport for deterministic security tests only. */
function createInMemoryTransport(server) {
  if (!server || typeof server.handle !== "function") throw new BrokerError("broker_transport_invalid");
  return (request) => server.handle(request);
}

/** Create the production Unix-socket transport with bounded newline-delimited JSON. */
function createUnixSocketTransport({ socketPath, timeoutMs = 5000, maxResponseBytes = 128 * 1024 } = {}) {
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new BrokerError("broker_transport_configuration_invalid", "broker_transport_invalid");
  }
  return (request) => new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let bytes = 0;
    const chunks = [];
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const socket = net.createConnection(socketPath);
    const fail = (message) => finish(reject, new BrokerError(message, "broker_transport_failed"));
    timer = setTimeout(() => { socket.destroy(); fail("broker_transport_timeout"); }, timeoutMs);
    socket.on("error", () => fail("broker_transport_failed"));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxResponseBytes) { socket.destroy(); fail("broker_response_too_large"); return; }
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(0x0a)) socket.end();
    });
    socket.on("close", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
      try {
        const response = JSON.parse(raw);
        if (!response || response.ok !== true || response.requestId !== request.requestId) throw new Error("response_invalid");
        finish(resolve, response.result);
      } catch { fail("broker_response_invalid"); }
    });
    socket.write(`${JSON.stringify(request)}\n`, (error) => {
      if (error) fail("broker_transport_failed");
    });
    socket.end();
  });
}

/** Build the orchestrator operation surface that can only talk to the broker. */
function createRootfulBrokerOperations({ config, release, approval, transport, requestIdFactory = () => crypto.randomUUID() } = {}) {
  const brokerConfig = validateBrokerConfig(config, config?.appDir || "/");
  const validatedRelease = validateReleaseIdentity(release);
  if (typeof approval !== "object" || approval === null) throw new BrokerError("broker_approval_required", "approval_unavailable");
  if (typeof transport !== "function") throw new BrokerError("broker_transport_required", "broker_unavailable");
  const call = async (operation, payload) => {
    const requestId = requestIdFactory();
    if (!TOKEN.test(requestId)) throw new BrokerError("broker_request_id_invalid", "broker_request_invalid");
    return transport({
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      sessionId: validatedRelease.sessionId,
      operation,
      release: validatedRelease,
      approval,
      payload,
    });
  };
  const operations = {
    readPreflightEvidence: () => call("readPreflightEvidence", {}),
    acquireExclusiveLock: async () => {
      await call("acquireExclusiveLock", {});
      let released = false;
      return async () => {
        if (released) return false;
        released = true;
        const result = await call("releaseExclusiveLock", {});
        return result === true || result?.released === true;
      };
    },
    computeReleaseDiff: (_repoRoot, oldSha, newSha) => call("computeReleaseDiff", { oldSha, newSha }),
    classifyReleaseDiff: (_repoRoot, oldSha, newSha) => call("classifyReleaseDiff", { oldSha, newSha }),
    inspectCheckout: () => call("inspectCheckout", {}),
    inspectRuntime: () => call("inspectRuntime", {}),
    createCandidate: (_candidatePath, sha) => call("createCandidate", { sha }),
    buildCandidate: ({ sha }) => call("buildCandidate", { sha }),
    runMigrationRunner: (request) => call("runMigrationRunner", {
      releaseId: request.releaseId,
      targetSha: request.targetSha,
      migrationManifestDigest: request.migrationManifestDigest,
      migrationNames: request.migrationNames || [],
    }),
    verifyMigration: (request) => call("verifyMigration", {
      targetSha: request.targetSha,
      migrationNames: request.migrationNames || [],
    }),
    verifyPromotedArtifact: ({ sha }) => call("verifyPromotedArtifact", { sha }),
    stopRuntime: () => call("stopRuntime", {}),
    checkoutRelease: ({ sha }) => call("checkoutRelease", { sha }),
    startRuntime: ({ sha }) => call("startRuntime", { sha }),
    healthCheck: () => call("healthCheck", {}),
    cleanupCandidate: ({ sha }) => call("cleanupCandidate", { sha }),
    writeReleaseRecord: (_recordPath, line) => {
      let event;
      try { event = JSON.parse(line)?.event; } catch { throw new BrokerError("broker_release_record_invalid", "broker_request_invalid"); }
      return call("writeReleaseRecord", { event });
    },
    runNonMigration: ({ oldSha, newSha }) => call("runNonMigration", { oldSha, newSha }),
    now: () => new Date().toISOString(),
  };
  return Object.freeze({ broker: brokerConfig, operations: Object.freeze(operations) });
}

module.exports = {
  PROTOCOL_VERSION,
  BROKER_STRATEGY,
  BROKER_APPROVAL_SCOPE,
  BROKER_MIGRATION_APPROVAL_SCOPE,
  BROKER_APPROVAL_SCOPES,
  OPERATION_NAMES,
  BrokerError,
  approvalPayload,
  canonicalize,
  createReleaseRecordLine,
  createDurableBrokerStateStore,
  createEd25519ApprovalVerifier,
  createInMemoryTransport,
  createRootfulBrokerOperations,
  createRootfulBrokerServer,
  createUnixBrokerListener,
  createUnixSocketTransport,
  verifySocketActivationBoundary,
  validateApproval,
  validateBrokerConfig,
  validateBrokerRequest,
  validatePayload,
  validatePeerIdentity,
  validateReleaseIdentity,
};
