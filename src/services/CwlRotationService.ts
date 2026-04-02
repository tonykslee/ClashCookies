import { prisma } from "../prisma";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { cwlStateService, type CwlActualLineup, type CwlSeasonRosterEntry } from "./CwlStateService";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";

export type CreateCwlRotationPlanResult =
  | {
      outcome: "created";
      season: string;
      clanTag: string;
      version: number;
      lineupSize: number;
      warnings: string[];
    }
  | {
      outcome: "blocked_existing";
      season: string;
      clanTag: string;
      existingVersion: number;
    }
  | {
      outcome: "not_tracked";
      season: string;
      clanTag: string;
    }
  | {
      outcome: "not_preparation";
      season: string;
      clanTag: string;
    }
  | {
      outcome: "invalid_excludes";
      season: string;
      clanTag: string;
      invalidTags: string[];
    }
  | {
      outcome: "not_enough_players";
      season: string;
      clanTag: string;
      lineupSize: number;
      availablePlayers: number;
    };

export type CwlRotationValidationResult = {
  season: string;
  clanTag: string;
  roundDay: number;
  plannedPlayerTags: string[];
  plannedPlayerNames: string[];
  actualPlayerTags: string[];
  actualPlayerNames: string[];
  missingExpectedPlayerTags: string[];
  extraActualPlayerTags: string[];
  complete: boolean;
  actualAvailable: boolean;
  currentState: string | null;
};

export type CwlRotationOverviewEntry = {
  season: string;
  clanTag: string;
  clanName: string | null;
  version: number;
  roundDay: number | null;
  status: "complete" | "mismatch" | "no_active_round" | "no_plan_day";
  missingExpectedPlayerTags: string[];
  extraActualPlayerTags: string[];
};

function compareRosterEntries(
  a: CwlSeasonRosterEntry,
  b: CwlSeasonRosterEntry,
  stableIndexByTag: Map<string, number>,
  totalCountByTag: Map<string, number>,
): number {
  const aCount = totalCountByTag.get(a.playerTag) ?? 0;
  const bCount = totalCountByTag.get(b.playerTag) ?? 0;
  if (aCount !== bCount) return aCount - bCount;
  const aStable = stableIndexByTag.get(a.playerTag) ?? Number.MAX_SAFE_INTEGER;
  const bStable = stableIndexByTag.get(b.playerTag) ?? Number.MAX_SAFE_INTEGER;
  if (aStable !== bStable) return aStable - bStable;
  const byName = a.playerName.localeCompare(b.playerName, undefined, {
    sensitivity: "base",
  });
  if (byName !== 0) return byName;
  return a.playerTag.localeCompare(b.playerTag);
}

function buildStableRosterOrder(input: {
  roster: CwlSeasonRosterEntry[];
  currentLineupTags: string[];
}): CwlSeasonRosterEntry[] {
  const currentTagSet = new Set(input.currentLineupTags);
  const currentByTag = new Map(input.currentLineupTags.map((tag, index) => [tag, index]));
  const currentEntries = input.roster
    .filter((entry) => currentTagSet.has(entry.playerTag))
    .sort((a, b) => {
      const aIndex = currentByTag.get(a.playerTag) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = currentByTag.get(b.playerTag) ?? Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex;
    });
  const remainingEntries = input.roster
    .filter((entry) => !currentTagSet.has(entry.playerTag))
    .sort((a, b) => {
      if (a.daysParticipated !== b.daysParticipated) {
        return a.daysParticipated - b.daysParticipated;
      }
      const byName = a.playerName.localeCompare(b.playerName, undefined, {
        sensitivity: "base",
      });
      if (byName !== 0) return byName;
      return a.playerTag.localeCompare(b.playerTag);
    });
  return [...currentEntries, ...remainingEntries];
}

