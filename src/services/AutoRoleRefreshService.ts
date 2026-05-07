import { Guild } from "discord.js";
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
  normalizePlayerTag,
  type PlayerLinkWithTrust,
} from "./PlayerLinkService";
import { runWithCoCQueueContext } from "./CoCQueueContext";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";

export type AutoRoleRefreshScope =
  | { kind: "guild" }
  | { kind: "user"; discordUserId: string }
  | { kind: "role"; discordRoleId: string };

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
  user: { id: string; username?: string | null; globalName?: string | null };
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

function collectPlayerCurrentRequirementFields(input: {
  snapshot: AutoRoleGuildStateSnapshot;
  nicknameEnabled: boolean;
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

async function loadTrackedClansForNickname(): Promise<AutoRoleNicknameTrackedClanLike[]> {
  const rows = await prisma.trackedClan.findMany({
    select: {
      tag: true,
      name: true,
      shortName: true,
    },
  });

  return rows
    .map((row) => ({
      tag: normalizeClanTag(row.tag),
      name: row.name ?? null,
      shortName: row.shortName ?? null,
    }))
    .filter((row) => row.tag.length > 0);
}

async function loadTrackedClanMembershipScope(input: {
  season: string;
  cocService?: CoCService | null;
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
  const cwlRoundRows = cwlClanTags.size > 0
    ? await prisma.cwlRoundMemberCurrent.findMany({
        where: { season: input.season, clanTag: { in: [...cwlClanTags] } },
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
        const clan = await cocService.getClan(clanTag).catch(() => null);
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
    const cwlMembershipRows = await prisma.cwlPlayerClanSeason.findMany({
      where: { season: input.season, cwlClanTag: { in: cwlClanTags } },
      select: { cwlClanTag: true, playerTag: true },
    });
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
    const [fwaMembershipRows, cwlMembershipRows] = await Promise.all([
      prisma.fwaClanMemberCurrent.findMany({
        where: { clanTag: { in: ambiguousTags } },
        select: { clanTag: true, playerTag: true },
      }),
      prisma.cwlPlayerClanSeason.findMany({
        where: { season: input.season, cwlClanTag: { in: ambiguousTags } },
        select: { cwlClanTag: true, playerTag: true },
      }),
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

function buildManagedRoleIds(snapshot: AutoRoleGuildStateSnapshot): Set<string> {
  return autoRoleEvaluationService.getManagedRoleIds({
    config: snapshot.config,
    rules: snapshot.rules,
  });
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
  membersById: Map<string, AutoRoleGuildMemberLike>;
  linkedAccountsByUserId: Map<string, PlayerLinkWithTrust[]>;
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  trackedClans: AutoRoleNicknameTrackedClanLike[];
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
}): Promise<AutoRoleRefreshResult> {
  const now = input.now;
  const managedRoleIds = buildManagedRoleIds(input.snapshot);
  const candidateUserIds = collectCandidateUsersForScope({
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
  }): Promise<AutoRoleRefreshResult> {
    return this.refresh({
      guild: input.guild,
      guildId: input.guildId,
      scope: { kind: "guild" },
      cocService: input.cocService ?? null,
      now: input.now ?? new Date(),
    });
  }

  async refreshUser(input: {
    guild: Guild;
    guildId: string;
    discordUserId: string;
    cocService?: CoCService | null;
    now?: Date;
  }): Promise<AutoRoleRefreshResult> {
    return this.refresh({
      guild: input.guild,
      guildId: input.guildId,
      scope: { kind: "user", discordUserId: input.discordUserId },
      cocService: input.cocService ?? null,
      now: input.now ?? new Date(),
    });
  }

  async refreshRole(input: {
    guild: Guild;
    guildId: string;
    discordRoleId: string;
    cocService?: CoCService | null;
    now?: Date;
  }): Promise<AutoRoleRefreshResult> {
    return this.refresh({
      guild: input.guild,
      guildId: input.guildId,
      scope: { kind: "role", discordRoleId: input.discordRoleId },
      cocService: input.cocService ?? null,
      now: input.now ?? new Date(),
    });
  }

  private async refresh(input: {
    guild: Guild;
    guildId: string;
    scope: AutoRoleRefreshScope;
    cocService?: CoCService | null;
    now: Date;
  }): Promise<AutoRoleRefreshResult> {
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

      const managedRoleIds = buildManagedRoleIds(snapshot);
      if (input.scope.kind === "role" && !managedRoleIds.has(input.scope.discordRoleId)) {
        throw new Error("That Discord role is not managed by autorole.");
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
        input.scope.kind === "guild" || roleScope === null || (!isFamilyRoleScope && !isCwlClanRoleScope)
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
      });
      const playerCurrentByTag = await loadPlayerCurrentByLinkedAccounts({
        linkedAccountsByUserId,
        cocService: input.cocService ?? null,
        requireFields: playerCurrentRequiredFields,
      });
      const trackedClans = snapshot.config.applyNicknames && nicknameTemplate !== null && nicknameTemplate !== undefined
        ? await loadTrackedClansForNickname()
        : [];

      dozzleLog.info(
        `[autorole] event=refresh_start guild_id=${input.guildId} scope=${input.scope.kind} guild_members=${membersById.size} candidate_members=${candidateUserIds.size} linked_users=${linkedAccountsByUserId.size} managed_roles=${managedRoleIds.size} fwa_member_tags=${trackedMembershipScope.fwaMemberTags.size} cwl_member_tags=${trackedMembershipScope.cwlMemberTags.size} cwl_clan_fetches=${trackedMembershipScope.cwlClanFetchCount} player_current_tags=${playerCurrentByTag.size} player_current_fields=${playerCurrentRequiredFields.length > 0 ? playerCurrentRequiredFields.join(",") : "none"}`,
      );

      return runRefreshPass({
        guildId: input.guildId,
        scope: input.scope,
        guild: input.guild,
        snapshot,
        membersById,
        linkedAccountsByUserId,
        playerCurrentByTag,
        trackedClans,
        clanMembershipIndex,
        trackedMembershipScope,
        runId: run.id,
        now: input.now,
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
