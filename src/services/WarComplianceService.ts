import { prisma } from "../prisma";
import {
  type FwaLoseStyle,
  type MatchType,
  type WarComplianceAttack,
  type WarComplianceParticipant,
  type WarComplianceSnapshot,
  computeWarComplianceForTest,
  normalizeTagBare,
  normalizeOutcome,
  normalizeTag,
} from "./war-events/core";

export type WarComplianceIssue = {
  playerTag: string;
  playerName: string;
  ruleType: "missed_both" | "not_following_plan";
  expectedBehavior: string;
  actualBehavior: string;
};

export type WarComplianceReport = {
  clanTag: string;
  warId: number | null;
  warStartTime: Date;
  warEndTime: Date | null;
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
  missedBoth: WarComplianceIssue[];
  notFollowingPlan: WarComplianceIssue[];
  participantsCount: number;
  attacksCount: number;
};

type WarSeedRow = {
  warStartTime: Date;
  warId: number;
  warEndTime: Date | null;
};

/** Purpose: produce a reusable clan-tag OR filter that supports stored with/without `#`. */
function buildClanTagWhere(tagInput: string): { OR: Array<{ clanTag: string }> } {
  const normalized = normalizeTag(tagInput);
  const bare = normalizeTagBare(tagInput);
  if (!bare) {
    return { OR: [{ clanTag: normalized }] };
  }
  if (normalized === bare) {
    return { OR: [{ clanTag: normalized }] };
  }
  return { OR: [{ clanTag: normalized }, { clanTag: bare }] };
}

/** Purpose: build a stable participant label from known name/tag fields. */
function getParticipantLabel(input: { playerName: string | null; playerTag: string }): string {
  const name = String(input.playerName ?? "").trim();
  return name || input.playerTag;
}

/** Purpose: describe expected plan behavior for actionable compliance output lines. */
function describeExpectedPlanBehavior(input: {
  matchType: MatchType;
  expectedOutcome: "WIN" | "LOSE" | null;
  loseStyle: FwaLoseStyle;
}): string {
  if (input.matchType === "BL" || input.matchType === "MM") {
    return "War-plan compliance enforcement is disabled for BL/MM wars.";
  }
  if (input.matchType === "FWA" && input.expectedOutcome === "WIN") {
    return "Mirror triple in strict window; avoid off-mirror triples/zeros.";
  }
  if (input.matchType === "FWA" && input.expectedOutcome === "LOSE") {
    return input.loseStyle === "TRIPLE_TOP_30"
      ? "Lose style TRIPLE_TOP_30: attack top-30 bases only."
      : "Lose style TRADITIONAL: controlled 1-2 star flow and late-window constraints.";
  }
  return "Mirror-based fallback plan applies when expected outcome is unknown.";
}

/** Purpose: summarize observed attack behavior for one player in command output. */
function describeActualBehaviorForPlayer(
  playerTag: string,
  attacksByPlayerTag: Map<string, WarComplianceAttack[]>,
  attacksUsedByPlayerTag: Map<string, number>
): string {
  const normalizedTag = normalizeTag(playerTag);
  const attacksUsed = attacksUsedByPlayerTag.get(normalizedTag) ?? 0;
  const playerAttacks = attacksByPlayerTag.get(normalizedTag) ?? [];
  if (playerAttacks.length === 0) {
    return `Attacks used: ${attacksUsed}. No attack rows recorded.`;
  }
  const attackSummaries = playerAttacks
    .slice()
    .sort((a, b) => {
      const orderDelta = Number(a.attackOrder ?? 0) - Number(b.attackOrder ?? 0);
      if (orderDelta !== 0) return orderDelta;
      return a.attackSeenAt.getTime() - b.attackSeenAt.getTime();
    })
    .map((row) => `#${row.defenderPosition ?? "?"} (${row.stars ?? 0}*)`);
  return `Attacks used: ${attacksUsed}. Targets: ${attackSummaries.join(", ")}.`;
}

