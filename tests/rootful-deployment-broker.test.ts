import { generateKeyPairSync, sign } from "node:crypto";
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
    operator: {
      uid: 1001,
      gid: 1001,
      supplementaryGids: [],
      groupNames: ["clashcookies-deploy"],
    },
    service: {
      uid: 0,
      gid: 0,
      dockerAccess: "rootful-socket-only",
      dockerSocket: "/var/run/docker.sock",
    },
    approval: {
      scope: "rootful-docker-broker-deployment",
      publicKeyPath: "/synthetic/protected/clashcookies-broker.pub",
      keyId: "production-broker",
    },
  };
}

function makeRelease(sessionId = "session-1") {
  return {
    sessionId,
    releaseId: `release-${sessionId}`,
    oldSha: OLD_SHA,
    newSha: NEW_SHA,
    migrationDiffDigest: DIGEST,
    migrationManifestDigest: DIGEST,
    authorizationDigest: DIGEST,
    approvedBy: "github-main-merge",
  };
}

function makeApproval(privateKey: unknown, release: ReturnType<typeof makeRelease>, nonce = `nonce-${release.sessionId}`) {
  const envelope = {
    keyId: "production-broker",
    nonce,
    scope: "rootful-docker-broker-deployment",
    approvedBy: release.approvedBy,
    reviewedCommit: release.newSha,
  };
  return {
    ...envelope,
    signature: sign(null, Buffer.from(broker.approvalPayload(envelope, release)), privateKey as Parameters<typeof sign>[2]).toString("base64"),
  };
}

function makeServer(config: ReturnType<typeof makeConfig>, publicKey: unknown, handlers = {}, state = {}) {
  return broker.createRootfulBrokerServer({
    config,
    peerIdentitySource: () => ({
      uid: config.operator.uid,
      gid: config.operator.gid,
      supplementaryGids: config.operator.supplementaryGids,
      groupNames: config.operator.groupNames,
    }),
    approvalVerifier: broker.createEd25519ApprovalVerifier({ publicKey }),
    handlers,
    state,
  });
}

function request(server: ReturnType<typeof makeServer>, release: ReturnType<typeof makeRelease>, approval: object, operation: string, payload: object = {}, requestId = `request-${operation}`) {
  return server.handle({
    protocolVersion: 1,
    requestId,
    sessionId: release.sessionId,
    operation,
    release,
    approval,
    payload,
  });
}

