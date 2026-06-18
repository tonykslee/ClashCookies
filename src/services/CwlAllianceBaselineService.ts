import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePersistedPlayerName,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { deriveState } from "./war-events/core";

type Logger = Pick<Console, "info" | "warn" | "error">;

export type CwlAllianceBaselineCoverageStatus = "CAPTURED" | "UNAVAILABLE";
export type CwlAllianceBaselineSourceType =
  | "CURRENT_FWA_WAR"
  | "LATEST_FWA_WAR";

export type CwlAllianceBaselineCoverageSummary = {
  clanTag: string;
  clanName: string | null;
  captureStatus: CwlAllianceBaselineCoverageStatus;
  sourceType: CwlAllianceBaselineSourceType | null;
  sourceWarId: number | null;
  sourceWarStartTime: Date | null;
  sourceWarEndTime: Date | null;
  sourceOpponentTag: string | null;
  sourceObservedAt: Date | null;
  rosterSize: number;
  failureReason: string | null;
};

export type CwlAllianceBaselineMemberSummary = {
  playerTag: string;
  playerName: string;
  townHall: number | null;
  position: number | null;
  linkedDiscordUserId: string | null;
};

export type CwlAllianceBaselineCaptureSummary = {
  baselineId: string;
  guildId: string;
  season: string;
  capturedAt: Date;
  trackedClanCount: number;
  capturedClanCount: number;
  unavailableClanCount: number;
  memberAccountCount: number;
  linkedAccountCount: number;
  currentWarSourceCount: number;
  latestWarFallbackCount: number;
  coverageSummaries: CwlAllianceBaselineCoverageSummary[];
  reusedExistingBaseline: boolean;
};

export class CwlAllianceBaselineValidationError extends Error {
  readonly code: string = "cwl_alliance_baseline_validation_error";

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CwlAllianceBaselineValidationError";
  }
}

export class CwlAllianceBaselineDuplicatePlayerTagError extends CwlAllianceBaselineValidationError {
  readonly code: string = "cwl_alliance_baseline_duplicate_player_tag";

  constructor(
    message: string,
    readonly conflicts: Array<{ playerTag: string; clanTags: string[] }>,
  ) {
    super(message, { conflicts });
    this.name = "CwlAllianceBaselineDuplicatePlayerTagError";
  }
}

type NormalizedTrackedClanRow = {
  clanTag: string;
  originalTag: string;
  clanName: string | null;
  validQueryTag: string | null;
};

type CurrentWarRow = {
  guildId: string;
  clanTag: string;
  warId: number | null;
  matchType: string | null;
  state: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  clanName: string | null;
  prepStartTime: Date | null;
  startTime: Date | null;
  endTime: Date | null;
};

type CurrentRosterMemberRow = {
  position: number;
  playerTag: string;
  playerName: string;
  townHall: number | null;
};

type CurrentRosterRow = {
  clanTag: string;
  clanName: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  rosterSize: number;
  observedAt: Date;
  sourceUpdatedAt: Date | null;
  members: CurrentRosterMemberRow[];
};

type HistoryRow = {
  warId: number;
  clanTag: string;
  clanName: string | null;
  opponentTag: string | null;
  opponentName: string | null;
  matchType: string | null;
  warStartTime: Date;
  warEndTime: Date | null;
  updatedAt: Date;
};

type ParticipationRow = {
  warId: string;
  clanTag: string;
  playerTag: string;
  playerName: string | null;
  playerPosition: number | null;
  townHall: number | null;
  attacksUsed: number;
};

type ExistingBaselineMemberRow = {
  id: string;
  baselineId: string;
  baselineClanId: string;
  playerTag: string;
  playerName: string;
  townHall: number | null;
  position: number | null;
  linkedDiscordUserId: string | null;
  createdAt: Date;
};

type ExistingBaselineClanRow = {
  id: string;
  clanTag: string;
  clanName: string | null;
  captureStatus: CwlAllianceBaselineCoverageStatus;
  sourceType: CwlAllianceBaselineSourceType | null;
  sourceWarId: number | null;
  sourceWarStartTime: Date | null;
  sourceWarEndTime: Date | null;
  sourceOpponentTag: string | null;
  sourceObservedAt: Date | null;
  rosterSize: number;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: ExistingBaselineMemberRow[];
};

type ExistingBaselineRow = {
  id: string;
  guildId: string;
  season: string;
  capturedAt: Date;
  capturedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  clans: ExistingBaselineClanRow[];
};

type CandidateMemberRow = CwlAllianceBaselineMemberSummary & {
  id: string;
  baselineId: string;
  baselineClanId: string;
};

type CandidateClanRow = CwlAllianceBaselineCoverageSummary & {
  id: string;
  baselineId: string;
};

