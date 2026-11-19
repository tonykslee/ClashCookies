"use strict";

const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");

const socketPath = process.env.BROKER_SOCKET_PATH;
const workerPath = process.env.BROKER_WORKER_PATH || path.join(__dirname, "rootful-broker-socket-server.js");

const seed = net.createServer();
seed.once("error", () => process.exit(92));
seed.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    process.exit(93);
  }
  const worker = spawn(process.execPath, [workerPath], {
    env: process.env,
    stdio: ["ignore", "pipe", "inherit", seed._handle.fd],
    windowsHide: true,
  });
  worker.once("error", () => process.exit(94));
  worker.stdout.on("data", (chunk) => {
    if (!chunk.toString("utf8").includes("ready\n")) return;
    // Deliberately exit without calling seed.close(): the worker owns the
    // inherited listening fd, while the pathname remains bound for clients.
    process.stdout.write(`ready:${worker.pid}\n`, () => process.exit(0));
  });
});
