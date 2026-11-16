import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The orchestrator is intentionally JavaScript so the reviewed VM adapter can
// invoke it before application compilation and without importing the bot.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orchestrator = require("../ops/deploy/migration-aware-deploy.js") as typeof import("../ops/deploy/migration-aware-deploy.js");

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const DIFF_DIGEST = "c".repeat(64);
const MANIFEST_DIGEST = "d".repeat(64);
const AUTHORIZATION_DIGEST = "e".repeat(64);
const ownedRoots = new Set<string>();

function ownedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-migration-aware-test-"));
  ownedRoots.add(root);
  return root;
}

function makeEnvironment(root = ownedRoot()): Record<string, string> {
  return {
    DEPLOY_EXECUTION_AUTHORIZED: "1",
    DEPLOY_TARGET_ENV: "production",
    DEPLOY_RELEASE_ID: "release-test-1",
    DEPLOY_OLD_SHA: OLD_SHA,
    DEPLOY_NEW_SHA: NEW_SHA,
    DEPLOY_EXPECTED_MIGRATION_DIFF_DIGEST: DIFF_DIGEST,
    DEPLOY_EXPECTED_MIGRATION_MANIFEST_DIGEST: MANIFEST_DIGEST,
    DEPLOY_AUTHORIZATION_DIGEST: AUTHORIZATION_DIGEST,
    DEPLOY_APPROVED_BY: "release-approver",
    DEPLOY_ROLLBACK_AUTHORIZED: "1",
    DEPLOY_LOCK_PATH: join(root, "deploy.lock"),
    DEPLOY_RELEASE_RECORD_PATH: join(root, "release-record.jsonl"),
    DEPLOY_PREFLIGHT_EVIDENCE_PATH: join(root, "preflight.json"),
    DEPLOY_CANDIDATE_WORKTREE_PATH: join(root, "candidate"),
  };
}

function makeEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const gates = Object.fromEntries(
    orchestrator.REQUIRED_PREFLIGHT_GATES.map((gate) => [gate, "PASS"]),
  );
  return {
    evidenceId: "evidence-1",
    releaseId: "release-test-1",
    oldSha: OLD_SHA,
    newSha: NEW_SHA,
    migrationDiffDigest: DIFF_DIGEST,
    migrationManifestDigest: MANIFEST_DIGEST,
    approvedBy: "release-approver",
    authorizationDigest: AUTHORIZATION_DIGEST,
    authorizationStatus: "PASS",
    gates,
    ...overrides,
  };
}

