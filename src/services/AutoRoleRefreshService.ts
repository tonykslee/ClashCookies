import { Guild } from "discord.js";
import { AutoRoleRuleType } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { mapWithConcurrency } from "./fwa-feeds/concurrency";
import { isMirrorPollingMode } from "./PollingModeService";
import {
  playerCurrentService,
  type PlayerCurrentLike,
  type PlayerCurrentResolutionField,
} from "./PlayerCurrentService";
import {
  autoRoleApplyService,
  type AutoRoleMemberApplyResult,
} from "./AutoRoleApplyService";
import {
  autoRoleEvaluationService,
  type AutoRoleClanMembershipIndex,
  type AutoRoleClanMembershipIndexRow,
  type AutoRoleMemberEvaluation,
  type AutoRoleTrackedClanLeadRole,
} from "./AutoRoleEvaluationService";
import type { AutoRoleNicknameTrackedClanLike } from "./AutoRoleNicknameService";
import { resolveHomeVillageLeagueObservation } from "./HomeVillageLeagueTaxonomy";
import { normalizeNicknameTemplate } from "./AutoRoleService";
import {
  autoRoleService,
  type AutoRoleGuildStateSnapshot,
  type AutoRoleRuleRecord,
} from "./AutoRoleService";
import type { CoCQueuePriority } from "./CoCQueueContext";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePersistedPlayerName,
  normalizePlayerTag,
  getPlayerLinksForDiscordUserWithTrust,
  type PlayerLinkWithTrust,
} from "./PlayerLinkService";
import { runWithCoCQueueContext } from "./CoCQueueContext";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { cwlEventResolutionService } from "./CwlEventResolutionService";

export type AutoRoleRefreshScope =
  | { kind: "guild" }
  | { kind: "user"; discordUserId: string }
  | { kind: "role"; discordRoleId: string };

export type AutoRoleRefreshTelemetry = {
  refreshId?: string;
  refreshStartedAtMs?: number;
  schedulerSource?: string;
};

export type AutoRoleLinkedPlayerRefreshResult = {
  requestedPlayerCount: number;
  successfulCount: number;
  failedCount: number;
  failedPlayerTags: string[];
  queuePriority: CoCQueuePriority | null;
  queueSource: string | null;
  action: "refreshed" | "partial_failure" | "failed" | "skipped";
};

export type AutoRoleRefreshResult = {
  guildId: string;
  scope: AutoRoleRefreshScope;
  runId: string;
  evaluatedCount: number;
  addedCount: number;
  removedCount: number;
  skippedCount: number;
  failedCount: number;
  memberResults: AutoRoleMemberApplyResult[];
  linkedPlayerRefresh?: AutoRoleLinkedPlayerRefreshResult | null;
  memberSourceSummary?: AutoRoleRefreshMemberSourceSummary | null;
};

export type AutoRoleRefreshMemberSourceMode = "cache_complete" | "targeted_candidates" | "partial_candidates";

export type AutoRoleRefreshMemberSourceSummary = {
  scope: AutoRoleRefreshScope;
  guildMemberCount: number;
  cachedMemberCount: number;
  cacheCoverageComplete: boolean;
  candidateUserCount: number;
  targetedFetchRequestedCount: number;
  targetedFetchSucceededCount: number;
  targetedFetchFailedCount: number;
  memberSourceMode: AutoRoleRefreshMemberSourceMode;
  visitorRoleAdditionsSuppressed: boolean;
  playerCurrentPersistedRowCount: number;
  trackedClanOverlayCount: number;
};

type AutoRoleGuildMemberLike = {
  id: string;
  displayName?: string;
  nickname?: string | null;
  user: { id: string; username?: string | null; globalName?: string | null; bot?: boolean };
  roles: {
    cache: {
      keys(): IterableIterator<string>;
      has(roleId: string): boolean;
    };
    add(roleId: string): Promise<unknown>;
    remove(roleId: string): Promise<unknown>;
  };
  setNickname?(nickname: string | null): Promise<unknown>;
};

type AutoRoleMemberCollectionLike =
  | Map<string, AutoRoleGuildMemberLike>
  | Array<AutoRoleGuildMemberLike>
  | { values(): IterableIterator<AutoRoleGuildMemberLike> };

function memberCollectionToMap(input: AutoRoleMemberCollectionLike): Map<string, AutoRoleGuildMemberLike> {
  if (input instanceof Map) {
    return input;
  }

  const values =
    Array.isArray(input)
      ? input
      : [...input.values()];
  return new Map(values.map((member) => [member.id, member] as const));
}

function normalizeMemberIds(memberIds: Iterable<string>): string[] {
  return [...new Set([...memberIds].map((id) => String(id ?? "").trim()).filter(Boolean))].sort();
}

function getGuildCachedMembersMap(guild: Guild): Map<string, AutoRoleGuildMemberLike> {
  return memberCollectionToMap(guild.members.cache as unknown as AutoRoleMemberCollectionLike);
}

function isDiscordMemberFetchRateLimitError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return (
    message.includes("opcode 8") ||
    message.includes("request_guild_members") ||
    message.includes("request guild members") ||
    message.includes("rate limited") ||
    message.includes("rate-limited")
  );
}

function formatDiscordMemberFetchRateLimitMessage(error: unknown): string {
  const message = formatError(error);
  const match =
    /retry after\s+([0-9]+(?:\.[0-9]+)?)\s*seconds?/i.exec(message) ??
    /retry after\s+([0-9]+(?:\.[0-9]+)?)\s*s\b/i.exec(message);
  const retrySeconds = match ? Math.max(1, Math.ceil(Number(match[1]))) : null;
  return retrySeconds !== null
    ? `Discord rate-limited member fetching. Try again in about ${retrySeconds} seconds.`
    : "Discord rate-limited member fetching. Try again in about a minute.";
}

async function loadGuildMembersByIds(input: {
  guild: Guild;
  userIds: Iterable<string>;
  concurrency?: number;
}): Promise<{
  membersById: Map<string, AutoRoleGuildMemberLike>;
}> {
  const membersById = new Map<string, AutoRoleGuildMemberLike>();
  const cachedMembers = getGuildCachedMembersMap(input.guild);
  const userIds = normalizeMemberIds(input.userIds);
  const userIdSet = new Set(userIds);
  const missingUserIds = userIds.filter((userId) => !cachedMembers.has(userId));

  for (const [userId, member] of cachedMembers.entries()) {
    if (userIdSet.has(userId)) {
      membersById.set(userId, member);
    }
  }

  if (missingUserIds.length === 0) {
    return { membersById };
  }

  const concurrency = Math.max(1, Math.trunc(input.concurrency ?? 4));
  const fetchResults = await mapWithConcurrency(missingUserIds, concurrency, async (userId) => {
    try {
      const fetched = await input.guild.members.fetch(userId);
      return { userId, member: fetched ? (fetched as unknown as AutoRoleGuildMemberLike) : null, error: null };
    } catch (error) {
      return {
        userId,
        member: null,
        error: isDiscordMemberFetchRateLimitError(error)
          ? new Error(formatDiscordMemberFetchRateLimitMessage(error))
          : error,
      };
    }
  });

  for (const result of fetchResults) {
    if (result.member) {
      membersById.set(result.userId, result.member);
      continue;
    }
    if (result.error) {
      throw result.error instanceof Error ? result.error : new Error(formatError(result.error));
    }
  }

  return { membersById };
}

async function loadGuildMembersByIdsAllowPartial(input: {
  guild: Guild;
  userIds: Iterable<string>;
  concurrency?: number;
}): Promise<{
  membersById: Map<string, AutoRoleGuildMemberLike>;
  targetedFetchRequestedCount: number;
  targetedFetchSucceededCount: number;
  targetedFetchFailedCount: number;
  failedUserIds: string[];
  failureReasons: string[];
}> {
  const membersById = new Map<string, AutoRoleGuildMemberLike>();
  const cachedMembers = getGuildCachedMembersMap(input.guild);
  const userIds = normalizeMemberIds(input.userIds);
  const userIdSet = new Set(userIds);
  const missingUserIds = userIds.filter((userId) => !cachedMembers.has(userId));
  const failedUserIds: string[] = [];
  const failureReasons: string[] = [];
  let targetedFetchSucceededCount = 0;

  for (const [userId, member] of cachedMembers.entries()) {
    if (userIdSet.has(userId)) {
      membersById.set(userId, member);
    }
  }

  if (missingUserIds.length > 0) {
    const concurrency = Math.max(1, Math.trunc(input.concurrency ?? 4));
    const fetchResults = await mapWithConcurrency(missingUserIds, concurrency, async (userId) => {
      try {
        const fetched = await input.guild.members.fetch(userId);
        return {
          userId,
          member: fetched ? (fetched as unknown as AutoRoleGuildMemberLike) : null,
          error: null as unknown,
        };
      } catch (error) {
        return {
          userId,
          member: null,
          error,
        };
      }
    });

    for (const result of fetchResults) {
      if (result.member) {
        membersById.set(result.userId, result.member);
        targetedFetchSucceededCount += 1;
        continue;
      }

      failedUserIds.push(result.userId);
      const error = result.error;
      if (error) {
        const normalizedError = isDiscordMemberFetchRateLimitError(error)
          ? formatDiscordMemberFetchRateLimitMessage(error)
          : formatError(error);
        failureReasons.push(normalizedError);
      }
    }
  }

  return {
    membersById,
    targetedFetchRequestedCount: missingUserIds.length,
    targetedFetchSucceededCount,
    targetedFetchFailedCount: failedUserIds.length,
    failedUserIds,
    failureReasons,
  };
}

function mergeTrackedClanPlayerCurrentOverlay(input: {
  baseByTag: Map<string, PlayerCurrentLike>;
  overlayByTag: Map<string, PlayerCurrentLike>;
}): Map<string, PlayerCurrentLike> {
  const merged = new Map<string, PlayerCurrentLike>();
  for (const [playerTag, record] of input.baseByTag.entries()) {
    merged.set(playerTag, { ...record });
  }

  for (const [playerTag, overlay] of input.overlayByTag.entries()) {
    const current = merged.get(playerTag) ?? {
      playerTag,
      playerName: null,
      townHall: null,
      currentClanTag: null,
      currentClanName: null,
      trophies: null,
      builderTrophies: null,
      warStars: null,
      expLevel: null,
      role: null,
      leagueName: null,
      currentWeight: null,
      currentWeightSource: null,
      currentWeightMeasuredAt: null,
      achievementsJson: null,
      lastSeenAt: null,
      lastFetchedAt: null,
      lastSource: null,
      createdAt: null,
      updatedAt: null,
      source: "missing",
      liveRefreshInvoked: false,
    };

    current.playerName = overlay.playerName ?? current.playerName;
    current.townHall = overlay.townHall ?? current.townHall;
    current.currentClanTag = overlay.currentClanTag ?? current.currentClanTag;
    current.currentClanName = overlay.currentClanName ?? current.currentClanName;
    current.role = overlay.role ?? current.role;
    if (overlay.leagueName !== null) {
      current.leagueName = overlay.leagueName;
    }
    merged.set(playerTag, current);
  }

  return merged;
}

function buildTrackedClanPlayerCurrentFromMember(input: {
  playerTag: string;
  playerName: unknown;
  townHall: unknown;
  currentClanTag: string;
  currentClanName: string | null;
  role: unknown;
  leagueTier?: unknown;
  league?: unknown;
}): PlayerCurrentLike {
  const leagueObservation = resolveHomeVillageLeagueObservation({
    leagueTier: normalizeHomeVillageLeagueTier(input.leagueTier),
    league: normalizeHomeVillageLeague(input.league),
  });

  return createTrackedClanPlayerCurrent({
    playerTag: input.playerTag,
    playerName: normalizePersistedPlayerName(String(input.playerName ?? "")),
    townHall: normalizeTownHallLevel(input.townHall),
    currentClanTag: input.currentClanTag,
    currentClanName: input.currentClanName,
    role: normalizeClanMemberRole(input.role ?? null),
    leagueName: leagueObservation.leagueName,
  });
}

function normalizeHomeVillageLeagueTier(input: unknown): { id?: number | null; name?: string | null } | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const leagueTier = input as { id?: unknown; name?: unknown };
  const id = normalizeNumericId(leagueTier.id);
  const name = normalizeText(leagueTier.name);
  if (id === null && name === null) {
    return null;
  }

  return {
    id,
    name,
  };
}

function normalizeHomeVillageLeague(input: unknown): { name?: string | null } | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const league = input as { name?: unknown };
  const name = normalizeText(league.name);
  if (name === null) {
    return null;
  }

  return { name };
}

function normalizeNumericId(input: unknown): number | null {
  const value = Math.trunc(Number(input));
  return Number.isFinite(value) ? value : null;
}

function normalizePlayerTags(playerTags: Iterable<string>): string[] {
  return [...new Set([...playerTags].map((tag) => normalizePlayerTag(String(tag ?? ""))).filter(Boolean))].sort();
}

function normalizeClanTags(clanTags: Iterable<string>): Set<string> {
  return new Set(
    [...clanTags]
      .map((tag) => normalizeClanTag(String(tag ?? "")))
      .filter((tag): tag is string => Boolean(tag)),
  );
}

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTownHallLevel(input: unknown): number | null {
  const value = Math.trunc(Number(input));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeClanMemberRole(input: unknown): "member" | "elder" | "coLeader" | "leader" | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "leader") return "leader";
  if (normalized === "coleader") return "coLeader";
  if (normalized === "admin" || normalized === "elder") return "elder";
  if (normalized === "member") return "member";
  return null;
}

