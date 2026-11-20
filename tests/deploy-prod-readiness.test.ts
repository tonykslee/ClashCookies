import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Scenario =
  | "success"
  | "cold-start"
  | "rollback-cold-start"
  | "health-failure"
  | "rollback-failure"
  | "build-failure"
  | "container-failure"
  | "health-timeout"
  | "concurrent-active"
  | "lock-busy";

function bashExecutable(): string {
  return process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
}

function runScenario(scenario: Scenario): string {
  const harness = join(process.cwd(), "tests", "fixtures", "deploy-prod-readiness-harness.sh");
  const script = join(process.cwd(), "ops", "deploy", "deploy-prod.sh");
  return execFileSync(bashExecutable(), [harness, scenario, script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function section(output: string, name: string): string {
  const startMarker = `${name}_BEGIN\n`;
  const endMarker = `${name}_END`;
  const start = output.indexOf(startMarker);
  const end = output.indexOf(endMarker, start);
  return start < 0 || end < 0 ? "" : output.slice(start + startMarker.length, end);
}

describe("version-controlled production deployment readiness", () => {
  it("builds offline and promotes one prebuilt active runtime", () => {
    const output = runScenario("success");
    const log = section(output, "LOG");
    const buildLine = log.split("\n").find((line) => line.startsWith("BUILD ")) ?? "";
    expect(output).toContain("STATUS=0");
    expect(buildLine).not.toContain("--env-file");
    expect(buildLine).not.toContain("DATABASE_URL");
    expect(buildLine).not.toContain("POLLING_MODE=active");
    expect(buildLine).not.toContain("container-start.sh");
    expect(log).toContain("ACTIVE_RUN name=clashcookies-app revision=new-reviewed-sha prebuilt=1");
    expect(log.indexOf("BUILD ")).toBeLessThan(log.indexOf("ACTIVE_RUN"));
    expect(output).toContain("health_result=promotion status=200");
  });

  it("allows a cold start beyond the old 600-second promotion budget", () => {
    const output = runScenario("cold-start");
    expect(output).toContain("STATUS=0");
    expect(output).toContain("promotion_readiness_budget_seconds=601");
    expect(output).toContain("health_result=promotion status=200 probes=4");
  });

  it("allows rollback to exceed the old 600-second budget", () => {
    const output = runScenario("rollback-cold-start");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("rollback_readiness_budget_seconds=601");
    expect(output).toContain("health_result=rollback status=200 probes=4");
    expect(output).toContain("rollback_result=success");
  });

  it("captures promotion diagnostics and successfully rolls back", () => {
    const output = runScenario("health-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("diagnostics_saved label=promotion");
    expect(output).toContain("rollback_result=success final_state=old_sha:old-reviewed-sha");
    expect(output).toContain("STATE=active:old-reviewed-sha");
  });

  it("reports an unhealthy rollback without claiming recovery", () => {
    const output = runScenario("rollback-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("rollback_result=failed reason=health final_state=unhealthy_old_sha:old-reviewed-sha");
    expect(output).toContain("final_state=single_active_runtime");
  });

  it("leaves the known-good runtime untouched when candidate build fails", () => {
    const output = runScenario("build-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("candidate_build_failed");
    expect(output).not.toContain("ACTIVE_RUN name=clashcookies-app revision=new-reviewed-sha");
    expect(output).toContain("STATE=active:OLD");
  });

  it("keeps failure status accurate when the canonical container fails to start", () => {
    const output = runScenario("container-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("rollback_result=success");
  });

  it("keeps failure status accurate when a health-gated operation fails", () => {
    const output = runScenario("health-timeout");
    expect(output).toContain("STATUS=1");
  });

  it.each(["health-timeout", "concurrent-active", "lock-busy"] as const)(
    "fails closed for %s",
    (scenario) => {
      const output = runScenario(scenario);
      expect(output).toContain("STATUS=1");
      expect(output).not.toContain("STATUS=0");
    },
  );

  it("retains diagnostic evidence after a health timeout", () => {
    const output = runScenario("health-timeout");
    expect(output).toContain("diagnostics_saved label=promotion");
    expect(output).toContain("DIAGNOSTIC=promotion.log");
    expect(output).toContain("DIAGNOSTIC=promotion.state");
  });
});
