import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
} from "discord.js";
import { SettingsService } from "./SettingsService";

export const MANAGE_COMMAND_ROLES_COMMAND = "permission";
export const FWA_LEADER_ROLE_SETTING_KEY = "fwa_leader_role";

export const COMMAND_PERMISSION_TARGETS = [
  "help",
  "emoji",
  "emoji:add",
  "lastseen",
  "inactive",
  "role-users",
  "accounts",
  "todo",
  "remindme",
  "remindme:set",
  "remindme:list",
  "remindme:remove",
  "reminders",
  "reminders:create",
  "reminders:list",
  "reminders:reconcile-cwl",
  "reminders:audit-cwl",
  "reminders:edit",
  "link",
  "layout",
  "dump",
  "link:create",
  "link:create:other-user",
  "link:delete",
  "link:verify",
  "link:status",
  "link:list",
  "link:embed",
  "link:sync-clashperk",
  "link:create:admin",
  "link:delete:admin",
  "war",
  "notify",
  "warplan",
  "clan:configure",
  "clan:rep:add",
  "clan:rep:remove",
  "clan:rep:list",
  "clan:rep:time",
  "clan:rep:timezone",
  "clan:cwl-tags",
  "clan:raid-tags",
  "clan:remove",
  "clan:list",
  "raids",
  "raids:overview",
  "raids:intel",
  "raids:roster:add",
  "raids:roster:status",
  "sheet:link",
  "sheet:unlink",
  "sheet:show",
  "sheet:refresh",
  "compo:advice",
  "compo:state",
  "compo:place",
  "compo:fill",
  "cc:player",
  "cc:clan",
  "notify:war",
  "fwa:points",
  "fwa:match",
  "fwa:match-checklist",
  "fwa:violations",
  "fwa:layout",
  "fwa:layout-move",
  "fwa:layout-retitle",
  "fwa:blacklist-import",
  "fwa:blacklist-samples:rebuild",
  "fwa:blacklist-profile:rebuild",
  "fwa:compliance",
  "fwa:police",
  "fwa:base-swap",
  "fwa:weight-link",
  "fwa:weight-health",
  "fwa:weight-alert",
  "defer",
  "defer:add",
  "defer:list",
  "defer:config",
  "defer:remove",
  "defer:clear",
  "fwa:leader-role",
  "link:create:admin",
  "link:delete:admin",
  "force:sync:data",
  "force:sync:mail",
  "force:sync:warid",
  "force:mail:update",
  "force:refresh:heatmapref",
  "remaining",
  "remaining:war",
  "remaining:cwl",
  "potion",
  "potion:calc",
  "clan-health",
  "repwork",
  "telemetry",
  "telemetry:report",
  "telemetry:schedule:set",
  "telemetry:schedule:show",
  "telemetry:schedule:disable",
  "telemetry:schedule:run-now",
  "recruitment:show",
  "recruitment:edit",
  "recruitment:dashboard",
  "recruitment:countdown:start",
  "recruitment:countdown:settings",
  "recruitment:countdown:status",
  "kick-list:build",
  "kick-list:add",
  "kick-list:remove",
  "kick-list:show",
  "kick-list:clear",
  "autorole",
  "autorole:config",
  "autorole:config:show",
  "autorole:config:set",
  "autorole:rules",
  "autorole:rules:list",
  "autorole:rules:add",
  "autorole:rules:edit",
  "autorole:rules:remove",
  "autorole:exclusions",
  "autorole:exclusions:list",
  "autorole:exclusions:add-user",
  "autorole:exclusions:remove-user",
  "autorole:exclusions:add-role",
  "autorole:exclusions:remove-role",
  "autorole:refresh:user",
  "autorole:refresh:role",
  "autorole:refresh",
  "fillers",
  "fillers:list",
  "fillers:set",
  "sync",
  "sync:readiness",
  "sync:retrospective",
  "sync:time:post",
  "sync:post:status",
  "say",
  "copy-channel",
  "bot-logs",
  "bot:status",
  "bot:poll:status",
  "ban",
  "ban:add",
  "ban:list",
  "ban:remove",
  "unlinked",
  "unlinked:set-alert",
  "unlinked:list",
  "cwl",
  "cwl:activity",
  "cwl:camping",
  "cwl:members",
  "cwl:rotations",
  "cwl:rotations:show",
  "cwl:rotations:create",
  "cwl:rotations:import",
  "cwl:rotations:export",
  "roster:create",
  "roster:list",
  "roster:show",
  "roster:set",
  "roster:reset",
  "roster:post",
  "roster:manage",
  "roster:ping",
  "roster:edit",
  "roster:delete",
  "roster:report",
  "roster:refresh",
  `${MANAGE_COMMAND_ROLES_COMMAND}:add`,
  `${MANAGE_COMMAND_ROLES_COMMAND}:remove`,
  `${MANAGE_COMMAND_ROLES_COMMAND}:list`,
] as const;

