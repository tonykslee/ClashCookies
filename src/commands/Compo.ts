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
  SheetRgbColor,
  GoogleSheetsService,
} from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

const COMPO_MODE_CHOICES = [
  { name: "Actual Roster", value: "actual" },
  { name: "War Roster", value: "war" },
];

function readMode(interaction: ChatInputCommandInteraction): GoogleSheetMode {
  const rawMode = interaction.options.getString("mode", false);
  return rawMode === "war" ? "war" : "actual";
}

function clampCell(value: string): string {
  const sanitized = value.replace(/\s+/g, " ").trim();
  return sanitized.length > 28 ? `${sanitized.slice(0, 25)}...` : sanitized;
}

function colorSwatch(color: SheetRgbColor | null): string {
  if (!color) return "⬜";
  const r = Math.round(color.red * 255);
  const g = Math.round(color.green * 255);
  const b = Math.round(color.blue * 255);

  if (r > 225 && g > 225 && b > 225) return "⬜";
  if (r > 200 && g < 110 && b < 110) return "🟥";
  if (r > 215 && g > 160 && b < 110) return "🟧";
  if (r > 210 && g > 200 && b < 120) return "🟨";
  if (g > 170 && r < 140 && b < 140) return "🟩";
  if (b > 180 && r < 150 && g < 180) return "🟦";
  if (r > 150 && b > 150 && g < 130) return "🟪";
  return "⬛";
}

function renderGridSection(title: string, rows: Array<Array<{ value: string; backgroundColor: SheetRgbColor | null }>>): string {
  const lines: string[] = [];
  lines.push(`**${title}**`);

  for (let i = 0; i < rows.length; i += 1) {
    const rowNumber = String(i + 1).padStart(2, "0");
    const formattedCells = rows[i].map((cell) => {
      const value = clampCell(cell.value || "-");
      return `${colorSwatch(cell.backgroundColor)} ${value}`;
    });
    lines.push(`${rowNumber}. ${formattedCells.join(" | ")}`);
  }

  return lines.join("\n");
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
          choices: COMPO_MODE_CHOICES,
        },
      ],
    },
    {
      name: "state",
      description: "Show AllianceDashboard state blocks with color indicators",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "mode",
          description: "Use the actual or war roster sheet link",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: COMPO_MODE_CHOICES,
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
      const mode = readMode(interaction);

      if (subcommand === "advice") {
        const clanInput = interaction.options.getString("clan", true);
        const targetClan = normalize(clanInput);

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
                  ? `Mode: **${mode.toUpperCase()}**\n**${clanName}** adjustment:\n${advice}`
                  : `Mode: **${mode.toUpperCase()}**\nFound **${clanName}**, but there is no advice text in AllianceDashboard!F13:F20.`,
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
              ? `Mode: **${mode.toUpperCase()}**\nNo advice mapping found for "${clanInput}". Known clans: ${knownClans.join(", ")}`
              : `Mode: **${mode.toUpperCase()}**\nNo advice mapping found for "${clanInput}".`,
        });
        return;
      }

      if (subcommand === "state") {
        const settings = new SettingsService();
        const sheets = new GoogleSheetsService(settings);

        const [leftBlock, middleBlock, rightBlock] = await Promise.all([
          sheets.readLinkedFormattedGrid("AllianceDashboard!A1:A9", mode),
          sheets.readLinkedFormattedGrid("AllianceDashboard!D1:E9", mode),
          sheets.readLinkedFormattedGrid("AllianceDashboard!U1:AA9", mode),
        ]);

        const content = [
          `Mode Displayed: **${mode.toUpperCase()}**`,
          "",
          renderGridSection("AllianceDashboard!A1:A9", leftBlock),
          "",
          renderGridSection("AllianceDashboard!D1:E9", middleBlock),
          "",
          renderGridSection("AllianceDashboard!U1:AA9", rightBlock),
          "",
          "Color key: sheet-like swatches are approximated via emoji.",
        ].join("\n");

        await safeReply(interaction, {
          ephemeral: true,
          content,
        });
        return;
      }

      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown subcommand.",
      });
      return;
    } catch (err) {
      console.error(`compo command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content:
          "Failed to read compo sheet data. Check linked sheet access for the selected mode and AllianceDashboard layout.",
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
