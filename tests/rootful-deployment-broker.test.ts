import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const broker = require("../ops/deploy/rootful-deployment-broker.js") as typeof import("../ops/deploy/rootful-deployment-broker.js");

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);

function makeConfig() {
  return {
    appDir: "/synthetic/clashcookies",
    strategy: "rootful-docker-broker",
    verified: true,
    socketPath: "/synthetic/protected/clashcookies-broker.sock",
    statePath: "/synthetic/protected/clashcookies-broker-state.json",
    operator: { uid: 1001, gid: 1001, supplementaryGids: [], groupNames: ["clashcookies-deploy"] },
    service: { uid: 0, gid: 0, dockerAccess: "rootful-socket-only", dockerSocket: "/var/run/docker.sock" },
    approval: {
      scopes: ["rootful-docker-broker-deployment", "rootful-docker-broker-migration"],
      publicKeyPath: "/synthetic/protected/clashcookies-broker.pub",
      keyId: "production-broker",
    },
  };
}

function makeRelease(sessionId = "session-1", approvedBy = "github-main-merge") {
  return {
    sessionId, releaseId: `release-${sessionId}`, oldSha: OLD_SHA, newSha: NEW_SHA,
    migrationDiffDigest: DIGEST, migrationManifestDigest: DIGEST, authorizationDigest: DIGEST, approvedBy,
  };
}

function makeApproval(privateKey: unknown, release: ReturnType<typeof makeRelease>, nonce = `nonce-${release.sessionId}`, scope = release.approvedBy === "github-environment-production-migration" ? "rootful-docker-broker-migration" : "rootful-docker-broker-deployment") {
  const envelope = { keyId: "production-broker", nonce, scope, approvedBy: release.approvedBy, reviewedCommit: release.newSha };
  return { ...envelope, signature: sign(null, Buffer.from(broker.approvalPayload(envelope, release)), privateKey as Parameters<typeof sign>[2]).toString("base64") };
}

function makeEvidence(release: ReturnType<typeof makeRelease>) {
  return {
    evidenceId: "evidence-1", releaseId: release.releaseId, oldSha: release.oldSha, newSha: release.newSha,
    migrationDiffDigest: release.migrationDiffDigest, migrationManifestDigest: release.migrationManifestDigest,
    authorizationDigest: release.authorizationDigest, approvedBy: release.approvedBy, authorizationStatus: "PASS",
    gates: {
      releaseApproval: "PASS", targetIdentity: "PASS", migrationScope: "PASS", operatorIdentity: "PASS",
      checkoutSafety: "PASS", runtimeSingleton: "PASS", databaseIdentity: "PASS", migrationBaseline: "PASS",
      backupRestore: "PASS", diskCapacity: "PASS", healthMonitoring: "PASS", stagingOrWaiver: "PASS", historicalCompatibility: "PASS",
    },
  };
}

function makeDiff(release: ReturnType<typeof makeRelease>, paths = ["prisma/migrations/20261119_add_field/migration.sql"]) {
  return { oldSha: release.oldSha, newSha: release.newSha, digest: release.migrationDiffDigest, paths, migrationNames: paths.length === 0 ? [] : ["20261119_add_field"] };
}

