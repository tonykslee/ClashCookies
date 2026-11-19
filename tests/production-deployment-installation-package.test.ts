import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(__dirname, "..");
const socketUnit = readFileSync(
  resolve(repositoryRoot, "ops/deploy/systemd/clashcookies-deployment-broker.socket"),
  "utf8",
);
const serviceUnit = readFileSync(
  resolve(repositoryRoot, "ops/deploy/systemd/clashcookies-deployment-broker.service"),
  "utf8",
);

function assertUnitHas(unit: string, line: string): void {
  expect(unit.split(/\r?\n/)).toContain(line);
}

describe("production deployment installation package", () => {
  it("pins the broker socket to the operator-owned activation boundary", () => {
    assertUnitHas(socketUnit, "ListenStream=/run/clashcookies/deployment-broker.sock");
    assertUnitHas(socketUnit, "SocketUser=clashcookies-deploy");
    assertUnitHas(socketUnit, "SocketGroup=clashcookies-deploy");
    assertUnitHas(socketUnit, "SocketMode=0600");
    assertUnitHas(socketUnit, "DirectoryMode=0755");
    assertUnitHas(socketUnit, "Service=clashcookies-deployment-broker.service");
    expect(socketUnit).not.toContain("ExecStart=");
  });

  it("pins the root-only broker service and writable surface", () => {
    assertUnitHas(serviceUnit, "User=root");
    assertUnitHas(serviceUnit, "Group=root");
    assertUnitHas(serviceUnit, "ExecStart=/usr/bin/node /usr/local/libexec/clashcookies/rootful-deployment-broker-service.js");
    assertUnitHas(serviceUnit, "Requires=clashcookies-deployment-broker.socket");
    assertUnitHas(serviceUnit, "Restart=no");
    assertUnitHas(serviceUnit, "UMask=0077");
    assertUnitHas(serviceUnit, "NoNewPrivileges=yes");
    assertUnitHas(serviceUnit, "ProtectSystem=full");
    assertUnitHas(serviceUnit, "ReadWritePaths=/home/tilo/apps/clashcookies-prod /home/tilo/apps/clashcookies-prod-replacement /home/tilo/apps/clashcookies-prod-artifacts /run/lock /run/clashcookies /var/lib/clashcookies");
    assertUnitHas(serviceUnit, "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(serviceUnit).not.toMatch(/^Environment=.*(PASSWORD|TOKEN|SECRET|DATABASE_URL)/mi);
  });
});
