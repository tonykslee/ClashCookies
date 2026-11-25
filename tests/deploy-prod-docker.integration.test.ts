import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function bashExecutable(): string {
  return process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
}

describe("real Docker deployment artifact smoke", () => {
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
      const output = execFileSync(
        bashExecutable(),
        [deployScript, sourceDist, sourceNodeModules, distVolume, nodeModulesVolume, revision],
        {
          cwd: repo,
          encoding: "utf8",
          timeout: 120_000,
          env: {
            ...process.env,
            DEPLOY_PROD_ARTIFACT_TEST_MODE: "1",
            ARTIFACT_IMAGE: "node:20-bookworm",
          },
        },
      );
      expect(output).toContain(`artifact_test=success revision=${revision}`);
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
