import type { AutoRoleGuildConfigSnapshot, AutoRoleEvaluationMemberLike, AutoRoleMemberEvaluation } from "./AutoRoleEvaluationService";
import {
  autoRoleNicknameService,
  type AutoRoleNicknameTrackedClanLike,
} from "./AutoRoleNicknameService";
import type { PlayerCurrentLike } from "./PlayerCurrentService";
import type { PlayerLinkWithTrust } from "./PlayerLinkService";

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
  config: AutoRoleGuildConfigSnapshot;
  managedRoleIds: Set<string>;
  member: AutoRoleEvaluationMemberLike;
  evaluation: AutoRoleMemberEvaluation;
  linkedAccounts: PlayerLinkWithTrust[];
  playerCurrentByTag: Map<string, PlayerCurrentLike>;
  trackedClans: AutoRoleNicknameTrackedClanLike[];
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

/** Purpose: apply the evaluated autorole state to one Discord member while respecting kill switch and stale-removal policy. */
export class AutoRoleApplyService {
  async applyMember(input: AutoRoleApplyInput): Promise<AutoRoleMemberApplyResult> {
    const desiredManagedRoleIds = normalizeRoleIds(
      input.evaluation.desiredManagedRoleIds.filter((roleId) => input.managedRoleIds.has(roleId)),
    );
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

    const rolesToAdd = [...desiredManagedRoleIds].filter((roleId) => !currentManagedRoleIds.has(roleId));
    const rolesToRemove = input.config.removeStaleManagedRoles
      ? [...currentManagedRoleIds].filter((roleId) => !desiredManagedRoleIds.has(roleId))
      : [];

    const rolesAdded: string[] = [];
    const rolesRemoved: string[] = [];
    const failureReasons: string[] = [];

    for (const roleId of rolesToAdd) {
      try {
        await input.member.roles.add(roleId);
        rolesAdded.push(roleId);
      } catch (error) {
        failureReasons.push(formatFailureReason("add", roleId, error));
      }
    }

    for (const roleId of rolesToRemove) {
      try {
        await input.member.roles.remove(roleId);
        rolesRemoved.push(roleId);
      } catch (error) {
        failureReasons.push(formatFailureReason("remove", roleId, error));
      }
    }

    let nicknameStatus: AutoRoleApplyNicknameStatus = "skipped";
    let nicknameReason: string | null = null;
    if (!input.config.applyNicknames) {
      nicknameReason = "nickname sync disabled";
    } else if (!normalizeText(input.config.nicknameTemplate)) {
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
