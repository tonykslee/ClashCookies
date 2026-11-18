import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const boundary = require("../ops/deploy/discovery/gate1-local-capture-boundary.js") as typeof import("../ops/deploy/discovery/gate1-local-capture-boundary.js");
const custody = require("../ops/deploy/discovery/gate1-offline-age-custody.js") as typeof import("../ops/deploy/discovery/gate1-offline-age-custody.js");

const agePath = commandPath("age.exe");
const ageKeygenPath = commandPath("age-keygen.exe");

function commandPath(name: string): string | undefined {
  const result = spawnSync("where.exe", [name], { encoding: "utf8", maxBuffer: 4096, windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function createAgeFixture() {
  if (!agePath || !ageKeygenPath) throw new Error("age test tools unavailable");
  const root = mkdtempSync(join(tmpdir(), "clashcookies-age-test-"));
  const keygen = spawnSync(ageKeygenPath, [], { encoding: "utf8", maxBuffer: 4096, windowsHide: true });
  if (keygen.status !== 0) throw new Error("age test key generation failed");
  const identity = keygen.stdout.trim();
  const recipient = identity.match(/# public key: (age1[0-9a-z]+)/)?.[1];
  if (!recipient) throw new Error("age test recipient unavailable");
  const identityPath = join(root, "test-only-identity.txt");
  writeFileSync(identityPath, identity, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot, { mode: 0o700 });
  return { root, evidenceRoot, identityPath, recipient, agePath };
}

function captureMetadata(plaintext: Buffer) {
  return boundary.createCaptureMetadata({
    captureAttemptId: "synthetic-age-attempt",
    packetVersion: boundary.CAPTURE_PACKET_VERSION,
    sourceIdentity: boundary.SYNTHETIC_SOURCE,
    assertedIdentity: "synthetic-host/synthetic-operator",
    hostKeyBinding: "EXTERNAL_REVIEW_REQUIRED",
    authorizationScope: "EXTERNAL_REVIEW_REQUIRED",
    sshExitStatus: 0,
    streamStatus: boundary.COMPLETE,
    eofObserved: true,
    stdout: plaintext,
    stderr: Buffer.alloc(0),
    declaredStdoutBytes: plaintext.length,
    declaredStdoutSha256: createHash("sha256").update(plaintext).digest("hex"),
    declaredStderrBytes: 0,
    declaredStderrSha256: createHash("sha256").update("").digest("hex"),
  });
}

function encryptOptions(fixture: ReturnType<typeof createAgeFixture>, plaintext = Buffer.from("synthetic evidence\0\r\n", "utf8"), destination = join(fixture.evidenceRoot, "capture.age")) {
  return {
    agePath: fixture.agePath,
    approvedRoot: fixture.evidenceRoot,
    destination,
    recipient: fixture.recipient,
    plaintext,
    captureMetadata: captureMetadata(plaintext),
    timeoutMs: 5000,
  };
}

function decryptFixture(fixture: ReturnType<typeof createAgeFixture>, ciphertextPath: string, identityPath = fixture.identityPath) {
  return spawnSync(fixture.agePath, ["--decrypt", "--identity", identityPath], {
    input: readFileSync(ciphertextPath),
    maxBuffer: boundary.MAX_CAPTURE_BYTES + 1,
    encoding: null,
    windowsHide: true,
  });
}

function fakeChild(setup: (child: EventEmitter & { stdin: { end: (value: Buffer) => void }; stdout: EventEmitter; stderr: EventEmitter; kill: () => void }) => void) {
  const child = new EventEmitter() as EventEmitter & { stdin: { end: (value: Buffer) => void }; stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  child.stdin = { end: () => undefined };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => undefined;
  setImmediate(() => setup(child));
  return child;
}

describe.skipIf(!agePath || !ageKeygenPath)("Gate 1 offline age ciphertext custody", () => {
  it("performs genuine age encryption and synthetic decryption round-trip", async () => {
    const fixture = createAgeFixture();
    try {
      const options = encryptOptions(fixture);
      const result = await custody.encryptSyntheticCaptureToFile(options);
      expect(result.status).toBe("ENCRYPTED_SYNTHETIC_CIPHERTEXT");
      expect(result.encryption).toBe("AGE_PROCESS_COMPLETED");
      expect(result.custody).toBe(custody.RESTRICTED_UNVERIFIED);
      expect(result.provenance).toBe("UNVERIFIED");
      expect(result.plaintext_persisted).toBe(false);
      const ciphertext = readFileSync(options.destination);
      expect(ciphertext.length).toBe(result.ciphertext_bytes);
      expect(createHash("sha256").update(ciphertext).digest("hex")).toBe(result.ciphertext_sha256);
      const decrypted = decryptFixture(fixture, options.destination);
      expect(decrypted.status).toBe(0);
      expect(Buffer.from(decrypted.stdout)).toEqual(options.plaintext);
      expect(existsSync(join(fixture.evidenceRoot, "plaintext"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects decryption with a different disposable identity", async () => {
    const fixture = createAgeFixture();
    const wrongIdentity = spawnSync(ageKeygenPath!, [], { encoding: "utf8", maxBuffer: 4096, windowsHide: true });
    const wrongIdentityPath = join(fixture.root, "wrong-test-only-identity.txt");
    writeFileSync(wrongIdentityPath, wrongIdentity.stdout, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      const options = encryptOptions(fixture);
      await custody.encryptSyntheticCaptureToFile(options);
      const decrypted = decryptFixture(fixture, options.destination, wrongIdentityPath);
      expect(decrypted.status).not.toBe(0);
      expect(Buffer.from(decrypted.stdout)).toHaveLength(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects invalid recipient syntax before destination creation", () => {
    const fixture = createAgeFixture();
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), recipient: "not-an-age-recipient" })).toThrow("AGE_RECIPIENT_SYNTAX_INVALID");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects a missing encryption tool without creating output", () => {
    const fixture = createAgeFixture();
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), agePath: join(fixture.root, "age.exe") })).toThrow("AGE_EXECUTABLE_MISSING");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects plaintext before invoking age", () => {
    const fixture = createAgeFixture();
    let invoked = false;
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), plaintext: Buffer.alloc(boundary.MAX_CAPTURE_BYTES + 1), captureMetadata: {} }, { spawnProcess: () => { invoked = true; throw new Error("must not run"); } })).toThrow("PLAINTEXT_TOO_LARGE");
      expect(invoked).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("accepts maximum plaintext without an additional unbounded copy", async () => {
    const fixture = createAgeFixture();
    const plaintext = Buffer.alloc(boundary.MAX_CAPTURE_BYTES, 65);
    try {
      const result = await custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture, plaintext), timeoutMs: 5000 });
      expect(result.ciphertext_bytes).toBeGreaterThan(0);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects oversized ciphertext before writing it", async () => {
    const fixture = createAgeFixture();
    try {
      const promise = custody.encryptSyntheticCaptureToFile(encryptOptions(fixture), {
        spawnProcess: () => fakeChild((child) => child.stdout.emit("data", Buffer.alloc(custody.MAX_CIPHERTEXT_BYTES + 1))),
      });
      await expect(promise).rejects.toThrow("CIPHERTEXT_TOO_LARGE");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects partial ciphertext and cleans the new file", async () => {
    const fixture = createAgeFixture();
    try {
      const promise = custody.encryptSyntheticCaptureToFile(encryptOptions(fixture), {
        spawnProcess: () => fakeChild((child) => {
          child.stdout.emit("data", Buffer.from("partial"));
          child.emit("close", 1, null);
        }),
      });
      await expect(promise).rejects.toThrow("AGE_PROCESS_FAILED");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects empty ciphertext output and cleans the new file", async () => {
    const fixture = createAgeFixture();
    try {
      const promise = custody.encryptSyntheticCaptureToFile(encryptOptions(fixture), {
        spawnProcess: () => fakeChild((child) => child.emit("close", 0, null)),
      });
      await expect(promise).rejects.toThrow("CIPHERTEXT_SIZE_MISMATCH");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("classifies interrupted encryption and cleans the new file", async () => {
    const fixture = createAgeFixture();
    try {
      const promise = custody.encryptSyntheticCaptureToFile(encryptOptions(fixture), {
        spawnProcess: () => fakeChild((child) => child.emit("close", null, "SIGTERM")),
      });
      await expect(promise).rejects.toThrow("AGE_PROCESS_INTERRUPTED");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("times out without retrying and cleans the new file", async () => {
    const fixture = createAgeFixture();
    let count = 0;
    try {
      const promise = custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), timeoutMs: 10 }, {
        spawnProcess: () => { count += 1; return fakeChild(() => undefined); },
      });
      await expect(promise).rejects.toThrow("AGE_PROCESS_TIMEOUT");
      expect(count).toBe(1);
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("detects tampered ciphertext through age decryption", async () => {
    const fixture = createAgeFixture();
    try {
      const options = encryptOptions(fixture);
      await custody.encryptSyntheticCaptureToFile(options);
      const ciphertext = readFileSync(options.destination);
      ciphertext[ciphertext.length - 1] ^= 1;
      writeFileSync(options.destination, ciphertext, { flag: "w" });
      const decrypted = decryptFixture(fixture, options.destination);
      expect(decrypted.status).not.toBe(0);
      expect(Buffer.from(decrypted.stdout)).toHaveLength(0);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects an empty plaintext capture", () => {
    const fixture = createAgeFixture();
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({
        ...encryptOptions(fixture),
        plaintext: Buffer.alloc(0),
        captureMetadata: {
          source_identity: boundary.SYNTHETIC_SOURCE,
          boundary: "UNVERIFIED",
          provenance: "UNVERIFIED",
          custody: "UNVERIFIED",
          stdout_bytes: 0,
          stdout_sha256: createHash("sha256").update("").digest("hex"),
        },
      })).toThrow("PLAINTEXT_EMPTY");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects forged capture provenance and custody claims", () => {
    const fixture = createAgeFixture();
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), captureMetadata: { source_identity: "production", boundary: "VERIFIED", provenance: "VERIFIED", custody: "VERIFIED" } })).toThrow("CAPTURE_METADATA_UNTRUSTED");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("rejects destination escape and existing collisions without overwrite", async () => {
    const fixture = createAgeFixture();
    const outside = join(fixture.root, "outside.age");
    writeFileSync(outside, "sentinel", { flag: "wx" });
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), destination: outside })).toThrow("CIPHERTEXT_DESTINATION_OUTSIDE_ROOT");
      const existing = join(fixture.evidenceRoot, "existing.age");
      writeFileSync(existing, "sentinel", { flag: "wx" });
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), destination: existing })).toThrow(/CIPHERTEXT_DESTINATION_(EXISTS|COLLISION)/);
      expect(readFileSync(existing, "utf8")).toBe("sentinel");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("rejects permission-denied destination parents", () => {
    const fixture = createAgeFixture();
    const blocked = join(fixture.evidenceRoot, "blocked");
    mkdirSync(blocked, { mode: 0o700 });
    chmodSync(blocked, 0o000);
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), destination: join(blocked, "capture.age") })).toThrow();
    } finally { chmodSync(blocked, 0o700); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("rejects symlinked destination parents", () => {
    const fixture = createAgeFixture();
    const outside = join(fixture.root, "outside");
    const link = join(fixture.evidenceRoot, "link");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, link, "dir");
    try {
      expect(() => custody.encryptSyntheticCaptureToFile({ ...encryptOptions(fixture), destination: join(link, "capture.age") })).toThrow("CIPHERTEXT_ROOT_UNSAFE");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("detects post-write hash mismatch and removes the new file", async () => {
    const fixture = createAgeFixture();
    const realFs = require("node:fs");
    const fakeFs = { ...realFs, readSync: (...args: unknown[]) => {
      const count = realFs.readSync(...args as Parameters<typeof realFs.readSync>);
      if (count > 0) (args[1] as Buffer)[args[2] as number] ^= 1;
      return count;
    } };
    try {
      await expect(custody.encryptSyntheticCaptureToFile(encryptOptions(fixture), { fsImpl: fakeFs })).rejects.toThrow("CIPHERTEXT_HASH_MISMATCH");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("reports cleanup failure without deleting an existing file", async () => {
    const fixture = createAgeFixture();
    const realFs = require("node:fs");
    const fakeFs = { ...realFs, unlinkSync: () => { throw new Error("cleanup denied"); } };
    try {
      await expect(custody.encryptSyntheticCaptureToFile(encryptOptions(fixture), {
        fsImpl: fakeFs,
        spawnProcess: () => fakeChild((child) => child.emit("close", 1, null)),
      })).rejects.toThrow("CIPHERTEXT_CLEANUP_FAILED");
      expect(existsSync(join(fixture.evidenceRoot, "capture.age"))).toBe(true);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("serializes concurrent destination creation through exclusive open", async () => {
    const fixture = createAgeFixture();
    try {
      const destination = join(fixture.evidenceRoot, "concurrent.age");
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => custody.encryptSyntheticCaptureToFile(encryptOptions(fixture, Buffer.from("one"), destination))),
        Promise.resolve().then(() => custody.encryptSyntheticCaptureToFile(encryptOptions(fixture, Buffer.from("two"), destination))),
      ]);
      expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
      expect(lstatSync(destination).isFile()).toBe(true);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("does not echo raw evidence or invoke SSH/production commands", () => {
    const source = readFileSync("ops/deploy/discovery/gate1-offline-age-custody.js", "utf8");
    expect(source).not.toMatch(/execFile|execSync|shell:\s*true|clash-vm|production-vm-discovery/i);
    expect(() => custody.encryptSyntheticCaptureToFile({ agePath: "not-an-age-path", approvedRoot: "not-absolute", destination: "not-absolute", recipient: "secret", plaintext: "raw-sensitive-evidence", captureMetadata: {} })).toThrow();
    try {
      custody.encryptSyntheticCaptureToFile({ agePath: "not-an-age-path", approvedRoot: "not-absolute", destination: "not-absolute", recipient: "secret", plaintext: "raw-sensitive-evidence", captureMetadata: {} });
    } catch (error) {
      expect(String(error)).not.toContain("raw-sensitive-evidence");
      expect(String(error)).not.toContain("secret");
    }
  });

  it("performs no automatic retry after one process failure", async () => {
    const fixture = createAgeFixture();
    let count = 0;
    try {
      await expect(custody.encryptSyntheticCaptureToFile(encryptOptions(fixture), {
        spawnProcess: () => { count += 1; return fakeChild((child) => child.emit("close", 1, null)); },
      })).rejects.toThrow("AGE_PROCESS_FAILED");
      expect(count).toBe(1);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
});
