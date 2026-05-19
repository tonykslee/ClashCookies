import { createHash } from "node:crypto";
import { AutoRoleRuleType, type AutoRoleGuildConfig, type AutoRoleRule } from "@prisma/client";
import {
  getPlayerLinkTrustTier,
  isPlayerLinkTrustedForAutorole,
  isPlayerLinkVerifiedForAutorole,
  normalizeClanTag,
  normalizePlayerTag,
  type PlayerLinkWithTrust,
} from "./PlayerLinkService";
import type { PlayerCurrentLike } from "./PlayerCurrentService";

export type AutoRoleClanMembershipSource = "FWA" | "CWL" | "AMBIGUOUS" | "UNKNOWN";

export type AutoRoleClanMembershipIndexRow = {
  source: AutoRoleClanMembershipSource;
  playerTags: Set<string>;
};

export type AutoRoleClanMembershipIndex = Map<string, AutoRoleClanMembershipIndexRow>;

export type AutoRoleGuildConfigSnapshot = Pick<
  AutoRoleGuildConfig,
  | "enabled"
  | "killSwitchEnabled"
  | "removeStaleManagedRoles"
  | "applyNicknames"
  | "nicknameTemplate"
  | "trustedLinksAllowed"
  | "verifiedOnlyMode"
  | "verifiedRoleId"
  | "familyRoleId"
  | "cwlClanRoleId"
  | "clanRoleRemovalDelayMinutes"
>;

export type AutoRoleTrackedClanScope = {
  fwaClanTags: Set<string>;
  cwlClanTags: Set<string>;
  fwaMemberTags: Set<string>;
  cwlMemberTags: Set<string>;
};

export type AutoRoleTrackedClanLeadRole = {
  tag: string;
  leadRoleId: string | null;
};