function makeServer(config: ReturnType<typeof makeConfig>, publicKey: unknown, handlers: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const defaultHandlers = {
    readPreflightEvidence: (_payload: unknown, context: { release: ReturnType<typeof makeRelease> }) => makeEvidence(context.release),
    inspectCheckout: () => ({ currentSha: OLD_SHA, trackedChanges: false, stagedChanges: false, unknownPaths: [] }),
    classifyReleaseDiff: (_payload: unknown, context: { release: ReturnType<typeof makeRelease> }) => makeDiff(context.release),
    computeReleaseDiff: (_payload: unknown, context: { release: ReturnType<typeof makeRelease> }) => makeDiff(context.release),
    inspectRuntime: (_payload: unknown, context: { release: ReturnType<typeof makeRelease>, session: { runtimeStarted?: boolean } }) => ({
      candidates: [{ name: "clashcookies-app", label: "active", environment: "prod", port: 8085, recognized: true, revision: context.session.runtimeStarted ? context.release.newSha : context.release.oldSha }],
    }),
    verifyMigration: () => ({ unresolved: 0, targetApplied: true }), verifyPromotedArtifact: () => undefined, healthCheck: () => ({ status: 200 }),
    acquireExclusiveLock: () => ({ acquired: true }), releaseExclusiveLock: () => ({ released: true }), createCandidate: () => undefined,
    buildCandidate: () => undefined, runMigrationRunner: () => ({ exitCode: 0 }), stopRuntime: () => undefined, checkoutRelease: () => undefined,
    startRuntime: () => undefined, cleanupCandidate: () => undefined, writeReleaseRecord: () => undefined, runNonMigration: () => 0,
  };
  const phaseValidators = {
    readPreflightEvidence: (evidence: unknown) => evidence, inspectCheckout: (checkout: unknown) => checkout,
    classifyReleaseDiff: (diff: unknown) => diff, computeReleaseDiff: (diff: unknown) => diff,
    inspectRuntime: (runtime: unknown) => runtime, runMigrationRunner: (result: unknown) => { if (!result || (result as { exitCode?: number }).exitCode !== 0) throw new broker.BrokerError("migration_result_invalid", "phase_evidence_invalid"); return result; }, verifyMigration: (status: unknown) => status, healthCheck: (health: unknown) => health,
  };
  return broker.createRootfulBrokerServer({
    config, peerIdentitySource: () => ({ ...config.operator }),
    approvalVerifier: broker.createEd25519ApprovalVerifier({ publicKey }), handlers: { ...defaultHandlers, ...handlers }, phaseValidators, ...options,
  });
}

function request(server: ReturnType<typeof makeServer>, release: ReturnType<typeof makeRelease>, approval: object, operation: string, payload: object = {}, requestId = `request-${operation}`) {
  return server.handle({ protocolVersion: 1, requestId, sessionId: release.sessionId, operation, release, approval, payload });
}

