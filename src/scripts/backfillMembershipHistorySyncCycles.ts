import { prisma } from "../prisma";
import {
  MembershipHistorySyncCycleBackfillService,
  type MembershipHistorySyncCycleBackfillDb,
  type MembershipSyncFilter,
  type MembershipSyncCycleBackfillPlan,
} from "../services/MembershipHistorySyncCycleBackfillService";

export type BackfillMembershipHistorySyncCyclesArgs = {
  guildId: string;
  syncFilter: MembershipSyncFilter;
  apply: boolean;
};

function parsePositiveSync(value: string): number {
  const syncNumber = Number(value.trim());
  if (!Number.isInteger(syncNumber) || syncNumber <= 0) {
    throw new Error(`Invalid sync number: ${value}`);
  }
  return syncNumber;
}

export function parseSyncFilter(value: string): Set<number> {
  const syncNumbers = new Set<number>();
  for (const token of value.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const range = part.split("-").map((piece) => piece.trim());
    if (range.length === 1) {
      syncNumbers.add(parsePositiveSync(range[0]));
      continue;
    }
    if (range.length !== 2) throw new Error(`Invalid sync range: ${part}`);
    const start = parsePositiveSync(range[0]);
    const end = parsePositiveSync(range[1]);
    if (end < start) throw new Error(`Sync range must be ascending: ${part}`);
    for (let syncNumber = start; syncNumber <= end; syncNumber += 1) syncNumbers.add(syncNumber);
  }
  if (syncNumbers.size === 0) throw new Error("Sync filter must contain at least one sync number.");
  return syncNumbers;
}

export function parseBackfillMembershipHistorySyncCyclesArgs(argv: string[]): BackfillMembershipHistorySyncCyclesArgs {
  let guildId = "";
  let syncFilter: Set<number> | null = null;
  let filterFlag: string | null = null;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--guild" || token === "--sync" || token === "--syncs") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--guild") guildId = value.trim();
      else {
        if (filterFlag && filterFlag !== token) throw new Error("Use only one of --sync or --syncs.");
        filterFlag = token;
        syncFilter = token === "--sync" ? new Set([parsePositiveSync(value)]) : parseSyncFilter(value);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!guildId) throw new Error("Usage: node dist/scripts/backfillMembershipHistorySyncCycles.js --guild <guild-id> [--sync <number>|--syncs <list/range>] [--apply]");
  return { guildId, syncFilter, apply };
}

function formatDate(value: Date | null): string {
  return value?.toISOString() ?? "-";
}

export function formatBackfillPlan(plan: MembershipSyncCycleBackfillPlan, apply: boolean): string {
  const lines = [
    apply ? "APPLY MODE — only CREATE rows from this plan may be written" : "DRY RUN — no database mutations performed",
    `guild=${plan.guildId}`,
    "",
  ];
  for (const row of plan.rows) {
    lines.push([
      `guild=${row.guildId}`,
      `sync=${row.syncNumber}`,
      `action=${row.action}`,
      `candidate_sync_time=${formatDate(row.candidateSyncTime)}`,
      `scheduled_sync_post_id=${row.scheduledSyncPostId ?? "-"}`,
      `canonical_history_count=${row.canonicalHistoryCount}`,
      `reasons=${row.reasons.join(",") || "-"}`,
    ].join(" | "));
  }
  lines.push(
    "",
    `considered=${plan.considered}`,
    `creatable=${plan.creatable}`,
    `already_present=${plan.alreadyPresent}`,
    `skipped=${plan.skipped}`,
    `conflicts=${plan.conflicts}`,
  );
  return lines.join("\n");
}

export async function runBackfillMembershipHistorySyncCycles(
  args: BackfillMembershipHistorySyncCyclesArgs,
  db: MembershipHistorySyncCycleBackfillDb = prisma as unknown as MembershipHistorySyncCycleBackfillDb,
): Promise<MembershipSyncCycleBackfillPlan> {
  const service = new MembershipHistorySyncCycleBackfillService(db);
  const plan = await service.plan(args.guildId, args.syncFilter);
  console.log(formatBackfillPlan(plan, args.apply));
  if (!args.apply) return plan;
  if (plan.conflicts > 0) throw new Error("Apply aborted before writes because the selected plan contains conflicts.");
  await service.apply(plan);
  return plan;
}

async function main(): Promise<void> {
  const args = parseBackfillMembershipHistorySyncCyclesArgs(process.argv.slice(2));
  await runBackfillMembershipHistorySyncCycles(args);
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