type CandidateSnapshot = {
  baselineId: string;
  clans: CandidateClanRow[];
  members: CandidateMemberRow[];
};

function normalizeGuildId(input: string | null | undefined): string {
  const guildId = String(input ?? "").trim();
  if (!guildId) {
    throw new CwlAllianceBaselineValidationError("guildId is required.", {
      field: "guildId",
    });
  }
  return guildId;
}

function normalizeSeasonKey(input: string | null | undefined): string {
  const season = String(input ?? "").trim();
  if (!season) return resolveCurrentCwlSeasonKey();
  if (!/^\d{4}-\d{2}$/.test(season)) {
    throw new CwlAllianceBaselineValidationError(
      "season must use canonical CWL YYYY-MM format.",
      { field: "season", season },
    );
  }
  return season;
}

function normalizeCapturedByUserId(
  input: string | null | undefined,
): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeDiscordUserId(raw);
  if (!normalized) {
    throw new CwlAllianceBaselineValidationError(
      "capturedByUserId must be a valid Discord snowflake when provided.",
      { field: "capturedByUserId", capturedByUserId: raw },
    );
  }
  return normalized;
}

function toNullableInt(input: unknown): number | null {
  const numeric = Number(input);
  if (!Number.isFinite(numeric)) return null;
  return Math.trunc(numeric);
}

function toPositiveInt(input: unknown): number | null {
  const numeric = toNullableInt(input);
  if (numeric === null || numeric <= 0) return null;
  return numeric;
}

function formatClanTagForLog(input: string): string {
  return normalizeClanTag(input) || String(input ?? "").trim();
}

function normalizeTrackedClanRows(
  rows: Array<{ tag: string; name: string | null }>,
): NormalizedTrackedClanRow[] {
  return rows.map((row) => {
    const originalTag = String(row.tag ?? "").trim();
    const clanTag = normalizeClanTag(row.tag) || originalTag;
    return {
      clanTag,
      originalTag,
      clanName: row.name?.trim() ? row.name.trim() : null,
      validQueryTag: normalizeClanTag(row.tag) || null,
    };
  });
}

function toTrackedClanQueryTags(
  rows: NormalizedTrackedClanRow[],
): string[] {
  return [
    ...new Set(rows.map((row) => row.validQueryTag).filter((tag): tag is string => Boolean(tag))),
  ];
}

function isCurrentRosterValidated(input: {
  currentWar: CurrentWarRow;
  roster: CurrentRosterRow;
}): boolean {
  if (deriveState(input.currentWar.state ?? null) === "notInWar") {
    return false;
  }
  if (String(input.currentWar.matchType ?? "").toUpperCase() !== "FWA") {
    return false;
  }
  if (!(input.currentWar.startTime instanceof Date)) {
    return false;
  }
  if (!(input.roster.observedAt instanceof Date)) {
    return false;
  }
  if (input.roster.members.length <= 0) {
    return false;
  }
  if (input.roster.members.length !== input.roster.rosterSize) {
    return false;
  }

  const currentOpponentTag = normalizeClanTag(String(input.currentWar.opponentTag ?? ""));
  const rosterOpponentTag = normalizeClanTag(String(input.roster.opponentTag ?? ""));
  const opponentMatches =
    !currentOpponentTag ||
    !rosterOpponentTag ||
    currentOpponentTag === rosterOpponentTag;
  if (!opponentMatches) {
    return false;
  }

  const rosterUpdatedAt =
    input.roster.sourceUpdatedAt ?? input.roster.observedAt ?? null;
  const warAnchorTime =
    input.currentWar.prepStartTime ??
    input.currentWar.startTime ??
    input.currentWar.endTime ??
    null;
  if (
    !(rosterUpdatedAt instanceof Date) ||
    !(warAnchorTime instanceof Date) ||
    rosterUpdatedAt.getTime() < warAnchorTime.getTime()
  ) {
    return false;
  }

  return true;
}

function buildSelectedMembers(input: {
  baselineId: string;
  baselineClanId: string;
  clanTag: string;
  rows: Array<{
    playerTag: string;
    playerName: string | null;
    townHall: number | null;
    position: number | null;
  }>;
  linkedDiscordUserIdByPlayerTag: Map<string, string | null>;
}):
  | { kind: "ok"; members: CandidateMemberRow[] }
  | { kind: "invalid"; reason: string } {
  const seen = new Set<string>();
  const members: CandidateMemberRow[] = [];
  for (const row of input.rows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) {
      return { kind: "invalid", reason: "INVALID_MEMBER_TAG" };
    }
    if (seen.has(playerTag)) {
      return { kind: "invalid", reason: "INVALID_MEMBER_DUPLICATE_TAG" };
    }
    seen.add(playerTag);
    members.push({
      id: randomUUID(),
      baselineId: input.baselineId,
      baselineClanId: input.baselineClanId,
      playerTag,
      playerName:
        normalizePersistedPlayerName(row.playerName) ?? playerTag,
      townHall: row.townHall,
      position: row.position,
      linkedDiscordUserId:
        input.linkedDiscordUserIdByPlayerTag.get(playerTag) ?? null,
    });
  }
  return { kind: "ok", members };
}