function makeOperations(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const records: string[] = [];
  const state = {
    runtimeRevision: OLD_SHA,
    candidateCreated: false,
  };
  const operations = {
    readPreflightEvidence: () => makeEvidence(),
    acquireExclusiveLock: () => {
      calls.push("lock");
      return () => {
        calls.push("unlock");
        return true;
      };
    },
    inspectCheckout: () => {
      calls.push("inspect-checkout");
      return {
        currentSha: OLD_SHA,
        trackedChanges: false,
        stagedChanges: false,
        unknownPaths: ["runtime-data/keep.txt", "unknown.log"],
      };
    },
    computeReleaseDiff: () => {
      calls.push("diff");
      return {
        oldSha: OLD_SHA,
        newSha: NEW_SHA,
        paths: ["prisma/schema.prisma", "prisma/migrations/20261116120000_release/migration.sql"],
        digest: DIFF_DIGEST,
      };
    },
    inspectRuntime: () => {
      calls.push("inspect-runtime");
      return {
        candidates: [{
          name: orchestrator.RUNTIME_NAME,
          label: "active",
          environment: "prod",
          port: 8085,
          recognized: true,
          revision: state.runtimeRevision,
        }],
      };
    },
    createCandidate: () => {
      calls.push("create-candidate");
      state.candidateCreated = true;
    },
    buildCandidate: ({ environment }: { environment: Record<string, string> }) => {
      calls.push("build-candidate");
      expect(environment).toEqual({ NODE_ENV: "production", POLLING_MODE: "disabled", POLLING_ENV: "build" });
    },
    runMigrationRunner: (request: Record<string, unknown>) => {
      calls.push("migration-runner");
      expect(request.repoRoot).toBeTruthy();
      expect(request.targetSha).toBe(NEW_SHA);
      expect(request.migrationDiffDigest).toBe(DIFF_DIGEST);
      expect(request.migrationManifestDigest).toBe(MANIFEST_DIGEST);
      expect(request).not.toHaveProperty("DATABASE_URL");
      return { exitCode: 0 };
    },
    verifyMigration: () => {
      calls.push("verify-migration");
      return { unresolved: 0, targetApplied: true };
    },
    stopRuntime: () => calls.push("stop-runtime"),
    checkoutRelease: (request: { preserveUnknownFiles: boolean }) => {
      calls.push("checkout-release");
      expect(request.preserveUnknownFiles).toBe(true);
    },
    startRuntime: () => {
      calls.push("start-runtime");
      state.runtimeRevision = NEW_SHA;
    },
    healthCheck: (url: string) => {
      calls.push("health-check");
      expect(url).toBe(orchestrator.HEALTH_URL);
      return { status: 200 };
    },
    verifyOldRuntimeCompatibility: () => false,
    startOldRuntime: () => calls.push("start-old-runtime"),
    cleanupCandidate: () => {
      calls.push("cleanup-candidate");
      state.candidateCreated = false;
    },
    writeReleaseRecord: (_path: string, line: string) => records.push(line),
    now: () => "2026-11-16T21:00:00.000Z",
    ...overrides,
  };
  return { calls, records, state, operations };
}

function runWith(overrides: Record<string, unknown> = {}, envOverrides: Record<string, string> = {}) {
  const env = { ...makeEnvironment(), ...envOverrides };
  const logs: string[] = [];
  const harness = makeOperations(overrides);
  return orchestrator.runMigrationAwareDeployment({
    env,
    repoRoot: process.cwd(),
    log: (line: string) => logs.push(line),
    operations: harness.operations,
  }).then((exitCode: number) => ({ ...harness, env, logs, exitCode }));
}

afterEach(() => {
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  ownedRoots.clear();
});

