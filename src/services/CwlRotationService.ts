import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { cwlStateService, type CwlActualLineup, type CwlSeasonRosterEntry } from "./CwlStateService";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";

type CwlRotationPlanPlayerRow = {
  playerTag: string;
  playerName: string;
  assignmentOrder: number;
  manualOverride?: boolean;
};

type CwlRotationPlanDayWriteInput = {
  roundDay: number;
  lineupSize: number;
  locked: boolean;
  metadata: Prisma.InputJsonValue;
  members: CwlRotationPlanPlayerRow[];
};

type CwlRotationPlanWriteInput = {
  clanTag: string;
  season: string;
  version: number;
  overwriteExisting: boolean;
  rosterSize: number;
  generatedFromRoundDay: number | null;
  excludedPlayerTags: string[];
  warningSummary: string | null;
  metadata: Prisma.InputJsonValue;
  days: CwlRotationPlanDayWriteInput[];
};

export type CwlRotationPlanExportDayRow = {
  playerTag: string;
  playerName: string;
  subbedOut: boolean;
  assignmentOrder: number;
};

export type CwlRotationPlanExportDay = {
  roundDay: number;
  lineupSize: number;
  locked: boolean;
  rows: CwlRotationPlanExportDayRow[];
  metadata: Record<string, unknown> | null;
};

export type CwlRotationPlanExport = {
  season: string;
  clanTag: string;
  clanName: string | null;
  version: number;
  rosterSize: number;
  generatedFromRoundDay: number | null;
  excludedPlayerTags: string[];
  warningSummary: string | null;
  metadata: Record<string, unknown> | null;
  days: CwlRotationPlanExportDay[];
};

type CwlRotationPlanWriteTx = Prisma.TransactionClient;

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

export type PersistImportedCwlRotationPlanResult =
  | {
      outcome: "created";
      season: string;
      clanTag: string;
      clanName: string | null;
      version: number;
      dayCount: number;
      warnings: string[];
      sourceTabName: string;
    }
  | {
      outcome: "blocked_existing";
      season: string;
      clanTag: string;
      clanName: string | null;
      existingVersion: number;
      sourceTabName: string;
    }
  | {
      outcome: "not_tracked";
      season: string;
      clanTag: string;
      clanName: string | null;
      sourceTabName: string;
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
  battleDayStartAt: Date | null;
  leaderNames: string[];
  status: "complete" | "mismatch" | "no_active_round" | "no_plan_day";
  missingExpectedPlayerTags: string[];
  extraActualPlayerTags: string[];
};

function normalizeClanMemberRole(input: unknown): "leader" | "coleader" | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "leader") return "leader";
  if (normalized === "coleader") return "coleader";
  return null;
}

