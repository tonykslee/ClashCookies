import { prisma } from "../prisma";
import {
  buildHistoricalSyncReconciliationPlan,
  type HistoricalSyncReconciliationArgs,
  type HistoricalSyncReconciliationDb,
  type HistoricalSyncReconciliationPlan,
} from "./auditHistoricalSyncReconciliation";
import {
  persistResolvedSyncCycle,
  type SyncCyclePersistenceDb,
} from "../services/SyncCycleService";

export type HistoricalSyncReconciliationWriterArgs = HistoricalSyncReconciliationArgs & {
  apply: boolean;
  expectedCreateCount?: number;
};

export type HistoricalSyncReconciliationWriterAction = "CREATE" | "ALREADY_PRESENT" | "SKIP" | "CONFLICT";

export type HistoricalSyncReconciliationWriterRow = {
  guildId: string;
  syncNumber: number;
  action: HistoricalSyncReconciliationWriterAction;
  reason: string;
  candidateSyncTime: Date | null;
  scheduledSyncPostId: string | null;
};

export type HistoricalSyncReconciliationWriterPlan = {
  guildId: string;
  fromSync?: number;
  toSync?: number;
  rows: HistoricalSyncReconciliationWriterRow[];
  considered: number;
  create: number;
  alreadyPresent: number;
  skip: number;
  conflict: number;
  proofAvailable: boolean;
};

export type HistoricalSyncReconciliationWriterDb = HistoricalSyncReconciliationDb & {
  scheduledSyncPost: HistoricalSyncReconciliationDb["scheduledSyncPost"] & {
    findUnique: (args?: any) => Promise<any | null>;
  };
  syncCycle: SyncCyclePersistenceDb["syncCycle"] & {
    findMany: (args?: any) => Promise<any[]>;
  };
  $transaction?: <T>(callback: (tx: HistoricalSyncReconciliationWriterTransactionDb) => Promise<T>) => Promise<T>;
};

export type HistoricalSyncReconciliationWriterTransactionDb = SyncCyclePersistenceDb & {
  scheduledSyncPost: {
    findUnique: (args?: any) => Promise<any | null>;
  };
};

type ApplyCounts = { created: number; idempotent: number };

function parsePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function parseNonNegative(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative integer`);
  return parsed;
}

/** Purpose: parse the bounded, dry-run-by-default historical writer command. */
export function parseHistoricalSyncReconciliationWriterArgs(argv: string[]): HistoricalSyncReconciliationWriterArgs {
  let guildId = "";
  let fromSync: number | undefined;
  let toSync: number | undefined;
  let expectedCreateCount: number | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--guild" || token === "--from-sync" || token === "--to-sync" || token === "--expected-create-count") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--guild") guildId = value.trim();
      else if (token === "--from-sync") fromSync = parsePositive(value, token);
      else if (token === "--to-sync") toSync = parsePositive(value, token);
      else expectedCreateCount = parseNonNegative(value, token);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!guildId) throw new Error("Usage: backfill:historical-sync-reconciliation --guild <guildId> [--from-sync <n>] [--to-sync <n>] [--apply --expected-create-count <n>]");
  if (fromSync !== undefined && toSync !== undefined && fromSync > toSync) throw new Error("--from-sync must not exceed --to-sync");
  if (apply && (fromSync === undefined || toSync === undefined)) throw new Error("--apply requires both --from-sync and --to-sync");
  if (apply && expectedCreateCount === undefined) throw new Error("--apply requires --expected-create-count");
  if (!apply && expectedCreateCount !== undefined) throw new Error("--expected-create-count requires --apply");
  return { guildId, fromSync, toSync, apply, expectedCreateCount };
}

function formatDate(value: Date | null): string {
  return value?.toISOString() ?? "-";
}

function formatRange(plan: Pick<HistoricalSyncReconciliationWriterPlan, "fromSync" | "toSync">): string {
  return `${plan.fromSync ?? "-"}..${plan.toSync ?? "-"}`;
}

function firstReason(reasons: readonly string[], fallback: string): string {
  return reasons[0] ?? fallback;
}

function parentForNumber(plan: HistoricalSyncReconciliationPlan, syncNumber: number) {
  return plan.realizedSequences.find((sequence) =>
    syncNumber > sequence.lower.syncNumber && syncNumber < sequence.upper.syncNumber);
}

function cycleForNumber(plan: HistoricalSyncReconciliationPlan, syncNumber: number) {
  return plan.realizedSequences
    .flatMap((sequence) => sequence.cycles.map((cycle) => ({ sequence, cycle })))
    .find(({ cycle }) => cycle.expectedSyncNumber === syncNumber);
}

function existingCycleForNumber(plan: HistoricalSyncReconciliationPlan, syncNumber: number) {
  return plan.inputs.cycles.find((cycle) => cycle.guildId === plan.args.guildId && cycle.syncNumber === syncNumber);
}

function rowForNumber(plan: HistoricalSyncReconciliationPlan, syncNumber: number): HistoricalSyncReconciliationWriterRow {
  const located = cycleForNumber(plan, syncNumber);
  const parent = located?.sequence ?? parentForNumber(plan, syncNumber);
  const existing = existingCycleForNumber(plan, syncNumber);
  if (!located && existing) {
    return {
      guildId: plan.args.guildId,
      syncNumber,
      action: "ALREADY_PRESENT",
      reason: "exact_mapping_already_present",
      candidateSyncTime: existing.syncTime,
      scheduledSyncPostId: existing.scheduledSyncPostId ?? null,
    };
  }
  if (!parent || parent.classification !== "REALIZED_SEQUENCE_CORROBORATED") {
    return {
      guildId: plan.args.guildId,
      syncNumber,
      action: "SKIP",
      reason: "ambiguous_parent_sequence",
      candidateSyncTime: null,
      scheduledSyncPostId: null,
    };
  }

  const cycle = located?.cycle;
  if (!cycle) {
    return {
      guildId: plan.args.guildId,
      syncNumber,
      action: "SKIP",
      reason: "no_exact_persisted_schedule",
      candidateSyncTime: null,
      scheduledSyncPostId: null,
    };
  }

  const candidateSyncTime = cycle.selectedSchedule?.syncTime ?? null;
  const scheduledSyncPostId = cycle.selectedSchedule?.id ?? null;
  switch (cycle.action) {
    case "EXACT_SYNC_CYCLE_CANDIDATE":
      return { guildId: plan.args.guildId, syncNumber, action: "CREATE", reason: "exact_sync_cycle_candidate", candidateSyncTime, scheduledSyncPostId };
    case "ALREADY_PRESENT":
      return { guildId: plan.args.guildId, syncNumber, action: "ALREADY_PRESENT", reason: "exact_mapping_already_present", candidateSyncTime, scheduledSyncPostId };
    case "REALIZED_NUMBER_CONFLICT":
      return { guildId: plan.args.guildId, syncNumber, action: "CONFLICT", reason: firstReason(cycle.reasons, "sync_number_already_mapped"), candidateSyncTime, scheduledSyncPostId };
    case "CONFLICT":
      return { guildId: plan.args.guildId, syncNumber, action: "CONFLICT", reason: firstReason(cycle.reasons, "sync_time_already_mapped"), candidateSyncTime, scheduledSyncPostId };
    case "REALIZED_AMBIGUOUS_SCHEDULE":
      return { guildId: plan.args.guildId, syncNumber, action: "SKIP", reason: firstReason(cycle.reasons, "ambiguous_schedule"), candidateSyncTime, scheduledSyncPostId };
    case "REALIZED_MISSING_EXACT_SCHEDULE":
      return { guildId: plan.args.guildId, syncNumber, action: "SKIP", reason: firstReason(cycle.reasons, "no_exact_persisted_schedule"), candidateSyncTime, scheduledSyncPostId };
  }
}

/** Purpose: derive deterministic writer rows without reimplementing reconciliation or reading audit text. */
export function buildHistoricalSyncReconciliationWriterPlan(
  plan: HistoricalSyncReconciliationPlan,
): HistoricalSyncReconciliationWriterPlan {
  const boundedRequested = plan.args.fromSync !== undefined && plan.args.toSync !== undefined
    ? Array.from({ length: plan.args.toSync - plan.args.fromSync + 1 }, (_unused, index) => plan.args.fromSync! + index)
    : plan.requestedMissingNumbers;
  const requested = [...new Set(boundedRequested)].sort((left, right) => left - right);
  const rows = requested.map((syncNumber) => rowForNumber(plan, syncNumber));
  const proofAvailable = plan.args.fromSync !== undefined && plan.args.toSync !== undefined && plan.realizedSequences.some((sequence) =>
    sequence.classification === "REALIZED_SEQUENCE_CORROBORATED" &&
    sequence.lower.syncNumber <= plan.args.fromSync! && sequence.upper.syncNumber >= plan.args.toSync!,
  );
  return {
    guildId: plan.args.guildId,
    fromSync: plan.args.fromSync,
    toSync: plan.args.toSync,
    rows,
    considered: rows.length,
    create: rows.filter((row) => row.action === "CREATE").length,
    alreadyPresent: rows.filter((row) => row.action === "ALREADY_PRESENT").length,
    skip: rows.filter((row) => row.action === "SKIP").length,
    conflict: rows.filter((row) => row.action === "CONFLICT").length,
    proofAvailable,
  };
}

/** Purpose: render one deterministic operator row per requested missing sync. */
export function formatHistoricalSyncReconciliationWriterPlan(
  plan: HistoricalSyncReconciliationWriterPlan,
  apply: boolean,
  applyCounts?: ApplyCounts,
): string {
  const lines = plan.rows.map((row) => [
    `sync=${row.syncNumber}`,
    `action=${row.action}`,
    `reason=${row.reason}`,
    `candidate_sync_time=${formatDate(row.candidateSyncTime)}`,
    `scheduled_sync_post_id=${row.scheduledSyncPostId ?? "-"}`,
  ].join(" "));
  lines.push([
    `mode=${apply ? "APPLY" : "DRY_RUN"}`,
    `guild=${plan.guildId}`,
    `range=${formatRange(plan)}`,
    `considered=${plan.considered}`,
    `create=${plan.create}`,
    `already_present=${plan.alreadyPresent}`,
    `skip=${plan.skip}`,
    `conflict=${plan.conflict}`,
    ...(apply ? [`created=${applyCounts?.created ?? 0}`, `idempotent=${applyCounts?.idempotent ?? 0}`, "rolled_back=false"] : []),
  ].join(" "));
  return lines.join("\n");
}

function ensureApplyReady(args: HistoricalSyncReconciliationWriterArgs, plan: HistoricalSyncReconciliationWriterPlan): void {
  if (!args.apply) return;
  if (args.fromSync === undefined || args.toSync === undefined) throw new Error("Apply requires both bounds.");
  if (args.expectedCreateCount === undefined) throw new Error("Apply requires --expected-create-count.");
  if (args.expectedCreateCount !== plan.create) {
    throw new Error(`Apply aborted before writes: expected_create_count=${args.expectedCreateCount} actual_create_count=${plan.create}`);
  }
  if (plan.create > 0 && !plan.proofAvailable) throw new Error("Apply aborted before writes: the requested range lacks an exact anchored proof interval.");
  if (plan.conflict > 0) throw new Error("Apply aborted before writes: the selected plan contains CONFLICT rows.");
}

async function validateSchedule(
  tx: HistoricalSyncReconciliationWriterTransactionDb,
  row: HistoricalSyncReconciliationWriterRow,
): Promise<void> {
  if (!row.candidateSyncTime || !row.scheduledSyncPostId) throw new Error(`CREATE row missing exact schedule for sync ${row.syncNumber}`);
  const schedule = await tx.scheduledSyncPost.findUnique({
    where: { id: row.scheduledSyncPostId },
    select: { id: true, guildId: true, syncTime: true, status: true },
  });
  if (!schedule) throw new Error(`Apply aborted: scheduled sync post ${row.scheduledSyncPostId} is missing`);
  if (String(schedule.guildId ?? "") !== row.guildId) throw new Error(`Apply aborted: scheduled sync post ${row.scheduledSyncPostId} belongs to another guild`);
  const liveSyncTime = schedule.syncTime instanceof Date ? schedule.syncTime : new Date(schedule.syncTime);
  if (!Number.isFinite(liveSyncTime.getTime()) || liveSyncTime.getTime() !== row.candidateSyncTime.getTime()) {
    throw new Error(`Apply aborted: scheduled sync post ${row.scheduledSyncPostId} changed sync time`);
  }
  const status = String(schedule.status ?? "").trim().toUpperCase();
  if (status === "CANCELLED" || status === "REPLACED") {
    throw new Error(`Apply aborted: scheduled sync post ${row.scheduledSyncPostId} is ${status}`);
  }
}

/** Purpose: apply only exact, globally corroborated CREATE rows in one transaction. */
export async function applyHistoricalSyncReconciliationPlan(
  plan: HistoricalSyncReconciliationWriterPlan,
  db: HistoricalSyncReconciliationWriterDb,
): Promise<ApplyCounts> {
  if (plan.conflict > 0) throw new Error("Apply aborted before writes: the selected plan contains CONFLICT rows.");
  const createRows = plan.rows.filter((row) => row.action === "CREATE");
  if (createRows.length === 0) return { created: 0, idempotent: 0 };
  if (!db.$transaction) throw new Error("Apply requires a transactional database delegate.");
  try {
    return await db.$transaction(async (tx) => {
      let created = 0;
      let idempotent = 0;
      for (const row of createRows) await validateSchedule(tx, row);
      for (const row of createRows) {
        const result = await persistResolvedSyncCycle(tx, {
          guildId: row.guildId,
          syncNumber: row.syncNumber,
          syncTime: row.candidateSyncTime!,
          scheduledSyncPostId: row.scheduledSyncPostId!,
        });
        if (result.status === "conflict" || result.status === "failed") {
          throw new Error(`Apply aborted for sync ${row.syncNumber}: ${result.status} ${"reason" in result ? result.reason : ""}`.trim());
        }
        if (result.status === "created") created += 1;
        if (result.status === "existing") idempotent += 1;
      }
      return { created, idempotent };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} rolled_back=true`);
  }
}

