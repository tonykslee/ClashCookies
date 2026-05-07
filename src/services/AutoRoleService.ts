import {
  AutoRoleRuleType,
  type AutoRoleGuildConfig,
  type AutoRoleRoleExclusion,
  type AutoRoleRule,
  type AutoRoleUserExclusion,
} from "@prisma/client";
import { prisma } from "../prisma";
import { normalizeClanTag, normalizeDiscordUserId } from "./PlayerLinkService";

export const AUTO_ROLE_RULE_TYPES = [
  "VERIFIED",
  "FAMILY",
  "CLAN",
  "CLAN_ROLE",
  "LEAGUE",
  "TOWN_HALL",
  "LABEL",
] as const satisfies readonly AutoRoleRuleType[];

export const AUTO_ROLE_RULE_DEFAULT_TARGET_VALUES = {
  VERIFIED: "__verified__",
  FAMILY: "__family__",
} as const;

const AUTO_ROLE_RULE_TYPE_ORDER: Record<AutoRoleRuleType, number> = {
  VERIFIED: 0,
  FAMILY: 1,
  CLAN: 2,
  CLAN_ROLE: 3,
  LEAGUE: 4,
  TOWN_HALL: 5,
  LABEL: 6,
};

const AUTO_ROLE_CLAN_ROLE_VALUES = new Set([
  "member",
  "elder",
  "coLeader",
  "leader",
]);

const AUTO_ROLE_SNOWFLAKE_RE = /^\d{15,22}$/;
const AUTO_ROLE_TOWN_HALL_MIN = 1;
const AUTO_ROLE_TOWN_HALL_MAX = 18;
const AUTO_ROLE_CLAN_ROLE_REMOVAL_DELAY_MIN = 0;
const AUTO_ROLE_CLAN_ROLE_REMOVAL_DELAY_MAX = 10080;

export type AutoRoleGuildConfigRecord = AutoRoleGuildConfig;
export type AutoRoleRuleRecord = AutoRoleRule;
export type AutoRoleUserExclusionRecord = AutoRoleUserExclusion;
export type AutoRoleRoleExclusionRecord = AutoRoleRoleExclusion;

export type AutoRoleGuildConfigUpdateInput = {
  enabled?: boolean;
  killSwitchEnabled?: boolean;
  removeStaleManagedRoles?: boolean;
  applyNicknames?: boolean;
  nicknameTemplate?: string | null;
  trustedLinksAllowed?: boolean;
  verifiedOnlyMode?: boolean;
  syncEnabled?: boolean;
  syncIntervalMinutes?: number | null;
  verifiedRoleId?: string | null;
  familyRoleId?: string | null;
  cwlClanRoleId?: string | null;
  clanRoleRemovalDelayMinutes?: number | null;
};

export type AutoRoleRuleCreateInput = {
  type: AutoRoleRuleType;
  discordRoleId: string;
  targetValue?: string | number | null;
  priority?: number | null;
  enabled?: boolean | null;
};

export type AutoRoleRuleUpdateInput = {
  type?: AutoRoleRuleType;
  discordRoleId?: string;
  targetValue?: string | number | null;
  priority?: number | null;
  enabled?: boolean | null;
};

export type AutoRoleExclusionList = {
  users: AutoRoleUserExclusionRecord[];
  roles: AutoRoleRoleExclusionRecord[];
};

export type AutoRoleGuildStateSnapshot = {
  config: AutoRoleGuildConfigRecord;
  rules: AutoRoleRuleRecord[];
  exclusions: AutoRoleExclusionList;
};

export type AutoRoleRuleDisplayType =
  | "all_verified"
  | "all_family"
  | "clan"
  | "clan_role"
  | "town_hall"
  | "label";

export type AutoRoleRuleNormalizedInput = {
  type: AutoRoleRuleType;
  discordRoleId: string;
  targetValue: string;
  priority: number;
  enabled: boolean;
};

/** Purpose: normalize a guild snowflake or reject blank/invalid input. */
function normalizeSnowflakeId(input: string): string {
  const trimmed = String(input ?? "").trim();
  return AUTO_ROLE_SNOWFLAKE_RE.test(trimmed) ? trimmed : "";
}

/** Purpose: canonicalize a boolean if the caller provided one. */
function toBooleanOrUndefined(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined;
}