function buildCapturedClanSnapshotFromCurrentWar(input: {
  baselineId: string;
  trackedClan: NormalizedTrackedClanRow;
  currentWar: CurrentWarRow;
  roster: CurrentRosterRow;
  linkedDiscordUserIdByPlayerTag: Map<string, string | null>;
}):
  | { kind: "captured"; clan: CandidateClanRow; members: CandidateMemberRow[] }
  | { kind: "unavailable"; reason: string } {
  if (!isCurrentRosterValidated(input)) {
    return { kind: "unavailable", reason: "CURRENT_FWA_WAR_UNVERIFIED" };
  }

  const baselineClanId = randomUUID();
  const selectedMembers = buildSelectedMembers({
    baselineId: input.baselineId,
    baselineClanId,
    clanTag: input.trackedClan.clanTag,
    rows: input.roster.members.map((member) => ({
      playerTag: member.playerTag,
      playerName: member.playerName,
      townHall: member.townHall,
      position: member.position,
    })),
    linkedDiscordUserIdByPlayerTag: input.linkedDiscordUserIdByPlayerTag,
  });
  if (selectedMembers.kind === "invalid") {
    return { kind: "unavailable", reason: selectedMembers.reason };
  }

  const clan: CandidateClanRow = {
    id: baselineClanId,
    baselineId: input.baselineId,
    clanTag: input.trackedClan.clanTag,
    clanName:
      input.roster.clanName ?? input.currentWar.clanName ?? input.trackedClan.clanName,
    captureStatus: "CAPTURED",
    sourceType: "CURRENT_FWA_WAR",
    sourceWarId: toNullableInt(input.currentWar.warId),
    sourceWarStartTime: input.currentWar.startTime,
    sourceWarEndTime: input.currentWar.endTime,
    sourceOpponentTag:
      normalizeClanTag(String(input.currentWar.opponentTag ?? "")) ||
      normalizeClanTag(String(input.roster.opponentTag ?? "")) ||
      null,
    sourceObservedAt: input.roster.observedAt,
    rosterSize: selectedMembers.members.length,
    failureReason: null,
  };

  return { kind: "captured", clan, members: selectedMembers.members };
}

function buildCapturedClanSnapshotFromLatestWar(input: {
  baselineId: string;
  trackedClan: NormalizedTrackedClanRow;
  history: HistoryRow;
  participationRows: ParticipationRow[];
  linkedDiscordUserIdByPlayerTag: Map<string, string | null>;
}):
  | { kind: "captured"; clan: CandidateClanRow; members: CandidateMemberRow[] }
  | { kind: "unavailable"; reason: string } {
  if (String(input.history.matchType ?? "").toUpperCase() !== "FWA") {
    return { kind: "unavailable", reason: "LATEST_FWA_WAR_UNVERIFIED" };
  }
  if (!(input.history.warStartTime instanceof Date)) {
    return { kind: "unavailable", reason: "LATEST_FWA_WAR_UNVERIFIED" };
  }
  if (input.participationRows.length <= 0) {
    return { kind: "unavailable", reason: "LATEST_FWA_WAR_NO_PARTICIPATION" };
  }

  const baselineClanId = randomUUID();
  const selectedMembers = buildSelectedMembers({
    baselineId: input.baselineId,
    baselineClanId,
    clanTag: input.trackedClan.clanTag,
    rows: input.participationRows.map((row) => ({
      playerTag: row.playerTag,
      playerName: row.playerName,
      townHall: row.townHall,
      position: row.playerPosition,
    })),
    linkedDiscordUserIdByPlayerTag: input.linkedDiscordUserIdByPlayerTag,
  });
  if (selectedMembers.kind === "invalid") {
    return { kind: "unavailable", reason: selectedMembers.reason };
  }

  const clan: CandidateClanRow = {
    id: baselineClanId,
    baselineId: input.baselineId,
    clanTag: input.trackedClan.clanTag,
    clanName: input.history.clanName ?? input.trackedClan.clanName,
    captureStatus: "CAPTURED",
    sourceType: "LATEST_FWA_WAR",
    sourceWarId: input.history.warId,
    sourceWarStartTime: input.history.warStartTime,
    sourceWarEndTime: input.history.warEndTime,
    sourceOpponentTag: normalizeClanTag(String(input.history.opponentTag ?? "")) || null,
    sourceObservedAt: input.history.updatedAt,
    rosterSize: selectedMembers.members.length,
    failureReason: null,
  };

  return { kind: "captured", clan, members: selectedMembers.members };
}