/** Purpose: build the shared plan, print deterministic rows, and apply only after explicit operator confirmation. */
export async function runHistoricalSyncReconciliationWriter(
  args: HistoricalSyncReconciliationWriterArgs,
  db: HistoricalSyncReconciliationWriterDb = prisma as unknown as HistoricalSyncReconciliationWriterDb,
): Promise<HistoricalSyncReconciliationWriterPlan> {
  if (args.apply && (args.fromSync === undefined || args.toSync === undefined)) throw new Error("Apply requires both bounds.");
  if (args.apply && args.expectedCreateCount === undefined) throw new Error("Apply requires --expected-create-count.");
  const sharedPlan = await buildHistoricalSyncReconciliationPlan(args, db);
  const writerPlan = buildHistoricalSyncReconciliationWriterPlan(sharedPlan);
  ensureApplyReady(args, writerPlan);
  if (!args.apply) {
    console.log(formatHistoricalSyncReconciliationWriterPlan(writerPlan, false));
    return writerPlan;
  }
  const applyCounts = await applyHistoricalSyncReconciliationPlan(writerPlan, db);
  console.log(formatHistoricalSyncReconciliationWriterPlan(writerPlan, true, applyCounts));
  return writerPlan;
}

/** Purpose: execute the compiled historical SyncCycle reconciliation writer command. */
async function main(): Promise<void> {
  const args = parseHistoricalSyncReconciliationWriterArgs(process.argv.slice(2));
  await runHistoricalSyncReconciliationWriter(args);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