const fwaClanMembersSyncService = new FwaClanMembersSyncService();

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
  seedRoundAlreadyCountedInParticipation?: boolean;
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
  if (!input.seedRoundAlreadyCountedInParticipation) {
    for (const member of currentDayMembers) {
      totalCountByTag.set(member.playerTag, (totalCountByTag.get(member.playerTag) ?? 0) + 1);
    }
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
  currentRoundDay: number;
  seedRoundAlreadyCountedInParticipation?: boolean;
}): string[] {
  const plannedDaysByTag = new Map<string, number>();
  for (const day of input.planDays) {
    if (input.seedRoundAlreadyCountedInParticipation && day.roundDay === input.currentRoundDay) {
      continue;
    }
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

function buildRosterRowsForMetadata(roster: CwlSeasonRosterEntry[]): Array<{
  playerTag: string;
  playerName: string;
}> {
  return roster.map((entry) => ({
    playerTag: entry.playerTag,
    playerName: entry.playerName,
  }));
}

function shouldShowRotationSubbedOutMember(input: {
  playerTag: string;
  excludedPlayerTags: string[];
  scheduledInTagSet: Set<string>;
}): boolean {
  const playerTag = normalizePlayerTag(input.playerTag);
  if (!playerTag) return false;
  const excludedTagSet = new Set(
    input.excludedPlayerTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean),
  );
  if (excludedTagSet.has(playerTag)) return false;
  return input.scheduledInTagSet.has(playerTag);
}

function buildRotationShowScheduledInTagSet(input: {
  days: Array<{
    rows: Array<{
      playerTag: string;
      subbedOut: boolean;
    }>;
  }>;
}): Set<string> {
  const scheduledInTagSet = new Set<string>();
  for (const day of input.days) {
    for (const row of day.rows) {
      if (row.subbedOut) continue;
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      scheduledInTagSet.add(playerTag);
    }
  }
  return scheduledInTagSet;
}

function sanitizeDisplayText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function toRecordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeRosterRows(value: unknown): Array<{
  playerTag: string;
  playerName: string;
}> {
  if (!Array.isArray(value)) return [];
  const rows = value
    .map((row) => {
      const record = toRecordValue(row);
      if (!record) return null;
      const playerTag = normalizePlayerTag(String(record.playerTag ?? ""));
      if (!playerTag) return null;
      const playerName = sanitizeDisplayText(record.playerName);
      return {
        playerTag,
        playerName: playerName || playerTag,
      };
    })
    .filter((row): row is { playerTag: string; playerName: string } => Boolean(row));
  return [...new Map(rows.map((row) => [row.playerTag, row])).values()];
}

function normalizeExportRows(value: unknown): CwlRotationPlanExportDayRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row, index) => {
      const record = toRecordValue(row);
      if (!record) return null;
      const playerTag = normalizePlayerTag(String(record.playerTag ?? ""));
      if (!playerTag) return null;
      const playerName = sanitizeDisplayText(record.playerName) || playerTag;
      const subbedOut =
        typeof record.subbedOut === "boolean"
          ? record.subbedOut
          : typeof record.subbedOut === "string"
            ? ["1", "true", "yes", "y", "x"].includes(record.subbedOut.trim().toLowerCase())
            : false;
      const assignmentOrder =
        typeof record.assignmentOrder === "number"
          ? Math.trunc(record.assignmentOrder)
          : index;
      return {
        playerTag,
        playerName,
        subbedOut,
        assignmentOrder,
      };
    })
    .filter((row): row is CwlRotationPlanExportDayRow => Boolean(row));
}

function buildExportRowsFromMembersAndRoster(input: {
  dayMembers: Array<{
    playerTag: string;
    playerName: string;
    assignmentOrder: number;
    manualOverride?: boolean;
  }>;
  rosterRows: Array<{
    playerTag: string;
    playerName: string;
  }>;
}): CwlRotationPlanExportDayRow[] {
  const activeMemberByTag = new Map(
    input.dayMembers.map((member) => [member.playerTag, member]),
  );
  const rows: CwlRotationPlanExportDayRow[] = [];
  const seenTags = new Set<string>();

  for (const rosterRow of input.rosterRows) {
    const activeMember = activeMemberByTag.get(rosterRow.playerTag);
    rows.push({
      playerTag: rosterRow.playerTag,
      playerName: rosterRow.playerName,
      subbedOut: !activeMember,
      assignmentOrder: activeMember?.assignmentOrder ?? rows.length,
    });
    seenTags.add(rosterRow.playerTag);
  }

  for (const member of [...input.dayMembers].sort((a, b) => a.assignmentOrder - b.assignmentOrder)) {
    if (seenTags.has(member.playerTag)) continue;
    rows.push({
      playerTag: member.playerTag,
      playerName: member.playerName,
      subbedOut: false,
      assignmentOrder: member.assignmentOrder,
    });
  }

  return rows;
}

async function persistRotationPlanVersion(
  tx: CwlRotationPlanWriteTx,
  input: CwlRotationPlanWriteInput,
): Promise<{ version: number }> {
  if (input.overwriteExisting) {
    await tx.cwlRotationPlan.updateMany({
      where: {
        clanTag: input.clanTag,
        season: input.season,
        isActive: true,
      },
      data: { isActive: false },
    });
  }

  const createdPlan = await tx.cwlRotationPlan.create({
    data: {
      clanTag: input.clanTag,
      season: input.season,
      version: input.version,
      isActive: true,
      rosterSize: input.rosterSize,
      generatedFromRoundDay: input.generatedFromRoundDay,
      excludedPlayerTags: input.excludedPlayerTags,
      warningSummary: input.warningSummary,
      metadata: input.metadata,
    },
  });

  for (const day of input.days) {
    const createdDay = await tx.cwlRotationPlanDay.create({
      data: {
        planId: createdPlan.id,
        roundDay: day.roundDay,
        lineupSize: day.lineupSize,
        locked: day.locked,
        metadata: day.metadata,
      },
    });
    if (day.members.length > 0) {
      await tx.cwlRotationPlanMember.createMany({
        data: day.members.map((member) => ({
          planDayId: createdDay.id,
          playerTag: member.playerTag,
          playerName: member.playerName,
          assignmentOrder: member.assignmentOrder,
          manualOverride: Boolean(member.manualOverride),
        })),
      });
    }
  }

  return { version: input.version };
}

