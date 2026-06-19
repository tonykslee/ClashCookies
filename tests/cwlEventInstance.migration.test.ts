import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260618120000_add_cwl_event_instances/migration.sql", import.meta.url),
);
const ROTATION_MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260619120000_scope_cwl_rotation_plans_by_event/migration.sql", import.meta.url),
);
const REPAIR_ROTATION_MIGRATION_PATH = fileURLToPath(
  new URL("../prisma/migrations/20260619130000_repair_current_cwl_rotation_event_scope/migration.sql", import.meta.url),
);

type PostgresToolName = "initdb" | "postgres" | "psql" | "pg_ctl" | "pg_config";

type ResolvedPostgresTool = {
  command: string;
  source: string;
};

type PostgresToolchain = {
  initdb: ResolvedPostgresTool;
  postgres: ResolvedPostgresTool;
  psql: ResolvedPostgresTool;
  pgCtl: ResolvedPostgresTool;
  sessionEnv: NodeJS.ProcessEnv;
};

type HistoricalEventFixture = {
  id: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

type OrphanPlanFixture = {
  season: string;
  clanTag: string;
  eventInstanceId: string;
  createdAt: Date;
  updatedAt: Date;
};

type ActivePlanFixture = {
  id: string;
  eventInstanceId: string;
  clanTag: string;
  version: number;
  updatedAt: Date;
  isActive: boolean;
};

function loadMigration(): string {
  return readFileSync(ROTATION_MIGRATION_PATH, "utf8");
}

function loadMigrationStatements(): string[] {
  return loadMigration()
    .split(/;\s*(?:\r?\n|$)/g)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function findStatementIndex(statements: string[], pattern: string): number {
  return statements.findIndex((statement) => statement.includes(pattern));
}

function expectNoLaterStatementReferences(statements: string[], startIndex: number, pattern: string) {
  expect(statements.slice(startIndex + 1).some((statement) => statement.includes(pattern))).toBe(false);
}

function expectOrphanTempTableStructure(statement: string) {
  expect(statement).toContain('CREATE TEMP TABLE "_CwlRotationOrphanGroup" AS');
  expect(statement).toContain('WHERE plan."eventInstanceId" IS NULL');
  expect(statement).toContain('orphan_groups AS (');
  expect(statement).toContain('ranked_orphans AS (');
  expect(statement).toContain('FROM ranked_orphans orphan');
  expect(statement).not.toContain('ON COMMIT DROP');
  expect(statement).toMatch(
    /ROW_NUMBER\(\) OVER \(\s*PARTITION BY orphan\."clanTag"\s*ORDER BY\s*orphan\."lastUpdatedAt" DESC,\s*orphan\."firstCreatedAt" DESC,\s*orphan\."season" DESC,\s*orphan\."eventInstanceId" DESC\s*\) AS "orphanRank"/,
  );
}

function expectSyntheticCurrentStructure(statement: string) {
  expect(statement).toContain('FROM "_CwlRotationOrphanGroup" orphan');
  expect(statement).toContain('orphan."orphanRank" = 1');
  expect(statement).toContain('NOT EXISTS (');
  expect(statement).toContain('current_clan."clanTag" = orphan."clanTag"');
  expect(statement).toContain('current_clan."isCurrent" = true');
  expect(statement).toContain('ELSE false');
}

type TempRepairEventInstanceRow = {
  id: string;
  season: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

type TempRepairEventClanRow = {
  clanTag: string;
  eventInstanceId: string;
  isCurrent: boolean;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

type TempRepairPlanRow = {
  id: string;
  clanTag: string;
  season: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  eventInstanceId: string;
  isActive: boolean;
};

type TempPgCluster = {
  port: number;
  dataDir: string;
  runSql: (sql: string) => string;
};

type PostgresCommandFailure = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

type PostgresExitState = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Format a JavaScript Date as a timezone-less PostgreSQL timestamp literal.
function sqlTimestamp(value: Date): string {
  return `TIMESTAMP(3) ${sqlText(value.toISOString().slice(0, 23).replace("T", " "))}`;
}

// Pick a platform-appropriate PostgreSQL executable name.
function postgresExecutableName(toolName: PostgresToolName): string {
  return process.platform === "win32" ? `${toolName}.exe` : toolName;
}

// Build PostgreSQL tool candidates from the configured bin dir, pg_config bindir, and PATH.
function buildPostgresToolCandidates(toolName: PostgresToolName, bindirCandidates: string[]): ResolvedPostgresTool[] {
  const executableName = postgresExecutableName(toolName);
  const candidates = bindirCandidates.map((bindir) => ({
    command: join(bindir, executableName),
    source: `bindir:${bindir}`,
  }));
  candidates.push({
    command: executableName,
    source: "PATH",
  });
  return candidates;
}

// Resolve a runnable PostgreSQL tool from the configured sources and record what worked.
function resolvePostgresToolOrNull(
  toolName: PostgresToolName,
  bindirCandidates: string[],
): ResolvedPostgresTool | null {
  for (const candidate of buildPostgresToolCandidates(toolName, bindirCandidates)) {
    try {
      execFileSync(candidate.command, ["--version"], {
        encoding: "utf8",
      });
      return candidate;
    } catch {
      // Try the next PostgreSQL source before failing the migration test preflight.
    }
  }
  return null;
}

// Resolve pg_config bindir so the test can reuse the same server installation on any platform.
function resolvePostgresBindirFromPgConfig(configuredBindir: string | null): string | null {
  const pgConfig = resolvePostgresToolOrNull("pg_config", configuredBindir ? [configuredBindir] : []);
  if (!pgConfig) {
    return null;
  }
  try {
    const bindir = execFileSync(pgConfig.command, ["--bindir"], {
      encoding: "utf8",
    }).trim();
    return bindir || null;
  } catch {
    return null;
  }
}

// Format an actionable error when the PostgreSQL server tools are unavailable.
function formatPostgresToolchainResolutionError(
  missingTools: string[],
  configuredBindir: string | null,
  pgConfigBindir: string | null,
): string {
  const bindirSummary = configuredBindir ? `POSTGRES_BIN_DIR=${configuredBindir}` : "POSTGRES_BIN_DIR=(unset)";
  const pgConfigSummary = pgConfigBindir ? `pg_config --bindir=${pgConfigBindir}` : "pg_config --bindir=unavailable";
  return [
    `Unable to resolve PostgreSQL tools required by cwlEventInstance.migration.test.ts: ${missingTools.join(", ")}.`,
    `Tried ${bindirSummary}, ${pgConfigSummary}, and PATH fallback command names.`,
    "Install the PostgreSQL server tools, or set POSTGRES_BIN_DIR to a directory containing initdb, postgres, psql, and pg_ctl.",
  ].join(" ");
}

// Resolve the PostgreSQL toolchain and fail fast when any required tool is missing.
function resolvePostgresToolchainOrThrow(sessionTimezone?: string): PostgresToolchain {
  const configuredBindir = process.env.POSTGRES_BIN_DIR?.trim() || null;
  const pgConfigBindir = resolvePostgresBindirFromPgConfig(configuredBindir);
  const bindirCandidates = [configuredBindir, pgConfigBindir].filter((value): value is string => Boolean(value));

  const initdb = resolvePostgresToolOrNull("initdb", bindirCandidates);
  const postgres = resolvePostgresToolOrNull("postgres", bindirCandidates);
  const psql = resolvePostgresToolOrNull("psql", bindirCandidates);
  const pgCtl = resolvePostgresToolOrNull("pg_ctl", bindirCandidates);
  const missingTools = [
    !initdb ? "initdb" : null,
    !postgres ? "postgres" : null,
    !psql ? "psql" : null,
    !pgCtl ? "pg_ctl" : null,
  ].filter((tool): tool is string => Boolean(tool));

  if (missingTools.length > 0 || !initdb || !postgres || !psql || !pgCtl) {
    throw new Error(formatPostgresToolchainResolutionError(missingTools, configuredBindir, pgConfigBindir));
  }

  return {
    initdb,
    postgres,
    psql,
    pgCtl,
    sessionEnv: buildPostgresSessionEnv(sessionTimezone),
  };
}

// Apply a per-session timezone to every psql invocation without mutating global process state.
function buildPostgresSessionEnv(sessionTimezone?: string): NodeJS.ProcessEnv {
  if (!sessionTimezone) {
    return process.env;
  }
  return {
    ...process.env,
    PGTZ: sessionTimezone,
  };
}

// Build the temporary server arguments that keep the cluster TCP-only and bound to localhost.
function buildPostgresServerArgs(dataDir: string, port: number): string[] {
  const args = ["-D", dataDir, "-h", "127.0.0.1", "-p", String(port)];
  if (process.platform !== "win32") {
    args.push("-c", "unix_socket_directories=");
  }
  return args;
}

// Read the temporary cluster startup log without failing the harness cleanup path.
function readStartupLogContents(startupLogPath: string): string {
  try {
    return readFileSync(startupLogPath, "utf8").trim();
  } catch {
    return "<startup log unavailable>";
  }
}

// Format a startup failure with the command, exit status, and server log for quick diagnosis.
function formatPostgresStartupFailure(
  phase: "start" | "readiness",
  failure: PostgresCommandFailure | null,
  startupCommand: string,
  startupArgs: string[],
  startupLogPath: string,
  dataDir: string,
  port: number,
): Error {
  const exitSummary = failure
    ? `exit_code=${failure.exitCode ?? "unknown"} signal=${failure.signal ?? "none"}`
    : "exit_code=unknown signal=unknown";
  const commandSummary = [startupCommand, ...startupArgs].join(" ");
  const logContents = readStartupLogContents(startupLogPath);
  const details = [
    `Temporary PostgreSQL ${phase} failed for cwlEventInstance.migration.test.ts.`,
    `command=${commandSummary}`,
    `status=${exitSummary}`,
    `data_dir=${dataDir}`,
    `port=${port}`,
  ];
  if (failure) {
    details.push(`stdout=${failure.stdout.trim() || "<empty>"}`);
    details.push(`stderr=${failure.stderr.trim() || "<empty>"}`);
  }
  details.push(`startup_log=${logContents || "<empty>"}`);
  return new Error(details.join(" "));
}

// Capture an execFileSync failure in a structured form for actionable startup errors.
function toPostgresCommandFailure(command: string, args: string[], error: unknown): PostgresCommandFailure {
  const failure = error as NodeJS.ErrnoException & {
    status?: number | null;
    signal?: string | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  };
  return {
    command,
    args,
    exitCode: typeof failure.status === "number" ? failure.status : null,
    signal: typeof failure.signal === "string" ? failure.signal : null,
    stdout: typeof failure.stdout === "string" ? failure.stdout : Buffer.isBuffer(failure.stdout) ? failure.stdout.toString("utf8") : "",
    stderr: typeof failure.stderr === "string" ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : "",
  };
}

async function withTemporaryPostgres<T>(
  callback: (cluster: TempPgCluster) => Promise<T>,
  sessionTimezone?: string,
): Promise<T> {
  const tempBaseDir = ".tmp-migration-pg";
  mkdirSync(tempBaseDir, { recursive: true });
  const dataDir = join(tempBaseDir, `cluster-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  rmSync(dataDir, { recursive: true, force: true });
  const tracePath = join(tempBaseDir, `trace-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const startupLogPath = join(tempBaseDir, `startup-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const trace = (message: string) => appendFileSync(tracePath, `${message}\n`, "utf8");
  const port = await reserveFreePort();
  const toolchain = resolvePostgresToolchainOrThrow(sessionTimezone);
  const startupLogFd = openSync(startupLogPath, "a");
  let started = false;
  let postgresProcessExited: PostgresExitState | null = null;
  let postgresLaunchFailure: PostgresCommandFailure | null = null;
  try {
    trace(`initdb_start ${dataDir}`);
    execFileSync(toolchain.initdb.command, ["-D", dataDir, "--auth=trust", "--username=postgres"], {
      encoding: "utf8",
    });
    trace(`initdb_done ${dataDir}`);
    const postgresArgs = buildPostgresServerArgs(dataDir, port);
    trace(`postgres_start ${toolchain.postgres.command} ${postgresArgs.join(" ")}`);
    const postgresProcess = spawn(toolchain.postgres.command, postgresArgs, {
      stdio: ["ignore", startupLogFd, startupLogFd],
      windowsHide: true,
    });
    const postgresExitPromise = new Promise<PostgresExitState | null>((resolve) => {
      postgresProcess.once("error", (error) => {
        postgresLaunchFailure = toPostgresCommandFailure(toolchain.postgres.command, postgresArgs, error);
        resolve(null);
      });
      postgresProcess.once("exit", (code, signal) => {
        const exitState = {
          code,
          signal,
        };
        postgresProcessExited = exitState;
        resolve(exitState);
      });
    });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (postgresLaunchFailure) {
        throw formatPostgresStartupFailure(
          "start",
          postgresLaunchFailure,
          toolchain.postgres.command,
          postgresArgs,
          startupLogPath,
          dataDir,
          port,
        );
      }
      if (postgresProcessExited) {
        throw formatPostgresStartupFailure(
          "start",
          {
            command: toolchain.postgres.command,
            args: postgresArgs,
            exitCode: postgresProcessExited.code,
            signal: postgresProcessExited.signal,
            stdout: "",
            stderr: "",
          },
          toolchain.postgres.command,
          postgresArgs,
          startupLogPath,
          dataDir,
          port,
        );
      }
      try {
        execFileSync(
          toolchain.psql.command,
          [
            "-h",
            "127.0.0.1",
            "-p",
            String(port),
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-q",
            "-A",
            "-t",
            "-F",
            "\t",
            "-c",
            "select 1;",
          ],
          {
            encoding: "utf8",
            env: toolchain.sessionEnv,
          },
        );
        trace(`postgres_ready ${port}`);
        started = true;
        break;
      } catch (error) {
        if (postgresLaunchFailure) {
          throw formatPostgresStartupFailure(
            "start",
            postgresLaunchFailure,
            toolchain.postgres.command,
            postgresArgs,
            startupLogPath,
            dataDir,
            port,
          );
        }
        if (postgresProcessExited) {
          throw formatPostgresStartupFailure(
            "readiness",
            {
              command: toolchain.postgres.command,
              args: postgresArgs,
              exitCode: postgresProcessExited.code,
              signal: postgresProcessExited.signal,
              stdout: "",
              stderr: "",
            },
            toolchain.postgres.command,
            postgresArgs,
            startupLogPath,
            dataDir,
            port,
          );
        }
        if (attempt === 59) {
          throw formatPostgresStartupFailure(
            "readiness",
            toPostgresCommandFailure(toolchain.psql.command, ["select 1;"], error),
            toolchain.postgres.command,
            postgresArgs,
            startupLogPath,
            dataDir,
            port,
          );
        }
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 250)), postgresExitPromise]);
        if (postgresLaunchFailure) {
          throw formatPostgresStartupFailure(
            "start",
            postgresLaunchFailure,
            toolchain.postgres.command,
            postgresArgs,
            startupLogPath,
            dataDir,
            port,
          );
        }
        if (postgresProcessExited) {
          throw formatPostgresStartupFailure(
            "start",
            {
              command: toolchain.postgres.command,
              args: postgresArgs,
              exitCode: postgresProcessExited.code,
              signal: postgresProcessExited.signal,
              stdout: "",
              stderr: "",
            },
            toolchain.postgres.command,
            postgresArgs,
            startupLogPath,
            dataDir,
            port,
          );
        }
      }
    }

    const runSql = (sql: string) =>
      execFileSync(
        toolchain.psql.command,
        [
          "-h",
          "127.0.0.1",
          "-p",
          String(port),
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-q",
          "-A",
          "-t",
          "-F",
          "\t",
        ],
        {
          encoding: "utf8",
          input: sql,
          env: toolchain.sessionEnv,
        },
      ).trim();

    return await callback({ port, dataDir, runSql });
  } finally {
    closeSync(startupLogFd);
    if (started) {
      trace(`pg_ctl_stop ${port}`);
      try {
        execFileSync(toolchain.pgCtl.command, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
          encoding: "utf8",
          env: toolchain.sessionEnv,
        });
      } catch {
        // Best-effort cleanup after temporary migration verification.
      }
    }
    await waitForDirectoryRelease(dataDir);
    trace(`cleanup ${port}`);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(startupLogPath, { force: true });
  }
}

async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
        return;
      }
      reject(new Error("Unable to reserve a free PostgreSQL port"));
    });
  });
}

async function waitForDirectoryRelease(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function parseTabSeparatedRows(output: string): string[][] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

const REPAIR_MIGRATION_SEASON = "2026-06";
const REPAIR_MIGRATION_LEGACY_FIRST_OBSERVED_AT = new Date("2026-06-16T18:04:00.000Z");
const REPAIR_MIGRATION_LEGACY_LAST_OBSERVED_AT = new Date("2026-06-19T07:11:00.000Z");
const REPAIR_MIGRATION_CURRENT_FIRST_OBSERVED_AT = new Date("2026-06-19T08:43:00.000Z");
const REPAIR_MIGRATION_CURRENT_LAST_OBSERVED_AT = new Date("2026-06-19T09:36:00.000Z");

type RepairMigrationFixtureRow = {
  id: string;
  clanTag: string;
  season: string;
  version: number;
  createdAt: Date;
  eventInstanceId: string;
  currentEventInstanceId: string;
};

function buildRepairMigrationSeed(rows: RepairMigrationFixtureRow[]): {
  events: TempRepairEventInstanceRow[];
  eventClans: TempRepairEventClanRow[];
  plans: TempRepairPlanRow[];
} {
  const eventsById = new Map<string, TempRepairEventInstanceRow>();
  const eventClanRows: TempRepairEventClanRow[] = [];
  const planRows: TempRepairPlanRow[] = rows.map((row) => ({
    id: row.id,
    clanTag: row.clanTag,
    season: row.season,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    eventInstanceId: row.eventInstanceId,
    isActive: true,
  }));

  const ensureEvent = (
    id: string,
    season: string,
    firstObservedAt: Date,
    lastObservedAt: Date,
  ): TempRepairEventInstanceRow => {
    const existing = eventsById.get(id);
    if (existing) return existing;
    const event = {
      id,
      season,
      firstObservedAt,
      lastObservedAt,
    };
    eventsById.set(id, event);
    return event;
  };

  for (const row of rows) {
    const sourceObservedAt =
      row.eventInstanceId === row.currentEventInstanceId
        ? REPAIR_MIGRATION_CURRENT_FIRST_OBSERVED_AT
        : REPAIR_MIGRATION_LEGACY_FIRST_OBSERVED_AT;
    const sourceLastObservedAt =
      row.eventInstanceId === row.currentEventInstanceId
        ? REPAIR_MIGRATION_CURRENT_LAST_OBSERVED_AT
        : REPAIR_MIGRATION_LEGACY_LAST_OBSERVED_AT;
    const currentObservedAt =
      row.eventInstanceId === row.currentEventInstanceId
        ? sourceObservedAt
        : REPAIR_MIGRATION_CURRENT_FIRST_OBSERVED_AT;
    const currentLastObservedAt =
      row.eventInstanceId === row.currentEventInstanceId
        ? sourceLastObservedAt
        : REPAIR_MIGRATION_CURRENT_LAST_OBSERVED_AT;

    ensureEvent(row.eventInstanceId, row.season, sourceObservedAt, sourceLastObservedAt);
    if (row.currentEventInstanceId !== row.eventInstanceId) {
      ensureEvent(
        row.currentEventInstanceId,
        row.season,
        currentObservedAt,
        currentLastObservedAt,
      );
      eventClanRows.push({
        clanTag: row.clanTag,
        eventInstanceId: row.eventInstanceId,
        isCurrent: false,
        firstObservedAt: sourceObservedAt,
        lastObservedAt: sourceLastObservedAt,
      });
    }
    eventClanRows.push({
      clanTag: row.clanTag,
      eventInstanceId: row.currentEventInstanceId,
      isCurrent: true,
      firstObservedAt: currentObservedAt,
      lastObservedAt: currentLastObservedAt,
    });
  }

  return {
    events: [...eventsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    eventClans: eventClanRows.sort((left, right) =>
      left.clanTag.localeCompare(right.clanTag) ||
      left.eventInstanceId.localeCompare(right.eventInstanceId) ||
      Number(left.isCurrent) - Number(right.isCurrent),
    ),
    plans: planRows.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function buildDiagnosedRepairRows(): {
  affected: RepairMigrationFixtureRow[];
  historical: RepairMigrationFixtureRow[];
  unrelatedSeason: RepairMigrationFixtureRow[];
  unrelatedClan: RepairMigrationFixtureRow[];
} {
  const affected: RepairMigrationFixtureRow[] = [
    {
      id: "cmqhiv81g01i4tr40oiyg33ig",
      clanTag: "#2C0UURLQU",
      season: REPAIR_MIGRATION_SEASON,
      version: 5,
      createdAt: new Date("2026-06-17T03:39:25.684Z"),
      eventInstanceId: "legacy:2026-06:#2C0UURLQU",
      currentEventInstanceId: "cmqkolj7800yly017ec8wb9qe",
    },
    {
      id: "cmqhcyu4j05wt4ll0715ru1bh",
      clanTag: "#2C998J8LY",
      season: REPAIR_MIGRATION_SEASON,
      version: 3,
      createdAt: new Date("2026-06-17T00:54:16.579Z"),
      eventInstanceId: "legacy:2026-06:#2C998J8LY",
      currentEventInstanceId: "cmqkolpxc0105y017ee11ejb1",
    },
    {
      id: "cmqhcwtp105wp4ll03qzam7au",
      clanTag: "#2CCR8UYG0",
      season: REPAIR_MIGRATION_SEASON,
      version: 5,
      createdAt: new Date("2026-06-17T00:52:42.709Z"),
      eventInstanceId: "legacy:2026-06:#2CCR8UYG0",
      currentEventInstanceId: "cmqkolnd800zdy017nbp6eo7a",
    },
    {
      id: "cmqh1bx6j0fp9gxnd4njg87ef",
      clanTag: "#2CCUGYG8V",
      season: REPAIR_MIGRATION_SEASON,
      version: 1,
      createdAt: new Date("2026-06-16T19:28:31.675Z"),
      eventInstanceId: "legacy:2026-06:#2CCUGYG8V",
      currentEventInstanceId: "cmqkolyfb011py01743rhinex",
    },
    {
      id: "cmqhcy2yp05wr4ll0lesacl7k",
      clanTag: "#2CGG9GGRV",
      season: REPAIR_MIGRATION_SEASON,
      version: 4,
      createdAt: new Date("2026-06-17T00:53:41.376Z"),
      eventInstanceId: "legacy:2026-06:#2CGG9GGRV",
      currentEventInstanceId: "cmqkolfu100xty017110lj7yu",
    },
    {
      id: "cmqh1edsu0grcgxndx3zp8kux",
      clanTag: "#2CLVCCG2R",
      season: REPAIR_MIGRATION_SEASON,
      version: 1,
      createdAt: new Date("2026-06-16T19:30:26.527Z"),
      eventInstanceId: "legacy:2026-06:#2CLVCCG2R",
      currentEventInstanceId: "cmqkom0j1012hy0178cj40kw5",
    },
    {
      id: "cmqhjzn3f05i5tr406yddz1pc",
      clanTag: "#2CPLCLRQL",
      season: REPAIR_MIGRATION_SEASON,
      version: 4,
      createdAt: new Date("2026-06-17T04:10:51.435Z"),
      eventInstanceId: "legacy:2026-06:#2CPLCLRQL",
      currentEventInstanceId: "cmqkol87800w9y0174mi8rtut",
    },
    {
      id: "cmqh1mnc80hp3gxndzusw87l7",
      clanTag: "#2CY29QRGU",
      season: REPAIR_MIGRATION_SEASON,
      version: 1,
      createdAt: new Date("2026-06-16T19:36:52.136Z"),
      eventInstanceId: "legacy:2026-06:#2CY29QRGU",
      currentEventInstanceId: "cmqkomfjm015ly017l1oinli3",
    },
    {
      id: "cmqh1knmq0hp1gxndp5vkx52a",
      clanTag: "#2CYGCCGVC",
      season: REPAIR_MIGRATION_SEASON,
      version: 1,
      createdAt: new Date("2026-06-16T19:35:19.203Z"),
      eventInstanceId: "legacy:2026-06:#2CYGCCGVC",
      currentEventInstanceId: "cmqkom5400139y017ytj05qeo",
    },
    {
      id: "cmqhatho700024ll0y3yojyfq",
      clanTag: "#2RJC2UCC2",
      season: REPAIR_MIGRATION_SEASON,
      version: 3,
      createdAt: new Date("2026-06-16T23:54:07.927Z"),
      eventInstanceId: "legacy:2026-06:#2RJC2UCC2",
      currentEventInstanceId: "cmqkolvge010xy017nesp9vtk",
    },
    {
      id: "cmqh1999g0fp7gxndssslydqs",
      clanTag: "#2RQCVGGVL",
      season: REPAIR_MIGRATION_SEASON,
      version: 1,
      createdAt: new Date("2026-06-16T19:26:27.364Z"),
      eventInstanceId: "legacy:2026-06:#2RQCVGGVL",
      currentEventInstanceId: "cmqkom8wg0141y017adcxnjrw",
    },
    {
      id: "cmqharu4r00xjbarui311v5xf",
      clanTag: "#2RVP0J80G",
      season: REPAIR_MIGRATION_SEASON,
      version: 3,
      createdAt: new Date("2026-06-16T23:52:50.759Z"),
      eventInstanceId: "legacy:2026-06:#2RVP0J80G",
      currentEventInstanceId: "cmqkolbyb00x1y0179ojj2k2v",
    },
    {
      id: "cmqhcv98s05114ll07y06cy7o",
      clanTag: "#2U0JGVC8Y",
      season: REPAIR_MIGRATION_SEASON,
      version: 1,
      createdAt: new Date("2026-06-17T00:51:29.548Z"),
      eventInstanceId: "legacy:2026-06:#2U0JGVC8Y",
      currentEventInstanceId: "cmqkomaz0014ty017fcrmdp3t",
    },
  ];

  const historical: RepairMigrationFixtureRow[] = [
    {
      id: "cmpwp02y100zprofmk6f0y82i",
      clanTag: "#2CCJVQ0YC",
      season: REPAIR_MIGRATION_SEASON,
      version: 3,
      createdAt: new Date("2026-06-02T13:48:00.361Z"),
      eventInstanceId: "legacy:2026-06:#2CCJVQ0YC",
      currentEventInstanceId: "cmqkolhist0001newerplan0",
    },
    {
      id: "cmpwp0qa60109rofm41zh7ile",
      clanTag: "#2C80JCVJQ",
      season: REPAIR_MIGRATION_SEASON,
      version: 3,
      createdAt: new Date("2026-06-02T13:48:30.606Z"),
      eventInstanceId: "legacy:2026-06:#2C80JCVJQ",
      currentEventInstanceId: "legacy:2026-06:#2C80JCVJQ",
    },
    {
      id: "cmpwp8eiy0134rofm73zlji3x",
      clanTag: "#2RJC2V2RV",
      season: REPAIR_MIGRATION_SEASON,
      version: 2,
      createdAt: new Date("2026-06-02T13:54:28.618Z"),
      eventInstanceId: "legacy:2026-06:#2RJC2V2RV",
      currentEventInstanceId: "legacy:2026-06:#2RJC2V2RV",
    },
    {
      id: "cmpwoyal60052rofmz7iwbr6p",
      clanTag: "#2RP2G8QCG",
      season: REPAIR_MIGRATION_SEASON,
      version: 2,
      createdAt: new Date("2026-06-02T13:46:36.954Z"),
      eventInstanceId: "legacy:2026-06:#2RP2G8QCG",
      currentEventInstanceId: "legacy:2026-06:#2RP2G8QCG",
    },
  ];

  const unrelatedSeason: RepairMigrationFixtureRow[] = [
    {
      id: "plan-unrelated-season",
      clanTag: "#9GLGQCCU",
      season: "2026-05",
      version: 1,
      createdAt: new Date("2026-05-10T00:00:00.000Z"),
      eventInstanceId: "legacy:2026-05:#9GLGQCCU",
      currentEventInstanceId: "legacy:2026-05:#9GLGQCCU",
    },
  ];

  const unrelatedClan: RepairMigrationFixtureRow[] = [
    {
      id: "plan-unrelated-clan",
      clanTag: "#1UNRELATED",
      season: REPAIR_MIGRATION_SEASON,
      version: 2,
      createdAt: new Date("2026-06-11T00:00:00.000Z"),
      eventInstanceId: "legacy:2026-06:#1UNRELATED",
      currentEventInstanceId: "legacy:2026-06:#1UNRELATED",
    },
  ];

  return { affected, historical, unrelatedSeason, unrelatedClan };
}

function formatSqlValue(value: string | number | boolean | Date | null): string {
  if (value === null) return "NULL";
  if (value instanceof Date) {
    return sqlTimestamp(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  return sqlText(value);
}

function buildInsertStatement<T extends Record<string, string | number | boolean | Date | null>>(
  tableName: string,
  columns: Array<keyof T & string>,
  rows: T[],
): string {
  const columnSql = columns.map((column) => `"${column}"`).join(", ");
  const valuesSql = rows
    .map((row) => `(${columns.map((column) => formatSqlValue(row[column] ?? null)).join(", ")})`)
    .join(",\n  ");
  return `INSERT INTO "${tableName}" (${columnSql}) VALUES\n  ${valuesSql};`;
}

function buildRepairMigrationSchemaSql(): string {
  return [
    'CREATE TABLE "CwlEventInstance" (',
    '  id text PRIMARY KEY,',
    '  season text NOT NULL,',
    '  "firstObservedAt" timestamp(3) NOT NULL,',
    '  "lastObservedAt" timestamp(3) NOT NULL',
    ");",
    'CREATE TABLE "CwlEventClan" (',
    '  "clanTag" text NOT NULL,',
    '  "eventInstanceId" text NOT NULL,',
    '  "isCurrent" boolean NOT NULL,',
    '  "firstObservedAt" timestamp(3) NOT NULL,',
    '  "lastObservedAt" timestamp(3) NOT NULL',
    ");",
    'CREATE TABLE "CwlRotationPlan" (',
    '  id text PRIMARY KEY,',
    '  "clanTag" text NOT NULL,',
    '  season text NOT NULL,',
    '  version integer NOT NULL,',
    '  "createdAt" timestamp(3) NOT NULL,',
    '  "updatedAt" timestamp(3) NOT NULL,',
    '  "eventInstanceId" text NOT NULL,',
    '  "isActive" boolean NOT NULL',
    ");",
  ].join("\n");
}

function buildRepairMigrationSeedSql(input: {
  events: TempRepairEventInstanceRow[];
  eventClans: TempRepairEventClanRow[];
  plans: TempRepairPlanRow[];
}): string {
  return [
    buildInsertStatement("CwlEventInstance", ["id", "season", "firstObservedAt", "lastObservedAt"], input.events),
    buildInsertStatement(
      "CwlEventClan",
      ["clanTag", "eventInstanceId", "isCurrent", "firstObservedAt", "lastObservedAt"],
      input.eventClans,
    ),
    buildInsertStatement(
      "CwlRotationPlan",
      ["id", "clanTag", "season", "version", "createdAt", "updatedAt", "eventInstanceId", "isActive"],
      input.plans,
    ),
  ].join("\n\n");
}

function buildRepairMigrationPlanStateSql(): string {
  return [
    'SELECT id, "eventInstanceId"',
    'FROM "CwlRotationPlan"',
    'ORDER BY id;',
  ].join("\n");
}

function selectHistoricalEvent(
  planCreatedAt: Date,
  events: Array<HistoricalEventFixture & { season: string }>,
): HistoricalEventFixture & { season: string } {
  const ranked = [...events].sort((left, right) => {
    const leftBefore = left.firstObservedAt.getTime() <= planCreatedAt.getTime() ? 0 : 1;
    const rightBefore = right.firstObservedAt.getTime() <= planCreatedAt.getTime() ? 0 : 1;
    if (leftBefore !== rightBefore) return leftBefore - rightBefore;
    if (leftBefore === 0) {
      const byObserved = right.firstObservedAt.getTime() - left.firstObservedAt.getTime();
      if (byObserved !== 0) return byObserved;
      const byLastObserved = right.lastObservedAt.getTime() - left.lastObservedAt.getTime();
      if (byLastObserved !== 0) return byLastObserved;
    } else {
      const byObserved = left.firstObservedAt.getTime() - right.firstObservedAt.getTime();
      if (byObserved !== 0) return byObserved;
      const byLastObserved = left.lastObservedAt.getTime() - right.lastObservedAt.getTime();
      if (byLastObserved !== 0) return byLastObserved;
    }
    const bySeason = right.season.localeCompare(left.season);
    if (bySeason !== 0) return bySeason;
    return right.id.localeCompare(left.id);
  });
  return ranked[0]!;
}

function selectSyntheticCurrentOrphan(
  groups: OrphanPlanFixture[],
  currentPointerClanTags: Set<string>,
): OrphanPlanFixture | null {
  const groupedByClan = new Map<string, OrphanPlanFixture[]>();
  for (const group of groups) {
    const existing = groupedByClan.get(group.clanTag) ?? [];
    existing.push(group);
    groupedByClan.set(group.clanTag, existing);
  }

  const candidates: OrphanPlanFixture[] = [];
  for (const [clanTag, clanGroups] of groupedByClan.entries()) {
    if (currentPointerClanTags.has(clanTag)) {
      continue;
    }
    const ranked = [...clanGroups].sort((left, right) => {
      const byLastUpdated = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (byLastUpdated !== 0) return byLastUpdated;
      const byFirstCreated = right.createdAt.getTime() - left.createdAt.getTime();
      if (byFirstCreated !== 0) return byFirstCreated;
      const bySeason = right.season.localeCompare(left.season);
      if (bySeason !== 0) return bySeason;
      return right.eventInstanceId.localeCompare(left.eventInstanceId);
    });
    candidates.push(ranked[0]!);
  }
  return candidates[0] ?? null;
}

function repairDuplicateActivePlans(rows: ActivePlanFixture[]): ActivePlanFixture[] {
  const ranked = new Map<string, ActivePlanFixture[]>();
  for (const row of rows.filter((entry) => entry.isActive)) {
    const key = `${row.eventInstanceId}:${row.clanTag}`;
    const existing = ranked.get(key) ?? [];
    existing.push(row);
    ranked.set(key, existing);
  }

  const kept = [...rows.filter((row) => !row.isActive)];
  for (const group of ranked.values()) {
    const winner = [...group].sort((left, right) => {
      if (left.version !== right.version) return right.version - left.version;
      const byUpdatedAt = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (byUpdatedAt !== 0) return byUpdatedAt;
      return right.id.localeCompare(left.id);
    })[0]!;
    kept.push(winner);
  }
  return kept;
}

describe("CWL event instance migration", () => {
  it("backfills one current clan pointer per clan and enforces a partial unique current index", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");

    expect(migration).toContain('ROW_NUMBER() OVER (');
    expect(migration).toContain('PARTITION BY "clanTag"');
    expect(migration).toContain('ORDER BY "lastObservedAt" DESC, "season" DESC, "eventInstanceId" DESC');
    expect(migration).toContain('"currentRank" = 1 AS "isCurrent"');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlEventClan_current_clan_key"');
    expect(migration).toContain('WHERE "isCurrent" = true;');
  });
});

describe("CWL rotation event-scope migration", () => {
  it("assigns historical plans before materializing orphan groups", () => {
    const statements = loadMigrationStatements();
    const historicalUpdateIndex = findStatementIndex(statements, 'WITH ranked_candidates AS (');
    const tempTableIndex = findStatementIndex(statements, 'CREATE TEMP TABLE "_CwlRotationOrphanGroup" AS');
    const eventInstanceInsertIndex = findStatementIndex(statements, 'INSERT INTO "CwlEventInstance"');
    const eventClanInsertIndex = findStatementIndex(statements, 'INSERT INTO "CwlEventClan"');
    const orphanPlanUpdateIndex = findStatementIndex(statements, 'SET "eventInstanceId" = orphan."eventInstanceId"');
    const tempTableDropIndex = findStatementIndex(statements, 'DROP TABLE "_CwlRotationOrphanGroup"');
    const rankedActiveIndex = findStatementIndex(statements, 'WITH ranked_active AS (');

    expect(historicalUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(tempTableIndex).toBeGreaterThan(historicalUpdateIndex);
    expect(eventInstanceInsertIndex).toBeGreaterThan(tempTableIndex);
    expect(eventClanInsertIndex).toBeGreaterThan(eventInstanceInsertIndex);
    expect(orphanPlanUpdateIndex).toBeGreaterThan(eventClanInsertIndex);
    expect(tempTableDropIndex).toBeGreaterThan(orphanPlanUpdateIndex);
    expect(rankedActiveIndex).toBeGreaterThan(tempTableDropIndex);

    const tempTableStatement = statements[tempTableIndex]!;
    expectOrphanTempTableStructure(tempTableStatement);
    expectNoLaterStatementReferences(statements, tempTableIndex, 'orphan_groups');
    expectNoLaterStatementReferences(statements, tempTableIndex, 'ranked_orphans');

    const laterStatements = statements.slice(tempTableIndex + 1);
    const tempReferences = laterStatements.filter((statement) => statement.includes('_CwlRotationOrphanGroup'));
    expect(tempReferences.length).toBeGreaterThan(0);
    expect(tempReferences.every((statement) => !statement.includes('orphan_groups'))).toBe(true);
    expect(tempReferences.every((statement) => !statement.includes('ranked_orphans'))).toBe(true);
    expect(tempReferences.every((statement) => !statement.includes('ON COMMIT DROP'))).toBe(true);

    const historicalStatement = statements[historicalUpdateIndex]!;
    expect(historicalStatement).toContain('clan."firstObservedAt" <= plan."createdAt"');
    expect(historicalStatement).toContain('CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN 0 ELSE 1 END ASC');
    expect(historicalStatement).toContain('CASE WHEN clan."firstObservedAt" <= plan."createdAt" THEN clan."firstObservedAt" END DESC');
    expect(historicalStatement).toContain('CASE WHEN clan."firstObservedAt" > plan."createdAt" THEN clan."firstObservedAt" END ASC');
  });

  it("materializes only still-null plans into the orphan table and keeps the temp table local", () => {
    const migration = loadMigration();
    const statements = loadMigrationStatements();
    const tempTableIndex = findStatementIndex(statements, 'CREATE TEMP TABLE "_CwlRotationOrphanGroup" AS');
    const tempTableDropIndex = findStatementIndex(statements, 'DROP TABLE "_CwlRotationOrphanGroup"');
    const tempTableStatement = statements[tempTableIndex]!;

    expect(migration).toContain('CREATE TEMP TABLE "_CwlRotationOrphanGroup" AS');
    expect(tempTableStatement).toContain('WHERE plan."eventInstanceId" IS NULL');
    expect(tempTableStatement).toContain('orphan_groups AS (');
    expect(tempTableStatement).toContain('ranked_orphans AS (');
    expect(tempTableStatement).not.toContain('ON COMMIT DROP');
    expectNoLaterStatementReferences(statements, tempTableIndex, 'orphan_groups');
    expectNoLaterStatementReferences(statements, tempTableIndex, 'ranked_orphans');
    expect(tempTableDropIndex).toBeGreaterThan(tempTableIndex);
    expectNoLaterStatementReferences(statements, tempTableDropIndex, '_CwlRotationOrphanGroup');

    const orphanPlanMaterializationIndex = findStatementIndex(
      statements,
      'SET "eventInstanceId" = orphan."eventInstanceId"',
    );
    expect(orphanPlanMaterializationIndex).toBeGreaterThan(tempTableIndex);
    expect(orphanPlanMaterializationIndex).toBeLessThan(tempTableDropIndex);
  });

  it("nominates at most one orphan event as current per clan and leaves existing pointers alone", () => {
    const statements = loadMigrationStatements();
    const clanInsertIndex = findStatementIndex(statements, 'INSERT INTO "CwlEventClan"');
    const clanInsertStatement = statements[clanInsertIndex]!;

    expectSyntheticCurrentStructure(clanInsertStatement);

    const orphanGroups: OrphanPlanFixture[] = [
      {
        season: "2026-05",
        clanTag: "#2QG2C08UP",
        eventInstanceId: "legacy-rotation:2026-05:#2QG2C08UP",
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        updatedAt: new Date("2026-05-02T00:00:00.000Z"),
      },
      {
        season: "2026-06",
        clanTag: "#2QG2C08UP",
        eventInstanceId: "legacy-rotation:2026-06:#2QG2C08UP",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-05T00:00:00.000Z"),
      },
    ];
    const syntheticCurrent = selectSyntheticCurrentOrphan(orphanGroups, new Set());
    expect(syntheticCurrent).toEqual(
      expect.objectContaining({
        season: "2026-06",
        clanTag: "#2QG2C08UP",
      }),
    );

    const existingCurrentSynthetic = selectSyntheticCurrentOrphan(orphanGroups, new Set(["#2QG2C08UP"]));
    expect(existingCurrentSynthetic).toBeNull();
  });

  it("attaches a historical plan to the earliest eligible event and keeps tie-breakers deterministic", () => {
    const planCreatedAt = new Date("2026-06-05T00:00:00.000Z");
    const selectedPastEvent = selectHistoricalEvent(planCreatedAt, [
      {
        id: "event-a",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        id: "event-b",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-01T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
      {
        id: "event-c",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-15T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-15T00:00:00.000Z"),
      },
    ]);
    const selectedFutureEvent = selectHistoricalEvent(new Date("2026-05-01T00:00:00.000Z"), [
      {
        id: "event-d",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-10T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-10T00:00:00.000Z"),
      },
      {
        id: "event-e",
        season: "2026-06",
        firstObservedAt: new Date("2026-06-20T00:00:00.000Z"),
        lastObservedAt: new Date("2026-06-20T00:00:00.000Z"),
      },
    ]);

    expect(selectedPastEvent.id).toBe("event-b");
    expect(selectedFutureEvent.id).toBe("event-d");
  });

  it("repairs duplicate active plans and enforces event-scoped uniqueness", () => {
    const migration = loadMigration();

    expect(migration).toContain('PARTITION BY "eventInstanceId", "clanTag"');
    expect(migration).toContain('ORDER BY "version" DESC, "updatedAt" DESC, "id" DESC');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlRotationPlan_eventInstanceId_clanTag_version_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "CwlRotationPlan_active_event_clan_key"');
    expect(migration).toContain('WHERE "isActive" = true;');
    expect(migration).toContain('FOREIGN KEY ("eventInstanceId", "clanTag") REFERENCES "CwlEventClan"("eventInstanceId", "clanTag")');

    const repaired = repairDuplicateActivePlans([
      {
        id: "plan-a-v1",
        eventInstanceId: "event-a",
        clanTag: "#2QG2C08UP",
        version: 1,
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        isActive: true,
      },
      {
        id: "plan-a-v2-newer",
        eventInstanceId: "event-a",
        clanTag: "#2QG2C08UP",
        version: 2,
        updatedAt: new Date("2026-06-02T00:00:00.000Z"),
        isActive: true,
      },
      {
        id: "plan-a-v2-older",
        eventInstanceId: "event-a",
        clanTag: "#2QG2C08UP",
        version: 2,
        updatedAt: new Date("2026-06-01T12:00:00.000Z"),
        isActive: true,
      },
      {
        id: "plan-b-v1",
        eventInstanceId: "event-b",
        clanTag: "#2QG2C08UP",
        version: 1,
        updatedAt: new Date("2026-06-03T00:00:00.000Z"),
        isActive: true,
      },
    ]);

    expect(repaired.map((row) => row.id)).toEqual(["plan-a-v2-newer", "plan-b-v1"]);
    expect(repaired).toHaveLength(2);
  });

  it("chooses only one synthetic current pointer when multiple orphan seasons exist for one clan", () => {
    const migration = loadMigration();
    const statements = loadMigrationStatements();
    const clanInsertIndex = findStatementIndex(statements, 'INSERT INTO "CwlEventClan"');

    expectOrphanTempTableStructure(migration);

    const orphanGroups: OrphanPlanFixture[] = [
      {
        season: "2026-05",
        clanTag: "#9GLGQCCU",
        eventInstanceId: "legacy-rotation:2026-05:#9GLGQCCU",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        updatedAt: new Date("2026-05-04T00:00:00.000Z"),
      },
      {
        season: "2026-06",
        clanTag: "#9GLGQCCU",
        eventInstanceId: "legacy-rotation:2026-06:#9GLGQCCU",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-05T00:00:00.000Z"),
      },
    ];

    const current = selectSyntheticCurrentOrphan(orphanGroups, new Set());
    expect(current).toEqual(
      expect.objectContaining({
        season: "2026-06",
        clanTag: "#9GLGQCCU",
      }),
    );

    const dropIndex = findStatementIndex(statements, 'DROP TABLE "_CwlRotationOrphanGroup"');
    const rankedActiveIndex = findStatementIndex(statements, 'WITH ranked_active AS (');
    expect(dropIndex).toBeGreaterThan(clanInsertIndex);
    expect(rankedActiveIndex).toBeGreaterThan(dropIndex);
    expectNoLaterStatementReferences(statements, dropIndex, '_CwlRotationOrphanGroup');
  });

  it("repairs only the explicit prod-confirmed rows and stays idempotent in PostgreSQL", async () => {
    const migration = readFileSync(REPAIR_ROTATION_MIGRATION_PATH, "utf8");
    expect(migration).toContain('incident_season AS (');
    expect(migration).toContain('explicit_repair_candidates AS (');
    expect(migration).toContain('plan."createdAt" = candidate."createdAt"');
    expect(migration).toContain("TIMESTAMP(3) '2026-06-17 03:39:25.684'");
    expect(migration).not.toContain('TIMESTAMPTZ');
    expect(migration).toContain('source_event."isCurrent" = false');
    expect(migration).toContain('current_plan."isActive" = true');
    expect(migration).toContain('current_version.version = plan.version');
    expect(migration).toContain('SET "eventInstanceId" = eligible_candidates."currentEventInstanceId"');
    expect(migration).not.toContain('now()');
    expect(migration).not.toContain('CURRENT_DATE');

    const diagnosed = buildDiagnosedRepairRows();
    const seed = buildRepairMigrationSeed([
      ...diagnosed.affected,
      ...diagnosed.historical,
      ...diagnosed.unrelatedSeason,
      ...diagnosed.unrelatedClan,
    ]);

    await withTemporaryPostgres(async ({ runSql }) => {
      runSql(buildRepairMigrationSchemaSql());
      runSql(buildRepairMigrationSeedSql(seed));

      runSql(migration);
      const repairedRows = parseTabSeparatedRows(runSql(buildRepairMigrationPlanStateSql()));
      const repairedById = new Map(repairedRows.map(([id, eventInstanceId]) => [id, eventInstanceId]));

      for (const row of diagnosed.affected) {
        expect(repairedById.get(row.id)).toBe(row.currentEventInstanceId);
      }
      for (const row of diagnosed.historical) {
        expect(repairedById.get(row.id)).toBe(row.eventInstanceId);
      }
      expect(
        repairedRows.some(([, eventInstanceId]) => eventInstanceId === diagnosed.historical[0]!.currentEventInstanceId),
      ).toBe(false);
      for (const row of diagnosed.unrelatedSeason) {
        expect(repairedById.get(row.id)).toBe(row.eventInstanceId);
      }
      for (const row of diagnosed.unrelatedClan) {
        expect(repairedById.get(row.id)).toBe(row.eventInstanceId);
      }

      runSql(migration);
      const rerunRows = parseTabSeparatedRows(runSql(buildRepairMigrationPlanStateSql()));
      expect(rerunRows).toEqual(repairedRows);
    }, "America/Los_Angeles");
  }, 60000);

  it("skips repair when a current-event active plan already exists", async () => {
    const candidate = buildDiagnosedRepairRows().affected[0]!;
    const seed = buildRepairMigrationSeed([
      candidate,
      {
        id: "plan-current-guard",
        clanTag: candidate.clanTag,
        season: candidate.season,
        version: candidate.version + 1,
        createdAt: new Date("2026-06-19T10:00:00.000Z"),
        eventInstanceId: candidate.currentEventInstanceId,
        currentEventInstanceId: candidate.currentEventInstanceId,
      },
    ]);

    await withTemporaryPostgres(async ({ runSql }) => {
      runSql(buildRepairMigrationSchemaSql());
      runSql(buildRepairMigrationSeedSql(seed));
      runSql(readFileSync(REPAIR_ROTATION_MIGRATION_PATH, "utf8"));

      const rows = parseTabSeparatedRows(runSql(buildRepairMigrationPlanStateSql()));
      const byId = new Map(rows.map(([id, eventInstanceId]) => [id, eventInstanceId]));
      expect(byId.get(candidate.id)).toBe(candidate.eventInstanceId);
      expect(byId.get("plan-current-guard")).toBe(candidate.currentEventInstanceId);
    });
  }, 60000);

  it("skips repair when the source event ID or current pointer changes", async () => {
    const candidate = buildDiagnosedRepairRows().affected[1]!;

    await withTemporaryPostgres(async ({ runSql }) => {
      runSql(buildRepairMigrationSchemaSql());
      const seed = buildRepairMigrationSeed([
        {
          ...candidate,
          eventInstanceId: "legacy:2026-06:#2C998J8LY-drifted",
        },
      ]);
      runSql(buildRepairMigrationSeedSql(seed));
      runSql(readFileSync(REPAIR_ROTATION_MIGRATION_PATH, "utf8"));
      const rows = parseTabSeparatedRows(runSql(buildRepairMigrationPlanStateSql()));
      expect(new Map(rows.map(([id, eventInstanceId]) => [id, eventInstanceId])).get(candidate.id)).toBe(
        "legacy:2026-06:#2C998J8LY-drifted",
      );
    });

    await withTemporaryPostgres(async ({ runSql }) => {
      runSql(buildRepairMigrationSchemaSql());
      const seed = buildRepairMigrationSeed([
        {
          ...candidate,
          currentEventInstanceId: "cmqkolpxc0105y017ee11ejb1-drifted",
        },
      ]);
      runSql(buildRepairMigrationSeedSql(seed));
      runSql(readFileSync(REPAIR_ROTATION_MIGRATION_PATH, "utf8"));
      const rows = parseTabSeparatedRows(runSql(buildRepairMigrationPlanStateSql()));
      expect(new Map(rows.map(([id, eventInstanceId]) => [id, eventInstanceId])).get(candidate.id)).toBe(
        candidate.eventInstanceId,
      );
    });
  }, 30000);

  it("skips repair when the target event has a version collision", async () => {
    const candidate = buildDiagnosedRepairRows().affected[2]!;
    const seed = buildRepairMigrationSeed([
      candidate,
      {
        id: "plan-version-collision",
        clanTag: candidate.clanTag,
        season: candidate.season,
        version: candidate.version,
        createdAt: new Date("2026-06-19T10:00:00.000Z"),
        eventInstanceId: candidate.currentEventInstanceId,
        currentEventInstanceId: candidate.currentEventInstanceId,
      },
    ]);

    await withTemporaryPostgres(async ({ runSql }) => {
      runSql(buildRepairMigrationSchemaSql());
      runSql(buildRepairMigrationSeedSql(seed));
      runSql(readFileSync(REPAIR_ROTATION_MIGRATION_PATH, "utf8"));

      const rows = parseTabSeparatedRows(runSql(buildRepairMigrationPlanStateSql()));
      const byId = new Map(rows.map(([id, eventInstanceId]) => [id, eventInstanceId]));
      expect(byId.get(candidate.id)).toBe(candidate.eventInstanceId);
      expect(byId.get("plan-version-collision")).toBe(candidate.currentEventInstanceId);
    });
  }, 30000);
});
