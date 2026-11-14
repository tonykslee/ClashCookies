import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { request } from "node:https";
import { join, resolve } from "node:path";

export const BACKUP_RETENTION_DAYS = {
  daily: 14,
  weekly: 56,
  monthly: 186,
} as const;

const BACKUP_RETENTION_SAFETY_MS = 60 * 60 * 1000;

export type RetentionClass = keyof typeof BACKUP_RETENTION_DAYS;

export type BackupConfig = {
  databaseService: string;
  pgDumpPath: string;
  pgServiceFile: string;
  pgPassFile: string;
  stagingDirectory: string;
  b2Bucket: string;
  b2Endpoint: string;
  b2Region: string;
  b2Prefix: string;
  ageRecipients: string[];
  weeklyUtcDay: number;
  monthlyUtcDay: number;
  maxAttempts: number;
  heartbeatUrl?: string;
  failureAlertUrl?: string;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

export type PutObjectInput = {
  bodyPath: string;
  key: string;
  metadata: Record<string, string>;
  retainUntil: Date;
};

export type HeadObject = {
  contentLength: number;
  metadata: Record<string, string | undefined>;
};

export type ObjectRetention = {
  mode: string;
  retainUntil: Date;
};

export type ObjectStore = {
  headObject: (key: string) => Promise<HeadObject | null>;
  getObjectRetention: (key: string) => Promise<ObjectRetention>;
  putObject: (input: PutObjectInput) => Promise<void>;
};

export type BackupNotification = {
  backupId: string;
  event: "backup_failed" | "backup_succeeded";
  objectCount?: number;
};

export type BackupDependencies = {
  runDump: (outputPath: string) => Promise<void>;
  encryptDump: (inputPath: string, outputPath: string, recipients: string[]) => Promise<void>;
  objectStore: ObjectStore;
  now?: () => Date;
  randomId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  notify?: (notification: BackupNotification) => Promise<void>;
  logger?: Pick<Console, "error" | "log">;
};

export type BackupObject = {
  key: string;
  retentionClass: RetentionClass;
  retainUntil: string;
  sha256: string;
  bytes: number;
};

export type BackupResult = {
  backupId: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  objects: BackupObject[];
};

type BackupError = Error & { code?: string; stderr?: string };

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`Missing required backup setting: ${name}`);
  return value;
}

function parseDay(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw new Error(`${name} must be an integer from 0 through 6`);
  }
  return value;
}

function parseCalendarDay(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new Error(`${name} must be an integer from 1 through 31`);
  }
  return value;
}

function parsePositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Loads backup configuration without accepting a database URL that could leak in process arguments. */
export function loadBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const ageRecipients = [
    requiredValue(env, "BACKUP_AGE_RECIPIENT_PRIMARY"),
    requiredValue(env, "BACKUP_AGE_RECIPIENT_EMERGENCY"),
  ];
  const prefix = requiredValue(env, "BACKUP_B2_PREFIX").replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("BACKUP_B2_PREFIX must not be empty");

  return {
    databaseService: requiredValue(env, "BACKUP_DATABASE_SERVICE"),
    pgDumpPath: requiredValue(env, "BACKUP_PG_DUMP_PATH"),
    pgServiceFile: requiredValue(env, "BACKUP_PG_SERVICEFILE"),
    pgPassFile: requiredValue(env, "BACKUP_PGPASSFILE"),
    stagingDirectory: requiredValue(env, "BACKUP_STAGING_DIR"),
    b2Bucket: requiredValue(env, "BACKUP_B2_BUCKET"),
    b2Endpoint: requiredValue(env, "BACKUP_B2_ENDPOINT"),
    b2Region: requiredValue(env, "AWS_DEFAULT_REGION"),
    b2Prefix: prefix,
    ageRecipients,
    weeklyUtcDay: parseDay(env, "BACKUP_WEEKLY_UTC_DAY", 0),
    monthlyUtcDay: parseCalendarDay(env, "BACKUP_MONTHLY_UTC_DAY", 1),
    maxAttempts: parsePositiveInteger(env, "BACKUP_MAX_ATTEMPTS", 3),
    heartbeatUrl: env.BACKUP_HEARTBEAT_URL?.trim() || undefined,
    failureAlertUrl: env.BACKUP_FAILURE_ALERT_URL?.trim() || undefined,
  };
}

