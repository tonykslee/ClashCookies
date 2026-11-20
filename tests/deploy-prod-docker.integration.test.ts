import { execFileSync } from "node:child_process";
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
    const repo = process.cwd();
    try {
      execFileSync("docker", ["volume", "create", distVolume], { encoding: "utf8" });
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${repo}:/app`,
          "-v",
          `${distVolume}:/build-dist`,
          "-w",
          "/app",
          "node:20-bookworm",
          "bash",
          "-lc",
          "./ops/deploy/ensure-yarn-deps.sh && npm run build && test -d /app/dist && find /build-dist -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /app/dist/. /build-dist/ && test -s /build-dist/ClashCookies.js",
        ],
        { cwd: repo, stdio: "pipe", timeout: 900_000 },
      );
      expect(
        execFileSync(
          "docker",
          ["run", "--rm", "-v", `${distVolume}:/dist:ro`, "node:20-bookworm", "bash", "-lc", "test -s /dist/ClashCookies.js"],
          { encoding: "utf8", timeout: 30_000 },
        ),
      ).toBe("");
    } finally {
      execFileSync("docker", ["volume", "rm", "-f", distVolume], { stdio: "ignore" });
    }
  }, 1_000_000);
});
