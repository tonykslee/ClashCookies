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
import { GoogleSheetMode, GoogleSheetsService } from "../services/GoogleSheetsService";
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
  const normalizedLabel =
    sanitized.toLowerCase() === "missing weights" ? "Missing" : sanitized;
  return normalizedLabel.length > 32
    ? `${normalizedLabel.slice(0, 29)}...`
    : normalizedLabel;
}

function abbreviateClan(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/["'`]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .replace(/TM/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const map: Record<string, string> = {
    "RISING DAWN": "RD",
    "ZERO GRAVITY": "ZG",
    "DARK EMPIRE": "DE",
    "STEEL EMPIRE 2": "SE",
    "THEWISECOWBOYS": "TWC",
    MARVELS: "MV",
    "ROCKY ROAD": "RR",
    AKATSUKI: "AK",
  };

  return map[normalized] ?? value;
}

function padRows(rows: string[][], rowCount: number, colCount: number): string[][] {
  const padded: string[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const source = rows[r] ?? [];
    const normalized: string[] = [];
    for (let c = 0; c < colCount; c += 1) {
      normalized.push(clampCell(source[c] ?? ""));
    }
    padded.push(normalized);
  }
  return padded;
}

function mergeStateRows(
  left: string[][],
  middle: string[][],
  right: string[][],
  targetBand: string[][]
): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < 9; i += 1) {
    const rightRow = right[i] ?? ["", "", "", "", "", "", ""];
    const beforeTargetBand = rightRow.slice(0, 2);
    const afterTargetBand = rightRow.slice(2);
    const targetBandValue = (targetBand[i] ?? [""])[0] ?? "";

    out.push([
      abbreviateClan((left[i] ?? [""])[0] ?? ""),
      (middle[i] ?? ["", ""])[0] ?? "",
      ...beforeTargetBand,
      targetBandValue,
      ...afterTargetBand,
    ]);
  }
  return out;
}

function renderPlainTable(title: string, rows: string[][]): string {
  if (rows.length === 0) {
    return `**${title}**\n\`\`\`\n(no data)\n\`\`\``;
  }

  const colCount = Math.max(...rows.map((row) => row.length), 1);
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.max(1, ...rows.map((row) => (row[col] ?? "").length))
  );

  const divider = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;
  const body = rows
    .map(
      (row) =>
        `| ${widths.map((w, col) => (row[col] ?? "").padEnd(w, " ")).join(" | ")} |`
    )
    .join("\n");

  return `**${title}**\n\`\`\`\n${divider}\n${body}\n${divider}\n\`\`\``;
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
      description: "Show AllianceDashboard state blocks",
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

        const [leftBlock, middleBlock, rightBlock, targetBandBlock] = await Promise.all([
          sheets.readLinkedValues("AllianceDashboard!A1:A9", mode),
          sheets.readLinkedValues("AllianceDashboard!D1:E9", mode),
          sheets.readLinkedValues("AllianceDashboard!U1:AA9", mode),
          sheets.readLinkedValues("AllianceDashboard!AW1:AW9", mode),
        ]);

        const mergedRows = mergeStateRows(
          padRows(leftBlock, 9, 1),
          padRows(middleBlock, 9, 2),
          padRows(rightBlock, 9, 7),
          padRows(targetBandBlock, 9, 1)
        );

        const content = [
          `Mode Displayed: **${mode.toUpperCase()}**`,
          "",
          renderPlainTable("AllianceDashboard!A1:A9 + D1 + U1:AA9 + AW1:AW9", mergedRows),
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
