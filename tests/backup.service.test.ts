import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_RETENTION_DAYS,
  BackupConfig,
  BackupDependencies,
  HeadObject,
  ObjectRetention,
  ObjectStore,
  createB2ObjectStore,
  createPgDumpRunner,
  loadBackupConfig,
  runBackup,
} from "../src/backup/BackupService";

const temporaryDirectories: string[] = [];

const baseConfig: Omit<BackupConfig, "stagingDirectory"> = {
  databaseService: "clashcookies_backup",
  pgDumpPath: "/usr/lib/postgresql/17/bin/pg_dump",
  pgServiceFile: "/etc/clashcookies/pg_service.conf",
  pgPassFile: "/etc/clashcookies/.pgpass",
  b2Bucket: "clashcookies-prod-backups",
  b2Endpoint: "https://s3.example.invalid",
  b2Region: "us-west-004",
  b2Prefix: "clashcookies-prod",
  ageRecipients: ["age1primary", "age1emergency"],
  weeklyUtcDay: 0,
  monthlyUtcDay: 1,
  maxAttempts: 3,
};

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clashcookies-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeStore(options: {
  head?: (key: string) => Promise<HeadObject | null>;
  put?: ObjectStore["putObject"];
  retention?: (key: string) => Promise<ObjectRetention>;
} = {}): ObjectStore {
  const stored = new Map<string, HeadObject>();
  const retained = new Map<string, ObjectRetention>();
  return {
    headObject: options.head ?? (async (key) => stored.get(key) ?? null),
    putObject: async (input) => {
      if (options.put) await options.put(input);
      const fileStats = await stat(input.bodyPath);
      stored.set(input.key, {
        contentLength: fileStats.size,
        metadata: input.metadata,
      });
      retained.set(input.key, { mode: "GOVERNANCE", retainUntil: input.retainUntil });
    },
    getObjectRetention:
      options.retention ??
      (async (key) => retained.get(key) ?? { mode: "GOVERNANCE", retainUntil: new Date("2030-01-01T00:00:00.000Z") }),
  };
}

function makeDependencies(objectStore: ObjectStore): BackupDependencies {
  return {
    runDump: async (outputPath) => writeFile(outputPath, "dump"),
    encryptDump: async (inputPath, outputPath, recipients) => {
      expect(await readFile(inputPath, "utf8")).toBe("dump");
      expect(recipients).toEqual(baseConfig.ageRecipients);
      await writeFile(outputPath, "encrypted-dump");
    },
    objectStore,
    now: () => new Date("2026-11-15T02:15:00.000Z"),
    randomId: () => "abc123",
    sleep: async () => undefined,
    logger: { log: vi.fn(), error: vi.fn() },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadBackupConfig", () => {
  const configEnv = {
    BACKUP_DATABASE_SERVICE: "backup",
    BACKUP_PG_DUMP_PATH: "/usr/lib/postgresql/17/bin/pg_dump",
    BACKUP_PG_SERVICEFILE: "/etc/pg_service.conf",
    BACKUP_PGPASSFILE: "/etc/.pgpass",
    BACKUP_STAGING_DIR: "/var/lib/backup",
    BACKUP_B2_BUCKET: "bucket",
    BACKUP_B2_ENDPOINT: "https://s3.example.invalid",
    AWS_DEFAULT_REGION: "us-west-004",
    BACKUP_B2_PREFIX: "prod",
    BACKUP_AGE_RECIPIENT_PRIMARY: "age1primary",
    BACKUP_AGE_RECIPIENT_EMERGENCY: "age1emergency",
  };

  it("requires public recipients and a service-file database identity", () => {
    expect(() => loadBackupConfig({})).toThrow("BACKUP_AGE_RECIPIENT_PRIMARY");
    expect(loadBackupConfig(configEnv).databaseService).toBe("backup");
    expect(loadBackupConfig(configEnv).pgDumpPath).toBe(configEnv.BACKUP_PG_DUMP_PATH);
    expect(loadBackupConfig(configEnv).b2Region).toBe("us-west-004");
    const { AWS_DEFAULT_REGION: _omit, ...missingRegion } = configEnv;
    expect(() => loadBackupConfig(missingRegion)).toThrow("AWS_DEFAULT_REGION");
  });

  it("accepts calendar month days 1 through 31 and rejects invalid values", () => {
    expect(loadBackupConfig({ ...configEnv, BACKUP_MONTHLY_UTC_DAY: "31" }).monthlyUtcDay).toBe(31);
    expect(() => loadBackupConfig({ ...configEnv, BACKUP_MONTHLY_UTC_DAY: "0" })).toThrow(
      "BACKUP_MONTHLY_UTC_DAY must be an integer from 1 through 31"
    );
    expect(() => loadBackupConfig({ ...configEnv, BACKUP_MONTHLY_UTC_DAY: "32" })).toThrow(
      "BACKUP_MONTHLY_UTC_DAY must be an integer from 1 through 31"
    );
  });

  it("pins the isolated Node executable, local-only PostgreSQL service and B2 region examples", async () => {
    const [systemdService, pgServiceExample, backupEnvExample] = await Promise.all([
      readFile("ops/backup/systemd/clashcookies-backup.service", "utf8"),
      readFile("ops/backup/pg_service.conf.example", "utf8"),
      readFile("ops/backup/backup.env.example", "utf8"),
    ]);
    expect(systemdService).toContain(
      "ExecStart=/opt/clashcookies-node24/bin/node /opt/clashcookies/dist/scripts/backup.js"
    );
    expect(systemdService).not.toContain("ExecStart=/usr/bin/node");
    expect(pgServiceExample).toContain("host=127.0.0.1");
    expect(pgServiceExample).toContain("sslmode=disable");
    expect(pgServiceExample).not.toContain("sslmode=require");
    expect(backupEnvExample).toContain("BACKUP_B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com");
    expect(backupEnvExample).toContain("AWS_DEFAULT_REGION=us-west-004");
    expect(backupEnvExample).not.toContain("AWS_DEFAULT_REGION=us-east-1");
  });

  it("documents readable service files and strict service-account password permissions", async () => {
    const readme = await readFile("ops/backup/README.md", "utf8");
    expect(readme).toContain("install -o root -g root -m 0644 pg_service.conf");
    expect(readme).toContain("install -o clashcookies-backup -g clashcookies-backup -m 0600 .pgpass");
  });
});