export type AutoRoleEvaluationMemberLike = {
  id: string;
  displayName?: string | null;
  nickname?: string | null;
  user?: {
    username?: string | null;
    globalName?: string | null;
  } | null;
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

export type AutoRoleMemberEvaluation = {
  discordUserId: string;
  skipReason: string | null;
  desiredManagedRoleIds: string[];
  matchedRuleIds: string[];
  primaryPlayerTag: string | null;
  primaryPlayerName: string | null;
  resultHash: string;
};

export type AutoRoleEvaluationInput = {
  config: AutoRoleGuildConfigSnapshot;
  rules: AutoRoleRule[];
  managedRoleIds: Set<string>;
  member: AutoRoleEvaluationMemberLike;
  linkedAccounts: PlayerLinkWithTrust[];
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  clanMembershipByTag: AutoRoleClanMembershipIndex;
  trackedClanScope: AutoRoleTrackedClanScope;
  trackedClans?: AutoRoleTrackedClanLeadRole[];
  preferCurrentClanTagForClanRules?: boolean;
};

type RankedLinkedAccount = PlayerLinkWithTrust & {
  playerCurrent: PlayerCurrentLike | null;
};

const TRUST_TIER_ORDER: Record<string, number> = {
  verified: 0,
  trusted: 1,
  legacy: 2,
  untrusted: 3,
  revoked: 4,
};

function normalizeRoleIds(roleIds: Iterable<string>): string[] {
  return [...new Set([...roleIds].map((roleId) => String(roleId ?? "").trim()).filter(Boolean))].sort();
}

function compareLinkedAccounts(left: RankedLinkedAccount, right: RankedLinkedAccount): number {
  const leftTier = TRUST_TIER_ORDER[getPlayerLinkTrustTier(left)] ?? 99;
  const rightTier = TRUST_TIER_ORDER[getPlayerLinkTrustTier(right)] ?? 99;
  if (leftTier !== rightTier) return leftTier - rightTier;

  const leftLinkedAt = left.createdAt?.getTime?.() ?? 0;
  const rightLinkedAt = right.createdAt?.getTime?.() ?? 0;
  if (leftLinkedAt !== rightLinkedAt) return leftLinkedAt - rightLinkedAt;

  return left.playerTag.localeCompare(right.playerTag);
}

function isEligibleAutoroleLink(
  link: Pick<PlayerLinkWithTrust, "linkSource" | "verificationStatus" | "verificationMethod">,
  config: AutoRoleGuildConfigSnapshot,
): boolean {
  if (link.verificationStatus === "REVOKED") {
    return false;
  }

  if (config.verifiedOnlyMode || config.trustedLinksAllowed === false) {
    return isPlayerLinkVerifiedForAutorole(link);
  }
  return true;
}

function resolveMemberSourceCurrentClanTag(
  linkedAccount: RankedLinkedAccount,
): string | null {
  const currentClanTag = normalizeClanTag(linkedAccount.playerCurrent?.currentClanTag ?? "");
  return currentClanTag || null;
}

function normalizeLeagueNameForComparison(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isLinkedAccountCurrentlyInTrackedClan(
  linkedAccount: RankedLinkedAccount,
  trackedClanTags: Set<string>,
): boolean {
  if (trackedClanTags.size === 0) return false;
  const currentClanTag = normalizeClanTag(linkedAccount.playerCurrent?.currentClanTag ?? "");
  return currentClanTag.length > 0 && trackedClanTags.has(currentClanTag);
}

function isLinkedAccountInTrackedMembershipTags(
  linkedAccount: RankedLinkedAccount,
  trackedMemberTags: Set<string>,
): boolean {
  if (trackedMemberTags.size === 0) return false;
  const playerTag = normalizePlayerTag(linkedAccount.playerTag);
  return playerTag.length > 0 && trackedMemberTags.has(playerTag);
}

function isLinkedAccountLeaderInTrackedClan(
  linkedAccount: RankedLinkedAccount,
  targetClanTag: string,
): boolean {
  const normalizedTarget = normalizeClanTag(targetClanTag);
  if (!normalizedTarget) return false;

  const currentClanTag = resolveMemberSourceCurrentClanTag(linkedAccount);
  if (currentClanTag !== normalizedTarget) {
    return false;
  }

  const currentRole = String(linkedAccount.playerCurrent?.role ?? "").trim();
  return currentRole === "leader" || currentRole === "coLeader";
}

function isLeaderRankTarget(targetValue: string): boolean {
  return targetValue === "leader" || targetValue === "coLeader";
}

function isLinkedAccountInClanTarget(
  linkedAccount: RankedLinkedAccount,
  targetClanTag: string,
  clanMembership: AutoRoleClanMembershipIndexRow | null,
  preferCurrentClanTagForClanRules: boolean,
): boolean {
  const normalizedTarget = normalizeClanTag(targetClanTag);
  if (!normalizedTarget) return false;

  const currentClanTag = resolveMemberSourceCurrentClanTag(linkedAccount);
  if (preferCurrentClanTagForClanRules && currentClanTag) {
    return currentClanTag === normalizedTarget;
  }

  if (clanMembership?.playerTags.has(linkedAccount.playerTag)) {
    return true;
  }

  if (!clanMembership || clanMembership.source === "UNKNOWN" || clanMembership.source === "FWA") {
    return currentClanTag === normalizedTarget;
  }

  return false;
}

function buildResultHash(input: {
  skipReason: string | null;
  desiredManagedRoleIds: string[];
  matchedRuleIds: string[];
  primaryPlayerTag: string | null;
  primaryPlayerName: string | null;
}): string {
  const payload = JSON.stringify({
    skipReason: input.skipReason,
    desiredManagedRoleIds: input.desiredManagedRoleIds,
    matchedRuleIds: input.matchedRuleIds,
    primaryPlayerTag: input.primaryPlayerTag,
    primaryPlayerName: input.primaryPlayerName,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** Purpose: evaluate autorole desired state for one Discord member from persisted link/current-clan facts. */
export class AutoRoleEvaluationService {
  /** Purpose: get the active managed-role set for one guild snapshot. */
  getManagedRoleIds(input: {
    config: AutoRoleGuildConfigSnapshot;
    rules: AutoRoleRule[];
    trackedClans?: AutoRoleTrackedClanLeadRole[];
  }): Set<string> {
    const roleIds = new Set<string>();
    if (input.config.verifiedRoleId) roleIds.add(input.config.verifiedRoleId);
    if (input.config.familyRoleId) roleIds.add(input.config.familyRoleId);
    if (input.config.cwlClanRoleId) roleIds.add(input.config.cwlClanRoleId);
    for (const clan of input.trackedClans ?? []) {
      const leadRoleId = String(clan.leadRoleId ?? "").trim();
      if (leadRoleId) {
        roleIds.add(leadRoleId);
      }
    }
    for (const rule of input.rules) {
      if (!rule.enabled) continue;
      roleIds.add(rule.discordRoleId);
    }
    return roleIds;
  }

  /** Purpose: evaluate one member's autorole desired managed-role set and stable result hash. */
  evaluateMember(input: AutoRoleEvaluationInput): AutoRoleMemberEvaluation {
    const trackedClans = input.trackedClans ?? [];
    const linkedAccounts = [...input.linkedAccounts]
      .map((account) => ({
        ...account,
        playerCurrent: input.playerCurrentByTag.get(account.playerTag) ?? null,
      }))
      .filter((account) => account.playerTag.length > 0)
      .filter((account) => isEligibleAutoroleLink(account, input.config))
      .sort(compareLinkedAccounts);

    const skipReason = this.resolveSkipReason(input.config);
    if (skipReason) {
      return {
        discordUserId: input.member.id,
        skipReason,
        desiredManagedRoleIds: [],
        matchedRuleIds: [],
        primaryPlayerTag: linkedAccounts[0]?.playerTag ?? null,
        primaryPlayerName: linkedAccounts[0]?.playerCurrent?.playerName ?? linkedAccounts[0]?.playerName ?? null,
        resultHash: buildResultHash({
          skipReason,
          desiredManagedRoleIds: [],
          matchedRuleIds: [],
          primaryPlayerTag: linkedAccounts[0]?.playerTag ?? null,
          primaryPlayerName: linkedAccounts[0]?.playerCurrent?.playerName ?? linkedAccounts[0]?.playerName ?? null,
        }),
      };
    }

    const desiredManagedRoleIds = new Set<string>();
    const matchedRuleIds = new Set<string>();
    for (const rule of input.rules) {
      if (!rule.enabled) continue;
      if (!input.managedRoleIds.has(rule.discordRoleId)) continue;

      if (
        this.isRuleMatched(
          rule,
          linkedAccounts,
          input.clanMembershipByTag,
          input.trackedClanScope,
          input.preferCurrentClanTagForClanRules ?? false,
        )
      ) {
        desiredManagedRoleIds.add(rule.discordRoleId);
        matchedRuleIds.add(rule.id);
      }
    }

    if (
      input.config.familyRoleId &&
      input.managedRoleIds.has(input.config.familyRoleId) &&
      linkedAccounts.some((account) =>
        isLinkedAccountInTrackedMembershipTags(account, input.trackedClanScope.fwaMemberTags) ||
        isLinkedAccountInTrackedMembershipTags(account, input.trackedClanScope.cwlMemberTags),
      )
    ) {
      desiredManagedRoleIds.add(input.config.familyRoleId);
    }

    if (
      input.config.cwlClanRoleId &&
      input.managedRoleIds.has(input.config.cwlClanRoleId) &&
      linkedAccounts.some((account) =>
        isLinkedAccountInTrackedMembershipTags(account, input.trackedClanScope.cwlMemberTags),
      )
    ) {
      desiredManagedRoleIds.add(input.config.cwlClanRoleId);
    }

    for (const trackedClan of trackedClans) {
      const leadRoleId = String(trackedClan.leadRoleId ?? "").trim();
      const clanTag = normalizeClanTag(trackedClan.tag);
      if (!leadRoleId || !clanTag || !input.managedRoleIds.has(leadRoleId)) {
        continue;
      }

      if (linkedAccounts.some((account) => isLinkedAccountLeaderInTrackedClan(account, clanTag))) {
        desiredManagedRoleIds.add(leadRoleId);
      }
    }

    const primary = linkedAccounts[0] ?? null;
    const primaryPlayerTag = primary?.playerTag ?? null;
    const primaryPlayerName = primary?.playerCurrent?.playerName ?? primary?.playerName ?? null;
    const normalizedDesiredRoleIds = normalizeRoleIds(desiredManagedRoleIds);
    const normalizedMatchedRuleIds = normalizeRoleIds(matchedRuleIds);

    return {
      discordUserId: input.member.id,
      skipReason: null,
      desiredManagedRoleIds: normalizedDesiredRoleIds,
      matchedRuleIds: normalizedMatchedRuleIds,
      primaryPlayerTag,
      primaryPlayerName,
      resultHash: buildResultHash({
        skipReason: null,
        desiredManagedRoleIds: normalizedDesiredRoleIds,
        matchedRuleIds: normalizedMatchedRuleIds,
        primaryPlayerTag,
        primaryPlayerName,
      }),
    };
  }

  private resolveSkipReason(config: AutoRoleGuildConfigSnapshot): string | null {
    if (!config.enabled) {
      return "autorole disabled";
    }
    if (config.killSwitchEnabled) {
      return "kill switch enabled";
    }
    return null;
  }

  private isRuleMatched(
    rule: AutoRoleRule,
    linkedAccounts: RankedLinkedAccount[],
    clanMembershipByTag: AutoRoleClanMembershipIndex,
    trackedClanScope: AutoRoleTrackedClanScope,
    preferCurrentClanTagForClanRules: boolean,
  ): boolean {
    switch (rule.type) {
      case AutoRoleRuleType.VERIFIED:
        return linkedAccounts.some((account) => isPlayerLinkVerifiedForAutorole(account));
      case AutoRoleRuleType.FAMILY:
        return linkedAccounts.some((account) => isPlayerLinkTrustedForAutorole(account));
      case AutoRoleRuleType.CLAN:
        return linkedAccounts.some((account) =>
          isLinkedAccountInClanTarget(
            account,
            rule.targetValue,
            clanMembershipByTag.get(rule.targetValue) ?? null,
            preferCurrentClanTagForClanRules,
          ),
        );
      case AutoRoleRuleType.CLAN_ROLE:
        return linkedAccounts.some((account) => {
          const targetRole = String(rule.targetValue ?? "").trim();
          const currentRole = String(account.playerCurrent?.role ?? "").trim();
          if (targetRole.length === 0 || currentRole.length === 0 || currentRole !== targetRole) {
            return false;
          }

          if (!isLeaderRankTarget(targetRole)) {
            return true;
          }

          return isLinkedAccountCurrentlyInTrackedClan(
            account,
            trackedClanScope.fwaClanTags,
          );
        });
      case AutoRoleRuleType.TOWN_HALL: {
        const targetTownHall = Math.trunc(Number(rule.targetValue));
        if (!Number.isFinite(targetTownHall)) return false;
        return linkedAccounts.some((account) => account.playerCurrent?.townHall === targetTownHall);
      }
      case AutoRoleRuleType.LEAGUE: {
        const targetLeague = normalizeLeagueNameForComparison(rule.targetValue);
        if (!targetLeague) return false;
        return linkedAccounts.some(
          (account) =>
            normalizeLeagueNameForComparison(account.playerCurrent?.leagueName) === targetLeague,
        );
      }
      case AutoRoleRuleType.LABEL:
        return false;
      default:
        return false;
    }
  }
}

export const autoRoleEvaluationService = new AutoRoleEvaluationService();
