"use strict";

// Offline-only age custody adapter. It accepts synthetic capture metadata and
// bounded plaintext, then streams that plaintext to an explicitly selected
// local age executable. It has no SSH, Docker, PostgreSQL, deployment, upload,
// retry, key-generation or production-key capability. Cleanup is identity-bound
// where the host exposes stable dev/inode evidence, but Node cannot provide an
// atomic unlink-by-identity primitive on every supported Windows filesystem.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { MAX_CAPTURE_BYTES, SYNTHETIC_SOURCE } = require("./gate1-local-capture-boundary.js");

const MAX_CIPHERTEXT_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const UNVERIFIED = "UNVERIFIED";
const RESTRICTED_UNVERIFIED = "RESTRICTED_UNVERIFIED";
const AGE_RECIPIENT_SYNTAX = /^age1[0-9a-z]{50,}$/;
const AGE_EXECUTABLE_NAMES = new Set(["age", "age.exe"]);

class AgeCustodyFailure extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function reject(status, reason) {
  throw new AgeCustodyFailure(status, reason);
}

function boundedBuffer(value, limit, reason) {
  if (Buffer.isBuffer(value)) {
    if (value.length > limit) reject("INVALID", reason);
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > limit) reject("INVALID", reason);
    return Buffer.from(value, "utf8");
  }
  reject("INVALID", "AGE_INPUT_TYPE_UNSUPPORTED");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0") && value.length <= 4096;
}

function canonicalKey(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(canonicalKey(root), canonicalKey(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function regularDirectory(fsImpl, directoryPath, reason) {
  let stats;
  try {
    stats = fsImpl.lstatSync(directoryPath);
  } catch {
    reject("INCOMPLETE", reason);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) reject("INVALID", "CIPHERTEXT_ROOT_UNSAFE");
  return stats;
}

function inspectDestination(fsImpl, approvedRoot, destination) {
  if (!isAbsolutePath(approvedRoot)) reject("INVALID", "CIPHERTEXT_ROOT_INVALID");
  if (!isAbsolutePath(destination)) reject("INVALID", "CIPHERTEXT_DESTINATION_INVALID");

  const root = path.resolve(approvedRoot);
  const target = path.resolve(destination);
  regularDirectory(fsImpl, root, "CIPHERTEXT_ROOT_UNAVAILABLE");
  let rootCanonical;
  try {
    rootCanonical = fsImpl.realpathSync.native(root);
  } catch {
    reject("INCOMPLETE", "CIPHERTEXT_ROOT_UNAVAILABLE");
  }
  const parent = path.dirname(target);
  regularDirectory(fsImpl, parent, "CIPHERTEXT_PARENT_UNAVAILABLE");
  let parentCanonical;
  try {
    parentCanonical = fsImpl.realpathSync.native(parent);
  } catch {
    reject("INCOMPLETE", "CIPHERTEXT_PARENT_UNAVAILABLE");
  }
  if (!isWithin(rootCanonical, parentCanonical) && canonicalKey(parentCanonical) !== canonicalKey(rootCanonical)) {
    reject("INVALID", "CIPHERTEXT_DESTINATION_OUTSIDE_ROOT");
  }

  let current = parent;
  while (canonicalKey(current) !== canonicalKey(root)) {
    regularDirectory(fsImpl, current, "CIPHERTEXT_PARENT_UNSAFE");
    const next = path.dirname(current);
    if (next === current) reject("INVALID", "CIPHERTEXT_PARENT_UNSAFE");
    current = next;
  }
  try {
    const existing = fsImpl.lstatSync(target);
    if (existing.isSymbolicLink() || !existing.isFile()) reject("INVALID", "CIPHERTEXT_DESTINATION_COLLISION");
    reject("INVALID", "CIPHERTEXT_DESTINATION_EXISTS");
  } catch (error) {
    if (error instanceof AgeCustodyFailure) throw error;
    if (error && error.code !== "ENOENT") reject("INCOMPLETE", "CIPHERTEXT_DESTINATION_UNAVAILABLE");
  }
  return { root, target, rootCanonical, parentCanonical };
}

function validateAgeExecutable(fsImpl, agePath) {
  if (!isAbsolutePath(agePath) || !AGE_EXECUTABLE_NAMES.has(path.basename(agePath).toLowerCase())) {
    reject("INVALID", "AGE_EXECUTABLE_NOT_ALLOWLISTED");
  }
  let stats;
  try {
    stats = fsImpl.lstatSync(agePath);
  } catch {
    reject("INCOMPLETE", "AGE_EXECUTABLE_MISSING");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) reject("INVALID", "AGE_EXECUTABLE_UNSAFE");
}

function fileIdentity(stats) {
  if (!stats || typeof stats.dev !== "number" || typeof stats.ino !== "number" || stats.dev === 0 || stats.ino === 0) return null;
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left, right) {
  if (!left || !right) return null;
  return left.dev === right.dev && left.ino === right.ino;
}

function captureFileIdentity(fsImpl, fd) {
  try {
    return fileIdentity(fsImpl.fstatSync(fd));
  } catch {
    return null;
  }
}

function writeAll(fsImpl, fd, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const written = fsImpl.writeSync(fd, chunk, offset, chunk.length - offset);
    if (!Number.isInteger(written) || written <= 0) reject("INCOMPLETE", "CIPHERTEXT_WRITE_FAILED");
    offset += written;
  }
}

function verifyWrittenCiphertext(fsImpl, fd, expectedBytes, expectedSha256) {
  const stats = fsImpl.fstatSync(fd);
  if (stats.size !== expectedBytes || expectedBytes <= 0 || expectedBytes > MAX_CIPHERTEXT_BYTES) {
    reject("INCOMPLETE", "CIPHERTEXT_SIZE_MISMATCH");
  }
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_CIPHERTEXT_BYTES));
  let readTotal = 0;
  while (readTotal < expectedBytes) {
    const read = fsImpl.readSync(fd, buffer, 0, Math.min(buffer.length, expectedBytes - readTotal), readTotal);
    if (!Number.isInteger(read) || read <= 0) reject("INCOMPLETE", "CIPHERTEXT_READBACK_FAILED");
    hash.update(buffer.subarray(0, read));
    readTotal += read;
  }
  if (readTotal !== expectedBytes || hash.digest("hex") !== expectedSha256) reject("INCOMPLETE", "CIPHERTEXT_HASH_MISMATCH");
}

