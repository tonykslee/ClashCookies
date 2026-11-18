"use strict";

const fs = require("node:fs");
const http = require("node:http");
const childProcess = require("node:child_process");
const path = require("node:path");
const { createRequire } = require("node:module");
const orchestrator = require("./migration-aware-deploy");
const adapter = require("./direct-docker-adapter");
const migrationRunner = require("./migration-runner");
const entrypoint = require("./production-deployment-entrypoint");

const SHA1 = /^[0-9a-f]{40}$/i;
const EXIT_CODES = entrypoint.EXIT_CODES;
const isInside = (parent, candidate) => {
  const parentPath = path.resolve(parent);
  const candidatePath = path.resolve(candidate);
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${path.sep}`);
};
const ProductionEntrypointError = entrypoint.ProductionEntrypointError;
const checkedCommand = entrypoint.checkedCommand;
const commandResult = entrypoint.commandResult;
const safeGit = entrypoint.safeGit;
const inspectCheckout = entrypoint.inspectCheckout;
const sourceFilesForCandidate = entrypoint.sourceFilesForCandidate;
const createArtifactManifest = entrypoint.createArtifactManifest;
const validateArtifactManifest = entrypoint.validateArtifactManifest;
const verifyArtifactPrismaClient = entrypoint.verifyArtifactPrismaClient;
const createCandidatePrismaFactory = (repoRoot, databaseUrl) => {
  const requireFromCandidate = createRequire(path.join(repoRoot, "package.json"));
  return () => {
    const { PrismaClient } = requireFromCandidate("@prisma/client");
    return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  };
};

function createPrivilegedOperations(manifest, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const spawnSyncImpl = dependencies.spawnSync || childProcess.spawnSync;
  const commandExecutor = dependencies.commandExecutor || adapter.createReadOnlyCommandExecutor({
    spawnImpl: dependencies.spawnImpl || childProcess.spawn,
  });
  const runtimeCollector = dependencies.runtimeEvidenceCollector || adapter.createDockerRuntimeEvidenceCollector({
    executor: commandExecutor,
  });

  const readCredential = () => adapter.readProtectedCredential(manifest.adapter.credential, manifest.appDir, fsImpl);
  const verifyArtifactPrismaClientImpl = dependencies.verifyArtifactPrismaClient || verifyArtifactPrismaClient;
  const createArtifactManifestImpl = dependencies.createArtifactManifest || createArtifactManifest;
  const validateArtifactManifestImpl = dependencies.validateArtifactManifest || validateArtifactManifest;
  let promotedArtifactPath = null;
  let promotedArtifactIdentity = null;
  let candidateSourceFiles = [];

  const artifactPathFor = (sha) => {
    if (!SHA1.test(String(sha || ""))) throw new ProductionEntrypointError("promotion_artifact_sha_invalid");
    const candidate = path.join(manifest.promotionArtifactRoot, String(sha).toLowerCase());
    if (!isInside(manifest.promotionArtifactRoot, candidate)) {
      throw new ProductionEntrypointError("promotion_artifact_path_invalid");
    }
    return candidate;
  };

  const assertAbsent = (targetPath, label) => {
    try {
      fsImpl.lstatSync(targetPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new ProductionEntrypointError(`${label}_identity_unavailable`);
    }
    throw new ProductionEntrypointError(`${label}_already_exists`);
  };
  const requirePromotedArtifact = (sha) => {
    const expectedPath = artifactPathFor(sha);
    if (promotedArtifactPath !== expectedPath || !promotedArtifactIdentity) {
      throw new ProductionEntrypointError("promoted_artifact_revision_mismatch", EXIT_CODES.BLOCKED, "artifact_identity_failed");
    }
    return expectedPath;
  };
  const runMigration = dependencies.runMigrationRunner || (async ({ repoRoot, releaseId, targetSha, migrationManifestDigest }) => {
    const credential = readCredential();
    const artifactPath = requirePromotedArtifact(targetSha);
    const migrationConfig = {
      enabled: true,
      targetEnvironment: "production",
      databaseIdentity: manifest.adapter.databaseIdentity,
      locks: manifest.adapter.locks,
    };
    const env = adapter.buildMigrationChildEnvironment({
      config: migrationConfig,
      releaseId,
      targetSha,
      migrationManifestDigest,
      databaseUrl: credential,
      baseEnv: dependencies.baseEnv || process.env,
    });
    return {
      exitCode: await migrationRunner.runMigrationRunner({
        env,
        repoRoot,
        log: () => undefined,
        dependencies: {
          prismaFactory: createCandidatePrismaFactory(artifactPath, credential),
          executeMigration: (config) => executeMigrationInArtifact(
            config,
            artifactPath,
            manifest.adapter.runtime,
            manifest.adapter.credential.path,
            spawnSyncImpl,
          ),
        },
      }),
    };
  });
  const verifyMigration = dependencies.verifyAppliedMigrations || (async ({ targetSha, migrationNames }) => {
    const credential = readCredential();
    const artifactPath = requirePromotedArtifact(targetSha);
    return migrationRunner.verifyAppliedMigrations({
      databaseUrl: credential,
      identity: manifest.adapter.databaseIdentity,
      migrationNames,
      prismaFactory: createCandidatePrismaFactory(artifactPath, credential),
    });
  });

  return Object.freeze({
    readPreflightEvidence: orchestrator.readPreflightEvidence,
    acquireExclusiveLock: (lockPath, owner) => {
      if (path.resolve(lockPath) !== manifest.adapter.locks.releasePath) {
        throw new ProductionEntrypointError("release_lock_path_mismatch");
      }
      return adapter.acquireHostLock(lockPath, owner, fsImpl);
    },
    computeReleaseDiff: (repoRoot, oldSha, newSha) => orchestrator.computeReleaseDiff(repoRoot, oldSha, newSha, spawnSyncImpl),
    inspectCheckout: (repoRoot) => inspectCheckout(repoRoot, spawnSyncImpl),
    inspectRuntime: async () => adapter.inspectRuntimeSnapshot(await runtimeCollector.collect(), manifest.adapter),
    createCandidate: (candidatePath, sha) => {
      if (path.resolve(candidatePath) !== manifest.candidateWorktreePath) throw new ProductionEntrypointError("candidate_path_mismatch");
      assertAbsent(candidatePath, "candidate_path");
      checkedCommand("git", ["-c", `safe.directory=${manifest.appDir}`, "-C", manifest.appDir, "worktree", "add", "--quiet", "--detach", candidatePath, sha], { label: "candidate_create" }, spawnSyncImpl);
      candidateSourceFiles = sourceFilesForCandidate(candidatePath, spawnSyncImpl, fsImpl);
    },
    buildCandidate: ({ candidatePath, sha }) => {
      const artifactPath = artifactPathFor(sha);
      assertAbsent(artifactPath, "promotion_artifact");
      fsImpl.mkdirSync(artifactPath);
      const buildContainer = "clashcookies-prod-candidate-build";
      let buildError = null;
      try {
        checkedCommand("docker", [
          "run", "--name", buildContainer,
          "--label", "com.clashcookies.deploy=candidate-build-only",
          "--network", "bridge", "-w", "/app", "-v", `${candidatePath}:/app`,
          "-v", "clashcookies-prod-candidate_node_modules:/app/node_modules",
          "-v", "clashcookies-prod-candidate_dist:/app/dist",
          manifest.adapter.runtime.image, "bash", "-lc", "./ops/deploy/ensure-yarn-deps.sh && npm run build",
        ], { label: "candidate_build" }, spawnSyncImpl);
        checkedCommand("docker", ["cp", `${buildContainer}:/app/.`, artifactPath], { label: "candidate_artifact_copy" }, spawnSyncImpl);
        verifyArtifactPrismaClientImpl(artifactPath);
        promotedArtifactIdentity = createArtifactManifestImpl(
          artifactPath,
          sha,
          candidateSourceFiles,
          manifest.appDir,
          fsImpl,
        );
        promotedArtifactPath = artifactPath;
      } catch (error) {
        buildError = error;
      }
      const cleanup = commandResult("docker", ["rm", "-f", buildContainer], { label: "candidate_build_cleanup" }, spawnSyncImpl);
      if (buildError) throw buildError;
      if (cleanup.status !== 0) {
        throw new ProductionEntrypointError("candidate_build_cleanup_ambiguous", EXIT_CODES.AMBIGUOUS, "ambiguous_execution");
      }
    },
    runMigrationRunner: runMigration,
    verifyMigration,
    verifyPromotedArtifact: ({ sha }) => {
      const artifactPath = requirePromotedArtifact(sha);
      validateArtifactManifestImpl(artifactPath, sha, promotedArtifactIdentity, manifest.appDir, fsImpl);
      verifyArtifactPrismaClientImpl(artifactPath);
    },
    stopRuntime: () => {
      checkedCommand("docker", ["rm", "-f", manifest.adapter.runtime.name], { label: "runtime_stop" }, spawnSyncImpl);
    },
    checkoutRelease: ({ sha }) => {
      checkedCommand("git", ["-c", `safe.directory=${manifest.appDir}`, "-C", manifest.appDir, "checkout", "--quiet", "--detach", sha], { label: "release_checkout" }, spawnSyncImpl);
    },
    startRuntime: ({ sha }) => {
      const artifactPath = requirePromotedArtifact(sha);
      validateArtifactManifestImpl(artifactPath, sha, promotedArtifactIdentity, manifest.appDir, fsImpl);
      const runtimeEnvironmentPath = manifest.adapter.runtimeCredential.path;
      const args = [
        "run", "-d", "--restart", "unless-stopped", "--name", manifest.adapter.runtime.name,
        "--label", `com.clashcookies.runtime=${manifest.adapter.runtime.label}`,
        "--label", `com.clashcookies.environment=${manifest.adapter.runtime.environment}`,
        "--label", `com.clashcookies.revision=${sha}`,
        "--network", manifest.adapter.runtime.network,
        "-p", `${adapter.CANONICAL_HOST_ADDRESS}:${manifest.adapter.runtime.hostPort}:${manifest.adapter.runtime.containerPort}`,
        "--env-file", runtimeEnvironmentPath,
        "-e", "POLLING_MODE=active", "-e", "POLLING_ENV=prod", "-w", "/app",
        "-v", `${artifactPath}:/app:ro`, manifest.adapter.runtime.image, "bash", "-lc", "npm run start:runtime",
      ];
      checkedCommand("docker", args, { label: "runtime_start" }, spawnSyncImpl);
    },
    healthCheck: (url) => new Promise((resolve) => {
      const request = http.get(url, { timeout: 5000 }, (response) => {
        response.resume();
        resolve({ status: response.statusCode });
      });
      request.on("error", () => resolve({ status: 0 }));
      request.on("timeout", () => {
        request.destroy();
        resolve({ status: 0 });
      });
    }),
    cleanupCandidate: ({ path: candidatePath, sha }) => {
      if (path.resolve(candidatePath) !== manifest.candidateWorktreePath) throw new ProductionEntrypointError("candidate_path_mismatch");
      const worktrees = safeGit(manifest.appDir, ["worktree", "list", "--porcelain"], spawnSyncImpl);
      if (!worktrees.includes(`worktree ${candidatePath}`) || !worktrees.includes(`HEAD ${sha}`)) {
        throw new ProductionEntrypointError("candidate_ownership_unverified");
      }
      checkedCommand("git", ["-c", `safe.directory=${manifest.appDir}`, "-C", manifest.appDir, "worktree", "remove", candidatePath], { label: "candidate_cleanup" }, spawnSyncImpl);
    },
    writeReleaseRecord: (recordPath, line) => {
      if (path.resolve(recordPath) !== manifest.adapter.releaseRecord.path) throw new ProductionEntrypointError("release_record_path_mismatch");
      return adapter.appendReleaseRecord(manifest.adapter.releaseRecord, manifest.appDir, adapter.validateReleaseRecordLine(line), fsImpl);
    },
    now: () => new Date().toISOString(),
  });
}

module.exports = { createPrivilegedOperations };