function createTrackedClanPlayerCurrent(input: {
  playerTag: string;
  playerName: string | null;
  townHall: number | null;
  currentClanTag: string | null;
  currentClanName: string | null;
  role: "member" | "elder" | "coLeader" | "leader" | null;
  leagueName: string | null;
}): PlayerCurrentLike {
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    townHall: input.townHall,
    currentClanTag: input.currentClanTag,
    currentClanName: input.currentClanName,
    trophies: null,
    builderTrophies: null,
    warStars: null,
    expLevel: null,
    role: input.role,
    leagueName: input.leagueName,
    currentWeight: null,
    currentWeightSource: null,
    currentWeightMeasuredAt: null,
    achievementsJson: null,
    lastSeenAt: null,
    lastFetchedAt: null,
    lastSource: "live_refresh",
    createdAt: null,
    updatedAt: null,
    source: "live_refresh",
    liveRefreshInvoked: false,
  };
}

async function fetchClanWithTelemetry(input: {
  cocService: CoCService;
  clanTag: string;
  guildId?: string;
  telemetry?: AutoRoleRefreshTelemetry | null;
  fetchLabel: string;
}): Promise<any | null> {
  const clanTag = normalizeClanTag(input.clanTag) ?? String(input.clanTag ?? "").trim();
  const startedAtMs = Date.now();
  try {
    const clan = await input.cocService.getClan(clanTag);
    if (!clan) {
      if (input.telemetry?.refreshId) {
        dozzleLog.info(
          `[autorole] event=live_clan_fetch source=${input.telemetry.schedulerSource ?? "autorole_scheduler"} autorole_refresh_id=${input.telemetry.refreshId} guild_id=${input.guildId ?? "unknown"} fetch_label=${input.fetchLabel} clan_tag=${clanTag} status=failure duration_ms=${Date.now() - startedAtMs} error=empty_response`,
        );
      }
      return null;
    }
    if (input.telemetry?.refreshId) {
      dozzleLog.info(
        `[autorole] event=live_clan_fetch source=${input.telemetry.schedulerSource ?? "autorole_scheduler"} autorole_refresh_id=${input.telemetry.refreshId} guild_id=${input.guildId ?? "unknown"} fetch_label=${input.fetchLabel} clan_tag=${clanTag} clan_name=${String(clan.name ?? clanTag).replace(/\s+/g, " ").trim()} member_count=${Array.isArray(clan.members) ? clan.members.length : 0} status=success duration_ms=${Date.now() - startedAtMs}`,
      );
    }
    return clan;
  } catch (error) {
    if (input.telemetry?.refreshId) {
      dozzleLog.info(
        `[autorole] event=live_clan_fetch source=${input.telemetry.schedulerSource ?? "autorole_scheduler"} autorole_refresh_id=${input.telemetry.refreshId} guild_id=${input.guildId ?? "unknown"} fetch_label=${input.fetchLabel} clan_tag=${clanTag} status=failure duration_ms=${Date.now() - startedAtMs} error=${formatError(error)}`,
      );
    }
    return null;
  }
}

function memberHasAnyManagedRole(member: AutoRoleGuildMemberLike, managedRoleIds: Set<string>): boolean {
  for (const roleId of member.roles.cache.keys()) {
    if (managedRoleIds.has(String(roleId ?? "").trim())) {
      return true;
    }
  }
  return false;
}