describe("command adapters", () => {
  it("uses a PostgreSQL service identity and read-only guard without a URL", async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const commandRunner = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options?.env });
      return args[0] === "--version"
        ? { stdout: "pg_dump (PostgreSQL) 17.9", stderr: "" }
        : { stdout: "", stderr: "" };
    };
    await createPgDumpRunner(baseConfig, commandRunner)("/tmp/backup.dump");
    expect(calls[0]).toEqual({
      command: baseConfig.pgDumpPath,
      args: ["--version"],
      env: expect.objectContaining({
        PGSERVICE: "clashcookies_backup",
        PGSERVICEFILE: "/etc/clashcookies/pg_service.conf",
        PGPASSFILE: "/etc/clashcookies/.pgpass",
        PGOPTIONS: "-c default_transaction_read_only=on",
      }),
    });
    expect(calls[1]).toEqual({
      command: baseConfig.pgDumpPath,
      args: ["--format=custom", "--no-password", "--file", "/tmp/backup.dump", "--dbname", "service=clashcookies_backup"],
      env: expect.objectContaining({
        PGSERVICE: "clashcookies_backup",
        PGSERVICEFILE: "/etc/clashcookies/pg_service.conf",
        PGPASSFILE: "/etc/clashcookies/.pgpass",
        PGOPTIONS: "-c default_transaction_read_only=on",
      }),
    });
  });

  it("fails closed when the configured pg_dump is not PostgreSQL 17", async () => {
    const commandRunner = vi.fn(async () => ({ stdout: "pg_dump (PostgreSQL) 16.15", stderr: "" }));
    await expect(createPgDumpRunner(baseConfig, commandRunner)("/tmp/backup.dump")).rejects.toThrow(
      "Configured pg_dump must be PostgreSQL 17"
    );
    expect(commandRunner).toHaveBeenCalledTimes(1);
  });

  it("sends Governance Object Lock arguments and treats only 404 as missing", async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const commandRunner = async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options?.env });
      return { stdout: "{}", stderr: "" };
    };
    const store = createB2ObjectStore(baseConfig, commandRunner);
    await store.putObject({
      bodyPath: "/tmp/backup.dump.age",
      key: "clashcookies-prod/daily/example.dump.age",
      metadata: { sha256: "abc" },
      retainUntil: new Date("2026-11-29T02:15:00.000Z"),
    });
    expect(calls[0]?.args).toContain("--object-lock-mode");
    expect(calls[0]?.args).toContain("GOVERNANCE");
    expect(calls[0]?.env?.AWS_DEFAULT_REGION).toBe("us-west-004");
    expect(calls[0]?.args).toContain("--object-lock-retain-until-date");

    const missingRunner = async () => {
      const error = new Error("not found") as Error & { stderr: string };
      error.stderr = "An error occurred (404) when calling the HeadObject operation";
      throw error;
    };
    await expect(createB2ObjectStore(baseConfig, missingRunner).headObject("missing")).resolves.toBeNull();
  });
});

