import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The runner is intentionally JavaScript so it can be invoked before any
// application build and so its process boundary is easy to inspect.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require("../ops/deploy/migration-runner.js") as typeof import("../ops/deploy/migration-runner.js");

const testLockRoots = new Set<string>();

function createTestLockRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "clashcookies-migration-lock-"));
  testLockRoots.add(root);
  return root;
}

function createTestLockPath(): string {
  return join(createTestLockRoot(), "runner.lock");
}

afterEach(() => {
  for (const root of testLockRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  testLockRoots.clear();
});

function makeEnvironment(lockPath = createTestLockPath()): Record<string, string> {
  return {
    DATABASE_URL: "postgresql://migration_user:super-secret@127.0.0.1:55434/clashcookies_disposable",
    MIGRATION_EXECUTION_AUTHORIZED: "1",
    MIGRATION_TARGET_ENV: "disposable",
    MIGRATION_RELEASE_ID: "test-release",
    MIGRATION_TARGET_SHA: "a".repeat(40),
    MIGRATION_EXPECTED_MIGRATION_DIGEST: "b".repeat(64),
    MIGRATION_LOCK_PATH: lockPath,
    MIGRATION_ALLOWED_DB_HOST: "127.0.0.1",
    MIGRATION_ALLOWED_DB_PORT: "55434",
    MIGRATION_ALLOWED_DB_NAME: "clashcookies_disposable",
    MIGRATION_ALLOWED_DB_USER: "migration_user",
    MIGRATION_ALLOWED_DB_SCHEMA: "public",
    MIGRATION_ALLOWED_DB_SERVER_ADDRESS: "127.0.0.1",
    MIGRATION_ALLOWED_DB_SERVER_PORT: "55434",
    MIGRATION_ALLOWED_DB_MAJOR: "17",
  };
}

function successfulDependencies(calls: { migrate: number; identity?: number }) {
  return {
    currentGitSha: () => "a".repeat(40),
    computeMigrationManifest: () => ({ digest: "b".repeat(64), fileCount: 3, files: [] }),
    verifyDatabaseIdentity: async () => {
      calls.identity = (calls.identity || 0) + 1;
      return {
        database: "clashcookies_disposable",
        role: "migration_user",
        schema: "public",
        serverAddress: "127.0.0.1",
        serverPort: 55434,
        postgresMajor: 17,
        digest: "c".repeat(64),
      };
    },
    executeMigration: () => {
      calls.migrate += 1;
      return { status: 0, signal: null, error: null, classification: "success" };
    },
  };
}

describe("isolated Prisma migration runner", () => {
  it("exposes the exact explicit migration command contract", () => {
    expect(runner.assertMigrationCommandContract(process.cwd())).toBeUndefined();
  });

  it("requires explicit authorization and rejects malformed credentials/configuration", () => {
    const env = makeEnvironment();
    delete env.DATABASE_URL;
    expect(() => runner.parseRunnerConfig(env)).toThrow(/database_url/i);

    const unauthorized = makeEnvironment();
    unauthorized.MIGRATION_EXECUTION_AUTHORIZED = "0";
    expect(() => runner.parseRunnerConfig(unauthorized)).toThrow(/not_authorized/i);

    const malformed = makeEnvironment();
    malformed.DATABASE_URL = "mysql://user:password@host/db";
    expect(() => runner.parseRunnerConfig(malformed)).toThrow(/database_url/i);
  });

  it("executes exactly once for an explicitly authorized disposable target", async () => {
    const calls = { migrate: 0 };
    const logs: string[] = [];
    const result = await runner.runMigrationRunner({
      env: makeEnvironment(),
      log: (line: string) => logs.push(line),
      dependencies: successfulDependencies(calls),
    });

    expect(result).toBe(0);
    expect(calls.migrate).toBe(1);
    expect(logs.some((line) => line.includes("failure_class=success"))).toBe(true);
  });

  it("blocks a missing or incorrect database identity before migration execution", async () => {
    const calls = { migrate: 0 };
    const dependencies = successfulDependencies(calls);
    dependencies.verifyDatabaseIdentity = async () => {
      throw new runner.RunnerError(
        "database_identity_mismatch",
        runner.EXIT_CODES.INVALID_CONFIGURATION,
        "database_identity_mismatch",
      );
    };

    const result = await runner.runMigrationRunner({
      env: makeEnvironment(),
      dependencies,
    });

    expect(result).toBe(runner.EXIT_CODES.INVALID_CONFIGURATION);
    expect(calls.migrate).toBe(0);
  });

  it("blocks an incorrect release SHA or migration manifest before database access", async () => {
    const calls = { migrate: 0, identity: 0 };
    const dependencies = successfulDependencies(calls);
    dependencies.currentGitSha = () => "c".repeat(40);
    dependencies.verifyDatabaseIdentity = async () => {
      calls.identity += 1;
      return { digest: "c".repeat(64) };
    };

    const result = await runner.runMigrationRunner({
      env: makeEnvironment(),
      dependencies,
    });

    expect(result).toBe(runner.EXIT_CODES.INVALID_CONFIGURATION);
    expect(calls.identity).toBe(0);
    expect(calls.migrate).toBe(0);

    const manifestCalls = { migrate: 0, identity: 0 };
    const manifestMismatch = successfulDependencies(manifestCalls);
    manifestMismatch.computeMigrationManifest = () => ({ digest: "c".repeat(64), fileCount: 3, files: [] });
    manifestMismatch.verifyDatabaseIdentity = async () => {
      manifestCalls.identity += 1;
      return { digest: "c".repeat(64) };
    };
    const manifestResult = await runner.runMigrationRunner({
      env: makeEnvironment(),
      dependencies: manifestMismatch,
    });

    expect(manifestResult).toBe(runner.EXIT_CODES.INVALID_CONFIGURATION);
    expect(manifestCalls.identity).toBe(0);
    expect(manifestCalls.migrate).toBe(0);
  });

  it("propagates migration failures without retrying", async () => {
    const calls = { migrate: 0 };
    const dependencies = successfulDependencies(calls);
    dependencies.executeMigration = () => {
      calls.migrate += 1;
      return {
        status: 17,
        signal: null,
        error: null,
        classification: "prisma_migration_failed",
      };
    };

    const result = await runner.runMigrationRunner({
      env: makeEnvironment(),
      dependencies,
    });

    expect(result).toBe(17);
    expect(calls.migrate).toBe(1);
  });

  it("rejects concurrent invocation with an atomic exclusive lock", () => {
    const lockRoot = createTestLockRoot();
    const lockPath = join(lockRoot, "exclusive");
    const release = runner.acquireExclusiveLock(lockPath);
    expect(() => runner.acquireExclusiveLock(lockPath)).toThrow(/already_held/i);
    release();
    const releaseAfter = runner.acquireExclusiveLock(lockPath);
    releaseAfter();
  });

  it("fails closed when lock acquisition fails before database access or migration execution", async () => {
    const lockRoot = createTestLockRoot();
    const lockPath = join(lockRoot, "held");
    const release = runner.acquireExclusiveLock(lockPath);
    const calls = { migrate: 0, identity: 0 };
    try {
      const result = await runner.runMigrationRunner({
        env: makeEnvironment(lockPath),
        dependencies: successfulDependencies(calls),
      });

      expect(result).toBe(runner.EXIT_CODES.LOCKED);
      expect(calls.identity).toBe(0);
      expect(calls.migrate).toBe(0);
    } finally {
      release();
    }
  });

  it("runs only npm run migrate:deploy and never the application startup command", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const config = runner.parseRunnerConfig(makeEnvironment());
    const result = runner.executeMigration(config, process.cwd(), (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, signal: null, error: null };
    });

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["run", "migrate:deploy"]);
    expect(calls[0].args).not.toContain("start");
    const source = readFileSync(join(process.cwd(), "ops", "deploy", "migration-runner.js"), "utf8");
    expect(source).not.toContain("start:runtime");
    expect(source).not.toContain("ClashCookies.js");
  });

  it("never emits the connection string or password in bounded logs", async () => {
    const logs: string[] = [];
    const result = await runner.runMigrationRunner({
      env: makeEnvironment(),
      log: (line: string) => logs.push(line),
      dependencies: {
        ...successfulDependencies({ migrate: 0 }),
        executeMigration: () => ({
          status: 1,
          signal: null,
          error: new Error("postgresql://migration_user:super-secret@127.0.0.1:55434/clashcookies_disposable"),
          classification: "migration_process_error",
        }),
      },
    });

    expect(result).toBe(runner.EXIT_CODES.AMBIGUOUS_RESULT);
    expect(logs.join("\n")).not.toContain("super-secret");
    expect(logs.join("\n")).not.toContain("DATABASE_URL");
    expect(logs.join("\n")).not.toContain("postgresql://");
  });

  it("verifies the database identity through a read-only Prisma query", async () => {
    const config = runner.parseRunnerConfig(makeEnvironment());
    const queries: string[] = [];
    const identity = await runner.verifyDatabaseIdentity(config, () => ({
      $queryRawUnsafe: async (query: string) => {
        queries.push(query);
        return [{
          database_name: "clashcookies_disposable",
          role_name: "migration_user",
          schema_name: "public",
          server_address: "127.0.0.1",
          server_port: 55434,
          server_version_num: "170012",
        }];
      },
      $disconnect: async () => undefined,
    }));

    expect(identity.postgresMajor).toBe(17);
    expect(identity.database).toBe("clashcookies_disposable");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("current_database()");
    expect(queries[0]).toContain("current_user");
    expect(queries[0]).toContain("inet_server_addr()");
  });
});
