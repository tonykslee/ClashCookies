import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const validator = require("../ops/deploy/discovery/gate1-prerequisite-validator.js") as typeof import("../ops/deploy/discovery/gate1-prerequisite-validator.js");

const emptyInventorySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const wrapperSha = "f".repeat(64);
const headSha = "b".repeat(40);
const validatorPath = resolve("ops/deploy/discovery/gate1-prerequisite-validator.js");

type RecordOptions = {
  branch?: "ATTACHED" | "DETACHED" | "UNKNOWN";
  clean?: "CLEAN" | "CHANGED" | "UNKNOWN";
  candidates?: Record<string, "ABSENT" | "SYMLINK" | "PRESENT">;
};

function artifactRecord(name: keyof typeof validator.APPROVED_ARTIFACT_SHA256, hash = validator.APPROVED_ARTIFACT_SHA256[name]) {
  return `${name}|regular file|1000|1000|664|42|sha256=${hash}`;
}

function candidateRecord(name: string, state: "ABSENT" | "SYMLINK" | "PRESENT") {
  return state === "PRESENT" ? `${name}|PRESENT|regular file|1000|1000|640|0` : `${name}|${state}`;
}

function records(options: RecordOptions = {}) {
  const candidates = options.candidates ?? {};
  return [
    "identity|uid=1000|gid=1000|group_count=4",
    ...(["archive", "adapter", "collector", "validator"] as const).map((name) => artifactRecord(name)),
    `wrapper|metadata=regular file|1001|1001|755|7348|sha256=${wrapperSha}`,
    "wrapper|syntax=PASS",
    "wrapper|control_flow=DEFERRED_TO_REDACTED_COLLECTOR",
    `checkout|head=${headSha}`,
    `checkout|branch=${options.branch ?? "ATTACHED"}`,
    `checkout|tracked_clean=${options.clean ?? "CLEAN"}`,
    "checkout|untracked_count=0",
    `checkout|untracked_inventory_sha256=${emptyInventorySha}`,
    ...validator.CANDIDATES.map((name) => candidateRecord(name, candidates[name] ?? "PRESENT")),
  ];
}

function stdoutFor(lines: string[]) {
  return `${lines.join("\n")}\n`;
}

function envelopeForStdout(stdout: string, overrides: Record<string, unknown> = {}) {
  const capture = {
    ssh_exit_status: 0,
    stream_status: "COMPLETE",
    eof_observed: true,
    stdout_sha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
    stdout_bytes: Buffer.byteLength(stdout, "utf8"),
  };
  const base = {
    schema_version: validator.SCHEMA_VERSION,
    packet_version: validator.PACKET_VERSION,
    target: "clash-vm",
    account: "tilo",
    expected_artifact_sha256: { ...validator.APPROVED_ARTIFACT_SHA256 },
    capture,
    provenance: {
      captured_at: "2026-11-18T01:02:03.000Z",
      host_key_binding: "EXTERNAL_REVIEW_REQUIRED",
      authorization_scope: "EXTERNAL_REVIEW_REQUIRED",
      source: "EXTERNAL_LOCAL_CAPTURE_WRAPPER",
    },
    stdout,
  };
  return {
    ...base,
    ...overrides,
    capture: { ...capture, ...(overrides.capture as Record<string, unknown> | undefined) },
    provenance: { ...base.provenance, ...(overrides.provenance as Record<string, unknown> | undefined) },
  };
}

function validEnvelope(options: RecordOptions = {}, overrides: Record<string, unknown> = {}) {
  return envelopeForStdout(stdoutFor(records(options)), overrides);
}

function mutateRecords(mutator: (lines: string[]) => string[], overrides: Record<string, unknown> = {}) {
  return envelopeForStdout(stdoutFor(mutator(records())), overrides);
}

function expectFailure(input: unknown, status: "INVALID" | "INCOMPLETE") {
  const result = validator.validateEnvelope(input);
  expect(result.status).toBe(status);
  expect(validator.formatResult(result)).not.toMatch(/DATABASE_URL|postgresql|secret|filename|branch=dev/i);
}