export type CommandPermissionTarget =
  (typeof COMMAND_PERMISSION_TARGETS)[number];

type GuildInteraction =
  | ButtonInteraction
  | ChatInputCommandInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction;

const ADMIN_DEFAULT_TARGETS = new Set<string>([
  "clan:configure",
  "clan:rep:add",
  "clan:rep:remove",
  "clan:rep:timezone",
  "clan:cwl-tags",
  "clan:raid-tags",
  "clan:remove",
  "reminders",
  "reminders:create",
  "reminders:list",
  "reminders:reconcile-cwl",
  "reminders:audit-cwl",
  "reminders:edit",
  "sheet:link",
  "sheet:unlink",
  "sheet:show",
  "emoji:add",
  "telemetry",
  "kick-list:clear",
  "notify:war",
  "link:embed",
  "link:sync-clashperk",
  "link:delete:admin",
  "bot-logs",
  "bot:status",
  "warplan",
  "ban",
  "ban:add",
  "ban:list",
  "ban:remove",
  "fwa:leader-role",
  "fwa:layout-move",
  "fwa:layout-retitle",
  "force:sync:data",
  "force:sync:mail",
  "force:sync:warid",
  "force:mail:update",
  "force:refresh:heatmapref",
  "cwl:rotations:create",
  "cwl:rotations:import",
  "cwl:rotations:export",
  "roster:create",
  "roster:set",
  "roster:reset",
  "roster:post",
  "roster:manage",
  "roster:ping",
  "roster:edit",
  "roster:delete",
  "roster:report",
  "roster:refresh",
  "autorole",
  "autorole:config",
  "autorole:rules",
  "autorole:exclusions",
  "autorole:refresh:user",
  "autorole:refresh:role",
  "fillers",
  "fillers:list",
  "fillers:set",
  "bot:poll:status",
  `${MANAGE_COMMAND_ROLES_COMMAND}:add`,
  `${MANAGE_COMMAND_ROLES_COMMAND}:remove`,
]);

const FWA_LEADER_DEFAULT_TARGETS = new Set<string>([
  "clan:list",
  "sheet:refresh",
  "compo:advice",
  "compo:state",
  "compo:place",
  "compo:fill",
  "fwa:points",
  "fwa:match",
  "fwa:match-checklist",
  "fwa:violations",
  "fwa:blacklist-import",
  "fwa:blacklist-samples:rebuild",
  "fwa:blacklist-profile:rebuild",
  "fwa:compliance",
  "fwa:police",
  "fwa:base-swap",
  "fwa:weight-link",
  "fwa:weight-health",
  "fwa:weight-alert",
  "defer",
  "defer:add",
  "defer:list",
  "defer:config",
  "defer:remove",
  "defer:clear",
  "clan:rep:list",
  "clan:rep:time",
  "fwa:mail:send",
  "link:create:other-user",
  "recruitment:show",
  "recruitment:edit",
  "recruitment:dashboard",
  "recruitment:countdown:start",
  "recruitment:countdown:settings",
  "recruitment:countdown:status",
  "kick-list:build",
  "kick-list:add",
  "kick-list:remove",
  "kick-list:show",
  "autorole:refresh",
  "fillers",
  "fillers:list",
  "fillers:set",
  "sync:readiness",
  "sync:retrospective",
  "sync:time:post",
  "sync:post:status",
  "inactive",
  "clan-health",
  "repwork",
  "unlinked",
  "unlinked:set-alert",
  "unlinked:list",
  "cwl:activity",
  "cwl:camping",
]);

/** Purpose: command roles key. */
function normalizePermissionTargetNamespace(commandName: string): string {
  const normalized = String(commandName ?? "").trim();
  if (normalized === "clan") return "tracked-clan";
  if (normalized.startsWith("clan:")) return `tracked-clan:${normalized.slice("clan:".length)}`;
  return normalized;
}