/** Purpose: canonicalize an optional integer if the caller provided one. */
function toIntegerOrNull(input: unknown): number | null | undefined {
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
  return Math.trunc(input);
}

/** Purpose: normalize an optional nickname template while preserving explicit clears. */
export function normalizeNicknameTemplate(input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  const firstChar = trimmed.at(0);
  const lastChar = trimmed.at(-1);
  if (trimmed.length >= 2 && firstChar === lastChar && (firstChar === '"' || firstChar === "'")) {
    const unquoted = trimmed.slice(1, -1);
    return unquoted.length > 0 ? unquoted : null;
  }

  return trimmed;
}

/** Purpose: normalize an optional snowflake string while preserving explicit clears. */
function normalizeOptionalSnowflakeId(
  input: string | null | undefined,
): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const normalized = normalizeSnowflakeId(trimmed);
  if (!normalized) throw new Error("Selected Discord role is invalid.");
  return normalized;
}

function normalizeClanRoleRemovalDelayMinutes(
  input: number | null | undefined,
): number | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const value = Math.trunc(input);
  if (
    !Number.isFinite(value) ||
    value < AUTO_ROLE_CLAN_ROLE_REMOVAL_DELAY_MIN ||
    value > AUTO_ROLE_CLAN_ROLE_REMOVAL_DELAY_MAX
  ) {
    throw new Error(
      `Clan role removal delay must be between ${AUTO_ROLE_CLAN_ROLE_REMOVAL_DELAY_MIN} and ${AUTO_ROLE_CLAN_ROLE_REMOVAL_DELAY_MAX} minutes.`,
    );
  }
  return value === 0 ? null : value;
}

/** Purpose: normalize human-readable league text for persistence. */
function normalizeLeagueText(input: unknown): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

/** Purpose: normalize and validate a rule target for persistence. */
function normalizeRuleTarget(input: AutoRoleRuleCreateInput): string {
  switch (input.type) {
    case "VERIFIED":
      return AUTO_ROLE_RULE_DEFAULT_TARGET_VALUES.VERIFIED;
    case "FAMILY":
      return AUTO_ROLE_RULE_DEFAULT_TARGET_VALUES.FAMILY;
    case "CLAN": {
      const normalized = normalizeClanTag(String(input.targetValue ?? ""));
      if (!normalized) throw new Error("CLAN rules require a valid clan tag target.");
      return normalized;
    }
    case "CLAN_ROLE": {
      const normalized = String(input.targetValue ?? "").trim();
      if (!AUTO_ROLE_CLAN_ROLE_VALUES.has(normalized)) {
        throw new Error("CLAN_ROLE rules require one of: member, elder, coLeader, leader.");
      }
      return normalized;
    }
    case "TOWN_HALL": {
      const value = Number.parseInt(String(input.targetValue ?? "").trim(), 10);
      if (!Number.isFinite(value) || value < AUTO_ROLE_TOWN_HALL_MIN || value > AUTO_ROLE_TOWN_HALL_MAX) {
        throw new Error("TOWN_HALL rules require a TH value between 1 and 18.");
      }
      return String(value);
    }
    case "LEAGUE": {
      const normalized = normalizeLeagueText(input.targetValue);
      if (!normalized) throw new Error("LEAGUE rules require a non-empty target value.");
      return normalized;
    }
    case "LABEL": {
      const normalized = String(input.targetValue ?? "").trim();
      if (!normalized) throw new Error("LABEL rules require a non-empty target value.");
      return normalized;
    }
    default:
      throw new Error("Unknown autorole rule type.");
  }
}

/** Purpose: normalize a rule type from edit input and keep the schema contract stable. */
function normalizeRuleType(input: unknown): AutoRoleRuleType {
  const normalized = String(input ?? "").trim();
  if ((AUTO_ROLE_RULE_TYPES as readonly string[]).includes(normalized)) {
    return normalized as AutoRoleRuleType;
  }
  throw new Error("Unknown autorole rule type.");
}

/** Purpose: normalize a rule priority with a deterministic fallback. */
function normalizeRulePriority(type: AutoRoleRuleType, priority: number | null | undefined): number {
  if (typeof priority === "number" && Number.isFinite(priority)) {
    return Math.trunc(priority);
  }
  return AUTO_ROLE_RULE_TYPE_ORDER[type] * 100;
}

