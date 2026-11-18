import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const validator = require("../ops/deploy/discovery/gate1-prerequisite-validator.js") as typeof import("../ops/deploy/discovery/gate1-prerequisite-validator.js");
const boundary = require("../ops/deploy/discovery/gate1-local-capture-boundary.js") as typeof import("../ops/deploy/discovery/gate1-local-capture-boundary.js");

const emptyInventorySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const wrapperSha = "f".repeat(64);
const headSha = "b".repeat(40);
const validRecipient = "age15gwzpsek379vh09r9qylc2td3rzglls9hctum063p8qkqmxhagqqmtee3g";

function records() {
  const artifact = (name: string, hash = validator.APPROVED_ARTIFACT_SHA256[name as keyof typeof validator.APPROVED_ARTIFACT_SHA256]) => `${name}|regular file|1000|1000|664|42|sha256=${hash}`;
  const candidate = (name: string) => `${name}|PRESENT|regular file|1000|1000|640|0`;
  return [
    "identity|uid=1000|gid=1000|group_count=4",
    ...["archive", "adapter", "collector", "validator"].map((name) => artifact(name)),
    `wrapper|metadata=regular file|1001|1001|755|7348|sha256=${wrapperSha}`,
    "wrapper|syntax=PASS",
    "wrapper|control_flow=DEFERRED_TO_REDACTED_COLLECTOR",
    `checkout|head=${headSha}`,
    "checkout|branch=ATTACHED",
    "checkout|tracked_clean=CLEAN",
    "checkout|untracked_count=0",
    `checkout|untracked_inventory_sha256=${emptyInventorySha}`,
    ...validator.CANDIDATES.map((name: string) => candidate(name)),
  ];
}

function stdout(extra = "") {
  return `${records().join("\n")}\n${extra}`;
}

function envelopeFor(value: string, overrides: Record<string, unknown> = {}) {
  const capture = {
    ssh_exit_status: 0,
    stream_status: "COMPLETE",
    eof_observed: true,
    stdout_sha256: createHash("sha256").update(value).digest("hex"),
    stdout_bytes: Buffer.byteLength(value),
  };
  return {
    schema_version: validator.SCHEMA_VERSION,
    packet_version: validator.PACKET_VERSION,
    target: "clash-vm",
    account: "tilo",
    expected_artifact_sha256: { ...validator.APPROVED_ARTIFACT_SHA256 },
    capture: { ...capture, ...((overrides.capture ?? {}) as object) },
    provenance: {
      captured_at: "2026-11-18T01:02:03.000Z",
      host_key_binding: "EXTERNAL_REVIEW_REQUIRED",
      authorization_scope: "EXTERNAL_REVIEW_REQUIRED",
      source: "EXTERNAL_LOCAL_CAPTURE_WRAPPER",
      ...((overrides.provenance ?? {}) as object),
    },
    stdout: value,
    ...overrides,
  };
}

function options(value = stdout(), overrides: Record<string, unknown> = {}) {
  return {
    captureAttemptId: "synthetic-attempt-1",
    packetVersion: validator.PACKET_VERSION,
    sourceIdentity: boundary.SYNTHETIC_SOURCE,
    assertedIdentity: "clash-vm/tilo",
    hostKeyBinding: "EXTERNAL_REVIEW_REQUIRED",
    authorizationScope: "EXTERNAL_REVIEW_REQUIRED",
    sshExitStatus: 0,
    streamStatus: boundary.COMPLETE,
    eofObserved: true,
    stderr: "",
    declaredStdoutBytes: Buffer.byteLength(value),
    declaredStdoutSha256: createHash("sha256").update(value).digest("hex"),
    declaredStderrBytes: 0,
    declaredStderrSha256: createHash("sha256").update("").digest("hex"),
    stdout: value,
    envelope: envelopeFor(value),
    ...overrides,
  };
}