/** Purpose: command roles key. */
function commandRolesKey(commandName: string): string {
  return `command_roles:${normalizePermissionTargetNamespace(commandName)}`;
}

/** Purpose: build the additive role-grant setting key. */
function commandRoleAdditionsKey(commandName: string): string {
  return `command_roles_additions:${normalizePermissionTargetNamespace(commandName)}`;
}

/** Purpose: build the role-exclusion setting key. */
function commandRoleExclusionsKey(commandName: string): string {
  return `command_roles_exclusions:${normalizePermissionTargetNamespace(commandName)}`;
}

/** Purpose: build the legacy-restrictive marker setting key. */
function commandRolesRestrictiveMarkerKey(commandName: string): string {
  return `command_roles_restrictive:${normalizePermissionTargetNamespace(commandName)}`;
}

/** Purpose: fwa leader role key. */
function fwaLeaderRoleKey(guildId: string): string {
  return `${FWA_LEADER_ROLE_SETTING_KEY}:${guildId}`;
}

/** Purpose: parse role ids. */
function parseRoleIds(input: string | null): string[] {
  if (!input) return [];
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  return [...new Set(parts)];
}

/** Purpose: stringify role ids. */
function stringifyRoleIds(roleIds: string[]): string {
  return [...new Set(roleIds)].join(",");
}

/** Purpose: get interaction role ids. */
async function getInteractionRoleIds(
  interaction: GuildInteraction,
): Promise<string[]> {
  if (!interaction.inGuild()) return [];

  const member = interaction.member;
  if (member && "roles" in member) {
    const roles = member.roles;
    if (Array.isArray(roles)) {
      return roles;
    }
    if (roles && "cache" in roles) {
      return [...roles.cache.keys()];
    }
  }

  const guild = interaction.guild;
  if (!guild) return [];

  const fetched = await guild.members.fetch(interaction.user.id);
  return [...fetched.roles.cache.keys()];
}

/** Purpose: is admin default target. */
function isAdminDefaultTarget(target: string): boolean {
  return ADMIN_DEFAULT_TARGETS.has(target);
}

/** Purpose: is fwa leader default target. */
function isFwaLeaderDefaultTarget(target: string): boolean {
  return FWA_LEADER_DEFAULT_TARGETS.has(target);
}

/** Purpose: is known target. */
function isKnownTarget(target: string): target is CommandPermissionTarget {
  return (COMMAND_PERMISSION_TARGETS as readonly string[]).includes(target);
}

type PermissionDefaultKind = "everyone" | "fwa_leader" | "administrator";

type StoredPermissionPolicy = {
  legacyRoleIds: string[];
  addedRoleIds: string[];
  excludedRoleIds: string[];
  hasLegacyRestrictivePolicy: boolean;
  hasCustomPolicy: boolean;
};

export type CommandPermissionPolicyLayer = StoredPermissionPolicy & {
  target: string;
};

export type CommandPermissionPolicy = StoredPermissionPolicy & {
  requestedTarget: string;
  sourceTarget: string;
  inheritedFrom: string | null;
  defaultKind: PermissionDefaultKind | "legacy_restrictive";
  layers: CommandPermissionPolicyLayer[];
};

export type PermissionRoleMutation = {
  roleId: string;
  outcome:
    | "added"
    | "restored"
    | "already_allowed"
    | "removed"
    | "excluded"
    | "already_excluded"
    | "administrator_bypass"
    | "no_op";
  policy: CommandPermissionPolicy;
};

export type EffectiveAllowedRoleSummary = {
  everyone: boolean;
  roleIds: string[];
};

/** Purpose: identify a target's built-in default policy. */
function getPermissionDefaultKind(target: string): PermissionDefaultKind {
  if (isFwaLeaderDefaultTarget(target)) return "fwa_leader";
  if (isAdminDefaultTarget(target)) return "administrator";
  return "everyone";
}

/** Purpose: format permission role mentions for policy summaries. */
function formatPermissionRoleIds(roleIds: string[]): string {
  return roleIds.length > 0
    ? roleIds.map((roleId) => `<@&${roleId}>`).join(", ")
    : "(none)";
}

/** Purpose: expand permission targets with backward-compatible policy fallbacks. */
function getEffectivePermissionTargets(targets: string[]): string[] {
  const effective: string[] = [];
  for (const target of targets) {
    effective.push(target);
    if (target === "roster:ping") {
      effective.push("roster:manage");
    }
  }
  return [...new Set(effective)];
}

