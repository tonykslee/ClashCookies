import { AutoRoleRuleType, type AutoRoleRule } from "@prisma/client";
import type { AutoRoleGuildConfigSnapshot, AutoRoleEvaluationMemberLike, AutoRoleMemberEvaluation } from "./AutoRoleEvaluationService";
import {
  autoRoleNicknameService,
  type AutoRoleNicknameTrackedClanLike,
  normalizeNicknameTemplate,
} from "./AutoRoleNicknameService";
import type { PlayerCurrentLike } from "./PlayerCurrentService";
import { normalizePlayerTag, type PlayerLinkWithTrust } from "./PlayerLinkService";
import { prisma } from "../prisma";

export type AutoRoleApplyNicknameStatus = "changed" | "skipped" | "unchanged" | "failed";

export type AutoRoleMemberApplyResult = {
  discordUserId: string;
  status: "applied" | "skipped" | "failed";
  skipReason: string | null;
  rolesAdded: string[];
  rolesRemoved: string[];
  nicknameStatus: AutoRoleApplyNicknameStatus;
  nicknameReason: string | null;
  failureReasons: string[];
  resultHash: string;
};

export type AutoRoleApplyInput = {
  guildId: string;
  config: AutoRoleGuildConfigSnapshot;
  managedRoleIds: Set<string>;
  suppressRemovalRoleIds?: Set<string>;
  trackedFwaMemberTags?: Set<string>;
  visitorRoleAvailable?: boolean;
  rules: AutoRoleRule[];
  member: AutoRoleEvaluationMemberLike;
  evaluation: AutoRoleMemberEvaluation;
  linkedAccounts: PlayerLinkWithTrust[];
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  trackedClans: AutoRoleNicknameTrackedClanLike[];
  now?: Date;
};

function normalizeRoleIds(roleIds: Iterable<string>): Set<string> {
  return new Set([...roleIds].map((roleId) => String(roleId ?? "").trim()).filter(Boolean));
}

function formatRoleMention(roleId: string): string {
  return `<@&${roleId}>`;
}

function formatFailureReason(action: "add" | "remove", roleId: string, error: unknown): string {
  const message = String((error as { message?: string } | null | undefined)?.message ?? error ?? "").trim();
  return `${action} ${formatRoleMention(roleId)} failed${message ? `: ${message}` : ""}`;
}

function formatNicknameFailureReason(error: unknown): string {
  const code = String((error as { code?: string } | null | undefined)?.code ?? "").trim();
  const message = String((error as { message?: string } | null | undefined)?.message ?? error ?? "").trim();
  const normalizedMessage = message.toLowerCase();
  if (code === "50013" || normalizedMessage.includes("missing permissions") || normalizedMessage.includes("missing access") || normalizedMessage.includes("hierarchy")) {
    return `nickname update failed: ${message || "insufficient permissions"}`;
  }
  return `nickname update failed${message ? `: ${message}` : ""}`;
}

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function isLinkedAccountFamilyMember(input: {
  linkedAccounts: PlayerLinkWithTrust[];
  trackedFwaMemberTags: Set<string>;
}): boolean {
  if (input.trackedFwaMemberTags.size === 0) {
    return false;
  }

  return input.linkedAccounts.some((account) => {
    const playerTag = normalizePlayerTag(account.playerTag);
    return playerTag.length > 0 && input.trackedFwaMemberTags.has(playerTag);
  });
}

const CLAN_STALE_PENDING_REMOVAL_REASON = "CLAN_STALE";
const MAX_CLAN_ROLE_REMOVAL_DELAY_MINUTES = 10080;

function normalizeClanRoleRemovalDelayMinutes(value: number | null | undefined): number {
  const minutes = Number(value ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error("Clan role removal delay must be a non-negative number.");
  }
  if (minutes > MAX_CLAN_ROLE_REMOVAL_DELAY_MINUTES) {
    throw new Error(`Clan role removal delay must be at most ${MAX_CLAN_ROLE_REMOVAL_DELAY_MINUTES} minutes.`);
  }
  return Math.trunc(minutes);
}