function buildUnavailableClanSnapshot(input: {
  baselineId: string;
  trackedClan: NormalizedTrackedClanRow;
  failureReason: string;
}): CandidateClanRow {
  return {
    id: randomUUID(),
    baselineId: input.baselineId,
    clanTag: input.trackedClan.clanTag,
    clanName: input.trackedClan.clanName,
    captureStatus: "UNAVAILABLE",
    sourceType: null,
    sourceWarId: null,
    sourceWarStartTime: null,
    sourceWarEndTime: null,
    sourceOpponentTag: null,
    sourceObservedAt: null,
    rosterSize: 0,
    failureReason: input.failureReason,
  };
}

function buildCoverageSummaryFromStoredClan(
  clan: ExistingBaselineClanRow,
): CwlAllianceBaselineCoverageSummary {
  return {
    clanTag: clan.clanTag,
    clanName: clan.clanName,
    captureStatus: clan.captureStatus,
    sourceType: clan.sourceType ?? null,
    sourceWarId: clan.sourceWarId ?? null,
    sourceWarStartTime: clan.sourceWarStartTime ?? null,
    sourceWarEndTime: clan.sourceWarEndTime ?? null,
    sourceOpponentTag: normalizeClanTag(String(clan.sourceOpponentTag ?? "")) || null,
    sourceObservedAt: clan.sourceObservedAt ?? null,
    rosterSize: clan.rosterSize,
    failureReason: clan.failureReason ?? null,
  };
}

function buildCoverageSummaryFromCandidateClan(
  clan: CandidateClanRow,
): CwlAllianceBaselineCoverageSummary {
  return {
    clanTag: clan.clanTag,
    clanName: clan.clanName,
    captureStatus: clan.captureStatus,
    sourceType: clan.sourceType,
    sourceWarId: clan.sourceWarId,
    sourceWarStartTime: clan.sourceWarStartTime,
    sourceWarEndTime: clan.sourceWarEndTime,
    sourceOpponentTag: clan.sourceOpponentTag,
    sourceObservedAt: clan.sourceObservedAt,
    rosterSize: clan.rosterSize,
    failureReason: clan.failureReason,
  };
}

function summarizeStoredBaseline(input: ExistingBaselineRow): CwlAllianceBaselineCaptureSummary {
  const clans = [...input.clans].sort((left, right) =>
    left.clanTag.localeCompare(right.clanTag),
  );
  const coverageSummaries = clans.map((clan) =>
    buildCoverageSummaryFromStoredClan(clan),
  );
  const memberRows = clans.flatMap((clan) =>
    [...clan.members].sort((left, right) =>
      left.playerTag.localeCompare(right.playerTag),
    ),
  );
  const capturedClanCount = coverageSummaries.filter(
    (clan) => clan.captureStatus === "CAPTURED",
  ).length;
  const unavailableClanCount = coverageSummaries.length - capturedClanCount;
  const currentWarSourceCount = coverageSummaries.filter(
    (clan) => clan.sourceType === "CURRENT_FWA_WAR",
  ).length;
  const latestWarFallbackCount = coverageSummaries.filter(
    (clan) => clan.sourceType === "LATEST_FWA_WAR",
  ).length;
  const linkedAccountCount = memberRows.filter(
    (member) => Boolean(normalizeDiscordUserId(member.linkedDiscordUserId)),
  ).length;

  return {
    baselineId: input.id,
    guildId: input.guildId,
    season: input.season,
    capturedAt: input.capturedAt,
    trackedClanCount: coverageSummaries.length,
    capturedClanCount,
    unavailableClanCount,
    memberAccountCount: memberRows.length,
    linkedAccountCount,
    currentWarSourceCount,
    latestWarFallbackCount,
    coverageSummaries,
    reusedExistingBaseline: true,
  };
}

