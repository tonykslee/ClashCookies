import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      cwd: process.cwd(),
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function requireDockerOrSkip(): void {
  if (!dockerAvailable()) {
    if (process.env.REQUIRE_DOCKER_LIFECYCLE === "1") {
      throw new Error("Docker daemon is required for the lifecycle integration job");
    }
    console.warn("Skipping real Docker lifecycle integration: Docker daemon is unavailable");
  }
}

function bashExecutable(): string {
  return process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
}

function sanitizeWrapperOutput(output: string): string {
  return output
    .replace(/((?:DISCORD|DATABASE|TOKEN|PASSWORD|SECRET|AUTH)[A-Z0-9_]*=)[^\s\r\n]+/gi, "$1[redacted]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s\r\n]+/gi, "$1[redacted]");
}

function expectWrapperOutput(output: string, expected: string, label: string): void {
  expect(output, `${label}: missing ${JSON.stringify(expected)}\n--- sanitized wrapper output ---\n${sanitizeWrapperOutput(output)}\n--- end wrapper output ---`).toContain(expected);
}

function expectWrapperStatus(status: number | null, expected: number, output: string, label: string): void {
  expect(status, `${label}: unexpected status\n--- sanitized wrapper output ---\n${sanitizeWrapperOutput(output)}\n--- end wrapper output ---`).toBe(expected);
}

function containerIdsByName(name: string): string[] {
  try {
    return execFileSync("docker", ["ps", "-aq", "--filter", `name=${name}`], {
      encoding: "utf8",
      timeout: 10_000,
    }).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function removeContainerByName(name: string): void {
  for (const id of containerIdsByName(name)) {
    try {
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore", timeout: 15_000 });
    } catch {
      // Best effort cleanup must not hide the assertion that failed first.
    }
  }
}

async function waitForContainerName(name: string, timeoutMs: number, diagnostics: () => string = () => ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (containerIdsByName(name).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for container ${name}\n--- sanitized wrapper output ---\n${sanitizeWrapperOutput(diagnostics())}\n--- end wrapper output ---`);
}

async function waitForRunningContainer(name: string, timeoutMs: number, diagnostics: () => string = () => ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const id of containerIdsByName(name)) {
      try {
        if (execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", id], { encoding: "utf8", timeout: 10_000 }).trim() === "true") return;
      } catch {
        // The daemon may be between create and inspect; keep polling.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for running container ${name}\n--- sanitized wrapper output ---\n${sanitizeWrapperOutput(diagnostics())}\n--- end wrapper output ---`);
}

function readDiagnosticFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return `[diagnostic unavailable: ${path}]`;
  }
}

function removeVolume(name: string): void {
  try {
    execFileSync("docker", ["volume", "rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
  } catch {
    // Best effort cleanup must not hide the assertion that failed first.
  }
}

describe("real Docker deployment artifact smoke", () => {
  it("invokes the production wrapper and removes its daemon-managed candidate at the deadline", async () => {
    if (!dockerAvailable()) {
      requireDockerOrSkip();
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const fixture = mkdtempSync(join(tmpdir(), "clashcookies-wrapper-lifecycle-"));
    const origin = `${fixture}-origin.git`;
    const normalContainer = `fb027-production-${suffix}`;
    const unrelatedContainer = `fb027-unrelated-${suffix}`;
    const buildContainer = `fb027-candidate-${suffix}`;
    const port = String(18085 + (process.pid % 100));
    const deployScript = join(process.cwd(), "ops", "deploy", "deploy-prod.sh");
    const write = (path: string, content: string) => writeFileSync(join(fixture, path), content);
    const git = (args: string[]) => execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8" });

    mkdirSync(join(fixture, "dist"), { recursive: true });
    mkdirSync(join(fixture, "node_modules"), { recursive: true });
    mkdirSync(join(fixture, "ops", "deploy"), { recursive: true });
    let oldSha = "";
    let newSha = "";
    let wrapper: ReturnType<typeof spawn> | undefined;
    write("docker-compose.yml", "services:\n  app:\n    environment:\n      DATABASE_URL: postgresql://fixture\n");
    write(".env", "DISCORD_TOKEN=fixture\n");
    write("package.json", JSON.stringify({
      scripts: { build: "sleep 30", start: "node server.js", "start:runtime": "node server.js" },
    }));
    write("server.js", "const fs=require('fs'); require('http').createServer((req,res)=>{const degraded=fs.existsSync('/app/degrade');res.writeHead(degraded?503:200);res.end(degraded?'degraded':'ok');}).listen(8080,'0.0.0.0');\n");
    write("dist/ClashCookies.js", "old-build\n");
    write("node_modules/.fixture", "old-dependency\n");
    write("ops/deploy/ensure-yarn-deps.sh", "#!/usr/bin/env bash\nset -euo pipefail\n");
    write("ops/deploy/container-start.sh", "#!/usr/bin/env bash\nset -euo pipefail\nnpm run start\n");
    write("resources", "mem_available_mib=8192\nswap_total_mib=0\nswap_free_mib=0\nload_per_cpu_percent=0\nhost_pid_max=50000\nhost_pid_count=100\n");
    execFileSync("chmod", ["+x", join(fixture, "ops/deploy/ensure-yarn-deps.sh"), join(fixture, "ops/deploy/container-start.sh")]);

    try {
      execFileSync("git", ["init", "-b", "main", fixture], { stdio: "ignore" });
      git(["config", "user.email", "fb027@example.invalid"]);
      git(["config", "user.name", "FB-027 test"]);
      git(["add", "."]);
      git(["commit", "-m", "old runtime"]);
      oldSha = git(["rev-parse", "HEAD"]).trim();
      execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
      git(["remote", "add", "origin", origin]);
      git(["push", "-u", "origin", "main"]);
      write("build-marker.txt", "new-build\n");
      git(["add", "."]);
      git(["commit", "-m", "new candidate"]);
      git(["push", "origin", "main"]);
      newSha = git(["rev-parse", "HEAD"]).trim();
      git(["reset", "--hard", oldSha]);

      const image = process.env.DEPLOY_TEST_IMAGE ?? "node:20-bookworm";
      execFileSync("docker", ["pull", image], { stdio: "ignore", timeout: 300_000 });
      execFileSync("docker", [
        "run", "-d", "--name", normalContainer,
        "--label", "com.clashcookies.runtime=active",
        "--label", "com.clashcookies.environment=prod",
        "--label", "com.clashcookies.revision=old",
        "-p", `127.0.0.1:${port}:8080`, "-v", `${fixture}:/app`, image, "node", "/app/server.js",
      ], { encoding: "utf8", timeout: 30_000 });
      execFileSync("docker", ["run", "-d", "--name", unrelatedContainer, image, "sleep", "300"], { encoding: "utf8", timeout: 30_000 });
      execFileSync(bashExecutable(), ["-lc", `for i in $(seq 1 30); do curl --fail --silent http://127.0.0.1:${port}/healthz && exit 0; sleep 1; done; exit 1`], { timeout: 35_000 });

      const startedAt = Date.now();
      const stdout: string[] = [];
      const stderr: string[] = [];
      wrapper = spawn(bashExecutable(), [deployScript], {
        cwd: fixture,
        env: {
          ...process.env,
          APP_DIR: fixture,
          NORMAL_CONTAINER: normalContainer,
          BUILD_CONTAINER: buildContainer,
          NORMAL_PORT: port,
          PROD_NETWORK: "bridge",
          TARGET_REF: "origin/main",
          DEPLOY_DIAGNOSTIC_DIR: join(fixture, "diagnostics"),
          DEPLOY_LOCK_PATH: join(fixture, "deploy.lock"),
          DEPLOY_LOCK_FILE: join(fixture, "deploy.lock.flock"),
          DEPLOY_INTENT_DIR: join(fixture, "attempt-intents"),
          DEPLOY_RESOURCE_ADMISSION_FILE: join(fixture, "resources"),
          CANDIDATE_BUILD_TIMEOUT_SECONDS: "10",
          ARTIFACT_STAGE_TIMEOUT_SECONDS: "5",
          PROMOTION_HEALTH_TIMEOUT_SECONDS: "5",
          ROLLBACK_HEALTH_TIMEOUT_SECONDS: "5",
          CLEANUP_OVERHEAD_SECONDS: "30",
          DEPLOYMENT_OVERHEAD_SECONDS: "30",
          DEPLOY_OUTER_TIMEOUT_SECONDS: "180",
          DEPLOY_RESERVED_MEMORY_MIB: "128",
          DEPLOY_CANDIDATE_MEMORY_LIMIT: "256m",
          DEPLOY_CANDIDATE_MEMORY_RESERVATION: "128m",
          DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT: "256m",
          DEPLOY_MIN_FREE_PIDS: "1",
          DEPLOY_MAX_HOST_SWAP_USED_PERCENT: "100",
          DEPLOY_MAX_HOST_LOAD_PER_CPU_PERCENT: "100",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      wrapper.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      wrapper.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      await waitForRunningContainer(buildContainer, 30_000, () => `${stdout.join("")}\n${stderr.join("")}\n${readDiagnosticFile(join(fixture, "diagnostics", "candidate-build.log"))}`);
      const candidateRunningAt = Date.now();
      const status = await new Promise<number | null>((resolve) => {
        wrapper?.once("close", (code) => resolve(code));
        wrapper?.once("error", () => resolve(null));
      });
      const candidateLog = readDiagnosticFile(join(fixture, "diagnostics", "candidate-build.log"));
      const output = `${stdout.join("")}\n${stderr.join("")}\n${candidateLog}`;
      expectWrapperStatus(status, 1, output, "deadline wrapper");
      expectWrapperOutput(output, "candidate_build=failed reason=build_deadline status=124", "deadline wrapper");
      expectWrapperOutput(output, "container_started", "deadline wrapper");
      expectWrapperOutput(output, "role=candidate-build", "deadline wrapper");
      expectWrapperOutput(output, "container_cleanup=verified", "deadline wrapper");
      expect(output).toMatch(new RegExp(`container_cleanup=verified attempt=[^ ]+ role=candidate-build revision=${newSha} name=${buildContainer}`));
      expectWrapperOutput(output, "container_waiter=process_group_reaped", "deadline wrapper");
      expect(candidateLog.indexOf("container_started")).toBeGreaterThanOrEqual(0);
      expect(candidateLog.indexOf("container_started")).toBeLessThan(candidateLog.indexOf("container_abort=deadline"));
      expect(Date.now() - startedAt).toBeLessThan(60_000);
      expect(candidateRunningAt - startedAt).toBeLessThan(30_000);
      const candidates = execFileSync("docker", [
        "ps", "-aq",
        "--filter", "label=com.clashcookies.deploy.owner=clashcookies-deploy",
        "--filter", "label=com.clashcookies.deploy.environment=prod",
      ], { encoding: "utf8" }).trim();
      expect(candidates).toBe("");
      expect(execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", normalContainer], { encoding: "utf8" }).trim()).toBe("true");
      expect(execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", unrelatedContainer], { encoding: "utf8" }).trim()).toBe("true");
      execFileSync("flock", ["-n", join(fixture, "deploy.lock.flock"), "true"], { timeout: 10_000 });
    } finally {
      if (wrapper && wrapper.exitCode === null) {
        wrapper.kill("SIGKILL");
        await new Promise<void>((resolve) => wrapper?.once("close", () => resolve()));
      }
      removeContainerByName(normalContainer);
      removeContainerByName(unrelatedContainer);
      removeContainerByName(buildContainer);
      for (const volume of [
        `clashcookies-prod-build-${newSha}`,
        `clashcookies-prod-build-dist-${newSha}`,
        `clashcookies-prod-build-workspace-${newSha}`,
        `clashcookies-prod-artifact-${oldSha}-rollback-dist`,
        `clashcookies-prod-artifact-${oldSha}-rollback-node-modules`,
      ]) {
        removeVolume(volume);
      }
      rmSync(fixture, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  }, 180_000);

  it("contains a health-aborted long-running candidate promptly", async () => {
    if (!dockerAvailable()) {
      requireDockerOrSkip();
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const fixture = mkdtempSync(join(tmpdir(), "clashcookies-wrapper-health-abort-"));
    const origin = `${fixture}-origin.git`;
    const normalContainer = `fb027-health-production-${suffix}`;
    const unrelatedContainer = `fb027-health-unrelated-${suffix}`;
    const buildContainer = `fb027-health-candidate-${suffix}`;
    const port = String(18185 + (process.pid % 100));
    const deployScript = join(process.cwd(), "ops", "deploy", "deploy-prod.sh");
    const write = (path: string, content: string) => writeFileSync(join(fixture, path), content);
    const git = (args: string[]) => execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8" });
    let oldSha = "";
    let newSha = "";
    let wrapper: ReturnType<typeof spawn> | undefined;

    mkdirSync(join(fixture, "dist"), { recursive: true });
    mkdirSync(join(fixture, "node_modules"), { recursive: true });
    mkdirSync(join(fixture, "ops", "deploy"), { recursive: true });
    write("docker-compose.yml", "services:\n  app:\n    environment:\n      DATABASE_URL: postgresql://fixture\n");
    write(".env", "DISCORD_TOKEN=fixture\n");
    write("package.json", JSON.stringify({
      scripts: { build: "sleep 30", start: "node server.js", "start:runtime": "node server.js" },
    }));
    write("server.js", "const fs=require('fs'); require('http').createServer((req,res)=>{const degraded=fs.existsSync('/app/degrade');res.writeHead(degraded?503:200);res.end(degraded?'degraded':'ok');}).listen(8080,'0.0.0.0');\n");
    write("dist/ClashCookies.js", "old-build\n");
    write("node_modules/.fixture", "old-dependency\n");
    write("ops/deploy/ensure-yarn-deps.sh", "#!/usr/bin/env bash\nset -euo pipefail\n");
    write("ops/deploy/container-start.sh", "#!/usr/bin/env bash\nset -euo pipefail\nnpm run start\n");
    write("resources", "mem_available_mib=8192\nswap_total_mib=0\nswap_free_mib=0\nload_per_cpu_percent=0\nhost_pid_max=50000\nhost_pid_count=100\n");
    execFileSync("chmod", ["+x", join(fixture, "ops/deploy/ensure-yarn-deps.sh"), join(fixture, "ops/deploy/container-start.sh")]);

    try {
      execFileSync("git", ["init", "-b", "main", fixture], { stdio: "ignore" });
      git(["config", "user.email", "fb027@example.invalid"]);
      git(["config", "user.name", "FB-027 test"]);
      git(["add", "."]);
      git(["commit", "-m", "old runtime"]);
      oldSha = git(["rev-parse", "HEAD"]).trim();
      execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
      git(["remote", "add", "origin", origin]);
      git(["push", "-u", "origin", "main"]);
      write("build-marker.txt", "new-build\n");
      git(["add", "."]);
      git(["commit", "-m", "new candidate"]);
      git(["push", "origin", "main"]);
      newSha = git(["rev-parse", "HEAD"]).trim();
      git(["reset", "--hard", oldSha]);

      const image = process.env.DEPLOY_TEST_IMAGE ?? "node:20-bookworm";
      execFileSync("docker", ["pull", image], { stdio: "ignore", timeout: 300_000 });
      execFileSync("docker", [
        "run", "-d", "--name", normalContainer,
        "--label", "com.clashcookies.runtime=active",
        "--label", "com.clashcookies.environment=prod",
        "--label", "com.clashcookies.revision=old",
        "-p", `127.0.0.1:${port}:8080`, "-v", `${fixture}:/app`, image, "node", "/app/server.js",
      ], { encoding: "utf8", timeout: 30_000 });
      execFileSync("docker", ["run", "-d", "--name", unrelatedContainer, image, "sleep", "300"], { encoding: "utf8", timeout: 30_000 });
      execFileSync(bashExecutable(), ["-lc", `for i in $(seq 1 30); do curl --fail --silent http://127.0.0.1:${port}/healthz && exit 0; sleep 1; done; exit 1`], { timeout: 35_000 });

      const stdout: string[] = [];
      const stderr: string[] = [];
      const startedAt = Date.now();
      wrapper = spawn(bashExecutable(), [deployScript], {
        cwd: fixture,
        env: {
          ...process.env,
          APP_DIR: fixture,
          NORMAL_CONTAINER: normalContainer,
          BUILD_CONTAINER: buildContainer,
          NORMAL_PORT: port,
          PROD_NETWORK: "bridge",
          TARGET_REF: "origin/main",
          DEPLOY_DIAGNOSTIC_DIR: join(fixture, "diagnostics"),
          DEPLOY_LOCK_PATH: join(fixture, "deploy.lock"),
          DEPLOY_LOCK_FILE: join(fixture, "deploy.lock.flock"),
          DEPLOY_INTENT_DIR: join(fixture, "attempt-intents"),
          DEPLOY_RESOURCE_ADMISSION_FILE: join(fixture, "resources"),
          CANDIDATE_BUILD_TIMEOUT_SECONDS: "30",
          ARTIFACT_STAGE_TIMEOUT_SECONDS: "5",
          PROMOTION_HEALTH_TIMEOUT_SECONDS: "5",
          ROLLBACK_HEALTH_TIMEOUT_SECONDS: "5",
          CLEANUP_OVERHEAD_SECONDS: "30",
          DEPLOYMENT_OVERHEAD_SECONDS: "30",
          DEPLOY_OUTER_TIMEOUT_SECONDS: "180",
          DEPLOY_RESERVED_MEMORY_MIB: "128",
          DEPLOY_CANDIDATE_MEMORY_LIMIT: "256m",
          DEPLOY_CANDIDATE_MEMORY_RESERVATION: "128m",
          DEPLOY_CANDIDATE_MEMORY_SWAP_LIMIT: "256m",
          DEPLOY_MIN_FREE_PIDS: "1",
          DEPLOY_MAX_HOST_SWAP_USED_PERCENT: "100",
          DEPLOY_MAX_HOST_LOAD_PER_CPU_PERCENT: "100",
          DEPLOY_HEALTH_DEGRADATION_FAILURES: "1",
          HEALTH_POLL_INTERVAL_SECONDS: "1",
          DEPLOY_CONTAINER_OPERATION_TIMEOUT_SECONDS: "3",
          DEPLOY_CONTAINER_STOP_TIMEOUT_SECONDS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      wrapper.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      wrapper.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      await waitForContainerName(buildContainer, 30_000, () => `${stdout.join("")}\n${stderr.join("")}\n${readDiagnosticFile(join(fixture, "diagnostics", "candidate-build.log"))}`);
      const degradedAt = Date.now();
      write("degrade", "1\n");
      const status = await new Promise<number | null>((resolve) => {
        wrapper?.once("close", (code) => resolve(code));
        wrapper?.once("error", () => resolve(null));
      });
      const output = `${stdout.join("")}\n${stderr.join("")}`;
      const candidateOutput = `${output}\n${readDiagnosticFile(join(fixture, "diagnostics", "candidate-build.log"))}`;
      expectWrapperStatus(status, 1, candidateOutput, "health-abort wrapper");
      expectWrapperOutput(candidateOutput, "container_started", "health-abort wrapper");
      expectWrapperOutput(candidateOutput, "container_abort=health_degradation", "health-abort wrapper");
      expectWrapperOutput(candidateOutput, "candidate_build=failed reason=build_abort_or_cleanup status=125", "health-abort wrapper");
      expect(candidateOutput).toMatch(new RegExp(`container_cleanup=verified attempt=[^ ]+ role=candidate-build revision=${newSha} name=${buildContainer}`));
      expectWrapperOutput(candidateOutput, "container_waiter=process_group_reaped", "health-abort wrapper");
      expect(Date.now() - degradedAt).toBeLessThan(10_000);
      expect(containerIdsByName(buildContainer)).toHaveLength(0);
      expect(execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", normalContainer], { encoding: "utf8" }).trim()).toBe("true");
      expect(execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", unrelatedContainer], { encoding: "utf8" }).trim()).toBe("true");
      execFileSync("flock", ["-n", join(fixture, "deploy.lock.flock"), "true"], { timeout: 10_000 });
      expect(Date.now() - startedAt).toBeLessThan(45_000);
    } finally {
      if (wrapper && wrapper.exitCode === null) wrapper.kill("SIGKILL");
      removeContainerByName(normalContainer);
      removeContainerByName(unrelatedContainer);
      removeContainerByName(buildContainer);
      for (const volume of [
        `clashcookies-prod-build-${newSha}`,
        `clashcookies-prod-build-dist-${newSha}`,
        `clashcookies-prod-build-workspace-${newSha}`,
        `clashcookies-prod-artifact-${oldSha}-rollback-dist`,
        `clashcookies-prod-artifact-${oldSha}-rollback-node-modules`,
      ]) removeVolume(volume);
      rmSync(fixture, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  }, 180_000);

  it("removes a daemon-managed candidate after the handled client deadline", async () => {
    if (!dockerAvailable()) {
      console.warn("Skipping real Docker lifecycle integration: Docker daemon is unavailable");
      return;
    }

    const name = `clashcookies-test-candidate-${process.pid}-${Date.now()}`;
    const image = process.env.DEPLOY_TEST_IMAGE ?? "node:20-bookworm";
    const labels = [
      "com.clashcookies.deploy=candidate-build-only",
      "com.clashcookies.deploy.owner=clashcookies-deploy",
      "com.clashcookies.deploy.environment=prod",
      "com.clashcookies.deploy.role=candidate-build",
      `com.clashcookies.deploy.attempt=${name}`,
    ];
    const waitClient = (container: string) => {
      const child = spawn("docker", ["wait", container], { stdio: ["ignore", "pipe", "pipe"] });
      const done = new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
        child.on("error", () => resolve(null));
      });
      return { child, done };
    };

    try {
      execFileSync("docker", [
        "run", "-d", "--name", name,
        ...labels.flatMap((label) => ["--label", label]),
        "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.25", "--pids-limit", "64",
        image, "bash", "-lc", "sleep 30",
      ], { encoding: "utf8", timeout: 30_000 });

      const waiter = waitClient(name);
      await new Promise((resolve) => setTimeout(resolve, 500));
      waiter.child.kill();
      await waiter.done;
      execFileSync("docker", ["stop", "--time", "1", name], { encoding: "utf8", timeout: 15_000 });

      const running = execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", name], { encoding: "utf8" }).trim();
      expect(running).toBe("false");
      execFileSync("docker", ["rm", name], { encoding: "utf8", timeout: 15_000 });
      expect(() => execFileSync("docker", ["inspect", name], { stdio: "ignore" })).toThrow();
    } finally {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
      } catch {
        // The explicit verification above is authoritative; cleanup is best effort.
      }
    }
  }, 90_000);

  it("builds with the artifact volume mounted outside /app/dist", () => {
    if (!dockerAvailable()) {
      console.warn("Skipping real Docker smoke: Docker daemon is unavailable");
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const distVolume = `clashcookies-test-dist-${suffix}`;
    const nodeModulesVolume = `clashcookies-test-node-modules-${suffix}`;
    const repo = process.cwd();
    const fixture = mkdtempSync(join(tmpdir(), "clashcookies-docker-smoke-"));
    const dockerUser = typeof process.getuid === "function" && typeof process.getgid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : [];
    try {
      cpSync(repo, fixture, {
        recursive: true,
        filter: (source) => {
          const path = relative(repo, source).replaceAll("\\", "/");
          return path !== ".git" && !path.startsWith(".git/") && path !== "node_modules" && !path.startsWith("node_modules/") && path !== "dist" && !path.startsWith("dist/");
        },
      });
      execFileSync("docker", ["volume", "create", distVolume], { encoding: "utf8" });
      execFileSync("docker", ["volume", "create", nodeModulesVolume], { encoding: "utf8" });
      execFileSync("docker", ["run", "--rm", "-v", `${distVolume}:/dist`, "node:20-bookworm", "bash", "-lc", "chmod -R a+rwX /dist"], { timeout: 30_000 });
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${join(repo, "node_modules")}:/source:ro`,
          "-v",
          `${nodeModulesVolume}:/target`,
          "node:20-bookworm",
          "bash",
          "-lc",
          `cp -a /source/. /target/ && chown -R ${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000} /target`,
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          ...dockerUser,
          "-v",
          `${fixture}:/app`,
          "-v",
          `${nodeModulesVolume}:/app/node_modules`,
          "-v",
          `${distVolume}:/build-dist`,
          "-w",
          "/app",
          "node:20-bookworm",
          "bash",
          "-lc",
          "npm run build && test -d /app/dist && find /build-dist -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -r /app/dist/. /build-dist/ && test -s /build-dist/ClashCookies.js",
        ],
        { cwd: repo, stdio: "pipe", timeout: 900_000 },
      );
      expect(
        execFileSync(
          "docker",
          ["run", "--rm", ...dockerUser, "-v", `${distVolume}:/dist:ro`, "node:20-bookworm", "bash", "-lc", "test -s /dist/ClashCookies.js"],
          { encoding: "utf8", timeout: 30_000 },
        ),
      ).toBe("");
    } finally {
      execFileSync("docker", ["volume", "rm", "-f", distVolume], { stdio: "ignore" });
      execFileSync("docker", ["volume", "rm", "-f", nodeModulesVolume], { stdio: "ignore" });
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 1_000_000);

  it("stamps and verifies artifacts through the deployment helpers", () => {
    if (!dockerAvailable()) {
      console.warn("Skipping real Docker artifact verification: Docker daemon is unavailable");
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const distVolume = `clashcookies-test-artifact-dist-${suffix}`;
    const nodeModulesVolume = `clashcookies-test-artifact-node-modules-${suffix}`;
    const repo = process.cwd();
    const deployScript = join(repo, "ops", "deploy", "deploy-prod.sh");
    const fixture = mkdtempSync(join(tmpdir(), "clashcookies-artifact-smoke-"));
    const sourceDist = join(fixture, "dist");
    const sourceNodeModules = join(fixture, "node_modules");
    const revision = "artifact-test-revision";
    mkdirSync(sourceDist, { recursive: true });
    mkdirSync(join(sourceNodeModules, "fixture-package"), { recursive: true });
    writeFileSync(join(sourceDist, "ClashCookies.js"), "artifact-source\n");
    writeFileSync(join(sourceDist, "nested.txt"), "nested-source\n");
    writeFileSync(join(sourceNodeModules, "fixture-package", "index.js"), "dependency-source\n");

    try {
      execFileSync("docker", ["volume", "create", distVolume], { encoding: "utf8" });
      execFileSync("docker", ["volume", "create", nodeModulesVolume], { encoding: "utf8" });
      const result = spawnSync(
        bashExecutable(),
        [deployScript, sourceDist, sourceNodeModules, distVolume, nodeModulesVolume, revision],
        {
          cwd: repo,
          encoding: "utf8",
          timeout: 120_000,
          env: {
            ...process.env,
            DEPLOY_PROD_ARTIFACT_TEST_MODE: "1",
            DEPLOY_INTENT_DIR: join(fixture, "attempt-intents"),
            DEPLOY_DIAGNOSTIC_DIR: join(fixture, "diagnostics"),
            ARTIFACT_IMAGE: "node:20-bookworm",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.error, `artifact wrapper spawn failed\n${sanitizeWrapperOutput(output)}`).toBeUndefined();
      expectWrapperStatus(result.status, 0, output, "artifact wrapper");
      expectWrapperOutput(output, `artifact_test=success revision=${revision}`, "artifact wrapper");
      const marker = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${distVolume}:/dist:ro`,
          "node:20-bookworm",
          "bash",
          "-lc",
          "cat /dist/.clashcookies-artifact",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(marker).toContain(`revision=${revision}`);
      expect(marker).toContain("dist_digest=");
      expect(marker).toContain("node_modules_digest=");
    } finally {
      execFileSync("docker", ["volume", "rm", "-f", distVolume], { stdio: "ignore" });
      execFileSync("docker", ["volume", "rm", "-f", nodeModulesVolume], { stdio: "ignore" });
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 180_000);
});