function buildPlanDays(input: {
  roster: CwlSeasonRosterEntry[];
  lineupSize: number;
  currentRoundDay: number;
  currentLineupTags: string[];
}): Array<{ roundDay: number; members: CwlSeasonRosterEntry[] }> {
  const stableRoster = buildStableRosterOrder({
    roster: input.roster,
    currentLineupTags: input.currentLineupTags,
  });
  const stableIndexByTag = new Map(
    stableRoster.map((entry, index) => [entry.playerTag, index]),
  );
  const totalCountByTag = new Map(
    stableRoster.map((entry) => [entry.playerTag, Math.max(0, entry.daysParticipated)]),
  );
  const rosterByTag = new Map(stableRoster.map((entry) => [entry.playerTag, entry]));
  const days: Array<{ roundDay: number; members: CwlSeasonRosterEntry[] }> = [];

  const currentDayMembers = input.currentLineupTags
    .map((tag) => rosterByTag.get(tag))
    .filter((entry): entry is CwlSeasonRosterEntry => Boolean(entry))
    .slice(0, input.lineupSize);
  for (const member of currentDayMembers) {
    totalCountByTag.set(member.playerTag, (totalCountByTag.get(member.playerTag) ?? 0) + 1);
  }
  days.push({
    roundDay: input.currentRoundDay,
    members: currentDayMembers,
  });

  for (let roundDay = input.currentRoundDay + 1; roundDay <= 7; roundDay += 1) {
    const selected = [...stableRoster]
      .sort((a, b) => compareRosterEntries(a, b, stableIndexByTag, totalCountByTag))
      .slice(0, input.lineupSize)
      .sort((a, b) => {
        const aIndex = stableIndexByTag.get(a.playerTag) ?? Number.MAX_SAFE_INTEGER;
        const bIndex = stableIndexByTag.get(b.playerTag) ?? Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      });
    for (const member of selected) {
      totalCountByTag.set(member.playerTag, (totalCountByTag.get(member.playerTag) ?? 0) + 1);
    }
    days.push({
      roundDay,
      members: selected,
    });
  }

  return days;
}

function buildCoverageWarnings(input: {
  roster: CwlSeasonRosterEntry[];
  planDays: Array<{ roundDay: number; members: CwlSeasonRosterEntry[] }>;
}): string[] {
  const plannedDaysByTag = new Map<string, number>();
  for (const day of input.planDays) {
    for (const member of day.members) {
      plannedDaysByTag.set(member.playerTag, (plannedDaysByTag.get(member.playerTag) ?? 0) + 1);
    }
  }

  const underCovered = input.roster
    .map((entry) => ({
      playerTag: entry.playerTag,
      playerName: entry.playerName,
      totalDays: entry.daysParticipated + (plannedDaysByTag.get(entry.playerTag) ?? 0),
    }))
    .filter((entry) => entry.totalDays < 5)
    .sort((a, b) => a.totalDays - b.totalDays || a.playerName.localeCompare(b.playerName));
  if (underCovered.length <= 0) return [];

  const names = underCovered
    .map((entry) => `${entry.playerName} (${entry.playerTag}) -> ${entry.totalDays}/5`)
    .join(", ");
  return [
    `Could not reach 5 planned CWL days for: ${names}`,
    "Consider excluding lower-priority players to improve 5-day coverage.",
  ];
}

async function loadActivePlan(input: {
  clanTag: string;
  season: string;
}) {
  return prisma.cwlRotationPlan.findFirst({
    where: {
      clanTag: input.clanTag,
      season: input.season,
      isActive: true,
    },
    orderBy: [{ version: "desc" }],
  });
}

async function loadPlanDaysWithMembers(planId: string) {
  return prisma.cwlRotationPlanDay.findMany({
    where: { planId },
    include: {
      members: {
        orderBy: [{ assignmentOrder: "asc" }, { playerName: "asc" }, { playerTag: "asc" }],
      },
    },
    orderBy: [{ roundDay: "asc" }],
  });
}