function cleanupNewFile(fsImpl, target, fd, createdIdentity) {
  let cleanupFailed = false;
  try {
    const descriptorIdentity = fd === undefined ? null : fileIdentity(fsImpl.fstatSync(fd));
    const pathStats = fsImpl.lstatSync(target);
    const pathIdentity = fileIdentity(pathStats);
    const identityMatches = sameIdentity(createdIdentity, descriptorIdentity) === true
      && sameIdentity(createdIdentity, pathIdentity) === true;
    if (pathStats.isSymbolicLink() || !pathStats.isFile() || !identityMatches) {
      cleanupFailed = true;
    } else {
      fsImpl.unlinkSync(target);
    }
  } catch {
    cleanupFailed = true;
  }
  if (fd !== undefined) {
    try { fsImpl.closeSync(fd); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) reject("INCOMPLETE", "CIPHERTEXT_CLEANUP_FAILED");
}

function validateCaptureMetadata(captureMetadata, plaintext) {
  if (!captureMetadata || captureMetadata.source_identity !== SYNTHETIC_SOURCE
    || captureMetadata.boundary !== UNVERIFIED || captureMetadata.provenance !== UNVERIFIED
    || captureMetadata.custody !== UNVERIFIED) {
    reject("INVALID", "CAPTURE_METADATA_UNTRUSTED");
  }
  if (captureMetadata.stdout_bytes !== plaintext.length || captureMetadata.stdout_sha256 !== sha256(plaintext)) {
    reject("INVALID", "CAPTURE_METADATA_MISMATCH");
  }
}

function encryptSyntheticCaptureToFile(options, dependencies = {}) {
  const fsImpl = dependencies.fsImpl ?? fs;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const plaintext = boundedBuffer(options.plaintext, MAX_CAPTURE_BYTES, "PLAINTEXT_TOO_LARGE");
  if (plaintext.length === 0) reject("INCOMPLETE", "PLAINTEXT_EMPTY");
  validateCaptureMetadata(options.captureMetadata, plaintext);
  if (typeof options.recipient !== "string" || !AGE_RECIPIENT_SYNTAX.test(options.recipient)) {
    reject("INVALID", "AGE_RECIPIENT_SYNTAX_INVALID");
  }
  validateAgeExecutable(fsImpl, options.agePath);
  const destination = inspectDestination(fsImpl, options.approvedRoot, options.destination);
  const openFlags = fsImpl.constants.O_RDWR | fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL;
  let fd;
  let created = false;
  let createdIdentity;
  try {
    fd = fsImpl.openSync(destination.target, openFlags, 0o600);
    created = true;
    createdIdentity = captureFileIdentity(fsImpl, fd);
    if (!createdIdentity) reject("INCOMPLETE", "CIPHERTEXT_IDENTITY_UNAVAILABLE");
    if (typeof fsImpl.fchmodSync === "function") fsImpl.fchmodSync(fd, 0o600);
  } catch (error) {
    if (created) cleanupNewFile(fsImpl, destination.target, fd, createdIdentity);
    if (error instanceof AgeCustodyFailure) throw error;
    if (error && error.code === "EEXIST") reject("INVALID", "CIPHERTEXT_DESTINATION_EXISTS");
    reject("INCOMPLETE", "CIPHERTEXT_CREATE_FAILED");
  }

  return new Promise((resolve, rejectPromise) => {
    let child;
    let settled = false;
    let ciphertextBytes = 0;
    let stderrBytes = 0;
    let timer;
    const ciphertextHash = crypto.createHash("sha256");
    const errorListeners = [];
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const retireClosedErrorListeners = () => {
      for (const { emitter, listener, childProcess } of errorListeners) {
        const closed = childProcess
          ? emitter.exitCode !== null || emitter.signalCode !== null
          : emitter.destroyed === true || emitter.closed === true;
        if (closed) emitter.removeListener("error", listener);
      }
    };
    const settleFailure = (status, reason) => {
      if (settled) return;
      settled = true;
      clearTimer();
      try { if (child && typeof child.kill === "function") child.kill(); } catch { /* sanitized failure path */ }
      try { cleanupNewFile(fsImpl, destination.target, fd, createdIdentity); } catch (error) { rejectPromise(error); return; }
      rejectPromise(new AgeCustodyFailure(status, reason));
    };
    try {
      child = spawnProcess(options.agePath, ["--encrypt", "--recipient", options.recipient], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      settleFailure("INCOMPLETE", "AGE_PROCESS_START_FAILED");
      return;
    }
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
    timer = setTimeout(() => settleFailure("INCOMPLETE", "AGE_PROCESS_TIMEOUT"), timeoutMs);
    const finish = (status, reason) => {
      clearTimer();
      retireClosedErrorListeners();
      if (settled) return;
      if (status !== "success") {
        settleFailure("INCOMPLETE", reason);
        return;
      }
      try {
        fsImpl.fsyncSync(fd);
        const pathStats = fsImpl.lstatSync(destination.target);
        const descriptorStats = fsImpl.fstatSync(fd);
        const identity = sameIdentity(pathStats, descriptorStats);
        if (pathStats.isSymbolicLink() || !pathStats.isFile() || identity !== true || identity !== sameIdentity(createdIdentity, fileIdentity(descriptorStats))) {
          reject("INCOMPLETE", "CIPHERTEXT_IDENTITY_CHANGED");
        }
        const expectedHash = ciphertextHash.digest("hex");
        verifyWrittenCiphertext(fsImpl, fd, ciphertextBytes, expectedHash);
        fsImpl.closeSync(fd);
        settled = true;
        resolve(Object.freeze({
          status: "ENCRYPTED_SYNTHETIC_CIPHERTEXT",
          encryption: "AGE_PROCESS_COMPLETED",
          ciphertext_bytes: ciphertextBytes,
          ciphertext_sha256: expectedHash,
          destination: "EXPLICIT_LOCAL_CIPHERTEXT",
          custody: RESTRICTED_UNVERIFIED,
          provenance: UNVERIFIED,
          overwritten: false,
          plaintext_persisted: false,
        }));
      } catch (error) {
        settleFailure("INCOMPLETE", error instanceof AgeCustodyFailure ? error.reason : "CIPHERTEXT_VERIFICATION_FAILED");
      }
    };
    const handleStreamError = () => settleFailure("INCOMPLETE", "AGE_STREAM_ERROR");
    try {
      for (const emitter of [child.stdin, child.stdout, child.stderr]) {
        emitter.on("error", handleStreamError);
        errorListeners.push({ emitter, listener: handleStreamError, childProcess: false });
      }
    } catch {
      settleFailure("INCOMPLETE", "AGE_STREAM_SETUP_FAILED");
      return;
    }
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      if (!Buffer.isBuffer(chunk)) { settleFailure("INCOMPLETE", "AGE_STDOUT_TYPE_INVALID"); return; }
      if (ciphertextBytes + chunk.length > MAX_CIPHERTEXT_BYTES) { settleFailure("INVALID", "CIPHERTEXT_TOO_LARGE"); return; }
      try { writeAll(fsImpl, fd, chunk); ciphertextHash.update(chunk); ciphertextBytes += chunk.length; } catch (error) { settleFailure("INCOMPLETE", error.reason ?? "CIPHERTEXT_WRITE_FAILED"); }
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      if (Buffer.isBuffer(chunk)) stderrBytes += chunk.length;
      if (stderrBytes > MAX_DIAGNOSTIC_BYTES) settleFailure("INCOMPLETE", "AGE_DIAGNOSTIC_TOO_LARGE");
    });
    const handleChildError = () => settleFailure("INCOMPLETE", "AGE_PROCESS_FAILED");
    child.on("error", handleChildError);
    errorListeners.push({ emitter: child, listener: handleChildError, childProcess: true });
    child.once("close", (code, signal) => finish(code === 0 && !signal ? "success" : "failed", signal ? "AGE_PROCESS_INTERRUPTED" : "AGE_PROCESS_FAILED"));
    try { child.stdin.end(plaintext); } catch { settleFailure("INCOMPLETE", "AGE_STDIN_FAILED"); }
  });
}

module.exports = {
  AgeCustodyFailure,
  MAX_CIPHERTEXT_BYTES,
  MAX_DIAGNOSTIC_BYTES,
  RESTRICTED_UNVERIFIED,
  encryptSyntheticCaptureToFile,
  inspectDestination,
};