describe("Gate 1 prerequisite evidence validator", () => {
  it("accepts complete ordered evidence as structural VALID, never readiness PASS", () => {
    const result = validator.validateEnvelope(validEnvelope());
    expect(result.status).toBe("VALID");
    expect(result.reason).toBe("STRUCTURALLY_VALID");
    expect(result.recordCount).toBe(20);
    expect(result.reviewRequired).toBe(true);
    expect(validator.formatResult(result)).toBe("VALID|schema=clashcookies-gate1-prerequisite-v1|records=20|reason=STRUCTURALLY_VALID|review=REQUIRED|boundary=UNVERIFIED|provenance=UNVERIFIED\n");
  });

  it("accepts expected unresolved candidate states without treating them as readiness PASS", () => {
    for (const state of ["ABSENT", "SYMLINK"] as const) {
      const result = validator.validateEnvelope(validEnvelope({ candidates: { outer_lock: state } }));
      expect(result.status).toBe("VALID");
      expect(result.reason).toBe("UNKNOWN_OR_UNRESOLVED");
    }
  });

  it("accepts attached, detached and unknown checkout classifications", () => {
    for (const branch of ["ATTACHED", "DETACHED"] as const) {
      expect(validator.validateEnvelope(validEnvelope({ branch })).status).toBe("VALID");
    }
    const unknown = validator.validateEnvelope(validEnvelope({ branch: "UNKNOWN" }));
    expect(unknown.status).toBe("VALID");
    expect(unknown.reason).toBe("UNKNOWN_OR_UNRESOLVED");
  });

  it("accepts an empty untracked inventory with its fixed digest", () => {
    expect(validator.validateEnvelope(validEnvelope()).status).toBe("VALID");
  });

  const negativeCases: Array<[string, () => unknown, "INVALID" | "INCOMPLETE"]> = [
    ["missing required record", () => mutateRecords((lines) => lines.slice(0, -1)), "INVALID"],
    ["duplicate record", () => mutateRecords((lines) => [lines[0], lines[0], ...lines.slice(1)]), "INVALID"],
    ["unexpected record", () => mutateRecords((lines) => [lines[0], "unexpected|record", ...lines.slice(1)]), "INVALID"],
    ["incorrect order", () => mutateRecords((lines) => { [lines[1], lines[2]] = [lines[2], lines[1]]; return lines; }), "INVALID"],
    ["unexpected field", () => mutateRecords((lines) => { lines[0] += "|extra"; return lines; }), "INVALID"],
    ["extra field", () => mutateRecords((lines) => { lines[19] += "|extra"; return lines; }), "INVALID"],
    ["missing field", () => mutateRecords((lines) => { lines[0] = "identity|uid=1000|gid=1000"; return lines; }), "INVALID"],
    ["invalid UID", () => mutateRecords((lines) => { lines[0] = lines[0].replace("uid=1000", "uid=not-a-number"); return lines; }), "INVALID"],
    ["invalid GID", () => mutateRecords((lines) => { lines[0] = lines[0].replace("gid=1000", "gid=-1"); return lines; }), "INVALID"],
    ["invalid mode", () => mutateRecords((lines) => { lines[1] = lines[1].replace("|664|", "|999|"); return lines; }), "INVALID"],
    ["invalid size", () => mutateRecords((lines) => { lines[1] = lines[1].replace("|42|", "|-1|"); return lines; }), "INVALID"],
    ["invalid SHA-256", () => mutateRecords((lines) => { lines[1] = lines[1].replace(/[0-9a-f]{64}$/, "z".repeat(64)); return lines; }), "INVALID"],
    ["invalid HEAD", () => mutateRecords((lines) => { lines[9] = "checkout|head=bbbb"; return lines; }), "INVALID"],
    ["raw branch name", () => mutateRecords((lines) => { lines[10] = "checkout|branch=dev"; return lines; }), "INVALID"],
    ["raw filename", () => mutateRecords((lines) => { lines[13] = "checkout|filename=secret.env"; return lines; }), "INVALID"],
    ["wrapper source fragment", () => mutateRecords((lines) => { lines[8] = "DEPLOY_LOCK_PATH=/secret"; return lines; }), "INVALID"],
    ["credential-like content", () => mutateRecords((lines) => { lines[8] = "wrapper|value=DATABASE_URL=postgresql://secret"; return lines; }), "INVALID"],
    ["blank line", () => mutateRecords((lines) => [lines[0], "", ...lines.slice(1)]), "INVALID"],
    ["oversized line", () => mutateRecords((lines) => { lines[0] = `identity|${"x".repeat(1100)}`; return lines; }), "INVALID"],
    ["input over 8 KiB", () => envelopeForStdout(`${stdoutFor(records())}${"x".repeat(8000)}\n`), "INVALID"],
    ["truncated final record", () => envelopeForStdout(stdoutFor(records()).slice(0, -1)), "INCOMPLETE"],
    ["mixed SSH diagnostic", () => mutateRecords((lines) => ["Warning: host key", ...lines]), "INVALID"],
    ["nonzero SSH exit status", () => validEnvelope({}, { capture: { ssh_exit_status: 255 } }), "INCOMPLETE"],
    ["missing completion evidence", () => validEnvelope({}, { capture: { eof_observed: false } }), "INCOMPLETE"],
    ["STOP record", () => mutateRecords((lines) => [...lines.slice(0, -1), "STOP|reason=METADATA"]), "INCOMPLETE"],
    ["timeout", () => mutateRecords((lines) => [...lines.slice(0, -1), "STOP|reason=TIMEOUT"]), "INCOMPLETE"],
    ["interrupted collection", () => validEnvelope({}, { capture: { stream_status: "INTERRUPTED" } }), "INCOMPLETE"],
    ["malformed provenance", () => validEnvelope({}, { provenance: { captured_at: "not-a-timestamp" } }), "INVALID"],
    ["host identity mismatch", () => validEnvelope({}, { target: "unexpected-host" }), "INVALID"],
    ["artifact digest mismatch", () => mutateRecords((lines) => { lines[1] = artifactRecord("archive", "a".repeat(64)); return lines; }), "INVALID"],
    ["unsupported schema version", () => validEnvelope({}, { schema_version: "future-version" }), "INVALID"],
    ["unknown status", () => mutateRecords((lines) => { lines[10] = "checkout|branch=BOGUS"; return lines; }), "INVALID"],
    ["extra trailing output", () => mutateRecords((lines) => [...lines, "extra|trailing"]), "INVALID"],
    ["embedded control character", () => mutateRecords((lines) => { lines[0] += "\u0001"; return lines; }), "INVALID"],
    ["secret-bearing malformed output", () => mutateRecords((lines) => [...lines.slice(0, -1), "wrapper|PASSWORD=do-not-print"]), "INVALID"],
  ];

  it.each(negativeCases)("rejects %s without echoing input", (_name, makeInput, expectedStatus) => {
    expectFailure(makeInput(), expectedStatus);
  });

  it("fails closed for unknown envelope fields and does not trust caller provenance", () => {
    expectFailure({ ...validEnvelope(), unexpected: "field" }, "INVALID");
    expectFailure(validEnvelope({}, { provenance: {
      host_key_binding: "VERIFIED",
      authorization_scope: "AUTHORIZED",
      source: "TRUSTED",
    } }), "INCOMPLETE");
  });

  it("keeps the CLI output bounded and free of rejected input", () => {
    const result = validator.validateEnvelope(validEnvelope({}, { target: "DATABASE_URL=secret" }));
    const output = validator.formatResult(result);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(1024);
    expect(output).not.toContain("DATABASE_URL");
    expect(output).not.toContain("secret");
  });
});