/** Purpose: resolve known parent targets for permission management summaries and mutations. */
function getPermissionManagementTargets(commandName: string): string[] {
  const exactOnlyTargets = new Set([
    "autorole:refresh:user",
    "autorole:refresh:role",
    "defer:config",
    "link:create:other-user",
    "link:delete:admin",
    "link:embed",
    "link:sync-clashperk",
    "sync:time:post",
    "sync:post:status",
  ]);
  if (exactOnlyTargets.has(commandName)) return [commandName];

  const targets = [commandName];
  const segments = commandName.split(":");
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const parent = segments.slice(0, length).join(":");
    if (isKnownTarget(parent)) targets.push(parent);
  }
  return targets;
}

export function getPermissionTargetPrefixesForCommand(
  commandName: string,
): string[] {
  return [commandName];
}

export function hasPermissionTargetForCommand(commandName: string): boolean {
  const prefixes = getPermissionTargetPrefixesForCommand(commandName);
  return COMMAND_PERMISSION_TARGETS.some((target) =>
    prefixes.some(
      (prefix) => target === prefix || target.startsWith(`${prefix}:`),
    ),
  );
}

/** Purpose: get owner bypass ids. */
function getOwnerBypassIds(): Set<string> {
  const raw =
    process.env.OWNER_DISCORD_USER_IDS ?? process.env.OWNER_DISCORD_USER_ID;
  if (!raw) return new Set();
  const ids = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v));
  return new Set(ids);
}

/** Purpose: has owner bypass. */
function hasOwnerBypass(interaction: GuildInteraction): boolean {
  const owners = getOwnerBypassIds();
  if (owners.size === 0) return false;
  return owners.has(interaction.user.id);
}

/** Purpose: get command targets from interaction. */
export function getCommandTargetsFromInteraction(
  interaction: ChatInputCommandInteraction,
): string[] {
  const command = interaction.commandName;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);

  const raw: string[] = [];
  if (command === "autorole" && sub === "refresh" && group === null) {
    const user = interaction.options.getUser("user", false);
    const role = interaction.options.getRole("role", false);
    if (user) {
      raw.push("autorole:refresh:user");
    }
    if (role) {
      raw.push("autorole:refresh:role");
    }
    if (!user && !role) {
      raw.push("autorole:refresh");
    }
    raw.push(command);
    return raw.filter((target) => isKnownTarget(target));
  }
  if (command === "fillers" && group === null && sub) {
    if (sub === "list") {
      raw.push("fillers:list");
    } else if (sub === "set") {
      raw.push("fillers:set");
    }
    raw.push(command);
    return raw.filter((target) => isKnownTarget(target));
  }
  if (command === "defer" && group === null && sub === "config") {
    raw.push("defer:config");
    return raw.filter((target) => isKnownTarget(target));
  }
  if (command === "post" && group === "sync" && sub === "time") {
    raw.push("sync:time:post");
  } else if (command === "post" && group === "sync" && sub === "status") {
    raw.push("sync:post:status");
  } else if ((command === "sync" || command === "post") && group === "spin" && sub === "status") {
    raw.push("sync:post:status");
  } else if (group && sub) {
    raw.push(`${command}:${group}:${sub}`);
  }
  if (group) {
    raw.push(`${command}:${group}`);
  }
  if (sub) {
    raw.push(`${command}:${sub}`);
  }
  raw.push(command);

  return raw.filter((target) => isKnownTarget(target));
}

export class CommandPermissionService {
  /** Purpose: initialize service dependencies. */
  constructor(private readonly settings = new SettingsService()) {}

  /** Purpose: get fwa leader role id. */
  async getFwaLeaderRoleId(guildId: string): Promise<string | null> {
    const raw = await this.settings.get(fwaLeaderRoleKey(guildId));
    if (!raw || !/^\d+$/.test(raw.trim())) return null;
    return raw.trim();
  }

  /** Purpose: set fwa leader role id. */
  async setFwaLeaderRoleId(guildId: string, roleId: string): Promise<void> {
    await this.settings.set(fwaLeaderRoleKey(guildId), roleId);
  }

  /** Purpose: get allowed role ids. */
  async getAllowedRoleIds(commandName: string): Promise<string[]> {
    const raw = await this.settings.get(commandRolesKey(commandName));
    return parseRoleIds(raw);
  }

