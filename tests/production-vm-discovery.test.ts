import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";
const script = join(process.cwd(), "ops", "deploy", "discovery", "production-vm-discovery.sh");
const runtimeValidator = join(process.cwd(), "ops", "deploy", "discovery", "runtime-contract-validator.js");

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

function phase2bFixture(psLine = `4321 1000 node S 0::/docker/${"a".repeat(64)}`) {
  const containerId = "a".repeat(64);
  const revision = "b".repeat(40);
  return {
    docker: `
case "$*" in
  *"container inspect"*) printf '%s\\n' '${containerId}|/clashcookies-app|node:20-bookworm|running|4321|||active|prod|${revision}';;
  *"container ls --filter status=running"*) printf '%s\\n' '${containerId}|clashcookies-app|node:20-bookworm|running|127.0.0.1:8085->8080/tcp|clashcookies-prod_default';;
  *"container ls -a --filter name=staging"*) : ;;
  *"network ls --filter name=staging"*) : ;;
  *"volume ls --filter name=staging"*) : ;;
  *) : ;;
esac`,
    ps: `printf '%s\\n' '${psLine}'; exit 0`,
    curl: "printf '200'",
    df: `
if [[ "$*" == *"-Pi"* ]]; then
  printf 'Filesystem Inodes IUsed IFree IUse%% Mounted on\\n/dev/root 100 10 90 10%% /\\n'
else
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 100000 1000 99000 1%% /\\n'
fi`,
    systemctl: `
if [[ "$*" == *"is-enabled"* ]]; then printf 'disabled'; else printf 'inactive\\ndead\\nsuccess'; fi`,
    psql: `
if [[ "$*" == *"_prisma_migrations"* ]]; then
  printf 'BEGIN\\n7\\nROLLBACK\\n'
else
  printf 'BEGIN\\nprod_db|clashcookies|public|127.0.0.1|5432|160000|on\\nROLLBACK\\n'
fi`,
  };
}

function runRuntimeContractValidator(psLine = `4321 1000 node S 0::/docker/${"a".repeat(64)}`) {
  const containerId = "a".repeat(64);
  const revision = "b".repeat(40);
  const input = `LIST_BEGIN\n${containerId}|clashcookies-app|node:20-bookworm|running|127.0.0.1:8085->8080/tcp|clashcookies-prod_default\nLIST_END\nINSPECT_BEGIN\n${containerId}|/clashcookies-app|node:20-bookworm|running|4321|||active|prod|${revision}\nINSPECT_END\nPROCESS_BEGIN\n${psLine}\nPROCESS_END\n`;
  return spawnSync(process.execPath, [runtimeValidator], { input, encoding: "utf8" });
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
    expect(record(output, "executor_metadata").status).toBe("UNKNOWN");
    expect(record(output, "credential_metadata").status).toBe("UNKNOWN");
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

  it("accepts the Phase 2B runtime contract and tagged read-only PostgreSQL output", () => {
    const output = runDiscovery({ DISCOVERY_PG_SERVICE: "production-ro" }, phase2bFixture());
    const runtimeStatus = process.platform === "win32" ? "UNKNOWN" : "PASS";
    expect(record(output, "runtime_docker").status).toBe(runtimeStatus);
    expect(record(output, "runtime_identity").status).toBe(runtimeStatus);
    expect(record(output, "database_identity").status).toBe("PASS");
    expect(record(output, "prisma_migration_baseline").status).toBe("PASS");
    expect(record(output, "staging_residuals").status).toBe("PASS");
    expect(output).not.toContain("prod_db|clashcookies");
  });

  it("fails closed when the host process PID or cgroup does not match the inspected container", () => {
    const output = runDiscovery({}, phase2bFixture(`4322 1000 node S 0::/docker/${"a".repeat(64)}`));
    const runtimeStatus = process.platform === "win32" ? "UNKNOWN" : "FAIL";
    expect(record(output, "runtime_identity").status).toBe(runtimeStatus);
    if (process.platform !== "win32") {
      expect(record(output, "runtime_identity").detail).toContain("Phase 2B direct-Docker runtime contract rejected");
    }
  });

  it("does not pass staging discovery when any bounded probe fails", () => {
    const fixture = phase2bFixture();
    fixture.docker = `${fixture.docker}\nif [[ "$*" == *"volume ls --filter name=staging"* ]]; then exit 17; fi`;
    const output = runDiscovery({}, fixture);
    expect(record(output, "runtime_identity").status).toBe(process.platform === "win32" ? "UNKNOWN" : "PASS");
    expect(record(output, "staging_residuals").status).toBe("UNKNOWN");
    expect(record(output, "staging_residuals").detail).toContain("one_or_more_staging_probes_failed_or_bounded");
  });

  it("fails closed when Docker list and inspect evidence are stale", () => {
    const fixture = phase2bFixture();
    fixture.docker = fixture.docker.replace("a".repeat(64), "c".repeat(64));
    const output = runDiscovery({}, fixture);
    expect(record(output, "runtime_docker").status).toBe("UNKNOWN");
    expect(record(output, "runtime_identity").status).toBe("UNKNOWN");
  });

  it("fails closed on an extra host process candidate through the discovery entry point", () => {
    const fixture = phase2bFixture();
    fixture.ps = `printf '%s\\n' '4321 1000 node S 0::/docker/${"a".repeat(64)}' '4322 1000 node S 0::/docker/${"c".repeat(64)}'; exit 0`;
    const output = runDiscovery({}, fixture);
    const runtimeStatus = process.platform === "win32" ? "UNKNOWN" : "FAIL";
    expect(record(output, "runtime_identity").status).toBe(runtimeStatus);
  });

  it("propagates GIT_OPTIONAL_LOCKS=0 to checkout probes", () => {
    const output = runDiscovery({}, {
      git: `
if [[ "$GIT_OPTIONAL_LOCKS" != "0" ]]; then exit 91; fi
case "$*" in
  *"rev-parse"*) printf '%s' '${"d".repeat(40)}';;
  *"symbolic-ref"*) printf '%s' 'dev';;
  *"status"*) printf '%s' '## dev';;
esac`,
    });
    expect(readFileSync(script, "utf8")).toContain("GIT_OPTIONAL_LOCKS=0");
    if (process.platform !== "win32") {
      expect(record(output, "checkout_identity").status).toBe("PASS");
      expect(record(output, "checkout_unknown_files").status).toBe("PASS");
    }
  });

  it("accepts and rejects realistic Phase 2B runtime identity fixtures", () => {
    const success = runRuntimeContractValidator();
    expect(success.status).toBe(0);
    expect(success.stdout).toContain("PASS|phase2b_runtime_contract");

    const wrongPid = runRuntimeContractValidator(`4322 1000 node S 0::/docker/${"a".repeat(64)}`);
    expect(wrongPid.status).toBe(3);
    expect(wrongPid.stdout).toContain("REJECT|phase2b_runtime_contract");
  });
});
