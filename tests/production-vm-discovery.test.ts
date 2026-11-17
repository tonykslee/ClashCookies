import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";
const script = join(process.cwd(), "ops", "deploy", "discovery", "production-vm-discovery.sh");

function shellPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  return execFileSync(bash, ["-lc", "cygpath -u \"$DISCOVERY_TEST_PATH\""], {
    env: { ...process.env, DISCOVERY_TEST_PATH: filePath },
    encoding: "utf8",
  }).trim();
}

function runDiscovery(overrides: Record<string, string> = {}, commandScripts: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-discovery-test-"));
  const bin = join(root, "bin");
  const app = join(root, "app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "tracked.txt"), "tracked\n");
  const defaultCommandScripts = {
    docker: "exit 17",
    ps: "exit 17",
    curl: "exit 17",
    df: "exit 17",
    systemctl: "exit 17",
    psql: "exit 17",
    ...commandScripts,
  };
  for (const [name, body] of Object.entries(defaultCommandScripts)) {
    const commandPath = join(bin, name);
    writeFileSync(commandPath, `#!/usr/bin/env bash\nset -u\n${body}\n`);
    chmodSync(commandPath, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${shellPath(bin)}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
    DISCOVERY_APP_DIR: shellPath(app),
    DISCOVERY_WRAPPER_PATH: shellPath(join(root, "deploy-prod.sh")),
    DISCOVERY_LOCK_PATH: shellPath(join(root, "lock")),
    DISCOVERY_MIGRATION_LOCK_PATH: shellPath(join(root, "migration-lock")),
    DISCOVERY_EXECUTOR_PATH: shellPath(join(root, "executor.sh")),
    DISCOVERY_CREDENTIAL_PATH: shellPath(join(root, "credential")),
    DISCOVERY_RELEASE_RECORD_PATH: shellPath(join(root, "release.ndjson")),
    DISCOVERY_MAX_COMMAND_SECONDS: "2",
    ...overrides,
  };
  const output = execFileSync(bash, [script], { env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  rmSync(root, { recursive: true, force: true });
  return output;
}

function record(output: string, evidence: string) {
  return output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.evidence === evidence);
}

describe("production VM discovery shell bundle", () => {
  it("redacts wrapper contents and never emits secret-bearing lines", () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-wrapper-test-"));
    const wrapper = join(root, "deploy-prod.sh");
    writeFileSync(wrapper, "#!/usr/bin/env bash\nDEPLOY_LOCK_PATH=/run/lock/x\nDATABASE_URL=postgresql://secret-password\nmkdir -- \"$DEPLOY_LOCK_PATH\"\necho token=do-not-print\n");
    chmodSync(wrapper, 0o755);
    const output = runDiscovery({ DISCOVERY_WRAPPER_PATH: shellPath(wrapper) });
    expect(output).not.toContain("secret-password");
    expect(output).not.toContain("do-not-print");
    expect(record(output, "wrapper_identity").status).toBe("PASS");
    expect(record(output, "wrapper_control_flow").detail).toContain("redacted_sensitive_lines=2");
    rmSync(root, { recursive: true, force: true });
  });

  it("classifies denied or missing protected permissions as unknown/fail without reading contents", () => {
    const output = runDiscovery({
      DISCOVERY_EXECUTOR_PATH: "/path/that/is/not/configured",
      DISCOVERY_CREDENTIAL_PATH: "/path/that/is/not/configured",
    });
    expect(record(output, "executor_resource").status).toBe("UNKNOWN");
    expect(record(output, "credential_resource").status).toBe("UNKNOWN");
    expect(output).not.toContain("DATABASE_URL");
  });

  it("classifies denied database access as unknown without replaying command stderr", () => {
    const output = runDiscovery({ DISCOVERY_PG_SERVICE: "production-ro" }, { psql: "printf 'permission denied' >&2; exit 13" });
    expect(record(output, "database_identity").status).toBe("UNKNOWN");
    expect(output).not.toContain("permission denied");
    expect(output).not.toContain("production-ro");
  });

  it("classifies malformed runtime output and command failures as unknown", () => {
    const output = runDiscovery({}, {
      docker: "if [[ \"$*\" == *\"container ls\"* ]]; then printf '%s\\n' 'not-a-valid-row'; else exit 17; fi",
      ps: "exit 17",
      curl: "exit 17",
      df: "exit 17",
      systemctl: "exit 17",
      id: "printf '1000'",
      date: "printf '2026-11-16T00:00:00Z'",
    });
    expect(record(output, "runtime_docker").status).toBe("UNKNOWN");
    expect(record(output, "health_livez").status).toBe("UNKNOWN");
    expect(record(output, "backup_service").status).toBe("UNKNOWN");
  });

  it("bounds command output and reports the bounded failure without replaying it", () => {
    const output = runDiscovery({ DISCOVERY_MAX_OUTPUT_BYTES: "1024" }, {
      docker: "printf '%02000d' 0",
    });
    expect(output).toContain('"runtime_docker"');
    expect(output).not.toContain("00000000000000000000");
    expect(record(output, "runtime_docker").status).toBe("UNKNOWN");
  });
});
