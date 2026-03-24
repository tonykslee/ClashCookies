import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeTag } from "../services/war-events/core";

type ScriptArgs = {
  sourceGuildId: string;
  targetGuildId: string;
  apply: boolean;
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

  const sourceGuildId = String(values.get("source-guild") ?? "").trim();
  const targetGuildId = String(values.get("target-guild") ?? "").trim();
  if (!sourceGuildId || !targetGuildId) {
    throw new Error(
      "Usage: ts-node src/scripts/repairClanWarParticipationGuildScope.ts --source-guild <guild-id> --target-guild <guild-id> [--apply]",
    );
  }
  if (sourceGuildId === targetGuildId) {
    throw new Error("source and target guild IDs must be different.");
  }
  return {
    sourceGuildId,
    targetGuildId,
    apply: Boolean(values.get("apply")),
  };
}

async function readParticipationSummary(guildId: string): Promise<{
  totalRows: number;
  fwaRows: number;
  endedFwaWars: number;
}> {
  const rows = await prisma.$queryRaw<
    Array<{ totalRows: number; fwaRows: number; endedFwaWars: number }>
  >(Prisma.sql`
    SELECT
      COUNT(*)::int AS "totalRows",
      COUNT(*) FILTER (WHERE "matchType" = 'FWA')::int AS "fwaRows",
      COUNT(DISTINCT "warId") FILTER (
        WHERE "matchType" = 'FWA'
          AND "warEndTime" IS NOT NULL
      )::int AS "endedFwaWars"
    FROM "ClanWarParticipation"
    WHERE "guildId" = ${guildId}
  `);
  return (
    rows[0] ?? {
      totalRows: 0,
      fwaRows: 0,
      endedFwaWars: 0,
    }
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targetCurrentWarRows = await prisma.currentWar.findMany({
    where: { guildId: args.targetGuildId },
    select: { clanTag: true },
  });
  const targetClanTags = Array.from(
    new Set(
      targetCurrentWarRows
        .map((row) => normalizeTag(row.clanTag))
        .filter((value) => Boolean(value)),
    ),
  );
  if (targetClanTags.length === 0) {
    throw new Error(
      `No CurrentWar clans found for target guild ${args.targetGuildId}; aborting repair.`,
    );
  }

  const sourceRows = await prisma.clanWarParticipation.findMany({
    where: {
      guildId: args.sourceGuildId,
      matchType: "FWA",
      warEndTime: { not: null },
    },
    orderBy: [{ warStartTime: "desc" }, { createdAt: "desc" }],
  });
  const targetTagSet = new Set(targetClanTags);
  const candidateRows = sourceRows.filter((row) =>
    targetTagSet.has(normalizeTag(row.clanTag)),
  );
  const candidateClanTags = Array.from(
    new Set(candidateRows.map((row) => normalizeTag(row.clanTag))),
  );
  const nonCandidateRows = sourceRows.filter(
    (row) => !targetTagSet.has(normalizeTag(row.clanTag)),
  );

  const sourceSummary = await readParticipationSummary(args.sourceGuildId);
  const targetSummaryBefore = await readParticipationSummary(args.targetGuildId);
  const proof = {
    sourceGuildId: args.sourceGuildId,
    targetGuildId: args.targetGuildId,
    sourceSummary,
    targetSummaryBefore,
    targetCurrentWarClanCount: targetClanTags.length,
    sourceEndedFwaRows: sourceRows.length,
    candidateEndedFwaRows: candidateRows.length,
    candidateClanCount: candidateClanTags.length,
    candidateClanTags,
    excludedSourceRows: nonCandidateRows.length,
    excludedClanTags: Array.from(
      new Set(nonCandidateRows.map((row) => normalizeTag(row.clanTag))),
    ),
    canRepair: candidateRows.length > 0,
    mode: args.apply ? "apply" : "dry-run",
  };
  console.log(JSON.stringify(proof, null, 2));

  if (candidateRows.length === 0) {
    throw new Error(
      "Safety guard: no provable candidate rows overlap target CurrentWar clans; no mutation performed.",
    );
  }
  if (!args.apply) {
    console.log("Dry run complete. Re-run with --apply to insert repaired rows.");
    return;
  }

  const insertPayload = candidateRows.map((row) => ({
    id: randomUUID(),
    guildId: args.targetGuildId,
    warId: row.warId,
    clanTag: row.clanTag,
    opponentTag: row.opponentTag,
    playerTag: row.playerTag,
    playerName: row.playerName,
    townHall: row.townHall,
    attacksUsed: row.attacksUsed,
    attacksMissed: row.attacksMissed,
    starsEarned: row.starsEarned,
    trueStars: row.trueStars,
    missedBoth: row.missedBoth,
    firstAttackAt: row.firstAttackAt,
    attackDelayMinutes: row.attackDelayMinutes,
    attackWindowMissed: row.attackWindowMissed,
    matchType: row.matchType,
    warStartTime: row.warStartTime,
    warEndTime: row.warEndTime,
    createdAt: row.createdAt,
  }));

  const inserted = await prisma.clanWarParticipation.createMany({
    data: insertPayload,
    skipDuplicates: true,
  });
  const targetSummaryAfter = await readParticipationSummary(args.targetGuildId);
  const verification = {
    insertedRows: inserted.count,
    targetSummaryAfter,
  };
  console.log(JSON.stringify(verification, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