describe("runBackup", () => {
  it("uploads daily and weekly copies with governance retention", async () => {
    const directory = await makeDirectory();
    const uploads: Array<{ key: string; retainUntil: Date; metadata: Record<string, string> }> = [];
    const store = makeStore({
      put: async (input) => uploads.push({ key: input.key, retainUntil: input.retainUntil, metadata: input.metadata }),
    });
    const result = await runBackup({ ...baseConfig, stagingDirectory: directory }, makeDependencies(store));

    expect(result.objects).toHaveLength(2);
    expect(uploads.map((upload) => upload.key)).toEqual([
      expect.stringContaining("/daily/2026/11/15/"),
      expect.stringContaining("/weekly/2026/11/15/"),
    ]);
    expect(uploads[0]?.metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(uploads[0]?.retainUntil.toISOString()).toBe("2026-11-29T03:15:00.000Z");
    expect(BACKUP_RETENTION_DAYS.daily).toBe(14);
    expect(BACKUP_RETENTION_DAYS.weekly).toBe(56);
  });

  it("adds a monthly copy on the configured UTC day", async () => {
    const directory = await makeDirectory();
    const keys: string[] = [];
    const store = makeStore({ put: async ({ key }) => keys.push(key) });
    await runBackup(
      { ...baseConfig, stagingDirectory: directory, monthlyUtcDay: 15 },
      makeDependencies(store)
    );
    expect(keys).toHaveLength(3);
    expect(keys.some((key) => key.includes("/monthly/"))).toBe(true);
  });

  it("anchors retention to upload time instead of capture start time", async () => {
    const directory = await makeDirectory();
    const uploads: Array<{ retainUntil: Date }> = [];
    const store = makeStore({ put: async (input) => uploads.push({ retainUntil: input.retainUntil }) });
    const dependencies = makeDependencies(store);
    const times = [
      new Date("2026-11-15T02:15:00.000Z"),
      new Date("2026-11-15T05:00:00.000Z"),
      new Date("2026-11-15T05:01:00.000Z"),
    ];
    dependencies.now = () => times.shift() ?? new Date("2026-11-15T05:01:00.000Z");

    await runBackup({ ...baseConfig, stagingDirectory: directory }, dependencies);

    expect(uploads[0]?.retainUntil.toISOString()).toBe("2026-11-29T06:00:00.000Z");
  });

  it("does not leave temporary dump or encrypted files after failure", async () => {
    const directory = await makeDirectory();
    const dependencies = makeDependencies(makeStore());
    dependencies.encryptDump = async () => {
      throw new Error("simulated age interruption");
    };

    await expect(runBackup({ ...baseConfig, stagingDirectory: directory }, dependencies)).rejects.toThrow(
      "simulated age interruption"
    );
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("retries an interrupted upload and accepts the verified object", async () => {
    const directory = await makeDirectory();
    let attempts = 0;
    const store = makeStore({
      put: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated upload interruption");
      },
    });
    const result = await runBackup({ ...baseConfig, stagingDirectory: directory }, makeDependencies(store));
    expect(result.objects).toHaveLength(2);
    expect(attempts).toBe(3);
  });

  it("fails closed when an existing unique object has the wrong checksum", async () => {
    const directory = await makeDirectory();
    const store = makeStore({
      head: async () => ({ contentLength: 999, metadata: { sha256: "wrong" } }),
    });
    await expect(runBackup({ ...baseConfig, stagingDirectory: directory }, makeDependencies(store))).rejects.toThrow(
      "size mismatch"
    );
  });

  it("rejects retention shorter than the required class", async () => {
    const directory = await makeDirectory();
    const store = makeStore({
      retention: async () => ({ mode: "GOVERNANCE", retainUntil: new Date("2026-11-20T00:00:00.000Z") }),
    });
    await expect(runBackup({ ...baseConfig, stagingDirectory: directory }, makeDependencies(store))).rejects.toThrow(
      "retention is shorter"
    );
  });
});
