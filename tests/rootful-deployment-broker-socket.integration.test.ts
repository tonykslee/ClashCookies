import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const broker = require("../ops/deploy/rootful-deployment-broker.js") as typeof import("../ops/deploy/rootful-deployment-broker.js");

const ACTIVATOR = resolve("tests", "fixtures", "rootful-broker-socket-activator.js");
const MODULE = resolve("ops", "deploy", "rootful-deployment-broker.js");

function waitForActivation(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("socket_server_ready_timeout")), 3000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/ready:(\d+)\n/);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
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
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
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

async function startActivatedBroker(mode = "success", delayMs = 25) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-socket-"));
  const socketPath = join(root, "broker.sock");

  const activator = spawn(process.execPath, [ACTIVATOR], {
    env: {
      ...process.env,
      BROKER_MODULE_PATH: MODULE,
      BROKER_SOCKET_PATH: socketPath,
      BROKER_SOCKET_MODE: mode,
      BROKER_DELAY_MS: String(delayMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // The activator exits only after the worker has inherited the listening fd;
  // it intentionally leaves the seed server unclosed during handoff so the
  // socket pathname remains valid for the worker's clients.
  const workerPid = await waitForActivation(activator);
  return { activator, workerPid, root, socketPath };
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
      await stopPid(fixture.workerPid);
      await stopChild(fixture.activator);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("bounds interruption and timeout failures", async () => {
    const interrupted = await startActivatedBroker("interrupt", 25);
    try {
      const transport = broker.createUnixSocketTransport({ socketPath: interrupted.socketPath, timeoutMs: 500 });
      await expect(transport({ requestId: "interrupted-request" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      await stopPid(interrupted.workerPid);
      await stopChild(interrupted.activator);
      rmSync(interrupted.root, { recursive: true, force: true });
    }

    const timedOut = await startActivatedBroker("success", 250);
    try {
      const transport = broker.createUnixSocketTransport({ socketPath: timedOut.socketPath, timeoutMs: 35 });
      await expect(transport({ requestId: "timeout-request" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      await stopPid(timedOut.workerPid);
      await stopChild(timedOut.activator);
      rmSync(timedOut.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("returns a bounded error for malformed requests", async () => {
    const fixture = await startActivatedBroker("success");
    try {
      const response = await rawRequest(fixture.socketPath, "not-json\n");
      expect(JSON.parse(response)).toMatchObject({ ok: false, error: { message: "broker request rejected" } });
    } finally {
      await stopPid(fixture.workerPid);
      await stopChild(fixture.activator);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("rejects incomplete responses and oversized response frames", async () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-response-"));
    const incompletePath = join(root, "incomplete.sock");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.end("{\"ok\":true");
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(incompletePath, resolveListen);
    });
    try {
      const transport = broker.createUnixSocketTransport({ socketPath: incompletePath, timeoutMs: 500 });
      await expect(transport({ requestId: "incomplete-response" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("rejects an oversized response without unbounded buffering", async () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-oversized-response-"));
    const socketPath = join(root, "oversized.sock");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.end(Buffer.alloc(256, 65));
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });
    try {
      const transport = broker.createUnixSocketTransport({ socketPath, timeoutMs: 500, maxResponseBytes: 64 });
      await expect(transport({ requestId: "oversized-response" })).rejects.toMatchObject({ code: "broker_transport_failed" });
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