/** Purpose: map rule-engine name output into detailed issues for user-facing command output. */
function mapNamesToIssues(input: {
  names: string[];
  ruleType: "missed_both" | "not_following_plan";
  expectedBehavior: string;
  participantByLabel: Map<string, WarComplianceParticipant>;
  attacksByPlayerTag: Map<string, WarComplianceAttack[]>;
  attacksUsedByPlayerTag: Map<string, number>;
}): WarComplianceIssue[] {
  return input.names.map((name) => {
    const participant = input.participantByLabel.get(name) ?? null;
    const playerTag = normalizeTag(participant?.playerTag ?? "") || "UNKNOWN";
    const actualBehavior =
      input.ruleType === "missed_both"
        ? `Attacks used: ${participant?.attacksUsed ?? 0}.`
        : describeActualBehaviorForPlayer(
            playerTag,
            input.attacksByPlayerTag,
            input.attacksUsedByPlayerTag
          );
    return {
      playerTag,
      playerName: name,
      ruleType: input.ruleType,
      expectedBehavior: input.expectedBehavior,
      actualBehavior,
    };
  });
}

/** Purpose: resolve lose-style configuration for a tracked clan with safe fallback. */
async function getLoseStyleForClan(clanTagInput: string): Promise<FwaLoseStyle> {
  const clanTag = normalizeTag(clanTagInput);
  if (!clanTag) return "TRIPLE_TOP_30";
  const row = await prisma.trackedClan.findFirst({
    where: {
      OR: [
        { tag: { equals: `#${clanTag}`, mode: "insensitive" } },
        { tag: { equals: clanTag, mode: "insensitive" } },
      ],
    },
    select: { loseStyle: true },
  });
  const loseStyle = String(row?.loseStyle ?? "").toUpperCase();
  if (loseStyle === "TRADITIONAL" || loseStyle === "TRIPLE_TOP_30") {
    return loseStyle;
  }
  return "TRIPLE_TOP_30";
}

/** Purpose: resolve ended-war seed row using explicit or latest war selection rules. */
async function getWarSeed(input: {
  clanTag: string;
  preferredWarStartTime?: Date | null;
  warId?: number | null;
}): Promise<WarSeedRow | null> {
  const clanTagWhere = buildClanTagWhere(input.clanTag);
  if (input.preferredWarStartTime instanceof Date) {
    const row = await prisma.warAttacks.findFirst({
      where: {
        ...clanTagWhere,
        warStartTime: input.preferredWarStartTime,
        warEndTime: { not: null },
        attackOrder: 0,
      },
      orderBy: [{ warStartTime: "desc" }],
      select: { warStartTime: true, warId: true, warEndTime: true },
    });
    if (!row) return null;
    return {
      warStartTime: row.warStartTime,
      warId: Number.isFinite(Number(row.warId)) ? Math.trunc(Number(row.warId)) : 0,
      warEndTime: row.warEndTime ?? null,
    };
  }
  if (
    input.warId !== null &&
    input.warId !== undefined &&
    Number.isFinite(input.warId)
  ) {
    const row = await prisma.warAttacks.findFirst({
      where: {
        ...clanTagWhere,
        warId: Math.trunc(input.warId),
        warEndTime: { not: null },
        attackOrder: 0,
      },
      orderBy: [{ warStartTime: "desc" }],
      select: { warStartTime: true, warId: true, warEndTime: true },
    });
    if (!row) return null;
    return {
      warStartTime: row.warStartTime,
      warId: Number.isFinite(Number(row.warId)) ? Math.trunc(Number(row.warId)) : 0,
      warEndTime: row.warEndTime ?? null,
    };
  }
  const row = await prisma.warAttacks.findFirst({
    where: {
      ...clanTagWhere,
      warEndTime: { not: null },
      attackOrder: 0,
    },
    orderBy: [{ warStartTime: "desc" }],
    select: { warStartTime: true, warId: true, warEndTime: true },
  });
  if (!row) return null;
  return {
    warStartTime: row.warStartTime,
    warId: Number.isFinite(Number(row.warId)) ? Math.trunc(Number(row.warId)) : 0,
    warEndTime: row.warEndTime ?? null,
  };
}

/** Purpose: centralize DB-backed compliance evaluation shared by events and user commands. */
export class WarComplianceService {
  /** Purpose: resolve compliance snapshot names for a clan+war context without extra command logic. */
  async getComplianceSnapshot(input: {
    clanTag: string;
    preferredWarStartTime?: Date | null;
    warId?: number | null;
    matchType: MatchType;
    expectedOutcome: "WIN" | "LOSE" | null;
  }): Promise<WarComplianceSnapshot> {
    const report = await this.getComplianceReport(input);
    if (!report) return { missedBoth: [], notFollowingPlan: [] };
    return {
      missedBoth: report.missedBoth.map((row) => row.playerName),
      notFollowingPlan: report.notFollowingPlan.map((row) => row.playerName),
    };
  }

