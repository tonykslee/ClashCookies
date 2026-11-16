import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Scenario =
  | "success"
  | "candidate-build-failure"
  | "health-failure"
  | "rollback-failure"
  | "stale-candidate"
  | "untracked-collision"
  | "concurrent-active"
  | "migration";

function bashExecutable(): string {
  return process.platform === "win32"
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash";
}

function runScenario(scenario: Scenario): string {
  const harness = join(process.cwd(), "tests", "fixtures", "deploy-prod-harness.sh");
  const script = join(process.cwd(), "ops", "deploy", "deploy-prod.sh");
  return execFileSync(bashExecutable(), [harness, scenario, script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function section(output: string, name: string): string {
  const startMarker = name + "_BEGIN\n";
  const endMarker = name + "_END";
  const start = output.indexOf(startMarker);
  const end = output.indexOf(endMarker, start);
  return start === -1 || end === -1 ? "" : output.slice(start + startMarker.length, end);
}

describe("version-controlled production deployment procedure", () => {
  it("builds without production credentials/runtime and promotes one active container", () => {
    const output = runScenario("success");
    const log = section(output, "LOG");
    const buildLine = log.split("\n").find((line) => line.startsWith("BUILD ")) ?? "";
    expect(output).toContain("STATUS=0");
    expect(buildLine).not.toContain("--env-file");
    expect(buildLine).not.toContain("DATABASE_URL");
    expect(buildLine).not.toContain("POLLING_MODE=active");
    expect(buildLine).not.toContain("container-start.sh");
    expect(log).toContain("ACTIVE_RUN new-reviewed-sha");
    expect(log).toContain("CURL new-reviewed-sha");
  });

  it("leaves the current runtime untouched when candidate build fails", () => {
    const output = runScenario("candidate-build-failure");
    const log = section(output, "LOG");
    expect(output).not.toContain("STATUS=0");
    expect(log).toContain("BUILD ");
    expect(log).not.toContain("ACTIVE_RUN");
    expect(log).not.toContain("DOCKER rm");
    expect(output).toContain("STATE=active:OLD");
  });

  it("restores the reviewed old revision after promotion health failure", () => {
    const output = runScenario("health-failure");
    const log = section(output, "LOG");
    expect(output).not.toContain("STATUS=0");
    expect(log).toContain("ACTIVE_RUN new-reviewed-sha");
    expect(log).toContain("CHECKOUT old-reviewed-sha");
    expect(log).toContain("ACTIVE_RUN old-reviewed-sha");
    expect(log).toContain("CURL old-reviewed-sha");
    expect(log).toContain("GIT worktree-remove");
  });

  it("reports rollback failure without claiming recovery", () => {
    const output = runScenario("rollback-failure");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("rollback_result=failed");
    expect(section(output, "LOG")).toContain("ACTIVE_RUN old-reviewed-sha");
  });

  it("refuses to clean a pre-existing replacement path", () => {
    const output = runScenario("stale-candidate");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("refusing_to_clean_existing_temp_worktree");
    expect(section(output, "LOG")).not.toContain("BUILD ");
    expect(output).toContain("MARKER=preserved");
  });

  it("refuses a target that would overwrite an unknown production file", () => {
    const output = runScenario("untracked-collision");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("unknown_path_would_be_overwritten");
    expect(section(output, "LOG")).not.toContain("BUILD ");
    expect(section(output, "LOG")).not.toContain("CHECKOUT");
  });

  it("refuses to deploy when more than one active runtime is present", () => {
    const output = runScenario("concurrent-active");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("active_runtime_singleton_required_before_deploy");
    expect(section(output, "LOG")).not.toContain("BUILD ");
    expect(section(output, "LOG")).not.toContain("DOCKER rm");
  });

  it("fails closed before stopping production when Prisma changes are detected", () => {
    const output = runScenario("migration");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("migration_changes_detected_fail_closed");
    expect(section(output, "LOG")).not.toContain("DOCKER rm");
  });
});
