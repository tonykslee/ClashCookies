import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The adapter is intentionally JavaScript so the VM wrapper can load the
// contract without importing the application runtime.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapter = require("../ops/deploy/direct-docker-adapter.js") as typeof import("../ops/deploy/direct-docker-adapter.js");

const roots = new Set<string>();

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-direct-adapter-"));
  roots.add(root);
  return root;
}

function makeExecutorAuthorization(root: string, digest: string) {
  return {
    authorizationStatus: "PASS",
    scope: "immutable-deployment-entrypoint",
    canonicalPath: join(root, "executor.sh"),
    approvedSha256: digest,
    approvedOwnerUid: 0,
    approvedOwnerGid: 0,
    approvedMode: 0o755,
    operatorUid: 1000,
    operatorGids: [1000],
  };
}

function makeConfig(root = makeRoot()): Record<string, unknown> {
  return {
    adapterEnabled: true,
    verificationStatus: "PASS",
    targetEnvironment: "production",
    appDir: join(root, "app"),
    runtime: {
      name: "clashcookies-app",
      label: "active",
      environment: "prod",
      hostPort: 8085,
      containerPort: 8080,
      image: "node:20-bookworm",
      network: "clashcookies-prod_default",
    },
    executor: {
      path: join(root, "executor.sh"),
      sha256: "a".repeat(64),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o755,
      authorization: makeExecutorAuthorization(root, "a".repeat(64)),
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
      releasePath: join(root, "release.lock"),
      runnerPath: join(root, "runner.lock"),
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

function makeProtectedFs(root: string, executorContent: Buffer, credentialContent: string) {
  const openFiles = new Map<number, string>();
  const statFor = (filePath: string) => {
    const normalized = filePath.replaceAll("\\", "/");
    if (normalized.endsWith("/executor.sh")) {
      return {
        dev: 1, ino: 1, uid: 0, gid: 0, mode: 0o100755,
        isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false,
      };
    }
    if (normalized.endsWith("/database-url.credential")) {
      return {
        dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o100600,
        isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false,
      };
    }
    if (normalized.endsWith("/release-record.jsonl")) {
      return {
        dev: 1, ino: 3, uid: 0, gid: 0, mode: 0o100640,
        isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false,
      };
    }
    return {
      dev: 1, ino: 4, uid: 0, gid: 0, mode: 0o40755,
      isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true,
    };
  };
  return {
    constants: { O_RDONLY: 1, O_WRONLY: 2, O_APPEND: 4, O_NOFOLLOW: 8 },
    lstatSync: (filePath: string) => statFor(filePath),
    realpathSync: (filePath: string) => filePath,
    openSync: (filePath: string) => {
      const fd = openFiles.size + 10;
      openFiles.set(fd, filePath);
      return fd;
    },
    fstatSync: (fd: number) => statFor(openFiles.get(fd) || join(root, "unknown")),
    closeSync: (fd: number) => openFiles.delete(fd),
    readFileSync: (fd: number) => {
      const filePath = openFiles.get(fd) || "";
      return filePath.endsWith("executor.sh") ? executorContent : credentialContent;
    },
    writeSync: () => undefined,
  };
}

function makeEntryPointFs(
  root: string,
  executorContent: Buffer,
  options: {
    executorStat?: Record<string, unknown>;
    parentStat?: Record<string, unknown>;
    fstatSequence?: Array<Record<string, unknown>>;
    symlinkPath?: string;
    missingExecutor?: boolean;
  } = {},
) {
  const openFiles = new Map<number, string>();
  const defaultExecutorStat = {
    dev: 1,
    ino: 1,
    uid: 0,
    gid: 0,
    mode: 0o100755,
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => false,
  };
  const defaultParentStat = {
    dev: 1,
    ino: 2,
    uid: 0,
    gid: 0,
    mode: 0o40755,
    isSymbolicLink: () => false,
    isFile: () => false,
    isDirectory: () => true,
  };
  const fstatSequence = [...(options.fstatSequence || [])];
  const statFor = (filePath: string) => {
    const normalized = filePath.replaceAll("\\", "/");
    if (normalized.endsWith("/executor.sh")) {
      if (options.missingExecutor) throw new Error("missing");
      return options.executorStat || defaultExecutorStat;
    }
    if (options.symlinkPath && normalized === options.symlinkPath.replaceAll("\\", "/")) {
      return {
        ...defaultParentStat,
        isSymbolicLink: () => true,
      };
    }
    return options.parentStat || defaultParentStat;
  };
  return {
    constants: { O_RDONLY: 1, O_NOFOLLOW: 2 },
    lstatSync: (filePath: string) => statFor(filePath),
    realpathSync: (filePath: string) => filePath,
    openSync: (filePath: string) => {
      const fd = openFiles.size + 10;
      openFiles.set(fd, filePath);
      return fd;
    },
    fstatSync: (fd: number) => fstatSequence.shift() || statFor(openFiles.get(fd) || root),
    closeSync: (fd: number) => openFiles.delete(fd),
    readFileSync: () => executorContent,
  };
}

function canonicalSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    containers: [{
      id: "a".repeat(64),
      name: "clashcookies-app",
      image: "node:20-bookworm",
      state: "running",
      ports: "127.0.0.1:8085->8080/tcp",
      composeProject: "",
      composeService: "",
      runtime: "",
      environment: "",
      revision: "b".repeat(40),
      pid: "1234",
      networks: ["clashcookies-prod_default"],
      ...overrides,
    }],
    hostProcesses: [],
  };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("direct Docker production adapter contract", () => {
  it("keeps the adapter disabled without explicit verified configuration", async () => {
    const instance = adapter.createDirectDockerAdapter();

    expect(instance.config.enabled).toBe(false);
    await expect(instance.operations.inspectRuntime()).rejects.toThrow(/verified_adapter_configuration/i);
    expect(() => instance.operations.stopRuntime({})).toThrow(/verified_adapter_configuration/i);
  });

  it("requires every protected identity and ownership check before enabling", () => {
    const config = makeConfig();
    delete (config.executor as Record<string, unknown>).verified;

    expect(() => adapter.validateAdapterConfig(config)).toThrow(/identity_checks_must_be_verified/i);
  });

  it("pins enabled configuration to the reviewed canonical runtime identity", () => {
    const config = makeConfig();
    (config.runtime as Record<string, unknown>).network = "unexpected_network";

    expect(() => adapter.validateAdapterConfig(config)).toThrow(/canonical_runtime_network_mismatch/i);
  });

  it("preserves empty Docker label fields with the non-whitespace delimiter", () => {
    const containers = adapter.parseDockerContainerListing(
      `${"a".repeat(64)}|clashcookies-app|node:20-bookworm|127.0.0.1:8085->8080/tcp|||active|prod|${"b".repeat(40)}|1234`,
    );
    const volumes = adapter.parseDockerVolumeListing("clashcookies-prod_node_modules|local");
    const networks = adapter.parseDockerNetworkListing("clashcookies-prod_default|bridge||default");

    expect(containers[0]).toMatchObject({
      composeProject: "",
      composeService: "",
      runtime: "active",
      environment: "prod",
    });
    expect(volumes[0]).toEqual({ name: "clashcookies-prod_node_modules", driver: "local" });
    expect(networks[0]).toEqual({
      name: "clashcookies-prod_default",
      driver: "bridge",
      composeProject: "",
      composeNetwork: "default",
    });
  });

  it("rejects malformed Docker rows instead of shifting metadata", () => {
    expect(() => adapter.parseDockerContainerListing("app|node:20-bookworm|active"))
      .toThrow(/container_metadata_ambiguous/i);
    expect(() => adapter.parseDockerVolumeListing("volume|local|unexpected"))
      .toThrow(/volume_metadata_ambiguous/i);
    expect(() => adapter.parseDockerNetworkListing("network|bridge|only-three"))
      .toThrow(/network_metadata_ambiguous/i);
  });

  it("collects a bounded canonical runtime snapshot through only read-only allowlisted commands", async () => {
    const id = "a".repeat(64);
    const revision = "b".repeat(40);
    const calls: Array<Record<string, unknown>> = [];
    const collector = adapter.createDockerRuntimeEvidenceCollector({
      executor: async (request: Record<string, unknown>) => {
        calls.push(request);
        expect(request.shell).toBe(false);
        const args = request.args as string[];
        if (request.command === "docker" && args[1] === "ls") {
          return {
            exitCode: 0,
            stdout: `${id}|clashcookies-app|node:20-bookworm|running|127.0.0.1:8085->8080/tcp|clashcookies-prod_default\n`,
          };
        }
        if (request.command === "docker" && args[1] === "inspect") {
          return {
            exitCode: 0,
            stdout: `${id}|/clashcookies-app|node:20-bookworm|running|1234|||||${revision}\n`,
          };
        }
        if (request.command === "ps") {
          return { exitCode: 0, stdout: `1234 1000 node S 0::/docker/${id}\n` };
        }
        throw new Error("unexpected command");
      },
    });

    const snapshot = await collector.collect();
    expect(snapshot).toEqual({
      containers: [{
        id,
        name: "clashcookies-app",
        image: "node:20-bookworm",
        state: "running",
        ports: "127.0.0.1:8085->8080/tcp",
        networks: ["clashcookies-prod_default"],
        composeProject: "",
        composeService: "",
        runtime: "",
        environment: "",
        revision,
        pid: "1234",
      }],
      hostProcesses: [{
        pid: "1234",
        uid: "1000",
        comm: "node",
        state: "S",
        cwdScope: "container",
        containerId: id,
      }],
    });
    expect(adapter.inspectRuntimeSnapshot(snapshot, adapter.validateAdapterConfig(makeConfig()))).toMatchObject({
      candidates: [{ name: "clashcookies-app", recognized: true, revision }],
    });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => `${call.command}:${(call.args as string[]).slice(0, 2).join("/")}`))
      .toEqual(["docker:container/ls", "docker:container/inspect", "ps:--no-headers/-eo"]);
    expect(calls.every((call) => !(call.args as string[]).includes("exec"))).toBe(true);
  });

  it("accepts an exposed-only Compose PostgreSQL port beside the canonical app", async () => {
    const appId = "a".repeat(64);
    const databaseId = "c".repeat(64);
    const revision = "b".repeat(40);
    const collector = adapter.createDockerRuntimeEvidenceCollector({
      executor: async (request: Record<string, unknown>) => {
        const args = request.args as string[];
        if (args[1] === "ls") {
          return {
            exitCode: 0,
            stdout: [
              `${appId}|clashcookies-app|node:20-bookworm|running|127.0.0.1:8085->8080/tcp|clashcookies-prod_default`,
              `${databaseId}|clashcookies-db|postgres:17|running|5432/tcp|clashcookies-prod_default`,
            ].join("\n") + "\n",
          };
        }
        if (args[1] === "inspect") {
          return {
            exitCode: 0,
            stdout: [
              `${appId}|/clashcookies-app|node:20-bookworm|running|1234|||||${revision}`,
              `${databaseId}|/clashcookies-db|postgres:17|running|2345|clashcookies-prod|db|||`,
            ].join("\n") + "\n",
          };
        }
        if (request.command === "ps") {
          return { exitCode: 0, stdout: `1234 1000 node S 0::/docker/${appId}\n` };
        }
        throw new Error("unexpected command");
      },
    });

    const snapshot = await collector.collect();
    expect(snapshot.containers).toHaveLength(2);
    expect(snapshot.containers[1]).toMatchObject({
      id: databaseId,
      image: "postgres:17",
      ports: "5432/tcp",
      composeProject: "clashcookies-prod",
      composeService: "db",
    });
    expect(adapter.inspectRuntimeSnapshot(snapshot, adapter.validateAdapterConfig(makeConfig()))).toMatchObject({
      candidates: [{ name: "clashcookies-app", recognized: true, revision }],
    });
  });

  it("distinguishes exposed-only and published Docker ports while rejecting malformed entries", () => {
    expect(adapter.parsePublishedPortBindings("5432/tcp,8080/udp")).toEqual([
      { kind: "exposed", containerPort: 5432, protocol: "tcp" },
      { kind: "exposed", containerPort: 8080, protocol: "udp" },
    ]);
    expect(adapter.parsePublishedPortBindings("127.0.0.1:8085->8080/tcp")).toEqual([{
      kind: "published",
      hostAddress: "127.0.0.1",
      hostPort: 8085,
      containerPort: 8080,
      protocol: "tcp",
    }]);
    expect(() => adapter.parsePublishedPortBindings("5432")).toThrow(/ports_malformed/i);
    expect(() => adapter.parsePublishedPortBindings("127.0.0.1:8085->8080/tcp,garbage"))
      .toThrow(/ports_malformed/i);
  });

  it.each([
    ["command failure", { exitCode: 17, stdout: "" }],
    ["timeout", { exitCode: 0, stdout: "", timedOut: true }],
    ["unexpected status", { exitCode: 0, status: 17, stdout: "" }],
    ["oversized output", { exitCode: 0, stdout: "x".repeat(65_537) }],
  ])("fails closed for %s collector evidence", async (_label, result) => {
    const collector = adapter.createDockerRuntimeEvidenceCollector({
      maxOutputBytes: 65_536,
      executor: async () => result,
    });
    await expect(collector.collect()).rejects.toThrow();
  });

  it("rejects stale or contradictory Docker views before runtime validation", async () => {
    const id = "a".repeat(64);
    const collector = adapter.createDockerRuntimeEvidenceCollector({
      executor: async (request: Record<string, unknown>) => {
        const args = request.args as string[];
        if (args[1] === "ls") {
          return { exitCode: 0, stdout: `${id}|clashcookies-app|node:20-bookworm|running|127.0.0.1:8085->8080/tcp|clashcookies-prod_default\n` };
        }
        if (args[1] === "inspect") {
          return { exitCode: 0, stdout: `${id}|/clashcookies-app|postgres:17|running|1234|||||${"b".repeat(40)}\n` };
        }
        return { exitCode: 0, stdout: "" };
      },
    });
    await expect(collector.collect()).rejects.toThrow(/contradictory/i);
  });

  it("normalizes host process cgroups without collecting command arguments", () => {
    expect(adapter.parseHostProcessListing(
      `123 1000 node S 0::/docker/${"a".repeat(64)}\n456 1000 yarn S 0::/\n`,
    )).toEqual([
      { pid: "123", uid: "1000", comm: "node", state: "S", cwdScope: "container", containerId: "a".repeat(64) },
      { pid: "456", uid: "1000", comm: "yarn", state: "S", cwdScope: "host", containerId: "" },
    ]);
  });

  it("normalizes one direct-Docker canonical runtime without Compose ownership", () => {
    const config = adapter.validateAdapterConfig(makeConfig());
    const result = adapter.inspectRuntimeSnapshot(canonicalSnapshot(), config);

    expect(result).toEqual({
      candidates: [{
        name: "clashcookies-app",
        label: "active",
        environment: "prod",
        port: 8085,
        recognized: true,
        revision: "b".repeat(40),
      }],
    });
  });

  it.each([
    ["duplicate container candidates", { containers: [
      canonicalSnapshot().containers[0],
      { ...canonicalSnapshot().containers[0], name: "clashcookies-app-replacement" },
    ] }],
    ["unexpected network", { containers: [{ ...canonicalSnapshot().containers[0], networks: ["wrong_network"] }] }],
    ["unexpected published port", { containers: [{ ...canonicalSnapshot().containers[0], ports: "127.0.0.1:8085->8080/tcp,127.0.0.1:9090->9090/tcp" }] }],
    ["public published port", { containers: [{ ...canonicalSnapshot().containers[0], ports: "0.0.0.0:8085->8080/tcp" }] }],
    ["malformed relevant port evidence", { containers: [{ ...canonicalSnapshot().containers[0], ports: "8080" }] }],
    ["Compose-owned app", { containers: [{ ...canonicalSnapshot().containers[0], composeProject: "clashcookies-prod", composeService: "app" }] }],
    ["wrong revision", { containers: [{ ...canonicalSnapshot().containers[0], revision: "unknown" }] }],
  ])("fails closed for %s", (_label, snapshot) => {
    const config = adapter.validateAdapterConfig(makeConfig());
    expect(() => adapter.inspectRuntimeSnapshot(snapshot, config)).toThrow();
  });

  it("treats host Node processes as potential candidates, never as proof of a duplicate", () => {
    const config = adapter.validateAdapterConfig(makeConfig());
    const correlated = adapter.inspectRuntimeSnapshot({
      ...canonicalSnapshot(),
      hostProcesses: [{
        pid: "1234",
        uid: "1000",
        comm: "node",
        state: "S",
        cwdScope: "container",
        containerId: "a".repeat(64),
      }],
    }, config);
    expect(correlated.candidates[0].recognized).toBe(true);

    expect(() => adapter.inspectRuntimeSnapshot({
      ...canonicalSnapshot(),
      hostProcesses: [{ pid: "9999", uid: "1000", comm: "node", state: "S", cwdScope: "host", containerId: "host" }],
    }, config)).toThrow(/potential_host_bot_process_present/i);

    expect(() => adapter.inspectRuntimeSnapshot({
      ...canonicalSnapshot(),
      hostProcesses: [{ pid: "1234", uid: "1000", comm: "node", state: "S", cwdScope: "unknown", containerId: "" }],
    }, config)).toThrow(/container_correlation_unknown/i);

    const parsed = adapter.parseHostProcessListing(`123|1000|node|S|other|${"a".repeat(64)}`);
    expect(parsed).toEqual([{ pid: "123", uid: "1000", comm: "node", state: "S", cwdScope: "other", containerId: "a".repeat(64) }]);
  });

  it("validates executor checksum, ownership, mode, and symlink rejection", () => {
    const root = makeRoot();
    const content = Buffer.from("reviewed executor\n");
    const digest = createHash("sha256").update(content).digest("hex");
    const fakeFs = makeEntryPointFs(root, content);

    expect(adapter.validateImmutableExecutor({
      path: join(root, "executor.sh"),
      sha256: digest,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o755,
      authorization: makeExecutorAuthorization(root, digest),
    }, join(root, "app"), fakeFs)).toMatchObject({ sha256: digest, mode: 0o755 });

    expect(() => adapter.validateImmutableExecutor({
      path: join(root, "executor.sh"),
      sha256: "a".repeat(64),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o755,
      authorization: makeExecutorAuthorization(root, "a".repeat(64)),
    }, join(root, "app"), fakeFs)).toThrow(/checksum_mismatch/i);

    const forgedConfig = makeConfig(root);
    expect(() => adapter.createDirectDockerAdapter(forgedConfig, {
      fs: makeProtectedFs(root, Buffer.from("changed executor\n"), "credential"),
    })).toThrow(/checksum_mismatch/i);
  });

  it("validates the immutable entry-point boundary and rejects fail-closed evidence gaps", () => {
    const root = makeRoot();
    const content = Buffer.from("reviewed executor\n");
    const digest = createHash("sha256").update(content).digest("hex");
    const baseExecutorStat = {
      dev: 1,
      ino: 1,
      uid: 0,
      gid: 0,
      mode: 0o100755,
      isSymbolicLink: () => false,
      isFile: () => true,
      isDirectory: () => false,
    };
    const spec = () => ({
      path: join(root, "executor.sh"),
      sha256: digest,
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o755,
      authorization: makeExecutorAuthorization(root, digest),
    });

    expect(adapter.validateImmutableExecutor(spec(), join(root, "app"), makeEntryPointFs(root, content)))
      .toMatchObject({ path: join(root, "executor.sh"), sha256: digest, authorizationStatus: "PASS" });

    const missingAuthorization = spec();
    delete (missingAuthorization as Record<string, unknown>).authorization;
    expect(() => adapter.validateImmutableExecutor(
      missingAuthorization, join(root, "app"), makeEntryPointFs(root, content),
    )).toThrow(/authorization_required/i);

    const contradictoryAuthorization = spec();
    (contradictoryAuthorization.authorization as Record<string, unknown>).approvedSha256 = "f".repeat(64);
    expect(() => adapter.validateImmutableExecutor(
      contradictoryAuthorization, join(root, "app"), makeEntryPointFs(root, content),
    )).toThrow(/authorization_sha256_contradictory/i);

    const malformedAuthorization = spec();
    malformedAuthorization.authorization = { authorizationStatus: "PASS" };
    expect(() => adapter.validateImmutableExecutor(
      malformedAuthorization, join(root, "app"), makeEntryPointFs(root, content),
    )).toThrow(/authorization_status_invalid/i);

    expect(() => adapter.validateImmutableExecutor(
      spec(), join(root, "app"), makeEntryPointFs(root, content, { missingExecutor: true }),
    )).toThrow();

    expect(() => adapter.validateImmutableExecutor(
      spec(), join(root, "app"), makeEntryPointFs(root, content, {
        executorStat: { ...baseExecutorStat, isSymbolicLink: () => true, isFile: () => false },
      }),
    )).toThrow(/symlink_component/i);

    const parentSymlinkPath = join(root, "link", "executor.sh");
    const parentSymlinkSpec = spec();
    parentSymlinkSpec.path = parentSymlinkPath;
    parentSymlinkSpec.authorization = {
      ...makeExecutorAuthorization(root, digest),
      canonicalPath: parentSymlinkPath,
    };
    expect(() => adapter.validateImmutableExecutor(
      parentSymlinkSpec, join(root, "app"), makeEntryPointFs(root, content, { symlinkPath: join(root, "link") }),
    )).toThrow(/symlink_component/i);

    expect(() => adapter.validateImmutableExecutor(
      spec(), join(root, "app"), makeEntryPointFs(root, content, {
        executorStat: { ...baseExecutorStat, uid: 1001 },
      }),
    )).toThrow(/owner_mismatch/i);

    expect(() => adapter.validateImmutableExecutor(
      spec(), join(root, "app"), makeEntryPointFs(root, content, {
        executorStat: { ...baseExecutorStat, gid: 1001 },
      }),
    )).toThrow(/owner_mismatch/i);

    const writableExecutorSpec = spec();
    writableExecutorSpec.mode = 0o757;
    writableExecutorSpec.authorization = {
      ...makeExecutorAuthorization(root, digest),
      approvedMode: 0o757,
    };
    expect(() => adapter.validateImmutableExecutor(
      writableExecutorSpec, join(root, "app"), makeEntryPointFs(root, content, {
        executorStat: { ...baseExecutorStat, mode: 0o100757 },
      }),
    )).toThrow(/writable_by_operator/i);

    expect(() => adapter.validateImmutableExecutor(
      spec(), join(root, "app"), makeEntryPointFs(root, content, {
        parentStat: {
          dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o40757,
          isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true,
        },
      }),
    )).toThrow(/writable_by_operator/i);

    expect(() => adapter.validateImmutableExecutor(
      { ...spec(), path: join(root, "app", "executor.sh") }, join(root, "app"), makeEntryPointFs(root, content),
    )).toThrow(/outside_checkout/i);

    const replacedStat = { ...baseExecutorStat, ino: 99 };
    expect(() => adapter.validateImmutableExecutor(
      spec(), join(root, "app"), makeEntryPointFs(root, content, {
        fstatSequence: [baseExecutorStat, replacedStat],
      }),
    )).toThrow(/replaced_during_open/i);
  });

  it("rejects parent symlinks and replacement races for protected files", () => {
    const root = makeRoot();
    const symlinkFs = {
      lstatSync: (filePath: string) => ({
        isSymbolicLink: () => filePath === join(root, "link"),
        isFile: () => false,
        mode: 0o40755,
      }),
      realpathSync: (filePath: string) => filePath,
    };
    expect(() => adapter.validateProtectedCredentialSource({
      path: join(root, "link", "credential"),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o600,
    }, join(root, "app"), symlinkFs)).toThrow(/symlink_component/i);

    const recordStat = {
      dev: 1,
      ino: 1,
      uid: 0,
      gid: 0,
      mode: 0o100640,
      isSymbolicLink: () => false,
      isFile: () => true,
    };
    const replacementFs = {
      constants: { O_WRONLY: 1, O_APPEND: 2, O_NOFOLLOW: 4 },
      lstatSync: () => recordStat,
      realpathSync: (filePath: string) => filePath,
      openSync: () => 7,
      fstatSync: () => ({ ...recordStat, ino: 2 }),
      closeSync: () => undefined,
      writeSync: () => undefined,
    };
    expect(() => adapter.appendReleaseRecord({
      path: join(root, "release-record.jsonl"),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o640,
      appendOnlyVerified: true,
    }, join(root, "app"), "event=ok", replacementFs)).toThrow(/replaced_during_open/i);
  });

  it("validates a private credential source without returning it in metadata", () => {
    const root = makeRoot();
    const stat = {
      dev: 1,
      ino: 2,
      uid: 1000,
      gid: 1000,
      mode: 0o100600,
      isSymbolicLink: () => false,
      isFile: () => true,
    };
    const fakeFs = {
      constants: { O_RDONLY: 1, O_NOFOLLOW: 2 },
      lstatSync: () => stat,
      realpathSync: (value: string) => value,
      openSync: () => 7,
      fstatSync: () => stat,
      closeSync: () => undefined,
      readFileSync: () => "postgresql://user:password@db/clashcookies\n",
    };
    const spec = {
      path: join(root, "credential"),
      ownerUid: 1000,
      ownerGid: 1000,
      mode: 0o600,
    };

    expect(adapter.validateProtectedCredentialSource(spec, join(root, "app"), fakeFs))
      .toEqual({ path: spec.path, ownerUid: 1000, ownerGid: 1000, mode: 0o600 });
    expect(adapter.readProtectedCredential(spec, join(root, "app"), fakeFs))
      .toContain("postgresql://user:password");
  });

  it("builds a strict migration environment without inherited production credentials", () => {
    const config = adapter.validateAdapterConfig(makeConfig());
    const environment = adapter.buildMigrationChildEnvironment({
      config,
      releaseId: "release-1",
      targetSha: "b".repeat(40),
      migrationManifestDigest: "c".repeat(64),
      databaseUrl: "postgresql://user:password@db/clashcookies",
      baseEnv: {
        PATH: "/safe/bin",
        DISCORD_TOKEN: "discord-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
      },
    });

    expect(environment.PATH).toBe("/safe/bin");
    expect(environment.DATABASE_URL).toContain("postgresql://user:password");
    expect(environment).not.toHaveProperty("DISCORD_TOKEN");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).toHaveProperty("MIGRATION_ALLOWED_DB_NAME", "clashcookies");
  });

  it("keeps executable migration and injected runtime operations disabled in Phase 1", async () => {
    const root = makeRoot();
    const configInput = makeConfig(root);
    configInput.allowMutations = true;
    configInput.allowMigrationExecution = true;
    const executorContent = Buffer.from("reviewed executor\n");
    const executorDigest = createHash("sha256").update(executorContent).digest("hex");
    (configInput.executor as Record<string, unknown>).sha256 = executorDigest;
    (configInput.executor as Record<string, unknown>).authorization = makeExecutorAuthorization(root, executorDigest);
    const fakeFs = makeProtectedFs(root, executorContent, "postgresql://migration:password@db/clashcookies\n");
    let migrationCalled = false;
    let injectedInspectCalled = false;
    const instance = adapter.createDirectDockerAdapter(configInput, {
      fs: fakeFs,
      operations: {
        inspectRuntime: () => {
          injectedInspectCalled = true;
          return { bypassed: true };
        },
      },
      runMigrationRunner: () => {
        migrationCalled = true;
        return { exitCode: 0 };
      },
    });

    await expect(instance.operations.runMigrationRunner({
      repoRoot: join(root, "candidate"),
      releaseId: "release-1",
      targetSha: "b".repeat(40),
      migrationManifestDigest: "c".repeat(64),
    })).rejects.toThrow(/disabled_until_reviewed_vm_primitives/i);
    expect(migrationCalled).toBe(false);
    expect(() => instance.operations.stopRuntime({})).toThrow(/disabled_until_reviewed_vm_primitives/i);

    await expect(instance.operations.inspectRuntime()).rejects.toThrow(/reviewed_vm_snapshot/i);
    expect(injectedInspectCalled).toBe(false);
  });

  it("feeds an injected read-only collector through the existing runtime validator", async () => {
    const root = makeRoot();
    const configInput = makeConfig(root);
    const executorContent = Buffer.from("reviewed executor\n");
    const executorDigest = createHash("sha256").update(executorContent).digest("hex");
    (configInput.executor as Record<string, unknown>).sha256 = executorDigest;
    (configInput.executor as Record<string, unknown>).authorization = makeExecutorAuthorization(root, executorDigest);
    const collector = { collect: async () => canonicalSnapshot() };
    const instance = adapter.createDirectDockerAdapter(configInput, {
      fs: makeProtectedFs(root, executorContent, "credential"),
      runtimeEvidenceCollector: collector,
    });

    await expect(instance.operations.inspectRuntime()).resolves.toEqual({
      candidates: [{
        name: "clashcookies-app",
        label: "active",
        environment: "prod",
        port: 8085,
        recognized: true,
        revision: "b".repeat(40),
      }],
    });
  });

  it("requires separate outer and runner locks", () => {
    const root = makeRoot();
    expect(() => adapter.validateLockCoordination({
      releaseLockPath: join(root, "same.lock"),
      runnerLockPath: join(root, "same.lock"),
      appDir: join(root, "app"),
    })).toThrow(/must_differ/i);
  });

  it("rejects secrets, multiline data, and oversized release records", () => {
    expect(() => adapter.validateReleaseRecordLine("DATABASE_URL=hidden"))
      .toThrow(/secret_detected/i);
    expect(() => adapter.validateReleaseRecordLine("event=ok\nfield=bad"))
      .toThrow(/multiline/i);
    expect(() => adapter.validateReleaseRecordLine("x".repeat(2049)))
      .toThrow(/line_invalid/i);
  });

  it("uses append-only and no-follow flags for release records", () => {
    const root = makeRoot();
    const writes: string[] = [];
    let flags = 0;
    const fakeFs = {
      constants: { O_WRONLY: 1, O_APPEND: 2, O_NOFOLLOW: 4 },
      lstatSync: () => ({
        uid: 0,
        gid: 0,
        mode: 0o100640,
        isSymbolicLink: () => false,
        isFile: () => true,
      }),
      realpathSync: (value: string) => value,
      openSync: (_path: string, openFlags: number) => {
        flags = openFlags;
        return 7;
      },
      fstatSync: () => ({
        uid: 0,
        gid: 0,
        mode: 0o100640,
        isSymbolicLink: () => false,
        isFile: () => true,
      }),
      writeSync: (_fd: number, value: string) => writes.push(value),
      closeSync: () => undefined,
    };
    const spec = {
      path: join(root, "release-record.jsonl"),
      ownerUid: 0,
      ownerGid: 0,
      mode: 0o640,
      appendOnlyVerified: true,
    };

    adapter.appendReleaseRecord(spec, join(root, "app"), "event=success", fakeFs);

    expect(flags & fakeFs.constants.O_APPEND).toBe(fakeFs.constants.O_APPEND);
    expect(flags & fakeFs.constants.O_NOFOLLOW).toBe(fakeFs.constants.O_NOFOLLOW);
    expect(writes).toEqual(["event=success\n"]);
  });

  it("exposes the complete orchestrator operation surface", () => {
    const instance = adapter.createDirectDockerAdapter();
    expect(Object.keys(instance.operations).sort()).toEqual(
      [...adapter.ORCHESTRATOR_OPERATION_NAMES].sort(),
    );
  });
});
