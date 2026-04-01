import {
  PrismaClient,
  type ClanPointsSync,
  type ClanWarHistory,
  type ClanWarParticipation,
  type CurrentWar,
  type TrackedClan,
  type WarAttacks,
  type WarLookup,
} from "@prisma/client";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  isMirrorPollingMode,
  resolveDatabaseNameFromUrlForLog,
  resolvePollingMode,
  resolveRuntimeEnvironment,
} from "./PollingModeService";

export const MIRRORED_RUNTIME_TABLES = [
  "TrackedClan",
  "CurrentWar",
  "WarAttacks",
  "ClanPointsSync",
  "ClanWarHistory",
  "ClanWarParticipation",
  "WarLookup",
] as const;

type MirrorTableName = (typeof MIRRORED_RUNTIME_TABLES)[number];
type MirrorSyncTrigger = "scheduled" | "manual";

type MirrorSyncLogger = Pick<Console, "info" | "warn" | "error">;

type MirrorSyncColumnRow = {
  column_name: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

type MirrorSyncTableSummary = {
  table: MirrorTableName;
  sourceRows: number;
  deletedRows: number;
  insertedRows: number;
};

type MirrorSyncResult = {
  trigger: MirrorSyncTrigger;
  sourceDatabase: string;
  targetDatabase: string;
  durationMs: number;
  tableSummaries: MirrorSyncTableSummary[];
};

type DeleteManyResult = { count: number };
type CreateManyResult = { count: number };

type MirrorSyncSourceClient = {
  trackedClan: { findMany: (args?: unknown) => Promise<TrackedClan[]> };
  currentWar: { findMany: (args?: unknown) => Promise<CurrentWar[]> };
  warAttacks: { findMany: (args?: unknown) => Promise<WarAttacks[]> };
  clanPointsSync: { findMany: (args?: unknown) => Promise<ClanPointsSync[]> };
  clanWarHistory: { findMany: (args?: unknown) => Promise<ClanWarHistory[]> };
  clanWarParticipation: {
    findMany: (args?: unknown) => Promise<ClanWarParticipation[]>;
  };
  warLookup: { findMany: (args?: unknown) => Promise<WarLookup[]> };
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  $disconnect?: () => Promise<void>;
};

type MirrorSyncTargetClient = {
  trackedClan: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: TrackedClan[] }) => Promise<CreateManyResult>;
  };
  currentWar: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CurrentWar[] }) => Promise<CreateManyResult>;
  };
  warAttacks: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: WarAttacks[] }) => Promise<CreateManyResult>;
  };
  clanPointsSync: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: ClanPointsSync[] }) => Promise<CreateManyResult>;
  };
  clanWarHistory: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: ClanWarHistory[] }) => Promise<CreateManyResult>;
  };
  clanWarParticipation: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: ClanWarParticipation[] }) => Promise<CreateManyResult>;
  };
  warLookup: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: WarLookup[] }) => Promise<CreateManyResult>;
  };
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $transaction: <T>(
    fn: (tx: MirrorSyncTargetClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ) => Promise<T>;
};

type MirrorSyncServiceOptions = {
  env?: NodeJS.ProcessEnv;
  logger?: MirrorSyncLogger;
  targetClient?: MirrorSyncTargetClient;
  createSourceClient?: (
    sourceDatabaseUrl: string,
  ) => MirrorSyncSourceClient | Promise<MirrorSyncSourceClient>;
  disconnectSourceClient?: boolean;
};

type SyncSafetyContext = {
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  sourceDatabaseName: string;
  targetDatabaseName: string;
};

function resolvePositiveInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeConnectionUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

function chunkRows<T>(rows: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    chunks.push(rows.slice(index, index + batchSize));
  }
  return chunks;
}