async function loadLinkedAccountsForGuildMemberIds(input: {
  guildMemberIds: string[];
}): Promise<Map<string, PlayerLinkWithTrust[]>> {
  const normalizedMemberIds = normalizeMemberIds(input.guildMemberIds);
  if (normalizedMemberIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.playerLink.findMany({
    where: {
      discordUserId: { in: normalizedMemberIds },
    },
    select: {
      playerTag: true,
      discordUserId: true,
      discordUsername: true,
      playerName: true,
      linkSource: true,
      verificationStatus: true,
      verificationMethod: true,
      verifiedAt: true,
      verifiedByDiscordUserId: true,
      lastVerifiedAt: true,
      verificationFailureReason: true,
      importBatchKey: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const byUserId = new Map<string, PlayerLinkWithTrust[]>();
  for (const row of rows) {
    const discordUserId = String(row.discordUserId ?? "").trim();
    if (!discordUserId) continue;
    const list = byUserId.get(discordUserId) ?? [];
    list.push({
      playerTag: row.playerTag,
      discordUserId,
      discordUsername: row.discordUsername,
      playerName: row.playerName,
      linkSource: row.linkSource,
      verificationStatus: row.verificationStatus,
      verificationMethod: row.verificationMethod,
      verifiedAt: row.verifiedAt,
      verifiedByDiscordUserId: row.verifiedByDiscordUserId,
      lastVerifiedAt: row.lastVerifiedAt,
      verificationFailureReason: row.verificationFailureReason,
      importBatchKey: row.importBatchKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    byUserId.set(discordUserId, list);
  }
  return byUserId;
}

async function loadLinkedAccountsForPlayerTags(input: {
  playerTags: string[];
}): Promise<Map<string, PlayerLinkWithTrust[]>> {
  const normalizedTags = normalizePlayerTags(input.playerTags);
  if (normalizedTags.length === 0) {
    return new Map();
  }

  const rows = await prisma.playerLink.findMany({
    where: {
      playerTag: { in: normalizedTags },
    },
    select: {
      playerTag: true,
      discordUserId: true,
      discordUsername: true,
      playerName: true,
      linkSource: true,
      verificationStatus: true,
      verificationMethod: true,
      verifiedAt: true,
      verifiedByDiscordUserId: true,
      lastVerifiedAt: true,
      verificationFailureReason: true,
      importBatchKey: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const byUserId = new Map<string, PlayerLinkWithTrust[]>();
  for (const row of rows) {
    const discordUserId = String(row.discordUserId ?? "").trim();
    if (!discordUserId) continue;
    const list = byUserId.get(discordUserId) ?? [];
    list.push({
      playerTag: row.playerTag,
      discordUserId,
      discordUsername: row.discordUsername,
      playerName: row.playerName,
      linkSource: row.linkSource,
      verificationStatus: row.verificationStatus,
      verificationMethod: row.verificationMethod,
      verifiedAt: row.verifiedAt,
      verifiedByDiscordUserId: row.verifiedByDiscordUserId,
      lastVerifiedAt: row.lastVerifiedAt,
      verificationFailureReason: row.verificationFailureReason,
      importBatchKey: row.importBatchKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    byUserId.set(discordUserId, list);
  }
  return byUserId;
}

function collectLinkedPlayerTags(linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>): string[] {
  const playerTags: string[] = [];
  for (const rows of linkedAccountsByUserId.values()) {
    for (const row of rows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (playerTag) {
        playerTags.push(playerTag);
      }
    }
  }
  return [...new Set(playerTags)];
}

async function loadDistinctLinkedDiscordUserIds(): Promise<Set<string>> {
  const rows = await prisma.playerLink.findMany({
    where: {
      discordUserId: { not: null },
    },
    select: {
      discordUserId: true,
    },
    distinct: ["discordUserId"],
  });

  return new Set(
    rows
      .map((row) => normalizeDiscordUserId(row.discordUserId))
      .filter((value): value is string => Boolean(value)),
  );
}

async function loadAutoRoleEvaluatedDiscordUserIds(guildId: string): Promise<Set<string>> {
  const rows = await prisma.autoRoleMemberState.findMany({
    where: { guildId },
    select: {
      discordUserId: true,
    },
  });

  return new Set(
    rows
      .map((row) => normalizeDiscordUserId(row.discordUserId))
      .filter((value): value is string => Boolean(value)),
  );
}

async function collectGuildRefreshCandidateUserIds(input: {
  guildId: string;
  managedRoleIds: Set<string>;
  cachedMembersById: Map<string, AutoRoleGuildMemberLike>;
  cacheCoverageComplete: boolean;
}): Promise<{
  candidateUserIds: Set<string>;
  sourceUserCount: number;
}> {
  if (input.cacheCoverageComplete) {
    return {
      candidateUserIds: new Set(input.cachedMembersById.keys()),
      sourceUserCount: input.cachedMembersById.size,
    };
  }

  const [linkedUserIds, evaluatedUserIds] = await Promise.all([
    loadDistinctLinkedDiscordUserIds(),
    loadAutoRoleEvaluatedDiscordUserIds(input.guildId),
  ]);

  const candidateUserIds = new Set<string>(input.cachedMembersById.keys());
  for (const userId of linkedUserIds) {
    candidateUserIds.add(userId);
  }
  for (const userId of evaluatedUserIds) {
    candidateUserIds.add(userId);
  }
  for (const userId of collectCurrentRoleHolders(input.cachedMembersById, input.managedRoleIds)) {
    candidateUserIds.add(userId);
  }

  return {
    candidateUserIds,
    sourceUserCount: linkedUserIds.size + evaluatedUserIds.size,
  };
}

async function loadPersistedPlayerCurrentByLinkedAccounts(input: {
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
}): Promise<Map<string, PlayerCurrentLike>> {
  const playerTags = normalizePlayerTags(
    [...input.linkedAccountsByUserId.values()].flatMap((rows) => rows.map((row) => row.playerTag)),
  );
  return playerTags.length > 0 ? playerCurrentService.listPlayerCurrentByTags(playerTags) : new Map();
}

async function loadLinkedAccountsForDiscordUser(input: {
  discordUserId: string;
}): Promise<Map<string, PlayerLinkWithTrust[]>> {
  const linkedAccounts = await getPlayerLinksForDiscordUserWithTrust({
    discordUserId: input.discordUserId,
  });
  return linkedAccounts.length > 0 ? new Map([[input.discordUserId, linkedAccounts]]) : new Map();
}

async function collectMembershipScopedCandidateUsers(input: {
  membersById: Map<string, AutoRoleGuildMemberLike>;
  trackedMemberPlayerTags: string[];
  targetRoleId: string;
}): Promise<Set<string>> {
  const candidateIds = collectCurrentRoleHolders(input.membersById, new Set([input.targetRoleId]));
  const linkedAccountsByUserId = await loadLinkedAccountsForPlayerTags({
    playerTags: input.trackedMemberPlayerTags,
  });

  for (const userId of linkedAccountsByUserId.keys()) {
    if (input.membersById.has(userId)) {
      candidateIds.add(userId);
    }
  }

  return candidateIds;
}

async function collectGuildCandidateUsersForTrackedMembership(input: {
  membersById: Map<string, AutoRoleGuildMemberLike>;
  managedRoleIds: Set<string>;
  trackedMemberPlayerTags: string[];
}): Promise<Set<string>> {
  const candidateIds = collectCurrentRoleHolders(input.membersById, input.managedRoleIds);
  const linkedAccountsByUserId = await loadLinkedAccountsForPlayerTags({
    playerTags: input.trackedMemberPlayerTags,
  });

  for (const userId of linkedAccountsByUserId.keys()) {
    if (input.membersById.has(userId)) {
      candidateIds.add(userId);
    }
  }

  return candidateIds;
}

function collectPlayerCurrentRequirementFields(input: {
  snapshot: AutoRoleGuildStateSnapshot;
  nicknameEnabled: boolean;
  leadRolesEnabled: boolean;
}): PlayerCurrentResolutionField[] {
  const fields: PlayerCurrentResolutionField[] = [];
  const addField = (field: PlayerCurrentResolutionField) => {
    if (!fields.includes(field)) {
      fields.push(field);
    }
  };

  if (input.nicknameEnabled) {
    addField("currentClanTag");
    addField("townHall");
    addField("role");
    addField("leagueName");
  }

  if (input.leadRolesEnabled) {
    addField("currentClanTag");
    addField("role");
  }

  for (const rule of input.snapshot.rules) {
    if (!rule.enabled) continue;
    switch (rule.type) {
      case "TOWN_HALL":
        addField("townHall");
        break;
      case "CLAN_ROLE":
        addField("role");
        break;
      case "LEAGUE":
        addField("leagueName");
        break;
      case "CLAN":
        addField("currentClanTag");
        break;
      default:
        break;
    }
  }

  return fields;
}

async function loadPlayerCurrentByLinkedAccounts(input: {
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
  cocService?: CoCService | null;
  requireFields: PlayerCurrentResolutionField[];
}): Promise<Map<string, PlayerCurrentLike>> {
  const playerTags = normalizePlayerTags(
    [...input.linkedAccountsByUserId.values()].flatMap((rows) => rows.map((row) => row.playerTag)),
  );
  if (playerTags.length === 0 || input.requireFields.length === 0) {
    return new Map();
  }
  const resolution = () =>
    playerCurrentService.resolveCurrentPlayersForTags({
      playerTags,
      cocService: input.cocService ?? null,
      requireFields: input.requireFields,
      refreshPolicy: "missing_only",
    });

  if (!input.cocService) {
    return resolution();
  }

  return runWithCoCQueueContext(
    {
      priority: "background",
      source: "autorole_refresh",
    },
    resolution,
  );
}

async function loadPlayerCurrentByLinkedAccountsForUserRefresh(input: {
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
  cocService?: CoCService | null;
  requireFields: PlayerCurrentResolutionField[];
  guildId: string;
  discordUserId: string;
  now?: Date;
}): Promise<{
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  refreshOutcome: AutoRoleLinkedPlayerRefreshResult | null;
}> {
  const playerTags = collectLinkedPlayerTags(input.linkedAccountsByUserId);
  if (playerTags.length === 0 || input.requireFields.length === 0) {
    const refreshOutcome: AutoRoleLinkedPlayerRefreshResult = {
      requestedPlayerCount: playerTags.length,
      successfulCount: 0,
      failedCount: 0,
      failedPlayerTags: [],
      queuePriority: null,
      queueSource: null,
      action: "skipped",
    };
    dozzleLog.debug(
      `[autorole] event=user_live_reconcile_summary guild_id=${input.guildId} user_id=${input.discordUserId} requested_player_count=${refreshOutcome.requestedPlayerCount} successful_count=${refreshOutcome.successfulCount} failed_count=${refreshOutcome.failedCount} failed_tags=none queue_priority=none queue_source=none action=${refreshOutcome.action} reason=no_tags_or_fields`,
    );
    return { playerCurrentByTag: new Map(), refreshOutcome };
  }

  const cocService = input.cocService ?? null;
  if (cocService && typeof cocService.getPlayerRaw === "function") {
    const queuePriority: CoCQueuePriority = "interactive";
    const queueSource = "autorole_user_refresh";
    const refreshResult = await runWithCoCQueueContext(
      {
        priority: queuePriority,
        source: queueSource,
      },
      () =>
        playerCurrentService.refreshCurrentPlayersFromLiveTags({
          playerTags,
          cocService,
          source: "live_refresh",
          now: input.now ?? new Date(),
        }),
    );
    const successfulTags = playerTags.filter((playerTag) => !refreshResult.failedPlayerTags.includes(playerTag));
    const playerCurrentByTag =
      successfulTags.length > 0
        ? await playerCurrentService.listPlayerCurrentByTags(successfulTags)
        : new Map<string, PlayerCurrentLike>();
    const refreshOutcome: AutoRoleLinkedPlayerRefreshResult = {
      requestedPlayerCount: playerTags.length,
      successfulCount: refreshResult.successCount,
      failedCount: refreshResult.failedPlayerTags.length,
      failedPlayerTags: [...refreshResult.failedPlayerTags],
      queuePriority,
      queueSource,
      action:
        refreshResult.failedPlayerTags.length === 0
          ? "refreshed"
          : refreshResult.successCount > 0
            ? "partial_failure"
            : "failed",
    };
    dozzleLog[refreshOutcome.failedCount > 0 ? "warn" : "info"](
      `[autorole] event=user_live_reconcile_summary guild_id=${input.guildId} user_id=${input.discordUserId} requested_player_count=${refreshOutcome.requestedPlayerCount} successful_count=${refreshOutcome.successfulCount} failed_count=${refreshOutcome.failedCount} failed_tags=${refreshOutcome.failedPlayerTags.length > 0 ? refreshOutcome.failedPlayerTags.join(",") : "none"} queue_priority=${refreshOutcome.queuePriority ?? "none"} queue_source=${refreshOutcome.queueSource ?? "none"} action=${refreshOutcome.action}`,
    );
    return { playerCurrentByTag, refreshOutcome };
  }

  const refreshOutcome: AutoRoleLinkedPlayerRefreshResult = {
    requestedPlayerCount: playerTags.length,
    successfulCount: 0,
    failedCount: 0,
    failedPlayerTags: [],
    queuePriority: null,
    queueSource: null,
    action: "skipped",
  };
  dozzleLog.debug(
    `[autorole] event=user_live_reconcile_summary guild_id=${input.guildId} user_id=${input.discordUserId} requested_player_count=${refreshOutcome.requestedPlayerCount} successful_count=${refreshOutcome.successfulCount} failed_count=${refreshOutcome.failedCount} failed_tags=none queue_priority=none queue_source=none action=${refreshOutcome.action} reason=no_coc_service`,
  );
  return {
    playerCurrentByTag: await loadPlayerCurrentByLinkedAccounts({
      linkedAccountsByUserId: input.linkedAccountsByUserId,
      cocService: input.cocService ?? null,
      requireFields: input.requireFields,
    }),
    refreshOutcome,
  };
}

type AutoRoleTrackedClanLike = AutoRoleNicknameTrackedClanLike & AutoRoleTrackedClanLeadRole;

async function loadTrackedClansForAutorole(): Promise<AutoRoleTrackedClanLike[]> {
  const rows = await prisma.trackedClan.findMany({
    select: {
      tag: true,
      name: true,
      shortName: true,
      clanRoleId: true,
      leadRoleId: true,
    },
  });

  return rows
    .map((row) => ({
      tag: normalizeClanTag(row.tag),
      name: row.name ?? null,
      shortName: row.shortName ?? null,
      clanRoleId: String(row.clanRoleId ?? "").trim() || null,
      leadRoleId: String(row.leadRoleId ?? "").trim() || null,
    }))
    .filter((row) => row.tag.length > 0);
}

type TrackedFwaClanRefreshState = {
  requestedClanCount: number;
  configuredClanTags: string[];
  fwaClanTags: Set<string>;
  fwaMemberTags: Set<string>;
  clanMembershipIndex: AutoRoleClanMembershipIndex;
  trackedClans: AutoRoleTrackedClanLike[];
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  clanFetchCount: number;
  failedClanTags: string[];
};

type TrackedLeadRoleRefreshState = {
  requestedClanCount: number;
  configuredClanTags: string[];
  trackedClans: AutoRoleTrackedClanLike[];
  clanMembershipIndex: AutoRoleClanMembershipIndex;
  trackedMembershipScope: {
    fwaClanTags: Set<string>;
    cwlClanTags: Set<string>;
    fwaMemberTags: Set<string>;
    cwlMemberTags: Set<string>;
    cwlClanFetchCount: number;
  };
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
  membersById: Map<string, AutoRoleGuildMemberLike>;
  candidateUserIds: Set<string>;
  cachedMemberCount: number;
  guildMemberCount: number;
  targetedFetchRequestedCount: number;
  targetedFetchSucceededCount: number;
  targetedFetchFailedCount: number;
  clanFetchCount: number;
  failedClanTags: string[];
};

type TrackedClanRoleRefreshState = {
  requestedClanCount: number;
  configuredClanTags: string[];
  trackedClans: AutoRoleTrackedClanLike[];
  clanMembershipIndex: AutoRoleClanMembershipIndex;
  trackedMembershipScope: {
    fwaClanTags: Set<string>;
    cwlClanTags: Set<string>;
    fwaMemberTags: Set<string>;
    cwlMemberTags: Set<string>;
    cwlClanFetchCount: number;
  };
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
  candidateUserIds: Set<string>;
  membersById: Map<string, AutoRoleGuildMemberLike>;
  cachedMemberCount: number;
  guildMemberCount: number;
  targetedFetchRequestedCount: number;
  targetedFetchSucceededCount: number;
  targetedFetchFailedCount: number;
  clanFetchCount: number;
  failedClanTags: string[];
};

function buildMemberSourceSummary(input: {
  scope: AutoRoleRefreshScope;
  guildMemberCount: number;
  cachedMemberCount: number;
  cacheCoverageComplete: boolean;
  candidateUserCount: number;
  targetedFetchRequestedCount: number;
  targetedFetchSucceededCount: number;
  targetedFetchFailedCount: number;
  visitorRoleAdditionsSuppressed: boolean;
  playerCurrentPersistedRowCount: number;
  trackedClanOverlayCount: number;
}): AutoRoleRefreshMemberSourceSummary {
  return {
    scope: input.scope,
    guildMemberCount: input.guildMemberCount,
    cachedMemberCount: input.cachedMemberCount,
    cacheCoverageComplete: input.cacheCoverageComplete,
    candidateUserCount: input.candidateUserCount,
    targetedFetchRequestedCount: input.targetedFetchRequestedCount,
    targetedFetchSucceededCount: input.targetedFetchSucceededCount,
    targetedFetchFailedCount: input.targetedFetchFailedCount,
    memberSourceMode: input.cacheCoverageComplete
      ? "cache_complete"
      : input.targetedFetchFailedCount > 0
        ? "partial_candidates"
        : "targeted_candidates",
    visitorRoleAdditionsSuppressed: input.visitorRoleAdditionsSuppressed,
    playerCurrentPersistedRowCount: input.playerCurrentPersistedRowCount,
    trackedClanOverlayCount: input.trackedClanOverlayCount,
  };
}

async function loadTrackedFwaClanRefreshState(input: {
  guildId?: string;
  cocService?: CoCService | null;
  telemetry?: AutoRoleRefreshTelemetry | null;
}): Promise<TrackedFwaClanRefreshState> {
  const rows = await prisma.trackedClan.findMany({
    select: {
      tag: true,
      name: true,
      shortName: true,
      clanRoleId: true,
      leadRoleId: true,
    },
  });

  const fwaClanTags = new Set<string>();
  const fwaMemberTags = new Set<string>();
  const clanMembershipIndex = new Map<string, AutoRoleClanMembershipIndexRow>();
  const trackedClans: AutoRoleTrackedClanLike[] = [];
  const playerCurrentByTag = new Map<string, PlayerCurrentLike>();
  const failedClanTags = new Set<string>();
  const configuredClanTags = new Set<string>();
  let clanFetchCount = 0;

  for (const row of rows) {
    const clanTag = normalizeClanTag(row.tag);
    if (!clanTag) {
      continue;
    }

    configuredClanTags.add(clanTag);
    fwaClanTags.add(clanTag);
    const trackedClanName = normalizeText(row.name);
    const shortName = normalizeText(row.shortName);
    let clan = null;
    if (input.cocService) {
      clan = await fetchClanWithTelemetry({
        cocService: input.cocService,
        clanTag,
        guildId: input.guildId,
        telemetry: input.telemetry,
        fetchLabel: "tracked_fwa_clan",
      });
      if (!clan) {
        failedClanTags.add(clanTag);
      }
    }
    if (input.cocService) {
      clanFetchCount += 1;
    }

    if (!clan) {
      if (!input.cocService) {
        trackedClans.push({
          tag: clanTag,
          name: trackedClanName ?? clanTag,
          shortName,
          clanRoleId: String(row.clanRoleId ?? "").trim() || null,
          leadRoleId: String(row.leadRoleId ?? "").trim() || null,
        });
      }
      clanMembershipIndex.set(clanTag, {
        source: "UNKNOWN",
        playerTags: new Set<string>(),
      });
      continue;
    }

    const clanName = normalizeText(clan?.name ?? trackedClanName);
    trackedClans.push({
      tag: clanTag,
      name: clanName,
      shortName,
      clanRoleId: String(row.clanRoleId ?? "").trim() || null,
      leadRoleId: String(row.leadRoleId ?? "").trim() || null,
    });

    const members = Array.isArray(clan?.members)
      ? clan.members
      : Array.isArray(clan?.memberList)
        ? clan.memberList
        : [];
    const playerTags = new Set<string>();
    for (const member of members) {
      const clanMember = member as {
        tag?: unknown;
        name?: unknown;
        townHallLevel?: unknown;
        townhallLevel?: unknown;
        townHall?: unknown;
        role?: unknown;
        leagueTier?: { id?: unknown; name?: unknown } | null;
        league?: { name?: unknown } | null;
      };
      const playerTag = normalizePlayerTag(String(clanMember.tag ?? ""));
      if (!playerTag) {
        continue;
      }
      playerTags.add(playerTag);
      fwaMemberTags.add(playerTag);

      if (!playerCurrentByTag.has(playerTag)) {
        playerCurrentByTag.set(
          playerTag,
          buildTrackedClanPlayerCurrentFromMember({
            playerTag,
            playerName: clanMember.name,
            townHall: clanMember.townHallLevel ?? clanMember.townhallLevel ?? clanMember.townHall ?? null,
            currentClanTag: clanTag,
            currentClanName: clanName,
            role: clanMember.role,
            leagueTier: clanMember.leagueTier ?? null,
            league: clanMember.league ?? null,
          }),
        );
      }
    }

    clanMembershipIndex.set(clanTag, {
      source: "FWA",
      playerTags,
    });
  }

  return {
    requestedClanCount: rows.length,
    configuredClanTags: [...configuredClanTags].sort(),
    fwaClanTags,
    fwaMemberTags,
    clanMembershipIndex,
    trackedClans,
    playerCurrentByTag,
    clanFetchCount,
    failedClanTags: [...failedClanTags].sort(),
  };
}

async function loadTrackedLeadRoleRefreshState(input: {
  guildId?: string;
  roleId: string;
  guild: Guild;
  membersById: Map<string, AutoRoleGuildMemberLike>;
  cocService?: CoCService | null;
  telemetry?: AutoRoleRefreshTelemetry | null;
}): Promise<TrackedLeadRoleRefreshState | null> {
  const roleId = String(input.roleId ?? "").trim();
  if (!roleId) {
    return null;
  }

  const rows = await prisma.trackedClan.findMany({
    where: { leadRoleId: roleId },
    select: {
      tag: true,
      name: true,
      shortName: true,
      clanRoleId: true,
      leadRoleId: true,
    },
  });
  if (rows.length === 0) {
    return null;
  }

  const matchingRows = rows.filter((row) => String(row.leadRoleId ?? "").trim() === roleId);
  if (matchingRows.length === 0) {
    return null;
  }

  const cocService = input.cocService ?? null;
  if (!cocService || typeof cocService.getClan !== "function") {
    return null;
  }

  const cachedMembersById = input.membersById;
  const currentHolderIds = collectCurrentRoleHolders(cachedMembersById, new Set([roleId]));
  const failedClanTags = new Set<string>();
  const configuredClanTags = new Set<string>();
  const clanLookups = await Promise.all(
    matchingRows.map(async (row) => {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) {
        return null;
      }

      configuredClanTags.add(clanTag);
      const clan = await fetchClanWithTelemetry({
        cocService,
        clanTag,
        guildId: input.guildId,
        telemetry: input.telemetry,
        fetchLabel: "tracked_lead_clan",
      });
      if (!clan) {
        failedClanTags.add(clanTag);
      }
      return {
        row: {
          tag: clanTag,
          name: row.name,
          shortName: row.shortName,
          clanRoleId: row.clanRoleId,
          leadRoleId: row.leadRoleId,
        },
        clan,
      };
    }),
  );

  const successfulLookups = clanLookups.filter((lookup): lookup is NonNullable<typeof lookup> => Boolean(lookup?.clan));
  const trackedClans: AutoRoleTrackedClanLike[] = [];
  const clanMembershipIndex = new Map<string, AutoRoleClanMembershipIndexRow>();
  const playerCurrentByTag = new Map<string, PlayerCurrentLike>();
  const fwaClanTags = new Set<string>();
  const fwaMemberTags = new Set<string>();
  const leaderMemberTags = new Set<string>();
  let clanFetchCount = 0;

  for (const lookup of successfulLookups) {
    clanFetchCount += 1;
    const clanTag = normalizeClanTag(lookup.row.tag);
    if (!clanTag) {
      continue;
    }

    fwaClanTags.add(clanTag);
    const trackedClanName = normalizeText(lookup.row.name);
    const shortName = normalizeText(lookup.row.shortName);
    const clanName = normalizeText(lookup.clan?.name ?? trackedClanName);
    trackedClans.push({
      tag: clanTag,
      name: clanName,
      shortName,
      clanRoleId: String(lookup.row.clanRoleId ?? "").trim() || null,
      leadRoleId: String(lookup.row.leadRoleId ?? "").trim() || null,
    });

    const members = Array.isArray(lookup.clan?.members)
      ? lookup.clan.members
      : Array.isArray(lookup.clan?.memberList)
        ? lookup.clan.memberList
        : [];
    const playerTags = new Set<string>();
    for (const member of members) {
      const clanMember = member as {
        tag?: unknown;
        name?: unknown;
        townHallLevel?: unknown;
        townhallLevel?: unknown;
        townHall?: unknown;
        role?: unknown;
        leagueTier?: { id?: unknown; name?: unknown } | null;
        league?: { name?: unknown } | null;
      };
      const playerTag = normalizePlayerTag(String(clanMember.tag ?? ""));
      if (!playerTag) {
        continue;
      }

      playerTags.add(playerTag);
      fwaMemberTags.add(playerTag);

      if (!playerCurrentByTag.has(playerTag)) {
        playerCurrentByTag.set(
          playerTag,
          buildTrackedClanPlayerCurrentFromMember({
            playerTag,
            playerName: clanMember.name,
            townHall: clanMember.townHallLevel ?? clanMember.townhallLevel ?? clanMember.townHall ?? null,
            currentClanTag: clanTag,
            currentClanName: clanName,
            role: clanMember.role,
            leagueTier: clanMember.leagueTier ?? null,
            league: clanMember.league ?? null,
          }),
        );
      }

      const role = normalizeClanMemberRole(clanMember.role ?? null);
      if (role === "leader" || role === "coLeader") {
        leaderMemberTags.add(playerTag);
      }
    }

    clanMembershipIndex.set(clanTag, {
      source: "FWA",
      playerTags,
    });
  }

  const leaderLinkedAccountsByUserId = await loadLinkedAccountsForPlayerTags({
    playerTags: [...leaderMemberTags],
  });
  const candidateUserIds = new Set<string>(currentHolderIds);
  for (const userId of leaderLinkedAccountsByUserId.keys()) {
    candidateUserIds.add(userId);
  }

  const memberSource = await loadGuildMembersByIdsAllowPartial({
    guild: input.guild,
    userIds: candidateUserIds,
  });
  const membersById = memberSource.membersById;
  const loadedCandidateUserIds = new Set<string>(membersById.keys());
  const linkedAccountsByUserId = await loadLinkedAccountsForGuildMemberIds({
    guildMemberIds: [...loadedCandidateUserIds],
  });

  return {
    requestedClanCount: matchingRows.length,
    configuredClanTags: [...configuredClanTags].sort(),
    trackedClans,
    clanMembershipIndex,
    trackedMembershipScope: {
      fwaClanTags,
      cwlClanTags: new Set<string>(),
      fwaMemberTags,
      cwlMemberTags: new Set<string>(),
      cwlClanFetchCount: 0,
    },
    playerCurrentByTag,
    linkedAccountsByUserId,
    membersById,
    candidateUserIds: loadedCandidateUserIds,
    cachedMemberCount: cachedMembersById.size,
    guildMemberCount: input.guild.memberCount,
    targetedFetchRequestedCount: memberSource.targetedFetchRequestedCount,
    targetedFetchSucceededCount: memberSource.targetedFetchSucceededCount,
    targetedFetchFailedCount: memberSource.targetedFetchFailedCount,
    clanFetchCount,
    failedClanTags: [...failedClanTags].sort(),
  };
}

async function loadTrackedClanRoleRefreshState(input: {
  guildId?: string;
  roleId: string;
  guild: Guild;
  cocService?: CoCService | null;
  telemetry?: AutoRoleRefreshTelemetry | null;
}): Promise<TrackedClanRoleRefreshState | null> {
  const roleId = String(input.roleId ?? "").trim();
  if (!roleId) {
    return null;
  }

  const rows = await prisma.trackedClan.findMany({
    where: { clanRoleId: roleId },
    select: {
      tag: true,
      name: true,
      shortName: true,
      clanRoleId: true,
      leadRoleId: true,
    },
  });
  if (rows.length === 0) {
    return null;
  }

  const matchingRows = rows.filter((row) => String(row.clanRoleId ?? "").trim() === roleId);
  if (matchingRows.length === 0) {
    return null;
  }

  const cocService = input.cocService ?? null;
  if (!cocService || typeof cocService.getClan !== "function") {
    throw new Error("Tracked clan role refresh requires CoC clan data.");
  }

  const cachedMembersById = getGuildCachedMembersMap(input.guild);
  const currentHolderIds = collectCurrentRoleHolders(cachedMembersById, new Set([roleId]));
  const failedClanTags = new Set<string>();
  const configuredClanTags = new Set<string>();
  const clanLookups = await Promise.all(
    matchingRows.map(async (row) => {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) {
        return null;
      }

      configuredClanTags.add(clanTag);
      const clan = await fetchClanWithTelemetry({
        cocService,
        clanTag,
        guildId: input.guildId,
        telemetry: input.telemetry,
        fetchLabel: "tracked_role_clan",
      });
      if (!clan) {
        failedClanTags.add(clanTag);
      }
      return {
        row: {
          tag: clanTag,
          name: row.name,
          shortName: row.shortName,
          clanRoleId: row.clanRoleId,
          leadRoleId: row.leadRoleId,
        },
        clan,
      };
    }),
  );

  const successfulLookups = clanLookups.filter((lookup): lookup is NonNullable<typeof lookup> => Boolean(lookup?.clan));
  const trackedClans: AutoRoleTrackedClanLike[] = [];
  const clanMembershipIndex = new Map<string, AutoRoleClanMembershipIndexRow>();
  const playerCurrentByTag = new Map<string, PlayerCurrentLike>();
  const fwaClanTags = new Set<string>();
  const fwaMemberTags = new Set<string>();
  const candidatePlayerTags = new Set<string>();
  let clanFetchCount = 0;
  const cachedMemberCount = cachedMembersById.size;

  for (const lookup of successfulLookups) {
    clanFetchCount += 1;
    const clanTag = normalizeClanTag(lookup.row.tag);
    if (!clanTag) {
      continue;
    }

    fwaClanTags.add(clanTag);
    const trackedClanName = normalizeText(lookup.row.name);
    const shortName = normalizeText(lookup.row.shortName);
    const clanName = normalizeText(lookup.clan?.name ?? trackedClanName);
    trackedClans.push({
      tag: clanTag,
      name: clanName,
      shortName,
      clanRoleId: String(lookup.row.clanRoleId ?? "").trim() || null,
      leadRoleId: String(lookup.row.leadRoleId ?? "").trim() || null,
    });

    const members = Array.isArray(lookup.clan?.members)
      ? lookup.clan.members
      : Array.isArray(lookup.clan?.memberList)
        ? lookup.clan.memberList
        : [];
    const playerTags = new Set<string>();
    for (const member of members) {
      const clanMember = member as {
        tag?: unknown;
        name?: unknown;
        townHallLevel?: unknown;
        townhallLevel?: unknown;
        townHall?: unknown;
        role?: unknown;
        leagueTier?: { id?: unknown; name?: unknown } | null;
        league?: { name?: unknown } | null;
      };
      const playerTag = normalizePlayerTag(String(clanMember.tag ?? ""));
      if (!playerTag) {
        continue;
      }

      playerTags.add(playerTag);
      fwaMemberTags.add(playerTag);
      candidatePlayerTags.add(playerTag);

      if (!playerCurrentByTag.has(playerTag)) {
        playerCurrentByTag.set(
          playerTag,
          buildTrackedClanPlayerCurrentFromMember({
            playerTag,
            playerName: clanMember.name,
            townHall: clanMember.townHallLevel ?? clanMember.townhallLevel ?? clanMember.townHall ?? null,
            currentClanTag: clanTag,
            currentClanName: clanName,
            role: clanMember.role,
            leagueTier: clanMember.leagueTier ?? null,
            league: clanMember.league ?? null,
          }),
        );
      }
    }

    clanMembershipIndex.set(clanTag, {
      source: "FWA",
      playerTags,
    });
  }

  const linkedAccountsByPlayerTag = await loadLinkedAccountsForPlayerTags({
    playerTags: [...candidatePlayerTags],
  });
  const candidateUserIds = new Set<string>(currentHolderIds);
  const linkedUserIds = new Set<string>();
  for (const linkedAccounts of linkedAccountsByPlayerTag.values()) {
    for (const account of linkedAccounts) {
      const userId = normalizeDiscordUserId(account.discordUserId);
      if (userId) {
        linkedUserIds.add(userId);
      }
    }
  }

  for (const userId of linkedUserIds) {
    candidateUserIds.add(userId);
  }

  const memberSource = await loadGuildMembersByIdsAllowPartial({
    guild: input.guild,
    userIds: candidateUserIds,
  });
  const membersById = memberSource.membersById;
  const loadedCandidateUserIds = new Set<string>(membersById.keys());
  const rateLimitFailureReason = memberSource.failureReasons.find((reason) =>
    reason.toLowerCase().includes("rate-limited member fetching"),
  );
  if (rateLimitFailureReason) {
    throw new Error(rateLimitFailureReason);
  }

  const linkedAccountsByUserId = await loadLinkedAccountsForGuildMemberIds({
    guildMemberIds: [...loadedCandidateUserIds],
  });

  return {
    requestedClanCount: matchingRows.length,
    configuredClanTags: [...configuredClanTags].sort(),
    trackedClans,
    clanMembershipIndex,
    trackedMembershipScope: {
      fwaClanTags,
      cwlClanTags: new Set<string>(),
      fwaMemberTags,
      cwlMemberTags: new Set<string>(),
      cwlClanFetchCount: 0,
    },
    playerCurrentByTag,
    linkedAccountsByUserId,
    candidateUserIds: loadedCandidateUserIds,
    membersById,
    cachedMemberCount,
    guildMemberCount: input.guild.memberCount,
    targetedFetchRequestedCount: memberSource.targetedFetchRequestedCount,
    targetedFetchSucceededCount: memberSource.targetedFetchSucceededCount,
    targetedFetchFailedCount: memberSource.targetedFetchFailedCount,
    clanFetchCount,
    failedClanTags: [...failedClanTags].sort(),
  };
}

async function loadTrackedClanMembershipScope(input: {
  season: string;
  cocService?: CoCService | null;
  guildId?: string;
  telemetry?: AutoRoleRefreshTelemetry | null;
}): Promise<{
  fwaClanTags: Set<string>;
  cwlClanTags: Set<string>;
  fwaMemberTags: Set<string>;
  cwlMemberTags: Set<string>;
  cwlClanFetchCount: number;
}> {
  const [fwaRows, cwlRows] = await Promise.all([
    prisma.trackedClan.findMany({
      select: { tag: true },
    }),
    prisma.cwlTrackedClan.findMany({
      where: { season: input.season },
      select: { tag: true },
    }),
  ]);

  const fwaClanTags = normalizeClanTags(fwaRows.map((row) => row.tag));
  const cwlClanTags = normalizeClanTags(cwlRows.map((row) => row.tag));

  const fwaMemberTags = new Set<string>();
  if (fwaClanTags.size > 0) {
    const fwaMemberRows = await prisma.fwaClanMemberCurrent.findMany({
      where: { clanTag: { in: [...fwaClanTags] } },
      select: {
        clanTag: true,
        playerTag: true,
      },
    });
    for (const row of fwaMemberRows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      fwaMemberTags.add(playerTag);
    }
  }

  const cwlMemberTags = new Set<string>();
  let cwlClanFetchCount = 0;
  const cwlCurrentEvents = cwlClanTags.size > 0
    ? await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
        clanTags: [...cwlClanTags],
      })
    : new Map();
  const cwlEventIds = [...new Set([...cwlCurrentEvents.values()].map((event) => event.id))];
  const cwlRoundRows = cwlEventIds.length > 0
    ? await prisma.cwlRoundMemberCurrent.findMany({
        where: {
          eventInstanceId: { in: cwlEventIds },
          clanTag: { in: [...cwlClanTags] },
        },
        select: {
          clanTag: true,
          playerTag: true,
        },
      })
    : [];
  const cwlClanTagsSeen = new Set<string>();
  for (const row of cwlRoundRows) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (playerTag) {
      cwlMemberTags.add(playerTag);
    }
    const clanTag = normalizeClanTag(row.clanTag);
    if (clanTag) {
      cwlClanTagsSeen.add(clanTag);
    }
  }

  const missingCwlClanTags = [...cwlClanTags].filter((tag) => !cwlClanTagsSeen.has(tag));
  if (missingCwlClanTags.length > 0 && input.cocService && typeof input.cocService.getClan === "function") {
    const cocService = input.cocService;
    const fetchedClans = await Promise.all(
      missingCwlClanTags.map(async (clanTag) => {
        const clan = await fetchClanWithTelemetry({
          cocService,
          clanTag,
          guildId: input.guildId,
          telemetry: input.telemetry,
          fetchLabel: "tracked_membership_scope_clan",
        });
        return { clanTag, clan };
      }),
    );
    for (const { clan } of fetchedClans) {
      cwlClanFetchCount += 1;
      for (const member of clan?.members ?? []) {
        const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
        if (playerTag) {
          cwlMemberTags.add(playerTag);
        }
      }
    }
  }

  return {
    fwaClanTags,
    cwlClanTags,
    fwaMemberTags,
    cwlMemberTags,
    cwlClanFetchCount,
  };
}

async function loadClanMembershipIndex(input: {
  season: string;
  rules: AutoRoleRuleRecord[];
}): Promise<AutoRoleClanMembershipIndex> {
  const clanTags = normalizePlayerTags(
    input.rules
      .filter((rule) => rule.enabled && rule.type === "CLAN")
      .map((rule) => rule.targetValue),
  );
  if (clanTags.length === 0) {
    return new Map();
  }

  const [fwaRows, cwlRows] = await Promise.all([
    prisma.trackedClan.findMany({
      where: { tag: { in: clanTags } },
      select: { tag: true },
    }),
    prisma.cwlTrackedClan.findMany({
      where: {
        season: input.season,
        tag: { in: clanTags },
      },
      select: { tag: true },
    }),
  ]);

  const fwaTagSet = new Set(fwaRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean));
  const cwlTagSet = new Set(cwlRows.map((row) => normalizeClanTag(row.tag)).filter(Boolean));

  const index = new Map<string, AutoRoleClanMembershipIndexRow>();
  const fwaClanTags = [...fwaTagSet].filter((tag) => !cwlTagSet.has(tag));
  const cwlClanTags = [...cwlTagSet].filter((tag) => !fwaTagSet.has(tag));
  const ambiguousTags = [...fwaTagSet].filter((tag) => cwlTagSet.has(tag));

  if (fwaClanTags.length > 0) {
    const fwaMembershipRows = await prisma.fwaClanMemberCurrent.findMany({
      where: { clanTag: { in: fwaClanTags } },
      select: { clanTag: true, playerTag: true },
    });
    for (const clanTag of fwaClanTags) {
      index.set(clanTag, {
        source: "FWA",
        playerTags: new Set(
          fwaMembershipRows
            .filter((row) => normalizeClanTag(row.clanTag) === clanTag)
            .map((row) => normalizePlayerTag(row.playerTag))
            .filter(Boolean),
        ),
      });
    }
  }

  if (cwlClanTags.length > 0) {
    const currentCwlEvents = await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
      clanTags: cwlClanTags,
    });
    const cwlEventIds = [...new Set([...currentCwlEvents.values()].map((event) => event.id))];
    const cwlMembershipRows = cwlEventIds.length > 0
      ? await prisma.cwlPlayerClanSeason.findMany({
          where: { eventInstanceId: { in: cwlEventIds }, cwlClanTag: { in: cwlClanTags } },
          select: { cwlClanTag: true, playerTag: true },
        })
      : [];
    for (const clanTag of cwlClanTags) {
      index.set(clanTag, {
        source: "CWL",
        playerTags: new Set(
          cwlMembershipRows
            .filter((row) => normalizeClanTag(row.cwlClanTag ?? "") === clanTag)
            .map((row) => normalizePlayerTag(row.playerTag))
            .filter(Boolean),
        ),
      });
    }
  }

  if (ambiguousTags.length > 0) {
    const currentCwlEvents = await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
      clanTags: ambiguousTags,
    });
    const cwlEventIds = [...new Set([...currentCwlEvents.values()].map((event) => event.id))];
    const [fwaMembershipRows, cwlMembershipRows] = await Promise.all([
      prisma.fwaClanMemberCurrent.findMany({
        where: { clanTag: { in: ambiguousTags } },
        select: { clanTag: true, playerTag: true },
      }),
      cwlEventIds.length > 0
        ? prisma.cwlPlayerClanSeason.findMany({
            where: { eventInstanceId: { in: cwlEventIds }, cwlClanTag: { in: ambiguousTags } },
            select: { cwlClanTag: true, playerTag: true },
          })
        : Promise.resolve([] as Array<{ cwlClanTag: string; playerTag: string }>),
    ]);
    for (const clanTag of ambiguousTags) {
      const playerTags = new Set<string>();
      for (const row of fwaMembershipRows) {
        if (normalizeClanTag(row.clanTag) === clanTag) {
          const tag = normalizePlayerTag(row.playerTag);
          if (tag) playerTags.add(tag);
        }
      }
      for (const row of cwlMembershipRows) {
        if (normalizeClanTag(row.cwlClanTag ?? "") === clanTag) {
          const tag = normalizePlayerTag(row.playerTag);
          if (tag) playerTags.add(tag);
        }
      }
      index.set(clanTag, {
        source: "AMBIGUOUS",
        playerTags,
      });
    }
  }

  return index;
}

function filterLinkedAccountsForClanMembership(
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>,
  clanMembershipIndex: AutoRoleClanMembershipIndex,
  targetClanTags: string[],
): Set<string> {
  const playerTags = new Set<string>();
  const normalizedTargets = new Set(targetClanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean));
  if (normalizedTargets.size === 0) return playerTags;

  const membershipTags = new Set<string>();
  for (const target of normalizedTargets) {
    const membership = clanMembershipIndex.get(target) ?? null;
    if (!membership) continue;
    for (const playerTag of membership.playerTags) {
      membershipTags.add(playerTag);
    }
  }

  if (membershipTags.size === 0) return playerTags;

  for (const [discordUserId, accounts] of linkedAccountsByUserId.entries()) {
    if (accounts.some((account) => membershipTags.has(normalizePlayerTag(account.playerTag)))) {
      playerTags.add(discordUserId);
    }
  }

  return playerTags;
}

