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
  | "migration"
  | "lock-busy"
  | "changed-checkout"
  | "legacy-target"
  | "legacy-health-failure"
  | "compose-environment-list"
  | "compose-multi-service"
  | "compose-wrong-service"
  | "compose-unresolved"
  | "compose-invalid"
  | "compose-ambiguous"
  | "cleanup-failure";

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
    expect(output).not.toContain("postgresql://");
    expect(log).toContain("ACTIVE_RUN new-reviewed-sha");
    expect(log).toContain("CURL new-reviewed-sha");
  });

  it("leaves the current runtime untouched when candidate build fails", () => {
    const output = runScenario("candidate-build-failure");
    const log = section(output, "LOG");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("candidate_build=failed revision=new-reviewed-sha");
    expect(log).toContain("BUILD ");
    expect(log).not.toContain("ACTIVE_RUN");
    expect(log).not.toContain("DOCKER rm");
    expect(log).toContain("GIT worktree-remove");
    expect(output).toContain("WORKTREE=removed");
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
    expect(output).toContain("WORKTREE=none");
  });

  it("refuses a target that would overwrite an unknown production file", () => {
    const output = runScenario("untracked-collision");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("unknown_path_would_be_overwritten");
    expect(section(output, "LOG")).not.toContain("BUILD ");
    expect(section(output, "LOG")).not.toContain("CHECKOUT");
  });

  it("refuses an unlabeled secondary active runtime without a published port", () => {
    const output = runScenario("concurrent-active");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("active_runtime_singleton_required_before_deploy");
    expect(section(output, "LOG")).not.toContain("BUILD ");
    expect(section(output, "LOG")).not.toContain("DOCKER rm");
  });

  it("takes the exclusive lock before checkout and runtime validation", () => {
    const output = runScenario("lock-busy");
    const log = section(output, "LOG");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("another_deployment_is_running");
    expect(log).not.toContain("FLOCK");
    expect(log).not.toContain("lock=acquired");
    expect(log).not.toContain("GIT diff");
    expect(log).not.toContain("DOCKER ps");
  });

  it("rejects changed checkout state after the lock is held", () => {
    const output = runScenario("changed-checkout");
    const log = section(output, "LOG");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("tracked_worktree_changes_present");
    expect(output).toContain("lock=acquired");
    expect(output.indexOf("lock=acquired")).toBeLessThan(output.indexOf("GIT diff"));
    expect(log).not.toContain("DOCKER rm");
  });

  it("fails closed before stopping production when Prisma changes are detected", () => {
    const output = runScenario("migration");
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("migration_changes_detected_fail_closed");
    expect(section(output, "LOG")).not.toContain("DOCKER rm");
  });

  it("keeps the stable executor working when the target revision lacks deploy-prod.sh", () => {
    const output = runScenario("legacy-target");
    expect(output).toContain("STATUS=0");
    expect(section(output, "LOG")).toContain("ACTIVE_RUN new-reviewed-sha");
    expect(section(output, "LOG")).toContain("CHECKOUT new-reviewed-sha");
    expect(section(output, "LOG")).toContain("legacy_target_missing_deploy_script");
  });

  it("rolls back through the stable executor when a target lacks deploy-prod.sh", () => {
    const output = runScenario("legacy-health-failure");
    const log = section(output, "LOG");
    expect(output).not.toContain("STATUS=0");
    expect(log).toContain("legacy_target_missing_deploy_script");
    expect(log).toContain("CHECKOUT old-reviewed-sha");
    expect(log).toContain("ACTIVE_RUN old-reviewed-sha");
    expect(log).toContain("CURL old-reviewed-sha");
  });

  it("fails closed and reports when owned worktree cleanup fails", () => {
    const output = runScenario("cleanup-failure");
    const log = section(output, "LOG");
    expect(output).not.toContain("STATUS=0");
    expect(log).toContain("BUILD ");
    expect(output).toContain("candidate_build=success");
    expect(log).toContain("GIT worktree-remove");
    expect(output).toContain("candidate_cleanup=failed reason=owned_worktree_remains");
    expect(log).not.toContain("ACTIVE_RUN");
    expect(output).toContain("STATE=active:OLD");
    expect(output).toContain("WORKTREE=owned:");
  });

  it.each([
    "compose-wrong-service",
    "compose-unresolved",
    "compose-invalid",
    "compose-ambiguous",
  ] as const)("fails closed for invalid Compose DATABASE_URL configuration: %s", (scenario) => {
    const output = runScenario(scenario);
    expect(output).not.toContain("STATUS=0");
    expect(output).toContain("production_database_url_not_found");
    expect(section(output, "LOG")).not.toContain("DOCKER rm");
  });

  it.each([
    "compose-environment-list",
    "compose-multi-service",
  ] as const)("resolves supported Compose DATABASE_URL format: %s", (scenario) => {
    const output = runScenario(scenario);
    expect(output).toContain("STATUS=0");
    expect(output).not.toContain("postgresql://");
    expect(section(output, "LOG")).toContain("ACTIVE_RUN new-reviewed-sha");
  });
});