describe("migration-aware deployment orchestrator", () => {
  it("preserves fail-closed absolute-path and authorization validation", () => {
    const env = makeEnvironment();
    delete env.DEPLOY_EXECUTION_AUTHORIZED;
    expect(() => orchestrator.parseConfig(env)).toThrow(/not_authorized/i);

    const relativePath = makeEnvironment();
    relativePath.DEPLOY_LOCK_PATH = "relative/deploy.lock";
    expect(() => orchestrator.parseConfig(relativePath)).toThrow(/lock_path/i);

    const relativeEvidence = makeEnvironment();
    relativeEvidence.DEPLOY_PREFLIGHT_EVIDENCE_PATH = "preflight.json";
    expect(() => orchestrator.parseConfig(relativeEvidence)).toThrow(/preflight_evidence_path/i);
  });

  it("computes exact old/new commit identity and migration diff digest", () => {
    const outputs = new Map<string, string>([
      ["rev-old", `${OLD_SHA}\n`],
      ["rev-new", `${NEW_SHA}\n`],
      ["names", "prisma/schema.prisma\nprisma/migrations/20261116120000_release/migration.sql\n"],
      ["diff", "reviewed migration patch\n"],
    ]);
    const result = orchestrator.computeReleaseDiff(process.cwd(), OLD_SHA, NEW_SHA, (_command: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === "rev-parse" && args[2].startsWith(OLD_SHA) ? outputs.get("rev-old")
        : args[0] === "rev-parse" ? outputs.get("rev-new")
          : args[1] === "--name-only" ? outputs.get("names") : outputs.get("diff"),
    }));

    expect(result.oldSha).toBe(OLD_SHA);
    expect(result.newSha).toBe(NEW_SHA);
    expect(result.paths).toHaveLength(2);
    expect(result.digest).toBe(createHash("sha256").update("reviewed migration patch\n").digest("hex"));
  });

  it("runs every authorized phase while preserving unknown files and excluding production secrets from the build", async () => {
    const result = await runWith();

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.SUCCESS);
    expect(result.calls.indexOf("lock")).toBeLessThan(result.calls.indexOf("inspect-checkout"));
    expect(result.calls).toContain("migration-runner");
    expect(result.calls).toContain("verify-migration");
    expect(result.calls).toContain("cleanup-candidate");
    expect(result.calls).not.toContain("start-old-runtime");
    expect(result.state.runtimeRevision).toBe(NEW_SHA);
    expect(result.records.join("\n")).not.toContain("DATABASE_URL");
  });

  it("blocks missing authorization or backup evidence before any runtime or database operation", async () => {
    const unauthorized = await runWith({}, { DEPLOY_EXECUTION_AUTHORIZED: "0" });
    expect(unauthorized.exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(unauthorized.calls).toEqual([]);

    const missingBackup = await runWith({
      readPreflightEvidence: () => makeEvidence({ gates: { ...makeEvidence().gates, backupRestore: "BLOCKED" } }),
    });
    expect(missingBackup.exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(missingBackup.calls).toEqual(["lock", "unlock"]);
    expect(missingBackup.calls).not.toContain("inspect-runtime");
    expect(missingBackup.calls).not.toContain("migration-runner");
  });

  it("blocks incorrect release identity or migration digest before candidate creation", async () => {
    const wrongIdentity = await runWith({
      computeReleaseDiff: () => ({ oldSha: "f".repeat(40), newSha: NEW_SHA, paths: ["prisma/schema.prisma"], digest: DIFF_DIGEST }),
    });
    expect(wrongIdentity.exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(wrongIdentity.calls).not.toContain("create-candidate");

    const wrongDigest = await runWith({
      computeReleaseDiff: () => ({ oldSha: OLD_SHA, newSha: NEW_SHA, paths: ["prisma/schema.prisma"], digest: "f".repeat(64) }),
    });
    expect(wrongDigest.exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(wrongDigest.calls).not.toContain("create-candidate");
  });

  it("rejects an incorrect database identity reported by the protected migration runner", async () => {
    const result = await runWith({
      runMigrationRunner: () => ({ exitCode: orchestrator.EXIT_CODES.BLOCKED, classification: "database_identity_mismatch" }),
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(result.calls).not.toContain("stop-runtime");
  });

  it("rejects concurrent deployment attempts before inspecting release state", async () => {
    let runnerCalls = 0;
    const result = await runWith({
      acquireExclusiveLock: () => {
        throw new orchestrator.OrchestratorError("deployment_lock_already_held", orchestrator.EXIT_CODES.LOCKED, "already_locked");
      },
      runMigrationRunner: () => {
        runnerCalls += 1;
        return { exitCode: 0 };
      },
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.LOCKED);
    expect(result.calls).toEqual([]);
    expect(runnerCalls).toBe(0);
  });

  it("stops on candidate build failure without invoking migration or runtime changes", async () => {
    const result = await runWith({
      buildCandidate: () => {
        throw new orchestrator.OrchestratorError("candidate_build_failed", orchestrator.EXIT_CODES.FAILED, "candidate_build_failed", "candidate_build");
      },
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.FAILED);
    expect(result.calls).not.toContain("migration-runner");
    expect(result.calls).not.toContain("stop-runtime");
    expect(result.calls).toContain("cleanup-candidate");
  });

  it("propagates migration failure and never retries or stops the old runtime", async () => {
    let runnerCalls = 0;
    const result = await runWith({
      runMigrationRunner: () => {
        runnerCalls += 1;
        return { exitCode: 17, classification: "migration_failed" };
      },
    });

    expect(result.exitCode).toBe(17);
    expect(runnerCalls).toBe(1);
    expect(result.calls).not.toContain("stop-runtime");
  });

  it("stops on ambiguous migration completion and preserves recovery state", async () => {
    const result = await runWith({
      runMigrationRunner: () => ({ exitCode: orchestrator.EXIT_CODES.AMBIGUOUS, ambiguous: true }),
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.AMBIGUOUS);
    expect(result.calls).not.toContain("stop-runtime");
    expect(result.calls).not.toContain("cleanup-candidate");
    expect(result.records.join("\n")).toContain("ambiguous_migration");
  });

  it("preserves recovery state when the new runtime fails to start after migration", async () => {
    const result = await runWith({
      startRuntime: () => {
        throw new orchestrator.OrchestratorError("runtime_start_failed", orchestrator.EXIT_CODES.FAILED, "runtime_start_failed", "promotion", true);
      },
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.FAILED);
    expect(result.calls).toContain("stop-runtime");
    expect(result.calls).toContain("checkout-release");
    expect(result.calls).not.toContain("health-check");
    expect(result.calls).not.toContain("start-old-runtime");
    expect(result.calls).not.toContain("cleanup-candidate");
  });

  it("does not roll back incompatible old runtime after a health failure", async () => {
    const result = await runWith({
      healthCheck: () => ({ status: 503 }),
      verifyOldRuntimeCompatibility: () => false,
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.FAILED);
    expect(result.calls).not.toContain("start-old-runtime");
    expect(result.records.join("\n")).toContain("old_runtime_rollback_blocked");
  });

  it("allows old-runtime restart only with proven compatibility and explicit rollback authorization", async () => {
    const result = await runWith({
      healthCheck: () => ({ status: 503 }),
      verifyOldRuntimeCompatibility: () => true,
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.FAILED);
    expect(result.calls).toContain("start-old-runtime");
    expect(result.records.join("\n")).toContain("old_runtime_restarted_after_verified_compatibility");
  });

  it("preserves interrupted deployment state and never performs destructive recovery", async () => {
    const result = await runWith({
      runMigrationRunner: () => {
        throw new orchestrator.OrchestratorError("deployment_interrupted", orchestrator.EXIT_CODES.AMBIGUOUS, "interrupted", "migration", true);
      },
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.AMBIGUOUS);
    expect(result.calls).not.toContain("stop-runtime");
    expect(result.calls).not.toContain("cleanup-candidate");
    expect(result.records.join("\n")).toContain("interrupted");
  });

  it("redacts secrets and does not expose runner errors in logs or release records", async () => {
    const secret = "postgresql://db-user:super-secret@db.example/prod";
    const result = await runWith({
      runMigrationRunner: () => {
        throw new Error(secret);
      },
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.AMBIGUOUS);
    expect(result.logs.join("\n")).not.toContain(secret);
    expect(result.records.join("\n")).not.toContain(secret);
  });

  it("rejects duplicate or unidentified active runtimes before candidate creation", async () => {
    const result = await runWith({
      inspectRuntime: () => ({
        candidates: [
          { name: orchestrator.RUNTIME_NAME, label: "active", environment: "prod", port: 8085, recognized: true, revision: OLD_SHA },
          { name: "unknown-bot", label: "", environment: "prod", port: 0, recognized: false, revision: OLD_SHA },
        ],
      }),
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(result.calls).not.toContain("create-candidate");
    expect(result.calls).not.toContain("migration-runner");
  });

  it("does not run migration when post-migration verification is unresolved", async () => {
    const result = await runWith({
      verifyMigration: () => ({ unresolved: 1, targetApplied: false }),
    });

    expect(result.exitCode).toBe(orchestrator.EXIT_CODES.AMBIGUOUS);
    expect(result.calls).not.toContain("stop-runtime");
    expect(result.calls).not.toContain("start-runtime");
    expect(result.calls).not.toContain("cleanup-candidate");
  });

  it("keeps the runner contract separate from application startup", () => {
    const source = require("node:fs").readFileSync(
      join(process.cwd(), "ops", "deploy", "migration-aware-deploy.js"),
      "utf8",
    ) as string;
    expect(source).not.toContain("ClashCookies.js");
    expect(source).not.toContain("start:runtime");
    expect(source).toContain("migration-runner.js");
  });
});
