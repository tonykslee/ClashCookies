import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function fixture(options: { unsafe?: boolean; escapingSymlink?: boolean; missingManifest?: boolean; missingRuntime?: boolean; realTar?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-runtime-artifact-test-"));
  const name = `clashcookies-runtime-${sourceSha}.tar.gz`;
  const archivePath = join(root, name);
  const entries: Entry[] = [
    { name: "dist", type: "directory" },
    ...(options.missingRuntime ? [] : [{ name: "dist/ClashCookies.js", content: "#!/usr/bin/env node\n", mode: 0o755 }]),
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
    { name: "node_modules/prisma/build/index.js", content: "#!/usr/bin/env node\nconsole.log('prisma');\n", mode: 0o755 },
    { name: "node_modules/.bin", type: "directory" },
    { name: "node_modules/.bin/prisma", type: "symlink", link: "../prisma/build/index.js" },
    { name: "prisma", type: "directory" },
    { name: "prisma/schema.prisma", content: "generator client { provider = \"prisma-client-js\" }\n" },
    { name: "package.json", content: "{}\n" },
    { name: "yarn.lock", content: "# fixture lock\n" },
  ];
  if (!options.missingManifest) entries.push({ name: "runtime-artifact-manifest.json", content: "PLACEHOLDER\n" });
  if (options.unsafe) entries.push({ name: "../escape.txt", content: "nope" });
  if (options.escapingSymlink) entries.push({ name: "node_modules/escape", type: "symlink", link: "../../outside" });
  if (options.realTar) {
    entries.push({ name: "node_modules/long-package", type: "directory" });
    entries.push({ name: `node_modules/long-package/${"x".repeat(150)}.js`, content: "long path\n" });
  }

  const manifest = {
    schemaVersion: 1,
    artifact: { name, format: "tar.gz", contents: ["dist", "node_modules", "prisma", "package.json", "yarn.lock"], nonProductionEvidence: true },
    source: { gitSha: sourceSha, context: "git-archive", untrackedFilesExcluded: true, localEnvironmentFilesExcluded: true, cleanSourceContext: true },
    identity: { kind: "pull_request_merge_commit", event: "pull_request", deployableRelease: false, note: "test" },
    provenance: { integrity: "archive SHA-256 checksum and manifest binding", authenticated: false, note: "Integrity metadata does not authenticate the source revision or authorize production use." },
    workflow: { name: "test", runId: "1", runAttempt: "1", ref: "refs/pull/1/merge", repository: "test/test", url: null },
    build: { platform: "linux/amd64", architecture: "amd64", nodeVersion: "v20.0.0", yarnVersion: "1.22.22", compiler: "npm run build", baseImage: "node:20-bookworm@sha256:" + "a".repeat(64), baseImageDigest: "sha256:" + "a".repeat(64), nativeLibraryCompatibility: { libc: "glibc", distribution: "Debian Bookworm", openssl: "OpenSSL 3.x", liveVmCompatibility: "not established" }, durationMs: 1, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z" },
    inputs: { packageJsonSha256: "", yarnLockSha256: "", prismaSchemaSha256: "", prismaMigrations: [] },
    integrity: { checksumFile: `${name}.sha256`, sha256: null },
    measurements: { archiveBytes: null, extractedFootprintBytes: null },
    runtimeValidation: { requiredFiles: ["dist/ClashCookies.js", "node_modules/@prisma/client/default.js", "node_modules/.prisma/client/index.js", "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", "node_modules/prisma/build/index.js", "node_modules/.bin/prisma", "prisma/schema.prisma", "package.json", "yarn.lock"], prohibitedActions: ["source compilation", "dependency installation", "prisma generate"] },
  };
  const contentHash = (name: string) => createHash("sha256").update(Buffer.from(entries.find((entry) => entry.name === name)?.content ?? "", "utf8")).digest("hex");
  manifest.inputs.packageJsonSha256 = contentHash("package.json");
  manifest.inputs.yarnLockSha256 = contentHash("yarn.lock");
  manifest.inputs.prismaSchemaSha256 = contentHash("prisma/schema.prisma");
  const embeddedManifest = entries.find((entry) => entry.name === "runtime-artifact-manifest.json");
  if (embeddedManifest) embeddedManifest.content = `${JSON.stringify(manifest)}\n`;
  let archive: Buffer;
  if (options.realTar) {
    const payload = join(root, "payload");
    for (const entry of entries) {
      const entryPath = join(payload, ...entry.name.split("/"));
      if (entry.type === "directory") mkdirSync(entryPath, { recursive: true });
      else if (entry.type === "symlink") { mkdirSync(join(entryPath, ".."), { recursive: true }); symlinkSync(entry.link ?? "", entryPath); }
      else { mkdirSync(join(entryPath, ".."), { recursive: true }); writeFileSync(entryPath, entry.content ?? "", { mode: entry.mode ?? 0o644 }); chmodSync(entryPath, entry.mode ?? 0o644); }
    }
    execFileSync("tar", ["--format=posix", "-czf", archivePath, "-C", payload, "dist", "node_modules", "prisma", "package.json", "yarn.lock", "runtime-artifact-manifest.json"], { stdio: "pipe" });
    archive = readFileSync(archivePath);
  } else {
    archive = tar(entries);
    writeFileSync(archivePath, archive);
  }
  const digest = createHash("sha256").update(archive).digest("hex");
  writeFileSync(`${archivePath}.sha256`, `${digest}  ${name}\n`);
  const footprint = entries.filter((entry) => entry.type !== "directory" && entry.type !== "symlink" && (entry.name === "package.json" || entry.name.startsWith("dist/") || entry.name.startsWith("node_modules/") || entry.name === "prisma" || entry.name.startsWith("prisma/"))).reduce((total, entry) => total + Buffer.byteLength(entry.content ?? "", "utf8"), 0);
  writeFileSync(`${archivePath}.manifest.json`, `${JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, archiveSha256: digest, archiveBytes: archive.length }, integrity: { ...manifest.integrity, sha256: digest }, measurements: { archiveBytes: archive.length, extractedFootprintBytes: footprint } }, null, 2)}\n`);
  return { root, archivePath };
}

function runValidation(archivePath: string, ...extra: string[]) {
  const command = process.platform === "win32" ? "python" : "bash";
  const commandArgs = process.platform === "win32"
    ? [join(process.cwd(), "scripts", "validate-runtime-artifact.py")]
    : [join(process.cwd(), "scripts", "validate-runtime-artifact.sh")];
  return execFileSync(command, [...commandArgs, "--archive", archivePath, "--checksum", `${archivePath}.sha256`, "--manifest", `${archivePath}.manifest.json`, "--expected-sha", sourceSha, ...extra], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" });
}

describe("runtime artifact validation", () => {
  it("delivers the clean Git source archive to the Docker build stdin", () => {
    const root = mkdtempSync(join(tmpdir(), "clashcookies-runtime-builder-test-"));
    const fakeBin = join(root, "bin");
    const capture = join(root, "source.tar");
    const output = join(root, "output");
    mkdirSync(fakeBin);
    mkdirSync(output);
    const fakeDocker = join(fakeBin, "docker");
    writeFileSync(fakeDocker, "#!/usr/bin/env bash\ncat > \"$DOCKER_CAPTURE\"\n", { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const pathSeparator = process.platform === "win32" ? ";" : ":";
    const env = { ...process.env, DOCKER_CAPTURE: capture, PATH: `${fakeBin}${pathSeparator}${process.env.PATH ?? ""}` };
    execFileSync(bash, [join(process.cwd(), "scripts", "build-runtime-artifact.sh"), "--output", output, "--expected-sha", sourceSha], { cwd: process.cwd(), env, encoding: "utf8", stdio: "pipe" });
    const archiveListing = execFileSync("tar", ["-tf", capture], { encoding: "utf8" });
    expect(archiveListing).toContain("package.json");
    expect(readFileSync(capture).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("validates and extracts a SHA-bound archive while preserving executable permissions", () => {
    const value = fixture();
    const extracted = join(value.root, "extracted");
    const extractionArgs = process.platform === "win32" ? [] : ["--extract", extracted];
    expect(runValidation(value.archivePath, ...extractionArgs)).toContain(sourceSha);
    if (process.platform !== "win32") expect(statSync(join(extracted, "dist", "ClashCookies.js")).mode & 0o111).toBeTruthy();
    rmSync(value.root, { recursive: true, force: true });
  });

  it("accepts real GNU tar output with trailing directories, long paths, and internal symlinks", () => {
    if (process.platform === "win32") return;
    if (!execFileSync("tar", ["--version"], { encoding: "utf8" }).startsWith("tar (GNU tar)")) return;
    const value = fixture({ realTar: true });
    expect(runValidation(value.archivePath)).toContain(sourceSha);
    rmSync(value.root, { recursive: true, force: true });
  });

  it.each([
    ["missing embedded manifest", { missingManifest: true }],
    ["unsafe path", { unsafe: true }],
    ["escaping symlink", { escapingSymlink: true }],
    ["missing runtime file", { missingRuntime: true }],
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

  it("rejects independent-context mismatches and resource-limit violations", () => {
    const value = fixture();
    expect(() => runValidation(value.archivePath, "--expected-repository", "wrong/repository")).toThrow();
    expect(() => runValidation(value.archivePath, "--expected-platform", "linux/arm64")).toThrow();
    expect(() => runValidation(value.archivePath, "--max-expanded-bytes", "1")).toThrow();
    expect(() => runValidation(value.archivePath, "--max-entries", "1")).toThrow();
    rmSync(value.root, { recursive: true, force: true });
  });

  it("rejects a corrupt archive even when its checksum sidecar is updated", () => {
    const value = fixture();
    const corrupted = Buffer.from(readFileSync(value.archivePath));
    corrupted[Math.min(40, corrupted.length - 1)] ^= 0xff;
    writeFileSync(value.archivePath, corrupted);
    const digest = createHash("sha256").update(corrupted).digest("hex");
    writeFileSync(`${value.archivePath}.sha256`, `${digest}  ${value.archivePath.split(/[\\/]/).pop()}\n`);
    expect(() => runValidation(value.archivePath)).toThrow();
    rmSync(value.root, { recursive: true, force: true });
  });
});
