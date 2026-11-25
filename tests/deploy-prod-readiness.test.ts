import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Scenario =
  | "success"
  | "slow-candidate-build"
  | "promotion-timeout-rollback-slow"
  | "unsafe-deadlines"
  | "cold-start"
  | "rollback-cold-start"
  | "health-failure"
  | "rollback-failure"
  | "build-failure"
  | "container-failure"
  | "health-timeout"
  | "concurrent-active"
  | "lock-busy"
  | "sequence"
  | "reset-failure"
  | "diagnostic-permissions"
  | "legacy-rollback"
  | "cleanup-failure"
  | "workspace-cleanup-failure"
  | "abandoned-attempt"
  | "abandoned-artifact"
  | "ambiguous-owned-resource"
  | "unrelated-resource"
  | "insufficient-resources"
  | "health-degradation"
  | "signal-term"
  | "signal-int"
  | "signal-hup"
  | "signal-rollback-artifact"
  | "candidate-container-cleanup-failure"
  | "cleanup-failure-retry"
  | "candidate-exit-137"
  | "candidate-exit-124"
  | "interrupted-creation"
  | "docker-enumeration-failure"
  | "docker-inspection-failure"
  | "legacy-candidate"
  | "partial-labels"
  | "concurrent-stale-lock"
  | "malformed-resources"
  | "contradictory-resources"
  | "malformed-memory";

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
  it("keeps candidate compilation outside the Git worktree", () => {
    const deployScript = readFileSync(join(process.cwd(), "ops", "deploy", "deploy-prod.sh"), "utf8");
    expect(deployScript).toContain('-v "$TEMP_WORKTREE:/source:ro"');
    expect(deployScript).toContain('-v "$BUILD_WORKSPACE_VOLUME:/app"');
    expect(deployScript).toContain("cp -a /source/. /app/");
    expect(deployScript).not.toContain('-v "$TEMP_WORKTREE:/app"');
  });

  it("keeps the SSH ceiling above the version-controlled recovery budget", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "deploy-prod.yml"), "utf8");
    const deployScript = readFileSync(join(process.cwd(), "ops", "deploy", "deploy-prod.sh"), "utf8");
    expect(workflow).toContain("command_timeout: 180m");
    expect(workflow).toContain("DEPLOY_OUTER_TIMEOUT_SECONDS=10800");
    expect(deployScript).toContain("(ARTIFACT_STAGE_TIMEOUT_SECONDS * 7)");
  });

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
    expect(output).toContain("workspace_cleanup=success");
    expect(output.indexOf("workspace_cleanup=success")).toBeLessThan(output.indexOf("promotion_step=stop_old_app"));
    expect(output).toContain("health_result=promotion status=200");
  });

  it("fails with preserved evidence when candidate build exceeds its deadline", () => {
    const output = runScenario("slow-candidate-build");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("candidate_build=failed reason=build_deadline");
    expect(output).toContain("candidate-build.log");
    expect(output).not.toContain("ACTIVE_RUN name=clashcookies-app revision=new-reviewed-sha");
    expect(output).toContain("STATE=active:OLD");
    expect(output).toContain("CONTAINERS_END\n");
  });

  it("terminates the daemon-managed candidate after the handled timeout", () => {
    const output = runScenario("slow-candidate-build");
    const log = section(output, "LOG");
    expect(output).toContain("STATUS=1");
    expect(log).toContain("DOCKER stop --time 10");
    expect(log).toContain("DOCKER rm container-");
    expect(output).toContain("CONTAINERS_BEGIN\nCONTAINERS_END");
  });

  it("does not misclassify an observed candidate exit 137 as a wrapper deadline", () => {
    const output = runScenario("candidate-exit-137");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("candidate_build=failed reason=build status=137");
    expect(output).not.toContain("reason=build_deadline");
    expect(output).toContain("STATE=active:OLD");
  });

  it("distinguishes an observed candidate exit 124 from the wrapper deadline", () => {
    const output = runScenario("candidate-exit-124");
    expect(output).toContain("candidate_build=failed reason=build_exit_124 status=124");
    expect(output).not.toContain("reason=build_deadline");
  });

  it("reconciles a failed container create through the pre-Docker intent", () => {
    const output = runScenario("interrupted-creation");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("CONTAINERS_BEGIN\nCONTAINERS_END");
  });

  it("keeps the outer deadline safe through promotion timeout and slow rollback", () => {
    const output = runScenario("promotion-timeout-rollback-slow");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("health_result=rollback status=200 probes=4");
    expect(output).toContain("rollback_result=success final_state=old_sha:old-reviewed-sha");
    expect(output).toContain("STATE=active:old-reviewed-sha");
  });

  it("rejects an outer deadline that cannot cover bounded recovery", () => {
    const output = runScenario("unsafe-deadlines");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("unsafe_deadline_configuration");
    expect(output).toContain("STATE=active:OLD");
    expect(output).not.toContain("BUILD ");
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

  it("rolls back to an old-style checkout with the deployment-owned prebuilt launcher", () => {
    const output = runScenario("legacy-rollback");
    const log = section(output, "LOG");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("rollback_result=success final_state=old_sha:old-reviewed-sha");
    expect(output).toContain("STATE=active:old-reviewed-sha");
    expect(log).toContain("LEGACY_ROLLBACK_LAUNCHER=inline");
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

  it("fails closed and reports candidate cleanup errors", () => {
    const output = runScenario("cleanup-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("candidate_cleanup=failed");
    expect(output).toContain("candidate_cleanup_failed");
    expect(output).toContain("STATE=active:OLD");
  });

  it("aborts before promotion when the owned workspace cannot be removed", () => {
    const output = runScenario("workspace-cleanup-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("workspace_cleanup=failed reason=remove");
    expect(output).toContain("candidate_workspace_cleanup_failed");
    expect(output).not.toContain("promotion_step=stop_old_app");
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

  it("serializes concurrent recovery of one stale legacy lock", () => {
    const output = runScenario("concurrent-stale-lock");
    expect(output).toContain("deploy_lock=recovered_stale");
    expect(output).toMatch(/CONCURRENT_FIRST_STATUS=0|CONCURRENT_SECOND_STATUS=0/);
    expect(output).toMatch(/CONCURRENT_FIRST_STATUS=1|CONCURRENT_SECOND_STATUS=1/);
  });

  it("retains diagnostic evidence after a health timeout", () => {
    const output = runScenario("health-timeout");
    expect(output).toContain("diagnostics_saved label=promotion");
    expect(output).toContain("DIAGNOSTIC=promotion.log");
    expect(output).toContain("DIAGNOSTIC=promotion.state");
  });

  it("retains exact release artifacts across two promotions and rollback", () => {
    const output = runScenario("sequence");
    expect(output).toContain("PASS=1 STATUS=0");
    expect(output).toContain("PASS=2 STATUS=0");
    expect(output).toContain("PASS=3 STATUS=1");
    expect(output).toContain("PASS=4 STATUS=0");
    expect(output).toContain("rollback_result=success final_state=old_sha:release-b");
    expect(output).toContain("ACTIVE_RUN name=clashcookies-app revision=release-a prebuilt=1");
    expect(output).toContain("ACTIVE_RUN name=clashcookies-app revision=release-b prebuilt=1");
    expect(output).toContain("ACTIVE_RUN name=clashcookies-app revision=release-c prebuilt=1");
    expect(output).toContain("rollback_artifact_prepare=reused_attached revision=release-b");
    expect(output).toContain("STATE=active:release-c");
    expect(output).toContain("artifact_cleanup=removed");
    expect(output).toContain("clashcookies-prod-artifact-release-b-rollback-dist");
    expect(output).toContain("clashcookies-prod-artifact-release-b-rollback-node-modules");
  });

  it("restores the old runtime when checkout fails after stopping it", () => {
    const output = runScenario("reset-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("reason=checkout_new_revision");
    expect(output).toContain("rollback_result=success final_state=old_sha:old-reviewed-sha");
    expect(output).toContain("STATE=active:old-reviewed-sha");
  });

  it("fails closed for a preexisting diagnostic directory with unsafe permissions", () => {
    if (process.platform === "win32") {
      console.warn("Skipping chmod assertion on Windows: MSYS reports ACL-backed paths as 755/644");
      const script = readFileSync(join(process.cwd(), "ops", "deploy", "deploy-prod.sh"), "utf8");
      expect(script).toContain("umask 077");
      expect(script).toContain("private_directory_mode_invalid");
      expect(script).toContain("private_file_mode_invalid");
      return;
    }
    const output = runScenario("diagnostic-permissions");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("private_directory_mode_invalid");
    expect(output).toContain("STATE=active:OLD");
  });

  it("reconciles an abandoned owned attempt before preparing the next one", () => {
    const output = runScenario("abandoned-attempt");
    expect(output).toContain("STATUS=0");
    expect(output).toContain("owned_resource_reconciliation=abandoned_container");
    expect(output).toContain("CONTAINERS_BEGIN\nCONTAINERS_END");
  });

  it("reconciles an owned abandoned artifact container by its exact revision and role", () => {
    const output = runScenario("abandoned-artifact");
    expect(output).toContain("STATUS=0");
    expect(output).toContain("owned_resource_reconciliation=abandoned_container");
    expect(output).toContain("role=artifact-stage");
    expect(output).toContain("revision=old-reviewed-sha");
    expect(output).toContain("CONTAINERS_BEGIN\nCONTAINERS_END");
  });

  it("refuses ambiguous owned resources and leaves them for an operator", () => {
    const output = runScenario("ambiguous-owned-resource");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("reason=ambiguous_container");
    expect(output).toContain("ambiguous-candidate");
  });

  it.each(["docker-enumeration-failure", "docker-inspection-failure", "legacy-candidate", "partial-labels"] as const)(
    "fails closed for %s",
    (scenario) => {
      const output = runScenario(scenario);
      expect(output).toContain("STATUS=1");
      expect(output).not.toContain("promotion_result=success");
    },
  );

  it("fails closed when owned container removal cannot be verified", () => {
    const output = runScenario("candidate-container-cleanup-failure");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("container_cleanup=failed");
    expect(output).toContain("operator_intervention_required");
    expect(output).toContain("CONTAINERS_BEGIN\ncontainer-");
  });

  it("refuses the next deployment while an owned cleanup failure remains", () => {
    const output = runScenario("cleanup-failure-retry");
    expect(output).toContain("FIRST_STATUS=1");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("owned_resource_reconciliation=failed");
    expect(output).toContain("operator_intervention_required");
  });

  it("does not touch resources owned by another tool", () => {
    const output = runScenario("unrelated-resource");
    expect(output).toContain("STATUS=0");
    expect(output).toContain("CONTAINERS_BEGIN\nunrelated-candidate\nCONTAINERS_END");
  });

  it("refuses candidate preparation when host headroom is insufficient", () => {
    const output = runScenario("insufficient-resources");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("resource_admission=denied reason=insufficient_memory");
    expect(output).not.toContain("BUILD ");
    expect(output).toContain("STATE=active:OLD");
  });

  it.each(["malformed-resources", "contradictory-resources", "malformed-memory"] as const)(
    "fails closed for invalid resource measurements/configuration: %s",
    (scenario) => {
      const output = runScenario(scenario);
      expect(output).toContain("STATUS=1");
      expect(output).not.toContain("BUILD ");
    },
  );

  it("aborts candidate preparation after confirmed production health degradation", () => {
    const output = runScenario("health-degradation");
    expect(output).toContain("STATUS=1");
    expect(output).toContain("production_health_monitor=failed");
    expect(output).toContain("candidate_build=failed reason=build_abort_or_cleanup");
    expect(output).toContain("STATE=active:OLD");
  });

  it.each(["signal-term", "signal-int", "signal-hup"] as const)(
    "cleans the owned candidate on %s",
    (scenario) => {
      const output = runScenario(scenario);
      expect(output).toMatch(/STATUS=(129|130|143)/);
      expect(output).toContain("interruption=received");
      expect(output).toContain("CONTAINERS_BEGIN\nCONTAINERS_END");
      expect(output).toContain("STATE=active:OLD");
    },
  );

  it("cleans an interrupted rollback-artifact container using its registered identity", () => {
    const output = runScenario("signal-rollback-artifact");
    expect(output).toMatch(/STATUS=(129|130|143)/);
    expect(output).toContain("interruption=received");
    expect(output).toContain("role=artifact-stage");
    expect(output).toContain("revision=old-reviewed-sha");
    expect(output).toContain("container_cleanup=verified");
    expect(output).toContain("CONTAINERS_BEGIN\nCONTAINERS_END");
    expect(output).toContain("STATE=active:OLD");
  });
});
