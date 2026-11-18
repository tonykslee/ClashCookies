"use strict";

// Offline-only capture boundary. This module deliberately has no filesystem,
// network, child-process, SSH, Docker or PostgreSQL capability. A future live
// adapter must be separately reviewed and must supply these metadata claims
// from trusted transport/host/authorization sources rather than from JSON.
const crypto = require("node:crypto");
const validator = require("./gate1-prerequisite-validator.js");

const CAPTURE_PACKET_VERSION = validator.PACKET_VERSION;
const MAX_CAPTURE_BYTES = validator.MAX_TOTAL_BYTES;
const COMPLETE = "COMPLETE";
const FAILURE_STATUSES = new Set(["INTERRUPTED", "TIMEOUT", "TRUNCATED", "FAILED"]);
const UNVERIFIED = "UNVERIFIED";
const SYNTHETIC_SOURCE = "SYNTHETIC_LOCAL_FIXTURE";
const SAFE_AGE_RECIPIENT = /^age1[0-9a-z]{50,}$/;

class CaptureBoundaryFailure extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function reject(status, reason) {
  throw new CaptureBoundaryFailure(status, reason);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  reject("INVALID", "CAPTURE_OUTPUT_NOT_BYTES");
}

function hexDigest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function requireText(value, reason) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) reject("INVALID", reason);
  return value;
}

function assertNoForgedTrust(value, reason) {
  if (value !== UNVERIFIED && value !== "EXTERNAL_REVIEW_REQUIRED") reject("INVALID", reason);
}

function createCaptureMetadata(options) {
  const bytes = asBuffer(options.stdout);
  const stderr = asBuffer(options.stderr ?? Buffer.alloc(0));
  const status = options.streamStatus;
  requireText(options.captureAttemptId, "CAPTURE_ATTEMPT_ID_INVALID");
  requireText(options.sourceIdentity, "SOURCE_IDENTITY_MISSING");
  requireText(options.assertedIdentity, "ASSERTED_IDENTITY_MISSING");
  requireText(options.packetVersion, "PACKET_VERSION_MISSING");
  if (options.packetVersion !== CAPTURE_PACKET_VERSION) reject("INVALID", "PACKET_VERSION_CHANGED");
  if (options.sourceIdentity !== SYNTHETIC_SOURCE) reject("INVALID", "SOURCE_IDENTITY_UNTRUSTED");
  assertNoForgedTrust(options.hostKeyBinding, "FORGED_HOST_KEY_BINDING");
  assertNoForgedTrust(options.authorizationScope, "FORGED_AUTHORIZATION");
  if (!FAILURE_STATUSES.has(status) && status !== COMPLETE) reject("INVALID", "STREAM_STATUS_INVALID");
  if (bytes.length > MAX_CAPTURE_BYTES) reject("INVALID", "CAPTURE_OUTPUT_TOO_LARGE");
  if (stderr.length > MAX_CAPTURE_BYTES) reject("INVALID", "CAPTURE_STDERR_TOO_LARGE");

  const actualSha256 = hexDigest(bytes);
  const actualBytes = bytes.length;
  const actualStderrBytes = stderr.length;
  if (options.declaredStdoutBytes !== undefined && options.declaredStdoutBytes !== actualBytes) {
    reject("INVALID", "CAPTURE_BYTE_COUNT_MISMATCH");
  }
  if (options.declaredStdoutSha256 !== undefined && options.declaredStdoutSha256 !== actualSha256) {
    reject("INVALID", "CAPTURE_SHA256_MISMATCH");
  }
  const actualStderrSha256 = hexDigest(stderr);
  if (options.declaredStderrBytes !== undefined && options.declaredStderrBytes !== actualStderrBytes) {
    reject("INVALID", "CAPTURE_STDERR_BYTE_COUNT_MISMATCH");
  }
  if (options.declaredStderrSha256 !== undefined && options.declaredStderrSha256 !== actualStderrSha256) {
    reject("INVALID", "CAPTURE_STDERR_SHA256_MISMATCH");
  }
  if (options.sshExitStatus !== 0) reject("INCOMPLETE", "REMOTE_EXIT_NONZERO");
  if (status !== COMPLETE || options.eofObserved !== true) reject("INCOMPLETE", "CAPTURE_NOT_COMPLETE");
  if (actualBytes === 0) reject("INCOMPLETE", "CAPTURE_OUTPUT_EMPTY");

  return Object.freeze({
    capture_attempt_id: options.captureAttemptId,
    packet_version: options.packetVersion,
    source_identity: options.sourceIdentity,
    asserted_identity: options.assertedIdentity,
    ssh_exit_status: options.sshExitStatus,
    stream_status: status,
    eof_observed: true,
    stdout_bytes: actualBytes,
    stdout_sha256: actualSha256,
    stderr_bytes: actualStderrBytes,
    stderr_sha256: actualStderrSha256,
    boundary: UNVERIFIED,
    provenance: UNVERIFIED,
    custody: "UNVERIFIED",
  });
}

