import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const service = require("../ops/deploy/rootful-deployment-broker-service.js") as typeof import("../ops/deploy/rootful-deployment-broker-service.js");

describe("rootful broker service installation boundary", () => {
  it("requires a self-contained broker-side sibling bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-broker-bundle-"));
    try {
      mkdirSync(join(root, "nested"));
      for (const relativePath of service.BROKER_SERVICE_MODULES) copyFileSync(join("ops", "deploy", relativePath), join(root, relativePath));
      expect(service.validateBrokerServiceBundle(root).files).toHaveLength(service.BROKER_SERVICE_MODULES.length);
      rmSync(join(root, "migration-runner.js"));
      expect(() => service.validateBrokerServiceBundle(root)).toThrow(/bundle_incomplete/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not synthesize peer identity or create an unverified socket", () => {
    expect(() => service.createRootfulBrokerService({ installation: { manifest: {}, publicKey: {} } })).toThrow(/socket_boundary_required/i);
  });
});
