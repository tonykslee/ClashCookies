"use strict";

// Offline-only validator for the fixed Gate 1 prerequisite summaries. This
// module never starts a process, connects remotely, or writes evidence.
const crypto = require("node:crypto");
const fs = require("node:fs");

const SCHEMA_VERSION = "clashcookies-gate1-prerequisite-v1";
const PACKET_VERSION = "2026-11-17";
const TARGET_ALIAS = "clash-vm";
const REMOTE_ACCOUNT = "tilo";
const MAX_LINE_BYTES = 1024;
const MAX_TOTAL_BYTES = 8192;

// These are the reviewed PR #2027 source-artifact values named by the
// inspection packet. They bind the envelope to a known preparation contract;
// they do not establish the identity of the machine that produced stdout.
const APPROVED_ARTIFACT_SHA256 = Object.freeze({
  archive: "8138275d0f18451ea02955357c3f2e7c22c729175c575033aae64bff7dc81015",
  adapter: "379490aa007ecf6d036d5ef95e6b5ed07c5d4fdf726904bbd152ee1486032666",
  collector: "bb56d8e4ff9cd8d7d2652ef6fb3fbc6dd07e98ca3b0d65252c8a7a2ec9626da9",
  validator: "e2fbc31275003aa631aa16b984e6d2a8eaabef57646b377b82e02d27a20e27d6",
});

const ARTIFACTS = ["archive", "adapter", "collector", "validator"];
const CANDIDATES = [
  "outer_lock",
  "migration_lock",
  "executor_candidate",
  "credential_candidate",
  "release_record_candidate",
  "env_candidate",
  "candidate_worktree",
];

const TOP_LEVEL_FIELDS = [
  "schema_version",
  "packet_version",
  "target",
  "account",
  "expected_artifact_sha256",
  "capture",
  "provenance",
  "stdout",
];
const CAPTURE_FIELDS = [
  "ssh_exit_status",
  "stream_status",
  "eof_observed",
  "stdout_sha256",
  "stdout_bytes",
];
const PROVENANCE_FIELDS = [
  "captured_at",
  "host_key_binding",
  "authorization_scope",
  "source",
];

class ValidationFailure extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function invalid(reason) {
  throw new ValidationFailure("INVALID", reason);
}

function incomplete(reason) {
  throw new ValidationFailure("INCOMPLETE", reason);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, reason) {
  if (!isPlainObject(value)) invalid(reason);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) invalid(reason);
}

function requireDecimal(value, reason) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid(reason);
  return value;
}

function requireSha256(value, reason) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid(reason);
  return value;
}

function requireSha1(value, reason) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) invalid(reason);
  return value;
}

function requireMode(value, reason) {
  if (typeof value !== "string" || !/^[0-7]{3,4}$/.test(value)) invalid(reason);
  return value;
}

function hasForbiddenControlCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}

function field(line, prefix, reason) {
  if (!line.startsWith(prefix)) invalid(reason);
  return line.slice(prefix.length);
}

function splitRecord(line, expectedName, reason) {
  const parts = line.split("|");
  if (parts[0] !== expectedName) invalid(reason);
  return parts;
}

function parseMetadata(parts, offset, hashRequired, reason) {
  const type = parts[offset];
  if (type !== "regular file" && (!hashRequired && type !== "directory")) invalid(reason);
  const uid = parts[offset + 1];
  const gid = parts[offset + 2];
  const mode = parts[offset + 3];
  const size = parts[offset + 4];
  requireDecimal(uid, reason);
  requireDecimal(gid, reason);
  requireMode(mode, reason);
  requireDecimal(size, reason);
  if (hashRequired) {
    const hash = field(parts[offset + 5], "sha256=", reason);
    requireSha256(hash, reason);
    return { type, uid, gid, mode, size, hash };
  }
  return { type, uid, gid, mode, size };
}

