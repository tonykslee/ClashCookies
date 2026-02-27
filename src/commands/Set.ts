import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService, SET_COMMAND } from "../services/CommandPermissionService";

export const SetCommand: Command = {
  name: SET_COMMAND,
  description: "Set bot configuration values",
  options: [
    {
      name: "fwa-leader-role",
      description: "Set the default FWA leader role used for leader-only commands",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "role",
          description: "Role to set as the FWA leader role",
          type: ApplicationCommandOptionType.Role,
          required: true,
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

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Only administrators can use this command.",
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand !== "fwa-leader-role") {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown subcommand.",
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

    const permissionService = new CommandPermissionService();
    await permissionService.setFwaLeaderRoleId(interaction.guildId, role.id);

    await safeReply(interaction, {
      ephemeral: true,
      content: `FWA leader role set to <@&${role.id}>.`,
    });
  },
};

