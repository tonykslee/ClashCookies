import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

function fixture(options: { unsafe?: boolean; escapingSymlink?: boolean; cyclicSymlink?: boolean; intermediateSymlink?: boolean; unsafeMode?: boolean; missingManifest?: boolean; missingRuntime?: boolean; realTar?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-runtime-artifact-test-"));
  const name = `clashcookies-runtime-${sourceSha}.tar.gz`;
  const archivePath = join(root, name);
  const entries: Entry[] = [
    { name: "dist", type: "directory" },
    ...(options.missingRuntime ? [] : [{ name: "dist/ClashCookies.js", content: "#!/usr/bin/env node\n", mode: options.unsafeMode ? 0o4755 : 0o755 }]),
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
  if (options.cyclicSymlink) {
    entries.push({ name: "node_modules/cycle-a", type: "symlink", link: "cycle-b" });
    entries.push({ name: "node_modules/cycle-b", type: "symlink", link: "cycle-a" });
  }
  if (options.intermediateSymlink) {
    entries.push({ name: "node_modules/intermediate", type: "symlink", link: "../../outside" });
    entries.push({ name: "node_modules/traversal", type: "symlink", link: "intermediate/../prisma" });
  }
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
  const footprint = entries.filter((entry) => entry.type !== "directory" && entry.type !== "symlink" && (entry.name === "package.json" || entry.name === "yarn.lock" || entry.name === "runtime-artifact-manifest.json" || entry.name.startsWith("dist/") || entry.name.startsWith("node_modules/") || entry.name.startsWith("prisma/"))).reduce((total, entry) => total + Buffer.byteLength(entry.content ?? "", "utf8"), 0);
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

function expectValidationFailure(archivePath: string, reason: string, ...extra: string[]) {
  let stderr = "";
  try {
    runValidation(archivePath, ...extra);
  } catch (error) {
    stderr = String((error as { stderr?: unknown }).stderr ?? "");
  }
  if (!stderr) throw new Error(`expected validation subprocess to fail with stderr containing ${JSON.stringify(reason)}`);
  expect(stderr).toContain(reason);
}

function refreshExternalIntegrity(archivePath: string) {
  const archive = readFileSync(archivePath);
  const digest = createHash("sha256").update(archive).digest("hex");
  const manifestPath = `${archivePath}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { artifact: Record<string, unknown>; integrity: Record<string, unknown>; measurements: Record<string, unknown> };
  manifest.artifact.archiveSha256 = digest;
  manifest.artifact.archiveBytes = archive.length;
  manifest.integrity.sha256 = digest;
  manifest.measurements.archiveBytes = archive.length;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${archivePath}.sha256`, `${digest}  ${archivePath.split(/[\\/]/).pop()}\n`);
}

function producerContractFixture() {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-runtime-producer-contract-"));
  const payload = join(root, "payload");
  const name = `clashcookies-runtime-${sourceSha}.tar.gz`;
  const archivePath = join(root, name);
  const image = "node:20-bookworm@sha256:" + "a".repeat(64);
  const writePayload = (name: string, content: string, mode = 0o644) => {
    const path = join(payload, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    chmodSync(path, mode);
  };
  for (const path of ["dist", "node_modules", "node_modules/@prisma", "node_modules/@prisma/client", "node_modules/.prisma", "node_modules/.prisma/client", "node_modules/prisma", "node_modules/prisma/build", "node_modules/.bin", "prisma", "prisma/migrations", "prisma/migrations/20260101000000_fixture"]) mkdirSync(join(payload, ...path.split("/")), { recursive: true });
  writePayload("dist/ClashCookies.js", "compiled\n", 0o755);
  writePayload("node_modules/@prisma/client/default.js", "module.exports = {};\n");
  writePayload("node_modules/.prisma/client/index.js", "module.exports = {};\n");
  writePayload("node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", "engine\n");
  writePayload("node_modules/prisma/build/index.js", "#!/usr/bin/env node\n", 0o755);
  symlinkSync("../prisma/build/index.js", join(payload, "node_modules/.bin/prisma"));
  writePayload("prisma/schema.prisma", "generator client { provider = \"prisma-client-js\" }\n");
  writePayload("prisma/migrations/20260101000000_fixture/migration.sql", "-- fixture\n");
  writePayload("package.json", "{}\n");
  writePayload("yarn.lock", "# fixture\n");
  const env = { ...process.env, SOURCE_SHA: sourceSha, ARTIFACT_NAME: name, BUILD_IMAGE: image, BUILD_PLATFORM: "linux/amd64", BUILD_ARCHITECTURE: "amd64", NODE_VERSION: "v20.0.0", YARN_VERSION: "1.22.22", BUILD_DURATION_MS: "7", BUILD_STARTED_AT: "2026-01-01T00:00:00Z", GITHUB_EVENT_NAME: "pull_request", GITHUB_WORKFLOW: "contract", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "3", GITHUB_REF: "refs/pull/1/merge", GITHUB_REPOSITORY: "test/test", GITHUB_SERVER_URL: "https://github.com" };
  execFileSync(process.execPath, [join(process.cwd(), "scripts", "runtime-artifact-manifest.js"), "--root", payload, "--output", join(payload, "runtime-artifact-manifest.json")], { cwd: process.cwd(), env, stdio: "pipe" });
  execFileSync("tar", ["--format=posix", "-czf", archivePath, "-C", payload, "dist", "node_modules", "prisma", "package.json", "yarn.lock", "runtime-artifact-manifest.json"], { stdio: "pipe" });
  const archive = readFileSync(archivePath);
  const digest = createHash("sha256").update(archive).digest("hex");
  execFileSync(process.execPath, [join(process.cwd(), "scripts", "finalize-runtime-artifact.js"), "--root", payload, "--embedded", join(payload, "runtime-artifact-manifest.json"), "--output", `${archivePath}.manifest.json`, "--sha256", digest, "--archive-bytes", String(statSync(archivePath).size)], { cwd: process.cwd(), env, stdio: "pipe" });
  writeFileSync(`${archivePath}.sha256`, `${digest}  ${name}\n`);
  return { root, archivePath, image };
}

describe("runtime artifact validation", () => {
  it("normalizes group-writable, setgid, and sticky producer directories/files without following dependency symlinks", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "clashcookies-runtime-permissions-test-"));
    const packageRoot = join(root, "package");
    const dependencyRoot = join(packageRoot, "node_modules", "fixture");
    mkdirSync(dependencyRoot, { recursive: true, mode: 0o2777 });
    const stickyRoot = join(packageRoot, "sticky");
    mkdirSync(stickyRoot, { recursive: true, mode: 0o1777 });
    chmodSync(dependencyRoot, 0o2777);
    chmodSync(stickyRoot, 0o1777);
    const target = join(dependencyRoot, "target.js");
    writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o777 });
    chmodSync(target, 0o777);
    symlinkSync("fixture/target.js", join(packageRoot, "node_modules", "link.js"));
    execFileSync(process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash", [join(process.cwd(), "scripts", "normalize-runtime-artifact-permissions.sh"), packageRoot], { stdio: "pipe" });
    expect(statSync(dependencyRoot).mode & 0o7777).toBe(0o755);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
    expect(statSync(stickyRoot).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(packageRoot, "node_modules", "link.js")).isSymbolicLink()).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

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
    expect(() => expectValidationFailure(value.archivePath, "should-not-match")).toThrow("expected validation subprocess to fail");
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

  it("validates the actual manifest generator/finalizer producer contract", () => {
    if (process.platform === "win32") return;
    if (!execFileSync("tar", ["--version"], { encoding: "utf8" }).startsWith("tar (GNU tar)")) return;
    const value = producerContractFixture();
    expect(runValidation(value.archivePath, "--expected-repository", "test/test", "--expected-workflow", "contract", "--expected-run-id", "42", "--expected-run-attempt", "3", "--expected-base-image", value.image, "--expected-base-image-digest", "sha256:" + "a".repeat(64))).toContain(sourceSha);
    rmSync(value.root, { recursive: true, force: true });
  });

  it.each([
    ["missing embedded manifest", { missingManifest: true }],
    ["unsafe path", { unsafe: true }],
    ["escaping symlink", { escapingSymlink: true }],
    ["cyclic symlink", { cyclicSymlink: true }],
    ["intermediate symlink traversal", { intermediateSymlink: true }],
    ["unsafe permissions", { unsafeMode: true }],
    ["missing runtime file", { missingRuntime: true }],
  ])("rejects %s", (_label, options) => {
    const value = fixture(options);
    const reasons: Record<string, string> = { "missing embedded manifest": "embedded manifest is missing", "unsafe path": "unsafe archive path", "escaping symlink": "symlink traversal escapes", "cyclic symlink": "cyclic symlink", "intermediate symlink traversal": "symlink traversal escapes", "unsafe permissions": "special permission bits", "missing runtime file": "missing required runtime file" };
    expectValidationFailure(value.archivePath, reasons[_label]);
    rmSync(value.root, { recursive: true, force: true });
  });

  it("rejects an unexpected revision and a corrupt checksum", () => {
    const value = fixture();
    expectValidationFailure(value.archivePath, "manifest Git SHA", "--expected-sha", "fedcba9876543210fedcba9876543210fedcba98");
    writeFileSync(`${value.archivePath}.sha256`, `${"0".repeat(64)}  ${value.archivePath.split(/[\\/]/).pop()}\n`);
    expectValidationFailure(value.archivePath, "checksum metadata",);
    rmSync(value.root, { recursive: true, force: true });
  });

  it("rejects independent-context mismatches and resource-limit violations", () => {
    const value = fixture();
    expectValidationFailure(value.archivePath, "workflow.repository", "--expected-repository", "wrong/repository");
    expectValidationFailure(value.archivePath, "manifest platform", "--expected-platform", "linux/arm64");
    expectValidationFailure(value.archivePath, "expanded archive", "--max-expanded-bytes", "1");
    expectValidationFailure(value.archivePath, "entry count", "--max-entries", "1");
    expectValidationFailure(value.archivePath, "aggregate retained", "--max-retained-metadata-bytes", "1");
    rmSync(value.root, { recursive: true, force: true });
  });

  it("rejects a corrupt archive even when its checksum sidecar is updated", () => {
    const value = fixture();
    const corrupted = Buffer.from(readFileSync(value.archivePath));
    corrupted[Math.min(40, corrupted.length - 1)] ^= 0xff;
    writeFileSync(value.archivePath, corrupted);
    const digest = createHash("sha256").update(corrupted).digest("hex");
    writeFileSync(`${value.archivePath}.sha256`, `${digest}  ${value.archivePath.split(/[\\/]/).pop()}\n`);
    expectValidationFailure(value.archivePath, "malformed archive");
    rmSync(value.root, { recursive: true, force: true });
  });

  it.each(["truncated gzip", "trailing bytes", "invalid tar termination"])("rejects %s", (kind) => {
    const value = fixture();
    let corrupted = readFileSync(value.archivePath);
    if (kind === "truncated gzip") corrupted = corrupted.subarray(0, corrupted.length - 1);
    if (kind === "trailing bytes") corrupted = Buffer.concat([corrupted, Buffer.from("unexpected trailing data")]);
    if (kind === "invalid tar termination") {
      const raw = gunzipSync(corrupted);
      const malformedHeader = Buffer.from("not-a-valid-tar-header");
      const payload = raw.subarray(0, raw.length - 1024);
      corrupted = gzipSync(Buffer.concat([payload, malformedHeader, Buffer.alloc(512 - malformedHeader.length), Buffer.alloc(1024)]));
    }
    writeFileSync(value.archivePath, corrupted);
    refreshExternalIntegrity(value.archivePath);
    const reasons: Record<string, string> = { "truncated gzip": "malformed archive", "trailing bytes": "malformed archive", "invalid tar termination": "invalid tar termination header" };
    expectValidationFailure(value.archivePath, reasons[kind]);
    rmSync(value.root, { recursive: true, force: true });
  });
});
