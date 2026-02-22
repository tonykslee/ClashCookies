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
  "sheet",
  "compo",
  "post",
  MANAGE_COMMAND_ROLES_COMMAND,
] as const;

export type CommandPermissionTarget = (typeof COMMAND_PERMISSION_TARGETS)[number];

type GuildInteraction = ChatInputCommandInteraction | ModalSubmitInteraction;

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
      return commandName === MANAGE_COMMAND_ROLES_COMMAND ? false : true;
    }

    const userRoles = await getInteractionRoleIds(interaction);
    return allowedRoles.some((id) => userRoles.includes(id));
  }

  async getPolicySummary(commandName: string): Promise<string> {
    const roles = await this.getAllowedRoleIds(commandName);
    if (roles.length === 0) {
      return commandName === MANAGE_COMMAND_ROLES_COMMAND
        ? "Default: Administrator only."
        : "Default: Everyone can use this command.";
    }
    return `Allowed roles: ${roles.map((id) => `<@&${id}>`).join(", ")}`;
  }
}
