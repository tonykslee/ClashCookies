import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = require("../ops/deploy/direct-docker-adapter.js") as typeof import("../ops/deploy/direct-docker-adapter.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const integration = require("../ops/deploy/offline-deployment-integration.js") as typeof import("../ops/deploy/offline-deployment-integration.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orchestrator = require("../ops/deploy/migration-aware-deploy.js") as typeof import("../ops/deploy/migration-aware-deploy.js");

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const DIFF_DIGEST = "c".repeat(64);
const MANIFEST_DIGEST = "d".repeat(64);
const AUTHORIZATION_DIGEST = "e".repeat(64);
const roots = new Set<string>();

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-offline-integration-"));
  roots.add(root);
  return root;
}

function makeIdentity(uid = 1000, gids = [1000]) {
  const [primaryGid, ...supplementaryGids] = gids;
  return {
    getuid: () => uid,
    getgid: () => primaryGid,
    getgroups: () => supplementaryGids,
  };
}

function makeFs(root: string, content: Buffer) {
  const openFiles = new Map<number, string>();
  const statFor = (filePath: string) => {
    const normalized = filePath.replaceAll("\\", "/");
    const file = normalized.endsWith("/executor.sh")
      ? { dev: 1, ino: 1, uid: 0, gid: 0, mode: 0o100755, isFile: true }
      : normalized.endsWith("/database-url.credential")
        ? { dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o100600, isFile: true }
        : normalized.endsWith("/release-record.jsonl")
          ? { dev: 1, ino: 3, uid: 0, gid: 0, mode: 0o100640, isFile: true }
          : { dev: 1, ino: 4, uid: 0, gid: 0, mode: 0o40755, isFile: false };
    return {
      ...file,
      isSymbolicLink: () => false,
      isFile: () => file.isFile,
      isDirectory: () => !file.isFile,
    };
  };
  return {
    operatorIdentitySource: makeIdentity(),
    constants: { O_RDONLY: 1, O_NOFOLLOW: 2 },
    lstatSync: (filePath: string) => statFor(filePath),
    realpathSync: (filePath: string) => filePath,
    openSync: (filePath: string) => {
      const fd = openFiles.size + 10;
      openFiles.set(fd, filePath);
      return fd;
    },
    fstatSync: (fd: number) => statFor(openFiles.get(fd) || root),
    closeSync: (fd: number) => openFiles.delete(fd),
    readFileSync: () => content,
  };
}

function makeConfig(root: string, digest: string) {
  return {
    adapterEnabled: true,
    verificationStatus: "PASS",
    targetEnvironment: "production",
    appDir: join(root, "app"),
    executor: {
      path: join(root, "executor.sh"),
      sha256: digest,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o755,
      authorization: {
        authorizationStatus: "PASS",
        scope: "immutable-deployment-entrypoint",
        canonicalPath: join(root, "executor.sh"),
        approvedSha256: digest,
        approvedOwnerUid: 0,
        approvedOwnerGid: 0,
        approvedMode: 0o755,
        operatorUid: 1000,
        operatorGids: [1000],
      },
      verified: true,
    },
    credential: {
      path: join(root, "database-url.credential"),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      verified: true,
    },
    locks: {
      releasePath: join(root, "deploy.lock"),
      runnerPath: join(root, "migration.lock"),
      verified: true,
    },
    releaseRecord: {
      path: join(root, "release-record.jsonl"),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o640,
      verified: true,
      appendOnlyVerified: true,
    },
    databaseIdentity: {
      host: "127.0.0.1",
      port: 5432,
      name: "clashcookies",
      user: "migration_runner",
      schema: "public",
      serverAddress: "127.0.0.1",
      serverPort: 5432,
      major: 17,
    },
  };
}

function makeEnvironment(root: string): Record<string, string> {
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
    DEPLOY_LOCK_PATH: join(root, "deploy.lock"),
    DEPLOY_MIGRATION_LOCK_PATH: join(root, "migration.lock"),
    DEPLOY_RELEASE_RECORD_PATH: join(root, "release-record.jsonl"),
    DEPLOY_PREFLIGHT_EVIDENCE_PATH: join(root, "preflight.json"),
    DEPLOY_CANDIDATE_WORKTREE_PATH: join(root, "candidate"),
  };
}