function parseArtifact(line, name) {
  const parts = splitRecord(line, name, "ARTIFACT_RECORD_INVALID");
  if (parts.length === 2 && (parts[1] === "ABSENT" || parts[1] === "SYMLINK")) {
    return { state: parts[1] };
  }
  if (parts.length !== 7) invalid("ARTIFACT_RECORD_INVALID");
  const metadata = parseMetadata(parts, 1, true, "ARTIFACT_METADATA_INVALID");
  if (metadata.hash !== APPROVED_ARTIFACT_SHA256[name]) invalid("ARTIFACT_DIGEST_MISMATCH");
  return { state: "PRESENT", metadata };
}

function parseIdentity(line) {
  const parts = splitRecord(line, "identity", "IDENTITY_RECORD_INVALID");
  if (parts.length !== 4) invalid("IDENTITY_RECORD_INVALID");
  requireDecimal(field(parts[1], "uid=", "IDENTITY_RECORD_INVALID"), "IDENTITY_UID_INVALID");
  requireDecimal(field(parts[2], "gid=", "IDENTITY_RECORD_INVALID"), "IDENTITY_GID_INVALID");
  requireDecimal(field(parts[3], "group_count=", "IDENTITY_GROUP_COUNT_INVALID"), "IDENTITY_GROUP_COUNT_INVALID");
}

function parseWrapper(lines, index) {
  const parts = splitRecord(lines[index], "wrapper", "WRAPPER_RECORD_INVALID");
  if (parts.length === 2 && (parts[1] === "MISSING" || parts[1] === "SYMLINK")) {
    return { next: index + 1, state: parts[1] };
  }
  if (parts.length !== 7) invalid("WRAPPER_METADATA_INVALID");
  const metadataType = field(parts[1], "metadata=", "WRAPPER_METADATA_INVALID");
  if (metadataType !== "regular file") invalid("WRAPPER_METADATA_INVALID");
  const metadata = parseMetadata([parts[0], metadataType, ...parts.slice(2)], 1, true, "WRAPPER_METADATA_INVALID");
  const syntax = lines[index + 1];
  const control = lines[index + 2];
  if (syntax !== "wrapper|syntax=PASS") invalid("WRAPPER_SYNTAX_NOT_PASS");
  if (control !== "wrapper|control_flow=DEFERRED_TO_REDACTED_COLLECTOR") invalid("WRAPPER_CONTROL_FLOW_INVALID");
  return { next: index + 3, state: "PRESENT", metadata };
}

function parseCheckout(lines, index) {
  const head = splitRecord(lines[index], "checkout", "CHECKOUT_RECORD_INVALID");
  if (head.length !== 2) invalid("CHECKOUT_HEAD_INVALID");
  requireSha1(field(head[1], "head=", "CHECKOUT_HEAD_INVALID"), "CHECKOUT_HEAD_INVALID");

  const branch = splitRecord(lines[index + 1], "checkout", "CHECKOUT_BRANCH_INVALID");
  if (branch.length !== 2 || !/^branch=(ATTACHED|DETACHED|UNKNOWN)$/.test(branch[1])) invalid("CHECKOUT_BRANCH_INVALID");

  const clean = splitRecord(lines[index + 2], "checkout", "CHECKOUT_CLEANLINESS_INVALID");
  if (clean.length !== 2 || !/^tracked_clean=(CLEAN|CHANGED|UNKNOWN)$/.test(clean[1])) invalid("CHECKOUT_CLEANLINESS_INVALID");

  const count = splitRecord(lines[index + 3], "checkout", "CHECKOUT_COUNT_INVALID");
  requireDecimal(field(count[1], "untracked_count=", "CHECKOUT_COUNT_INVALID"), "CHECKOUT_COUNT_INVALID");

  const digest = splitRecord(lines[index + 4], "checkout", "CHECKOUT_DIGEST_INVALID");
  if (digest.length !== 2) invalid("CHECKOUT_DIGEST_INVALID");
  requireSha256(field(digest[1], "untracked_inventory_sha256=", "CHECKOUT_DIGEST_INVALID"), "CHECKOUT_DIGEST_INVALID");
  return {
    next: index + 5,
    branch: branch[1].slice("branch=".length),
    clean: clean[1].slice("tracked_clean=".length),
  };
}