function withFixture(callback: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-gate1-validator-"));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeEnvelope(root: string, name: string, content: string | Buffer) {
  const input = join(root, name);
  writeFileSync(input, content);
  return input;
}

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [validatorPath, ...args], {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function expectSanitizedCli(result: ReturnType<typeof runCli>, expectedStatus: number, expectedReason: string) {
  expect(result.timedOut).toBe(false);
  expect(result.status).toBe(expectedStatus);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(new RegExp(`^(?:VALID|INVALID|INCOMPLETE)\\|schema=clashcookies-gate1-prerequisite-v1\\|records=0\\|reason=${expectedReason}\\|review=REQUIRED\\|boundary=UNVERIFIED\\|provenance=UNVERIFIED\\n$`));
  expect(result.stdout).not.toMatch(/DATABASE_URL|postgresql|secret|PASSWORD|filename|PRIVATE KEY/i);
}

describe("Gate 1 bounded local input boundary", () => {
  it("accepts a small regular file only with an explicit boundary", () => {
    withFixture((root) => {
      const input = writeEnvelope(root, "evidence.json", JSON.stringify(validEnvelope()));
      const result = runCli(["--input", input, "--approved-root", root]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("VALID|schema=clashcookies-gate1-prerequisite-v1|records=20");
      expect(result.stdout).toContain("boundary=UNVERIFIED|provenance=UNVERIFIED");
    });
  });

  it("accepts an envelope exactly at the fixed 32 KiB boundary", () => {
    withFixture((root) => {
      const base = JSON.stringify(validEnvelope());
      const padding = " ".repeat(validator.MAX_ENVELOPE_BYTES - Buffer.byteLength(base, "utf8"));
      const input = writeEnvelope(root, "boundary.json", `${base}${padding}`);
      const result = runCli(["--input", input, "--approved-root", root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("VALID|schema=clashcookies-gate1-prerequisite-v1|records=20");
    });
  });

  it("rejects one byte above the envelope boundary before parsing", () => {
    withFixture((root) => {
      const base = JSON.stringify(validEnvelope());
      const padding = " ".repeat(validator.MAX_ENVELOPE_BYTES - Buffer.byteLength(base, "utf8"));
      const input = writeEnvelope(root, "oversized.json", `${base}${padding} `);
      const before = readFileSync(input);
      const result = runCli(["--input", input, "--approved-root", root]);
      expectSanitizedCli(result, 2, "INPUT_ENVELOPE_TOO_LARGE");
      expect(readFileSync(input)).toEqual(before);
    });
  });

  it("rejects an oversized envelope even when stdout itself is short", () => {
    withFixture((root) => {
      const envelope = { ...validEnvelope(), padding: "x".repeat(validator.MAX_ENVELOPE_BYTES) };
      const input = writeEnvelope(root, "short-stdout-oversized-envelope.json", JSON.stringify(envelope));
      expectSanitizedCli(runCli(["--input", input, "--approved-root", root]), 2, "INPUT_ENVELOPE_TOO_LARGE");
    });
  });

  it("rejects malformed JSON and malformed UTF-8 without echoing input", () => {
    withFixture((root) => {
      const malformedJson = writeEnvelope(root, "malformed.json", "{\"schema_version\":");
      expectSanitizedCli(runCli(["--input", malformedJson, "--approved-root", root]), 2, "INPUT_NOT_VALID_JSON");
      const malformedUtf8 = writeEnvelope(root, "malformed-utf8.json", Buffer.from([0xc3, 0x28]));
      expectSanitizedCli(runCli(["--input", malformedUtf8, "--approved-root", root]), 2, "INPUT_NOT_UTF8");
    });
  });

  it("rejects symlink input and symlink/reparse parent components when creation is available", ({ skip }) => {
    withFixture((root) => {
      const target = writeEnvelope(root, "target.json", JSON.stringify(validEnvelope()));
      const link = join(root, "input-link.json");
      const linkedParent = join(root, "linked-parent");
      try {
        symlinkSync(target, link, "file");
        symlinkSync(root, linkedParent, "junction");
      } catch (error) {
        skip("Windows test environment did not permit synthetic symlink/reparse creation");
        return;
      }
      expectSanitizedCli(runCli(["--input", link, "--approved-root", root]), 2, "INPUT_SYMLINK_OR_REPARSE");
      expectSanitizedCli(runCli(["--input", join(linkedParent, "target.json"), "--approved-root", root]), 2, "INPUT_SYMLINK_OR_REPARSE");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
    });
  });

  it("rejects directories, missing files, outside-boundary paths and long paths", () => {
    withFixture((root) => {
      const directory = join(root, "directory");
      mkdirSync(directory);
      expectSanitizedCli(runCli(["--input", directory, "--approved-root", root]), 2, "INPUT_NOT_REGULAR_FILE");
      expectSanitizedCli(runCli(["--input", join(root, "missing.json"), "--approved-root", root]), 3, "INPUT_FILE_UNREADABLE");
      const outsideRoot = mkdtempSync(join(tmpdir(), "clashcookies-gate1-outside-"));
      try {
        const outside = writeEnvelope(outsideRoot, "outside.json", JSON.stringify(validEnvelope()));
        expectSanitizedCli(runCli(["--input", outside, "--approved-root", root]), 2, "INPUT_OUTSIDE_BOUNDARY");
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }
      const longPath = join(root, "x".repeat(validator.MAX_INPUT_PATH_CHARS));
      expect(() => validator.parseCliArguments(["--input", longPath, "--approved-root", root])).toThrow("INPUT_PATH_INVALID");
    });
  });

  it("rejects a device/special file where the platform exposes one", ({ skip }) => {
    if (process.platform === "win32") {
      skip("Windows does not expose a portable synthetic device file inside a disposable boundary");
      return;
    }
    const device = "/dev/null";
    if (!existsSync(device)) {
      skip("platform has no /dev/null device fixture");
      return;
    }
    const result = runCli(["--input", device, "--approved-root", "/dev"]);
    expectSanitizedCli(result, 2, "INPUT_NOT_REGULAR_FILE");
  });

  it("rejects permission-denied input when the platform can create it reliably", ({ skip }) => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
      skip("Windows ACLs or root execution do not provide a reliable disposable permission-denied fixture");
      return;
    }
    withFixture((root) => {
      const input = writeEnvelope(root, "denied.json", JSON.stringify(validEnvelope()));
      chmodSync(input, 0o000);
      try {
        expectSanitizedCli(runCli(["--input", input, "--approved-root", root]), 3, "INPUT_FILE_UNREADABLE");
      } finally {
        chmodSync(input, 0o600);
      }
    });
  });

  it("rejects replacement and mutation detected by descriptor/path identity checks", () => {
    withFixture((root) => {
      const input = writeEnvelope(root, "race.json", JSON.stringify(validEnvelope()));
      expect(() => validator.readBoundedInput(input, root, {
        beforeRead: () => {
          const replacement = `${input}.replacement`;
          writeFileSync(replacement, readFileSync(input));
          rmSync(input, { force: true });
          renameSync(replacement, input);
        },
      })).toThrow(/INPUT_(REPLACED|CHANGED_DURING_READ)/);

      writeFileSync(input, JSON.stringify(validEnvelope()));
      expect(() => validator.readBoundedInput(input, root, {
        afterChunk: () => appendFileSync(input, "x"),
      })).toThrow("INPUT_CHANGED_DURING_READ");
    });
  });

  it("rejects short/interrupted reads through the bounded loader and never hangs", () => {
    withFixture((root) => {
      const input = writeEnvelope(root, "short.json", JSON.stringify(validEnvelope()));
      expect(() => validator.readBoundedInput(input, root, {
        beforeRead: () => {
          truncateSync(input, 0);
        },
      })).toThrow(/INPUT_(SHORT_READ|CHANGED_DURING_READ)/);
    });
  });

  it("rejects unexpected arguments and secret-bearing payloads with fixed output", () => {
    withFixture((root) => {
      const input = writeEnvelope(root, "secret.json", JSON.stringify({ ...validEnvelope(), target: "DATABASE_URL=secret" }));
      expectSanitizedCli(runCli(["--input", input, "--approved-root", root, "--unexpected"]), 3, "INPUT_ARGUMENT_INVALID");
      expectSanitizedCli(runCli(["--input", input, "--approved-root", root]), 2, "HOST_IDENTITY_MISMATCH");
    });
  });

  it("does not modify fixture files while rejecting input", () => {
    withFixture((root) => {
      const input = writeEnvelope(root, "immutable.json", JSON.stringify(validEnvelope(), null, 2));
      const before = readFileSync(input);
      const beforeStats = lstatSync(input);
      const result = runCli(["--input", input, "--approved-root", root]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("VALID|schema=clashcookies-gate1-prerequisite-v1|records=20");
      expect(result.stdout).toContain("boundary=UNVERIFIED|provenance=UNVERIFIED");
      expect(readFileSync(input)).toEqual(before);
      const afterStats = lstatSync(input);
      expect(afterStats.size).toBe(beforeStats.size);
      expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs);
    });
  });
});