function validateCaptureEnvelope(options) {
  const bytes = asBuffer(options.stdout);
  const metadata = createCaptureMetadata({ ...options, stdout: bytes });
  const envelope = options.envelope;
  if (!envelope || typeof envelope !== "object") reject("INVALID", "ENVELOPE_MISSING");
  const result = validator.validateEnvelope(envelope);
  if (result.status !== "VALID") reject(result.status, `STRUCTURAL_${result.reason}`);
  if (envelope.packet_version !== metadata.packet_version || envelope.stdout !== bytes.toString("utf8")) {
    reject("INVALID", "ENVELOPE_CAPTURE_MISMATCH");
  }
  return Object.freeze({ status: "VALID", metadata, structural: result });
}

class CaptureLedger {
  constructor() {
    this.attempts = new Set();
    this.destinations = new Set();
  }

  reserve(attemptId, destinationId) {
    requireText(attemptId, "CAPTURE_ATTEMPT_ID_INVALID");
    requireText(destinationId, "DESTINATION_ID_INVALID");
    if (this.attempts.has(attemptId)) reject("INVALID", "DUPLICATE_CAPTURE_ATTEMPT");
    if (this.destinations.has(destinationId)) reject("INVALID", "DESTINATION_COLLISION");
    this.attempts.add(attemptId);
    this.destinations.add(destinationId);
    return Object.freeze({ attemptId, destinationId, reserved: true });
  }
}

function validateCiphertextDestination(destination) {
  if (!destination || destination.approved !== true || destination.exclusive !== true || destination.plaintext !== false) {
    reject("INVALID", "CIPHERTEXT_DESTINATION_UNSAFE");
  }
  if (destination.reparse === true || destination.regular !== true || destination.accessible !== true) {
    reject("INVALID", "CIPHERTEXT_DESTINATION_UNSAFE");
  }
  return Object.freeze({ status: "READY_FOR_SEPARATE_CUSTODY_AUTHORIZATION", custody: "UNVERIFIED" });
}

function encryptSyntheticInMemory({ plaintext, recipient, encryptor }) {
  const bytes = asBuffer(plaintext);
  if (typeof recipient !== "string" || !SAFE_AGE_RECIPIENT.test(recipient)) reject("INVALID", "ENCRYPTION_RECIPIENT_INVALID");
  if (typeof encryptor !== "function") reject("INVALID", "ENCRYPTION_IMPLEMENTATION_MISSING");
  let ciphertext;
  try {
    ciphertext = encryptor(Buffer.from(bytes), recipient);
  } catch {
    reject("INCOMPLETE", "ENCRYPTION_FAILED");
  }
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) reject("INCOMPLETE", "ENCRYPTION_FAILED");
  return Object.freeze({
    ciphertext: Buffer.from(ciphertext),
    ciphertext_bytes: ciphertext.length,
    ciphertext_sha256: hexDigest(ciphertext),
    plaintext_persisted: false,
    custody: "UNVERIFIED",
  });
}

module.exports = {
  CAPTURE_PACKET_VERSION,
  CaptureBoundaryFailure,
  CaptureLedger,
  COMPLETE,
  MAX_CAPTURE_BYTES,
  SYNTHETIC_SOURCE,
  createCaptureMetadata,
  encryptSyntheticInMemory,
  validateCaptureEnvelope,
  validateCiphertextDestination,
};