function parseCandidate(line, name) {
  const parts = splitRecord(line, name, "CANDIDATE_RECORD_INVALID");
  if (parts.length === 2 && (parts[1] === "ABSENT" || parts[1] === "SYMLINK")) return { state: parts[1] };
  if (parts.length !== 7 || parts[1] !== "PRESENT") invalid("CANDIDATE_RECORD_INVALID");
  return { state: "PRESENT", metadata: parseMetadata(parts, 2, false, "CANDIDATE_METADATA_INVALID") };
}

function validateStdout(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) invalid("STDOUT_MISSING");
  const bytes = Buffer.byteLength(stdout, "utf8");
  if (bytes > MAX_TOTAL_BYTES) invalid("TOTAL_OUTPUT_TOO_LARGE");
  if (!stdout.endsWith("\n")) incomplete("TRUNCATED_STREAM");
  if (stdout.includes("\r")) invalid("CONTROL_CHARACTER");
  if (/(DATABASE_URL|PASSWORD=|TOKEN=|postgres(?:ql)?:\/\/|PRIVATE KEY|BEGIN [^-]*PRIVATE KEY)/i.test(stdout)) {
    invalid("SENSITIVE_OR_UNEXPECTED_OUTPUT");
  }

  const lines = stdout.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) invalid("BLANK_RECORD");
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) invalid("LINE_TOO_LARGE");
    if (hasForbiddenControlCharacter(line)) invalid("CONTROL_CHARACTER");
    if (line.startsWith("STOP|")) incomplete("STOP_NOT_PASS");
  }

  let index = 0;
  parseIdentity(lines[index++]);
  const artifacts = {};
  for (const name of ARTIFACTS) artifacts[name] = parseArtifact(lines[index++], name);
  const wrapper = parseWrapper(lines, index);
  index = wrapper.next;
  const checkout = parseCheckout(lines, index);
  index = checkout.next;
  const candidates = {};
  for (const name of CANDIDATES) candidates[name] = parseCandidate(lines[index++], name);
  if (index !== lines.length) invalid("EXTRA_OR_TRAILING_OUTPUT");
  return { recordCount: lines.length, artifacts, wrapper, checkout, candidates };
}

