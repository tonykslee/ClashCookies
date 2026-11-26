#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");

const DEVELOPMENT_ARTIFACT_CLASS = "development-runtime-evidence";
const PRODUCTION_CANDIDATE_ARTIFACT_CLASS = "production-candidate-runtime-evidence-v1";
const PRODUCTION_CANDIDATE_PROFILE = "production-candidate-main-push-v1";
const PRODUCTION_CANDIDATE_AUTHORIZATION_CONTEXT = "production-candidate-selection-only";
const RELEASE_REPOSITORY = "tonykslee/ClashCookies";
const RELEASE_REPOSITORY_ID = "668452496";
const RELEASE_REPOSITORY_OWNER_ID = "18295450";
const RELEASE_SOURCE_REF = "refs/heads/main";
const RELEASE_WORKFLOW_PATH = ".github/workflows/runtime-artifact.yml";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashMigrations(root) {
  const migrationsRoot = join(root, "prisma", "migrations");
  const rows = [];
  for (const migration of readdirSync(migrationsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!migration.isDirectory()) continue;
    const path = join(migrationsRoot, migration.name, "migration.sql");
    rows.push({ path: relative(root, path).replaceAll("\\", "/"), sha256: sha256File(path) });
  }
  return rows;
}

function footprint(root) {
  let bytes = 0;
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { bytes += stat.size; return; }
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  for (const path of ["dist", "node_modules", "prisma", "package.json", "yarn.lock", "runtime-artifact-manifest.json"]) visit(join(root, path));
  return bytes;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--")) throw new Error(`Unexpected argument: ${argv[index]}`);
    args[argv[index].slice(2)] = argv[index + 1];
  }
  return args;
}

function buildManifest(root) {
  const event = process.env.GITHUB_EVENT_NAME || "local";
  const isPullRequest = event === "pull_request";
  const sourceSha = process.env.SOURCE_SHA;
  const isProductionCandidate = event === "push"
    && process.env.GITHUB_REF === RELEASE_SOURCE_REF
    && process.env.GITHUB_REPOSITORY === RELEASE_REPOSITORY
    && process.env.GITHUB_REPOSITORY_ID === RELEASE_REPOSITORY_ID
    && process.env.GITHUB_REPOSITORY_OWNER_ID === RELEASE_REPOSITORY_OWNER_ID
    && process.env.GITHUB_WORKFLOW_PATH === RELEASE_WORKFLOW_PATH
    && /^[0-9a-f]{40}$/i.test(process.env.GITHUB_WORKFLOW_SHA || "")
    && (!process.env.GITHUB_SHA || process.env.GITHUB_SHA.toLowerCase() === sourceSha?.toLowerCase());
  if (!/^[0-9a-f]{40}$/i.test(sourceSha || "")) throw new Error("SOURCE_SHA must be a full Git SHA");
  const image = process.env.BUILD_IMAGE || "node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5";
  const digest = image.match(/@(?<digest>sha256:[0-9a-f]{64})$/i)?.groups?.digest;
  if (!digest) throw new Error("BUILD_IMAGE must include a sha256 digest");

  return {
    schemaVersion: 1,
    artifact: {
      name: process.env.ARTIFACT_NAME,
      format: "tar.gz",
      contents: ["dist", "node_modules", "prisma", "package.json", "yarn.lock"],
      artifactClass: isProductionCandidate ? PRODUCTION_CANDIDATE_ARTIFACT_CLASS : DEVELOPMENT_ARTIFACT_CLASS,
      profile: isProductionCandidate ? PRODUCTION_CANDIDATE_PROFILE : "development-runtime-evidence",
      nonProductionEvidence: true,
    },
    source: { gitSha: sourceSha.toLowerCase(), context: "git-archive", untrackedFilesExcluded: true, localEnvironmentFilesExcluded: true, cleanSourceContext: true },
    identity: {
      kind: isProductionCandidate ? "production_candidate_main_push" : isPullRequest ? "pull_request_merge_commit" : event === "push" ? "development_branch_push" : "local_validation",
      event,
      deployableRelease: false,
      authorizationContext: isProductionCandidate ? PRODUCTION_CANDIDATE_AUTHORIZATION_CONTEXT : "ci-selection-only",
      note: isProductionCandidate
        ? "This main-push candidate is authenticated evidence for a later independent authorization decision; it is not a deployable release or authorization record."
        : isPullRequest
        ? "GitHub pull_request GITHUB_SHA is a test/merge commit and is not a deployable release identity."
        : "This development artifact is evidence only and is not eligible for production promotion.",
    },
    provenance: {
      contractVersion: 1,
      integrity: "archive SHA-256 checksum and manifest binding",
      authenticated: false,
      note: "This legacy development manifest is not the authenticated envelope; integrity metadata does not authenticate the source revision or authorize production use.",
    },
    workflow: {
      name: process.env.GITHUB_WORKFLOW || "local",
      runId: process.env.GITHUB_RUN_ID || "local",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
      ref: process.env.GITHUB_REF || "local",
      repository: process.env.GITHUB_REPOSITORY || "local",
      repositoryId: process.env.GITHUB_REPOSITORY_ID || "local",
      repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID || "local",
      sourceRef: process.env.GITHUB_REF || "local",
      workflowPath: process.env.GITHUB_WORKFLOW_PATH || "local",
      signerWorkflow: process.env.GITHUB_WORKFLOW_PATH || "local",
      signerRevision: process.env.GITHUB_WORKFLOW_SHA || "local",
      url: process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    },
    build: {
      platform: process.env.BUILD_PLATFORM || "linux/amd64",
      architecture: process.env.BUILD_ARCHITECTURE || "amd64",
      nodeVersion: process.env.NODE_VERSION,
      yarnVersion: process.env.YARN_VERSION,
      compiler: "npm run build",
      baseImage: image,
      baseImageDigest: digest,
      nativeLibraryCompatibility: { libc: "glibc", distribution: "Debian Bookworm", openssl: "OpenSSL 3.x compatible Node Prisma engine", liveVmCompatibility: "not established by this workflow" },
      durationMs: Number(process.env.BUILD_DURATION_MS || 0),
      startedAt: process.env.BUILD_STARTED_AT || null,
      completedAt: new Date().toISOString(),
    },
    inputs: {
      packageJsonSha256: sha256File(join(root, "package.json")),
      yarnLockSha256: sha256File(join(root, "yarn.lock")),
      prismaSchemaSha256: sha256File(join(root, "prisma", "schema.prisma")),
      prismaMigrations: hashMigrations(root),
    },
    integrity: { checksumFile: `${process.env.ARTIFACT_NAME}.sha256`, sha256: null },
    measurements: { archiveBytes: null, extractedFootprintBytes: null },
    runtimeValidation: {
      requiredFiles: ["dist/ClashCookies.js", "node_modules/@prisma/client/default.js", "node_modules/.prisma/client/index.js", "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node", "node_modules/prisma/build/index.js", "node_modules/.bin/prisma", "prisma/schema.prisma", "package.json", "yarn.lock", "runtime-artifact-manifest.json"],
      prohibitedActions: ["source compilation", "dependency installation", "prisma generate", "production runtime startup"],
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.output) throw new Error("--root and --output are required");
  writeFileSync(args.output, `${JSON.stringify(buildManifest(args.root), null, 2)}\n`, "utf8");
}

if (require.main === module) main();
module.exports = { buildManifest, footprint, sha256File };
