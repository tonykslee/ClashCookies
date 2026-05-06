import { createHash } from "node:crypto";
import { AutoRoleRuleType, type AutoRoleGuildConfig, type AutoRoleRule } from "@prisma/client";
import { normalizeClanTag, getPlayerLinkTrustTier, isPlayerLinkTrustedForAutorole, isPlayerLinkVerifiedForAutorole, type PlayerLinkWithTrust } from "./PlayerLinkService";
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
>;

export type AutoRoleEvaluationMemberLike = {
  id: string;
  roles: {
    cache: {
      keys(): IterableIterator<string>;
      has(roleId: string): boolean;
    };
    add(roleId: string): Promise<unknown>;
    remove(roleId: string): Promise<unknown>;
  };
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
  if (config.verifiedOnlyMode || config.trustedLinksAllowed === false) {
    return isPlayerLinkVerifiedForAutorole(link);
  }
  return isPlayerLinkTrustedForAutorole(link);
}

function resolveMemberSourceCurrentClanTag(
  linkedAccount: RankedLinkedAccount,
): string | null {
  const currentClanTag = normalizeClanTag(linkedAccount.playerCurrent?.currentClanTag ?? "");
  return currentClanTag || null;
}

function isLinkedAccountInClanTarget(
  linkedAccount: RankedLinkedAccount,
  targetClanTag: string,
  clanMembership: AutoRoleClanMembershipIndexRow | null,
): boolean {
  const normalizedTarget = normalizeClanTag(targetClanTag);
  if (!normalizedTarget) return false;

  if (clanMembership?.playerTags.has(linkedAccount.playerTag)) {
    return true;
  }

  if (!clanMembership || clanMembership.source === "UNKNOWN" || clanMembership.source === "FWA") {
    const currentClanTag = resolveMemberSourceCurrentClanTag(linkedAccount);
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
  }): Set<string> {
    const roleIds = new Set<string>();
    if (input.config.verifiedRoleId) roleIds.add(input.config.verifiedRoleId);
    if (input.config.familyRoleId) roleIds.add(input.config.familyRoleId);
    for (const rule of input.rules) {
      if (!rule.enabled) continue;
      roleIds.add(rule.discordRoleId);
    }
    return roleIds;
  }

  /** Purpose: evaluate one member's autorole desired managed-role set and stable result hash. */
  evaluateMember(input: AutoRoleEvaluationInput): AutoRoleMemberEvaluation {
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

      if (this.isRuleMatched(rule, linkedAccounts, input.clanMembershipByTag)) {
        desiredManagedRoleIds.add(rule.discordRoleId);
        matchedRuleIds.add(rule.id);
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
          ),
        );
      case AutoRoleRuleType.CLAN_ROLE:
        return linkedAccounts.some((account) => {
          const currentRole = String(account.playerCurrent?.role ?? "").trim();
          return currentRole.length > 0 && currentRole === String(rule.targetValue ?? "").trim();
        });
      case AutoRoleRuleType.TOWN_HALL: {
        const targetTownHall = Math.trunc(Number(rule.targetValue));
        if (!Number.isFinite(targetTownHall)) return false;
        return linkedAccounts.some((account) => account.playerCurrent?.townHall === targetTownHall);
      }
      case AutoRoleRuleType.LABEL:
        return false;
      default:
        return false;
    }
  }
}

export const autoRoleEvaluationService = new AutoRoleEvaluationService();