function buildManagedRoleIds(
  snapshot: AutoRoleGuildStateSnapshot,
  trackedClans: AutoRoleTrackedClanLike[],
): Set<string> {
  return autoRoleEvaluationService.getManagedRoleIds({
    config: snapshot.config,
    rules: snapshot.rules,
    trackedClans,
  });
}

/** Purpose: collect clan-role ids once for the current refresh pass. */
function collectClanRoleIds(
  snapshot: AutoRoleGuildStateSnapshot,
  trackedClans: AutoRoleTrackedClanLike[],
): Set<string> {
  const roleIds = new Set<string>();
  const cwlClanRoleId = String(snapshot.config.cwlClanRoleId ?? "").trim();
  if (cwlClanRoleId) {
    roleIds.add(cwlClanRoleId);
  }
  for (const trackedClan of trackedClans) {
    const clanRoleId = String(trackedClan.clanRoleId ?? "").trim();
    if (clanRoleId) {
      roleIds.add(clanRoleId);
    }
  }
  for (const rule of snapshot.rules) {
    if (!rule.enabled || rule.type !== AutoRoleRuleType.CLAN) continue;
    const clanRoleId = String(rule.discordRoleId ?? "").trim();
    if (clanRoleId) {
      roleIds.add(clanRoleId);
    }
  }
  return roleIds;
}

