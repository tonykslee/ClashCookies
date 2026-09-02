import { prisma } from "../prisma";
import {
  MEMBERSHIP_PARTICIPATION_BACKFILL_PREFIX,
  MembershipHistoryParticipationBackfillService,
  type ParticipationBackfillDb,
  type ParticipationBackfillPlan,
} from "../services/MembershipHistoryParticipationBackfillService";

export type BackfillMembershipHistoryParticipationArgs = {
  guildId: string;
  syncFilter: Set<number>;
  apply: boolean;
};

function parsePositiveSync(value: string): number {
  const syncNumber = Number(value.trim());
  if (!Number.isInteger(syncNumber) || syncNumber <= 0) throw new Error(`Invalid sync number: ${value}`);
  return syncNumber;
}

/** Purpose: parse comma-separated sync numbers and inclusive ascending ranges. */
export function parseParticipationSyncFilter(value: string): Set<number> {
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
    for (let sync = start; sync <= end; sync += 1) syncNumbers.add(sync);
  }
  if (syncNumbers.size === 0) throw new Error("Sync filter must contain at least one sync number.");
  return syncNumbers;
}

/** Purpose: require explicit guild and sync scope while keeping apply opt-in. */
export function parseBackfillMembershipHistoryParticipationArgs(argv: string[]): BackfillMembershipHistoryParticipationArgs {
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
        syncFilter = token === "--sync" ? new Set([parsePositiveSync(value)]) : parseParticipationSyncFilter(value);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!guildId || !syncFilter) {
    throw new Error("Usage: node dist/scripts/backfillMembershipHistoryParticipation.js --guild <guild-id> [--sync <number>|--syncs <list/range>] [--apply]");
  }
  return { guildId, syncFilter, apply };
}

/** Purpose: print bounded per-war evidence without dumping player rosters. */
export function formatParticipationBackfillPlan(plan: ParticipationBackfillPlan, apply: boolean): string {
  const lines = [
    `${MEMBERSHIP_PARTICIPATION_BACKFILL_PREFIX} mode=${apply ? "APPLY" : "DRY_RUN"} guild=${plan.guildId}`,
    `${MEMBERSHIP_PARTICIPATION_BACKFILL_PREFIX} selected_syncs=${plan.selectedSyncs.join(",")}`,
  ];
  for (const report of plan.reports) {
    lines.push([
      MEMBERSHIP_PARTICIPATION_BACKFILL_PREFIX,
      `guild=${report.guildId}`,
      `sync=${report.syncNumber}`,
      `clan=${report.clanTag ?? "-"}`,
      `canonical_war_id=${report.canonicalWarId ?? "-"}`,
      `action=${report.action}`,
      `archive_participants=${report.archiveParticipantCount}`,
      `reconstructable=${report.reconstructableCount}`,
      `existing=${report.existingCount}`,
      `planned_inserts=${report.plannedInsertCount}`,
      `skipped_unreconstructable=${report.skippedUnreconstructableCount}`,
      `expected_team_size=${report.expectedTeamSize ?? "UNKNOWN"}`,
      `projected_coverage=${report.projectedCoverage}`,
      `reasons=${report.reasons.join(",") || "-"}`,
    ].join(" "));
  }
  const summary = plan.summary;
  lines.push(
    `${MEMBERSHIP_PARTICIPATION_BACKFILL_PREFIX} summary ` + [
      `selected_syncs=${summary.selectedSyncs}`,
      `existing_sync_cycles=${summary.existingSyncCycles}`,
      `candidate_canonical_fwa_wars=${summary.candidateCanonicalFwaWars}`,
      `already_complete_noop_wars=${summary.alreadyCompleteNoOpWars}`,
      `wars_with_planned_inserts=${summary.warsWithPlannedInserts}`,
      `rows_planned=${summary.rowsPlanned}`,
      `rows_unreconstructable=${summary.rowsUnreconstructable}`,
      `complete_projected_rosters=${summary.completeProjectedRosters}`,
      `partial_projected_rosters=${summary.partialProjectedRosters}`,
      `unknown_projected_rosters=${summary.unknownProjectedRosters}`,
      `skipped_wars=${summary.skippedWars}`,
      `conflicts=${summary.conflicts}`,
    ].join(" "),
  );
  return lines.join("\n");
}

/** Purpose: plan the selected repair and apply only the already-planned rows on explicit request. */
export async function runBackfillMembershipHistoryParticipation(
  args: BackfillMembershipHistoryParticipationArgs,
  db: ParticipationBackfillDb = prisma as unknown as ParticipationBackfillDb,
): Promise<ParticipationBackfillPlan> {
  const service = new MembershipHistoryParticipationBackfillService(db);
  const plan = await service.plan(args.guildId, args.syncFilter);
  console.log(formatParticipationBackfillPlan(plan, args.apply));
  if (!args.apply) return plan;
  if (plan.summary.conflicts > 0) throw new Error("Apply aborted before writes because the selected plan contains conflicts.");
  const result = await service.apply(plan);
  console.log(`${MEMBERSHIP_PARTICIPATION_BACKFILL_PREFIX} apply batches=${result.batches} rows_attempted=${result.rowsAttempted} rows_reported_created=${result.rowsReportedCreated} verified_wars=${Object.keys(result.verifiedRowsByWar).length}`);
  return plan;
}

async function main(): Promise<void> {
  const args = parseBackfillMembershipHistoryParticipationArgs(process.argv.slice(2));
  await runBackfillMembershipHistoryParticipation(args);
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