/** Purpose: own CWL rotation-plan generation and validation using persisted CWL state only. */
export class CwlRotationService {
  async createPlan(input: {
    clanTag: string;
    excludeTagsRaw?: string | null;
    overwrite?: boolean;
    season?: string;
  }): Promise<CreateCwlRotationPlanResult> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) {
      return { outcome: "not_tracked", season, clanTag: "" };
    }

    const trackedClan = await prisma.cwlTrackedClan.findFirst({
      where: { season, tag: clanTag },
      select: { tag: true },
    });
    if (!trackedClan) {
      return { outcome: "not_tracked", season, clanTag };
    }

    const currentRound = await cwlStateService.getCurrentRoundForClan({ clanTag, season });
    if (!currentRound || !currentRound.roundState.toLowerCase().includes("preparation")) {
      return { outcome: "not_preparation", season, clanTag };
    }

    const existingActivePlan = await loadActivePlan({ clanTag, season });
    if (existingActivePlan && !input.overwrite) {
      return {
        outcome: "blocked_existing",
        season,
        clanTag,
        existingVersion: existingActivePlan.version,
      };
    }

    const rawExcludeTags = String(input.excludeTagsRaw ?? "")
      .split(",")
      .map((value) => normalizePlayerTag(value))
      .filter(Boolean);
    const excludeTags = [...new Set(rawExcludeTags)];
    const roster = await cwlStateService.listSeasonRosterForClan({ clanTag, season });
    const rosterByTag = new Map(roster.map((entry) => [entry.playerTag, entry]));
    const invalidTags = excludeTags.filter((tag) => !rosterByTag.has(tag));
    if (invalidTags.length > 0) {
      return { outcome: "invalid_excludes", season, clanTag, invalidTags };
    }

    const includedRoster = roster.filter((entry) => !excludeTags.includes(entry.playerTag));
    const currentLineupTags = currentRound.members
      .filter((member) => member.subbedIn)
      .map((member) => member.playerTag);
    const lineupSize = Math.max(0, currentLineupTags.length || currentRound.members.length);
    if (includedRoster.length < lineupSize) {
      return {
        outcome: "not_enough_players",
        season,
        clanTag,
        lineupSize,
        availablePlayers: includedRoster.length,
      };
    }

    const version = (existingActivePlan?.version ?? 0) + 1;
    const planDays = buildPlanDays({
      roster: includedRoster,
      lineupSize,
      currentRoundDay: currentRound.roundDay,
      currentLineupTags,
    });
    const warnings = buildCoverageWarnings({
      roster: includedRoster,
      planDays,
    });

    await prisma.$transaction(async (tx) => {
      if (existingActivePlan) {
        await tx.cwlRotationPlan.updateMany({
          where: {
            clanTag,
            season,
            isActive: true,
          },
          data: { isActive: false },
        });
      }

      const createdPlan = await tx.cwlRotationPlan.create({
        data: {
          clanTag,
          season,
          version,
          isActive: true,
          rosterSize: lineupSize,
          generatedFromRoundDay: currentRound.roundDay,
          excludedPlayerTags: excludeTags,
          warningSummary: warnings.join(" | ") || null,
          metadata: {
            createdFromRoundState: currentRound.roundState,
            currentLineupTags,
          },
        },
      });

      for (const day of planDays) {
        const createdDay = await tx.cwlRotationPlanDay.create({
          data: {
            planId: createdPlan.id,
            roundDay: day.roundDay,
            lineupSize,
            locked: day.roundDay < currentRound.roundDay,
            metadata: {
              generatedFromPreparationRoundDay: currentRound.roundDay,
            },
          },
        });
        if (day.members.length > 0) {
          await tx.cwlRotationPlanMember.createMany({
            data: day.members.map((member, index) => ({
              planDayId: createdDay.id,
              playerTag: member.playerTag,
              playerName: member.playerName,
              assignmentOrder: index,
              manualOverride: false,
            })),
          });
        }
      }
    });

    return {
      outcome: "created",
      season,
      clanTag,
      version,
      lineupSize,
      warnings,
    };
  }

  /** Purpose: compare one planned day against persisted actual CWL lineup data when available. */
  async validatePlanDay(input: {
    clanTag: string;
    roundDay: number;
    season?: string;
  }): Promise<CwlRotationValidationResult | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;

    const activePlan = await loadActivePlan({ clanTag, season });
    if (!activePlan) return null;
    const planDays = await loadPlanDaysWithMembers(activePlan.id);
    const planDay = planDays.find((day) => day.roundDay === input.roundDay);
    if (!planDay) {
      return {
        season,
        clanTag,
        roundDay: input.roundDay,
        plannedPlayerTags: [],
        plannedPlayerNames: [],
        actualPlayerTags: [],
        actualPlayerNames: [],
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
        complete: false,
        actualAvailable: false,
        currentState: null,
      };
    }

    const actual = await cwlStateService.getActualLineupForDay({
      clanTag,
      season,
      roundDay: input.roundDay,
    });
    const plannedPlayerTags = planDay.members.map((member) => member.playerTag);
    const plannedPlayerNames = planDay.members.map((member) => member.playerName);
    const actualMembers = actual?.members.filter((member) => member.subbedIn) ?? [];
    const actualPlayerTags = actualMembers.map((member) => member.playerTag);
    const actualPlayerNames = actualMembers.map((member) => member.playerName);
    const actualTagSet = new Set(actualPlayerTags);
    const plannedTagSet = new Set(plannedPlayerTags);
    const missingExpectedPlayerTags = plannedPlayerTags.filter((tag) => !actualTagSet.has(tag));
    const extraActualPlayerTags = actualPlayerTags.filter((tag) => !plannedTagSet.has(tag));

    return {
      season,
      clanTag,
      roundDay: input.roundDay,
      plannedPlayerTags,
      plannedPlayerNames,
      actualPlayerTags,
      actualPlayerNames,
      missingExpectedPlayerTags,
      extraActualPlayerTags,
      complete:
        Boolean(actual) &&
        missingExpectedPlayerTags.length <= 0 &&
        extraActualPlayerTags.length <= 0,
      actualAvailable: Boolean(actual),
      currentState: actual?.roundState ?? null,
    };
  }

  /** Purpose: summarize current-day plan-vs-actual status across all active CWL rotation plans. */
  async listOverview(input?: {
    season?: string;
  }): Promise<CwlRotationOverviewEntry[]> {
    const season = input?.season ?? resolveCurrentCwlSeasonKey();
    const activePlans = await prisma.cwlRotationPlan.findMany({
      where: {
        season,
        isActive: true,
      },
      orderBy: [{ clanTag: "asc" }, { version: "desc" }],
    });
    const uniquePlans = new Map<string, typeof activePlans[number]>();
    for (const plan of activePlans) {
      if (!uniquePlans.has(plan.clanTag)) {
        uniquePlans.set(plan.clanTag, plan);
      }
    }

    const entries: CwlRotationOverviewEntry[] = [];
    for (const plan of uniquePlans.values()) {
      const currentRound = await cwlStateService.getCurrentRoundForClan({
        clanTag: plan.clanTag,
        season,
      });
      if (!currentRound) {
        entries.push({
          season,
          clanTag: plan.clanTag,
          clanName: null,
          version: plan.version,
          roundDay: null,
          status: "no_active_round",
          missingExpectedPlayerTags: [],
          extraActualPlayerTags: [],
        });
        continue;
      }
      const validation = await this.validatePlanDay({
        clanTag: plan.clanTag,
        season,
        roundDay: currentRound.roundDay,
      });
      if (!validation || validation.plannedPlayerTags.length <= 0) {
        entries.push({
          season,
          clanTag: plan.clanTag,
          clanName: currentRound.clanName,
          version: plan.version,
          roundDay: currentRound.roundDay,
          status: "no_plan_day",
          missingExpectedPlayerTags: [],
          extraActualPlayerTags: [],
        });
        continue;
      }
      entries.push({
        season,
        clanTag: plan.clanTag,
        clanName: currentRound.clanName,
        version: plan.version,
        roundDay: currentRound.roundDay,
        status: validation.complete ? "complete" : "mismatch",
        missingExpectedPlayerTags: validation.missingExpectedPlayerTags,
        extraActualPlayerTags: validation.extraActualPlayerTags,
      });
    }
    return entries.sort((a, b) => a.clanTag.localeCompare(b.clanTag));
  }

  /** Purpose: expose one active plan with ordered day/member assignments for command rendering. */
  async getActivePlanView(input: {
    clanTag: string;
    season?: string;
  }): Promise<{
    season: string;
    clanTag: string;
    version: number;
    warningSummary: string | null;
    excludedPlayerTags: string[];
    days: Array<{
      roundDay: number;
      lineupSize: number;
      members: Array<{ playerTag: string; playerName: string }>;
      actual: CwlActualLineup | null;
    }>;
  } | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;

    const activePlan = await loadActivePlan({ clanTag, season });
    if (!activePlan) return null;
    const planDays = await loadPlanDaysWithMembers(activePlan.id);
    const days = [];
    for (const day of planDays) {
      const actual = await cwlStateService.getActualLineupForDay({
        clanTag,
        season,
        roundDay: day.roundDay,
      });
      days.push({
        roundDay: day.roundDay,
        lineupSize: day.lineupSize,
        members: day.members.map((member) => ({
          playerTag: member.playerTag,
          playerName: member.playerName,
        })),
        actual,
      });
    }

    return {
      season,
      clanTag,
      version: activePlan.version,
      warningSummary: activePlan.warningSummary,
      excludedPlayerTags: activePlan.excludedPlayerTags,
      days,
    };
  }
}

export const cwlRotationService = new CwlRotationService();
