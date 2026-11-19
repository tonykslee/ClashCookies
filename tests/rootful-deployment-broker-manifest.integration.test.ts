import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeCompleteProductionManifest } from "./fixtures/complete-production-manifest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const broker = require("../ops/deploy/rootful-deployment-broker.js") as typeof import("../ops/deploy/rootful-deployment-broker.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const entrypoint = require("../ops/deploy/production-deployment-entrypoint.js") as typeof import("../ops/deploy/production-deployment-entrypoint.js");

const ACTIVATOR = resolve("tests", "fixtures", "rootful-broker-socket-activator.js");
const WORKER = resolve("tests", "fixtures", "rootful-broker-manifest-server.js");
const MODULE = resolve("ops", "deploy", "rootful-deployment-broker.js");
const ENTRYPOINT = resolve("ops", "deploy", "production-deployment-entrypoint.js");
const SERVICE = resolve("ops", "deploy", "rootful-deployment-broker-service.js");
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const DIGEST = "c".repeat(64);

function waitForActivation(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => reject(new Error(`manifest_socket_server_ready_timeout${errorOutput ? `: ${errorOutput}` : ""}`)), 5000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/ready:(\d+)\n/);
      if (match) { clearTimeout(timer); resolveReady(Number(match[1])); }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorOutput = `${errorOutput}${chunk.toString("utf8")}`.slice(-2048);
    });
    const fail = (error: Error) => reject(new Error(`${error.message}${errorOutput ? `: ${errorOutput}` : ""}`));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) { clearTimeout(timer); fail(new Error(`manifest_socket_server_exit_${code}`)); }
    });
  });
}

