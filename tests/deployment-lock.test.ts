import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require("../ops/deploy/deployment-lock.js") as typeof import("../ops/deploy/deployment-lock.js");

const roots = new Set<string>();

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-deployment-lock-"));
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("shared deployment lock contract", () => {
  it("allows only one concurrent release owner and permits a later owner after verified release", () => {
    const lockPath = join(makeRoot(), "release.lock");
    const release = lock.acquireExclusiveHostLock(lockPath, { entrypoint: "test-a" });

    expect(() => lock.acquireExclusiveHostLock(lockPath, { entrypoint: "test-b" }))
      .toThrow(/already_held/i);
    expect(release()).toBe(true);

    const releaseAfter = lock.acquireExclusiveHostLock(lockPath, { entrypoint: "test-b" });
    expect(releaseAfter()).toBe(true);
  });

  it("never removes a corrupt or ambiguous pre-existing lock", () => {
    const root = makeRoot();
    const lockPath = join(root, "release.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), "not-json");

    expect(() => lock.acquireExclusiveHostLock(lockPath)).toThrow(/already_held/i);
    expect(readFileSync(join(lockPath, "owner.json"), "utf8")).toBe("not-json");
  });

  it("fails closed when the owner record is replaced or corrupted", () => {
    const lockPath = join(makeRoot(), "release.lock");
    const release = lock.acquireExclusiveHostLock(lockPath, { entrypoint: "test" });
    writeFileSync(join(lockPath, "owner.json"), "replacement");

    expect(release()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("fails closed when the lock directory is replaced", () => {
    const root = makeRoot();
    const lockPath = join(root, "release.lock");
    const movedPath = join(root, "moved.lock");
    const release = lock.acquireExclusiveHostLock(lockPath, { entrypoint: "test" });
    renameSync(lockPath, movedPath);
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), "replacement");

    expect(release()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(movedPath)).toBe(true);
  });

  it("fails closed on cleanup failure and leaves ambiguous contents for review", () => {
    const lockPath = join(makeRoot(), "release.lock");
    const release = lock.acquireExclusiveHostLock(lockPath, { entrypoint: "test" });
    writeFileSync(join(lockPath, "unexpected"), "operator-state");

    expect(release()).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(lockPath, "unexpected"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("fails closed on lock-path symlink substitution", () => {
    const root = makeRoot();
    const lockPath = join(root, "release.lock");
    const movedPath = join(root, "moved.lock");
    const release = lock.acquireExclusiveHostLock(lockPath, { entrypoint: "test" });
    renameSync(lockPath, movedPath);
    symlinkSync(movedPath, lockPath, "dir");

    expect(release()).toBe(false);
  });
});