function summarizeCandidateSnapshot(input: {
  baseline: {
    id: string;
    guildId: string;
    season: string;
    capturedAt: Date;
  };
  clans: CandidateClanRow[];
  members: CandidateMemberRow[];
}): CwlAllianceBaselineCaptureSummary {
  const coverageSummaries = [...input.clans]
    .sort((left, right) => left.clanTag.localeCompare(right.clanTag))
    .map((clan) => buildCoverageSummaryFromCandidateClan(clan));
  const capturedClanCount = coverageSummaries.filter(
    (clan) => clan.captureStatus === "CAPTURED",
  ).length;
  const unavailableClanCount = coverageSummaries.length - capturedClanCount;
  const linkedAccountCount = input.members.filter((member) =>
    Boolean(normalizeDiscordUserId(member.linkedDiscordUserId)),
  ).length;
  const currentWarSourceCount = coverageSummaries.filter(
    (clan) => clan.sourceType === "CURRENT_FWA_WAR",
  ).length;
  const latestWarFallbackCount = coverageSummaries.filter(
    (clan) => clan.sourceType === "LATEST_FWA_WAR",
  ).length;

  return {
    baselineId: input.baseline.id,
    guildId: input.baseline.guildId,
    season: input.baseline.season,
    capturedAt: input.baseline.capturedAt,
    trackedClanCount: coverageSummaries.length,
    capturedClanCount,
    unavailableClanCount,
    memberAccountCount: input.members.length,
    linkedAccountCount,
    currentWarSourceCount,
    latestWarFallbackCount,
    coverageSummaries,
    reusedExistingBaseline: false,
  };
}

