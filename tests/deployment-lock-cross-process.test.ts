import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = new Set<string>();

function bashExecutable(): string {
  return process.platform === "win32"
    ? "C:\\Program Files\\Git\\bin\\bash.exe"
    : "bash";
}

function shellPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  return execFileSync(bashExecutable(), ["-lc", "cygpath -u \"$CROSS_PROCESS_PATH\""], {
    env: { ...process.env, CROSS_PROCESS_PATH: filePath },
    encoding: "utf8",
  }).trim();
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-cross-process-lock-"));
  roots.add(root);
  return root;
}

function spawnAndCollect(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number | null; output: string }> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
}

function waitForFile(filePath: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 10000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        child.kill();
        reject(new Error(`timed out waiting for ${filePath}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function fixturePaths() {
  return {
    harness: join(process.cwd(), "tests", "fixtures", "deploy-prod-harness.sh"),
    deployScript: join(process.cwd(), "ops", "deploy", "deploy-prod.sh"),
    nodeFixture: join(process.cwd(), "tests", "fixtures", "deployment-lock-node-process.js"),
  };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("cross-process deployment lock coordination", () => {
  it("blocks Node deployment acquisition while Bash holds the shared path", async () => {
    const root = makeRoot();
    const lockPath = join(root, "deploy.lock");
    const readyPath = join(root, "bash.ready");
    const releasePath = join(root, "bash.release");
    const resultPath = join(root, "node-result.json");
    const paths = fixturePaths();
    const bashChild = spawn(bashExecutable(), [paths.harness, "cross-process", paths.deployScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DEPLOY_TEST_ROOT: shellPath(root),
        DEPLOY_TEST_LOCK_PATH: shellPath(lockPath),
        DEPLOY_TEST_READY_FILE: shellPath(readyPath),
        DEPLOY_TEST_RELEASE_FILE: shellPath(releasePath),
        DEPLOY_TEST_REAL_SLEEP: "/usr/bin/sleep",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bashOutput = "";
    bashChild.stdout.on("data", (chunk: Buffer) => { bashOutput += chunk.toString(); });
    bashChild.stderr.on("data", (chunk: Buffer) => { bashOutput += chunk.toString(); });

    await waitForFile(readyPath, bashChild).catch((error: Error) => {
      throw new Error(`${error.message}\nBash output:\n${bashOutput}`);
    });
    const node = await spawnAndCollect(process.execPath, [paths.nodeFixture, "attempt", lockPath, join(root, "node.ready"), join(root, "node.release"), resultPath], {});
    writeFileSync(releasePath, "release", "utf8");
    const bashStatus = await new Promise<number | null>((resolve) => bashChild.once("close", resolve));
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as { exitCode: number; calls: string[] };

    expect(node.status).toBe(0);
    expect(result.exitCode).toBe(75);
    expect(result.calls).toEqual([]);
    expect(bashStatus).toBe(0);
    expect(bashOutput).toContain("lock=acquired");
  }, 15000);

  it("blocks Bash deployment acquisition while Node holds the shared path", async () => {
    const nodeRoot = makeRoot();
    const bashRoot = makeRoot();
    const lockPath = join(nodeRoot, "deploy.lock");
    const readyPath = join(nodeRoot, "node.ready");
    const releasePath = join(nodeRoot, "node.release");
    const resultPath = join(nodeRoot, "node-result.json");
    const paths = fixturePaths();
    const nodeChild = spawn(process.execPath, [paths.nodeFixture, "hold", lockPath, readyPath, releasePath, resultPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForFile(readyPath, nodeChild);
    const bash = await spawnAndCollect(bashExecutable(), [paths.harness, "cross-process", paths.deployScript], {
      DEPLOY_TEST_ROOT: shellPath(bashRoot),
      DEPLOY_TEST_LOCK_PATH: shellPath(lockPath),
    });
    writeFileSync(releasePath, "release", "utf8");
    const nodeStatus = await new Promise<number | null>((resolve) => nodeChild.once("close", resolve));

    expect(bash.status).toBe(0);
    expect(bash.output).toContain("another_deployment_is_running");
    expect(bash.output).not.toContain("lock=acquired");
    expect(bash.output).not.toContain("GIT diff");
    expect(bash.output).not.toContain("DOCKER ps");
    expect(nodeStatus).toBe(0);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({ released: true });
  }, 15000);
});
