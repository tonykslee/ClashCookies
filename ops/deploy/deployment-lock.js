"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OWNER_FILE = "owner.json";

class LockCoordinationError extends Error {
  constructor(reason) {
    super(`lock_${reason}`);
    this.name = "LockCoordinationError";
    this.reason = reason;
  }
}

function assertAbsoluteLockPath(lockPath) {
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath)
    || lockPath.endsWith("\\") || lockPath.endsWith("/")) {
    throw new LockCoordinationError("unavailable");
  }
}

function assertNoSymlinkComponents(filePath, fsImpl) {
  if (typeof fsImpl.lstatSync !== "function") throw new LockCoordinationError("unavailable");
  const absolutePath = path.resolve(filePath);
  const root = path.parse(absolutePath).root;
  const relative = path.relative(root, absolutePath);
  let current = root;

  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fsImpl.lstatSync(current);
    } catch {
      throw new LockCoordinationError("unavailable");
    }
    if (stat.isSymbolicLink()) throw new LockCoordinationError("unavailable");
  }
}

function isDirectory(stat) {
  return Boolean(stat && typeof stat.isDirectory === "function" && stat.isDirectory()
    && typeof stat.isSymbolicLink === "function" && !stat.isSymbolicLink());
}

function isRegularFile(stat) {
  return Boolean(stat && typeof stat.isFile === "function" && stat.isFile()
    && typeof stat.isSymbolicLink === "function" && !stat.isSymbolicLink());
}

function sameIdentity(expected, actual) {
  if (!expected || !actual) return false;
  for (const field of ["dev", "ino"]) {
    if (expected[field] === undefined || actual[field] === undefined
      || expected[field] !== actual[field]) return false;
  }
  return true;
}

function readVerifiedOwner(ownerPath, expectedStat, fsImpl) {
  if (typeof fsImpl.openSync === "function" && typeof fsImpl.fstatSync === "function"
    && typeof fsImpl.closeSync === "function" && typeof fsImpl.readFileSync === "function") {
    const noFollow = fsImpl.constants && typeof fsImpl.constants.O_NOFOLLOW === "number"
      ? fsImpl.constants.O_NOFOLLOW : 0;
    const readOnly = fsImpl.constants && typeof fsImpl.constants.O_RDONLY === "number"
      ? fsImpl.constants.O_RDONLY : 0;
    const fd = fsImpl.openSync(ownerPath, readOnly | noFollow);
    try {
      const openedStat = fsImpl.fstatSync(fd);
      if (!isRegularFile(openedStat) || !sameIdentity(expectedStat, openedStat)) {
        throw new LockCoordinationError("owner_replaced");
      }
      return String(fsImpl.readFileSync(fd, "utf8"));
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  const currentStat = fsImpl.lstatSync(ownerPath);
  if (!isRegularFile(currentStat) || !sameIdentity(expectedStat, currentStat)) {
    throw new LockCoordinationError("owner_replaced");
  }
  return String(fsImpl.readFileSync(ownerPath, "utf8"));
}

function isAbsent(filePath, fsImpl) {
  try {
    fsImpl.lstatSync(filePath);
    return false;
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
}

/** Acquire an atomic directory lock. Existing state is never treated as stale. */
function acquireExclusiveHostLock(lockPath, owner = {}, fsImpl = fs) {
  assertAbsoluteLockPath(lockPath);
  assertNoSymlinkComponents(path.dirname(lockPath), fsImpl);

  try {
    fsImpl.mkdirSync(lockPath);
  } catch (error) {
    if (error && error.code === "EEXIST") throw new LockCoordinationError("already_held");
    throw new LockCoordinationError("unavailable");
  }

  const ownerPath = path.join(lockPath, OWNER_FILE);
  const ownerRecord = JSON.stringify({
    pid: process.pid,
    token: crypto.randomBytes(16).toString("hex"),
    ...(typeof owner === "string" ? { startedAt: owner } : owner),
  });
  let lockStat;

  try {
    lockStat = fsImpl.lstatSync(lockPath);
    if (!isDirectory(lockStat)) throw new LockCoordinationError("initialization_failed");
    fsImpl.writeFileSync(ownerPath, ownerRecord, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const ownerStat = fsImpl.lstatSync(ownerPath);
    if (!isRegularFile(ownerStat)) throw new LockCoordinationError("initialization_failed");

    let released = false;
    let releaseResult = false;
    return () => {
      if (released) return releaseResult;
      released = true;
      try {
        const currentLockStat = fsImpl.lstatSync(lockPath);
        if (!isDirectory(currentLockStat) || !sameIdentity(lockStat, currentLockStat)) {
          return false;
        }
        const currentOwnerStat = fsImpl.lstatSync(ownerPath);
        if (!isRegularFile(currentOwnerStat) || !sameIdentity(ownerStat, currentOwnerStat)) {
          return false;
        }
        if (readVerifiedOwner(ownerPath, ownerStat, fsImpl) !== ownerRecord) return false;

        fsImpl.unlinkSync(ownerPath);
        const afterUnlinkLockStat = fsImpl.lstatSync(lockPath);
        if (!isDirectory(afterUnlinkLockStat) || !sameIdentity(lockStat, afterUnlinkLockStat)) return false;
        if (!isAbsent(ownerPath, fsImpl)) return false;
        if (typeof fsImpl.readdirSync !== "function" || fsImpl.readdirSync(lockPath).length !== 0) return false;
        fsImpl.rmdirSync(lockPath);
        if (!isAbsent(lockPath, fsImpl)) return false;
        releaseResult = true;
        return true;
      } catch {
        return false;
      }
    };
  } catch (error) {
    if (error instanceof LockCoordinationError) throw error;
    throw new LockCoordinationError("initialization_failed");
  }
}

module.exports = {
  OWNER_FILE,
  LockCoordinationError,
  acquireExclusiveHostLock,
};
