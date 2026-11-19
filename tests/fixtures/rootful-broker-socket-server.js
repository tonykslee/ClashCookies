"use strict";

const net = require("node:net");

const broker = require(process.env.BROKER_MODULE_PATH);
const socketPath = process.env.BROKER_SOCKET_PATH;
const delayMs = Number(process.env.BROKER_DELAY_MS || 25);
const mode = process.env.BROKER_SOCKET_MODE || "success";

const operator = {
  uid: process.getuid(),
  gid: process.getgid(),
  supplementaryGids: [],
  groupNames: ["clashcookies-deploy"],
};

const socketBoundary = broker.verifySocketActivationBoundary({
  fd: 3,
  socketPath,
  operator,
  activation: {
    listenPid: process.pid,
    listenFds: 1,
    listenFd: 3,
  },
});

const server = {
  async handle(request) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (mode === "interrupt") process.exit(91);
    return { requestId: request.requestId, delayed: true };
  },
};

const listener = broker.createUnixBrokerListener({
  server,
  socketPath,
  peerIdentityResolver: () => operator,
  socketBoundary,
  requestTimeoutMs: 250,
});

listener.once("error", () => process.exit(92));
listener.once("listening", () => process.stdout.write("ready\n"));
