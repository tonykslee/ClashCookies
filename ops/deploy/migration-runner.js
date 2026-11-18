"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { acquireExclusiveHostLock, LockCoordinationError } = require("./deployment-lock");

const REPO_ROOT = path.resolve(__dirname, "../..");
const MAX_CHILD_OUTPUT_BYTES = 128 * 1024;

const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  MIGRATION_FAILED: 1,
  LOCKED: 75,
  INVALID_CONFIGURATION: 78,
  AMBIGUOUS_RESULT: 70,
});

class RunnerError extends Error {
  constructor(message, exitCode = EXIT_CODES.INVALID_CONFIGURATION, classification = "invalid_configuration") {
    super(message);
    this.name = "RunnerError";
    this.exitCode = exitCode;
    this.classification = classification;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new RunnerError(`missing_or_malformed_${name.toLowerCase()}`);
  }
  return value;
}

function requireSafeToken(env, name, pattern = /^[A-Za-z0-9._:-]{1,96}$/) {
  const value = requireEnvironment(env, name);
  if (!pattern.test(value)) {
    throw new RunnerError(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function requirePort(env, name) {
  const value = requireEnvironment(env, name);
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new RunnerError(`invalid_${name.toLowerCase()}`);
  }
  return Number(value);
}

function normalizeHost(host) {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

function normalizeServerAddress(address) {
  return normalizeHost(address).replace(/\/\d+$/, "");
}

function requireHost(env, name) {
  const value = requireEnvironment(env, name);
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(value)) {
    throw new RunnerError(`invalid_${name.toLowerCase()}`);
  }
  return normalizeHost(value);
}

function parseDatabaseUrl(databaseUrl, allowedSchema) {
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl) || /[\r\n]/.test(databaseUrl)) {
    throw new RunnerError("invalid_database_url");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new RunnerError("invalid_database_url");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new RunnerError("invalid_database_url_protocol");
  }
  if (!parsed.hostname || !parsed.port || !parsed.username) {
    throw new RunnerError("ambiguous_database_url");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(parsed.username);
  if (!databaseName || !user || parsed.pathname.includes("//")) {
    throw new RunnerError("ambiguous_database_url");
  }

  const schemaValues = parsed.searchParams.getAll("schema");
  if (schemaValues.length > 1 || (schemaValues.length === 1 && schemaValues[0] !== allowedSchema)) {
    throw new RunnerError("database_schema_mismatch");
  }

  return Object.freeze({
    host: normalizeHost(parsed.hostname),
    port: Number(parsed.port),
    databaseName,
    user,
    schema: schemaValues[0] || allowedSchema,
  });
}

function walkFiles(root, relativeDirectory, output) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(root, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new RunnerError("migration_manifest_symlink_rejected");
    }
    if (stat.isDirectory()) {
      walkFiles(root, relativePath, output);
    } else if (stat.isFile()) {
      const contents = fs.readFileSync(absolutePath);
      output.push({
        path: relativePath.split(path.sep).join("/"),
        digest: sha256(contents),
      });
    } else {
      throw new RunnerError("migration_manifest_special_file_rejected");
    }
  }
}

