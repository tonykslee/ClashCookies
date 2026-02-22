import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  COMMAND_PERMISSION_TARGETS,
  CommandPermissionService,
  MANAGE_COMMAND_ROLES_COMMAND,
} from "../services/CommandPermissionService";

const COMMAND_CHOICES = COMMAND_PERMISSION_TARGETS.map((name) => ({
  name,
  value: name,
}));

function isPermissionTarget(value: string): value is (typeof COMMAND_PERMISSION_TARGETS)[number] {
  return (COMMAND_PERMISSION_TARGETS as readonly string[]).includes(value);
}

function formatRoleList(roleIds: string[]): string {
  if (roleIds.length === 0) return "(none)";
  return roleIds.map((id) => `<@&${id}>`).join(", ");
}

export const CommandRole: Command = {
  name: MANAGE_COMMAND_ROLES_COMMAND,
  description: "Set which roles can use each command",
  options: [
    {
      name: "add",
      description: "Allow a role to use a command",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "command",
          description: "Command to restrict",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: COMMAND_CHOICES,
        },
        {
          name: "role",
          description: "Role to allow",
          type: ApplicationCommandOptionType.Role,
          required: true,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove a role from a command whitelist",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "command",
          description: "Command to update",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: COMMAND_CHOICES,
        },
        {
          name: "role",
          description: "Role to remove",
          type: ApplicationCommandOptionType.Role,
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "List roles whitelisted for one command",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "command",
          description: "Command to inspect",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: COMMAND_CHOICES,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    if (!interaction.inGuild()) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const permissionService = new CommandPermissionService();
    const subcommand = interaction.options.getSubcommand(true);

    const commandInput = interaction.options.getString("command", true);
    if (!isPermissionTarget(commandInput)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown command target.",
      });
      return;
    }

    if (subcommand === "list") {
      const roleIds = await permissionService.getAllowedRoleIds(commandInput);
      const summary =
        roleIds.length === 0
          ? "No whitelisted roles. Default access applies."
          : `Whitelisted roles: ${formatRoleList(roleIds)}`;
      await safeReply(interaction, {
        ephemeral: true,
        content: `\`/${commandInput}\` roles:\n${summary}`,
      });
      return;
    }

    const role = interaction.options.getRole("role", true);
    if (!("id" in role)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Invalid role selected.",
      });
      return;
    }

    if (subcommand === "add") {
      const next = await permissionService.addAllowedRoleId(commandInput, role.id);
      await safeReply(interaction, {
        ephemeral: true,
        content:
          `Added <@&${role.id}> to \`/${commandInput}\`.\n` +
          `Allowed roles: ${formatRoleList(next)}`,
      });
      return;
    }

    if (subcommand === "remove") {
      const next = await permissionService.removeAllowedRoleId(commandInput, role.id);
      const summary = next.length
        ? `Allowed roles: ${formatRoleList(next)}`
        : await permissionService.getPolicySummary(commandInput);
      await safeReply(interaction, {
        ephemeral: true,
        content:
          `Removed <@&${role.id}> from \`/${commandInput}\`.\n` +
          summary,
      });
      return;
    }

    await safeReply(interaction, {
      ephemeral: true,
      content: "Unknown subcommand.",
    });
  },
};