function resolveVisitorRoleAvailability(guild: Guild, visitorRoleId: string | null | undefined): boolean {
  const normalizedVisitorRoleId = String(visitorRoleId ?? "").trim();
  if (!normalizedVisitorRoleId) {
    return false;
  }

  const roleCache = guild.roles?.cache ?? null;
  if (!roleCache || typeof roleCache.has !== "function") {
    return true;
  }

  return roleCache.has(normalizedVisitorRoleId);
}

function collectConfiguredLeadRoleIds(trackedClans: AutoRoleTrackedClanLike[]): Set<string> {
  const roleIds = new Set<string>();
  for (const trackedClan of trackedClans) {
    const leadRoleId = String(trackedClan.leadRoleId ?? "").trim();
    if (leadRoleId) {
      roleIds.add(leadRoleId);
    }
  }
  return roleIds;
}

function formatTrackedClanFetchFailureTags(failedClanTags: Iterable<string>): string {
  return [...new Set([...failedClanTags].map((tag) => normalizeClanTag(String(tag ?? ""))).filter(Boolean))].sort().join(",");
}

function collectMissingTrackedClanTags(
  configuredClanTags: Iterable<string>,
  trackedClans: Array<{ tag: string }>,
): string[] {
  const trackedClanTags = new Set(
    trackedClans.map((clan) => normalizeClanTag(clan.tag)).filter((tag): tag is string => Boolean(tag)),
  );
  return [...new Set([...configuredClanTags].map((tag) => normalizeClanTag(String(tag ?? ""))).filter(Boolean))]
    .sort()
    .filter((tag) => !trackedClanTags.has(tag));
}

function buildTrackedClanFetchFailureError(input: {
  scope: AutoRoleRefreshScope;
  failedClanTags: Iterable<string>;
}): Error {
  const failedClanTags = formatTrackedClanFetchFailureTags(input.failedClanTags);
  const scopeLabel =
    input.scope.kind === "guild"
      ? "guild"
      : input.scope.kind === "user"
        ? `user:${input.scope.discordUserId}`
        : `role:${input.scope.discordRoleId}`;
  return new Error(
    `Tracked clan fetch failed for ${scopeLabel}${failedClanTags ? ` failed_clan_tags=${failedClanTags}` : ""}`,
  );
}

function buildLeadRoleRemovalSuppression(input: {
  scope: AutoRoleRefreshScope;
  configuredLeadRoleIds: Set<string>;
}): Set<string> {
  if (input.configuredLeadRoleIds.size === 0) {
    return new Set<string>();
  }

  if (input.scope.kind === "user") {
    return new Set<string>();
  }

  if (input.scope.kind === "guild") {
    return new Set(input.configuredLeadRoleIds);
  }

  if (input.scope.kind === "role") {
    const targetRoleId = String(input.scope.discordRoleId ?? "").trim();
    if (!targetRoleId || !input.configuredLeadRoleIds.has(targetRoleId)) {
      return new Set(input.configuredLeadRoleIds);
    }

    return new Set([...input.configuredLeadRoleIds].filter((roleId) => roleId !== targetRoleId));
  }

  return new Set<string>();
}

/** Purpose: protect live-data-backed managed roles from stale removals after a partial live refresh failure. */
function collectPartialUserRefreshRemovalSuppression(input: {
  snapshot: AutoRoleGuildStateSnapshot;
  trackedClans: AutoRoleTrackedClanLike[];
}): Set<string> {
  const roleIds = new Set<string>();
  for (const rule of input.snapshot.rules) {
    if (!rule.enabled) continue;
    if (
      rule.type !== AutoRoleRuleType.CLAN &&
      rule.type !== AutoRoleRuleType.CLAN_ROLE &&
      rule.type !== AutoRoleRuleType.TOWN_HALL &&
      rule.type !== AutoRoleRuleType.LEAGUE
    ) {
      continue;
    }

    const roleId = String(rule.discordRoleId ?? "").trim();
    if (roleId) {
      roleIds.add(roleId);
    }
  }

  for (const trackedClan of input.trackedClans) {
    const clanRoleId = String(trackedClan.clanRoleId ?? "").trim();
    if (clanRoleId) {
      roleIds.add(clanRoleId);
    }

    const leadRoleId = String(trackedClan.leadRoleId ?? "").trim();
    if (leadRoleId) {
      roleIds.add(leadRoleId);
    }
  }

  return roleIds;
}

/** Purpose: build a failed user-refresh member result without running stale autorole evaluation. */
function buildLinkedPlayerRefreshFailureResult(input: {
  guildId: string;
  discordUserId: string;
  scope: AutoRoleRefreshScope;
  refreshOutcome: AutoRoleLinkedPlayerRefreshResult;
}): AutoRoleMemberApplyResult {
  return {
    discordUserId: input.discordUserId,
    status: "failed",
    skipReason: null,
    rolesAdded: [],
    rolesRemoved: [],
    nicknameStatus: "skipped",
    nicknameReason: "linked player data could not be refreshed",
    failureReasons: [
      `linked player data could not be refreshed (${input.refreshOutcome.successfulCount}/${input.refreshOutcome.requestedPlayerCount} refreshed; failed tags: ${input.refreshOutcome.failedPlayerTags.length > 0 ? input.refreshOutcome.failedPlayerTags.join(",") : "none"})`,
    ],
    resultHash: `autorole:user_refresh_failed:${input.guildId}:${input.discordUserId}:${input.scope.kind}`,
  };
}

function collectCurrentRoleHolders(
  membersById: Map<string, AutoRoleGuildMemberLike>,
  managedRoleIds: Set<string>,
): Set<string> {
  const holderIds = new Set<string>();
  for (const member of membersById.values()) {
    if (memberHasAnyManagedRole(member, managedRoleIds)) {
      holderIds.add(member.id);
    }
  }
  return holderIds;
}

function collectCandidateUsersForScope(input: {
  scope: AutoRoleRefreshScope;
  membersById: Map<string, AutoRoleGuildMemberLike>;
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
  rules: AutoRoleRuleRecord[];
  clanMembershipIndex: AutoRoleClanMembershipIndex;
  managedRoleIds: Set<string>;
}): Set<string> {
  const candidateIds = new Set<string>();

  if (input.scope.kind === "user") {
    candidateIds.add(input.scope.discordUserId);
    return candidateIds;
  }

  const currentRoleHolders = collectCurrentRoleHolders(input.membersById, input.managedRoleIds);
  for (const userId of currentRoleHolders) {
    candidateIds.add(userId);
  }

  const linkedUserIds = new Set(input.linkedAccountsByUserId.keys());
  if (input.scope.kind === "guild") {
    for (const userId of linkedUserIds) candidateIds.add(userId);
    return candidateIds;
  }

  const roleScope = input.scope.kind === "role" ? input.scope : null;
  if (!roleScope) {
    return candidateIds;
  }

  const roleRules = input.rules.filter((rule) => rule.enabled && rule.discordRoleId === roleScope.discordRoleId);
  const clanRules = roleRules.filter((rule) => rule.type === "CLAN");
  const clanTargets = clanRules.map((rule) => rule.targetValue);
  const clanLinkedUserIds = filterLinkedAccountsForClanMembership(
    input.linkedAccountsByUserId,
    input.clanMembershipIndex,
    clanTargets,
  );

  for (const userId of clanLinkedUserIds) candidateIds.add(userId);
  if (roleRules.length === 0 || roleRules.some((rule) => rule.type !== "CLAN")) {
    for (const userId of linkedUserIds) candidateIds.add(userId);
  }

  return candidateIds;
}