/** Creates a child-process runner that never logs command arguments or environment values. */
export function createCommandRunner(): CommandRunner {
  return (command, args, options = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        if (exitCode === 0) {
          resolvePromise({ stdout, stderr });
          return;
        }
        const error = new Error(`${command} exited with status ${exitCode}`) as BackupError;
        error.code = "backup_command_failed";
        error.stderr = stderr;
        reject(error);
      });
    });
}

/** Runs PostgreSQL 17 pg_dump through a service file and a read-only transaction guard. */
function assertPostgres17DumpVersion(versionOutput: string): void {
  const match = versionOutput.match(/PostgreSQL\)?\s+(\d+)(?:\.\d+)?/i);
  if (!match || Number(match[1]) !== 17) {
    throw new Error("Configured pg_dump must be PostgreSQL 17");
  }
}

export function createPgDumpRunner(
  config: BackupConfig,
  commandRunner: CommandRunner = createCommandRunner()
): (outputPath: string) => Promise<void> {
  return async (outputPath) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      PGSERVICE: config.databaseService,
      PGSERVICEFILE: config.pgServiceFile,
      PGPASSFILE: config.pgPassFile,
      PGOPTIONS: "-c default_transaction_read_only=on",
    };
    const version = await commandRunner(config.pgDumpPath, ["--version"], { env });
    assertPostgres17DumpVersion(`${version.stdout}\n${version.stderr}`);
    await commandRunner(
      config.pgDumpPath,
      ["--format=custom", "--no-password", "--file", outputPath, "--dbname", `service=${config.databaseService}`],
      { env }
    );
  };
}

/** Encrypts a completed dump with both the primary and emergency public recipients. */
export function createAgeEncryptor(
  commandRunner: CommandRunner = createCommandRunner()
): (inputPath: string, outputPath: string, recipients: string[]) => Promise<void> {
  return async (inputPath, outputPath, recipients) => {
    const args = recipients.flatMap((recipient) => ["--recipient", recipient]);
    await commandRunner("age", [...args, "--output", outputPath, inputPath], {
      env: { PATH: process.env.PATH },
    });
  };
}

/** Creates an AWS CLI-backed B2 object store using explicit Object Lock retention. */
export function createB2ObjectStore(
  config: BackupConfig,
  commandRunner: CommandRunner = createCommandRunner()
): ObjectStore {
  const commonArgs = ["--endpoint-url", config.b2Endpoint, "--no-cli-pager"];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: config.b2Region,
    AWS_EC2_METADATA_DISABLED: "true",
  };

  return {
    async putObject(input) {
      await commandRunner(
        "aws",
        [
          "s3api",
          "put-object",
          "--bucket",
          config.b2Bucket,
          "--key",
          input.key,
          "--body",
          input.bodyPath,
          "--object-lock-mode",
          "GOVERNANCE",
          "--object-lock-retain-until-date",
          input.retainUntil.toISOString(),
          "--metadata",
          Object.entries(input.metadata)
            .map(([key, value]) => `${key}=${value}`)
            .join(","),
          ...commonArgs,
        ],
        { env }
      );
    },
    async headObject(key) {
      try {
        const result = await commandRunner(
          "aws",
          ["s3api", "head-object", "--bucket", config.b2Bucket, "--key", key, ...commonArgs],
          { env }
        );
        const parsed = JSON.parse(result.stdout) as {
          ContentLength?: number;
          Metadata?: Record<string, string>;
        };
        return {
          contentLength: Number(parsed.ContentLength ?? 0),
          metadata: parsed.Metadata ?? {},
        };
      } catch (error) {
        const commandError = error as BackupError;
        if (commandError.stderr && /(404|not found|nosuchkey|no such key)/i.test(commandError.stderr)) {
          return null;
        }
        throw error;
      }
    },
    async getObjectRetention(key) {
      const result = await commandRunner(
        "aws",
        ["s3api", "get-object-retention", "--bucket", config.b2Bucket, "--key", key, ...commonArgs],
        { env }
      );
      const parsed = JSON.parse(result.stdout) as {
        Retention?: { Mode?: string; RetainUntilDate?: string };
      };
      if (!parsed.Retention?.Mode || !parsed.Retention.RetainUntilDate) {
        throw new Error("B2 object is missing Object Lock retention metadata");
      }
      const retainUntil = new Date(parsed.Retention.RetainUntilDate);
      if (!Number.isFinite(retainUntil.getTime())) {
        const error = new Error("B2 returned an invalid retention timestamp") as BackupError;
        error.code = "backup_object_retention_invalid";
        throw error;
      }
      return {
        mode: parsed.Retention.Mode,
        retainUntil,
      };
    },
  };
}

