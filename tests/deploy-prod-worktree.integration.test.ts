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
});