  /** Purpose: load legacy, additive, and excluded role policy state. */
  private async getStoredPermissionPolicy(commandName: string): Promise<StoredPermissionPolicy> {
    const [legacyRaw, additionsRaw, exclusionsRaw, restrictiveMarkerRaw] = await Promise.all([
      this.settings.get(commandRolesKey(commandName)),
      this.settings.get(commandRoleAdditionsKey(commandName)),
      this.settings.get(commandRoleExclusionsKey(commandName)),
      this.settings.get(commandRolesRestrictiveMarkerKey(commandName)),
    ]);
    const legacyRoleIds = parseRoleIds(legacyRaw);
    const addedRoleIds = parseRoleIds(additionsRaw);
    const excludedRoleIds = parseRoleIds(exclusionsRaw);
    const hasLegacyRestrictivePolicy =
      Boolean(restrictiveMarkerRaw?.trim()) || legacyRaw !== null;

    return {
      legacyRoleIds,
      addedRoleIds,
      excludedRoleIds,
      hasLegacyRestrictivePolicy,
      hasCustomPolicy:
        hasLegacyRestrictivePolicy || addedRoleIds.length > 0 || excludedRoleIds.length > 0,
    };
  }

  /** Purpose: persist one role-id list while deleting empty additive state. */
  private async persistRoleIdList(key: string, roleIds: string[]): Promise<void> {
    const uniqueRoleIds = [...new Set(roleIds)].filter((roleId) => /^\d+$/.test(roleId));
    if (uniqueRoleIds.length === 0) {
      await this.settings.delete(key);
      return;
    }
    await this.settings.set(key, stringifyRoleIds(uniqueRoleIds));
  }

  /** Purpose: persist a legacy restrictive whitelist without widening its defaults. */
  private async persistLegacyRoleIds(commandName: string, roleIds: string[]): Promise<void> {
    const uniqueRoleIds = [...new Set(roleIds)].filter((roleId) => /^\d+$/.test(roleId));
    if (uniqueRoleIds.length === 0) {
      await this.settings.delete(commandRolesKey(commandName));
      await this.settings.set(commandRolesRestrictiveMarkerKey(commandName), "1");
      return;
    }
    await this.settings.set(commandRolesKey(commandName), stringifyRoleIds(uniqueRoleIds));
  }

  /** Purpose: resolve the first specific policy while retaining additive parent inheritance. */
  async getPermissionPolicy(
    targets: string[] | string,
    _guildId?: string | null,
    options?: { includeKnownParents?: boolean },
  ): Promise<CommandPermissionPolicy> {
    const requestedTarget = typeof targets === "string" ? targets : targets[0] ?? "";
    const requestedTargets =
      options?.includeKnownParents === true
        ? getPermissionManagementTargets(requestedTarget)
        : typeof targets === "string"
          ? [targets]
          : targets;
    const effectiveTargets = getEffectivePermissionTargets(requestedTargets);
    const storedPolicies = await Promise.all(
      effectiveTargets.map((target) => this.getStoredPermissionPolicy(target)),
    );
    const restrictiveIndex = storedPolicies.findIndex(
      (policy) => policy.hasLegacyRestrictivePolicy,
    );
    const fwaDefaultIndex = storedPolicies.findIndex((_, index) =>
      isFwaLeaderDefaultTarget(effectiveTargets[index] ?? ""),
    );
    const adminDefaultIndex = storedPolicies.findIndex((_, index) =>
      isAdminDefaultTarget(effectiveTargets[index] ?? ""),
    );
    const defaultIndex = fwaDefaultIndex >= 0 ? fwaDefaultIndex : adminDefaultIndex;
    const sourceIndex = restrictiveIndex >= 0
      ? restrictiveIndex
      : defaultIndex >= 0
        ? defaultIndex
        : 0;
    const sourceTarget = effectiveTargets[sourceIndex] ?? requestedTargets[0] ?? "";
    const sourcePolicy = storedPolicies[sourceIndex] ?? {
      legacyRoleIds: [],
      addedRoleIds: [],
      excludedRoleIds: [],
      hasLegacyRestrictivePolicy: false,
      hasCustomPolicy: false,
    };
    const includedPolicies = restrictiveIndex >= 0
      ? storedPolicies.slice(0, sourceIndex + 1)
      : storedPolicies;
    const includedLayers = includedPolicies.map((policy, index) => ({
      ...policy,
      target: effectiveTargets[index] ?? "",
    }));
    const addedRoleIds = [
      ...new Set(includedPolicies.flatMap((policy) => policy.addedRoleIds)),
    ];
    const excludedRoleIds = [
      ...new Set(includedPolicies.flatMap((policy) => policy.excludedRoleIds)),
    ];

    return {
      requestedTarget: requestedTarget || sourceTarget,
      sourceTarget,
      inheritedFrom:
        sourceTarget && sourceTarget !== (requestedTarget || sourceTarget)
          ? sourceTarget
          : null,
      defaultKind: restrictiveIndex >= 0
        ? "legacy_restrictive"
        : getPermissionDefaultKind(sourceTarget),
      legacyRoleIds: restrictiveIndex >= 0 ? sourcePolicy.legacyRoleIds : [],
      addedRoleIds,
      excludedRoleIds,
      hasLegacyRestrictivePolicy: restrictiveIndex >= 0,
      hasCustomPolicy: storedPolicies.some((policy) => policy.hasCustomPolicy),
      layers: includedLayers,
    };
  }