/** Computes a SHA-256 checksum without retaining database contents in memory. */
async function sha256File(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents as unknown as Uint8Array<ArrayBuffer>).digest("hex");
}

/** Produces a filesystem-safe unique backup identifier from UTC time and random bytes. */
function createBackupId(now: Date, randomId: () => string): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return `${timestamp}-${randomId()}`;
}

/** Returns the retention classes that receive a copy of the daily dump. */
function selectRetentionClasses(now: Date, config: BackupConfig): RetentionClass[] {
  const classes: RetentionClass[] = ["daily"];
  if (now.getUTCDay() === config.weeklyUtcDay) classes.push("weekly");
  if (now.getUTCDate() === config.monthlyUtcDay) classes.push("monthly");
  return classes;
}

/** Builds a stable B2 key whose category controls the lifecycle retention rule. */
function objectKey(config: BackupConfig, now: Date, retentionClass: RetentionClass, backupId: string): string {
  const datePath = now.toISOString().slice(0, 10).replace(/-/g, "/");
  return `${config.b2Prefix}/${retentionClass}/${datePath}/clashcookies-prod-${backupId}.dump.age`;
}

/** Validates an uploaded object without downloading database contents again. */
async function verifyUploadedObject(
  store: ObjectStore,
  key: string,
  bytes: number,
  sha256: string,
  retainUntil: Date
): Promise<void> {
  const head = await store.headObject(key);
  if (!head) throw new Error(`Uploaded backup object was not found: ${key}`);
  if (head.contentLength !== bytes) throw new Error(`Uploaded backup size mismatch: ${key}`);
  if (head.metadata.sha256?.toLowerCase() !== sha256) {
    throw new Error(`Uploaded backup checksum mismatch: ${key}`);
  }
  const retention = await store.getObjectRetention(key);
  if (retention.mode !== "GOVERNANCE") throw new Error(`Backup object is not governance-locked: ${key}`);
  if (retention.retainUntil.getTime() < retainUntil.getTime()) {
    throw new Error(`Backup object retention is shorter than required: ${key}`);
  }
}