function summarizeResultCounts(results: AutoRoleMemberApplyResult[]): {
  evaluatedCount: number;
  addedCount: number;
  removedCount: number;
  skippedCount: number;
  failedCount: number;
} {
  let addedCount = 0;
  let removedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const result of results) {
    if (result.status === "applied") {
      addedCount += result.rolesAdded.length;
    } else if (result.status === "failed") {
      failedCount += 1;
    } else {
      skippedCount += 1;
    }
    removedCount += result.rolesRemoved.length;
  }

  return {
    evaluatedCount: results.length,
    addedCount,
    removedCount,
    skippedCount,
    failedCount,
  };
}

async function persistAutoRoleMemberState(input: {
  guildId: string;
  evaluation: AutoRoleMemberEvaluation;
  result: AutoRoleMemberApplyResult;
  now: Date;
}): Promise<void> {
  const applied = input.result.status === "applied" || input.result.rolesAdded.length > 0 || input.result.rolesRemoved.length > 0;
  await prisma.autoRoleMemberState.upsert({
    where: {
      guildId_discordUserId: {
        guildId: input.guildId,
        discordUserId: input.evaluation.discordUserId,
      },
    },
    create: {
      guildId: input.guildId,
      discordUserId: input.evaluation.discordUserId,
      lastEvaluatedAt: input.now,
      lastAppliedAt:
        input.result.status === "applied" || input.result.rolesAdded.length > 0 || input.result.rolesRemoved.length > 0
          ? input.now
          : null,
      lastResultHash: input.evaluation.resultHash,
      lastError: input.result.failureReasons.length > 0
        ? input.result.failureReasons.join(" | ")
        : input.result.skipReason ?? null,
    },
    update: {
      lastEvaluatedAt: input.now,
      ...(applied ? { lastAppliedAt: input.now } : {}),
      lastResultHash: input.evaluation.resultHash,
      lastError: input.result.failureReasons.length > 0
        ? input.result.failureReasons.join(" | ")
        : input.result.skipReason ?? null,
    },
  });
}

function buildExclusionIndexes(snapshot: AutoRoleGuildStateSnapshot): {
  excludedUserIds: Set<string>;
  excludedRoleIds: Set<string>;
} {
  return {
    excludedUserIds: new Set(
      snapshot.exclusions.users
        .map((row) => normalizeDiscordUserId(row.discordUserId))
        .filter((value): value is string => Boolean(value)),
    ),
    excludedRoleIds: new Set(
      snapshot.exclusions.roles
        .map((row) => String(row.discordRoleId ?? "").trim())
        .filter(Boolean),
    ),
  };
}

function resolveExclusionSkipReason(input: {
  member: AutoRoleGuildMemberLike;
  excludedUserIds: Set<string>;
  excludedRoleIds: Set<string>;
}): string | null {
  if (input.excludedUserIds.has(input.member.id)) {
    return "excluded user";
  }

  for (const roleId of input.member.roles.cache.keys()) {
    const normalizedRoleId = String(roleId ?? "").trim();
    if (normalizedRoleId && input.excludedRoleIds.has(normalizedRoleId)) {
      return `excluded role ${normalizedRoleId}`;
    }
  }

  return null;
}

async function runRefreshPass(input: {
  guildId: string;
  scope: AutoRoleRefreshScope;
  guild: Guild;
  snapshot: AutoRoleGuildStateSnapshot;
  trackedClans: AutoRoleTrackedClanLike[];
  trackedFwaMemberTags: Set<string>;
  membersById: Map<string, AutoRoleGuildMemberLike>;
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  clanMembershipIndex: AutoRoleClanMembershipIndex;
  trackedMembershipScope: {
    fwaClanTags: Set<string>;
    cwlClanTags: Set<string>;
    fwaMemberTags: Set<string>;
    cwlMemberTags: Set<string>;
    cwlClanFetchCount: number;
  };
  runId: string;
  now: Date;
  candidateUserIdsOverride?: Set<string>;
  suppressRemovalRoleIds?: Set<string>;
  suppressNicknameUpdate?: boolean;
  nicknameSuppressionReason?: string | null;
  preferCurrentClanTagForClanRules?: boolean;
  visitorRoleAvailable?: boolean;
  visitorRoleAdditionsSuppressed?: boolean;
  memberSourceSummary?: AutoRoleRefreshMemberSourceSummary | null;
}): Promise<AutoRoleRefreshResult> {
  const now = input.now;
  const managedRoleIds = buildManagedRoleIds(input.snapshot, input.trackedClans);
  const clanRoleIds = collectClanRoleIds(input.snapshot, input.trackedClans);
  const suppressRemovalRoleIds = new Set([
    ...buildLeadRoleRemovalSuppression({
      scope: input.scope,
      configuredLeadRoleIds: collectConfiguredLeadRoleIds(input.trackedClans),
    }),
    ...(input.suppressRemovalRoleIds ?? []),
  ]);
  const candidateUserIds =
    input.candidateUserIdsOverride ??
    collectCandidateUsersForScope({
      scope: input.scope,
      membersById: input.membersById,
      linkedAccountsByUserId: input.linkedAccountsByUserId,
      rules: input.snapshot.rules,
      clanMembershipIndex: input.clanMembershipIndex,
      managedRoleIds,
    });
  const { excludedUserIds, excludedRoleIds } = buildExclusionIndexes(input.snapshot);

  const memberResults: AutoRoleMemberApplyResult[] = [];
  try {
    for (const userId of normalizeMemberIds(candidateUserIds)) {
      const member = input.membersById.get(userId) ?? null;
      if (!member) {
        dozzleLog.warn(`[autorole] event=member_missing guild_id=${input.guildId} user_id=${userId} scope=${input.scope.kind}`);
        memberResults.push({
          discordUserId: userId,
          status: "failed",
          skipReason: null,
          rolesAdded: [],
          rolesRemoved: [],
          nicknameStatus: "skipped",
          nicknameReason: "member missing from guild fetch",
          failureReasons: ["member missing from guild fetch"],
          resultHash: `missing:${input.guildId}:${userId}:${input.scope.kind}`,
        });
        continue;
      }

      const exclusionSkipReason = resolveExclusionSkipReason({
        member,
        excludedUserIds,
        excludedRoleIds,
      });
      if (exclusionSkipReason) {
        dozzleLog.debug(
          `[autorole] event=skip guild_id=${input.guildId} scope=${input.scope.kind} user_id=${userId} skip_reason=${exclusionSkipReason}`,
        );
        const skippedResult: AutoRoleMemberApplyResult = {
          discordUserId: userId,
          status: "skipped",
          skipReason: exclusionSkipReason,
          rolesAdded: [],
          rolesRemoved: [],
          nicknameStatus: "skipped",
          nicknameReason: "excluded from autorole",
          failureReasons: [],
          resultHash: `excluded:${input.guildId}:${userId}:${input.scope.kind}`,
        };
        memberResults.push(skippedResult);
        await persistAutoRoleMemberState({
          guildId: input.guildId,
          evaluation: {
            discordUserId: userId,
            skipReason: exclusionSkipReason,
            desiredManagedRoleIds: [],
            matchedRuleIds: [],
            primaryPlayerTag: null,
            primaryPlayerName: null,
            resultHash: skippedResult.resultHash,
          },
          result: skippedResult,
          now,
        });
        continue;
      }

      const linkedAccounts = input.linkedAccountsByUserId.get(userId) ?? [];
      const evaluation = autoRoleEvaluationService.evaluateMember({
        config: input.snapshot.config,
        rules: input.snapshot.rules,
        managedRoleIds,
        member,
        linkedAccounts,
        playerCurrentByTag: input.playerCurrentByTag,
        clanMembershipByTag: input.clanMembershipIndex,
        trackedClanScope: input.trackedMembershipScope,
        trackedClans: input.trackedClans,
        preferCurrentClanTagForClanRules: input.preferCurrentClanTagForClanRules ?? false,
      });
      dozzleLog.trace(
        `[autorole] event=evaluate guild_id=${input.guildId} scope=${input.scope.kind} user_id=${userId} skip_reason=${evaluation.skipReason ?? "none"} desired_roles=${evaluation.desiredManagedRoleIds.join(",") || "none"} primary_player=${evaluation.primaryPlayerTag ?? "none"}`,
      );

      const result = await autoRoleApplyService.applyMember({
        guildId: input.guildId,
        config: input.snapshot.config,
        managedRoleIds,
        rules: input.snapshot.rules,
        member,
        evaluation,
        linkedAccounts,
        playerCurrentByTag: input.playerCurrentByTag,
        trackedClans: input.trackedClans,
        clanRoleIds,
        suppressRemovalRoleIds,
        suppressNicknameUpdate: input.suppressNicknameUpdate,
        nicknameSuppressionReason: input.nicknameSuppressionReason,
        trackedFwaMemberTags: input.trackedFwaMemberTags,
        visitorRoleAvailable: input.visitorRoleAvailable,
        visitorRoleAdditionsSuppressed: input.visitorRoleAdditionsSuppressed,
        now: input.now,
      });

      memberResults.push(result);
      await persistAutoRoleMemberState({
        guildId: input.guildId,
        evaluation,
        result,
        now,
      });
    }

    const counts = summarizeResultCounts(memberResults);
    await prisma.autoRoleSyncRun.update({
      where: { id: input.runId },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        evaluatedCount: counts.evaluatedCount,
        appliedCount: counts.addedCount,
        removedCount: counts.removedCount,
        skippedCount: counts.skippedCount,
        error: counts.failedCount > 0 ? `failed_count=${counts.failedCount}` : null,
      },
    });

    return {
      guildId: input.guildId,
      scope: input.scope,
      runId: input.runId,
      evaluatedCount: counts.evaluatedCount,
      addedCount: counts.addedCount,
      removedCount: counts.removedCount,
      skippedCount: counts.skippedCount,
      failedCount: counts.failedCount,
      memberResults,
      memberSourceSummary: input.memberSourceSummary ?? null,
    };
  } catch (error) {
    await prisma.autoRoleSyncRun.update({
      where: { id: input.runId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: formatError(error),
      },
    });
    throw error;
  }
}

/** Purpose: execute manual autorole refreshes for a guild, one member, or one managed role. */
export class AutoRoleRefreshService {
  constructor(private readonly autoRoleCrud = autoRoleService) {}

  async refreshGuild(input: {
    guild: Guild;
    guildId: string;
    cocService?: CoCService | null;
    now?: Date;
    telemetry?: AutoRoleRefreshTelemetry | null;
  }): Promise<AutoRoleRefreshResult> {
    return this.refresh({
      guild: input.guild,
      guildId: input.guildId,
      scope: { kind: "guild" },
      cocService: input.cocService ?? null,
      now: input.now ?? new Date(),
      telemetry: input.telemetry ?? null,
    });
  }

  async refreshUser(input: {
    guild: Guild;
    guildId: string;
    discordUserId: string;
    cocService?: CoCService | null;
    now?: Date;
    telemetry?: AutoRoleRefreshTelemetry | null;
  }): Promise<AutoRoleRefreshResult> {
    return this.refresh({
      guild: input.guild,
      guildId: input.guildId,
      scope: { kind: "user", discordUserId: input.discordUserId },
      cocService: input.cocService ?? null,
      now: input.now ?? new Date(),
      telemetry: input.telemetry ?? null,
    });
  }

  async refreshRole(input: {
    guild: Guild;
    guildId: string;
    discordRoleId: string;
    cocService?: CoCService | null;
    now?: Date;
    telemetry?: AutoRoleRefreshTelemetry | null;
  }): Promise<AutoRoleRefreshResult> {
    return this.refresh({
      guild: input.guild,
      guildId: input.guildId,
      scope: { kind: "role", discordRoleId: input.discordRoleId },
      cocService: input.cocService ?? null,
      now: input.now ?? new Date(),
      telemetry: input.telemetry ?? null,
    });
  }

