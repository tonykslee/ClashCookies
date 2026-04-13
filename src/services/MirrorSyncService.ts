import {
  PrismaClient,
  type ClanPointsSync,
  type ClanWarHistory,
  type ClanWarParticipation,
  type CurrentCwlPrepSnapshot,
  type CurrentCwlRound,
  type CurrentWar,
  type CwlRotationPlan,
  type CwlRotationPlanDay,
  type CwlRotationPlanMember,
  type CwlRoundHistory,
  type CwlRoundMemberCurrent,
  type CwlRoundMemberHistory,
  type HeatMapRef,
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
  "CurrentCwlRound",
  "CurrentCwlPrepSnapshot",
  "CwlRoundMemberCurrent",
  "CwlRoundHistory",
  "CwlRoundMemberHistory",
  "CwlRotationPlan",
  "CwlRotationPlanDay",
  "CwlRotationPlanMember",
  "HeatMapRef",
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
  currentCwlRound: { findMany: (args?: unknown) => Promise<CurrentCwlRound[]> };
  currentCwlPrepSnapshot: { findMany: (args?: unknown) => Promise<CurrentCwlPrepSnapshot[]> };
  cwlRoundMemberCurrent: {
    findMany: (args?: unknown) => Promise<CwlRoundMemberCurrent[]>;
  };
  cwlRoundHistory: { findMany: (args?: unknown) => Promise<CwlRoundHistory[]> };
  cwlRoundMemberHistory: {
    findMany: (args?: unknown) => Promise<CwlRoundMemberHistory[]>;
  };
  cwlRotationPlan: { findMany: (args?: unknown) => Promise<CwlRotationPlan[]> };
  cwlRotationPlanDay: { findMany: (args?: unknown) => Promise<CwlRotationPlanDay[]> };
  cwlRotationPlanMember: {
    findMany: (args?: unknown) => Promise<CwlRotationPlanMember[]>;
  };
  heatMapRef: { findMany: (args?: unknown) => Promise<HeatMapRef[]> };
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
  currentCwlRound: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CurrentCwlRound[] }) => Promise<CreateManyResult>;
  };
  currentCwlPrepSnapshot: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CurrentCwlPrepSnapshot[] }) => Promise<CreateManyResult>;
  };
  cwlRoundMemberCurrent: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CwlRoundMemberCurrent[] }) => Promise<CreateManyResult>;
  };
  cwlRoundHistory: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CwlRoundHistory[] }) => Promise<CreateManyResult>;
  };
  cwlRoundMemberHistory: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CwlRoundMemberHistory[] }) => Promise<CreateManyResult>;
  };
  cwlRotationPlan: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CwlRotationPlan[] }) => Promise<CreateManyResult>;
  };
  cwlRotationPlanDay: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CwlRotationPlanDay[] }) => Promise<CreateManyResult>;
  };
  cwlRotationPlanMember: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: CwlRotationPlanMember[] }) => Promise<CreateManyResult>;
  };
  heatMapRef: {
    deleteMany: (args?: unknown) => Promise<DeleteManyResult>;
    createMany: (args: { data: HeatMapRef[] }) => Promise<CreateManyResult>;
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

type MirrorSyncSourceRows = {
  TrackedClan: TrackedClan[];
  CurrentWar: CurrentWar[];
  WarAttacks: WarAttacks[];
  ClanPointsSync: ClanPointsSync[];
  ClanWarHistory: ClanWarHistory[];
  ClanWarParticipation: ClanWarParticipation[];
  WarLookup: WarLookup[];
  CurrentCwlRound: CurrentCwlRound[];
  CurrentCwlPrepSnapshot: CurrentCwlPrepSnapshot[];
  CwlRoundMemberCurrent: CwlRoundMemberCurrent[];
  CwlRoundHistory: CwlRoundHistory[];
  CwlRoundMemberHistory: CwlRoundMemberHistory[];
  CwlRotationPlan: CwlRotationPlan[];
  CwlRotationPlanDay: CwlRotationPlanDay[];
  CwlRotationPlanMember: CwlRotationPlanMember[];
  HeatMapRef: HeatMapRef[];
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

  private async readAllSourceRows(
    sourceClient: MirrorSyncSourceClient,
  ): Promise<MirrorSyncSourceRows> {
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
      CurrentCwlRound: await sourceClient.currentCwlRound.findMany({
        orderBy: [{ season: "asc" }, { clanTag: "asc" }],
      }),
      CurrentCwlPrepSnapshot: await sourceClient.currentCwlPrepSnapshot.findMany({
        orderBy: [{ season: "asc" }, { clanTag: "asc" }],
      }),
      CwlRoundMemberCurrent: await sourceClient.cwlRoundMemberCurrent.findMany({
        orderBy: [{ season: "asc" }, { clanTag: "asc" }, { playerTag: "asc" }],
      }),
      CwlRoundHistory: await sourceClient.cwlRoundHistory.findMany({
        orderBy: [{ season: "asc" }, { clanTag: "asc" }, { roundDay: "asc" }],
      }),
      CwlRoundMemberHistory: await sourceClient.cwlRoundMemberHistory.findMany({
        orderBy: [
          { season: "asc" },
          { clanTag: "asc" },
          { roundDay: "asc" },
          { playerTag: "asc" },
        ],
      }),
      CwlRotationPlan: await sourceClient.cwlRotationPlan.findMany({
        orderBy: [{ season: "asc" }, { clanTag: "asc" }, { version: "asc" }],
      }),
      CwlRotationPlanDay: await sourceClient.cwlRotationPlanDay.findMany({
        orderBy: [{ id: "asc" }],
      }),
      CwlRotationPlanMember: await sourceClient.cwlRotationPlanMember.findMany({
        orderBy: [{ id: "asc" }],
      }),
      HeatMapRef: await sourceClient.heatMapRef.findMany({
        orderBy: [{ weightMinInclusive: "asc" }, { weightMaxInclusive: "asc" }],
      }),
    };
  }

  private async replaceTableRows(
    tx: MirrorSyncTargetClient,
    table: MirrorTableName,
    rows: readonly unknown[],
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

    if (table === "CurrentCwlRound") {
      const deletedRows = (await tx.currentCwlRound.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as CurrentCwlRound[], (batch) =>
        tx.currentCwlRound.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CurrentCwlPrepSnapshot") {
      const deletedRows = (await tx.currentCwlPrepSnapshot.deleteMany()).count;
      const insertedRows = await this.insertBatches(
        rows as CurrentCwlPrepSnapshot[],
        (batch) => tx.currentCwlPrepSnapshot.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CwlRoundMemberCurrent") {
      const deletedRows = (await tx.cwlRoundMemberCurrent.deleteMany()).count;
      const insertedRows = await this.insertBatches(
        rows as CwlRoundMemberCurrent[],
        (batch) => tx.cwlRoundMemberCurrent.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CwlRoundHistory") {
      const deletedRows = (await tx.cwlRoundHistory.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as CwlRoundHistory[], (batch) =>
        tx.cwlRoundHistory.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CwlRoundMemberHistory") {
      const deletedRows = (await tx.cwlRoundMemberHistory.deleteMany()).count;
      const insertedRows = await this.insertBatches(
        rows as CwlRoundMemberHistory[],
        (batch) => tx.cwlRoundMemberHistory.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CwlRotationPlan") {
      const deletedRows = (await tx.cwlRotationPlan.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as CwlRotationPlan[], (batch) =>
        tx.cwlRotationPlan.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CwlRotationPlanDay") {
      const deletedRows = (await tx.cwlRotationPlanDay.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as CwlRotationPlanDay[], (batch) =>
        tx.cwlRotationPlanDay.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "CwlRotationPlanMember") {
      const deletedRows = (await tx.cwlRotationPlanMember.deleteMany()).count;
      const insertedRows = await this.insertBatches(
        rows as CwlRotationPlanMember[],
        (batch) => tx.cwlRotationPlanMember.createMany({ data: batch }),
      );
      return { table, sourceRows: rows.length, deletedRows, insertedRows };
    }

    if (table === "HeatMapRef") {
      const deletedRows = (await tx.heatMapRef.deleteMany()).count;
      const insertedRows = await this.insertBatches(rows as HeatMapRef[], (batch) =>
        tx.heatMapRef.createMany({ data: batch }),
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
    await tx.$executeRawUnsafe(`
      SELECT setval(
        pg_get_serial_sequence('"CwlRotationPlanDay"', 'id'),
        COALESCE((SELECT MAX("id") FROM "CwlRotationPlanDay"), 1),
        COALESCE((SELECT MAX("id") FROM "CwlRotationPlanDay"), 0) > 0
      );
    `);
    await tx.$executeRawUnsafe(`
      SELECT setval(
        pg_get_serial_sequence('"CwlRotationPlanMember"', 'id'),
        COALESCE((SELECT MAX("id") FROM "CwlRotationPlanMember"), 1),
        COALESCE((SELECT MAX("id") FROM "CwlRotationPlanMember"), 0) > 0
      );
    `);
  }
}

