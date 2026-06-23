import { Guild } from "discord.js";
import { AutoRoleRuleType } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { dozzleLog } from "../helper/dozzleLogger";
import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
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
import { normalizeNicknameTemplate } from "./AutoRoleService";
import {
  autoRoleService,
  type AutoRoleGuildStateSnapshot,
  type AutoRoleRuleRecord,
} from "./AutoRoleService";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePersistedPlayerName,
  normalizePlayerTag,
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
    message.includes("rate limited")
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
}): Promise<{
  membersById: Map<string, AutoRoleGuildMemberLike>;
}> {
  const membersById = new Map<string, AutoRoleGuildMemberLike>();
  const cachedMembers = getGuildCachedMembersMap(input.guild);
  const userIds = normalizeMemberIds(input.userIds);

  for (const userId of userIds) {
    const cached = cachedMembers.get(userId) ?? null;
    if (cached) {
      membersById.set(userId, cached);
      continue;
    }

    try {
      const fetched = await input.guild.members.fetch(userId);
      if (fetched) {
        membersById.set(fetched.id, fetched as unknown as AutoRoleGuildMemberLike);
      }
    } catch (error) {
      if (isDiscordMemberFetchRateLimitError(error)) {
        throw new Error(formatDiscordMemberFetchRateLimitMessage(error));
      }
      // Missing or inaccessible members are intentionally ignored so tracked-clan
      // role refreshes stay targeted and fail-closed for destructive removals.
    }
  }

  return { membersById };
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

async function fetchGuildMembersMap(guild: Guild, scope: AutoRoleRefreshScope): Promise<Map<string, AutoRoleGuildMemberLike>> {
  if (scope.kind === "user") {
    const fetched = await guild.members.fetch(scope.discordUserId);
    return new Map([[fetched.id, fetched as unknown as AutoRoleGuildMemberLike]]);
  }

  const fetched = await guild.members.fetch();
  return memberCollectionToMap(fetched as unknown as AutoRoleMemberCollectionLike);
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
}): Promise<Map<string, PlayerCurrentLike>> {
  const playerTags = collectLinkedPlayerTags(input.linkedAccountsByUserId);
  if (playerTags.length === 0 || input.requireFields.length === 0) {
    dozzleLog.debug(
      `[autorole] event=user_live_reconcile guild_id=${input.guildId} user_id=${input.discordUserId} player_tags=none refreshed=0 skipped=0 reason=no_tags_or_fields`,
    );
    return new Map();
  }

  const cocService = input.cocService ?? null;
  if (cocService && typeof cocService.getPlayerRaw === "function") {
    const refreshResult = await playerCurrentService.refreshCurrentPlayersFromLiveTags({
      playerTags,
      cocService,
      source: "live_refresh",
      now: input.now ?? new Date(),
    });
    const playerCurrentByTag = await playerCurrentService.listPlayerCurrentByTags(playerTags);
    dozzleLog.debug(
      `[autorole] event=user_live_reconcile guild_id=${input.guildId} user_id=${input.discordUserId} player_tags=${playerTags.join(",")} refreshed=${refreshResult.successCount} skipped=${refreshResult.failedPlayerTags.length} failed_tags=${refreshResult.failedPlayerTags.length > 0 ? refreshResult.failedPlayerTags.join(",") : "none"}`,
    );
    return playerCurrentByTag;
  }

  dozzleLog.debug(
    `[autorole] event=user_live_reconcile guild_id=${input.guildId} user_id=${input.discordUserId} player_tags=${playerTags.join(",")} refreshed=0 skipped=${playerTags.length} reason=no_coc_service`,
  );
  return loadPlayerCurrentByLinkedAccounts({
    linkedAccountsByUserId: input.linkedAccountsByUserId,
    cocService: input.cocService ?? null,
    requireFields: input.requireFields,
  });
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
  trackedClans: AutoRoleNicknameTrackedClanLike[];
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
  candidateUserIds: Set<string>;
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
  clanFetchCount: number;
  failedClanTags: string[];
};

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
    },
  });

  const fwaClanTags = new Set<string>();
  const fwaMemberTags = new Set<string>();
  const clanMembershipIndex = new Map<string, AutoRoleClanMembershipIndexRow>();
  const trackedClans: AutoRoleNicknameTrackedClanLike[] = [];
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
      continue;
    }

    const clanName = normalizeText(clan?.name ?? trackedClanName);
    trackedClans.push({
      tag: clanTag,
      name: clanName,
      shortName,
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
        league?: { name?: unknown } | null;
      };
      const playerTag = normalizePlayerTag(String(clanMember.tag ?? ""));
      if (!playerTag) {
        continue;
      }
      playerTags.add(playerTag);
      fwaMemberTags.add(playerTag);

      if (!playerCurrentByTag.has(playerTag)) {
        const playerName = normalizePersistedPlayerName(String(clanMember.name ?? ""));
        const townHall = normalizeTownHallLevel(
          clanMember.townHallLevel ?? clanMember.townhallLevel ?? clanMember.townHall ?? null,
        );
        const role = normalizeClanMemberRole(clanMember.role ?? null);
        const leagueName = normalizeText(clanMember.league?.name ?? null);
        playerCurrentByTag.set(
          playerTag,
          createTrackedClanPlayerCurrent({
            playerTag,
            playerName,
            townHall,
            currentClanTag: clanTag,
            currentClanName: clanName,
            role,
            leagueName,
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

  const currentHolderIds = collectCurrentRoleHolders(input.membersById, new Set([roleId]));
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
        league?: { name?: unknown } | null;
      };
      const playerTag = normalizePlayerTag(String(clanMember.tag ?? ""));
      if (!playerTag) {
        continue;
      }

      playerTags.add(playerTag);
      fwaMemberTags.add(playerTag);

      const playerName = normalizePersistedPlayerName(String(clanMember.name ?? ""));
      const townHall = normalizeTownHallLevel(
        clanMember.townHallLevel ?? clanMember.townhallLevel ?? clanMember.townHall ?? null,
      );
      const role = normalizeClanMemberRole(clanMember.role ?? null);
      const leagueName = normalizeText(clanMember.league?.name ?? null);
      if (!playerCurrentByTag.has(playerTag)) {
        playerCurrentByTag.set(
          playerTag,
          createTrackedClanPlayerCurrent({
            playerTag,
            playerName,
            townHall,
            currentClanTag: clanTag,
            currentClanName: clanName,
            role,
            leagueName,
          }),
        );
      }

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

  const linkedAccountsByUserId = await loadLinkedAccountsForGuildMemberIds({
    guildMemberIds: [...candidateUserIds],
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
    candidateUserIds,
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
        const playerName = normalizePersistedPlayerName(String(clanMember.name ?? ""));
        const townHall = normalizeTownHallLevel(
          clanMember.townHallLevel ?? clanMember.townhallLevel ?? clanMember.townHall ?? null,
        );
        const role = normalizeClanMemberRole(clanMember.role ?? null);
        const leagueName = normalizeText(clanMember.league?.name ?? null);
        playerCurrentByTag.set(
          playerTag,
          createTrackedClanPlayerCurrent({
            playerTag,
            playerName,
            townHall,
            currentClanTag: clanTag,
            currentClanName: clanName,
            role,
            leagueName,
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

  const membersById = new Map<string, AutoRoleGuildMemberLike>();
  for (const userId of candidateUserIds) {
    const cached = cachedMembersById.get(userId) ?? null;
    if (cached) {
      membersById.set(userId, cached);
    }
  }

  const fetchableUserIds = [...linkedUserIds].filter((userId) => !membersById.has(userId));
  if (fetchableUserIds.length > 0) {
    const fetchedMembers = await loadGuildMembersByIds({
      guild: input.guild,
      userIds: fetchableUserIds,
    });
    for (const [userId, member] of fetchedMembers.membersById.entries()) {
      membersById.set(userId, member);
      candidateUserIds.add(userId);
    }
  }

  const linkedAccountsByUserId = await loadLinkedAccountsForGuildMemberIds({
    guildMemberIds: [...candidateUserIds],
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
    candidateUserIds,
    membersById,
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
  preferCurrentClanTagForClanRules?: boolean;
  visitorRoleAvailable?: boolean;
}): Promise<AutoRoleRefreshResult> {
  const now = input.now;
  const managedRoleIds = buildManagedRoleIds(input.snapshot, input.trackedClans);
  const clanRoleIds = collectClanRoleIds(input.snapshot, input.trackedClans);
  const suppressRemovalRoleIds = buildLeadRoleRemovalSuppression({
    scope: input.scope,
    configuredLeadRoleIds: collectConfiguredLeadRoleIds(input.trackedClans),
  });
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
        trackedFwaMemberTags: input.trackedFwaMemberTags,
        visitorRoleAvailable: input.visitorRoleAvailable,
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
      const suppressRemovalRoleIds = buildLeadRoleRemovalSuppression({
        scope: input.scope,
        configuredLeadRoleIds: collectConfiguredLeadRoleIds(trackedClans),
      });
      if (input.scope.kind === "role" && !managedRoleIds.has(input.scope.discordRoleId)) {
        throw new Error("That Discord role is not managed by autorole.");
      }

        if (input.scope.kind === "role") {
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
          dozzleLog.info(
            `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} target_role=${input.scope.discordRoleId} clan_role_clans=${clanRoleState.trackedClans.length} current_holders=${currentHolderCount} linked_users=${clanRoleState.linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} clan_member_tags=${clanRoleState.trackedMembershipScope.fwaMemberTags.size} clan_fetches=${clanRoleState.clanFetchCount} player_current_tags=${clanRoleState.playerCurrentByTag.size} member_fetch_mode=targeted`,
          );

          return runRefreshPass({
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
          });
        }

        dozzleLog.info(
          `[autorole] event=refresh_member_source guild_id=${input.guildId} scope=${input.scope.kind} target_role=${input.scope.discordRoleId} member_fetch_mode=full_guild_fetch reason=non_tracked_clan_role`,
        );
        const roleMembersById = await fetchGuildMembersMap(input.guild, input.scope);
          const leadRoleState = await loadTrackedLeadRoleRefreshState({
            guildId: input.guildId,
            roleId: input.scope.discordRoleId,
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
          dozzleLog.info(
            `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} target_role=${input.scope.discordRoleId} lead_clans=${leadRoleState.trackedClans.length} current_holders=${currentHolderCount} linked_users=${leadRoleState.linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} lead_member_tags=${leadRoleState.trackedMembershipScope.fwaMemberTags.size} clan_fetches=${leadRoleState.clanFetchCount} player_current_tags=${leadRoleState.playerCurrentByTag.size}`,
          );

          return runRefreshPass({
            guildId: input.guildId,
            scope: input.scope,
            guild: input.guild,
            snapshot,
            trackedClans: leadRoleState.trackedClans,
            membersById: roleMembersById,
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
          });
        }
      }

      if (input.scope.kind === "guild") {
      const membersById = await fetchGuildMembersMap(input.guild, input.scope);
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
        const visitorRoleAwareCandidateUserIds =
          visitorRoleConfigured && visitorRoleAvailable
            ? new Set<string>(membersById.keys())
            : await collectGuildCandidateUsersForTrackedMembership({
                membersById,
                managedRoleIds,
                trackedMemberPlayerTags: [
                  ...trackedMembershipScope.fwaMemberTags,
                  ...trackedFwaRefresh.fwaMemberTags,
                  ...trackedMembershipScope.cwlMemberTags,
                ],
              });
        const candidateUserIds = new Set<string>(visitorRoleAwareCandidateUserIds);
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

        dozzleLog.info(
          `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} guild_members=${membersById.size} candidate_members=${candidateUserIds.size} linked_users=${linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} fwa_clans=${trackedFwaRefresh.fwaClanTags.size} fwa_member_tags=${trackedFwaRefresh.fwaMemberTags.size} cwl_member_tags=${trackedMembershipScope.cwlMemberTags.size} cwl_clan_fetches=${trackedMembershipScope.cwlClanFetchCount} tracked_fwa_fetches=${trackedFwaRefresh.clanFetchCount} player_current_tags=${trackedFwaRefresh.playerCurrentByTag.size}`,
        );

        const result = await runRefreshPass({
          guildId: input.guildId,
          scope: input.scope,
          guild: input.guild,
          snapshot,
          trackedClans,
          membersById,
          linkedAccountsByUserId,
          playerCurrentByTag: trackedFwaRefresh.playerCurrentByTag,
          clanMembershipIndex: trackedFwaRefresh.clanMembershipIndex,
          trackedMembershipScope: trackedMembershipScopeForRefresh,
          runId: run.id,
          now: input.now,
          candidateUserIdsOverride: candidateUserIds,
          suppressRemovalRoleIds,
          trackedFwaMemberTags: trackedMembershipScopeForRefresh.fwaMemberTags,
          visitorRoleAvailable,
        });
        if (input.telemetry?.refreshId) {
          dozzleLog.info(
            `[autorole] event=autorole_refresh_summary source=${input.telemetry.schedulerSource ?? "autorole_scheduler"} autorole_refresh_id=${input.telemetry.refreshId} guild_id=${input.guildId} tracked_clan_count=${trackedFwaRefresh.requestedClanCount} live_clan_fetch_count=${trackedFwaRefresh.clanFetchCount} role_add_count=${result.addedCount} role_remove_count=${result.removedCount} duration_ms=${Date.now() - refreshStartedAtMs}`,
          );
        }
        return result;
      }

      const membersById = await fetchGuildMembersMap(input.guild, input.scope);
      const cwlSeason = resolveCurrentCwlSeasonKey();
      const trackedMembershipScope = await loadTrackedClanMembershipScope({
        season: cwlSeason,
        cocService: input.cocService ?? null,
      });
      const clanMembershipIndex = await loadClanMembershipIndex({
        season: cwlSeason,
        rules: snapshot.rules,
      });
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

      const linkedAccountsByUserId =
        roleScope === null || (!isFamilyRoleScope && !isCwlClanRoleScope)
          ? await loadLinkedAccountsForGuildMemberIds({
              guildMemberIds: [...membersById.keys()],
            })
          : await loadLinkedAccountsForGuildMemberIds({
              guildMemberIds: [...candidateUserIds],
            });

      const nicknameTemplate = normalizeNicknameTemplate(snapshot.config.nicknameTemplate);
      const playerCurrentRequiredFields = collectPlayerCurrentRequirementFields({
        snapshot,
        nicknameEnabled: snapshot.config.applyNicknames && nicknameTemplate !== null && nicknameTemplate !== undefined,
        leadRolesEnabled: trackedClans.some((clan) => String(clan.leadRoleId ?? "").trim().length > 0),
      });
      const playerCurrentByTag =
        input.scope.kind === "user"
          ? await loadPlayerCurrentByLinkedAccountsForUserRefresh({
              linkedAccountsByUserId,
              cocService: input.cocService ?? null,
              requireFields: playerCurrentRequiredFields,
              guildId: input.guildId,
              discordUserId: input.scope.discordUserId,
              now: input.now,
            })
          : await loadPlayerCurrentByLinkedAccounts({
              linkedAccountsByUserId,
              cocService: input.cocService ?? null,
              requireFields: playerCurrentRequiredFields,
            });

      dozzleLog.info(
        `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} guild_members=${membersById.size} candidate_members=${candidateUserIds.size} linked_users=${linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} fwa_member_tags=${trackedMembershipScope.fwaMemberTags.size} cwl_member_tags=${trackedMembershipScope.cwlMemberTags.size} cwl_clan_fetches=${trackedMembershipScope.cwlClanFetchCount} player_current_tags=${playerCurrentByTag.size} player_current_fields=${playerCurrentRequiredFields.length > 0 ? playerCurrentRequiredFields.join(",") : "none"}`,
      );

      return runRefreshPass({
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
        preferCurrentClanTagForClanRules: input.scope.kind === "user",
        trackedFwaMemberTags: trackedMembershipScope.fwaMemberTags,
        visitorRoleAvailable,
      });
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