/** Purpose: build the canonical rule target row for validation and persistence. */
function normalizeRuleCreateInput(input: AutoRoleRuleCreateInput): AutoRoleRuleNormalizedInput {
  const type = normalizeRuleType(input.type);
  const discordRoleId = normalizeSnowflakeId(input.discordRoleId);
  if (!discordRoleId) {
    throw new Error("Selected Discord role is invalid.");
  }

  const targetValue = normalizeRuleTarget({
    ...input,
    type,
    discordRoleId,
  });
  const priority = normalizeRulePriority(type, input.priority ?? null);
  const enabled = input.enabled ?? true;

  return { type, discordRoleId, targetValue, priority, enabled };
}

/** Purpose: build a canonical rule target for updates while preserving existing fields when omitted. */
function normalizeRuleUpdateInput(
  current: AutoRoleRule,
  input: AutoRoleRuleUpdateInput,
): AutoRoleRuleNormalizedInput {
  const type = input.type ? normalizeRuleType(input.type) : current.type;
  const discordRoleId = input.discordRoleId
    ? normalizeSnowflakeId(input.discordRoleId)
    : current.discordRoleId;
  if (!discordRoleId) {
    throw new Error("Selected Discord role is invalid.");
  }

  const typeChanged = input.type !== undefined && input.type !== current.type;
  let targetValue: string;
  if (typeChanged) {
    if (type === "VERIFIED") {
      targetValue = AUTO_ROLE_RULE_DEFAULT_TARGET_VALUES.VERIFIED;
    } else if (type === "FAMILY") {
      targetValue = AUTO_ROLE_RULE_DEFAULT_TARGET_VALUES.FAMILY;
    } else {
      if (input.targetValue === undefined) {
        throw new Error("Changing a rule type requires a matching target_value.");
      }
      targetValue = normalizeRuleTarget({
        type,
        discordRoleId,
        targetValue: input.targetValue,
        priority: input.priority ?? current.priority,
        enabled: input.enabled ?? current.enabled,
      });
    }
  } else {
    targetValue =
      input.targetValue === undefined
        ? current.targetValue
        : normalizeRuleTarget({
            type,
            discordRoleId,
            targetValue: input.targetValue,
            priority: input.priority ?? current.priority,
            enabled: input.enabled ?? current.enabled,
          });
  }

  const priority = input.priority === undefined
    ? current.priority
    : normalizeRulePriority(type, input.priority);
  const enabled = input.enabled === undefined ? current.enabled : Boolean(input.enabled);

  return { type, discordRoleId, targetValue, priority, enabled };
}

/** Purpose: compare rules by deterministic display order. */
function compareRules(left: AutoRoleRule, right: AutoRoleRule): number {
  const priorityDelta = left.priority - right.priority;
  if (priorityDelta !== 0) return priorityDelta;

  const typeDelta =
    AUTO_ROLE_RULE_TYPE_ORDER[left.type] - AUTO_ROLE_RULE_TYPE_ORDER[right.type];
  if (typeDelta !== 0) return typeDelta;

  const targetDelta = left.targetValue.localeCompare(right.targetValue);
  if (targetDelta !== 0) return targetDelta;

  const roleDelta = left.discordRoleId.localeCompare(right.discordRoleId);
  if (roleDelta !== 0) return roleDelta;

  const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDelta !== 0) return createdDelta;

  return left.id.localeCompare(right.id);
}

/** Purpose: compare exclusions in a deterministic admin-readable order. */
function compareExclusions(
  left: { createdAt: Date; discordUserId?: string; discordRoleId?: string; id: string },
  right: { createdAt: Date; discordUserId?: string; discordRoleId?: string; id: string },
): number {
  const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDelta !== 0) return createdDelta;

  const leftKey = left.discordUserId ?? left.discordRoleId ?? "";
  const rightKey = right.discordUserId ?? right.discordRoleId ?? "";
  const keyDelta = leftKey.localeCompare(rightKey);
  if (keyDelta !== 0) return keyDelta;

  return left.id.localeCompare(right.id);
}