  /** Purpose: produce detailed compliance issues for leadership-facing command responses. */
  async getComplianceReport(input: {
    clanTag: string;
    preferredWarStartTime?: Date | null;
    warId?: number | null;
    matchType: MatchType;
    expectedOutcome: "WIN" | "LOSE" | null;
  }): Promise<WarComplianceReport | null> {
    const clanTag = normalizeTag(input.clanTag);
    if (!normalizeTagBare(input.clanTag)) return null;
    if (input.matchType === "BL" || input.matchType === "MM") {
      return null;
    }

    const warSeed = await getWarSeed({
      clanTag,
      preferredWarStartTime: input.preferredWarStartTime ?? null,
      warId: input.warId ?? null,
    });
    if (!warSeed) return null;
    const warStartTime = warSeed.warStartTime;
    const warId = Number.isFinite(Number(warSeed.warId))
      ? Math.trunc(Number(warSeed.warId))
      : null;
    const clanTagWhere = buildClanTagWhere(clanTag);

    const participants = await prisma.warAttacks.findMany({
      where: { ...clanTagWhere, warStartTime, attackOrder: 0 },
      select: { playerName: true, playerTag: true, attacksUsed: true, playerPosition: true },
      orderBy: [{ playerPosition: "asc" }, { playerName: "asc" }],
    });
    const attacks = await prisma.warAttacks.findMany({
      where: { ...clanTagWhere, warStartTime },
      select: {
        playerTag: true,
        playerName: true,
        playerPosition: true,
        defenderPosition: true,
        stars: true,
        trueStars: true,
        attackSeenAt: true,
        warEndTime: true,
        attackOrder: true,
      },
      orderBy: [{ attackSeenAt: "asc" }, { attackOrder: "asc" }, { playerTag: "asc" }],
    });
    const loseStyle = await getLoseStyleForClan(clanTag);
    const normalizedOutcome = normalizeOutcome(input.expectedOutcome);
    const snapshot = computeWarComplianceForTest({
      clanTag,
      participants,
      attacks,
      matchType: input.matchType,
      expectedOutcome: normalizedOutcome,
      loseStyle,
    });

    const participantByLabel = new Map<string, WarComplianceParticipant>();
    const attacksByPlayerTag = new Map<string, WarComplianceAttack[]>();
    const attacksUsedByPlayerTag = new Map<string, number>();

    for (const participant of participants) {
      const label = getParticipantLabel({
        playerName: participant.playerName,
        playerTag: participant.playerTag,
      });
      participantByLabel.set(label, participant as WarComplianceParticipant);
      attacksUsedByPlayerTag.set(normalizeTag(participant.playerTag), Number(participant.attacksUsed ?? 0));
    }
    for (const attack of attacks) {
      const tag = normalizeTag(attack.playerTag);
      const rows = attacksByPlayerTag.get(tag) ?? [];
      rows.push(attack as WarComplianceAttack);
      attacksByPlayerTag.set(tag, rows);
    }

    const expectedPlanBehavior = describeExpectedPlanBehavior({
      matchType: input.matchType,
      expectedOutcome: normalizedOutcome,
      loseStyle,
    });
    return {
      clanTag,
      warId,
      warStartTime,
      warEndTime: warSeed.warEndTime,
      matchType: input.matchType,
      expectedOutcome: normalizedOutcome,
      loseStyle,
      missedBoth: mapNamesToIssues({
        names: snapshot.missedBoth,
        ruleType: "missed_both",
        expectedBehavior: "Use both attacks for the war.",
        participantByLabel,
        attacksByPlayerTag,
        attacksUsedByPlayerTag,
      }),
      notFollowingPlan: mapNamesToIssues({
        names: snapshot.notFollowingPlan,
        ruleType: "not_following_plan",
        expectedBehavior: expectedPlanBehavior,
        participantByLabel,
        attacksByPlayerTag,
        attacksUsedByPlayerTag,
      }),
      participantsCount: participants.length,
      attacksCount: attacks.length,
    };
  }
}
