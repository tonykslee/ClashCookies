import { prisma } from "../prisma";
import {
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
} from "../services/TrackedMessageService";

type ScriptArgs = {
  apply: boolean;
  guildId: string | null;
};

function parseArgs(argv: string[]): ScriptArgs {
  const values = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      values.set("apply", true);
      continue;
    }
    if (token.startsWith("--") && i + 1 < argv.length) {
      values.set(token.replace(/^--/, ""), argv[i + 1]);
      i += 1;
    }
  }

  const guildId = String(values.get("guild") ?? values.get("guild-id") ?? "").trim() || null;
  return {
    apply: Boolean(values.get("apply")),
    guildId,
  };
}

async function resolveGuildIds(): Promise<string[]> {
  const rows = await prisma.trackedMessage.findMany({
    where: {
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      featureType: {
        in: [
          TRACKED_MESSAGE_FEATURE_TYPE.FWA_BASE_SWAP,
          TRACKED_MESSAGE_FEATURE_TYPE.FWA_MATCH_CHECKLIST,
        ],
      },
    },
    distinct: ["guildId"],
    select: {
      guildId: true,
    },
  });
  return Array.from(
    new Set(
      rows
        .map((row) => String(row.guildId ?? "").trim())
        .filter((guildId) => Boolean(guildId)),
    ),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const guildIds = args.guildId ? [args.guildId] : await resolveGuildIds();

  if (guildIds.length === 0) {
    console.log("No active FWA bases checklist rows found; nothing to repair.");
    return;
  }

  const totals = {
    guildCount: guildIds.length,
    basesCompletionCandidates: 0,
    basesCompletionReplaced: 0,
    baseSwapCandidates: 0,
    baseSwapExpiredCandidates: 0,
    baseSwapOlderThanCurrentSyncCandidates: 0,
    baseSwapReplaced: 0,
  };

  for (const guildId of guildIds) {
    const summary = await trackedMessageService.repairStaleFwaBasesChecklistState({
      guildId,
      apply: args.apply,
    });
    console.log(JSON.stringify(summary, null, 2));
    totals.basesCompletionCandidates += summary.basesCompletionCandidates;
    totals.basesCompletionReplaced += summary.basesCompletionReplaced;
    totals.baseSwapCandidates += summary.baseSwapCandidates;
    totals.baseSwapExpiredCandidates += summary.baseSwapExpiredCandidates;
    totals.baseSwapOlderThanCurrentSyncCandidates +=
      summary.baseSwapOlderThanCurrentSyncCandidates;
    totals.baseSwapReplaced += summary.baseSwapReplaced;
  }

  console.log(JSON.stringify({ ...totals, mode: args.apply ? "apply" : "dry-run" }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