function validateEnvelope(envelope) {
  try {
    exactKeys(envelope, TOP_LEVEL_FIELDS, "ENVELOPE_FIELDS_INVALID");
    if (envelope.schema_version !== SCHEMA_VERSION) invalid("UNSUPPORTED_SCHEMA_VERSION");
    if (envelope.packet_version !== PACKET_VERSION) invalid("UNSUPPORTED_PACKET_VERSION");
    if (envelope.target !== TARGET_ALIAS || envelope.account !== REMOTE_ACCOUNT) invalid("HOST_IDENTITY_MISMATCH");

    exactKeys(envelope.expected_artifact_sha256, ARTIFACTS, "EXPECTED_ARTIFACT_FIELDS_INVALID");
    for (const name of ARTIFACTS) {
      if (envelope.expected_artifact_sha256[name] !== APPROVED_ARTIFACT_SHA256[name]) invalid("ARTIFACT_DIGEST_MISMATCH");
    }

    exactKeys(envelope.capture, CAPTURE_FIELDS, "CAPTURE_FIELDS_INVALID");
    if (!Number.isInteger(envelope.capture.ssh_exit_status)) invalid("SSH_EXIT_STATUS_INVALID");
    if (envelope.capture.ssh_exit_status !== 0) incomplete("SSH_NONZERO_EXIT");
    if (envelope.capture.stream_status !== "COMPLETE") incomplete("STREAM_NOT_COMPLETE");
    if (envelope.capture.eof_observed !== true) incomplete("EOF_NOT_OBSERVED");
    requireSha256(envelope.capture.stdout_sha256, "ORIGINAL_SHA256_INVALID");
    if (typeof envelope.capture.stdout_bytes !== "number" || !Number.isSafeInteger(envelope.capture.stdout_bytes)) {
      invalid("CAPTURE_BYTE_COUNT_INVALID");
    }

    exactKeys(envelope.provenance, PROVENANCE_FIELDS, "PROVENANCE_FIELDS_INVALID");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(envelope.provenance.captured_at)) {
      invalid("PROVENANCE_TIMESTAMP_INVALID");
    }
    if (envelope.provenance.host_key_binding !== "EXTERNAL_REVIEW_REQUIRED" ||
        envelope.provenance.authorization_scope !== "EXTERNAL_REVIEW_REQUIRED" ||
        envelope.provenance.source !== "EXTERNAL_LOCAL_CAPTURE_WRAPPER") {
      incomplete("PROVENANCE_REVIEW_REQUIRED");
    }

    const parsed = validateStdout(envelope.stdout);
    const stdoutBytes = Buffer.byteLength(envelope.stdout, "utf8");
    const stdoutSha256 = crypto.createHash("sha256").update(envelope.stdout, "utf8").digest("hex");
    if (envelope.capture.stdout_bytes !== stdoutBytes) invalid("CAPTURE_BYTE_COUNT_MISMATCH");
    if (envelope.capture.stdout_sha256 !== stdoutSha256) invalid("ORIGINAL_SHA256_MISMATCH");

    const unresolved = [
      ...Object.values(parsed.artifacts),
      parsed.wrapper,
      parsed.checkout,
      ...Object.values(parsed.candidates),
    ].some((entry) => entry.state === "ABSENT" || entry.state === "SYMLINK" || entry.state === "MISSING" ||
      entry.branch === "UNKNOWN" || entry.clean === "UNKNOWN" || entry.clean === "CHANGED");

    return {
      status: "VALID",
      reason: unresolved ? "UNKNOWN_OR_UNRESOLVED" : "STRUCTURALLY_VALID",
      recordCount: parsed.recordCount,
      schemaVersion: SCHEMA_VERSION,
      reviewRequired: true,
      provenance: "UNVERIFIED",
    };
  } catch (error) {
    if (error instanceof ValidationFailure) {
      return {
        status: error.status,
        reason: error.reason,
        recordCount: 0,
        schemaVersion: SCHEMA_VERSION,
        reviewRequired: true,
        provenance: "UNVERIFIED",
      };
    }
    return {
      status: "INVALID",
      reason: "INPUT_NOT_VALID_JSON",
      recordCount: 0,
      schemaVersion: SCHEMA_VERSION,
      reviewRequired: true,
      provenance: "UNVERIFIED",
    };
  }
}

function formatResult(result) {
  return [
    result.status,
    `schema=${result.schemaVersion}`,
    `records=${result.recordCount}`,
    `reason=${result.reason}`,
    `review=${result.reviewRequired ? "REQUIRED" : "NOT_REQUIRED"}`,
    `provenance=${result.provenance}`,
  ].join("|") + "\n";
}

function readExplicitInput(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--input" || !argv[1] || argv[1] === "-") {
    throw new Error("INPUT_ARGUMENT_INVALID");
  }
  return fs.readFileSync(argv[1], "utf8");
}

if (require.main === module) {
  let result;
  try {
    const raw = readExplicitInput(process.argv.slice(2));
    result = validateEnvelope(JSON.parse(raw));
  } catch (error) {
    result = {
      status: "INCOMPLETE",
      reason: error && error.message === "INPUT_ARGUMENT_INVALID" ? "INPUT_ARGUMENT_INVALID" : "INPUT_UNREADABLE",
      recordCount: 0,
      schemaVersion: SCHEMA_VERSION,
      reviewRequired: true,
      provenance: "UNVERIFIED",
    };
  }
  process.stdout.write(formatResult(result));
  process.exitCode = result.status === "VALID" ? 0 : result.status === "INCOMPLETE" ? 3 : 2;
}

module.exports = {
  APPROVED_ARTIFACT_SHA256,
  CANDIDATES,
  MAX_LINE_BYTES,
  MAX_TOTAL_BYTES,
  PACKET_VERSION,
  SCHEMA_VERSION,
  validateEnvelope,
  formatResult,
};