/** Purpose: own CWL rotation-plan generation and validation using persisted CWL state only. */
export class CwlRotationService {
  /** Purpose: determine which planned day rows should be rendered for CWL show pages. */
  getVisibleRotationShowDayRows(input: {
    excludedPlayerTags: string[];
    days: Array<{
      rows: Array<{
        playerTag: string;
        playerName: string;
        subbedOut: boolean;
        assignmentOrder: number;
      }>;
    }>;
    day: {
      rows: Array<{
        playerTag: string;
        playerName: string;
        subbedOut: boolean;
        assignmentOrder: number;
      }>;
    };
  }): Array<{
    playerTag: string;
    playerName: string;
    subbedOut: boolean;
    assignmentOrder: number;
  }> {
    const scheduledInTagSet = buildRotationShowScheduledInTagSet({
      days: input.days,
    });
    return input.day.rows.filter((row) => {
      if (!row.subbedOut) return true;
      return shouldShowRotationSubbedOutMember({
        playerTag: row.playerTag,
        excludedPlayerTags: input.excludedPlayerTags,
        scheduledInTagSet,
      });
    });
  }

  async getPreferredDisplayDay(input: {
    clanTag: string;
    season?: string;
  }): Promise<number | null> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) return null;

    const [currentRound, prepSnapshot] = await Promise.all([
      cwlStateService.getCurrentRoundForClan({ clanTag, season }),
      cwlStateService.getCurrentPreparationSnapshotForClan({ clanTag, season }),
    ]);
    return prepSnapshot?.roundDay ?? currentRound?.roundDay ?? null;
  }

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

    const [currentRound, prepSnapshot] = await Promise.all([
      cwlStateService.getCurrentRoundForClan({ clanTag, season }),
      cwlStateService.getCurrentPreparationSnapshotForClan({ clanTag, season }),
    ]);
    const currentRoundState = currentRound?.roundState.toLowerCase() ?? "";
    const hasOverlapPreparation =
      currentRound !== null &&
      currentRoundState.includes("inwar") &&
      prepSnapshot !== null &&
      prepSnapshot.roundDay > currentRound.roundDay;
    const hasPreparationWindow =
      currentRoundState.includes("preparation") || hasOverlapPreparation;
    if (!currentRound || !hasPreparationWindow) {
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
    const seedRoundAlreadyCountedInParticipation = hasOverlapPreparation;
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
      seedRoundAlreadyCountedInParticipation,
    });
    const warnings = buildCoverageWarnings({
      roster: includedRoster,
      planDays,
      currentRoundDay: currentRound.roundDay,
      seedRoundAlreadyCountedInParticipation,
    });
    const rosterRows = buildRosterRowsForMetadata(includedRoster);

    await prisma.$transaction(async (tx) => {
      await persistRotationPlanVersion(tx, {
        clanTag,
        season,
        version,
        overwriteExisting: Boolean(existingActivePlan),
        rosterSize: lineupSize,
        generatedFromRoundDay: currentRound.roundDay,
        excludedPlayerTags: excludeTags,
        warningSummary: warnings.join(" | ") || null,
        metadata: {
          source: "manual",
          clanName: currentRound.clanName,
          createdFromRoundState: currentRound.roundState,
          hasOverlapPreparation,
          currentLineupTags,
          rosterRows,
        } as Prisma.InputJsonValue,
        days: planDays.map((day) => ({
          roundDay: day.roundDay,
          lineupSize,
          locked: hasOverlapPreparation
            ? day.roundDay <= currentRound.roundDay
            : day.roundDay < currentRound.roundDay,
          metadata: {
            source: "manual",
            generatedFromRoundDay: currentRound.roundDay,
          } as Prisma.InputJsonValue,
          members: day.members.map((member, index) => ({
            playerTag: member.playerTag,
            playerName: member.playerName,
            assignmentOrder: index,
            manualOverride: false,
          })),
        })),
      });
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

  /** Purpose: persist one confirmed imported CWL planner plan into the active-season planner tables. */
  async persistImportedPlan(input: {
    clanTag: string;
    clanName: string | null;
    sourceSheetId: string;
    sourceSheetTitle: string | null;
    sourceTabName: string;
    season?: string;
    overwrite?: boolean;
    generatedFromRoundDay?: number | null;
    warningSummary?: string | null;
    metadata?: Prisma.InputJsonValue;
    rosterRows: Array<{
      playerTag: string;
      playerName: string;
    }>;
    days: Array<{
      roundDay: number;
      lineupSize: number;
      locked: boolean;
      rows: Array<{
        playerTag: string;
        playerName: string;
        subbedOut: boolean;
        assignmentOrder: number;
      }>;
      activeMembers: Array<{
        playerTag: string;
        playerName: string;
        assignmentOrder: number;
      }>;
    }>;
  }): Promise<PersistImportedCwlRotationPlanResult> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const clanTag = normalizeClanTag(input.clanTag);
    if (!clanTag) {
      return {
        outcome: "not_tracked",
        season,
        clanTag: "",
        clanName: input.clanName,
        sourceTabName: input.sourceTabName,
      };
    }

    const trackedClan = await prisma.cwlTrackedClan.findFirst({
      where: { season, tag: clanTag },
      select: { tag: true },
    });
    if (!trackedClan) {
      return {
        outcome: "not_tracked",
        season,
        clanTag,
        clanName: input.clanName,
        sourceTabName: input.sourceTabName,
      };
    }

    const existingActivePlan = await loadActivePlan({ clanTag, season });
    if (existingActivePlan && !input.overwrite) {
      return {
        outcome: "blocked_existing",
        season,
        clanTag,
        clanName: input.clanName,
        existingVersion: existingActivePlan.version,
        sourceTabName: input.sourceTabName,
      };
    }

    const activeDays: CwlRotationPlanDayWriteInput[] = input.days.map((day) => ({
      roundDay: day.roundDay,
      lineupSize: day.lineupSize,
      locked: day.locked,
      metadata: {
        source: "sheet-import",
        sheetId: input.sourceSheetId,
        sheetTitle: input.sourceSheetTitle,
        tabName: input.sourceTabName,
        roundDay: day.roundDay,
        rows: day.rows,
      } as Prisma.InputJsonValue,
      members: day.activeMembers.map((member, index) => ({
        playerTag: member.playerTag,
        playerName: member.playerName,
        assignmentOrder: member.assignmentOrder ?? index,
        manualOverride: false,
      })),
    }));
    const rosterRows = [...new Map(input.rosterRows.map((row) => [row.playerTag, row])).values()];
    const activeMemberCountByDay = activeDays.map((day) => day.members.length);
    const rosterSize = Math.max(...activeMemberCountByDay, 0);
    const version = (existingActivePlan?.version ?? 0) + 1;
    const warningSummary = input.warningSummary?.trim() || null;
    const inputMetadata = toRecordValue(input.metadata);
    const metadata = ({
      source: "sheet-import",
      sheetId: input.sourceSheetId,
      sheetTitle: input.sourceSheetTitle,
      tabName: input.sourceTabName,
      clanName: input.clanName,
      rosterRows,
      ...(inputMetadata ?? {}),
    } as Prisma.InputJsonValue);

    await prisma.$transaction(async (tx) => {
      await persistRotationPlanVersion(tx, {
        clanTag,
        season,
        version,
        overwriteExisting: Boolean(existingActivePlan),
        rosterSize,
        generatedFromRoundDay: input.generatedFromRoundDay ?? null,
        excludedPlayerTags: [],
        warningSummary,
        metadata,
        days: activeDays,
      });
    });

    return {
      outcome: "created",
      season,
      clanTag,
      clanName: input.clanName,
      version,
      dayCount: input.days.length,
      warnings: warningSummary ? [warningSummary] : [],
      sourceTabName: input.sourceTabName,
    };
  }

  /** Purpose: summarize active plan data for sheet export without hydrating live lineup state. */
  async listActivePlanExports(input?: {
    season?: string;
    clanTags?: string[];
  }): Promise<CwlRotationPlanExport[]> {
    const season = input?.season ?? resolveCurrentCwlSeasonKey();
    const clanTags = [...new Set((input?.clanTags ?? []).map((tag) => normalizeClanTag(tag)).filter(Boolean))];
    const activePlans = await prisma.cwlRotationPlan.findMany({
      where: {
        season,
        isActive: true,
        ...(clanTags.length > 0 ? { clanTag: { in: clanTags } } : {}),
      },
      orderBy: [{ clanTag: "asc" }, { version: "desc" }],
    });

    const uniquePlans = new Map<string, (typeof activePlans)[number]>();
    for (const plan of activePlans) {
      if (!uniquePlans.has(plan.clanTag)) {
        uniquePlans.set(plan.clanTag, plan);
      }
    }

    const exports: CwlRotationPlanExport[] = [];
    for (const plan of uniquePlans.values()) {
      const days = await loadPlanDaysWithMembers(plan.id);
      const planMetadata = toRecordValue(plan.metadata);
      const rosterRows = normalizeRosterRows(
        Array.isArray(planMetadata?.rosterRows) ? planMetadata.rosterRows : [],
      );
      const clanName =
        sanitizeDisplayText(String(planMetadata?.clanName ?? "")) ||
        null;
      exports.push({
        season: plan.season,
        clanTag: plan.clanTag,
        clanName,
        version: plan.version,
        rosterSize: plan.rosterSize,
        generatedFromRoundDay: plan.generatedFromRoundDay ?? null,
        excludedPlayerTags: [...plan.excludedPlayerTags],
        warningSummary: plan.warningSummary ?? null,
        metadata: planMetadata,
        days: days.map((day) => {
          const dayMetadata = toRecordValue(day.metadata);
          const rowSource = normalizeExportRows(
            Array.isArray(dayMetadata?.rows) ? dayMetadata.rows : [],
          );
          const rows =
            rowSource.length > 0
              ? rowSource
              : buildExportRowsFromMembersAndRoster({
                  dayMembers: day.members.map((member) => ({
                    playerTag: member.playerTag,
                    playerName: member.playerName,
                    assignmentOrder: member.assignmentOrder,
                    manualOverride: member.manualOverride,
                  })),
                  rosterRows,
                });
          return {
            roundDay: day.roundDay,
            lineupSize: day.lineupSize,
            locked: day.locked,
        metadata: dayMetadata,
            rows,
          };
        }),
      });
    }

    return exports.sort((a, b) => a.clanTag.localeCompare(b.clanTag));
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
    refreshLeadershipMembers?: boolean;
  }): Promise<CwlRotationOverviewEntry[]> {
    const season = input?.season ?? resolveCurrentCwlSeasonKey();
    const activePlans = await prisma.cwlRotationPlan.findMany({
      where: {
        season,
        isActive: true,
      },
      orderBy: [{ clanTag: "asc" }, { version: "desc" }],
    });
    const clanTags = [...new Set(activePlans.map((plan) => plan.clanTag).filter(Boolean))];
    const uniquePlans = new Map<string, typeof activePlans[number]>();
    for (const plan of activePlans) {
      if (!uniquePlans.has(plan.clanTag)) {
        uniquePlans.set(plan.clanTag, plan);
      }
    }

    const failedLeadershipClanTags = new Set<string>();
    if (input?.refreshLeadershipMembers && clanTags.length > 0) {
      try {
        const refreshResult = await fwaClanMembersSyncService.refreshCurrentClanMembersForClanTags(
          clanTags,
        );
        for (const clanTag of refreshResult.failedClans) {
          failedLeadershipClanTags.add(clanTag);
        }
        console.info(
          `[cwl] overview leadership refresh requested=${refreshResult.clanCount} rows=${refreshResult.rowCount} changed=${refreshResult.changedRowCount} failed=${refreshResult.failedClans.length}`,
        );
      } catch (error) {
        for (const clanTag of clanTags) {
          failedLeadershipClanTags.add(clanTag);
        }
        console.warn(
          `[cwl] overview leadership refresh failed requested=${clanTags.length} error=${String(
            (error as { message?: unknown })?.message ?? error,
          ).slice(0, 200)}`,
        );
      }
    }

    const leaderRows = clanTags.length > 0
      ? await prisma.fwaClanMemberCurrent.findMany({
          where: {
            clanTag: { in: clanTags },
            role: { not: null },
          },
          select: {
            clanTag: true,
            playerTag: true,
            playerName: true,
            role: true,
          },
          orderBy: [
            { clanTag: "asc" },
            { role: "asc" },
            { playerName: "asc" },
            { playerTag: "asc" },
          ],
        })
      : [];
    const leaderNamesByClanTag = new Map<string, string[]>();
    const leaderRowsByClanTag = new Map<
      string,
      Array<{ roleRank: number; playerName: string; playerTag: string }>
    >();
    for (const row of leaderRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      const role = normalizeClanMemberRole(row.role);
      if (!clanTag || !role) continue;
      const roleRank = role === "leader" ? 0 : 1;
      const entries = leaderRowsByClanTag.get(clanTag) ?? [];
      entries.push({
        roleRank,
        playerName: String(row.playerName ?? "").trim() || row.playerTag,
        playerTag: String(row.playerTag ?? "").trim() || "",
      });
      leaderRowsByClanTag.set(clanTag, entries);
    }
    for (const [clanTag, rows] of leaderRowsByClanTag.entries()) {
      leaderNamesByClanTag.set(
        clanTag,
        rows
          .sort((a, b) => {
            if (a.roleRank !== b.roleRank) return a.roleRank - b.roleRank;
            const byName = a.playerName.localeCompare(b.playerName, undefined, { sensitivity: "base" });
            if (byName !== 0) return byName;
            return a.playerTag.localeCompare(b.playerTag);
          })
          .map((row) => row.playerName),
      );
    }

    const entries: CwlRotationOverviewEntry[] = [];
    for (const plan of uniquePlans.values()) {
      const refreshFailed = failedLeadershipClanTags.has(plan.clanTag);
      const leaderRowsForClan = leaderRowsByClanTag.get(plan.clanTag) ?? [];
      const leaderNames = refreshFailed ? [] : leaderNamesByClanTag.get(plan.clanTag) ?? [];
      if (input?.refreshLeadershipMembers) {
        console.info(
          `[cwl] overview leadership clan=${plan.clanTag} persisted_rows=${leaderRowsForClan.length} refresh_failed=${refreshFailed ? "yes" : "no"}`,
        );
      }
      const [currentRound, preferredDay] = await Promise.all([
        cwlStateService.getCurrentRoundForClan({
          clanTag: plan.clanTag,
          season,
        }),
        this.getPreferredDisplayDay({
          clanTag: plan.clanTag,
          season,
        }),
      ]);
      if (!currentRound) {
        entries.push({
          season,
          clanTag: plan.clanTag,
          clanName: null,
          version: plan.version,
          roundDay: null,
          battleDayStartAt: null,
          leaderNames,
          status: "no_active_round",
          missingExpectedPlayerTags: [],
          extraActualPlayerTags: [],
        });
        continue;
      }
      const targetRoundDay = preferredDay ?? currentRound.roundDay;
      const [validation, battleDayStartAt] = await Promise.all([
        this.validatePlanDay({
          clanTag: plan.clanTag,
          season,
          roundDay: targetRoundDay,
        }),
        cwlStateService.getBattleDayStartForClanDay({
          clanTag: plan.clanTag,
          season,
          roundDay: targetRoundDay,
        }),
      ]);
      if (!validation || validation.plannedPlayerTags.length <= 0) {
        entries.push({
          season,
          clanTag: plan.clanTag,
          clanName: currentRound.clanName,
          version: plan.version,
          roundDay: targetRoundDay,
          battleDayStartAt,
          leaderNames,
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
        roundDay: targetRoundDay,
        battleDayStartAt,
        leaderNames,
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