/** Purpose: detect duplicate composite rows across one guild. */
async function assertNoDuplicateRule(
  guildId: string,
  next: AutoRoleRuleNormalizedInput,
  currentRuleId?: string,
): Promise<void> {
  const duplicate = await prisma.autoRoleRule.findFirst({
    where: {
      guildId,
      type: next.type,
      targetValue: next.targetValue,
      discordRoleId: next.discordRoleId,
      ...(currentRuleId ? { NOT: { id: currentRuleId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new Error("That autorole rule already exists for this guild.");
  }
}

/** Purpose: normalize guild config updates into Prisma-safe values. */
function normalizeGuildConfigUpdate(input: AutoRoleGuildConfigUpdateInput): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  const enabled = toBooleanOrUndefined(input.enabled);
  if (enabled !== undefined) data.enabled = enabled;

  const killSwitchEnabled = toBooleanOrUndefined(input.killSwitchEnabled);
  if (killSwitchEnabled !== undefined) data.killSwitchEnabled = killSwitchEnabled;

  const removeStaleManagedRoles = toBooleanOrUndefined(input.removeStaleManagedRoles);
  if (removeStaleManagedRoles !== undefined) data.removeStaleManagedRoles = removeStaleManagedRoles;

  const applyNicknames = toBooleanOrUndefined(input.applyNicknames);
  if (applyNicknames !== undefined) data.applyNicknames = applyNicknames;

  const nicknameTemplate = normalizeNicknameTemplate(input.nicknameTemplate);
  if (nicknameTemplate !== undefined) data.nicknameTemplate = nicknameTemplate;

  const trustedLinksAllowed = toBooleanOrUndefined(input.trustedLinksAllowed);
  if (trustedLinksAllowed !== undefined) data.trustedLinksAllowed = trustedLinksAllowed;

  const verifiedOnlyMode = toBooleanOrUndefined(input.verifiedOnlyMode);
  if (verifiedOnlyMode !== undefined) data.verifiedOnlyMode = verifiedOnlyMode;

  const syncEnabled = toBooleanOrUndefined(input.syncEnabled);
  if (syncEnabled !== undefined) data.syncEnabled = syncEnabled;

  const syncIntervalMinutes = toIntegerOrNull(input.syncIntervalMinutes);
  if (syncIntervalMinutes !== undefined) {
    if (syncIntervalMinutes !== null && syncIntervalMinutes <= 0) {
      throw new Error("syncIntervalMinutes must be greater than zero when provided.");
    }
    data.syncIntervalMinutes = syncIntervalMinutes;
  }

  if (input.verifiedRoleId !== undefined) {
    data.verifiedRoleId = normalizeOptionalSnowflakeId(input.verifiedRoleId) ?? null;
  }

  if (input.familyRoleId !== undefined) {
    data.familyRoleId = normalizeOptionalSnowflakeId(input.familyRoleId) ?? null;
  }

  if (input.cwlClanRoleId !== undefined) {
    data.cwlClanRoleId = normalizeOptionalSnowflakeId(input.cwlClanRoleId) ?? null;
  }

  if (input.clanRoleRemovalDelayMinutes !== undefined) {
    data.clanRoleRemovalDelayMinutes = normalizeClanRoleRemovalDelayMinutes(
      input.clanRoleRemovalDelayMinutes,
    ) ?? null;
  }

  return data;
}

/** Purpose: normalize a guild id or reject an invalid one. */
function requireGuildId(guildId: string): string {
  const normalized = normalizeSnowflakeId(guildId);
  if (!normalized) throw new Error("Invalid guild id.");
  return normalized;
}

/** Purpose: normalize a Discord user id for exclusion writes. */
function requireDiscordUserId(userId: string): string {
  const normalized = normalizeDiscordUserId(userId);
  if (!normalized) throw new Error("Invalid Discord user id.");
  return normalized;
}

/** Purpose: normalize a Discord role id for exclusion writes. */
function requireDiscordRoleId(roleId: string): string {
  const normalized = normalizeSnowflakeId(roleId);
  if (!normalized) throw new Error("Invalid Discord role id.");
  return normalized;
}

export class AutoRoleService {
  /** Purpose: get or create one guild config row. */
  async getOrCreateGuildConfig(guildId: string): Promise<AutoRoleGuildConfigRecord> {
    const normalizedGuildId = requireGuildId(guildId);
    return prisma.autoRoleGuildConfig.upsert({
      where: { guildId: normalizedGuildId },
      create: { guildId: normalizedGuildId },
      update: {},
    });
  }

  /** Purpose: update one guild config row with safe partial writes. */
  async updateGuildConfig(
    guildId: string,
    input: AutoRoleGuildConfigUpdateInput,
  ): Promise<AutoRoleGuildConfigRecord> {
    const normalizedGuildId = requireGuildId(guildId);
    const data = normalizeGuildConfigUpdate(input);
    if (Object.keys(data).length === 0) {
      return this.getOrCreateGuildConfig(normalizedGuildId);
    }

    return prisma.autoRoleGuildConfig.upsert({
      where: { guildId: normalizedGuildId },
      create: { guildId: normalizedGuildId, ...data },
      update: data,
    });
  }

  /** Purpose: load one guild's current autorole snapshot with the three persisted sources the refresh path needs. */
  async getGuildStateSnapshot(guildId: string): Promise<AutoRoleGuildStateSnapshot> {
    const config = await this.getOrCreateGuildConfig(guildId);
    const [rules, exclusions] = await Promise.all([
      this.listRules(guildId),
      this.listExclusions(guildId),
    ]);

    return {
      config,
      rules,
      exclusions,
    };
  }

  /** Purpose: list one guild's persisted autorole rules in deterministic order. */
  async listRules(guildId: string): Promise<AutoRoleRuleRecord[]> {
    const normalizedGuildId = requireGuildId(guildId);
    const rows = await prisma.autoRoleRule.findMany({
      where: { guildId: normalizedGuildId },
    });
    return [...rows].sort(compareRules);
  }

  /** Purpose: create one persisted autorole rule. */
  async createRule(
    guildId: string,
    input: AutoRoleRuleCreateInput,
  ): Promise<AutoRoleRuleRecord> {
    const normalizedGuildId = requireGuildId(guildId);
    const normalized = normalizeRuleCreateInput(input);
    await assertNoDuplicateRule(normalizedGuildId, normalized);

    try {
      return await prisma.autoRoleRule.create({
        data: {
          guildId: normalizedGuildId,
          type: normalized.type,
          targetValue: normalized.targetValue,
          discordRoleId: normalized.discordRoleId,
          priority: normalized.priority,
          enabled: normalized.enabled,
        },
      });
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code ?? "";
      if (code === "P2002") {
        throw new Error("That autorole rule already exists for this guild.");
      }
      throw err;
    }
  }

  /** Purpose: edit one persisted autorole rule. */
  async updateRule(
    guildId: string,
    ruleId: string,
    input: AutoRoleRuleUpdateInput,
  ): Promise<AutoRoleRuleRecord | null> {
    const normalizedGuildId = requireGuildId(guildId);
    const current = await prisma.autoRoleRule.findFirst({
      where: { id: ruleId, guildId: normalizedGuildId },
    });
    if (!current) return null;

    const normalized = normalizeRuleUpdateInput(current, input);
    await assertNoDuplicateRule(normalizedGuildId, normalized, current.id);

    try {
      return await prisma.autoRoleRule.update({
        where: { id: current.id },
        data: {
          type: normalized.type,
          targetValue: normalized.targetValue,
          discordRoleId: normalized.discordRoleId,
          priority: normalized.priority,
          enabled: normalized.enabled,
        },
      });
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code ?? "";
      if (code === "P2002") {
        throw new Error("That autorole rule already exists for this guild.");
      }
      throw err;
    }
  }

  /** Purpose: delete one persisted autorole rule. */
  async deleteRule(guildId: string, ruleId: string): Promise<boolean> {
    const normalizedGuildId = requireGuildId(guildId);
    const deleted = await prisma.autoRoleRule.deleteMany({
      where: { id: ruleId, guildId: normalizedGuildId },
    });
    return deleted.count > 0;
  }

  /** Purpose: list one guild's user/role exclusions. */
  async listExclusions(guildId: string): Promise<AutoRoleExclusionList> {
    const normalizedGuildId = requireGuildId(guildId);
    const [users, roles] = await Promise.all([
      prisma.autoRoleUserExclusion.findMany({
        where: { guildId: normalizedGuildId },
      }),
      prisma.autoRoleRoleExclusion.findMany({
        where: { guildId: normalizedGuildId },
      }),
    ]);

    return {
      users: [...users].sort(compareExclusions),
      roles: [...roles].sort(compareExclusions),
    };
  }

  /** Purpose: add one user exclusion. */
  async addUserExclusion(
    guildId: string,
    userId: string,
    reason?: string | null,
  ): Promise<AutoRoleUserExclusionRecord> {
    const normalizedGuildId = requireGuildId(guildId);
    const normalizedUserId = requireDiscordUserId(userId);
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    const existing = await prisma.autoRoleUserExclusion.findFirst({
      where: { guildId: normalizedGuildId, discordUserId: normalizedUserId },
    });
    if (existing) {
      throw new Error("That user exclusion already exists for this guild.");
    }

    try {
      return await prisma.autoRoleUserExclusion.create({
        data: {
          guildId: normalizedGuildId,
          discordUserId: normalizedUserId,
          reason: normalizedReason.length > 0 ? normalizedReason : null,
        },
      });
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code ?? "";
      if (code === "P2002") {
        throw new Error("That user exclusion already exists for this guild.");
      }
      throw err;
    }
  }

  /** Purpose: remove one user exclusion. */
  async removeUserExclusion(guildId: string, userId: string): Promise<boolean> {
    const normalizedGuildId = requireGuildId(guildId);
    const normalizedUserId = requireDiscordUserId(userId);
    const deleted = await prisma.autoRoleUserExclusion.deleteMany({
      where: { guildId: normalizedGuildId, discordUserId: normalizedUserId },
    });
    return deleted.count > 0;
  }

  /** Purpose: add one role exclusion. */
  async addRoleExclusion(
    guildId: string,
    roleId: string,
    reason?: string | null,
  ): Promise<AutoRoleRoleExclusionRecord> {
    const normalizedGuildId = requireGuildId(guildId);
    const normalizedRoleId = requireDiscordRoleId(roleId);
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    const existing = await prisma.autoRoleRoleExclusion.findFirst({
      where: { guildId: normalizedGuildId, discordRoleId: normalizedRoleId },
    });
    if (existing) {
      throw new Error("That role exclusion already exists for this guild.");
    }

    try {
      return await prisma.autoRoleRoleExclusion.create({
        data: {
          guildId: normalizedGuildId,
          discordRoleId: normalizedRoleId,
          reason: normalizedReason.length > 0 ? normalizedReason : null,
        },
      });
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code ?? "";
      if (code === "P2002") {
        throw new Error("That role exclusion already exists for this guild.");
      }
      throw err;
    }
  }

  /** Purpose: remove one role exclusion. */
  async removeRoleExclusion(guildId: string, roleId: string): Promise<boolean> {
    const normalizedGuildId = requireGuildId(guildId);
    const normalizedRoleId = requireDiscordRoleId(roleId);
    const deleted = await prisma.autoRoleRoleExclusion.deleteMany({
      where: { guildId: normalizedGuildId, discordRoleId: normalizedRoleId },
    });
    return deleted.count > 0;
  }
}

export const autoRoleService = new AutoRoleService();

/** Purpose: render a persisted rule target into a scan-friendly admin label. */
export function formatAutoRoleRuleTarget(rule: AutoRoleRuleRecord): string {
  switch (rule.type) {
    case "VERIFIED":
      return "verified accounts";
    case "FAMILY":
      return "family/member accounts";
    case "CLAN":
      return `clan ${rule.targetValue}`;
    case "CLAN_ROLE":
      return `clan rank ${rule.targetValue}`;
    case "LEAGUE":
      return `league ${rule.targetValue}`;
    case "TOWN_HALL":
      return `TH${rule.targetValue}`;
    case "LABEL":
      return `label ${rule.targetValue}`;
    default:
      return rule.targetValue;
  }
}

/** Purpose: render a stable rule type label. */
export function formatAutoRoleRuleType(ruleType: AutoRoleRuleType): string {
  switch (ruleType) {
    case "VERIFIED":
      return "VERIFIED";
    case "FAMILY":
      return "FAMILY";
    case "CLAN":
      return "CLAN";
    case "CLAN_ROLE":
      return "CLAN_ROLE";
    case "LEAGUE":
      return "LEAGUE";
    case "TOWN_HALL":
      return "TOWN_HALL";
    case "LABEL":
      return "LABEL";
    default:
      return ruleType;
  }
}