describe("Gate 1 local capture/provenance boundary", () => {
  it("accepts complete bounded output and delegates structural validation", () => {
    const result = boundary.validateCaptureEnvelope(options());
    expect(result.status).toBe("VALID");
    expect(result.metadata.boundary).toBe("UNVERIFIED");
    expect(result.metadata.provenance).toBe("UNVERIFIED");
  });

  it("rejects empty output", () => {
    expect(() => boundary.createCaptureMetadata(options(""))).toThrow("CAPTURE_OUTPUT_EMPTY");
  });

  it("accepts the maximum permitted capture size", () => {
    const value = Buffer.alloc(boundary.MAX_CAPTURE_BYTES, 120);
    const result = boundary.createCaptureMetadata(options(value));
    expect(result.stdout_bytes).toBe(boundary.MAX_CAPTURE_BYTES);
  });

  it("accepts the maximum permitted stdout string", () => {
    const value = "x".repeat(boundary.MAX_CAPTURE_BYTES);
    expect(boundary.createCaptureMetadata(options(value)).stdout_bytes).toBe(boundary.MAX_CAPTURE_BYTES);
  });

  it("rejects one byte over the capture limit", () => {
    expect(() => boundary.createCaptureMetadata(options(Buffer.alloc(boundary.MAX_CAPTURE_BYTES + 1)))).toThrow("CAPTURE_OUTPUT_TOO_LARGE");
  });

  it("rejects one byte over the stderr limit", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { stderr: "e".repeat(boundary.MAX_CAPTURE_BYTES + 1) }))).toThrow("CAPTURE_STDERR_TOO_LARGE");
  });

  it("rejects unsupported input types without conversion", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { stdout: 42 }))).toThrow("CAPTURE_INPUT_TYPE_UNSUPPORTED");
  });

  it("records the actual SHA-256 and byte count", () => {
    const value = stdout();
    const result = boundary.createCaptureMetadata(options(value));
    expect(result.stdout_bytes).toBe(Buffer.byteLength(value));
    expect(result.stdout_sha256).toBe(createHash("sha256").update(value).digest("hex"));
    expect(result.stderr_bytes).toBe(0);
    expect(result.stderr_sha256).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("rejects a SHA-256 mismatch", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { declaredStdoutSha256: "0".repeat(64) }))).toThrow("CAPTURE_SHA256_MISMATCH");
  });

  it("rejects a byte-count mismatch", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { declaredStdoutBytes: 1 }))).toThrow("CAPTURE_BYTE_COUNT_MISMATCH");
  });

  it("rejects an oversized Buffer before copying it", () => {
    const value = Buffer.alloc(boundary.MAX_CAPTURE_BYTES + 1);
    expect(() => boundary.createCaptureMetadata(options(value))).toThrow("CAPTURE_OUTPUT_TOO_LARGE");
  });

  it("rejects an oversized string before converting it", () => {
    const value = "x".repeat(boundary.MAX_CAPTURE_BYTES + 1);
    expect(() => boundary.createCaptureMetadata(options(value))).toThrow("CAPTURE_OUTPUT_TOO_LARGE");
  });

  it("rejects a stderr byte-count mismatch without exposing stderr", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { stderr: "diagnostic", declaredStderrBytes: 1 }))).toThrow("CAPTURE_STDERR_BYTE_COUNT_MISMATCH");
  });

  it("classifies nonzero remote exit as incomplete", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { sshExitStatus: 1 }))).toThrow("REMOTE_EXIT_NONZERO");
  });

  it.each(["INTERRUPTED", "TIMEOUT", "TRUNCATED"])("classifies %s as incomplete", (streamStatus) => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { streamStatus, eofObserved: false }))).toThrow("CAPTURE_NOT_COMPLETE");
  });

  it("rejects unexpected trailing records through the existing validator", () => {
    expect(() => boundary.validateCaptureEnvelope(options(stdout("unexpected|record\n")))).toThrow("STRUCTURAL_EXTRA_OR_TRAILING_OUTPUT");
  });

  it("rejects malformed provenance", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { hostKeyBinding: "" }))).toThrow("FORGED_HOST_KEY_BINDING");
  });

  it("rejects caller-forged VERIFIED metadata", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { authorizationScope: "AUTHORIZED" }))).toThrow("FORGED_AUTHORIZATION");
  });

  it("rejects missing authorization evidence", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { authorizationScope: undefined }))).toThrow("FORGED_AUTHORIZATION");
  });

  it("keeps source identity separate from asserted identity", () => {
    const result = boundary.createCaptureMetadata(options(stdout(), { assertedIdentity: "operator-asserted-host" }));
    expect(result.source_identity).toBe(boundary.SYNTHETIC_SOURCE);
    expect(result.asserted_identity).toBe("operator-asserted-host");
  });

  it("rejects incorrect host binding", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { hostKeyBinding: "wrong-host" }))).toThrow("FORGED_HOST_KEY_BINDING");
  });

  it("rejects a changed packet version", () => {
    expect(() => boundary.createCaptureMetadata(options(stdout(), { packetVersion: "2026-11-18" }))).toThrow("PACKET_VERSION_CHANGED");
  });

  it("rejects duplicate capture attempts and destination collisions", () => {
    const ledger = new boundary.CaptureLedger();
    ledger.reserve("attempt-1", "destination-1");
    expect(() => ledger.reserve("attempt-1", "destination-2")).toThrow("DUPLICATE_CAPTURE_ATTEMPT");
    expect(() => ledger.reserve("attempt-2", "destination-1")).toThrow("DESTINATION_COLLISION");
  });

  it("rejects unsafe existing destinations", () => {
    expect(() => boundary.validateCiphertextDestination({ approved: true, exclusive: false, plaintext: false, regular: true, accessible: true, reparse: false })).toThrow("CIPHERTEXT_DESTINATION_UNSAFE");
    expect(() => boundary.validateCiphertextDestination({ approved: true, exclusive: true, plaintext: false, regular: true, accessible: false, reparse: false })).toThrow("CIPHERTEXT_DESTINATION_UNSAFE");
  });

  it("rejects symlink or reparse destinations", () => {
    expect(() => boundary.validateCiphertextDestination({ approved: true, exclusive: true, plaintext: false, regular: true, accessible: true, reparse: true })).toThrow("CIPHERTEXT_DESTINATION_UNSAFE");
  });

  it("rejects invalid encryption recipients", () => {
    expect(() => boundary.encryptSyntheticInMemory({ plaintext: "fixture", recipient: "not-a-recipient", encryptor: () => Buffer.from("mock-output") })).toThrow("ENCRYPTION_RECIPIENT_SYNTAX_INVALID");
  });

  it("accepts maximum synthetic plaintext but never treats it as encrypted evidence", () => {
    const result = boundary.encryptSyntheticInMemory({ plaintext: Buffer.alloc(boundary.MAX_CAPTURE_BYTES, 1), recipient: validRecipient, encryptor: () => Buffer.from("mock-output") });
    expect(result.status).toBe("SYNTHETIC_UNTRUSTED");
    expect(result.encryption_verified).toBe(false);
  });

  it("rejects oversized synthetic plaintext before invoking the encryptor", () => {
    let invoked = false;
    expect(() => boundary.encryptSyntheticInMemory({ plaintext: Buffer.alloc(boundary.MAX_CAPTURE_BYTES + 1), recipient: validRecipient, encryptor: () => { invoked = true; return Buffer.from("mock-output"); } })).toThrow("ENCRYPTION_PLAINTEXT_TOO_LARGE");
    expect(invoked).toBe(false);
  });

  it("rejects oversized injected encryptor output before copying it", () => {
    expect(() => boundary.encryptSyntheticInMemory({ plaintext: "fixture", recipient: validRecipient, encryptor: () => Buffer.alloc(boundary.MAX_CAPTURE_BYTES + 1) })).toThrow("ENCRYPTION_OUTPUT_TOO_LARGE");
  });

  it("rejects invalid or empty encryptor output", () => {
    expect(() => boundary.encryptSyntheticInMemory({ plaintext: "fixture", recipient: validRecipient, encryptor: () => "not-a-buffer" })).toThrow("ENCRYPTION_OUTPUT_TYPE_INVALID");
    expect(() => boundary.encryptSyntheticInMemory({ plaintext: "fixture", recipient: validRecipient, encryptor: () => Buffer.alloc(0) })).toThrow("ENCRYPTION_OUTPUT_EMPTY");
  });

  it("classifies encryption failure without exposing plaintext", () => {
    expect(() => boundary.encryptSyntheticInMemory({ plaintext: "synthetic-secret", recipient: validRecipient, encryptor: () => { throw new Error("private failure"); } })).toThrow("ENCRYPTION_FAILED");
  });

  it("quarantines visible plaintext in synthetic mock output", () => {
    const result = boundary.encryptSyntheticInMemory({ plaintext: Buffer.from("synthetic evidence"), recipient: validRecipient, encryptor: (input: Buffer) => Buffer.concat([Buffer.from("age:"), input]) });
    expect(result.status).toBe("SYNTHETIC_UNTRUSTED");
    expect(result.output_kind).toBe("MOCK_ENCRYPTOR_OUTPUT");
    expect(result.encryption_verified).toBe(false);
    expect(result.confidentiality_verified).toBe(false);
    expect(result.plaintext_persisted).toBe(false);
    expect(result.mock_output.toString()).toBe("age:synthetic evidence");
  });

  it("rejects an identity/pass-through mock", () => {
    expect(() => boundary.encryptSyntheticInMemory({ plaintext: Buffer.from("synthetic evidence"), recipient: validRecipient, encryptor: (input: Buffer) => input })).toThrow("ENCRYPTION_OUTPUT_PASSTHROUGH");
  });

  it("rejects a structurally sensitive output", () => {
    const result = () => boundary.validateCaptureEnvelope(options(`${stdout()}credential=secret\n`));
    expect(result).toThrow();
    try { result(); } catch (error) { expect(String(error)).not.toContain("secret"); }
  });

  it("rejects envelope capture mismatch", () => {
    const otherValidOutput = stdout().replace("checkout|branch=ATTACHED", "checkout|branch=DETACHED");
    expect(() => boundary.validateCaptureEnvelope(options(stdout(), { envelope: envelopeFor(otherValidOutput) }))).toThrow("ENVELOPE_CAPTURE_MISMATCH");
  });

  it("does not invoke SSH, child processes or retries", () => {
    const source = readFileSync("ops/deploy/discovery/gate1-local-capture-boundary.js", "utf8");
    expect(source).not.toMatch(/child_process|execFile|spawn\s*\(|retry/i);
  });

  it("requires an explicit separate custody authorization", () => {
    const result = boundary.validateCiphertextDestination({ approved: true, exclusive: true, plaintext: false, regular: true, accessible: true, reparse: false });
    expect(result.status).toBe("DESTINATION_METADATA_ONLY");
    expect(result.storage_approved).toBe(false);
    expect(result.custody).toBe("UNVERIFIED");
  });
});
