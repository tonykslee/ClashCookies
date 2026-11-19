import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const broker = require("../ops/deploy/rootful-deployment-broker.js") as typeof import("../ops/deploy/rootful-deployment-broker.js");

const CHILD = resolve("tests", "fixtures", "rootful-broker-socket-server.js");
const MODULE = resolve("ops", "deploy", "rootful-deployment-broker.js");

function waitForLine(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("socket_server_ready_timeout")), 3000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.stderr?.on("data", () => undefined);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`socket_server_exit_${code}`));
      }
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function startActivatedBroker(mode = "success", delayMs = 25) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-socket-"));
  const socketPath = join(root, "broker.sock");
  const seed = createServer();
  await new Promise<void>((resolveListen, reject) => {
    seed.once("error", reject);
    seed.listen(socketPath, () => resolveListen());
  });
  chmodSync(socketPath, 0o600);
  const fd = (seed as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (!Number.isInteger(fd)) {
    await closeServer(seed);
    rmSync(root, { recursive: true, force: true });
    throw new Error("socket_fd_unavailable");
  }

  const child = spawn(process.execPath, [CHILD], {
    env: {
      ...process.env,
      BROKER_MODULE_PATH: MODULE,
      BROKER_SOCKET_PATH: socketPath,
      BROKER_SOCKET_MODE: mode,
      BROKER_DELAY_MS: String(delayMs),
    },
    stdio: ["ignore", "pipe", "pipe", fd],
    windowsHide: true,
  });
  await waitForLine(child, "ready\n");
  await closeServer(seed);
  return { child, root, socketPath };
}

async function rawRequest(socketPath: string, body: string): Promise<string> {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.setTimeout(2000, () => socket.destroy(new Error("raw_socket_timeout")));
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolveResponse(Buffer.concat(chunks).toString("utf8")));
    socket.on("connect", () => socket.end(body));
  });
}

describe("rootful broker real Linux Unix-socket transport", () => {
  it.runIf(process.platform === "linux")("returns delayed asynchronous responses without duplicate execution", async () => {
    const fixture = await startActivatedBroker("success", 75);
    try {
      const transport = broker.createUnixSocketTransport({ socketPath: fixture.socketPath, timeoutMs: 1000 });
      await expect(transport({ requestId: "delayed-request" })).resolves.toMatchObject({
        requestId: "delayed-request",
        delayed: true,
      });
    } finally {
      await stopChild(fixture.child);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("bounds interruption and timeout failures", async () => {
    const interrupted = await startActivatedBroker("interrupt", 25);
    try {
      const transport = broker.createUnixSocketTransport({ socketPath: interrupted.socketPath, timeoutMs: 500 });
      await expect(transport({ requestId: "interrupted-request" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      await stopChild(interrupted.child);
      rmSync(interrupted.root, { recursive: true, force: true });
    }

    const timedOut = await startActivatedBroker("success", 250);
    try {
      const transport = broker.createUnixSocketTransport({ socketPath: timedOut.socketPath, timeoutMs: 35 });
      await expect(transport({ requestId: "timeout-request" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      await stopChild(timedOut.child);
      rmSync(timedOut.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("returns a bounded error for malformed requests", async () => {
    const fixture = await startActivatedBroker("success");
    try {
      const response = await rawRequest(fixture.socketPath, "not-json\n");
      expect(JSON.parse(response)).toMatchObject({ ok: false, error: { message: "broker request rejected" } });
    } finally {
      await stopChild(fixture.child);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("rejects incomplete responses and oversized response frames", async () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-response-"));
    const incompletePath = join(root, "incomplete.sock");
    const server = createServer((socket) => socket.end("{\"ok\":true"));
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(incompletePath, resolveListen);
    });
    try {
      const transport = broker.createUnixSocketTransport({ socketPath: incompletePath, timeoutMs: 500 });
      await expect(transport({ requestId: "incomplete-response" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      await closeServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("rejects an oversized response without unbounded buffering", async () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-oversized-response-"));
    const socketPath = join(root, "oversized.sock");
    const server = createServer((socket) => socket.end(Buffer.alloc(256, 65)));
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });
    try {
      const transport = broker.createUnixSocketTransport({ socketPath, timeoutMs: 500, maxResponseBytes: 64 });
      await expect(transport({ requestId: "oversized-response" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      await closeServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
