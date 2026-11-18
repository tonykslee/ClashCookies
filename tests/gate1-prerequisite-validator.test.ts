import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const validator = require("../ops/deploy/discovery/gate1-prerequisite-validator.js") as typeof import("../ops/deploy/discovery/gate1-prerequisite-validator.js");

const emptyInventorySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const wrapperSha = "f".repeat(64);
const headSha = "b".repeat(40);

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
    expect(validator.formatResult(result)).toBe("VALID|schema=clashcookies-gate1-prerequisite-v1|records=20|reason=STRUCTURALLY_VALID|review=REQUIRED|provenance=UNVERIFIED\n");
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