describe("rootful deployment broker boundary", () => {
  it("uses one bounded operation-aware deadline policy for client and server phases", () => {
    expect(broker.operationDeadlineMs("buildCandidate")).toBeGreaterThan(5000);
    expect(broker.operationDeadlineMs("runMigrationRunner")).toBeGreaterThan(broker.operationDeadlineMs("healthCheck"));
    expect(broker.BROKER_RESPONSE_GRACE_MS).toBeGreaterThan(0);
    expect(() => broker.operationDeadlineMs("arbitrary-command")).toThrow(/operation_not_allowlisted/i);
  });

  it("rejects unauthorized operators and spoofed identity claims", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const config = makeConfig(); const release = makeRelease(); const approval = makeApproval(privateKey, release);
    const server = makeServer(config, publicKey, {}, { peerIdentitySource: () => ({ uid: 1002, gid: 1001, supplementaryGids: [], groupNames: ["clashcookies-deploy"] }) });
    await expect(request(server, release, approval, "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA })).rejects.toMatchObject({ code: "identity_invalid" });
    await expect(server.handle({ protocolVersion: 1, requestId: "spoofed", sessionId: release.sessionId, operation: "classifyReleaseDiff", release, approval, payload: { oldSha: OLD_SHA, newSha: NEW_SHA }, peerIdentity: { uid: 0, gid: 0 } })).rejects.toMatchObject({ code: "broker_request_invalid" });
  });

  it("requires release-bound approvals and rejects forged or replayed requests", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease(); const approval = makeApproval(privateKey, release, "one-time"); const server = makeServer(config, publicKey);
    await expect(request(server, release, { ...approval, signature: "Zm9yZ2Vk" }, "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA })).rejects.toMatchObject({ code: "approval_invalid" });
    await expect(request(server, release, approval, "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "valid-request")).resolves.toMatchObject({ ok: true });
    await expect(request(server, release, approval, "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "valid-request")).rejects.toMatchObject({ code: "replay_rejected" });
    const second = makeRelease("session-2"); await expect(request(server, second, makeApproval(privateKey, second, "one-time"), "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "second-request")).rejects.toMatchObject({ code: "approval_invalid" });
  });

  it("rejects arbitrary Docker, shell, path, environment, and credential payloads", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease(); const approval = makeApproval(privateKey, release); const server = makeServer(config, publicKey);
    await expect(request(server, release, approval, "exec", { command: "docker rm -f clashcookies-app" })).rejects.toMatchObject({ code: "broker_request_invalid" });
    await expect(request(server, release, approval, "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA, path: "/etc/shadow" }, "path-attempt")).rejects.toMatchObject({ code: "broker_request_invalid" });
    await expect(request(server, release, approval, "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA, env: { DATABASE_URL: "secret" } }, "env-attempt")).rejects.toMatchObject({ code: "broker_request_invalid" });
  });

  it("derives release-record content from trusted phase state", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease("record-integrity", "github-environment-production-migration"); const approval = makeApproval(privateKey, release); const server = makeServer(config, publicKey);
    await expect(request(server, release, approval, "writeReleaseRecord", { line: '{"event":"end","classification":"success"}' }, "record-raw-line")).rejects.toMatchObject({ code: "broker_request_invalid" });
    await request(server, release, approval, "acquireExclusiveLock", {}, "record-lock");
    await expect(request(server, release, approval, "writeReleaseRecord", { event: "promotion_passed" }, "record-forged-success")).rejects.toMatchObject({ code: "phase_invalid" });
    await expect(request(server, release, approval, "writeReleaseRecord", { event: "lock_acquired" }, "record-lock-event")).resolves.toMatchObject({ ok: true });
    await expect(request(server, release, approval, "writeReleaseRecord", { event: "lock_acquired" }, "record-lock-event-again")).rejects.toMatchObject({ code: "phase_invalid" });
  });

  it("keeps the integrated broker operation surface asynchronous and ordered", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease("async-transport", "github-environment-production-migration"); const approval = makeApproval(privateKey, release); const server = makeServer(config, publicKey); const transport = async (request: object) => { await Promise.resolve(); const response = await server.handle(request); if (!response.ok) throw new Error("broker_transport_failed"); return response.result; }; const operations = broker.createRootfulBrokerOperations({ config, release, approval, transport }).operations;
    await expect(operations.classifyReleaseDiff(config.appDir, OLD_SHA, NEW_SHA)).resolves.toMatchObject({ paths: [expect.any(String)] });
    const releaseLock = await operations.acquireExclusiveLock(); await expect(operations.readPreflightEvidence()).resolves.toMatchObject({ releaseId: release.releaseId }); await expect(operations.inspectCheckout()).resolves.toMatchObject({ currentSha: OLD_SHA }); await expect(operations.computeReleaseDiff(config.appDir, OLD_SHA, NEW_SHA)).resolves.toMatchObject({ newSha: NEW_SHA }); await expect(operations.inspectRuntime()).resolves.toMatchObject({ candidates: [expect.any(Object)] });
    await operations.writeReleaseRecord("ignored-by-broker", JSON.stringify({ event: "lock_acquired", forged: "ignored" })); await expect(operations.writeReleaseRecord("ignored-by-broker", JSON.stringify({ event: "lock_acquired" }))).rejects.toMatchObject({ code: "phase_invalid" }); await expect(releaseLock()).resolves.toBe(true);
  });

  it("rejects Docker or sudo group identities", () => {
    const config = makeConfig(); config.operator.groupNames = ["docker"]; expect(() => broker.validateBrokerConfig(config, config.appDir)).toThrow(/operator_identity_invalid/i); config.operator.groupNames = ["sudo"]; expect(() => broker.validateBrokerConfig(config, config.appDir)).toThrow(/operator_identity_invalid/i);
  });

  it("enforces lock/phase sequencing and distinct migration authority", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const migration = makeRelease("migration-1", "github-environment-production-migration"); const migrationApproval = makeApproval(privateKey, migration); const server = makeServer(config, publicKey);
    await expect(request(server, migration, migrationApproval, "stopRuntime", {}, "stop-before-lock")).rejects.toHaveProperty("code", "lock_conflict");
    const normal = makeRelease("normal-1"); await expect(request(server, normal, makeApproval(privateKey, normal), "runMigrationRunner", { releaseId: normal.releaseId, targetSha: NEW_SHA, migrationManifestDigest: DIGEST, migrationNames: ["migration"] }, "migration-bypass")).rejects.toHaveProperty("code", "approval_scope_invalid");
    await request(server, migration, migrationApproval, "acquireExclusiveLock", {}, "migration-lock"); await expect(request(server, migration, migrationApproval, "stopRuntime", {}, "stop-before-evidence")).rejects.toHaveProperty("code", "phase_invalid");
  });

  it("requires the full verified migration phase before privileged promotion", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease("migration-ordered", "github-environment-production-migration"); const approval = makeApproval(privateKey, release); const server = makeServer(config, publicKey);
    await request(server, release, approval, "acquireExclusiveLock", {}, "ordered-lock"); await request(server, release, approval, "readPreflightEvidence", {}, "ordered-evidence"); await request(server, release, approval, "inspectCheckout", {}, "ordered-checkout"); await request(server, release, approval, "computeReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "ordered-diff"); await request(server, release, approval, "inspectRuntime", {}, "ordered-runtime-before"); await request(server, release, approval, "createCandidate", { sha: NEW_SHA }, "ordered-candidate"); await request(server, release, approval, "buildCandidate", { sha: NEW_SHA }, "ordered-build");
    await request(server, release, approval, "runMigrationRunner", { releaseId: release.releaseId, targetSha: NEW_SHA, migrationManifestDigest: DIGEST, migrationNames: ["20261119_add_field"] }, "ordered-migration"); await request(server, release, approval, "verifyMigration", { targetSha: NEW_SHA, migrationNames: ["20261119_add_field"] }, "ordered-verify-migration"); await request(server, release, approval, "inspectRuntime", {}, "ordered-runtime-promotion"); await request(server, release, approval, "verifyPromotedArtifact", { sha: NEW_SHA }, "ordered-artifact"); await request(server, release, approval, "stopRuntime", {}, "ordered-stop"); await request(server, release, approval, "checkoutRelease", { sha: NEW_SHA }, "ordered-checkout-release"); await request(server, release, approval, "startRuntime", { sha: NEW_SHA }, "ordered-start"); await request(server, release, approval, "inspectRuntime", {}, "ordered-runtime-after"); await request(server, release, approval, "healthCheck", {}, "ordered-health"); await request(server, release, approval, "cleanupCandidate", { sha: NEW_SHA }, "ordered-cleanup");
    await expect(request(server, release, approval, "releaseExclusiveLock", {}, "ordered-release")).resolves.toMatchObject({ ok: true });
  });

  it("rejects repeated irreversible phases even with fresh request IDs and valid signatures", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease("no-repeat", "github-environment-production-migration"); const approval = makeApproval(privateKey, release); const server = makeServer(config, publicKey);
    await request(server, release, approval, "acquireExclusiveLock", {}, "repeat-lock"); await request(server, release, approval, "readPreflightEvidence", {}, "repeat-evidence"); await request(server, release, approval, "inspectCheckout", {}, "repeat-checkout"); await request(server, release, approval, "computeReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "repeat-diff"); await request(server, release, approval, "inspectRuntime", {}, "repeat-runtime-before"); await request(server, release, approval, "createCandidate", { sha: NEW_SHA }, "repeat-candidate"); await request(server, release, approval, "buildCandidate", { sha: NEW_SHA }, "repeat-build");
    await request(server, release, approval, "runMigrationRunner", { releaseId: release.releaseId, targetSha: NEW_SHA, migrationManifestDigest: DIGEST, migrationNames: ["migration"] }, "repeat-migration");
    await expect(request(server, release, approval, "runMigrationRunner", { releaseId: release.releaseId, targetSha: NEW_SHA, migrationManifestDigest: DIGEST, migrationNames: ["migration"] }, "repeat-migration-again")).rejects.toHaveProperty("code", "phase_invalid");
    await request(server, release, approval, "verifyMigration", { targetSha: NEW_SHA, migrationNames: ["migration"] }, "repeat-verify"); await request(server, release, approval, "inspectRuntime", {}, "repeat-promotion-runtime"); await request(server, release, approval, "verifyPromotedArtifact", { sha: NEW_SHA }, "repeat-artifact"); await request(server, release, approval, "stopRuntime", {}, "repeat-stop");
    await expect(request(server, release, approval, "stopRuntime", {}, "repeat-stop-again")).rejects.toHaveProperty("code", "phase_invalid");
    await request(server, release, approval, "checkoutRelease", { sha: NEW_SHA }, "repeat-release-checkout"); await request(server, release, approval, "startRuntime", { sha: NEW_SHA }, "repeat-start"); await request(server, release, approval, "inspectRuntime", {}, "repeat-runtime-after"); await request(server, release, approval, "healthCheck", {}, "repeat-health");
    await expect(request(server, release, approval, "healthCheck", {}, "repeat-health-again")).rejects.toHaveProperty("code", "phase_invalid");
  });

  it("propagates ambiguous handler failure to durable global recovery blocking", async () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-recovery-"));
    try {
      const config = makeConfig(); config.statePath = join(root, "broker-state.json"); const store = broker.createDurableBrokerStateStore({ statePath: config.statePath }); const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const release = makeRelease("recovery-1", "github-environment-production-migration"); const approval = makeApproval(privateKey, release);
      const options = { stateStore: store, approvalVerifierFactory: (consumedNonces: Set<string>) => broker.createEd25519ApprovalVerifier({ publicKey, consumedNonces }) };
      const server = makeServer(config, publicKey, { stopRuntime: () => { throw new Error("ambiguous stop"); } }, options);
      await request(server, release, approval, "acquireExclusiveLock", {}, "recovery-lock"); await request(server, release, approval, "readPreflightEvidence", {}, "recovery-evidence"); await request(server, release, approval, "inspectCheckout", {}, "recovery-checkout"); await request(server, release, approval, "computeReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "recovery-diff"); await request(server, release, approval, "inspectRuntime", {}, "recovery-runtime"); await request(server, release, approval, "createCandidate", { sha: NEW_SHA }, "recovery-candidate"); await request(server, release, approval, "buildCandidate", { sha: NEW_SHA }, "recovery-build"); await request(server, release, approval, "runMigrationRunner", { releaseId: release.releaseId, targetSha: NEW_SHA, migrationManifestDigest: DIGEST, migrationNames: ["migration"] }, "recovery-migration"); await request(server, release, approval, "verifyMigration", { targetSha: NEW_SHA, migrationNames: ["migration"] }, "recovery-verify"); await request(server, release, approval, "inspectRuntime", {}, "recovery-promotion-runtime"); await request(server, release, approval, "verifyPromotedArtifact", { sha: NEW_SHA }, "recovery-artifact");
      await expect(request(server, release, approval, "stopRuntime", {}, "recovery-stop")).rejects.toThrow("ambiguous stop");
      await expect(request(server, release, approval, "releaseExclusiveLock", {}, "recovery-release")).resolves.toMatchObject({ ok: true });
      const second = makeRelease("recovery-2", "github-environment-production-migration"); const restarted = makeServer(config, publicKey, {}, options);
      await expect(request(restarted, second, makeApproval(privateKey, second), "acquireExclusiveLock", {}, "recovery-new-session")).rejects.toMatchObject({ code: "broker_recovery_required" });
      expect(JSON.parse(readFileSync(config.statePath, "utf8")).recoveryRequired).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("supports a non-migration release through the same locked preflight boundary", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease("non-migration"); const approval = makeApproval(privateKey, release);
    const server = makeServer(config, publicKey, { classifyReleaseDiff: (_payload: unknown, context: { release: ReturnType<typeof makeRelease> }) => makeDiff(context.release, []) });
    await expect(request(server, release, approval, "runNonMigration", { oldSha: OLD_SHA, newSha: NEW_SHA }, "non-migration-before-preflight")).rejects.toHaveProperty("code", "lock_conflict");
    await request(server, release, approval, "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "non-migration-classify"); await request(server, release, approval, "acquireExclusiveLock", {}, "non-migration-lock"); await request(server, release, approval, "readPreflightEvidence", {}, "non-migration-evidence"); await request(server, release, approval, "inspectCheckout", {}, "non-migration-checkout"); await request(server, release, approval, "inspectRuntime", {}, "non-migration-runtime");
    await expect(request(server, release, approval, "runNonMigration", { oldSha: OLD_SHA, newSha: NEW_SHA }, "non-migration-run")).resolves.toMatchObject({ ok: true }); await expect(request(server, release, approval, "releaseExclusiveLock", {}, "non-migration-release")).resolves.toMatchObject({ ok: true });
  });

  it("enforces one broker-wide lock owner", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const server = makeServer(config, publicKey); const first = makeRelease("session-1"); const second = makeRelease("session-2");
    await expect(request(server, first, makeApproval(privateKey, first), "acquireExclusiveLock", {}, "lock-1")).resolves.toMatchObject({ ok: true }); await expect(request(server, second, makeApproval(privateKey, second), "acquireExclusiveLock", {}, "lock-2")).rejects.toMatchObject({ code: "lock_conflict" }); await expect(request(server, first, makeApproval(privateKey, first), "releaseExclusiveLock", {}, "unlock-1")).resolves.toMatchObject({ ok: true });
  });

  it("persists replay state and fails closed after an interrupted restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-state-"));
    try {
      const config = makeConfig(); config.statePath = join(root, "broker-state.json"); const store = broker.createDurableBrokerStateStore({ statePath: config.statePath }); const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const release = makeRelease("durable-1"); const approval = makeApproval(privateKey, release, "durable-once");
      const options = { stateStore: store, approvalVerifierFactory: (consumedNonces: Set<string>) => broker.createEd25519ApprovalVerifier({ publicKey, consumedNonces }) };
      const firstServer = makeServer(config, publicKey, {}, options); await request(firstServer, release, approval, "acquireExclusiveLock", {}, "durable-lock"); const restarted = makeServer(config, publicKey, {}, options); await expect(request(restarted, release, approval, "releaseExclusiveLock", {}, "durable-release")).resolves.toMatchObject({ ok: true }); const secondAfterRecovery = makeRelease("durable-recovery-2"); await expect(request(restarted, secondAfterRecovery, makeApproval(privateKey, secondAfterRecovery), "acquireExclusiveLock", {}, "durable-recovery-new-session")).rejects.toMatchObject({ code: "broker_recovery_required" }); expect(JSON.parse(readFileSync(config.statePath, "utf8")).recoveryRequired).toBe(true);
      const cleanRoot = mkdtempSync(join(tmpdir(), "clashcookies-broker-clean-state-"));
      try {
        const cleanConfig = makeConfig(); cleanConfig.statePath = join(cleanRoot, "broker-state.json"); const cleanStore = broker.createDurableBrokerStateStore({ statePath: cleanConfig.statePath }); const cleanServer = makeServer(cleanConfig, publicKey, {}, { stateStore: cleanStore, approvalVerifierFactory: options.approvalVerifierFactory });
        await request(cleanServer, release, approval, "acquireExclusiveLock", {}, "clean-lock"); await request(cleanServer, release, approval, "releaseExclusiveLock", {}, "clean-release"); const afterRestart = makeServer(cleanConfig, publicKey, {}, { stateStore: cleanStore, approvalVerifierFactory: options.approvalVerifierFactory }); const second = makeRelease("durable-2"); await expect(request(afterRestart, second, makeApproval(privateKey, second, "durable-once"), "classifyReleaseDiff", { oldSha: OLD_SHA, newSha: NEW_SHA }, "reused-after-restart")).rejects.toMatchObject({ code: "approval_invalid" });
      } finally { rmSync(cleanRoot, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when Linux state-file or parent-directory synchronization fails", () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-fsync-"));
    const statePath = join(root, "broker-state.json");
    const state = {
      version: 1,
      consumedNonces: ["production-broker:nonce"],
      requestIds: ["request-1"],
      sessions: {},
      lockOwnerSession: null,
      recoveryRequired: false,
    };
    const realFs = require("node:fs") as typeof import("node:fs");
    try {
      let syncCount = 0;
      const failingFileFs = {
        ...realFs,
        fsyncSync: () => {
          syncCount += 1;
          throw new Error("file_fsync_failed");
        },
      };
      const fileStore = broker.createDurableBrokerStateStore({ statePath, fsImpl: failingFileFs, platform: "linux" });
      expect(() => fileStore.save(state)).toThrow(/state_write_failed/i);

      syncCount = 0;
      const failingDirectoryFs = {
        ...realFs,
        fsyncSync: () => {
          syncCount += 1;
          if (syncCount === 2) throw new Error("directory_fsync_failed");
        },
      };
      const directoryStore = broker.createDurableBrokerStateStore({ statePath, fsImpl: failingDirectoryFs, platform: "linux" });
      expect(() => directoryStore.save(state)).toThrow(/state_write_failed/i);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ consumedNonces: state.consumedNonces });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a verified pre-owned socket activation boundary", () => {
    const config = makeConfig(); expect(() => broker.createUnixBrokerListener({ server: { handle: async () => ({ ok: true }) }, socketPath: config.socketPath, peerIdentityResolver: () => config.operator })).toThrow(/listener_configuration_invalid/i);
    const fakeFs = { fstatSync: () => ({ uid: 1000, gid: 1001, mode: 0o140660, isSocket: () => true }), lstatSync: () => ({ uid: 0, gid: 1001, mode: 0o140660, isSocket: () => true }) };
    expect(() => broker.verifySocketActivationBoundary({ fd: 3, socketPath: config.socketPath, operator: config.operator, activation: { listenPid: process.pid, listenFds: 1, listenFd: 3 }, fsImpl: fakeFs })).toThrow(/socket_boundary_mismatch/i);
  });

  it.runIf(process.platform === "linux" && typeof process.getuid === "function" && process.getuid() > 0)("verifies a real Linux socket fd against the operator-owned activation path", async () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-linux-socket-")); const socketPath = join(root, "broker.sock"); const listener = createServer();
    try {
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(socketPath, resolve); });
      chmodSync(socketPath, 0o600);
      const fd = (listener as unknown as { _handle?: { fd?: number } })._handle?.fd;
      const uid = process.getuid(); const gid = process.getgid();
      expect(Number.isInteger(fd)).toBe(true); expect(lstatSync(socketPath).mode & 0o7777).toBe(0o600);
      const boundary = broker.verifySocketActivationBoundary({
        fd,
        socketPath,
        operator: { uid, gid, supplementaryGids: [], groupNames: ["clashcookies-deploy"] },
        activation: { listenPid: process.pid, listenFds: 1, listenFd: fd },
      });
      expect(boundary).toMatchObject({ verified: true, exclusiveIdentity: true, activationVerified: true, ownerUid: uid, ownerGid: gid, mode: 0o600 });
    } finally { await new Promise<void>((resolve) => listener.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when a privileged operation or transport is unavailable", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const config = makeConfig(); const release = makeRelease("migration-unavailable", "github-environment-production-migration"); const approval = makeApproval(privateKey, release); const server = makeServer(config, publicKey); const operations = broker.createRootfulBrokerOperations({ config, release, approval, transport: broker.createInMemoryTransport(server) }).operations;
    await expect(operations.buildCandidate({ sha: NEW_SHA })).rejects.toHaveProperty("code", "lock_conflict"); expect(() => broker.createRootfulBrokerOperations({ config, release, approval })).toThrow(/broker_transport_required/i);
  });
});
