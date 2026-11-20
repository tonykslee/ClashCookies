import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
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

describe("real Docker deployment artifact smoke", () => {
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
          "npm run build && test -d /app/dist && find /build-dist -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /app/dist/. /build-dist/ && test -s /build-dist/ClashCookies.js",
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
});
