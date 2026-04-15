import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import {
  getDumpLinkForGuild,
  normalizeDumpLink,
  upsertDumpLinkForGuild,
} from "../services/DumpLinkService";

function formatDumpLink(link: string): string {
  return `<${link}>`;
}

export const Dump: Command = {
  name: "dump",
  description: "Show or update the stored dump link",
  options: [
    {
      name: "edit",
      description: "Update the stored dump link",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
  ) => {
    if (!interaction.inGuild() || !interaction.guildId) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    const edit = interaction.options.getString("edit", false)?.trim() ?? "";
    if (edit) {
      const isAdmin = interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      );
      if (!isAdmin) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "not_allowed: only admins can edit the dump link.",
        });
        return;
      }

      const normalizedLink = normalizeDumpLink(edit);
      if (!normalizedLink) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Invalid URL. Provide a valid http or https link.",
        });
        return;
      }

      const record = await upsertDumpLinkForGuild({
        guildId: interaction.guildId,
        link: normalizedLink,
        updatedByDiscordUserId: interaction.user.id,
      });

      await safeReply(interaction, {
        ephemeral: true,
        content: formatDumpLink(record.link),
      });
      return;
    }

    const record = await getDumpLinkForGuild(interaction.guildId);
    if (!record) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "No dump link configured for this server.",
      });
      return;
    }

    await safeReply(interaction, {
      ephemeral: true,
      content: formatDumpLink(record.link),
    });
  },
};
