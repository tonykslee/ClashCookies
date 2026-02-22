import {
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { SettingsService } from "./SettingsService";

export const MANAGE_COMMAND_ROLES_COMMAND = "permission";

export const COMMAND_PERMISSION_TARGETS = [
  "help",
  "clan-name",
  "lastseen",
  "inactive",
  "role-users",
  "tracked-clan",
  "tracked-clan:add",
  "tracked-clan:remove",
  "tracked-clan:list",
  "sheet",
  "sheet:link",
  "sheet:unlink",
  "sheet:show",
  "compo",
  "compo:advice",
  "compo:state",
  "post",
  "post:sync:time",
  MANAGE_COMMAND_ROLES_COMMAND,
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
  "post:sync:time",
  `${MANAGE_COMMAND_ROLES_COMMAND}:add`,
  `${MANAGE_COMMAND_ROLES_COMMAND}:remove`,
]);

function commandRolesKey(commandName: string): string {
  return `command_roles:${commandName}`;
}

function parseRoleIds(input: string | null): string[] {
  if (!input) return [];
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
  return [...new Set(parts)];
}

function stringifyRoleIds(roleIds: string[]): string {
  return [...new Set(roleIds)].join(",");
}

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

function isAdminDefaultTarget(target: string): boolean {
  return ADMIN_DEFAULT_TARGETS.has(target);
}

function isKnownTarget(target: string): target is CommandPermissionTarget {
  return (COMMAND_PERMISSION_TARGETS as readonly string[]).includes(target);
}

export function getCommandTargetsFromInteraction(
  interaction: ChatInputCommandInteraction
): string[] {
  const command = interaction.commandName;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);

  const raw: string[] = [];
  if (group && sub) {
    raw.push(`${command}:${group}:${sub}`);
  }
  if (sub) {
    raw.push(`${command}:${sub}`);
  }
  raw.push(command);

  return raw.filter((target) => isKnownTarget(target));
}

export class CommandPermissionService {
  constructor(private readonly settings = new SettingsService()) {}

  async getAllowedRoleIds(commandName: string): Promise<string[]> {
    const raw = await this.settings.get(commandRolesKey(commandName));
    return parseRoleIds(raw);
  }

  async setAllowedRoleIds(commandName: string, roleIds: string[]): Promise<void> {
    const serialized = stringifyRoleIds(roleIds);
    if (!serialized) {
      await this.settings.delete(commandRolesKey(commandName));
      return;
    }
    await this.settings.set(commandRolesKey(commandName), serialized);
  }

  async addAllowedRoleId(commandName: string, roleId: string): Promise<string[]> {
    const existing = await this.getAllowedRoleIds(commandName);
    const next = [...new Set([...existing, roleId])];
    await this.setAllowedRoleIds(commandName, next);
    return next;
  }

  async removeAllowedRoleId(commandName: string, roleId: string): Promise<string[]> {
    const existing = await this.getAllowedRoleIds(commandName);
    const next = existing.filter((id) => id !== roleId);
    await this.setAllowedRoleIds(commandName, next);
    return next;
  }

  async clearAllowedRoles(commandName: string): Promise<void> {
    await this.settings.delete(commandRolesKey(commandName));
  }

  async canUseCommand(
    commandName: string,
    interaction: GuildInteraction
  ): Promise<boolean> {
    if (!interaction.inGuild()) return true;

    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return true;
    }

    const allowedRoles = await this.getAllowedRoleIds(commandName);
    if (allowedRoles.length === 0) {
      return isAdminDefaultTarget(commandName) ? false : true;
    }

    const userRoles = await getInteractionRoleIds(interaction);
    return allowedRoles.some((id) => userRoles.includes(id));
  }

  async canUseAnyTarget(
    targets: string[],
    interaction: GuildInteraction
  ): Promise<boolean> {
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
    for (const target of targets) {
      if (isAdminDefaultTarget(target)) {
        return false;
      }
    }

    return true;
  }

  async getPolicySummary(commandName: string): Promise<string> {
    const roles = await this.getAllowedRoleIds(commandName);
    if (roles.length === 0) {
      return isAdminDefaultTarget(commandName)
        ? "Default: Administrator only."
        : "Default: Everyone can use this command.";
    }
    return `Allowed roles: ${roles.map((id) => `<@&${id}>`).join(", ")}`;
  }
}
