import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

type Entry = { name: string; content?: string; type?: "file" | "directory" | "symlink"; link?: string; mode?: number };
const sourceSha = "0123456789abcdef0123456789abcdef01234567";

function tar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const block = Buffer.alloc(512);
    const type = entry.type ?? "file";
    const mode = (entry.mode ?? (type === "directory" ? 0o755 : type === "symlink" ? 0o777 : 0o644)).toString(8).padStart(7, "0");
    block.write(entry.name, 0, 100, "utf8");
    block.write(mode, 100, 7, "ascii");
    block.write("0000000", 108, 8, "ascii");
    block.write("0000000", 116, 8, "ascii");
    const data = Buffer.from(entry.content ?? "", "utf8");
    block.write((type === "file" ? data.length : 0).toString(8).padStart(11, "0"), 124, 11, "ascii");
    block[156] = type === "directory" ? 53 : type === "symlink" ? 50 : 48;
    if (entry.link) block.write(entry.link, 157, 100, "utf8");
    block.fill(32, 148, 156);
    let checksum = 0;
    for (const byte of block) checksum += byte;
    block.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    blocks.push(block);
    if (type === "file") {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function fixture(options: { unsafe?: boolean; escapingSymlink?: boolean; missingManifest?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-runtime-artifact-test-"));
  const name = `clashcookies-runtime-${sourceSha}.tar.gz`;
  const archivePath = join(root, name);
  const entries: Entry[] = [
    { name: "dist", type: "directory" },
    { name: "dist/ClashCookies.js", content: "#!/usr/bin/env node\n", mode: 0o755 },
    { name: "node_modules", type: "directory" },
    { name: "node_modules/@prisma", type: "directory" },
    { name: "node_modules/@prisma/client", type: "directory" },
    { name: "node_modules/@prisma/client/default.js", content: "module.exports = {};\n" },
    { name: "node_modules/.prisma", type: "directory" },
    { name: "node_modules/.prisma/client", type: "directory" },
    { name: "node_modules/.prisma/client/index.js", content: "module.exports = {};\n" },
    { name: "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", content: "engine\n" },
    { name: "node_modules/prisma", type: "directory" },
    { name: "node_modules/prisma/build", type: "directory" },
    { name: "node_modules/prisma/build/index.js", content: "console.log('prisma');\n" },
    { name: "node_modules/.bin", type: "directory" },
    { name: "node_modules/.bin/prisma", type: "symlink", link: "../prisma/build/index.js" },
    { name: "prisma", type: "directory" },
    { name: "prisma/schema.prisma", content: "generator client { provider = \"prisma-client-js\" }\n" },
    { name: "package.json", content: "{}\n" },
  ];
  if (!options.missingManifest) entries.push({ name: "runtime-artifact-manifest.json", content: "PLACEHOLDER\n" });
  if (options.unsafe) entries.push({ name: "../escape.txt", content: "nope" });
  if (options.escapingSymlink) entries.push({ name: "node_modules/escape", type: "symlink", link: "../../outside" });

  const manifest = {
    schemaVersion: 1,
    artifact: { name, format: "tar.gz", contents: ["dist", "node_modules", "prisma", "package.json"], nonProductionEvidence: true },
    source: { gitSha: sourceSha, context: "git-archive", untrackedFilesExcluded: true, localEnvironmentFilesExcluded: true, cleanSourceContext: true },
    identity: { kind: "pull_request_merge_commit", event: "pull_request", deployableRelease: false, note: "test" },
    workflow: { name: "test", runId: "1", runAttempt: "1", ref: "refs/pull/1/merge", repository: "test/test", url: null },
    build: { platform: "linux/amd64", architecture: "amd64", nodeVersion: "v20.0.0", yarnVersion: "1.22.22", compiler: "npm run build", baseImage: "node:20-bookworm@sha256:" + "a".repeat(64), baseImageDigest: "sha256:" + "a".repeat(64), nativeLibraryCompatibility: { libc: "glibc" }, durationMs: 1, startedAt: null, completedAt: "2026-01-01T00:00:00.000Z" },
    inputs: { packageJsonSha256: "a", yarnLockSha256: "b", prismaSchemaSha256: "c", prismaMigrations: [] },
    integrity: { checksumFile: `${name}.sha256`, sha256: null },
    measurements: { archiveBytes: null, extractedFootprintBytes: null },
    runtimeValidation: { requiredFiles: [], prohibitedActions: [] },
  };
  const embeddedManifest = entries.find((entry) => entry.name === "runtime-artifact-manifest.json");
  if (embeddedManifest) embeddedManifest.content = `${JSON.stringify(manifest)}\n`;
  const archive = tar(entries);
  writeFileSync(archivePath, archive);
  const digest = createHash("sha256").update(archive).digest("hex");
  writeFileSync(`${archivePath}.sha256`, `${digest}  ${name}\n`);
  writeFileSync(`${archivePath}.manifest.json`, `${JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, archiveSha256: digest, archiveBytes: archive.length }, integrity: { ...manifest.integrity, sha256: digest }, measurements: { archiveBytes: archive.length, extractedFootprintBytes: 1 } }, null, 2)}\n`);
  return { root, archivePath };
}

function runValidation(archivePath: string, ...extra: string[]) {
  return execFileSync(process.execPath, [join(process.cwd(), "scripts", "validate-runtime-artifact.js"), "--archive", archivePath, "--checksum", `${archivePath}.sha256`, "--manifest", `${archivePath}.manifest.json`, ...extra], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" });
}

describe("runtime artifact validation", () => {
  it("validates and extracts a SHA-bound archive while preserving executable permissions", () => {
    const value = fixture();
    const extracted = join(value.root, "extracted");
    const extractionArgs = process.platform === "win32" ? [] : ["--extract", extracted];
    expect(runValidation(value.archivePath, "--expected-sha", sourceSha, ...extractionArgs)).toContain(sourceSha);
    if (process.platform !== "win32") expect(statSync(join(extracted, "dist", "ClashCookies.js")).mode & 0o111).toBeTruthy();
    rmSync(value.root, { recursive: true, force: true });
  });

  it.each([
    ["missing embedded manifest", { missingManifest: true }],
    ["unsafe path", { unsafe: true }],
    ["escaping symlink", { escapingSymlink: true }],
  ])("rejects %s", (_label, options) => {
    const value = fixture(options);
    expect(() => runValidation(value.archivePath)).toThrow();
    rmSync(value.root, { recursive: true, force: true });
  });

  it("rejects an unexpected revision and a corrupt checksum", () => {
    const value = fixture();
    expect(() => runValidation(value.archivePath, "--expected-sha", "fedcba9876543210fedcba9876543210fedcba98")).toThrow();
    writeFileSync(`${value.archivePath}.sha256`, `${"0".repeat(64)}  ${value.archivePath.split(/[\\/]/).pop()}\n`);
    expect(() => runValidation(value.archivePath)).toThrow();
    rmSync(value.root, { recursive: true, force: true });
  });
});
