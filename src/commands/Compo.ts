import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import { GoogleSheetsService } from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export const Compo: Command = {
  name: "compo",
  description: "Composition tools",
  options: [
    {
      name: "advice",
      description: "Get adjustment advice for a tracked clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked clan name (as listed in your sheet A13:A20)",
          type: ApplicationCommandOptionType.String,
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
    try {
      await interaction.deferReply({ ephemeral: true });

      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand !== "advice") {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Unknown subcommand.",
        });
        return;
      }

      const clanInput = interaction.options.getString("clan", true);
      const targetClan = normalize(clanInput);

      const settings = new SettingsService();
      const sheets = new GoogleSheetsService(settings);
      const linked = await sheets.getLinkedSheet();
      const range = linked.tabName ? `${linked.tabName}!A13:F20` : "A13:F20";
      const rows = await sheets.readLinkedValues(range);

      if (rows.length === 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content:
            "No rows found in A13:F20. Verify your sheet tab and that clan names are in A13:A20.",
        });
        return;
      }

      for (const row of rows) {
        const clanName = row[0]?.trim();
        const advice = row[5]?.trim();
        if (!clanName) continue;

        if (normalize(clanName) === targetClan) {
          await safeReply(interaction, {
            ephemeral: true,
            content: advice && advice.length > 0
              ? `**${clanName}** adjustment:\n${advice}`
              : `Found **${clanName}**, but there is no advice text in column F.`,
          });
          return;
        }
      }

      const knownClans = rows
        .map((row) => row[0]?.trim())
        .filter((name): name is string => Boolean(name));

      await safeReply(interaction, {
        ephemeral: true,
        content:
          knownClans.length > 0
            ? `No advice mapping found for "${clanInput}". Known clans: ${knownClans.join(", ")}`
            : `No advice mapping found for "${clanInput}".`,
      });
    } catch (err) {
      console.error(`compo command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content:
          "Failed to get compo advice. Check linked sheet access and A13:F20 layout.",
      });
    }
  },
};
