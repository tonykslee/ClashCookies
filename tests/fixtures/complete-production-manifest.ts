import { join, resolve } from "node:path";

export function makeCompleteProductionManifest(root = resolve("C:/synthetic/clashcookies-production"), external = resolve("C:/synthetic/clashcookies-protected")) {
  const executorDigest = "a".repeat(64);
  return {
    schemaVersion: 2,
    verificationStatus: "PASS",
    targetEnvironment: "production",
    appDir: root,
    candidateWorktreePath: resolve(root, "..", "replacement"),
    preflightEvidencePath: join(external, "preflight.json"),
    promotionArtifactRoot: join(external, "artifacts"),
    activation: {
      authorizationStatus: "PASS", scope: "production-deployment-entrypoint", authorizationDigest: "b".repeat(64),
      approvedBy: "owner-approval", reviewedCommit: "c".repeat(40),
    },
    executor: {
      path: join(external, "clashcookies-production-entrypoint"), sha256: executorDigest, ownerUid: 0, ownerGid: 0, mode: 0o755, verified: true,
      authorization: {
        authorizationStatus: "PASS", scope: "immutable-deployment-entrypoint", canonicalPath: join(external, "clashcookies-production-entrypoint"),
        approvedSha256: executorDigest, approvedOwnerUid: 0, approvedOwnerGid: 0, approvedMode: 0o755, operatorUid: 1001, operatorGids: [1001],
      },
    },
    credential: { path: join(external, "production-db.env"), ownerUid: 0, ownerGid: 0, mode: 0o600, verified: true },
    runtimeCredential: {
      path: join(external, "production-runtime.env"), ownerUid: 0, ownerGid: 0, mode: 0o600, format: "docker-env", databaseUser: "app_runtime", verified: true,
    },
    credentialAccess: {
      strategy: "broker-owned-protected-read-only", operatorUid: 1001, operatorGids: [1001], parentOwnerUid: 0, parentOwnerGid: 0, parentMode: 0o755,
      immutableFlagVerified: true, rootEquivalentAccess: "none", brokerServiceUid: 0, brokerServiceGid: 0, operatorCanReadCredentials: false,
      dockerAccess: "rootful-broker", verified: true,
    },
    broker: {
      strategy: "rootful-docker-broker", verified: true, socketPath: join(external, "broker.sock"), statePath: join(external, "broker-state.json"),
      operator: { uid: 1001, gid: 1001, supplementaryGids: [], groupNames: ["clashcookies-deploy"] },
      service: { uid: 0, gid: 0, dockerAccess: "rootful-socket-only", dockerSocket: "/var/run/docker.sock" },
      approval: { scopes: ["rootful-docker-broker-deployment", "rootful-docker-broker-migration"], publicKeyPath: join(external, "broker.pub"), keyId: "production-broker" },
    },
    locks: { releasePath: join(external, "clashcookies-prod-deploy.lock"), runnerPath: join(external, "clashcookies-prod-migration.lock"), verified: true },
    releaseRecord: { path: join(external, "release-record.ndjson"), ownerUid: 0, ownerGid: 0, mode: 0o640, verified: true, appendOnlyVerified: true },
    databaseIdentity: { host: "127.0.0.1", port: 5432, name: "clashcookies", user: "migration_runner", schema: "public", serverAddress: "127.0.0.1", serverPort: 5432, major: 17 },
    nonMigrationHelper: { path: join(external, "deploy-prod.sh"), sha256: "d".repeat(64), ownerUid: 0, ownerGid: 0, mode: 0o755, verified: true },
    moduleBundle: {
      root: external, verified: true,
      files: ["migration-aware-deploy.js", "direct-docker-adapter.js", "migration-runner.js", "deployment-lock.js", "rootful-deployment-broker.js"].map((relativePath) => ({
        relativePath, sha256: "e".repeat(64), ownerUid: 0, ownerGid: 0, mode: 0o644, verified: true,
      })),
    },
  };
}