/** Purpose: sync a fixed runtime-table allowlist from prod(source) to staging(target) with full overwrite semantics. */
export class MirrorSyncService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: MirrorSyncLogger;
  private readonly targetClient: MirrorSyncTargetClient;
  private readonly createSourceClient: (
    sourceDatabaseUrl: string,
  ) => MirrorSyncSourceClient | Promise<MirrorSyncSourceClient>;
  private readonly disconnectSourceClient: boolean;
  private readonly batchSize: number;
  private readonly transactionMaxWaitMs: number;
  private readonly transactionTimeoutMs: number;

  constructor(options: MirrorSyncServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.logger = options.logger ?? console;
    this.targetClient =
      options.targetClient ?? (prisma as unknown as MirrorSyncTargetClient);
    this.createSourceClient =
      options.createSourceClient ??
      ((sourceDatabaseUrl) =>
        new PrismaClient({
          datasources: { db: { url: sourceDatabaseUrl } },
        }) as unknown as MirrorSyncSourceClient);
    this.disconnectSourceClient = options.disconnectSourceClient ?? true;
    this.batchSize = resolvePositiveInt(this.env.MIRROR_SYNC_BATCH_SIZE, 500);
    this.transactionMaxWaitMs = resolvePositiveInt(
      this.env.MIRROR_SYNC_TRANSACTION_MAX_WAIT_MS,
      30_000,
    );
    this.transactionTimeoutMs = resolvePositiveInt(
      this.env.MIRROR_SYNC_TRANSACTION_TIMEOUT_MS,
      600_000,
    );
  }

  /** Purpose: run one full prod->staging mirror sync for allowlisted runtime tables. */
  async syncNow(trigger: MirrorSyncTrigger): Promise<MirrorSyncResult> {
    const startedAt = Date.now();
    const safety = this.resolveAndAssertSafety();
    this.logger.info(
      `[mirror-sync] event=${trigger}_started source_db=${safety.sourceDatabaseName} target_db=${safety.targetDatabaseName} tables=${MIRRORED_RUNTIME_TABLES.join(",")}`,
    );

    let sourceClient: MirrorSyncSourceClient | null = null;
    try {
      sourceClient = await this.createSourceClient(safety.sourceDatabaseUrl);
      await this.assertSchemaCompatibility(sourceClient);

      const sourceRows = await this.readAllSourceRows(sourceClient);
      const tableSummaries = await this.targetClient.$transaction(
        async (tx) => {
          const summaries: MirrorSyncTableSummary[] = [];
          for (const table of MIRRORED_RUNTIME_TABLES) {
            const summary = await this.replaceTableRows(
              tx,
              table,
              sourceRows[table],
            );
            summaries.push(summary);
          }
          await this.resetAutoIncrementSequences(tx);
          return summaries;
        },
        {
          maxWait: this.transactionMaxWaitMs,
          timeout: this.transactionTimeoutMs,
        },
      );

      const durationMs = Date.now() - startedAt;
      const summaryText = tableSummaries
        .map(
          (row) =>
            `${row.table}:src=${row.sourceRows},del=${row.deletedRows},ins=${row.insertedRows}`,
        )
        .join("|");
      this.logger.info(
        `[mirror-sync] event=${trigger}_completed source_db=${safety.sourceDatabaseName} target_db=${safety.targetDatabaseName} duration_ms=${durationMs} summary=${summaryText}`,
      );
      return {
        trigger,
        sourceDatabase: safety.sourceDatabaseName,
        targetDatabase: safety.targetDatabaseName,
        durationMs,
        tableSummaries,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.logger.error(
        `[mirror-sync] event=${trigger}_failed duration_ms=${durationMs} reason=${formatError(error)}`,
      );
      throw error;
    } finally {
      if (sourceClient && this.disconnectSourceClient && sourceClient.$disconnect) {
        await sourceClient.$disconnect().catch(() => undefined);
      }
    }
  }

  private resolveAndAssertSafety(): SyncSafetyContext {
    const mode = resolvePollingMode(this.env);
    if (!isMirrorPollingMode(this.env)) {
      this.logger.warn(
        `[mirror-sync] event=safety_block reason=mode_not_mirror mode=${mode}`,
      );
      throw new Error("Mirror sync is only allowed when POLLING_MODE=mirror.");
    }

    const runtimeEnvironment = resolveRuntimeEnvironment(this.env);
    if (runtimeEnvironment === "prod") {
      this.logger.warn(
        `[mirror-sync] event=safety_block reason=runtime_env_prod mode=${mode}`,
      );
      throw new Error("Mirror sync is blocked in production runtime environment.");
    }

    const sourceDatabaseUrl = String(this.env.MIRROR_SOURCE_DATABASE_URL ?? "").trim();
    if (!sourceDatabaseUrl) {
      throw new Error("Missing MIRROR_SOURCE_DATABASE_URL for mirror sync.");
    }
    const targetDatabaseUrl = String(this.env.DATABASE_URL ?? "").trim();
    if (!targetDatabaseUrl) {
      throw new Error("Missing DATABASE_URL for mirror sync target.");
    }

    const normalizedSourceUrl = normalizeConnectionUrl(sourceDatabaseUrl);
    const normalizedTargetUrl = normalizeConnectionUrl(targetDatabaseUrl);
    if (normalizedSourceUrl === normalizedTargetUrl) {
      this.logger.warn(
        "[mirror-sync] event=safety_block reason=source_equals_target",
      );
      throw new Error("Mirror sync source and target database URLs must be different.");
    }

    const sourceDatabaseName = resolveDatabaseNameFromUrlForLog(sourceDatabaseUrl);
    const targetDatabaseName = resolveDatabaseNameFromUrlForLog(targetDatabaseUrl);
    const targetLooksNonProd = /(staging|stage|stg|test|dev)/i.test(targetDatabaseName);
    if (runtimeEnvironment === "unknown" && !targetLooksNonProd) {
      this.logger.warn(
        `[mirror-sync] event=safety_block reason=target_env_ambiguous target_db=${targetDatabaseName}`,
      );
      throw new Error(
        "Mirror sync target environment is ambiguous. Set POLLING_ENV=staging (or DEPLOY_ENV=staging) to proceed.",
      );
    }

    return {
      sourceDatabaseUrl,
      targetDatabaseUrl,
      sourceDatabaseName,
      targetDatabaseName,
    };
  }

  private async assertSchemaCompatibility(
    sourceClient: MirrorSyncSourceClient,
  ): Promise<void> {
    for (const table of MIRRORED_RUNTIME_TABLES) {
      const sourceColumns = await this.readTableColumns(sourceClient, table);
      const targetColumns = await this.readTableColumns(this.targetClient, table);

      if (sourceColumns.length <= 0 || targetColumns.length <= 0) {
        throw new Error(
          `Schema compatibility check failed for ${table}: table missing on source or target.`,
        );
      }

      const sourceByName = new Map(sourceColumns.map((column) => [column.column_name, column]));
      const targetByName = new Map(targetColumns.map((column) => [column.column_name, column]));

      for (const sourceColumn of sourceColumns) {
        const targetColumn = targetByName.get(sourceColumn.column_name);
        if (!targetColumn) {
          throw new Error(
            `Schema compatibility check failed for ${table}: target missing column ${sourceColumn.column_name}.`,
          );
        }
        if (targetColumn.udt_name !== sourceColumn.udt_name) {
          throw new Error(
            `Schema compatibility check failed for ${table}: column ${sourceColumn.column_name} type mismatch source=${sourceColumn.udt_name} target=${targetColumn.udt_name}.`,
          );
        }
      }

      const requiredTargetColumnsMissingFromSource = targetColumns.filter((column) => {
        if (sourceByName.has(column.column_name)) return false;
        const hasDefault = String(column.column_default ?? "").trim().length > 0;
        return column.is_nullable === "NO" && !hasDefault;
      });
      if (requiredTargetColumnsMissingFromSource.length > 0) {
        throw new Error(
          `Schema compatibility check failed for ${table}: source missing required target columns ${requiredTargetColumnsMissingFromSource
            .map((column) => column.column_name)
            .join(", ")}.`,
        );
      }
    }
  }

  private async readTableColumns(
    client: Pick<MirrorSyncSourceClient, "$queryRawUnsafe">,
    table: MirrorTableName,
  ): Promise<MirrorSyncColumnRow[]> {
    return client.$queryRawUnsafe<MirrorSyncColumnRow[]>(
      `
        SELECT
          column_name,
          udt_name,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      table,
    );
  }

  private async readAllSourceRows(sourceClient: MirrorSyncSourceClient): Promise<{
    TrackedClan: TrackedClan[];
    CurrentWar: CurrentWar[];
    WarAttacks: WarAttacks[];
    ClanPointsSync: ClanPointsSync[];
    ClanWarHistory: ClanWarHistory[];
    ClanWarParticipation: ClanWarParticipation[];
    WarLookup: WarLookup[];
  }> {
    return {
      TrackedClan: await sourceClient.trackedClan.findMany({
        orderBy: [{ id: "asc" }],
      }),
      CurrentWar: await sourceClient.currentWar.findMany({
        orderBy: [{ clanTag: "asc" }, { guildId: "asc" }],
      }),
      WarAttacks: await sourceClient.warAttacks.findMany({
        orderBy: [{ warId: "asc" }, { playerTag: "asc" }, { attackNumber: "asc" }],
      }),
      ClanPointsSync: await sourceClient.clanPointsSync.findMany({
        orderBy: [{ guildId: "asc" }, { clanTag: "asc" }, { warStartTime: "asc" }],
      }),
      ClanWarHistory: await sourceClient.clanWarHistory.findMany({
        orderBy: [{ warId: "asc" }],
      }),
      ClanWarParticipation: await sourceClient.clanWarParticipation.findMany({
        orderBy: [{ guildId: "asc" }, { warId: "asc" }, { playerTag: "asc" }],
      }),
      WarLookup: await sourceClient.warLookup.findMany({
        orderBy: [{ warId: "asc" }],
      }),
    };
  }

  private async replaceTableRows(
    tx: MirrorSyncTargetClient,
    table: MirrorTableName,
    rows:
      | TrackedClan[]
      | CurrentWar[]
      | WarAttacks[]
      | ClanPointsSync[]
      | ClanWarHistory[]
      | ClanWarParticipation[]
      | WarLookup[],
  ): Promise<MirrorSyncTableSummary> {
    if (table === "TrackedClan") {
      const deletedRows = (await tx.trackedClan.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as TrackedClan[], (batch) =>
        tx.trackedClan.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CurrentWar") {
      const deletedRows = (await tx.currentWar.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as CurrentWar[], (batch) =>
        tx.currentWar.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "WarAttacks") {
      const deletedRows = (await tx.warAttacks.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as WarAttacks[], (batch) =>
        tx.warAttacks.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "ClanPointsSync") {
      const deletedRows = (await tx.clanPointsSync.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as ClanPointsSync[], (batch) =>
        tx.clanPointsSync.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "ClanWarHistory") {
      const deletedRows = (await tx.clanWarHistory.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as ClanWarHistory[], (batch) =>
        tx.clanWarHistory.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "ClanWarParticipation") {
      const deletedRows = (await tx.clanWarParticipation.deleteMany()).count;
      const insertedRows = await this.insertBatches(
        rows as ClanWarParticipation[],
        (batch) => tx.clanWarParticipation.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    const deletedRows = (await tx.warLookup.deleteMany()).count;
    const insertedRows = await this.insertBatches(rows as WarLookup[], (batch) =>
      tx.warLookup.createMany({ data: batch }),
    );
    return { table, sourceRows: rows.length, deletedRows, insertedRows };
  }

  private async insertBatches<T>(
    rows: T[],
    writeBatch: (batch: T[]) => Promise<CreateManyResult>,
  ): Promise<number> {
    if (rows.length <= 0) return 0;
    let insertedRows = 0;
    for (const batch of chunkRows(rows, this.batchSize)) {
      const result = await writeBatch(batch);
      insertedRows += Number(result.count ?? 0);
    }
    return insertedRows;
  }

  private async resetAutoIncrementSequences(tx: MirrorSyncTargetClient): Promise<void> {
    await tx.$executeRawUnsafe(`
      SELECT setval(
        pg_get_serial_sequence('"TrackedClan"', 'id'),
        COALESCE((SELECT MAX("id") FROM "TrackedClan"), 1),
        COALESCE((SELECT MAX("id") FROM "TrackedClan"), 0) > 0
      );
    `);
    await tx.$executeRawUnsafe(`
      SELECT setval(
        pg_get_serial_sequence('"ClanWarHistory"', 'warId'),
        COALESCE((SELECT MAX("warId") FROM "ClanWarHistory"), 1),
        COALESCE((SELECT MAX("warId") FROM "ClanWarHistory"), 0) > 0
      );
    `);
  }
}