  /** Purpose: determine whether a role receives access from a resolved policy. */
  private async roleHasPermission(
    policy: CommandPermissionPolicy,
    roleId: string,
    guildId?: string | null,
  ): Promise<boolean> {
    for (const layer of policy.layers) {
      if (layer.legacyRoleIds.includes(roleId) || layer.addedRoleIds.includes(roleId)) {
        return true;
      }
      if (layer.excludedRoleIds.includes(roleId)) return false;
      if (layer.hasLegacyRestrictivePolicy) return false;
    }
    if (policy.defaultKind === "everyone") return true;
    if (policy.defaultKind !== "fwa_leader" || !guildId) return false;
    const leaderRoleId = await this.getFwaLeaderRoleId(guildId);
    return leaderRoleId === roleId;
  }

  /** Purpose: resolve the concise effective role list used after permission additions. */
  async getEffectiveAllowedRoleSummary(
    commandName: string,
    guildId?: string | null,
  ): Promise<EffectiveAllowedRoleSummary> {
    const policy = await this.getPermissionPolicy(commandName, guildId, {
      includeKnownParents: true,
    });

    if (policy.defaultKind === "everyone") {
      return { everyone: true, roleIds: [] };
    }

    const candidateRoleIds: string[] = [];
    if (policy.defaultKind === "fwa_leader" && guildId) {
      const leaderRoleId = await this.getFwaLeaderRoleId(guildId);
      if (leaderRoleId) candidateRoleIds.push(leaderRoleId);
    }
    candidateRoleIds.push(...policy.legacyRoleIds, ...policy.addedRoleIds);

    const roleIds: string[] = [];
    for (const roleId of [...new Set(candidateRoleIds)]) {
      if (await this.roleHasPermission(policy, roleId, guildId)) {
        roleIds.push(roleId);
      }
    }

    return { everyone: false, roleIds };
  }

