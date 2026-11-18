import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The entrypoint is intentionally JavaScript so the protected executor can
// validate its contract before loading the application runtime.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entrypoint = require("../ops/deploy/production-deployment-entrypoint.js") as typeof import("../ops/deploy/production-deployment-entrypoint.js");

function makeManifest() {
  const root = resolve("C:/synthetic/clashcookies-production");
  const external = resolve("C:/synthetic/clashcookies-protected");
  const executorDigest = "a".repeat(64);
  return {
    schemaVersion: 1,
    verificationStatus: "PASS",
    targetEnvironment: "production",
    appDir: root,
    candidateWorktreePath: resolve("C:/synthetic/clashcookies-replacement"),
    preflightEvidencePath: resolve("C:/synthetic/clashcookies-protected/preflight.json"),
    activation: {
      authorizationStatus: "PASS",
      scope: "production-deployment-entrypoint",
      authorizationDigest: "b".repeat(64),
      approvedBy: "owner-approval",
      reviewedCommit: "c".repeat(40),
    },
    executor: {
      path: join(external, "clashcookies-production-entrypoint"),
      sha256: executorDigest,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o755,
      verified: true,
      authorization: {
        authorizationStatus: "PASS",
        scope: "immutable-deployment-entrypoint",
        canonicalPath: join(external, "clashcookies-production-entrypoint"),
        approvedSha256: executorDigest,
        approvedOwnerUid: 0,
        approvedOwnerGid: 0,
        approvedMode: 0o755,
        operatorUid: 1001,
        operatorGids: [1001],
      },
    },
    credential: {
      path: join(external, "production-db.env"),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      verified: true,
    },
    locks: {
      releasePath: join(external, "clashcookies-prod-deploy.lock"),
      runnerPath: join(external, "clashcookies-prod-migration.lock"),
      verified: true,
    },
    releaseRecord: {
      path: join(external, "release-record.ndjson"),
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
    nonMigrationHelper: {
      path: join(external, "deploy-prod.sh"),
      sha256: "d".repeat(64),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o755,
      verified: true,
    },
  };
}

describe("production deployment entrypoint contract", () => {
  it("validates proposed resources without claiming they are installed", () => {
    const manifest = entrypoint.validateProductionManifest(makeManifest());
    expect(manifest.targetEnvironment).toBe("production");
    expect(manifest.adapter.allowMutations).toBe(false);
    expect(manifest.adapter.allowMigrationExecution).toBe(false);
    expect(manifest.candidateWorktreePath).toContain("clashcookies-replacement");
  });

  it("rejects a candidate path inside the mutable checkout", () => {
    const manifest = makeManifest();
    manifest.candidateWorktreePath = resolve(manifest.appDir, "replacement");
    expect(() => entrypoint.validateProductionManifest(manifest)).toThrow(/outside_checkout/i);
  });

  it("requires the separate activation authorization and digest", () => {
    const manifest = entrypoint.validateProductionManifest(makeManifest());
    expect(() => entrypoint.ensureExplicitActivation(manifest, {})).toThrow(/not_authorized/i);
    expect(() => entrypoint.ensureExplicitActivation(manifest, {
      DEPLOYMENT_ACTIVATION_AUTHORIZED: "1",
      DEPLOYMENT_ACTIVATION_DIGEST: "0".repeat(64),
    })).toThrow(/digest_mismatch/i);
  });

  it("stops before any command when activation is absent", async () => {
    const calls: string[] = [];
    await expect(entrypoint.runProductionDeployment({
      manifest: makeManifest(),
      env: {},
      dependencies: {
        spawnSync: () => {
          calls.push("spawn");
          return { status: 0, stdout: "" };
        },
      },
    })).rejects.toThrow(/activation/i);
    expect(calls).toEqual([]);
  });

  it("exposes the orchestrator migration-runner contract and does not invoke the legacy wrapper", () => {
    const manifest = entrypoint.validateProductionManifest(makeManifest());
    const operations = entrypoint.createProductionOperations(manifest, {
      runMigrationRunner: async () => ({ exitCode: 0 }),
    });
    expect(operations.runMigrationRunner).toBeTypeOf("function");
    const workflow = readFileSync(resolve(".github/workflows/deploy-prod.yml"), "utf8");
    expect(workflow).toContain("/home/tilo/deploy-assets/clashcookies-production-entrypoint");
    expect(workflow).not.toContain("~/deploy-prod.sh");
    expect(workflow).not.toContain("exec /home/tilo/deploy-prod.sh");
    const packageJson = readFileSync(resolve("package.json"), "utf8");
    const startup = readFileSync(resolve("ops/deploy/container-start.sh"), "utf8");
    expect(packageJson).not.toContain('"start:runtime": "npm run migrate:deploy');
    expect(startup).not.toContain("migrate:deploy");
  });
});
