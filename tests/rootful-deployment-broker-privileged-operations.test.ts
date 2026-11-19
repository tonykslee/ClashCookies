import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const privileged = require("../ops/deploy/rootful-deployment-broker-privileged-operations.js") as typeof import("../ops/deploy/rootful-deployment-broker-privileged-operations.js");

describe("rootful broker privileged migration boundary", () => {
  it("mounts the protected credential and never places its value in argv", () => {
    const calls: Array<{ command: string, args: string[], options: Record<string, unknown> }> = [];
    const result = privileged.executeMigrationInArtifact(
      { targetEnvironment: "production" },
      "/var/lib/clashcookies/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      { network: "clashcookies-prod_default", image: "node:20-bookworm" },
      "/etc/clashcookies/production-db.env",
      (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("docker");
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].args).toContain("--mount");
    expect(calls[0].args.join(" ")).toContain("source=/etc/clashcookies/production-db.env");
    expect(calls[0].args.join(" ")).not.toContain("DATABASE_URL=postgres");
    expect(calls[0].args.join(" ")).not.toContain("postgres://");
  });
});
