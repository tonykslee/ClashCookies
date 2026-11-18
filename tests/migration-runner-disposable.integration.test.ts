import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This integration test starts only a disposable local PostgreSQL cluster. It
// never reads or connects to production configuration.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runnerModulePath = resolve("ops", "deploy", "migration-runner.js");

function executable(name: string): string | null {
  const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  return candidates.find((candidate) => spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) ?? null;
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${String(result.stderr || "").slice(0, 500)}`);
  }
  return String(result.stdout || "").trim();
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("disposable_port_unavailable"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForPostgres(port: number, user: string, database: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(psql!, [
      "-h", "127.0.0.1", "-p", String(port), "-U", user, "-d", database,
      "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1",
    ], { encoding: "utf8", windowsHide: true, timeout: 2_000 });
    if (result.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("disposable_postgres_readiness_timeout");
}

const initdb = executable("initdb");
const pgCtl = executable("pg_ctl");
const psql = executable("psql");
const postgres = executable("postgres");

describe("disposable candidate migration integration", () => {
  it.skipIf(!(initdb && pgCtl && psql && postgres))("loads Prisma from a fresh candidate worktree and executes migrate:deploy once", async () => {
    const repoRoot = process.cwd();
    const targetSha = run("git", ["rev-parse", "HEAD"], repoRoot);
    const root = mkdtempSync(join(tmpdir(), "clashcookies-disposable-migration-"));
    const candidatePath = join(root, "candidate");
    const databaseName = "clashcookies_disposable";
    const databaseUser = "migration_user";
    const databasePassword = "disposable-only";
    const adminUser = "disposable_admin";
    const port = await freePort();
    const dataPath = join(root, "postgres-data");
    let postgresStarted = false;
    let postgresProcess: ReturnType<typeof spawn> | undefined;

    try {
      run(initdb!, ["-D", dataPath, "-A", "trust", "-U", adminUser, "--no-locale"]);
      postgresProcess = spawn(postgres!, ["-D", dataPath, "-h", "127.0.0.1", "-p", String(port)], {
        stdio: "ignore",
        windowsHide: true,
      });
      postgresStarted = true;
      await waitForPostgres(port, adminUser, "postgres");
      run(psql!, ["-h", "127.0.0.1", "-p", String(port), "-U", adminUser, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE ROLE ${databaseUser} LOGIN PASSWORD '${databasePassword}'`]);
      run(psql!, ["-h", "127.0.0.1", "-p", String(port), "-U", adminUser, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${databaseName} OWNER ${databaseUser}`]);

      rmSync(candidatePath, { recursive: true, force: true });
      run("git", ["worktree", "add", "--detach", candidatePath, targetSha], repoRoot);
      rmSync(join(candidatePath, "prisma"), { recursive: true, force: true });
      cpSync(resolve("tests", "fixtures", "migration-runner-disposable", "prisma"), join(candidatePath, "prisma"), { recursive: true });
      writeFileSync(join(candidatePath, "package.json"), readFileSync(resolve("tests", "fixtures", "migration-runner-disposable", "package.json")));
      symlinkSync(join(repoRoot, "node_modules"), join(candidatePath, "node_modules"), "junction");

      // Load the reviewed runner from the current checkout while resolving
      // Prisma and the migration package from the fresh candidate worktree.
      // After commit, this module and targetSha are the same reviewed head.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const candidateRunner = require(runnerModulePath) as typeof import("../ops/deploy/migration-runner.js");
      const migrationManifestDigest = candidateRunner.computeMigrationManifest(candidatePath).digest;
      const serverVersion = run(psql!, ["-h", "127.0.0.1", "-p", String(port), "-U", adminUser, "-d", "postgres", "-At", "-c", "SHOW server_version_num"]);
      const databaseUrl = `postgresql://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}?schema=public`;
      const result = await candidateRunner.runMigrationRunner({
        repoRoot: candidatePath,
        env: {
          DATABASE_URL: databaseUrl,
          MIGRATION_EXECUTION_AUTHORIZED: "1",
          MIGRATION_TARGET_ENV: "disposable",
          MIGRATION_RELEASE_ID: "disposable-integration",
          MIGRATION_TARGET_SHA: targetSha,
          MIGRATION_EXPECTED_MIGRATION_DIGEST: migrationManifestDigest,
          MIGRATION_LOCK_PATH: join(root, "migration.lock"),
          MIGRATION_ALLOWED_DB_HOST: "127.0.0.1",
          MIGRATION_ALLOWED_DB_PORT: String(port),
          MIGRATION_ALLOWED_DB_NAME: databaseName,
          MIGRATION_ALLOWED_DB_USER: databaseUser,
          MIGRATION_ALLOWED_DB_SCHEMA: "public",
          MIGRATION_ALLOWED_DB_SERVER_ADDRESS: "127.0.0.1",
          MIGRATION_ALLOWED_DB_SERVER_PORT: String(port),
          MIGRATION_ALLOWED_DB_MAJOR: String(Math.floor(Number(serverVersion) / 10000)),
        },
        log: () => undefined,
      });

      expect(result).toBe(0);
      expect(run(psql!, ["-h", "127.0.0.1", "-p", String(port), "-U", databaseUser, "-d", databaseName, "-At", "-c", "SELECT to_regclass('public.\"MigrationRunnerFixture\"')"]))
        .toBe('"MigrationRunnerFixture"');
    } finally {
      if (postgresStarted) {
        spawnSync(pgCtl!, ["-D", dataPath, "-m", "immediate", "stop"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        });
      }
      if (postgresProcess && !postgresProcess.killed) postgresProcess.kill();
      if (candidatePath && existsSync(join(candidatePath, "node_modules"))) {
        unlinkSync(join(candidatePath, "node_modules"));
      }
      try {
        run("git", ["worktree", "remove", "--force", candidatePath], repoRoot);
      } catch {
        // Preserve the test failure; cleanup is best effort for a disposable worktree.
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }, 120_000);
});