async function stopPid(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await new Promise<void>((resolveExit) => {
    const deadline = Date.now() + 3000;
    const check = () => {
      try {
        process.kill(pid, 0);
        if (Date.now() < deadline) return setTimeout(check, 25);
      } catch { return resolveExit(); }
      resolveExit();
    };
    check();
  });
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

function makeRelease(sessionId: string) {
  return {
    sessionId, releaseId: `release-${sessionId}`, oldSha: OLD_SHA, newSha: NEW_SHA,
    migrationDiffDigest: DIGEST, migrationManifestDigest: DIGEST, authorizationDigest: DIGEST,
    approvedBy: "github-environment-production-migration",
  };
}

function makeApproval(privateKey: unknown, release: ReturnType<typeof makeRelease>, nonce: string) {
  const envelope = {
    keyId: "production-broker", nonce, scope: "rootful-docker-broker-migration",
    approvedBy: release.approvedBy, reviewedCommit: release.newSha,
  };
  return {
    ...envelope,
    signature: sign(null, Buffer.from(broker.approvalPayload(envelope, release)), privateKey as Parameters<typeof sign>[2]).toString("base64"),
  };
}

function shortDeadlinePolicy(runMigrationRunner: number) {
  return Object.fromEntries(Object.entries(broker.BROKER_OPERATION_DEADLINES_MS).map(([operation, value]) => [
    operation, operation === "runMigrationRunner" ? runMigrationRunner : Math.max(1000, Math.min(value, 5000)),
  ]));
}

async function startFixture({ delayMs, deadlinePolicy, release }: { delayMs: number; deadlinePolicy?: Record<string, number>; release: ReturnType<typeof makeRelease> }) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-manifest-e2e-"));
  const appDir = join(root, "app");
  const external = join(root, "protected");
  const manifest = makeCompleteProductionManifest(appDir, external) as any;
  const uid = typeof process.getuid === "function" ? process.getuid() : 1001;
  const gid = typeof process.getgid === "function" ? process.getgid() : uid;
  manifest.broker.socketPath = join(external, "broker.sock");
  manifest.broker.statePath = join(external, "broker-state.json");
  manifest.broker.operator = { uid, gid, supplementaryGids: [], groupNames: ["synthetic-deploy"] };
  manifest.credentialAccess.operatorUid = uid;
  manifest.credentialAccess.operatorGids = [gid];
  manifest.executor.authorization.operatorUid = uid;
  manifest.executor.authorization.operatorGids = [gid];
  const validated = entrypoint.validateProductionManifest(manifest);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(external, { recursive: true });
  writeFileSync(validated.broker.approval.publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(validated.broker.statePath, `${JSON.stringify({ version: 1, consumedNonces: [], requestIds: [], sessions: {}, lockOwnerSession: null, recoveryRequired: false })}\n`, { mode: 0o600 });
  chmodSync(validated.broker.statePath, 0o600);
  // The service must validate the reviewed input manifest at its own boundary.
  // The normalized return value intentionally omits the input-only verification
  // marker, so serializing it would make the child reject its own configuration.
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const socketPath = validated.broker.socketPath;
  const activator = spawn(process.execPath, [ACTIVATOR], {
    env: {
      ...process.env,
      BROKER_MODULE_PATH: MODULE,
      BROKER_WORKER_PATH: WORKER,
      BROKER_ENTRYPOINT_PATH: ENTRYPOINT,
      BROKER_SERVICE_PATH: SERVICE,
      BROKER_SOCKET_PATH: socketPath,
      BROKER_MANIFEST_PATH: join(root, "manifest.json"),
      BROKER_SOCKET_MODE: "success",
      BROKER_DELAY_MS: String(delayMs),
      BROKER_DEADLINE_POLICY: deadlinePolicy ? JSON.stringify(deadlinePolicy) : "",
      BROKER_RELEASE_ID: release.releaseId,
      BROKER_OLD_SHA: release.oldSha,
      BROKER_NEW_SHA: release.newSha,
      BROKER_DIFF_DIGEST: release.migrationDiffDigest,
      BROKER_MANIFEST_DIGEST: release.migrationManifestDigest,
      BROKER_AUTH_DIGEST: release.authorizationDigest,
      BROKER_APPROVED_BY: release.approvedBy,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const workerPid = await waitForActivation(activator);
  return { root, manifest: validated, privateKey, activator, workerPid, socketPath };
}

async function prepareMigration(operations: any, release: ReturnType<typeof makeRelease>) {
  const releaseLock = await operations.acquireExclusiveLock();
  await operations.readPreflightEvidence();
  await operations.inspectCheckout();
  await operations.computeReleaseDiff("ignored-by-broker", release.oldSha, release.newSha);
  await operations.inspectRuntime();
  await operations.createCandidate("ignored-by-broker", release.newSha);
  await operations.buildCandidate({ sha: release.newSha });
  return releaseLock;
}

describe("rootful broker complete validated-manifest Linux integration", () => {
  it.runIf(process.platform === "linux")("keeps a real delayed migration RPC alive beyond the former five-second deadline", async () => {
    const release = makeRelease("long-success");
    const fixture = await startFixture({ delayMs: 5500, release });
    try {
      const approval = makeApproval(fixture.privateKey, release, "long-success-nonce");
      const operations = entrypoint.createProductionOperations(fixture.manifest, {
        release, brokerApproval: approval, requestIdFactory: () => randomUUID(),
      });
      const releaseLock = await prepareMigration(operations, release);
      await expect(operations.runMigrationRunner({ releaseId: release.releaseId, targetSha: release.newSha, migrationManifestDigest: DIGEST, migrationNames: ["synthetic"] })).resolves.toMatchObject({ exitCode: 0 });
      await expect(releaseLock()).resolves.toBe(true);
    } finally { await stopPid(fixture.workerPid); await stopChild(fixture.activator); rmSync(fixture.root, { recursive: true, force: true }); }
  }, 15000);

  it.runIf(process.platform === "linux")("fails closed and durably blocks a timed-out or disconnected migration RPC", async () => {
    const policy = shortDeadlinePolicy(150);
    const release = makeRelease("ambiguous-migration");
    const fixture = await startFixture({ delayMs: 400, deadlinePolicy: policy, release });
    try {
      const approval = makeApproval(fixture.privateKey, release, "ambiguous-timeout");
      const normalTransport = broker.createUnixSocketTransport({ socketPath: fixture.socketPath, deadlinePolicy: policy });
      const disconnectingTransport = broker.createUnixSocketTransport({ socketPath: fixture.socketPath, deadlinePolicy: policy, timeoutMs: 50 });
      const transport = (request: any) => request.operation === "runMigrationRunner"
        ? disconnectingTransport(request)
        : normalTransport(request);
      const operations = broker.createRootfulBrokerOperations({ config: { ...fixture.manifest.broker, appDir: fixture.manifest.appDir }, release, approval, transport }).operations;
      const releaseLock = await prepareMigration(operations, release);
      await expect(operations.runMigrationRunner({ releaseId: release.releaseId, targetSha: release.newSha, migrationManifestDigest: DIGEST, migrationNames: ["synthetic"] })).rejects.toMatchObject({ code: "broker_transport_failed" });
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      expect(JSON.parse(readFileSync(fixture.manifest.broker.statePath, "utf8")).recoveryRequired).toBe(true);
      await expect(releaseLock()).resolves.toBe(true);
      const nextRelease = makeRelease("after-ambiguous");
      const nextApproval = makeApproval(fixture.privateKey, nextRelease, "after-ambiguous");
      const nextOperations = broker.createRootfulBrokerOperations({ config: { ...fixture.manifest.broker, appDir: fixture.manifest.appDir }, release: nextRelease, approval: nextApproval, transport }).operations;
      await expect(nextOperations.acquireExclusiveLock()).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally { await stopPid(fixture.workerPid); await stopChild(fixture.activator); rmSync(fixture.root, { recursive: true, force: true }); }
  }, 10000);
});