function detectDuplicateMemberTagsAcrossClans(
  clanRows: CandidateClanRow[],
  memberRows: CandidateMemberRow[],
): Array<{ playerTag: string; clanTags: string[] }> {
  const clanTagByPlayerTag = new Map<string, string[]>();
  const clanTagByClanId = new Map(
    clanRows.map((clan) => [clan.id, clan.clanTag] as const),
  );
  for (const member of memberRows) {
    const clanTag = clanTagByClanId.get(member.baselineClanId) ?? "unknown";
    const list = clanTagByPlayerTag.get(member.playerTag) ?? [];
    if (!list.includes(clanTag)) {
      list.push(clanTag);
      clanTagByPlayerTag.set(member.playerTag, list);
    }
  }
  return [...clanTagByPlayerTag.entries()]
    .filter(([, clanTags]) => clanTags.length > 1)
    .map(([playerTag, clanTags]) => ({
      playerTag,
      clanTags: [...clanTags].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.playerTag.localeCompare(right.playerTag));
}

/** Purpose: own the durable CWL measurement baseline capture and replacement flow. */
export class CwlAllianceBaselineService {
  /** Purpose: initialize the baseline service with the repo's standard logger. */
  constructor(private readonly logger: Logger = console) {}

  /** Purpose: capture or return the frozen alliance baseline for one guild-season pair. */
  async captureAllianceSeasonBaseline(input: {
    guildId: string;
    season?: string | null;
    capturedByUserId?: string | null;
    replaceExisting?: boolean;
    now?: Date;
  }): Promise<CwlAllianceBaselineCaptureSummary> {
    const startedAt = Date.now();
    const guildId = normalizeGuildId(input.guildId);
    const season = normalizeSeasonKey(input.season ?? null);
    const capturedByUserId = normalizeCapturedByUserId(input.capturedByUserId ?? null);
    const replaceExisting = Boolean(input.replaceExisting);
    const capturedAt = input.now ?? new Date();
    const existingBaseline = await this.loadExistingBaseline(guildId, season);

    if (existingBaseline && !replaceExisting) {
      const summary = summarizeStoredBaseline(existingBaseline);
      this.logger.info(
        `[cwl-alliance-baseline] event=capture_reused guildId=${guildId} season=${season} baselineId=${summary.baselineId} trackedClanCount=${summary.trackedClanCount} capturedClanCount=${summary.capturedClanCount} unavailableClanCount=${summary.unavailableClanCount} memberCount=${summary.memberAccountCount} linkedCount=${summary.linkedAccountCount} currentSourceCount=${summary.currentWarSourceCount} fallbackCount=${summary.latestWarFallbackCount} durationMs=${Date.now() - startedAt}`,
      );
      return summary;
    }

    const baselineId = existingBaseline?.id ?? randomUUID();
    const candidate = await this.buildCandidateSnapshot({
      baselineId,
      guildId,
      season,
      capturedAt,
    });

    const duplicateConflicts = detectDuplicateMemberTagsAcrossClans(
      candidate.clans,
      candidate.members,
    );
    if (duplicateConflicts.length > 0) {
      const conflict = duplicateConflicts[0];
      this.logger.error(
        `[cwl-alliance-baseline] event=capture_failed guildId=${guildId} season=${season} reason=duplicate_player_tag playerTag=${conflict.playerTag} clanTags=${conflict.clanTags.join(",")} durationMs=${Date.now() - startedAt}`,
      );
      throw new CwlAllianceBaselineDuplicatePlayerTagError(
        `Player tag ${conflict.playerTag} appears in multiple selected clan rosters.`,
        duplicateConflicts,
      );
    }

    const persisted = await prisma.$transaction(async (tx) => {
      const baseline = await tx.cwlAllianceSeasonBaseline.upsert({
        where: {
          guildId_season: {
            guildId,
            season,
          },
        },
        create: {
          id: baselineId,
          guildId,
          season,
          capturedAt,
          capturedByUserId,
        },
        update: {
          capturedAt,
          capturedByUserId,
        },
        select: {
          id: true,
          guildId: true,
          season: true,
          capturedAt: true,
        },
      });

      await tx.cwlAllianceSeasonBaselineClan.deleteMany({
        where: { baselineId: baseline.id },
      });
      await tx.cwlAllianceSeasonBaselineMember.deleteMany({
        where: { baselineId: baseline.id },
      });

      if (candidate.clans.length > 0) {
        await tx.cwlAllianceSeasonBaselineClan.createMany({
          data: candidate.clans.map((clan) => ({
            id: clan.id,
            baselineId: baseline.id,
            clanTag: clan.clanTag,
            clanName: clan.clanName,
            captureStatus: clan.captureStatus,
            sourceType: clan.sourceType,
            sourceWarId: clan.sourceWarId,
            sourceWarStartTime: clan.sourceWarStartTime,
            sourceWarEndTime: clan.sourceWarEndTime,
            sourceOpponentTag: clan.sourceOpponentTag,
            sourceObservedAt: clan.sourceObservedAt,
            rosterSize: clan.rosterSize,
            failureReason: clan.failureReason,
          })),
        });
      }

      if (candidate.members.length > 0) {
        await tx.cwlAllianceSeasonBaselineMember.createMany({
          data: candidate.members.map((member) => ({
            id: member.id,
            baselineId: member.baselineId,
            baselineClanId: member.baselineClanId,
            playerTag: member.playerTag,
            playerName: member.playerName,
            townHall: member.townHall,
            position: member.position,
            linkedDiscordUserId: member.linkedDiscordUserId,
          })),
        });
      }

      return baseline;
    });

    const summary = summarizeCandidateSnapshot({
      baseline: persisted,
      clans: candidate.clans,
      members: candidate.members,
    });
    this.logger.info(
      `[cwl-alliance-baseline] event=capture_completed guildId=${guildId} season=${season} baselineId=${summary.baselineId} replaceExisting=${replaceExisting ? "1" : "0"} trackedClanCount=${summary.trackedClanCount} capturedClanCount=${summary.capturedClanCount} unavailableClanCount=${summary.unavailableClanCount} memberCount=${summary.memberAccountCount} linkedCount=${summary.linkedAccountCount} currentSourceCount=${summary.currentWarSourceCount} fallbackCount=${summary.latestWarFallbackCount} durationMs=${Date.now() - startedAt}`,
    );
    for (const clan of summary.coverageSummaries.filter(
      (row) => row.captureStatus === "UNAVAILABLE",
    )) {
      this.logger.warn(
        `[cwl-alliance-baseline] event=clan_unavailable guildId=${guildId} season=${season} clanTag=${clan.clanTag} reason=${clan.failureReason ?? "unknown"}`,
      );
    }

    return summary;
  }

  /** Purpose: load one existing frozen baseline together with its child coverage rows. */
  private async loadExistingBaseline(
    guildId: string,
    season: string,
  ): Promise<ExistingBaselineRow | null> {
    return prisma.cwlAllianceSeasonBaseline.findUnique({
      where: {
        guildId_season: {
          guildId,
          season,
        },
      },
      select: {
        id: true,
        guildId: true,
        season: true,
        capturedAt: true,
        capturedByUserId: true,
        createdAt: true,
        updatedAt: true,
        clans: {
          orderBy: [{ clanTag: "asc" }],
          select: {
            id: true,
            clanTag: true,
            clanName: true,
            captureStatus: true,
            sourceType: true,
            sourceWarId: true,
            sourceWarStartTime: true,
            sourceWarEndTime: true,
            sourceOpponentTag: true,
            sourceObservedAt: true,
            rosterSize: true,
            failureReason: true,
            createdAt: true,
            updatedAt: true,
            members: {
              orderBy: [{ position: "asc" }, { playerTag: "asc" }],
              select: {
                id: true,
                baselineId: true,
                baselineClanId: true,
                playerTag: true,
                playerName: true,
                townHall: true,
                position: true,
                linkedDiscordUserId: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
  }

  /** Purpose: build a candidate baseline snapshot from persisted tracked clan, war, roster, and link rows. */
  private async buildCandidateSnapshot(input: {
    baselineId: string;
    guildId: string;
    season: string;
    capturedAt: Date;
  }): Promise<CandidateSnapshot> {
    const trackedClanRows = normalizeTrackedClanRows(
      await prisma.trackedClan.findMany({
        orderBy: [{ tag: "asc" }],
        select: {
          tag: true,
          name: true,
        },
      }),
    );
    const queryTags = toTrackedClanQueryTags(trackedClanRows);

    const [currentWarRows, currentRosterRows, historyRows] = await Promise.all([
      queryTags.length > 0
        ? prisma.currentWar.findMany({
            where: {
              guildId: input.guildId,
              clanTag: { in: queryTags },
            },
            orderBy: [{ clanTag: "asc" }],
            select: {
              guildId: true,
              clanTag: true,
              warId: true,
              matchType: true,
              state: true,
              opponentTag: true,
              opponentName: true,
              clanName: true,
              prepStartTime: true,
              startTime: true,
              endTime: true,
            },
          })
        : Promise.resolve([] as CurrentWarRow[]),
      queryTags.length > 0
        ? prisma.fwaTrackedClanWarRosterCurrent.findMany({
            where: {
              clanTag: { in: queryTags },
            },
            orderBy: [{ clanTag: "asc" }],
            select: {
              clanTag: true,
              clanName: true,
              opponentTag: true,
              opponentName: true,
              rosterSize: true,
              observedAt: true,
              sourceUpdatedAt: true,
              members: {
                orderBy: [{ position: "asc" }, { playerTag: "asc" }],
                select: {
                  position: true,
                  playerTag: true,
                  playerName: true,
                  townHall: true,
                },
              },
            },
          })
        : Promise.resolve([] as CurrentRosterRow[]),
      queryTags.length > 0
        ? prisma.clanWarHistory.findMany({
            where: {
              clanTag: { in: queryTags },
              matchType: "FWA",
            },
            orderBy: [
              { clanTag: "asc" },
              { warEndTime: "desc" },
              { warStartTime: "desc" },
              { updatedAt: "desc" },
            ],
            select: {
              warId: true,
              clanTag: true,
              clanName: true,
              opponentTag: true,
              opponentName: true,
              matchType: true,
              warStartTime: true,
              warEndTime: true,
              updatedAt: true,
            },
          })
        : Promise.resolve([] as HistoryRow[]),
    ]);

    const currentWarByClanTag = new Map<string, CurrentWarRow>();
    for (const row of currentWarRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      if (!clanTag) continue;
      currentWarByClanTag.set(clanTag, row);
    }

    const currentRosterByClanTag = new Map<string, CurrentRosterRow>();
    for (const row of currentRosterRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      if (!clanTag) continue;
      currentRosterByClanTag.set(clanTag, row);
    }

    const historyByClanTag = new Map<string, HistoryRow>();
    for (const row of historyRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      if (!clanTag || historyByClanTag.has(clanTag)) continue;
      historyByClanTag.set(clanTag, row);
    }

    const selectedHistoryWarIds = [
      ...new Set(
        [...historyByClanTag.values()]
          .map((row) => String(row.warId))
          .filter((warId) => Boolean(warId)),
      ),
    ];

    const participationRows =
      selectedHistoryWarIds.length > 0
        ? await prisma.clanWarParticipation.findMany({
            where: {
              guildId: input.guildId,
              warId: { in: selectedHistoryWarIds },
              clanTag: { in: queryTags },
            },
            orderBy: [
              { warId: "asc" },
              { playerPosition: "asc" },
              { playerTag: "asc" },
            ],
            select: {
              warId: true,
              clanTag: true,
              playerTag: true,
              playerName: true,
              playerPosition: true,
              townHall: true,
              attacksUsed: true,
            },
          })
        : [];

    const participationByClanAndWar = new Map<string, ParticipationRow[]>();
    for (const row of participationRows) {
      const clanTag = normalizeClanTag(row.clanTag);
      const warId = String(row.warId ?? "").trim();
      if (!clanTag || !warId) continue;
      const key = `${clanTag}:${warId}`;
      const list = participationByClanAndWar.get(key) ?? [];
      list.push({
        warId,
        clanTag,
        playerTag: row.playerTag,
        playerName: row.playerName ?? null,
        playerPosition:
          row.playerPosition !== null && row.playerPosition !== undefined
            ? Math.trunc(Number(row.playerPosition))
            : null,
        townHall:
          row.townHall !== null && row.townHall !== undefined
            ? Math.trunc(Number(row.townHall))
            : null,
        attacksUsed:
          row.attacksUsed !== null && row.attacksUsed !== undefined
            ? Math.max(0, Math.trunc(Number(row.attacksUsed)))
            : 0,
      });
      participationByClanAndWar.set(key, list);
    }

    const candidateClanRows: CandidateClanRow[] = [];
    const candidateMembers: CandidateMemberRow[] = [];
    const coverageFailureByClanTag = new Map<string, string>();

    for (const trackedClan of trackedClanRows) {
      const currentWarTag = trackedClan.validQueryTag;
      const currentWar =
        currentWarTag !== null ? currentWarByClanTag.get(currentWarTag) ?? null : null;
      const roster =
        currentWarTag !== null
          ? currentRosterByClanTag.get(currentWarTag) ?? null
          : null;
      const history =
        currentWarTag !== null ? historyByClanTag.get(currentWarTag) ?? null : null;

      const currentSelection =
        currentWar && roster
          ? buildCapturedClanSnapshotFromCurrentWar({
              baselineId: input.baselineId,
              trackedClan,
              currentWar,
              roster,
              linkedDiscordUserIdByPlayerTag: new Map(),
            })
          : currentWar
            ? ({ kind: "unavailable", reason: "CURRENT_FWA_WAR_UNVERIFIED" } as const)
            : ({ kind: "unavailable", reason: "NO_CURRENT_FWA_WAR" } as const);

      if (currentSelection.kind === "captured") {
        candidateClanRows.push(currentSelection.clan);
        candidateMembers.push(...currentSelection.members);
        continue;
      }

      const historyKey =
        currentWarTag !== null && history ? `${currentWarTag}:${String(history.warId)}` : null;
      const historyParticipations =
        historyKey !== null ? participationByClanAndWar.get(historyKey) ?? [] : [];
      const historySelection =
        history && historyParticipations.length > 0
          ? buildCapturedClanSnapshotFromLatestWar({
              baselineId: input.baselineId,
              trackedClan,
              history,
              participationRows: historyParticipations,
              linkedDiscordUserIdByPlayerTag: new Map(),
            })
          : history
            ? ({ kind: "unavailable", reason: "LATEST_FWA_WAR_NO_PARTICIPATION" } as const)
            : ({ kind: "unavailable", reason: currentSelection.reason } as const);

      if (historySelection.kind === "captured") {
        candidateClanRows.push(historySelection.clan);
        candidateMembers.push(...historySelection.members);
        continue;
      }

      const failureReason =
        historySelection.reason ||
        currentSelection.reason ||
        "NO_FWA_ROSTER_AVAILABLE";
      coverageFailureByClanTag.set(trackedClan.clanTag, failureReason);
      candidateClanRows.push(
        buildUnavailableClanSnapshot({
          baselineId: input.baselineId,
          trackedClan,
          failureReason,
        }),
      );
    }

    const selectedPlayerTags = [
      ...new Set(candidateMembers.map((member) => member.playerTag)),
    ];
    const playerLinks =
      selectedPlayerTags.length > 0
        ? await prisma.playerLink.findMany({
            where: {
              playerTag: { in: selectedPlayerTags },
            },
            select: {
              playerTag: true,
              discordUserId: true,
            },
          })
        : [];
    const linkedDiscordUserIdByPlayerTag = new Map<string, string | null>();
    for (const row of playerLinks) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      linkedDiscordUserIdByPlayerTag.set(
        playerTag,
        normalizeDiscordUserId(row.discordUserId) ?? null,
      );
    }

    const finalizedClanRows: CandidateClanRow[] = [];
    const finalizedMemberRows: CandidateMemberRow[] = [];

    for (const clan of candidateClanRows) {
      if (clan.captureStatus === "UNAVAILABLE") {
        finalizedClanRows.push(clan);
        continue;
      }
      const memberRows =
        candidateMembers.filter((member) => member.baselineClanId === clan.id);
      const withLinks = memberRows.map((member) => ({
        ...member,
        linkedDiscordUserId:
          linkedDiscordUserIdByPlayerTag.get(member.playerTag) ?? null,
      }));
      finalizedClanRows.push(clan);
      finalizedMemberRows.push(...withLinks);
    }

    const duplicateConflicts = detectDuplicateMemberTagsAcrossClans(
      finalizedClanRows,
      finalizedMemberRows,
    );
    if (duplicateConflicts.length > 0) {
      const conflict = duplicateConflicts[0];
      throw new CwlAllianceBaselineDuplicatePlayerTagError(
        `Player tag ${conflict.playerTag} appears in multiple selected clan rosters.`,
        duplicateConflicts,
      );
    }

    for (const [clanTag, reason] of coverageFailureByClanTag.entries()) {
      this.logger.warn(
        `[cwl-alliance-baseline] event=clan_unavailable_preview guildId=${input.guildId} season=${input.season} clanTag=${clanTag} reason=${reason}`,
      );
    }

    return {
      baselineId: input.baselineId,
      clans: finalizedClanRows,
      members: finalizedMemberRows,
    };
  }
}

export const cwlAllianceBaselineService = new CwlAllianceBaselineService();