/** Retries an idempotent unique-object upload while refusing to overwrite a mismatched object. */
async function uploadWithRetry(
  store: ObjectStore,
  input: Omit<PutObjectInput, "retainUntil">,
  retentionDays: number,
  bytes: number,
  sha256: string,
  maxAttempts: number,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => Date
): Promise<Date> {
  let requiredRetainUntil: Date | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const existing = await store.headObject(input.key);
    if (existing) {
      requiredRetainUntil ??= new Date(now().getTime() + retentionDays * 24 * 60 * 60 * 1000 + BACKUP_RETENTION_SAFETY_MS);
      await verifyUploadedObject(store, input.key, bytes, sha256, requiredRetainUntil);
      return requiredRetainUntil;
    }
    requiredRetainUntil = new Date(
      now().getTime() + retentionDays * 24 * 60 * 60 * 1000 + BACKUP_RETENTION_SAFETY_MS
    );
    try {
      await store.putObject({ ...input, retainUntil: requiredRetainUntil });
      await verifyUploadedObject(store, input.key, bytes, sha256, requiredRetainUntil);
      return requiredRetainUntil;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw new Error("Backup upload did not complete");
}

/** Runs one encrypted dump upload and removes every temporary artifact on success or failure. */
export async function runBackup(
  config: BackupConfig,
  dependencies: BackupDependencies
): Promise<BackupResult> {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => randomBytes(6).toString("hex"));
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const logger = dependencies.logger ?? console;
  const createdAt = now();
  const backupId = createBackupId(createdAt, randomId);
  const temporaryDirectory = await mkdtemp(join(resolve(config.stagingDirectory), ".clashcookies-backup-"));
  const dumpPath = join(temporaryDirectory, `${backupId}.dump`);
  const encryptedPath = join(temporaryDirectory, `${backupId}.dump.age`);

  try {
    await dependencies.runDump(dumpPath);
    const dumpStats = await stat(dumpPath);
    if (dumpStats.size <= 0) throw new Error("pg_dump produced an empty archive");
    await dependencies.encryptDump(dumpPath, encryptedPath, config.ageRecipients);
    const encryptedStats = await stat(encryptedPath);
    if (encryptedStats.size <= 0) throw new Error("age produced an empty archive");
    const sha256 = await sha256File(encryptedPath);
    const objects: BackupObject[] = [];

    for (const retentionClass of selectRetentionClasses(createdAt, config)) {
      const key = objectKey(config, createdAt, retentionClass, backupId);
      const retainUntil = await uploadWithRetry(
        dependencies.objectStore,
        {
          bodyPath: encryptedPath,
          key,
          metadata: { backupid: backupId, retention: retentionClass, sha256 },
        },
        BACKUP_RETENTION_DAYS[retentionClass],
        encryptedStats.size,
        sha256,
        config.maxAttempts,
        sleep,
        now
      );
      objects.push({
        key,
        retentionClass,
        retainUntil: retainUntil.toISOString(),
        sha256,
        bytes: encryptedStats.size,
      });
    }

    if (dependencies.notify) {
      await dependencies.notify({ backupId, event: "backup_succeeded", objectCount: objects.length });
    }
    logger.log(`[backup] completed backupId=${backupId} objects=${objects.length} bytes=${encryptedStats.size}`);
    return { backupId, createdAt: createdAt.toISOString(), bytes: encryptedStats.size, sha256, objects };
  } catch (error) {
    if (dependencies.notify) {
      try {
        await dependencies.notify({ backupId, event: "backup_failed" });
      } catch {
        logger.error(`[backup] failure alert delivery failed backupId=${backupId}`);
      }
    }
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Sends a bounded status notification without including database, credential, or command details. */
export async function sendBackupNotification(
  notification: BackupNotification,
  heartbeatUrl?: string,
  failureAlertUrl?: string
): Promise<void> {
  const url = notification.event === "backup_succeeded" ? heartbeatUrl : failureAlertUrl;
  if (!url) return;
  await new Promise<void>((resolvePromise, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") {
      reject(new Error("Backup notification URL must use HTTPS"));
      return;
    }
    const requestBody = JSON.stringify({
      backup_id: notification.backupId,
      event: notification.event,
      object_count: notification.objectCount,
    });
    const notificationRequest = request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(requestBody),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolvePromise();
          } else {
            reject(new Error(`Backup notification returned HTTP ${statusCode}`));
          }
        });
      }
    );
    notificationRequest.setTimeout(5_000, () => notificationRequest.destroy(new Error("Backup notification timed out")));
    notificationRequest.on("error", reject);
    notificationRequest.end(requestBody);
  });
}
