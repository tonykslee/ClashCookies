import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

describe("real Git deployment worktree cleanup", () => {
  it("removes a disposable worktree containing ignored dist artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-worktree-"));
    const repo = join(root, "repo");
    const candidate = join(root, "candidate");
    const deployScript = readFileSync(join(process.cwd(), "ops", "deploy", "deploy-prod.sh"), "utf8");

    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, ".gitignore"), "dist/\n");
      writeFileSync(join(repo, "src", "entry.txt"), "tracked\n");
      execFileSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf8" });
      git(repo, ["config", "user.name", "Worktree Test"]);
      git(repo, ["config", "user.email", "worktree-test@example.invalid"]);
      git(repo, ["add", ".gitignore", "src/entry.txt"]);
      git(repo, ["commit", "-m", "initial"]);
      git(repo, ["worktree", "add", "--detach", candidate, "HEAD"]);

      mkdirSync(join(candidate, "dist"), { recursive: true });
      writeFileSync(join(candidate, "dist", "ClashCookies.js"), "ignored build artifact\n");
      expect(git(candidate, ["check-ignore", "dist/ClashCookies.js"]).trim()).toBe("dist/ClashCookies.js");
      expect(deployScript).toContain('git_safe worktree remove "$TEMP_WORKTREE" >/dev/null');
      expect(deployScript).not.toContain("git_safe worktree remove --quiet");

      execFileSync("git", ["-c", "safe.directory=" + repo, "-C", repo, "worktree", "remove", candidate], {
        cwd: repo,
        encoding: "utf8",
      });

      expect(existsSync(candidate)).toBe(false);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(candidate);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds from a read-only worktree into an isolated workspace before unprivileged cleanup", () => {
    if (!dockerAvailable()) {
      console.warn("Skipping real Docker worktree-isolation test: Docker daemon is unavailable");
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "clashcookies-worktree-docker-"));
    const repo = join(root, "repo");
    const candidate = join(root, "candidate");
    const workspaceVolume = `clashcookies-test-build-workspace-${process.pid}-${Date.now()}`;
    const deployScript = readFileSync(join(process.cwd(), "ops", "deploy", "deploy-prod.sh"), "utf8");

    try {
      mkdirSync(join(repo, "scripts"), { recursive: true });
      writeFileSync(join(repo, ".gitignore"), "dist/\n");
      writeFileSync(join(repo, "package.json"), '{"scripts":{"build":"node scripts/build.js"}}\n');
      writeFileSync(
        join(repo, "scripts", "build.js"),
        'const fs = require("node:fs"); fs.mkdirSync("dist", { recursive: true }); fs.writeFileSync("dist/compiled.txt", "compiled\\n");\n',
      );
      execFileSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf8" });
      git(repo, ["config", "user.name", "Worktree Docker Test"]);
      git(repo, ["config", "user.email", "worktree-docker-test@example.invalid"]);
      git(repo, ["add", ".gitignore", "package.json", "scripts/build.js"]);
      git(repo, ["commit", "-m", "initial"]);
      git(repo, ["worktree", "add", "--detach", candidate, "HEAD"]);

      expect(deployScript).toContain('-v "$TEMP_WORKTREE:/source:ro"');
      expect(deployScript).toContain('-v "$BUILD_WORKSPACE_VOLUME:/app"');
      expect(deployScript).not.toContain('-v "$TEMP_WORKTREE:/app"');

      execFileSync("docker", ["volume", "create", workspaceVolume], { encoding: "utf8" });
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${candidate}:/source:ro`,
          "-v",
          `${workspaceVolume}:/app`,
          "-w",
          "/app",
          "node:20-bookworm",
          "bash",
          "-lc",
          "set -euo pipefail; cp -a /source/. /app/; npm run build; test -s /app/dist/compiled.txt; test \"$(stat -c '%u:%g' /app/dist/compiled.txt)\" = 0:0",
        ],
        { encoding: "utf8", timeout: 120_000 },
      );

      expect(existsSync(join(candidate, "dist"))).toBe(false);
      execFileSync("git", ["-c", "safe.directory=" + repo, "-C", repo, "worktree", "remove", candidate], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(existsSync(candidate)).toBe(false);
      expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(candidate);
    } finally {
      try {
        execFileSync("docker", ["volume", "rm", "-f", workspaceVolume], { stdio: "ignore" });
      } catch {
        // The disposable volume may not have been created if Docker failed early.
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
