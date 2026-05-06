import type { AutoRoleGuildConfigSnapshot, AutoRoleEvaluationMemberLike, AutoRoleMemberEvaluation } from "./AutoRoleEvaluationService";

export type AutoRoleApplyNicknameStatus = "changed" | "skipped" | "unchanged";

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
        nicknameReason: input.config.applyNicknames ? "nickname renderer not implemented" : "nickname sync disabled",
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

    const nicknameStatus: AutoRoleApplyNicknameStatus = "skipped";
    const nicknameReason = input.config.applyNicknames
      ? "nickname renderer not implemented"
      : "nickname sync disabled";

    let status: AutoRoleMemberApplyResult["status"] = "skipped";
    if (failureReasons.length > 0) {
      status = rolesAdded.length > 0 || rolesRemoved.length > 0 ? "failed" : "failed";
    } else if (rolesAdded.length > 0 || rolesRemoved.length > 0) {
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
