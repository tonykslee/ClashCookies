import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
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
    promotionArtifactRoot: resolve("C:/synthetic/clashcookies-artifacts"),
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
    runtimeCredential: {
      path: join(external, "production-runtime.env"),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
      format: "docker-env",
      databaseUser: "app_runtime",
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
    moduleBundle: {
      root: external,
      verified: true,
      files: [
        "migration-aware-deploy.js",
        "direct-docker-adapter.js",
        "migration-runner.js",
        "deployment-lock.js",
      ].map((relativePath) => ({
        relativePath,
        sha256: "e".repeat(64),
        ownerUid: 0,
        ownerGid: 0,
        mode: 0o644,
        verified: true,
      })),
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

  it("rejects a runtime credential that uses the migration identity", () => {
    const manifest = makeManifest();
    manifest.runtimeCredential.databaseUser = manifest.databaseIdentity.user;
    expect(() => entrypoint.validateProductionManifest(manifest)).toThrow(/runtime_credential_identity_invalid/i);
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
    expect(workflow).toContain("/home/tilo/deploy-assets/clashcookies-production/production-deployment-entrypoint.js");
    expect(workflow).not.toContain("~/deploy-prod.sh");
    expect(workflow).not.toContain("exec /home/tilo/deploy-prod.sh");
    const packageJson = readFileSync(resolve("package.json"), "utf8");
    const startup = readFileSync(resolve("ops/deploy/container-start.sh"), "utf8");
    expect(packageJson).not.toContain('"start:runtime": "npm run migrate:deploy');
    expect(startup).not.toContain("migrate:deploy");
  });

  it("loads the complete executor module bundle from an installed sibling layout", () => {
    const sourceRoot = resolve("ops", "deploy");
    const installedRoot = mkdtempSync(join(tmpdir(), "clashcookies-entrypoint-bundle-"));
    try {
      for (const file of [
        "production-deployment-entrypoint.js",
        "migration-aware-deploy.js",
        "direct-docker-adapter.js",
        "migration-runner.js",
        "deployment-lock.js",
      ]) {
        copyFileSync(join(sourceRoot, file), join(installedRoot, file));
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const installed = require(join(installedRoot, "production-deployment-entrypoint.js"));
      expect(installed.validateProductionManifest).toBeTypeOf("function");
      expect(installed.createProductionOperations).toBeTypeOf("function");
    } finally {
      rmSync(installedRoot, { recursive: true, force: true });
    }
  });

  it("invokes the installed entrypoint path without requiring production resources", () => {
    const sourceRoot = resolve("ops", "deploy");
    const installedRoot = mkdtempSync(join(tmpdir(), "clashcookies-entrypoint-invoke-"));
    try {
      for (const file of [
        "production-deployment-entrypoint.js",
        "migration-aware-deploy.js",
        "direct-docker-adapter.js",
        "migration-runner.js",
        "deployment-lock.js",
      ]) copyFileSync(join(sourceRoot, file), join(installedRoot, file));
      const installedPath = join(installedRoot, "production-deployment-entrypoint.js");
      expect(readFileSync(installedPath, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
      try {
        execFileSync(process.execPath, [installedPath], {
          env: { ...process.env, DEPLOYMENT_CONFIG_PATH: "" },
          stdio: "pipe",
        });
        throw new Error("installed entrypoint unexpectedly succeeded");
      } catch (error) {
        expect((error as { status?: number }).status).toBe(78);
      }
    } finally {
      rmSync(installedRoot, { recursive: true, force: true });
    }
  });

  it("verifies the pinned hashes of every installed sibling module", () => {
    const sourceRoot = resolve("ops", "deploy");
    const installedRoot = mkdtempSync(join(tmpdir(), "clashcookies-entrypoint-verified-bundle-"));
    try {
      const files = [
        "migration-aware-deploy.js",
        "direct-docker-adapter.js",
        "migration-runner.js",
        "deployment-lock.js",
      ].map((relativePath) => {
        const installedPath = join(installedRoot, relativePath);
        copyFileSync(join(sourceRoot, relativePath), installedPath);
        const stat = lstatSync(installedPath);
        return {
          relativePath,
          sha256: createHash("sha256").update(readFileSync(installedPath)).digest("hex"),
          ownerUid: stat.uid,
          ownerGid: stat.gid,
          mode: stat.mode & 0o7777,
          verified: true,
        };
      });
      expect(entrypoint.validateModuleBundle({ root: installedRoot, verified: true, files }, resolve("C:/synthetic/app"), join(installedRoot, "production-deployment-entrypoint.js"))).toBe(installedRoot);
    } finally {
      rmSync(installedRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["altered", (artifactPath: string) => {
      const target = join(artifactPath, "dist", "ClashCookies.js");
      const contents = readFileSync(target);
      writeFileSync(target, Buffer.concat([contents, Buffer.from("altered")]), { flag: "w" });
    }],
    ["missing", (artifactPath: string) => rmSync(join(artifactPath, "package-lock.json"))],
    ["partial", (artifactPath: string) => rmSync(join(artifactPath, "node_modules", ".prisma", "client"), { recursive: true })],
  ] as const)("rejects a %s promoted artifact before runtime stop", (_label, mutate) => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-artifact-integrity-"));
    try {
      const artifactPath = join(root, "artifact");
      const appDir = join(root, "app");
      mkdirSync(join(artifactPath, "dist"), { recursive: true });
      mkdirSync(join(artifactPath, "prisma"), { recursive: true });
      mkdirSync(join(artifactPath, "node_modules", "@prisma"), { recursive: true });
      mkdirSync(join(artifactPath, "node_modules", ".prisma"), { recursive: true });
      copyFileSync("package.json", join(artifactPath, "package.json"));
      copyFileSync("package-lock.json", join(artifactPath, "package-lock.json"));
      writeFileSync(join(artifactPath, "dist", "ClashCookies.js"), "synthetic-candidate-build\n");
      copyFileSync("prisma/schema.prisma", join(artifactPath, "prisma", "schema.prisma"));
      cpSync("prisma/migrations", join(artifactPath, "prisma", "migrations"), { recursive: true });
      cpSync("node_modules/@prisma/client", join(artifactPath, "node_modules", "@prisma", "client"), { recursive: true });
      cpSync("node_modules/.prisma/client", join(artifactPath, "node_modules", ".prisma", "client"), { recursive: true });
      const sha = "f".repeat(40);
      const identity = entrypoint.createArtifactManifest(artifactPath, sha, [], appDir);
      mutate(artifactPath);
      expect(() => entrypoint.validateArtifactManifest(artifactPath, sha, identity, appDir)).toThrow(/promoted_artifact_(content_changed|incomplete)/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("promotes the built artifact and passes only the protected runtime env path", () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-promotion-artifact-"));
    try {
      const manifest = makeManifest();
      manifest.appDir = join(root, "app");
      manifest.candidateWorktreePath = join(root, "candidate");
      manifest.preflightEvidencePath = join(root, "preflight.json");
      manifest.promotionArtifactRoot = join(root, "artifacts");
      manifest.executor.path = join(root, "protected", "clashcookies-production-entrypoint");
      manifest.moduleBundle.root = join(root, "protected");
      manifest.credential.path = join(root, "protected", "production-db.env");
      manifest.runtimeCredential.path = join(root, "protected", "production-runtime.env");
      manifest.locks.releasePath = join(root, "protected", "deploy.lock");
      manifest.locks.runnerPath = join(root, "protected", "migration.lock");
      manifest.releaseRecord.path = join(root, "protected", "release-record.ndjson");
      manifest.nonMigrationHelper.path = join(root, "protected", "deploy-prod.sh");
      manifest.moduleBundle.files = manifest.moduleBundle.files.map((file) => ({ ...file }));
      mkdirSync(manifest.promotionArtifactRoot, { recursive: true });

      const validated = entrypoint.validateProductionManifest(manifest);
      const calls: Array<{ command: string; args: string[] }> = [];
      const operations = entrypoint.createProductionOperations(validated, {
        spawnSync: (command: string, args: string[]) => {
          calls.push({ command, args });
          return { status: 0, stdout: "" };
        },
        verifyArtifactPrismaClient: () => undefined,
        createArtifactManifest: () => ({
          sha256: "a".repeat(64),
          uid: 0,
          gid: 0,
          mode: 0o640,
          dev: 1,
          ino: 1,
        }),
        validateArtifactManifest: () => undefined,
      });
      const sha = "f".repeat(40);
      operations.buildCandidate({ candidatePath: validated.candidateWorktreePath, sha });
      expect(() => operations.startRuntime({ sha: "e".repeat(40) })).toThrow(/promoted_artifact_revision_mismatch/i);
      operations.startRuntime({ sha });

      const runtimeStart = calls.find(({ args }) => args[0] === "run" && args.includes("-d"));
      expect(runtimeStart).toBeDefined();
      expect(runtimeStart?.args).toContain("--env-file");
      expect(runtimeStart?.args).toContain(validated.adapter.runtimeCredential.path);
      expect(runtimeStart?.args.join(" ")).not.toContain("DATABASE_URL=");
      expect(runtimeStart?.args.join(" ")).toContain("npm run start:runtime");
      expect(runtimeStart?.args.join(" ")).not.toContain(`${validated.appDir}:/app`);
      expect(calls.some(({ args }) => args[0] === "cp" && args.some((arg) => arg.includes("/app/.")))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the migration credential only through the protected container mount", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const credentialPath = "C:/synthetic/protected/production-db.env";
    const credentialValue = "postgresql://migration_user:synthetic-secret@db/clashcookies";
    const result = entrypoint.executeMigrationInArtifact(
      { databaseUrl: credentialValue },
      "C:/synthetic/artifacts/f",
      { image: "clashcookies:reviewed", network: "clashcookies_default" },
      credentialPath,
      (command: string, args: string[]) => {
        calls.push({ command, args });
        return { status: 0 };
      },
    );

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("docker");
    expect(calls[0].args.some((arg) => arg.includes(credentialPath))).toBe(true);
    expect(calls[0].args.join(" ")).toContain("/run/secrets/migration-url");
    expect(calls[0].args.join(" ")).not.toContain(credentialValue);
    expect(calls[0].args.join(" ")).not.toContain("--env-file");
  });
});