function getClanRulesByRoleId(rules: AutoRoleRule[]): Map<string, AutoRoleRule[]> {
  const byRoleId = new Map<string, AutoRoleRule[]>();
  for (const rule of rules) {
    if (!rule.enabled || rule.type !== AutoRoleRuleType.CLAN) continue;
    const roleId = String(rule.discordRoleId ?? "").trim();
    if (!roleId) continue;
    const rows = byRoleId.get(roleId) ?? [];
    rows.push(rule);
    byRoleId.set(roleId, rows);
  }
  return byRoleId;
}

function getEnabledRulesByRoleId(rules: AutoRoleRule[]): Map<string, AutoRoleRule[]> {
  const byRoleId = new Map<string, AutoRoleRule[]>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const roleId = String(rule.discordRoleId ?? "").trim();
    if (!roleId) continue;
    const rows = byRoleId.get(roleId) ?? [];
    rows.push(rule);
    byRoleId.set(roleId, rows);
  }
  return byRoleId;
}

type PendingRemovalRow = {
  ruleId: string;
  discordRoleId: string;
  firstMissingAt: Date;
  lastCheckedAt: Date;
};

function pendingRemovalKey(roleId: string, ruleId: string): string {
  return `${roleId}:${ruleId}`;
}

/** Purpose: apply the evaluated autorole state to one Discord member while respecting kill switch and stale-removal policy. */
export class AutoRoleApplyService {
  async applyMember(input: AutoRoleApplyInput): Promise<AutoRoleMemberApplyResult> {
    const desiredManagedRoleIds = normalizeRoleIds(
      input.evaluation.desiredManagedRoleIds.filter((roleId) => input.managedRoleIds.has(roleId)),
    );
    const suppressRemovalRoleIds = normalizeRoleIds(input.suppressRemovalRoleIds ?? new Set<string>());
    const visitorRoleId = String(input.config.nonMemberRoleId ?? "").trim();
    const visitorRoleConfigured =
      Boolean(visitorRoleId) && input.config.nonMemberEnabled && input.managedRoleIds.has(visitorRoleId);
    const visitorRoleAvailable = input.visitorRoleAvailable ?? true;
    const familyMember = visitorRoleConfigured
      ? isLinkedAccountFamilyMember({
          linkedAccounts: input.linkedAccounts,
          trackedFwaMemberTags: input.trackedFwaMemberTags ?? new Set(),
        })
      : false;
    const shouldHaveVisitorRole = visitorRoleConfigured && visitorRoleAvailable && !familyMember;
    const currentManagedRoleIds = new Set(
      [...input.member.roles.cache.keys()]
        .map((roleId) => String(roleId ?? "").trim())
        .filter((roleId) => roleId.length > 0 && input.managedRoleIds.has(roleId)),
    );

    if (input.evaluation.skipReason) {
      return {
        discordUserId: input.member.id,
        status: "skipped",
        skipReason: input.evaluation.skipReason,
        rolesAdded: [],
        rolesRemoved: [],
        nicknameStatus: "skipped",
        nicknameReason: input.config.applyNicknames ? input.evaluation.skipReason : "nickname sync disabled",
        failureReasons: [],
        resultHash: input.evaluation.resultHash,
      };
    }

    if (input.config.killSwitchEnabled) {
      return {
        discordUserId: input.member.id,
        status: "skipped",
        skipReason: "kill switch enabled",
        rolesAdded: [],
        rolesRemoved: [],
        nicknameStatus: "skipped",
        nicknameReason: input.config.applyNicknames ? "kill switch enabled" : "nickname sync disabled",
        failureReasons: [],
        resultHash: input.evaluation.resultHash,
      };
    }

    if (shouldHaveVisitorRole) {
      desiredManagedRoleIds.add(visitorRoleId);
    }

    const now = input.now ?? new Date();
    const rulesByRoleId = getEnabledRulesByRoleId(input.rules);
    const clanRulesByRoleId = getClanRulesByRoleId(input.rules);
    const clanRoleRemovalDelayMinutes = normalizeClanRoleRemovalDelayMinutes(
      input.config.clanRoleRemovalDelayMinutes,
    );

    const rolesToAdd = [...desiredManagedRoleIds].filter((roleId) => !currentManagedRoleIds.has(roleId));
    const rolesAdded: string[] = [];
    const rolesRemoved: string[] = [];
    const failureReasons: string[] = [];

    if (desiredManagedRoleIds.size > 0) {
      await prisma.autoRolePendingRemoval.deleteMany({
        where: {
          guildId: input.guildId,
          discordUserId: input.member.id,
          discordRoleId: { in: [...desiredManagedRoleIds] },
        },
      });
    }

    for (const roleId of rolesToAdd) {
      try {
        await input.member.roles.add(roleId);
        rolesAdded.push(roleId);
      } catch (error) {
        failureReasons.push(formatFailureReason("add", roleId, error));
      }
    }

    if (input.config.removeStaleManagedRoles) {
      const staleManagedRoleIds = [...currentManagedRoleIds].filter(
        (roleId) =>
          roleId !== visitorRoleId &&
          !desiredManagedRoleIds.has(roleId) &&
          !suppressRemovalRoleIds.has(roleId),
      );
      const staleClanRoles: Array<{ roleId: string; rules: AutoRoleRule[] }> = [];
      const immediateRemovalRoleIds = new Set<string>();

      for (const roleId of staleManagedRoleIds) {
        const roleRules = rulesByRoleId.get(roleId) ?? [];
        const clanRules = clanRulesByRoleId.get(roleId) ?? [];
        if (clanRules.length === 0 || roleRules.length !== clanRules.length || clanRoleRemovalDelayMinutes === 0) {
          immediateRemovalRoleIds.add(roleId);
          continue;
        }
        staleClanRoles.push({ roleId, rules: clanRules });
      }

      const pendingRows = staleClanRoles.length > 0
        ? await prisma.autoRolePendingRemoval.findMany({
          where: {
            guildId: input.guildId,
            discordUserId: input.member.id,
            discordRoleId: { in: staleClanRoles.map((row) => row.roleId) },
            reason: CLAN_STALE_PENDING_REMOVAL_REASON,
          },
          select: {
            ruleId: true,
            discordRoleId: true,
            firstMissingAt: true,
            lastCheckedAt: true,
          },
        })
        : [];
      const pendingRowsByKey = new Map(
        pendingRows.map((row) => [pendingRemovalKey(row.discordRoleId, row.ruleId), row] as const),
      );

      for (const entry of staleClanRoles) {
        let earliestFirstMissingAt: Date | null = null;
        for (const rule of entry.rules) {
          const pendingKey = pendingRemovalKey(entry.roleId, rule.id);
          const existing = pendingRowsByKey.get(pendingKey) as PendingRemovalRow | undefined;
          const firstMissingAt = existing?.firstMissingAt ?? now;
          if (!earliestFirstMissingAt || firstMissingAt.getTime() < earliestFirstMissingAt.getTime()) {
            earliestFirstMissingAt = firstMissingAt;
          }

          await prisma.autoRolePendingRemoval.upsert({
            where: {
              guildId_discordUserId_discordRoleId_ruleId: {
                guildId: input.guildId,
                discordUserId: input.member.id,
                discordRoleId: entry.roleId,
                ruleId: rule.id,
              },
            },
            create: {
              guildId: input.guildId,
              discordUserId: input.member.id,
              discordRoleId: entry.roleId,
              ruleId: rule.id,
              reason: CLAN_STALE_PENDING_REMOVAL_REASON,
              firstMissingAt,
              lastCheckedAt: now,
            },
            update: {
              reason: CLAN_STALE_PENDING_REMOVAL_REASON,
              firstMissingAt,
              lastCheckedAt: now,
            },
          });
        }

        if (earliestFirstMissingAt) {
          const elapsedMinutes = (now.getTime() - earliestFirstMissingAt.getTime()) / 60_000;
          if (elapsedMinutes >= clanRoleRemovalDelayMinutes) {
            immediateRemovalRoleIds.add(entry.roleId);
          }
        }
      }

      for (const roleId of immediateRemovalRoleIds) {
        try {
          await input.member.roles.remove(roleId);
          rolesRemoved.push(roleId);
        } catch (error) {
          failureReasons.push(formatFailureReason("remove", roleId, error));
          immediateRemovalRoleIds.delete(roleId);
        }
      }

      if (immediateRemovalRoleIds.size > 0) {
        await prisma.autoRolePendingRemoval.deleteMany({
          where: {
            guildId: input.guildId,
            discordUserId: input.member.id,
            discordRoleId: { in: [...immediateRemovalRoleIds] },
          },
        });
      }
    } else {
      await prisma.autoRolePendingRemoval.deleteMany({
        where: {
          guildId: input.guildId,
          discordUserId: input.member.id,
        },
      });
    }

    if (visitorRoleConfigured && visitorRoleAvailable && !shouldHaveVisitorRole && currentManagedRoleIds.has(visitorRoleId)) {
      try {
        await input.member.roles.remove(visitorRoleId);
        rolesRemoved.push(visitorRoleId);
      } catch (error) {
        failureReasons.push(formatFailureReason("remove", visitorRoleId, error));
      }
    }

    let nicknameStatus: AutoRoleApplyNicknameStatus = "skipped";
    let nicknameReason: string | null = null;
    if (!input.config.applyNicknames) {
      nicknameReason = "nickname sync disabled";
    } else if (!normalizeNicknameTemplate(input.config.nicknameTemplate)) {
      nicknameReason = "nickname template not configured";
    } else {
      const nicknameResult = autoRoleNicknameService.renderNickname({
        config: input.config,
        template: input.config.nicknameTemplate ?? null,
        member: input.member,
        linkedAccounts: input.linkedAccounts,
        playerCurrentByTag: input.playerCurrentByTag,
        trackedClans: input.trackedClans,
      });

      const renderedNickname = nicknameResult.renderedNickname;
      if (!renderedNickname) {
        nicknameReason = "nickname template rendered empty";
      } else {
        const currentDisplayNickname = normalizeText(input.member.displayName ?? input.member.nickname ?? null) ?? "";
        if (currentDisplayNickname === renderedNickname) {
          nicknameStatus = "unchanged";
        } else {
          try {
            if (typeof input.member.setNickname === "function") {
              await input.member.setNickname(renderedNickname);
              nicknameStatus = "changed";
            } else {
              nicknameStatus = "skipped";
              nicknameReason = "nickname updates are not supported on this member";
            }
          } catch (error) {
            nicknameStatus = "failed";
            nicknameReason = formatNicknameFailureReason(error);
            failureReasons.push(nicknameReason);
          }
        }
      }
    }

    let status: AutoRoleMemberApplyResult["status"] = "skipped";
    if (failureReasons.length > 0) {
      status = rolesAdded.length > 0 || rolesRemoved.length > 0 ? "failed" : "failed";
    } else if (rolesAdded.length > 0 || rolesRemoved.length > 0 || nicknameStatus === "changed") {
      status = "applied";
    }

    return {
      discordUserId: input.member.id,
      status,
      skipReason: null,
      rolesAdded,
      rolesRemoved,
      nicknameStatus,
      nicknameReason,
      failureReasons,
      resultHash: input.evaluation.resultHash,
    };
  }
}

export const autoRoleApplyService = new AutoRoleApplyService();