  private async refresh(input: {
    guild: Guild;
    guildId: string;
    scope: AutoRoleRefreshScope;
    cocService?: CoCService | null;
    now: Date;
    telemetry?: AutoRoleRefreshTelemetry | null;
  }): Promise<AutoRoleRefreshResult> {
    const refreshStartedAtMs = input.telemetry?.refreshStartedAtMs ?? Date.now();
    const run = await prisma.autoRoleSyncRun.create({
      data: {
        guildId: input.guildId,
        status: "RUNNING",
        startedAt: input.now,
        evaluatedCount: 0,
        appliedCount: 0,
        removedCount: 0,
        skippedCount: 0,
        error: null,
      },
      select: { id: true },
    });

    try {
      if (isMirrorPollingMode(process.env)) {
        throw new Error("Autorole refresh is disabled while POLLING_MODE=mirror.");
      }

      const snapshot = await this.autoRoleCrud.getGuildStateSnapshot(input.guildId);
      if (!snapshot.config.enabled) {
        throw new Error("Autorole is disabled for this guild.");
      }
      if (snapshot.config.killSwitchEnabled) {
        throw new Error("Autorole kill switch is enabled for this guild.");
      }

      const visitorRoleId = String(snapshot.config.nonMemberRoleId ?? "").trim();
      const visitorRoleConfigured = snapshot.config.nonMemberEnabled && visitorRoleId.length > 0;
      const visitorRoleAvailable = resolveVisitorRoleAvailability(input.guild, visitorRoleId);
      if (visitorRoleConfigured && !visitorRoleAvailable) {
        dozzleLog.warn(
          `[autorole] event=visitor_role_missing guild_id=${input.guildId} role_id=${visitorRoleId} reason=missing_or_deleted action=skip_visitor_role_changes`,
        );
      }

      const trackedClans = await loadTrackedClansForAutorole();
      const managedRoleIds = buildManagedRoleIds(snapshot, trackedClans);
      let suppressRemovalRoleIds = buildLeadRoleRemovalSuppression({
        scope: input.scope,
        configuredLeadRoleIds: collectConfiguredLeadRoleIds(trackedClans),
      });
      if (input.scope.kind === "role" && !managedRoleIds.has(input.scope.discordRoleId)) {
        throw new Error("That Discord role is not managed by autorole.");
      }

      if (input.scope.kind === "role") {
        const roleMembersById = getGuildCachedMembersMap(input.guild);
        const roleCacheCoverageComplete = input.guild.memberCount <= roleMembersById.size;
        const clanRoleState = await loadTrackedClanRoleRefreshState({
          guildId: input.guildId,
          roleId: input.scope.discordRoleId,
          guild: input.guild,
          cocService: input.cocService ?? null,
          telemetry: input.telemetry ?? null,
        });
        if (clanRoleState) {
          const missingClanTags = collectMissingTrackedClanTags(
            clanRoleState.configuredClanTags,
            clanRoleState.trackedClans,
          );
          const failedClanTags = formatTrackedClanFetchFailureTags([
            ...clanRoleState.failedClanTags,
            ...missingClanTags,
          ]);
          const hasFetchFailure =
            input.cocService &&
            (clanRoleState.requestedClanCount > clanRoleState.trackedClans.length ||
              failedClanTags.length > 0);
          if (hasFetchFailure) {
            const error = buildTrackedClanFetchFailureError({
              scope: input.scope,
              failedClanTags: [...clanRoleState.failedClanTags, ...missingClanTags],
            });
            dozzleLog.warn(
              `[autorole] event=tracked_clan_fetch_failed guild_id=${input.guildId} scope=${input.scope.kind} target_role=${input.scope.discordRoleId} failed_clan_tags=${failedClanTags} action=abort_before_apply removed=0`,
            );
            throw error;
          }

          const currentHolderCount = collectCurrentRoleHolders(
            clanRoleState.membersById,
            new Set([input.scope.discordRoleId]),
          ).size;
          const visitorRoleAdditionsSuppressed = visitorRoleConfigured && !roleCacheCoverageComplete;
          const memberSourceSummary = buildMemberSourceSummary({
            scope: input.scope,
            guildMemberCount: clanRoleState.guildMemberCount,
            cachedMemberCount: clanRoleState.cachedMemberCount,
            cacheCoverageComplete: roleCacheCoverageComplete,
            candidateUserCount: clanRoleState.candidateUserIds.size,
            targetedFetchRequestedCount: clanRoleState.targetedFetchRequestedCount,
            targetedFetchSucceededCount: clanRoleState.targetedFetchSucceededCount,
            targetedFetchFailedCount: clanRoleState.targetedFetchFailedCount,
            visitorRoleAdditionsSuppressed,
            playerCurrentPersistedRowCount: 0,
            trackedClanOverlayCount: clanRoleState.playerCurrentByTag.size,
          });
          dozzleLog.info(
            `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} target_role=${input.scope.discordRoleId} clan_role_clans=${clanRoleState.trackedClans.length} current_holders=${currentHolderCount} linked_users=${clanRoleState.linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} clan_member_tags=${clanRoleState.trackedMembershipScope.fwaMemberTags.size} clan_fetches=${clanRoleState.clanFetchCount} player_current_tags=${clanRoleState.playerCurrentByTag.size} member_fetch_mode=targeted`,
          );

          const result = await runRefreshPass({
            guildId: input.guildId,
            scope: input.scope,
            guild: input.guild,
            snapshot,
            trackedClans: clanRoleState.trackedClans,
            membersById: clanRoleState.membersById,
            linkedAccountsByUserId: clanRoleState.linkedAccountsByUserId,
            playerCurrentByTag: clanRoleState.playerCurrentByTag,
            clanMembershipIndex: clanRoleState.clanMembershipIndex,
            trackedMembershipScope: clanRoleState.trackedMembershipScope,
            runId: run.id,
            now: input.now,
            candidateUserIdsOverride: clanRoleState.candidateUserIds,
            suppressRemovalRoleIds,
            preferCurrentClanTagForClanRules: true,
            trackedFwaMemberTags: clanRoleState.trackedMembershipScope.fwaMemberTags,
            visitorRoleAvailable,
            visitorRoleAdditionsSuppressed,
          });
          return {
            ...result,
            memberSourceSummary,
          };
        }

        const leadRoleState = await loadTrackedLeadRoleRefreshState({
          guildId: input.guildId,
          roleId: input.scope.discordRoleId,
          guild: input.guild,
          membersById: roleMembersById,
          cocService: input.cocService ?? null,
          telemetry: input.telemetry ?? null,
        });
        if (leadRoleState) {
          const missingClanTags = collectMissingTrackedClanTags(
            leadRoleState.configuredClanTags,
            leadRoleState.trackedClans,
          );
          const failedClanTags = formatTrackedClanFetchFailureTags([
            ...leadRoleState.failedClanTags,
            ...missingClanTags,
          ]);
          const hasFetchFailure =
            input.cocService &&
            (leadRoleState.requestedClanCount > leadRoleState.trackedClans.length ||
              failedClanTags.length > 0);
          if (hasFetchFailure) {
            const error = buildTrackedClanFetchFailureError({
              scope: input.scope,
              failedClanTags: [...leadRoleState.failedClanTags, ...missingClanTags],
            });
            dozzleLog.warn(
              `[autorole] event=tracked_clan_fetch_failed guild_id=${input.guildId} scope=${input.scope.kind} target_role=${input.scope.discordRoleId} failed_clan_tags=${failedClanTags} action=abort_before_apply removed=0`,
            );
            throw error;
          }

          const currentHolderCount = collectCurrentRoleHolders(
            roleMembersById,
            new Set([input.scope.discordRoleId]),
          ).size;
          const visitorRoleAdditionsSuppressed = visitorRoleConfigured && !roleCacheCoverageComplete;
          const memberSourceSummary = buildMemberSourceSummary({
            scope: input.scope,
            guildMemberCount: leadRoleState.guildMemberCount,
            cachedMemberCount: leadRoleState.cachedMemberCount,
            cacheCoverageComplete: roleCacheCoverageComplete,
            candidateUserCount: leadRoleState.candidateUserIds.size,
            targetedFetchRequestedCount: leadRoleState.targetedFetchRequestedCount,
            targetedFetchSucceededCount: leadRoleState.targetedFetchSucceededCount,
            targetedFetchFailedCount: leadRoleState.targetedFetchFailedCount,
            visitorRoleAdditionsSuppressed,
            playerCurrentPersistedRowCount: 0,
            trackedClanOverlayCount: leadRoleState.playerCurrentByTag.size,
          });
          dozzleLog.info(
            `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} target_role=${input.scope.discordRoleId} lead_clans=${leadRoleState.trackedClans.length} current_holders=${currentHolderCount} linked_users=${leadRoleState.linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} lead_member_tags=${leadRoleState.trackedMembershipScope.fwaMemberTags.size} clan_fetches=${leadRoleState.clanFetchCount} player_current_tags=${leadRoleState.playerCurrentByTag.size}`,
          );

          const result = await runRefreshPass({
            guildId: input.guildId,
            scope: input.scope,
            guild: input.guild,
            snapshot,
            trackedClans: leadRoleState.trackedClans,
            membersById: leadRoleState.membersById,
            linkedAccountsByUserId: leadRoleState.linkedAccountsByUserId,
            playerCurrentByTag: leadRoleState.playerCurrentByTag,
            clanMembershipIndex: leadRoleState.clanMembershipIndex,
            trackedMembershipScope: leadRoleState.trackedMembershipScope,
            runId: run.id,
            now: input.now,
            candidateUserIdsOverride: leadRoleState.candidateUserIds,
            suppressRemovalRoleIds,
            trackedFwaMemberTags: leadRoleState.trackedMembershipScope.fwaMemberTags,
            visitorRoleAvailable,
            visitorRoleAdditionsSuppressed,
          });
          return {
            ...result,
            memberSourceSummary,
          };
        }
      }

      if (input.scope.kind === "guild") {
        const cwlSeason = resolveCurrentCwlSeasonKey();
        const trackedMembershipScope = await loadTrackedClanMembershipScope({
          season: cwlSeason,
          cocService: input.cocService ?? null,
          guildId: input.guildId,
          telemetry: input.telemetry ?? null,
        });
        const trackedFwaRefresh = await loadTrackedFwaClanRefreshState({
          guildId: input.guildId,
          cocService: input.cocService ?? null,
          telemetry: input.telemetry ?? null,
        });
        if (input.cocService) {
          const missingClanTags = collectMissingTrackedClanTags(
            trackedFwaRefresh.configuredClanTags,
            trackedFwaRefresh.trackedClans,
          );
          const failedClanTags = formatTrackedClanFetchFailureTags([
            ...trackedFwaRefresh.failedClanTags,
            ...missingClanTags,
          ]);
          if (
            trackedFwaRefresh.requestedClanCount > trackedFwaRefresh.trackedClans.length ||
            failedClanTags.length > 0
          ) {
            const error = buildTrackedClanFetchFailureError({
              scope: input.scope,
              failedClanTags: [...trackedFwaRefresh.failedClanTags, ...missingClanTags],
            });
            dozzleLog.warn(
              `[autorole] event=tracked_clan_fetch_failed guild_id=${input.guildId} scope=${input.scope.kind} failed_clan_tags=${failedClanTags} action=abort_before_apply removed=0`,
            );
            throw error;
          }
        }

        const cachedMembersById = getGuildCachedMembersMap(input.guild);
        const cacheCoverageComplete = input.guild.memberCount <= cachedMembersById.size;
        const guildCandidateUserIds = cacheCoverageComplete
          ? new Set<string>(cachedMembersById.keys())
          : (
              await collectGuildRefreshCandidateUserIds({
                guildId: input.guildId,
                managedRoleIds,
                cachedMembersById,
                cacheCoverageComplete,
              })
            ).candidateUserIds;
        const guildMemberSource = cacheCoverageComplete
          ? {
              membersById: new Map(cachedMembersById),
              targetedFetchRequestedCount: 0,
              targetedFetchSucceededCount: 0,
              targetedFetchFailedCount: 0,
              failedUserIds: [] as string[],
              failureReasons: [] as string[],
            }
            : await loadGuildMembersByIdsAllowPartial({
                guild: input.guild,
                userIds: guildCandidateUserIds,
              });
        const membersById = guildMemberSource.membersById;
        const trackedMembershipScopeForRefresh = {
          fwaClanTags: trackedFwaRefresh.fwaClanTags,
          cwlClanTags: trackedMembershipScope.cwlClanTags,
          fwaMemberTags: new Set([
            ...trackedMembershipScope.fwaMemberTags,
            ...trackedFwaRefresh.fwaMemberTags,
          ]),
          cwlMemberTags: trackedMembershipScope.cwlMemberTags,
          cwlClanFetchCount: trackedMembershipScope.cwlClanFetchCount,
        };
        const candidateUserIds = new Set<string>(guildCandidateUserIds);
        if (snapshot.config.nicknameExcludeRoleIds.length > 0) {
          const nicknameExcludeRoleIds = new Set(snapshot.config.nicknameExcludeRoleIds);
          for (const member of membersById.values()) {
            if (memberHasAnyManagedRole(member, nicknameExcludeRoleIds)) {
              candidateUserIds.add(member.id);
            }
          }
        }
        const linkedAccountsByUserId = await loadLinkedAccountsForGuildMemberIds({
          guildMemberIds: [...candidateUserIds],
        });
        const persistedPlayerCurrentByTag = await loadPersistedPlayerCurrentByLinkedAccounts({
          linkedAccountsByUserId,
        });
        const playerCurrentByTag = mergeTrackedClanPlayerCurrentOverlay({
          baseByTag: persistedPlayerCurrentByTag,
          overlayByTag: trackedFwaRefresh.playerCurrentByTag,
        });
        const visitorRoleAdditionsSuppressed = visitorRoleConfigured && !cacheCoverageComplete;
        const memberSourceSummary = buildMemberSourceSummary({
          scope: input.scope,
          guildMemberCount: input.guild.memberCount ?? membersById.size,
          cachedMemberCount: cachedMembersById.size,
          cacheCoverageComplete,
          candidateUserCount: candidateUserIds.size,
          targetedFetchRequestedCount: guildMemberSource.targetedFetchRequestedCount,
          targetedFetchSucceededCount: guildMemberSource.targetedFetchSucceededCount,
          targetedFetchFailedCount: guildMemberSource.targetedFetchFailedCount,
          visitorRoleAdditionsSuppressed,
          playerCurrentPersistedRowCount: persistedPlayerCurrentByTag.size,
          trackedClanOverlayCount: trackedFwaRefresh.playerCurrentByTag.size,
        });
        dozzleLog.info(
          `[autorole] event=refresh_member_source_summary scope=${memberSourceSummary.scope.kind} guild_id=${input.guildId} guild_member_count=${memberSourceSummary.guildMemberCount} cached_member_count=${memberSourceSummary.cachedMemberCount} cache_coverage_complete=${memberSourceSummary.cacheCoverageComplete ? "true" : "false"} candidate_user_count=${memberSourceSummary.candidateUserCount} targeted_fetch_requested_count=${memberSourceSummary.targetedFetchRequestedCount} targeted_fetch_succeeded_count=${memberSourceSummary.targetedFetchSucceededCount} targeted_fetch_failed_count=${memberSourceSummary.targetedFetchFailedCount} member_source_mode=${memberSourceSummary.memberSourceMode} visitor_role_additions_suppressed=${memberSourceSummary.visitorRoleAdditionsSuppressed ? "true" : "false"} player_current_persisted_row_count=${memberSourceSummary.playerCurrentPersistedRowCount} tracked_clan_overlay_count=${memberSourceSummary.trackedClanOverlayCount}${memberSourceSummary.memberSourceMode === "partial_candidates" ? " partial_reason=incomplete_cache_or_candidate_fetch_failure" : ""}`,
        );

        dozzleLog.info(
          `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} guild_members=${membersById.size} candidate_members=${candidateUserIds.size} linked_users=${linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} fwa_clans=${trackedFwaRefresh.fwaClanTags.size} fwa_member_tags=${trackedFwaRefresh.fwaMemberTags.size} cwl_member_tags=${trackedMembershipScope.cwlMemberTags.size} cwl_clan_fetches=${trackedMembershipScope.cwlClanFetchCount} tracked_fwa_fetches=${trackedFwaRefresh.clanFetchCount} player_current_tags=${playerCurrentByTag.size}`,
        );

        const result = await runRefreshPass({
          guildId: input.guildId,
          scope: input.scope,
          guild: input.guild,
          snapshot,
          trackedClans: trackedFwaRefresh.trackedClans,
          membersById,
          linkedAccountsByUserId,
          playerCurrentByTag,
          clanMembershipIndex: trackedFwaRefresh.clanMembershipIndex,
          trackedMembershipScope: trackedMembershipScopeForRefresh,
          runId: run.id,
          now: input.now,
          candidateUserIdsOverride: candidateUserIds,
          suppressRemovalRoleIds,
          trackedFwaMemberTags: trackedMembershipScopeForRefresh.fwaMemberTags,
          visitorRoleAvailable,
          visitorRoleAdditionsSuppressed,
        });
        if (input.telemetry?.refreshId) {
          dozzleLog.info(
            `[autorole] event=autorole_refresh_summary source=${input.telemetry.schedulerSource ?? "autorole_scheduler"} autorole_refresh_id=${input.telemetry.refreshId} guild_id=${input.guildId} tracked_clan_count=${trackedFwaRefresh.requestedClanCount} live_clan_fetch_count=${trackedFwaRefresh.clanFetchCount} role_add_count=${result.addedCount} role_remove_count=${result.removedCount} duration_ms=${Date.now() - refreshStartedAtMs}`,
          );
        }
        return {
          ...result,
          memberSourceSummary,
        };
      }

      const cwlSeason = resolveCurrentCwlSeasonKey();
      const trackedMembershipScope = await loadTrackedClanMembershipScope({
        season: cwlSeason,
        cocService: input.cocService ?? null,
      });
      const clanMembershipIndex = await loadClanMembershipIndex({
        season: cwlSeason,
        rules: snapshot.rules,
      });

      if (input.scope.kind === "user") {
        const requestedUserId =
          normalizeDiscordUserId(input.scope.discordUserId) ?? String(input.scope.discordUserId).trim();
        const requestedMemberSource = await loadGuildMembersByIdsAllowPartial({
          guild: input.guild,
          userIds: [requestedUserId],
        });
        const membersById = requestedMemberSource.membersById;
        const linkedAccountsByUserId = await loadLinkedAccountsForDiscordUser({
          discordUserId: requestedUserId,
        });
        const nicknameTemplate = normalizeNicknameTemplate(snapshot.config.nicknameTemplate);
        const playerCurrentRequiredFields = collectPlayerCurrentRequirementFields({
          snapshot,
          nicknameEnabled: snapshot.config.applyNicknames && nicknameTemplate !== null && nicknameTemplate !== undefined,
          leadRolesEnabled: trackedClans.some((clan) => String(clan.leadRoleId ?? "").trim().length > 0),
        });
        const userLinkedPlayerRefreshFields: PlayerCurrentResolutionField[] =
          playerCurrentRequiredFields.length > 0 ? playerCurrentRequiredFields : ["currentClanTag"];
        const userLinkedPlayerRefresh = await loadPlayerCurrentByLinkedAccountsForUserRefresh({
          linkedAccountsByUserId,
          cocService: input.cocService ?? null,
          requireFields: userLinkedPlayerRefreshFields,
          guildId: input.guildId,
          discordUserId: requestedUserId,
          now: input.now,
        });
        const playerCurrentByTag = userLinkedPlayerRefresh.playerCurrentByTag;
        const userLinkedPlayerRefreshOutcome = userLinkedPlayerRefresh.refreshOutcome;
        const userLinkedPlayerRefreshShouldAbort =
          userLinkedPlayerRefreshOutcome !== null &&
          userLinkedPlayerRefreshOutcome.failedCount > 0 &&
          userLinkedPlayerRefreshOutcome.successfulCount === 0 &&
          userLinkedPlayerRefreshOutcome.requestedPlayerCount > 0;
        const userLinkedPlayerRefreshSuppressNicknameUpdate =
          userLinkedPlayerRefreshOutcome !== null &&
          userLinkedPlayerRefreshOutcome.failedCount > 0 &&
          userLinkedPlayerRefreshOutcome.successfulCount > 0;
        const userLinkedPlayerRefreshNicknameSuppressionReason = userLinkedPlayerRefreshSuppressNicknameUpdate
          ? "partial linked player refresh"
          : null;

        dozzleLog.info(
          userLinkedPlayerRefreshOutcome
          ? `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} user_id=${requestedUserId} guild_members=${membersById.size} candidate_members=1 linked_users=${linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} fwa_member_tags=${trackedMembershipScope.fwaMemberTags.size} cwl_member_tags=${trackedMembershipScope.cwlMemberTags.size} cwl_clan_fetches=${trackedMembershipScope.cwlClanFetchCount} player_current_tags=${playerCurrentByTag.size} player_current_fields=${userLinkedPlayerRefreshFields.join(",")} linked_player_refresh_requested=${userLinkedPlayerRefreshOutcome.requestedPlayerCount} linked_player_refresh_successful=${userLinkedPlayerRefreshOutcome.successfulCount} linked_player_refresh_failed=${userLinkedPlayerRefreshOutcome.failedCount} linked_player_refresh_failed_tags=${userLinkedPlayerRefreshOutcome.failedPlayerTags.length > 0 ? userLinkedPlayerRefreshOutcome.failedPlayerTags.join(",") : "none"} linked_player_refresh_queue_source=${userLinkedPlayerRefreshOutcome.queueSource ?? "none"} linked_player_refresh_action=${userLinkedPlayerRefreshOutcome.action} linked_player_refresh_nickname_suppressed=${userLinkedPlayerRefreshSuppressNicknameUpdate ? "true" : "false"} linked_player_refresh_nickname_reason=${userLinkedPlayerRefreshNicknameSuppressionReason ?? "none"}`
            : `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} user_id=${requestedUserId} guild_members=${membersById.size} candidate_members=1 linked_users=${linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} fwa_member_tags=${trackedMembershipScope.fwaMemberTags.size} cwl_member_tags=${trackedMembershipScope.cwlMemberTags.size} cwl_clan_fetches=${trackedMembershipScope.cwlClanFetchCount} player_current_tags=${playerCurrentByTag.size} player_current_fields=${userLinkedPlayerRefreshFields.join(",")}`,
        );

        if (userLinkedPlayerRefreshShouldAbort && userLinkedPlayerRefreshOutcome) {
          const memberResult = buildLinkedPlayerRefreshFailureResult({
            guildId: input.guildId,
            discordUserId: requestedUserId,
            scope: input.scope,
            refreshOutcome: userLinkedPlayerRefreshOutcome,
          });
          const counts = summarizeResultCounts([memberResult]);
          await persistAutoRoleMemberState({
            guildId: input.guildId,
            evaluation: {
              discordUserId: requestedUserId,
              skipReason: null,
              desiredManagedRoleIds: [],
              matchedRuleIds: [],
              primaryPlayerTag: null,
              primaryPlayerName: null,
              resultHash: memberResult.resultHash,
            },
            result: memberResult,
            now: input.now,
          });
          await prisma.autoRoleSyncRun.update({
            where: { id: run.id },
            data: {
              status: "COMPLETED",
              finishedAt: new Date(),
              evaluatedCount: counts.evaluatedCount,
              appliedCount: counts.addedCount,
              removedCount: counts.removedCount,
              skippedCount: counts.skippedCount,
              error: memberResult.failureReasons.join(" | "),
            },
          });
          return {
            guildId: input.guildId,
            scope: input.scope,
            runId: run.id,
            evaluatedCount: counts.evaluatedCount,
            addedCount: counts.addedCount,
            removedCount: counts.removedCount,
            skippedCount: counts.skippedCount,
            failedCount: counts.failedCount,
            memberResults: [memberResult],
            linkedPlayerRefresh: userLinkedPlayerRefreshOutcome,
          };
        }

        if (userLinkedPlayerRefreshOutcome?.failedCount) {
          suppressRemovalRoleIds = new Set([
            ...suppressRemovalRoleIds,
            ...collectPartialUserRefreshRemovalSuppression({
              snapshot,
              trackedClans,
            }),
          ]);
        }

        const refreshResult = await runRefreshPass({
          guildId: input.guildId,
          scope: input.scope,
          guild: input.guild,
          snapshot,
          trackedClans,
          membersById,
          linkedAccountsByUserId,
          playerCurrentByTag,
          clanMembershipIndex,
          trackedMembershipScope,
          runId: run.id,
          now: input.now,
          candidateUserIdsOverride: new Set([requestedUserId]),
          suppressRemovalRoleIds,
          suppressNicknameUpdate: userLinkedPlayerRefreshSuppressNicknameUpdate,
          nicknameSuppressionReason: userLinkedPlayerRefreshNicknameSuppressionReason,
          preferCurrentClanTagForClanRules: true,
          trackedFwaMemberTags: trackedMembershipScope.fwaMemberTags,
          visitorRoleAvailable,
          visitorRoleAdditionsSuppressed:
            requestedMemberSource.targetedFetchFailedCount > 0 ||
            (userLinkedPlayerRefreshOutcome?.failedCount ?? 0) > 0,
        });
        return userLinkedPlayerRefreshOutcome
          ? {
              ...refreshResult,
              linkedPlayerRefresh: userLinkedPlayerRefreshOutcome,
            }
          : refreshResult;
      }

      const cachedMembersById = getGuildCachedMembersMap(input.guild);
      const cacheCoverageComplete = input.guild.memberCount <= cachedMembersById.size;
      const guildCandidateUserIds = cacheCoverageComplete
        ? new Set<string>(cachedMembersById.keys())
        : (
            await collectGuildRefreshCandidateUserIds({
              guildId: input.guildId,
              managedRoleIds,
              cachedMembersById,
              cacheCoverageComplete,
            })
          ).candidateUserIds;
      const guildMemberSource = cacheCoverageComplete
        ? {
            membersById: new Map(cachedMembersById),
            targetedFetchRequestedCount: 0,
            targetedFetchSucceededCount: 0,
            targetedFetchFailedCount: 0,
            failedUserIds: [] as string[],
            failureReasons: [] as string[],
          }
        : await loadGuildMembersByIdsAllowPartial({
            guild: input.guild,
            userIds: guildCandidateUserIds,
          });
      const membersById = guildMemberSource.membersById;
      const roleScope = input.scope.kind === "role" ? input.scope : null;
      const isFamilyRoleScope = roleScope !== null && snapshot.config.familyRoleId === roleScope.discordRoleId;
      const isCwlClanRoleScope = roleScope !== null && snapshot.config.cwlClanRoleId === roleScope.discordRoleId;
      const candidateUserIds =
        roleScope && (isFamilyRoleScope || isCwlClanRoleScope)
          ? await collectMembershipScopedCandidateUsers({
              membersById,
              trackedMemberPlayerTags: isFamilyRoleScope
                ? [...trackedMembershipScope.fwaMemberTags, ...trackedMembershipScope.cwlMemberTags]
                : [...trackedMembershipScope.cwlMemberTags],
              targetRoleId: roleScope.discordRoleId,
            })
          : new Set<string>(membersById.keys());
      const linkedAccountsByUserId = await loadLinkedAccountsForGuildMemberIds({
        guildMemberIds: [...candidateUserIds],
      });
      const persistedPlayerCurrentByTag = await loadPersistedPlayerCurrentByLinkedAccounts({
        linkedAccountsByUserId,
      });
      const playerCurrentByTag = persistedPlayerCurrentByTag;
      const visitorRoleAdditionsSuppressed = visitorRoleConfigured && !cacheCoverageComplete;
      const memberSourceSummary = buildMemberSourceSummary({
        scope: input.scope,
        guildMemberCount: input.guild.memberCount ?? membersById.size,
        cachedMemberCount: cachedMembersById.size,
        cacheCoverageComplete,
        candidateUserCount: candidateUserIds.size,
        targetedFetchRequestedCount: guildMemberSource.targetedFetchRequestedCount,
        targetedFetchSucceededCount: guildMemberSource.targetedFetchSucceededCount,
        targetedFetchFailedCount: guildMemberSource.targetedFetchFailedCount,
        visitorRoleAdditionsSuppressed,
        playerCurrentPersistedRowCount: persistedPlayerCurrentByTag.size,
        trackedClanOverlayCount: 0,
      });

      dozzleLog.info(
        `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} guild_members=${membersById.size} candidate_members=${candidateUserIds.size} linked_users=${linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} fwa_member_tags=${trackedMembershipScope.fwaMemberTags.size} cwl_member_tags=${trackedMembershipScope.cwlMemberTags.size} cwl_clan_fetches=${trackedMembershipScope.cwlClanFetchCount} player_current_tags=${playerCurrentByTag.size}`,
      );

      const refreshResult = await runRefreshPass({
        guildId: input.guildId,
        scope: input.scope,
        guild: input.guild,
        snapshot,
        trackedClans,
        membersById,
        linkedAccountsByUserId,
        playerCurrentByTag,
        clanMembershipIndex,
        trackedMembershipScope,
        runId: run.id,
        now: input.now,
        suppressRemovalRoleIds,
        preferCurrentClanTagForClanRules: false,
        trackedFwaMemberTags: trackedMembershipScope.fwaMemberTags,
        visitorRoleAvailable,
        visitorRoleAdditionsSuppressed,
      });
      return {
        ...refreshResult,
        memberSourceSummary,
      };
    } catch (error) {
      await prisma.autoRoleSyncRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: formatError(error),
        },
      });
      throw error;
    }
  }
}

export const autoRoleRefreshService = new AutoRoleRefreshService();