  /** Purpose: add one role without replacing defaults or existing grants. */
  async addRoleAccess(
    commandName: string,
    roleId: string,
    guildId?: string | null,
  ): Promise<PermissionRoleMutation> {
    const normalizedRoleId = String(roleId ?? "").trim();
    const stored = await this.getStoredPermissionPolicy(commandName);
    if (!/^\d+$/.test(normalizedRoleId)) {
      return {
        roleId: normalizedRoleId,
        outcome: "no_op",
        policy: await this.getPermissionPolicy(commandName, guildId, {
          includeKnownParents: true,
        }),
      };
    }

    if (stored.excludedRoleIds.includes(normalizedRoleId)) {
      await this.persistRoleIdList(
        commandRoleExclusionsKey(commandName),
        stored.excludedRoleIds.filter((id) => id !== normalizedRoleId),
      );
      if (stored.hasLegacyRestrictivePolicy && !stored.legacyRoleIds.includes(normalizedRoleId)) {
        await this.persistLegacyRoleIds(commandName, [
          ...stored.legacyRoleIds,
          normalizedRoleId,
        ]);
      } else if (!stored.hasLegacyRestrictivePolicy) {
        const restoredPolicy = await this.getPermissionPolicy(commandName, guildId, {
          includeKnownParents: true,
        });
        if (!(await this.roleHasPermission(restoredPolicy, normalizedRoleId, guildId))) {
          await this.persistRoleIdList(commandRoleAdditionsKey(commandName), [
            ...stored.addedRoleIds,
            normalizedRoleId,
          ]);
        }
      }
      return {
        roleId: normalizedRoleId,
        outcome: "restored",
        policy: await this.getPermissionPolicy(commandName, guildId, {
          includeKnownParents: true,
        }),
      };
    }

    if (stored.hasLegacyRestrictivePolicy) {
      if (stored.legacyRoleIds.includes(normalizedRoleId)) {
        return {
          roleId: normalizedRoleId,
          outcome: "already_allowed",
          policy: await this.getPermissionPolicy(commandName, guildId, {
            includeKnownParents: true,
          }),
        };
      }
      await this.persistLegacyRoleIds(commandName, [
        ...stored.legacyRoleIds,
        normalizedRoleId,
      ]);
      return {
        roleId: normalizedRoleId,
        outcome: "added",
        policy: await this.getPermissionPolicy(commandName, guildId, {
          includeKnownParents: true,
        }),
      };
    }

    const policy = await this.getPermissionPolicy(commandName, guildId, {
      includeKnownParents: true,
    });
    if (await this.roleHasPermission(policy, normalizedRoleId, guildId)) {
      return {
        roleId: normalizedRoleId,
        outcome: "already_allowed",
        policy,
      };
    }

    if (stored.addedRoleIds.includes(normalizedRoleId)) {
      return {
        roleId: normalizedRoleId,
        outcome: "already_allowed",
        policy,
      };
    }
    await this.persistRoleIdList(commandRoleAdditionsKey(commandName), [
      ...stored.addedRoleIds,
      normalizedRoleId,
    ]);
    return {
      roleId: normalizedRoleId,
      outcome: "added",
      policy: await this.getPermissionPolicy(commandName, guildId, {
        includeKnownParents: true,
      }),
    };
  }

  /** Purpose: remove one role while preserving defaults, exclusions, and restrictive policy state. */
  async removeRoleAccess(
    commandName: string,
    roleId: string,
    guildId?: string | null,
  ): Promise<PermissionRoleMutation> {
    const normalizedRoleId = String(roleId ?? "").trim();
    const stored = await this.getStoredPermissionPolicy(commandName);
    if (!/^\d+$/.test(normalizedRoleId)) {
      return {
        roleId: normalizedRoleId,
        outcome: "no_op",
        policy: await this.getPermissionPolicy(commandName, guildId, {
          includeKnownParents: true,
        }),
      };
    }
    if (stored.excludedRoleIds.includes(normalizedRoleId)) {
      return {
        roleId: normalizedRoleId,
        outcome: "already_excluded",
        policy: await this.getPermissionPolicy(commandName, guildId, {
          includeKnownParents: true,
        }),
      };
    }

    const hadLegacyGrant = stored.legacyRoleIds.includes(normalizedRoleId);
    const hadAddedGrant = stored.addedRoleIds.includes(normalizedRoleId);
    if (hadLegacyGrant) {
      await this.persistLegacyRoleIds(
        commandName,
        stored.legacyRoleIds.filter((id) => id !== normalizedRoleId),
      );
    }
    if (hadAddedGrant) {
      await this.persistRoleIdList(
        commandRoleAdditionsKey(commandName),
        stored.addedRoleIds.filter((id) => id !== normalizedRoleId),
      );
    }

    if (hadLegacyGrant || hadAddedGrant) {
      const remainingPolicy = await this.getPermissionPolicy(commandName, guildId, {
        includeKnownParents: true,
      });
      if (!hadLegacyGrant && (await this.roleHasPermission(remainingPolicy, normalizedRoleId, guildId))) {
        await this.persistRoleIdList(commandRoleExclusionsKey(commandName), [
          ...stored.excludedRoleIds,
          normalizedRoleId,
        ]);
        return {
          roleId: normalizedRoleId,
          outcome: "excluded",
          policy: await this.getPermissionPolicy(commandName, guildId, {
            includeKnownParents: true,
          }),
        };
      }
      return {
        roleId: normalizedRoleId,
        outcome: "removed",
        policy: remainingPolicy,
      };
    }

    const policy = await this.getPermissionPolicy(commandName, guildId, {
      includeKnownParents: true,
    });
    if (!(await this.roleHasPermission(policy, normalizedRoleId, guildId))) {
      return {
        roleId: normalizedRoleId,
        outcome: "no_op",
        policy,
      };
    }

    await this.persistRoleIdList(commandRoleExclusionsKey(commandName), [
      ...stored.excludedRoleIds,
      normalizedRoleId,
    ]);
    return {
      roleId: normalizedRoleId,
      outcome: "excluded",
      policy: await this.getPermissionPolicy(commandName, guildId, {
        includeKnownParents: true,
      }),
    };
  }

