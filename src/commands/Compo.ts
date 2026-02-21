import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  GoogleSheetMode,
  GoogleSheetsService,
} from "../services/GoogleSheetsService";
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
          description: "Tracked clan name",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "mode",
          description: "Use the actual or war roster sheet link",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "Actual Roster", value: "actual" },
            { name: "War Roster", value: "war" },
          ],
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
      const rawMode = interaction.options.getString("mode", false);
      const mode: GoogleSheetMode = rawMode === "war" ? "war" : "actual";

      const settings = new SettingsService();
      const sheets = new GoogleSheetsService(settings);
      const rows = await sheets.readLinkedValues("AllianceDashboard!A13:F20", mode);

      if (rows.length === 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "No rows found in AllianceDashboard!A13:F20.",
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
            content:
              advice && advice.length > 0
                ? `**${clanName}** adjustment:\n${advice}`
                : `Found **${clanName}**, but there is no advice text in AllianceDashboard!F13:F20.`,
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
          "Failed to get compo advice. Check linked sheet access for the selected mode and AllianceDashboard A13:A20 + F13:F20 layout.",
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const query = normalize(String(focused.value ?? ""));
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const names = tracked
      .map((c) => c.name?.trim() || c.tag.trim())
      .filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

    const filtered = names
      .filter((name) => normalize(name).includes(query))
      .slice(0, 25)
      .map((name) => ({ name, value: name }));

    await interaction.respond(filtered);
  },
};
