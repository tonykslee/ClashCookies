import {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { SettingsService } from "./SettingsService";

export const MANAGE_COMMAND_ROLES_COMMAND = "permission";
export const FWA_LEADER_ROLE_SETTING_KEY = "fwa_leader_role";

export const COMMAND_PERMISSION_TARGETS = [
  "help",
  "lastseen",
  "inactive",
  "role-users",
  "accounts",
  "war",
  "notify",
  "tracked-clan:add",
  "tracked-clan:remove",
  "tracked-clan:list",
  "sheet:link",
  "sheet:unlink",
  "sheet:show",
  "sheet:refresh",
  "compo:advice",
  "compo:state",
  "compo:place",
  "cc:player",
  "cc:clan",
  "notify:war",
  "fwa:points",
  "fwa:match",
  "fwa:leader-role",
  "recruitment:show",
  "recruitment:edit",
  "recruitment:dashboard",
  "recruitment:countdown:start",
  "recruitment:countdown:status",
  "kick-list:build",
  "kick-list:add",
  "kick-list:remove",
  "kick-list:show",
  "kick-list:clear",
  "post",
  "sync:time:post",
  "sync:post:status",
  `${MANAGE_COMMAND_ROLES_COMMAND}:add`,
  `${MANAGE_COMMAND_ROLES_COMMAND}:remove`,
  `${MANAGE_COMMAND_ROLES_COMMAND}:list`,
] as const;

export type CommandPermissionTarget = (typeof COMMAND_PERMISSION_TARGETS)[number];

type GuildInteraction = ChatInputCommandInteraction | ModalSubmitInteraction;

const ADMIN_DEFAULT_TARGETS = new Set<string>([
  "tracked-clan:add",
  "tracked-clan:remove",
  "sheet:link",
  "sheet:unlink",
  "sheet:show",
  "kick-list:clear",
  "notify:war",
  "fwa:leader-role",
  `${MANAGE_COMMAND_ROLES_COMMAND}:add`,
  `${MANAGE_COMMAND_ROLES_COMMAND}:remove`,
]);

const FWA_LEADER_DEFAULT_TARGETS = new Set<string>([
  "tracked-clan:list",
  "sheet:refresh",
  "compo:advice",
  "compo:state",
  "compo:place",
  "fwa:points",
  "fwa:match",
  "recruitment:show",
  "recruitment:edit",
  "recruitment:dashboard",
  "recruitment:countdown:start",
  "recruitment:countdown:status",
  "kick-list:build",
  "kick-list:add",
  "kick-list:remove",
  "kick-list:show",
  "sync:time:post",
  "sync:post:status",
  "inactive",
]);

/** Purpose: command roles key. */
function commandRolesKey(commandName: string): string {
  return `command_roles:${commandName}`;
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
async function getInteractionRoleIds(interaction: GuildInteraction): Promise<string[]> {
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

export function getPermissionTargetPrefixesForCommand(commandName: string): string[] {
  return [commandName];
}

export function hasPermissionTargetForCommand(commandName: string): boolean {
  const prefixes = getPermissionTargetPrefixesForCommand(commandName);
  return COMMAND_PERMISSION_TARGETS.some((target) =>
    prefixes.some((prefix) => target === prefix || target.startsWith(`${prefix}:`))
  );
}

/** Purpose: get owner bypass ids. */
function getOwnerBypassIds(): Set<string> {
  const raw = process.env.OWNER_DISCORD_USER_IDS ?? process.env.OWNER_DISCORD_USER_ID;
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
  interaction: ChatInputCommandInteraction
): string[] {
  const command = interaction.commandName;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);

  const raw: string[] = [];
  if (command === "post" && group === "sync" && sub === "time") {
    raw.push("sync:time:post");
  } else if (command === "post" && group === "sync" && sub === "status") {
    raw.push("sync:post:status");
  } else if (group && sub) {
    raw.push(`${command}:${group}:${sub}`);
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

  /** Purpose: set allowed role ids. */
  async setAllowedRoleIds(commandName: string, roleIds: string[]): Promise<void> {
    const serialized = stringifyRoleIds(roleIds);
    if (!serialized) {
      await this.settings.delete(commandRolesKey(commandName));
      return;
    }
    await this.settings.set(commandRolesKey(commandName), serialized);
  }

  /** Purpose: add allowed role id. */
  async addAllowedRoleId(commandName: string, roleId: string): Promise<string[]> {
    const existing = await this.getAllowedRoleIds(commandName);
    const next = [...new Set([...existing, roleId])];
    await this.setAllowedRoleIds(commandName, next);
    return next;
  }

  /** Purpose: remove allowed role id. */
  async removeAllowedRoleId(commandName: string, roleId: string): Promise<string[]> {
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
    interaction: GuildInteraction
  ): Promise<boolean> {
    if (hasOwnerBypass(interaction)) return true;

    if (!interaction.inGuild()) return true;

    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }

    const allowedRoles = await this.getAllowedRoleIds(commandName);
    if (allowedRoles.length === 0) {
      if (isFwaLeaderDefaultTarget(commandName)) {
        const guildId = interaction.guildId;
        if (!guildId) return false;
        const leaderRoleId = await this.getFwaLeaderRoleId(guildId);
        if (!leaderRoleId) return false;
        const userRoles = await getInteractionRoleIds(interaction);
        return userRoles.includes(leaderRoleId);
      }
      return isAdminDefaultTarget(commandName) ? false : true;
    }

    const userRoles = await getInteractionRoleIds(interaction);
    return allowedRoles.some((id) => userRoles.includes(id));
  }

  async canUseAnyTarget(
    targets: string[],
    interaction: GuildInteraction
  ): Promise<boolean> {
    if (hasOwnerBypass(interaction)) return true;

    if (targets.length === 0) return true;

    if (!interaction.inGuild()) return true;

    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }

    // First, find the most-specific explicit whitelist and enforce it.
    for (const target of targets) {
      const allowedRoles = await this.getAllowedRoleIds(target);
      if (allowedRoles.length > 0) {
        const userRoles = await getInteractionRoleIds(interaction);
        return allowedRoles.some((id) => userRoles.includes(id));
      }
    }

    // If no explicit whitelist is set, enforce first matching admin-default target.
    const userRoles = await getInteractionRoleIds(interaction);
    for (const target of targets) {
      if (isFwaLeaderDefaultTarget(target)) {
        const guildId = interaction.guildId;
        if (!guildId) return false;
        const leaderRoleId = await this.getFwaLeaderRoleId(guildId);
        if (!leaderRoleId) return false;
        return userRoles.includes(leaderRoleId);
      }
    }

    // If no explicit whitelist is set, enforce first matching admin-default target.
    for (const target of targets) {
      if (isAdminDefaultTarget(target)) {
        return false;
      }
    }

    return true;
  }

  /** Purpose: get policy summary. */
  async getPolicySummary(commandName: string, guildId?: string | null): Promise<string> {
    const roles = await this.getAllowedRoleIds(commandName);
    if (roles.length === 0) {
      if (isFwaLeaderDefaultTarget(commandName)) {
        if (!guildId) return "Default: FWA Leader role + Administrator.";
        const leaderRoleId = await this.getFwaLeaderRoleId(guildId);
        if (!leaderRoleId) {
          return "Default: Administrator only (set /fwa leader-role).";
        }
        return `Default: FWA Leader role <@&${leaderRoleId}> + Administrator.`;
      }
      return isAdminDefaultTarget(commandName)
        ? "Default: Administrator only."
        : "Default: Everyone can use this command.";
    }
    return `Allowed roles: ${roles.map((id) => `<@&${id}>`).join(", ")}`;
  }
}