  /** Purpose: set allowed role ids. */
  async setAllowedRoleIds(
    commandName: string,
    roleIds: string[],
  ): Promise<void> {
    const serialized = stringifyRoleIds(roleIds);
    if (!serialized) {
      await this.settings.delete(commandRolesKey(commandName));
      return;
    }
    await this.settings.set(commandRolesKey(commandName), serialized);
  }

  /** Purpose: add allowed role id. */
  async addAllowedRoleId(
    commandName: string,
    roleId: string,
  ): Promise<string[]> {
    const existing = await this.getAllowedRoleIds(commandName);
    const next = [...new Set([...existing, roleId])];
    await this.setAllowedRoleIds(commandName, next);
    return next;
  }

  /** Purpose: remove allowed role id. */
  async removeAllowedRoleId(
    commandName: string,
    roleId: string,
  ): Promise<string[]> {
    const existing = await this.getAllowedRoleIds(commandName);
    const next = existing.filter((id) => id !== roleId);
    await this.setAllowedRoleIds(commandName, next);
    return next;
  }

  /** Purpose: clear allowed roles. */
  async clearAllowedRoles(commandName: string): Promise<void> {
    await this.settings.delete(commandRolesKey(commandName));
  }

  async canUseCommand(
    commandName: string,
    interaction: GuildInteraction,
  ): Promise<boolean> {
    return this.canUseAnyTarget([commandName], interaction);
  }

  async canUseAnyTarget(
    targets: string[],
    interaction: GuildInteraction,
  ): Promise<boolean> {
    if (hasOwnerBypass(interaction)) return true;

    if (targets.length === 0) return true;

    if (!interaction.inGuild()) return true;

    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }

    const policy = await this.getPermissionPolicy(targets, interaction.guildId);
    const userRoles = await getInteractionRoleIds(interaction);
    if (userRoles.length === 0) return policy.defaultKind === "everyone";
    for (const roleId of userRoles) {
      if (await this.roleHasPermission(policy, roleId, interaction.guildId)) return true;
    }
    return false;
  }

  /** Purpose: get policy summary. */
  async getPolicySummary(
    commandName: string,
    guildId?: string | null,
  ): Promise<string> {
    const policy = await this.getPermissionPolicy(commandName, guildId, {
      includeKnownParents: true,
    });
    const lines: string[] = [];
    if (policy.inheritedFrom) {
      lines.push(`Inherited from \`/${policy.inheritedFrom}\`.`);
    }

    if (policy.defaultKind === "legacy_restrictive") {
      lines.push("Effective default: Legacy restrictive whitelist (built-in defaults excluded).");
      lines.push(
        `Explicitly allowed roles: ${formatPermissionRoleIds(policy.legacyRoleIds)}`,
      );
    } else if (policy.defaultKind === "fwa_leader") {
      if (!guildId) {
        lines.push("Effective default: FWA Leader role + Administrator.");
      } else {
        const leaderRoleId = await this.getFwaLeaderRoleId(guildId);
        lines.push(
          leaderRoleId
            ? `Effective default: FWA Leader role <@&${leaderRoleId}> + Administrator.`
            : "Effective default: Administrator only (set /fwa leader-role).",
        );
      }
    } else if (policy.defaultKind === "administrator") {
      lines.push("Effective default: Administrator only.");
    } else {
      lines.push("Effective default: Everyone can use this command.");
    }

    if (policy.addedRoleIds.length > 0) {
      lines.push(`Explicitly added roles: ${formatPermissionRoleIds(policy.addedRoleIds)}`);
    }
    if (policy.excludedRoleIds.length > 0) {
      lines.push(`Excluded roles/defaults: ${formatPermissionRoleIds(policy.excludedRoleIds)}`);
    }
    lines.push("Administrator bypass: always allowed.");
    return lines.join(" ");
  }
}