function makeEvidence() {
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
    gates: Object.fromEntries(orchestrator.REQUIRED_PREFLIGHT_GATES.map((gate: string) => [gate, "PASS"])),
  };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("offline deployment integration boundary", () => {
  it("returns PASS evidence but cannot authorize any orchestrator operation", async () => {
    const root = makeRoot();
    const content = Buffer.from("reviewed executor\n");
    const digest = createHash("sha256").update(content).digest("hex");
    const config = makeConfig(root, digest);
    const env = makeEnvironment(root);
    const deploymentConfig = orchestrator.parseConfig(env, process.cwd());
    const boundary = integration.createOfflineDeploymentIntegration({
      adapterConfig: config,
      dependencies: {
        fs: makeFs(root, content),
        operatorIdentitySource: makeIdentity(),
        testOnlyOperatorIdentityEvidence: true,
      },
    });
    const result = await boundary.guard({
      config: deploymentConfig,
      readPreflightEvidence: makeEvidence,
    });

    expect(result.status).toBe("PASS");
    expect(result.productionExecutionEnabled).toBe(false);
    expect(result.adapter.executor.independentOperatorIdentity).toBe("os-backed-process-identity");
    expect(result.adapter.executor).not.toHaveProperty("operatorGids");
    expect(result.deployment.lockPath).toBe(join(root, "deploy.lock"));

    const calls: string[] = [];
    const operation = (name: string) => (..._args: unknown[]) => {
      calls.push(name);
      return undefined;
    };
    const exitCode = await orchestrator.runMigrationAwareDeployment({
      env,
      repoRoot: process.cwd(),
      operations: {
        integrationGuard: boundary.guard,
        readPreflightEvidence: makeEvidence,
        now: operation("clock"),
        acquireExclusiveLock: operation("outer-lock"),
        writeReleaseRecord: operation("release-record"),
        inspectCheckout: operation("checkout-inspection"),
        inspectRuntime: operation("runtime-inspection"),
        computeReleaseDiff: operation("release-diff"),
        createCandidate: operation("candidate-creation"),
        buildCandidate: operation("candidate-build"),
        runMigrationRunner: operation("migration-runner"),
        verifyMigration: operation("migration-verification"),
        stopRuntime: operation("runtime-stop"),
        startRuntime: operation("runtime-start"),
        checkoutRelease: operation("release-checkout"),
        healthCheck: operation("health-check"),
        cleanupCandidate: operation("candidate-cleanup"),
      },
    });

    expect(exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(calls).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["malformed", {}],
    ["production-enabled", { status: "PASS", productionExecutionEnabled: true }],
  ])("fails closed for a %s integration result before sampling the clock", async (_label, integrationResult) => {
    const root = makeRoot();
    const calls: string[] = [];
    const env = makeEnvironment(root);
    const exitCode = await orchestrator.runMigrationAwareDeployment({
      env,
      repoRoot: process.cwd(),
      operations: {
        integrationGuard: async () => integrationResult,
        now: () => {
          calls.push("clock");
          return "2026-11-17T00:00:00.000Z";
        },
        acquireExclusiveLock: () => {
          calls.push("outer-lock");
          return () => true;
        },
      },
    });

    expect(exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(calls).toEqual([]);
  });

  it("does not treat a missing optional integration hook as offline authorization", async () => {
    const root = makeRoot();
    const calls: string[] = [];
    const env = makeEnvironment(root);
    const exitCode = await orchestrator.runMigrationAwareDeployment({
      env,
      repoRoot: process.cwd(),
      operations: {
        readPreflightEvidence: makeEvidence,
        now: () => {
          calls.push("clock");
          return "2026-11-17T00:00:00.000Z";
        },
        acquireExclusiveLock: () => {
          calls.push("outer-lock");
          return () => true;
        },
        writeReleaseRecord: (_path: string, _line: string) => {
          calls.push("release-record");
        },
        inspectCheckout: () => {
          calls.push("checkout-inspection");
          return { currentSha: "a".repeat(40), trackedChanges: false, stagedChanges: false, unknownPaths: [] };
        },
      },
    });

    expect(exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(calls).toContain("clock");
    expect(calls).toContain("outer-lock");
    expect(calls).toContain("checkout-inspection");
  });

  it.each([
    ["UID", { operatorUid: 1001 }, /operator_uid_mismatch/i],
    ["supplementary groups", { operatorGids: [1000, 2000] }, /operator_groups_mismatch/i],
  ])("blocks a claimed operator %s before acquiring the deployment lock", async (_label, authorization, expected) => {
    const root = makeRoot();
    const content = Buffer.from("reviewed executor\n");
    const digest = createHash("sha256").update(content).digest("hex");
    const config = makeConfig(root, digest);
    config.executor.authorization = { ...config.executor.authorization, ...authorization };
    const calls: string[] = [];
    const env = makeEnvironment(root);
    const deploymentConfig = orchestrator.parseConfig(env, process.cwd());
    const boundary = integration.createOfflineDeploymentIntegration({
      adapterConfig: config,
      dependencies: {
        fs: makeFs(root, content),
        operatorIdentitySource: makeIdentity(),
        testOnlyOperatorIdentityEvidence: true,
      },
    });

    const exitCode = await orchestrator.runMigrationAwareDeployment({
      env,
      repoRoot: process.cwd(),
      operations: {
        integrationGuard: boundary.guard,
        readPreflightEvidence: makeEvidence,
        acquireExclusiveLock: () => {
          calls.push("lock");
          return () => true;
        },
        now: () => {
          calls.push("now");
          return "2026-11-17T00:00:00.000Z";
        },
      },
    });

    expect(exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(calls).toEqual([]);
    expect(() => adapter.validateImmutableExecutor(
      config.executor,
      config.appDir,
      makeFs(root, content),
      makeIdentity(),
    )).toThrow(expected);
    expect(deploymentConfig.targetEnvironment).toBe("production");
  });

  it("blocks missing or failed preflight trust gates before any deployment operation", async () => {
    const root = makeRoot();
    const content = Buffer.from("reviewed executor\n");
    const digest = createHash("sha256").update(content).digest("hex");
    const config = makeConfig(root, digest);
    const calls: string[] = [];
    const env = makeEnvironment(root);
    const boundary = integration.createOfflineDeploymentIntegration({
      adapterConfig: config,
      dependencies: {
        fs: makeFs(root, content),
        operatorIdentitySource: makeIdentity(),
        testOnlyOperatorIdentityEvidence: true,
      },
    });
    const evidence = makeEvidence();
    evidence.gates.operatorIdentity = "BLOCKED";

    const exitCode = await orchestrator.runMigrationAwareDeployment({
      env,
      repoRoot: process.cwd(),
      operations: {
        integrationGuard: boundary.guard,
        readPreflightEvidence: () => evidence,
        acquireExclusiveLock: () => {
          calls.push("lock");
          return () => true;
        },
        now: () => {
          calls.push("now");
          return "2026-11-17T00:00:00.000Z";
        },
      },
    });

    expect(exitCode).toBe(orchestrator.EXIT_CODES.BLOCKED);
    expect(calls).toEqual([]);
  });
});