function computeMigrationManifest(repoRoot = REPO_ROOT) {
  const schemaPath = path.join(repoRoot, "prisma", "schema.prisma");
  const migrationsPath = path.join(repoRoot, "prisma", "migrations");
  if (!fs.existsSync(schemaPath) || !fs.statSync(schemaPath).isFile()) {
    throw new RunnerError("missing_prisma_schema");
  }
  if (!fs.existsSync(migrationsPath) || !fs.statSync(migrationsPath).isDirectory()) {
    throw new RunnerError("missing_prisma_migrations");
  }

  const schemaContents = fs.readFileSync(schemaPath, "utf8");
  if (!/url\s*=\s*env\(\s*["']DATABASE_URL["']\s*\)/.test(schemaContents)) {
    throw new RunnerError("prisma_schema_must_use_protected_database_url");
  }

  const files = [{
    path: "prisma/schema.prisma",
    digest: sha256(schemaContents),
  }];
  walkFiles(repoRoot, path.join("prisma", "migrations"), files);
  if (files.length < 2) {
    throw new RunnerError("empty_prisma_migrations");
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = files.map((file) => `${file.path}\0${file.digest}\n`).join("");
  return Object.freeze({
    digest: sha256(manifest),
    fileCount: files.length,
    files: Object.freeze(files),
  });
}

function assertMigrationCommandContract(repoRoot = REPO_ROOT) {
  const packagePath = path.join(repoRoot, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    throw new RunnerError("package_json_unavailable");
  }
  const scripts = packageJson && packageJson.scripts;
  if (!scripts || scripts["migrate:deploy"] !== "prisma migrate deploy"
    || Object.prototype.hasOwnProperty.call(scripts, "premigrate:deploy")
    || Object.prototype.hasOwnProperty.call(scripts, "postmigrate:deploy")) {
    throw new RunnerError("migration_command_contract_mismatch", EXIT_CODES.INVALID_CONFIGURATION, "migration_command_contract_failed");
  }
}

function parseRunnerConfig(env = process.env) {
  if (env.MIGRATION_EXECUTION_AUTHORIZED !== "1") {
    throw new RunnerError("migration_execution_not_authorized", EXIT_CODES.INVALID_CONFIGURATION, "unauthorized_target");
  }

  const targetEnvironment = requireSafeToken(env, "MIGRATION_TARGET_ENV", /^(?:disposable|production)$/);
  const releaseId = requireSafeToken(env, "MIGRATION_RELEASE_ID");
  const targetSha = requireSafeToken(env, "MIGRATION_TARGET_SHA", /^[0-9a-f]{40}$/i).toLowerCase();
  const expectedMigrationDigest = requireSafeToken(
    env,
    "MIGRATION_EXPECTED_MIGRATION_DIGEST",
    /^[0-9a-f]{64}$/i,
  ).toLowerCase();
  const lockPath = requireEnvironment(env, "MIGRATION_LOCK_PATH");
  if (!path.isAbsolute(lockPath) || lockPath.endsWith("\\") || lockPath.endsWith("/")) {
    throw new RunnerError("invalid_migration_lock_path");
  }

  const allowedSchema = requireSafeToken(env, "MIGRATION_ALLOWED_DB_SCHEMA", /^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
  const allowedDatabaseUrl = requireEnvironment(env, "DATABASE_URL");
  const database = parseDatabaseUrl(allowedDatabaseUrl, allowedSchema);
  const allowedHost = requireHost(env, "MIGRATION_ALLOWED_DB_HOST");
  const allowedPort = requirePort(env, "MIGRATION_ALLOWED_DB_PORT");
  const allowedDatabaseName = requireSafeToken(env, "MIGRATION_ALLOWED_DB_NAME", /^[A-Za-z0-9_$-]{1,63}$/);
  const allowedUser = requireSafeToken(env, "MIGRATION_ALLOWED_DB_USER", /^[A-Za-z0-9_$-]{1,63}$/);
  const allowedServerAddress = requireHost(env, "MIGRATION_ALLOWED_DB_SERVER_ADDRESS");
  const allowedServerPort = requirePort(env, "MIGRATION_ALLOWED_DB_SERVER_PORT");
  const allowedMajor = requireSafeToken(env, "MIGRATION_ALLOWED_DB_MAJOR", /^\d{1,2}$/);

  if (database.host !== allowedHost
    || database.port !== allowedPort
    || database.databaseName !== allowedDatabaseName
    || database.user !== allowedUser
    || database.schema !== allowedSchema) {
    throw new RunnerError("database_url_does_not_match_authorized_target", EXIT_CODES.INVALID_CONFIGURATION, "unauthorized_target");
  }

  return Object.freeze({
    targetEnvironment,
    releaseId,
    targetSha,
    expectedMigrationDigest,
    lockPath,
    databaseUrl: allowedDatabaseUrl,
    database,
    allowedServerAddress,
    allowedServerPort,
    allowedMajor: Number(allowedMajor),
  });
}

function acquireExclusiveLock(lockPath, owner = { startedAt: new Date().toISOString() }) {
  try {
    return acquireExclusiveHostLock(lockPath, owner, fs);
  } catch (error) {
    if (error instanceof LockCoordinationError && error.reason === "already_held") {
      throw new RunnerError("migration_runner_lock_already_held", EXIT_CODES.LOCKED, "already_locked");
    }
    if (error instanceof LockCoordinationError) {
      throw new RunnerError(`migration_runner_lock_${error.reason}`, EXIT_CODES.INVALID_CONFIGURATION, "lock_unavailable");
    }
    throw error;
  }
}

function currentGitSha(repoRoot, spawnSyncImpl = childProcess.spawnSync) {
  const result = spawnSyncImpl("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (!result || result.status !== 0 || typeof result.stdout !== "string") {
    throw new RunnerError("release_sha_unavailable", EXIT_CODES.INVALID_CONFIGURATION, "release_identity_failed");
  }
  const sha = result.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new RunnerError("release_sha_malformed", EXIT_CODES.INVALID_CONFIGURATION, "release_identity_failed");
  }
  return sha;
}

function identityDigest(identity) {
  return sha256(JSON.stringify({
    database: identity.database,
    role: identity.role,
    schema: identity.schema,
    serverAddress: identity.serverAddress,
    serverPort: identity.serverPort,
    postgresMajor: identity.postgresMajor,
  }));
}

async function verifyDatabaseIdentity(config, prismaFactory = null) {
  const factory = prismaFactory || (() => {
    // This is the only database library loaded by the runner. It does not load
    // the bot, Discord client, schedulers, pollers, or application entry point.
    const { PrismaClient } = require("@prisma/client");
    return new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  });
  const client = factory();
  try {
    const rows = await client.$queryRawUnsafe(
      "SELECT current_database() AS database_name, current_user AS role_name, current_schema() AS schema_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port, current_setting('server_version_num') AS server_version_num",
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      throw new RunnerError("database_identity_query_empty", EXIT_CODES.INVALID_CONFIGURATION, "database_identity_failed");
    }

    const postgresVersionNumber = Number(row.server_version_num);
    const identity = {
      database: String(row.database_name || ""),
      role: String(row.role_name || ""),
      schema: String(row.schema_name || ""),
      serverAddress: normalizeServerAddress(String(row.server_address || "local")),
      serverPort: Number(row.server_port),
      postgresMajor: Number.isFinite(postgresVersionNumber) ? Math.floor(postgresVersionNumber / 10000) : NaN,
    };

    if (identity.database !== config.database.databaseName
      || identity.role !== config.database.user
      || identity.schema !== config.database.schema
      || identity.serverAddress !== config.allowedServerAddress
      || identity.serverPort !== config.allowedServerPort
      || identity.postgresMajor !== config.allowedMajor) {
      throw new RunnerError("database_identity_mismatch", EXIT_CODES.INVALID_CONFIGURATION, "database_identity_mismatch");
    }
    return Object.freeze({ ...identity, digest: identityDigest(identity) });
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError("database_identity_verification_failed", EXIT_CODES.INVALID_CONFIGURATION, "database_identity_failed");
  } finally {
    try {
      await client.$disconnect();
    } catch {
      // The identity result is only trusted when the query succeeded. A
      // disconnect failure must not expose credentials or alter that result.
    }
  }
}

/**
 * Verify the migration rows for one release without invoking Prisma migrate.
 * This is intentionally read-only and is kept beside the runner so the
 * production boundary cannot accidentally verify through application startup.
 */
async function verifyAppliedMigrations({
  databaseUrl,
  identity,
  migrationNames,
  prismaFactory = null,
}) {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0
    || !identity || typeof identity !== "object"
    || !Array.isArray(migrationNames) || migrationNames.length === 0
    || migrationNames.some((name) => !/^[A-Za-z0-9_-]{1,200}$/.test(name))) {
    throw new RunnerError("migration_status_request_invalid", EXIT_CODES.INVALID_CONFIGURATION, "migration_status_invalid");
  }

  const factory = prismaFactory || (() => {
    const { PrismaClient } = require("@prisma/client");
    return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });
  const client = factory();
  try {
    const rows = await client.$queryRawUnsafe(
      'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = ANY($1::text[])',
      migrationNames,
    );
    const applied = new Set(
      (Array.isArray(rows) ? rows : [])
        .filter((row) => row
          && typeof row.migration_name === "string"
          && migrationNames.includes(row.migration_name)
          && row.finished_at !== null
          && row.finished_at !== undefined
          && (row.rolled_back_at === null || row.rolled_back_at === undefined))
        .map((row) => row.migration_name),
    );
    const unresolved = migrationNames.filter((name) => !applied.has(name));
    return Object.freeze({
      unresolved: unresolved.length,
      targetApplied: unresolved.length === 0,
      migrationNames: Object.freeze([...migrationNames]),
    });
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError("migration_status_verification_failed", EXIT_CODES.INVALID_CONFIGURATION, "migration_status_failed");
  } finally {
    try {
      await client.$disconnect();
    } catch {
      // A successful read remains valid; disconnect failures do not expose
      // credentials or change the verified status.
    }
  }
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.exe" : "npm";
}

function classifyMigrationResult(result) {
  if (result && result.error) return "migration_process_error";
  if (!result || result.signal) return "ambiguous_process_result";
  if (result.status === 0) return "success";
  return "prisma_migration_failed";
}

function buildMigrationChildEnvironment(config, baseEnvironment = process.env) {
  const pathValue = typeof baseEnvironment.PATH === "string" && baseEnvironment.PATH.length > 0
    ? baseEnvironment.PATH
    : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return Object.freeze({
    PATH: pathValue,
    NODE_ENV: "production",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    DATABASE_URL: config.databaseUrl,
    MIGRATION_RUNNER_CHILD: "1",
  });
}

function executeMigration(
  config,
  repoRoot = REPO_ROOT,
  spawnSyncImpl = childProcess.spawnSync,
  baseEnvironment = process.env,
) {
  const childEnvironment = buildMigrationChildEnvironment(config, baseEnvironment);
  const result = spawnSyncImpl(npmExecutable(), ["run", "migrate:deploy"], {
    cwd: repoRoot,
    env: childEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    windowsHide: true,
  });
  return Object.freeze({
    status: typeof result?.status === "number" ? result.status : null,
    signal: result?.signal || null,
    error: result?.error || null,
    classification: classifyMigrationResult(result),
  });
}

function safeLogValue(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  if (/^[0-9a-f]{40}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[A-Za-z0-9._:-]{1,96}$/.test(value)) return value;
  return fallback;
}

function writeLog(log, event, fields) {
  const serialized = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value).replace(/[^A-Za-z0-9._:/-]/g, "_")}`)
    .join(" ");
  log(`[migration-runner] ${event} ${serialized}`.trim());
}

async function runMigrationRunner({
  env = process.env,
  repoRoot = REPO_ROOT,
  log = console.log,
  dependencies = {},
} = {}) {
  const startedAt = new Date().toISOString();
  let targetSha = safeLogValue(env.MIGRATION_TARGET_SHA);
  let migrationIdentity = safeLogValue(env.MIGRATION_EXPECTED_MIGRATION_DIGEST);
  let releaseId = safeLogValue(env.MIGRATION_RELEASE_ID);
  let exitCode = EXIT_CODES.INVALID_CONFIGURATION;
  let failureClass = "invalid_configuration";
  let releaseLock = null;

  writeLog(log, "start", {
    release_id: releaseId,
    target_sha: targetSha,
    migration_identity: migrationIdentity,
    started_at: startedAt,
  });

  try {
    const config = (dependencies.parseRunnerConfig || parseRunnerConfig)(env);
    targetSha = config.targetSha;
    migrationIdentity = config.expectedMigrationDigest;
    releaseId = config.releaseId;

    releaseLock = (dependencies.acquireExclusiveLock || acquireExclusiveLock)(config.lockPath, { startedAt });
    const actualSha = (dependencies.currentGitSha || currentGitSha)(repoRoot, dependencies.spawnSync || childProcess.spawnSync);
    if (actualSha !== config.targetSha) {
      throw new RunnerError("checkout_sha_does_not_match_target", EXIT_CODES.INVALID_CONFIGURATION, "release_identity_mismatch");
    }

    (dependencies.assertMigrationCommandContract || assertMigrationCommandContract)(repoRoot);
    const manifest = (dependencies.computeMigrationManifest || computeMigrationManifest)(repoRoot);
    if (manifest.digest !== config.expectedMigrationDigest) {
      throw new RunnerError("migration_manifest_does_not_match_target", EXIT_CODES.INVALID_CONFIGURATION, "migration_identity_mismatch");
    }
    migrationIdentity = manifest.digest;

    const identity = await (dependencies.verifyDatabaseIdentity || verifyDatabaseIdentity)(
      config,
      dependencies.prismaFactory || null,
    );
    writeLog(log, "database_identity_verified", {
      release_id: releaseId,
      target_sha: targetSha,
      migration_identity: migrationIdentity,
      identity_digest: identity.digest,
    });

    const result = (dependencies.executeMigration || executeMigration)(
      config,
      repoRoot,
      dependencies.spawnSync || childProcess.spawnSync,
    );

    failureClass = result.classification;
    if (result.status === 0) {
      exitCode = EXIT_CODES.SUCCESS;
    } else if (typeof result.status === "number" && result.status > 0 && result.status <= 255 && !result.signal && !result.error) {
      exitCode = result.status;
    } else {
      exitCode = EXIT_CODES.AMBIGUOUS_RESULT;
      failureClass = "ambiguous_process_result";
    }
  } catch (error) {
    if (error instanceof RunnerError) {
      exitCode = error.exitCode;
      failureClass = error.classification;
    } else {
      exitCode = EXIT_CODES.AMBIGUOUS_RESULT;
      failureClass = "ambiguous_runner_error";
    }
  } finally {
    if (releaseLock && !releaseLock() && exitCode === EXIT_CODES.SUCCESS) {
      exitCode = EXIT_CODES.AMBIGUOUS_RESULT;
      failureClass = "lock_release_failed";
    }
    writeLog(log, "end", {
      release_id: releaseId,
      target_sha: targetSha,
      migration_identity: migrationIdentity,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit_code: exitCode,
      failure_class: failureClass,
    });
  }

  return exitCode;
}

module.exports = {
  EXIT_CODES,
  RunnerError,
  acquireExclusiveLock,
  computeMigrationManifest,
  executeMigration,
  verifyAppliedMigrations,
  assertMigrationCommandContract,
  buildMigrationChildEnvironment,
  parseDatabaseUrl,
  parseRunnerConfig,
  runMigrationRunner,
  verifyDatabaseIdentity,
};

if (require.main === module) {
  runMigrationRunner().then((exitCode) => process.exitCode = exitCode).catch(() => {
    process.exitCode = EXIT_CODES.AMBIGUOUS_RESULT;
  });
}