describe("rootful deployment broker boundary", () => {
  it("rejects an unauthorized operator and spoofed client identity claims", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const config = makeConfig();
    const release = makeRelease();
    const approval = makeApproval(privateKey, release);
    const server = broker.createRootfulBrokerServer({
      config,
      peerIdentitySource: () => ({ uid: 1002, gid: 1001, supplementaryGids: [], groupNames: ["clashcookies-deploy"] }),
      approvalVerifier: broker.createEd25519ApprovalVerifier({ publicKey }),
      handlers: { inspectRuntime: () => ({ singleton: true }) },
    });

    await expect(request(server, release, approval, "inspectRuntime")).rejects.toMatchObject({ code: "identity_invalid" });
    await expect(server.handle({
      protocolVersion: 1,
      requestId: "spoofed",
      sessionId: release.sessionId,
      operation: "inspectRuntime",
      release,
      approval,
      payload: {},
      peerIdentity: { uid: 0, gid: 0 },
    })).rejects.toMatchObject({ code: "broker_request_invalid" });
  });

  it("requires a valid release-bound approval and rejects replayed or forged approvals", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const config = makeConfig();
    const release = makeRelease();
    const approval = makeApproval(privateKey, release, "one-time");
    const server = makeServer(config, publicKey, { inspectRuntime: () => ({ singleton: true }) });
    await expect(request(server, release, { ...approval, signature: "Zm9yZ2Vk" }, "inspectRuntime"))
      .rejects.toMatchObject({ code: "approval_invalid" });
    await expect(request(server, release, approval, "inspectRuntime", {}, "valid-request")).resolves.toMatchObject({ ok: true });
    await expect(request(server, release, approval, "inspectRuntime", {}, "valid-request"))
      .rejects.toMatchObject({ code: "replay_rejected" });

    const secondRelease = makeRelease("session-2");
    const secondApproval = makeApproval(privateKey, secondRelease, "one-time");
    await expect(request(server, secondRelease, secondApproval, "inspectRuntime", {}, "second-session-request"))
      .rejects.toMatchObject({ code: "approval_invalid" });
  });

  it("allowlists operations and rejects shell, path, environment, and credential attempts", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const config = makeConfig();
    const release = makeRelease();
    const approval = makeApproval(privateKey, release);
    const server = makeServer(config, publicKey, { inspectRuntime: () => ({ singleton: true }) });
    await expect(request(server, release, approval, "exec", { command: "docker rm -f clashcookies-app" }))
      .rejects.toMatchObject({ code: "broker_request_invalid" });
    await expect(request(server, release, approval, "inspectRuntime", { path: "/etc/shadow" }, "path-attempt"))
      .rejects.toMatchObject({ code: "broker_request_invalid" });
    await expect(request(server, release, approval, "inspectRuntime", { env: { DATABASE_URL: "secret" } }, "env-attempt"))
      .rejects.toMatchObject({ code: "broker_request_invalid" });
    await expect(request(server, release, approval, "readPreflightEvidence", { credentialPath: "/etc/clashcookies/production-db.env" }, "credential-attempt"))
      .rejects.toMatchObject({ code: "broker_request_invalid" });
  });

  it("rejects docker or sudo group identities in the proposed operator contract", () => {
    const config = makeConfig();
    config.operator.groupNames = ["docker"];
    expect(() => broker.validateBrokerConfig(config, config.appDir)).toThrow(/operator_identity_invalid/i);
    config.operator.groupNames = ["sudo"];
    expect(() => broker.validateBrokerConfig(config, config.appDir)).toThrow(/operator_identity_invalid/i);
  });

  it("enforces one broker-wide lock owner across concurrent sessions", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const config = makeConfig();
    const state = {};
    const server = makeServer(config, publicKey, {
      acquireExclusiveLock: () => ({ acquired: true }),
      releaseExclusiveLock: () => ({ released: true }),
    }, state);
    const first = makeRelease("session-1");
    const second = makeRelease("session-2");
    const firstApproval = makeApproval(privateKey, first);
    const secondApproval = makeApproval(privateKey, second);
    await expect(request(server, first, firstApproval, "acquireExclusiveLock", {}, "lock-1")).resolves.toMatchObject({ ok: true });
    await expect(request(server, second, secondApproval, "acquireExclusiveLock", {}, "lock-2"))
      .rejects.toMatchObject({ code: "lock_conflict" });
    await expect(request(server, first, firstApproval, "releaseExclusiveLock", {}, "unlock-1")).resolves.toMatchObject({ ok: true });
    await expect(request(server, second, secondApproval, "acquireExclusiveLock", {}, "lock-3")).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when a privileged broker operation is unavailable", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const config = makeConfig();
    const release = makeRelease();
    const approval = makeApproval(privateKey, release);
    const server = makeServer(config, publicKey, {});
    const operations = broker.createRootfulBrokerOperations({
      config,
      release,
      approval,
      transport: broker.createInMemoryTransport(server),
    }).operations;
    await expect(operations.buildCandidate({ sha: NEW_SHA })).rejects.toMatchObject({ code: "broker_unavailable" });
  });

  it("rejects broker absence before any privileged operation is attempted", () => {
    const config = makeConfig();
    expect(() => broker.createRootfulBrokerOperations({
      config,
      release: makeRelease(),
      approval: makeApproval(generateKeyPairSync("ed25519").privateKey, makeRelease()),
    })).toThrow(/broker_transport_required/i);
  });
});
