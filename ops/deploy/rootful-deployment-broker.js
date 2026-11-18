"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");

const PROTOCOL_VERSION = 1;
const BROKER_STRATEGY = "rootful-docker-broker";
const BROKER_APPROVAL_SCOPE = "rootful-docker-broker-deployment";
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const OPERATION_NAMES = Object.freeze([
  "readPreflightEvidence",
  "acquireExclusiveLock",
  "releaseExclusiveLock",
  "computeReleaseDiff",
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
  "inspectCheckout",
  "inspectRuntime",
  "verifyMigration",
  "verifyPromotedArtifact",
  "healthCheck",
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
  if (approval.scope !== BROKER_APPROVAL_SCOPE
    || typeof approval.publicKeyPath !== "string" || !path.isAbsolute(approval.publicKeyPath)
    || typeof approval.keyId !== "string" || !TOKEN.test(approval.keyId)) {
    throw new BrokerError("broker_approval_boundary_invalid", "broker_configuration_invalid");
  }
  return Object.freeze({
    strategy: BROKER_STRATEGY,
    verified: true,
    socketPath: path.resolve(input.socketPath),
    operator: Object.freeze({
      uid: operator.uid,
      gid: operator.gid,
      supplementaryGids: Object.freeze([...new Set(operator.supplementaryGids)].sort((a, b) => a - b)),
      groupNames: Object.freeze([...operator.groupNames].sort()),
    }),
    service: Object.freeze({ uid: 0, gid: 0, dockerAccess: "rootful-socket-only", dockerSocket: service.dockerSocket }),
    approval: Object.freeze({
      scope: BROKER_APPROVAL_SCOPE,
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
    scope,
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
    || approval.scope !== BROKER_APPROVAL_SCOPE
    || !TOKEN.test(approval.approvedBy || "")
    || approval.approvedBy !== release.approvedBy
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
    writeReleaseRecord: ["line"],
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
  if (operation === "writeReleaseRecord"
    && (typeof payload.line !== "string" || payload.line.length === 0 || payload.line.length > 2048
      || /[\r\n\0]/.test(payload.line) || /(?:DATABASE_URL|PASSWORD|TOKEN|SECRET|PRIVATE[_-]?KEY|https?:\/\/)/i.test(payload.line))) {
    throw new BrokerError("broker_release_record_invalid", "broker_request_invalid");
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
    peerIdentity: Object.freeze({ ...peerIdentity }),
    readOnly: READ_ONLY_OPERATIONS.has(request.operation),
  });
}

/** Create the privileged-side request handler; Docker and credentials stay behind this boundary. */
function createRootfulBrokerServer({ config, peerIdentitySource, approvalVerifier, handlers = {}, state = {} } = {}) {
  const validatedConfig = validateBrokerConfig(config, config?.appDir || "/");
  const sessions = state.sessions instanceof Map ? state.sessions : new Map();
  const requestIds = state.requestIds instanceof Set ? state.requestIds : new Set();
  let lockOwnerSession = state.lockOwnerSession || null;
  return Object.freeze({
    async handle(request, peerIdentityOverride) {
      const peerIdentity = peerIdentityOverride
        || (typeof peerIdentitySource === "function" ? peerIdentitySource() : peerIdentitySource);
      const context = validateBrokerRequest(request, {
        config: validatedConfig,
        peerIdentity,
        sessions,
        requestIds,
        approvalVerifier,
      });
      const handler = handlers[context.operation];
      if (typeof handler !== "function") throw new BrokerError("broker_operation_unavailable", "broker_unavailable");
      if (context.operation === "acquireExclusiveLock"
        && lockOwnerSession !== null && lockOwnerSession !== context.sessionId) {
        throw new BrokerError("broker_lock_conflict", "lock_conflict");
      }
      if (context.operation === "releaseExclusiveLock"
        && lockOwnerSession !== null && lockOwnerSession !== context.sessionId) {
        throw new BrokerError("broker_lock_owner_mismatch", "lock_conflict");
      }
      if (context.operation === "acquireExclusiveLock") lockOwnerSession = context.sessionId;
      let result;
      try {
        result = await handler(context.payload, context);
      } catch (error) {
        if (context.operation === "acquireExclusiveLock" && lockOwnerSession === context.sessionId) lockOwnerSession = null;
        throw error;
      }
      if (context.operation === "acquireExclusiveLock") sessions.get(context.sessionId).acquired = true;
      if (context.operation === "releaseExclusiveLock") {
        sessions.get(context.sessionId).terminal = true;
        lockOwnerSession = null;
      }
      return Object.freeze({ ok: true, requestId: context.requestId, result: result === undefined ? null : result });
    },
    sessions,
    requestIds,
    get lockOwnerSession() { return lockOwnerSession; },
  });
}

/** Bind the broker protocol to a pre-created, service-owned Unix socket. */
function createUnixBrokerListener({ server, socketPath, peerIdentityResolver, maxRequestBytes = 128 * 1024 } = {}) {
  if (!server || typeof server.handle !== "function"
    || typeof socketPath !== "string" || !path.isAbsolute(socketPath)
    || typeof peerIdentityResolver !== "function"
    || !Number.isInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new BrokerError("broker_listener_configuration_invalid", "broker_configuration_invalid");
  }
  const listener = net.createServer((socket) => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    const closeWith = (response) => {
      if (settled) return;
      settled = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };
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
  listener.on("error", () => undefined);
  listener.listen(socketPath);
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
    socket.end(`${JSON.stringify(request)}\n`);
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
    writeReleaseRecord: (_recordPath, line) => call("writeReleaseRecord", { line }),
    runNonMigration: ({ oldSha, newSha }) => call("runNonMigration", { oldSha, newSha }),
    now: () => new Date().toISOString(),
  };
  return Object.freeze({ broker: brokerConfig, operations: Object.freeze(operations) });
}

module.exports = {
  PROTOCOL_VERSION,
  BROKER_STRATEGY,
  BROKER_APPROVAL_SCOPE,
  OPERATION_NAMES,
  BrokerError,
  approvalPayload,
  canonicalize,
  createEd25519ApprovalVerifier,
  createInMemoryTransport,
  createRootfulBrokerOperations,
  createRootfulBrokerServer,
  createUnixBrokerListener,
  createUnixSocketTransport,
  validateApproval,
  validateBrokerConfig,
  validateBrokerRequest,
  validatePayload,
  validatePeerIdentity,
  validateReleaseIdentity,
};
