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
  const normalizedLabelMap: Record<string, string> = {
    "missing weights": "Missing",
    "th18-delta": "TH18",
    "th17-delta": "TH17",
    "th16-delta": "TH16",
    "th15-delta": "TH15",
    "th14-delta": "TH14",
    "<=th13-delta": "<=TH13",
  };
  const normalizedLabel =
    normalizedLabelMap[sanitized.toLowerCase()] ?? sanitized;
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
    const targetBandValue = (targetBand[i] ?? [""])[0] ?? "";

    out.push([
      abbreviateClan((left[i] ?? [""])[0] ?? ""),
      (middle[i] ?? ["", ""])[0] ?? "",
      targetBandValue,
      ...rightRow,
    ]);
  }
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderStateSvg(mode: GoogleSheetMode, rows: string[][]): string {
  const tableRows = rows.length > 0 ? rows : [["(no data)"]];
  const colCount = Math.max(...tableRows.map((row) => row.length), 1);
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.min(
      24,
      Math.max(4, ...tableRows.map((row) => (row[col] ?? "").length))
    )
  );

  const fontSize = 22;
  const charWidth = 12;
  const rowHeight = 46;
  const cellPadding = 14;
  const titleHeight = 64;
  const margin = 24;

  const colPixelWidths = widths.map((w) => w * charWidth + cellPadding * 2);
  const tableWidth = colPixelWidths.reduce((a, b) => a + b, 0);
  const width = margin * 2 + tableWidth;
  const height = margin * 2 + titleHeight + tableRows.length * rowHeight;

  const xStarts: number[] = [];
  let x = margin;
  for (const w of colPixelWidths) {
    xStarts.push(x);
    x += w;
  }

  let svg = "";
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect x="0" y="0" width="${width}" height="${height}" fill="#101427"/>`;
  svg += `<text x="${margin}" y="${margin + 30}" fill="#e8edf8" font-family="Courier New, monospace" font-size="26" font-weight="700">Alliance State (${mode.toUpperCase()})</text>`;

  for (let r = 0; r < tableRows.length; r += 1) {
    const y = margin + titleHeight + r * rowHeight;
    const rowFill = r % 2 === 0 ? "#171d34" : "#131a2f";
    svg += `<rect x="${margin}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${rowFill}"/>`;

    for (let c = 0; c < colCount; c += 1) {
      const cx = xStarts[c];
      const text = escapeXml((tableRows[r][c] ?? "").slice(0, widths[c]));
      const textY = y + Math.floor(rowHeight / 2) + 8;
      const fill = r === 0 ? "#9ec2ff" : "#f0f4ff";
      svg += `<text x="${cx + cellPadding}" y="${textY}" fill="${fill}" font-family="Courier New, monospace" font-size="${fontSize}" font-weight="${r === 0 ? "700" : "500"}">${text}</text>`;
    }
  }

  for (let i = 0; i <= colCount; i += 1) {
    const lineX = i === colCount ? margin + tableWidth : xStarts[i];
    svg += `<line x1="${lineX}" y1="${margin + titleHeight}" x2="${lineX}" y2="${margin + titleHeight + tableRows.length * rowHeight}" stroke="#2a3558" stroke-width="1"/>`;
  }
  for (let i = 0; i <= tableRows.length; i += 1) {
    const lineY = margin + titleHeight + i * rowHeight;
    svg += `<line x1="${margin}" y1="${lineY}" x2="${margin + tableWidth}" y2="${lineY}" stroke="#2a3558" stroke-width="1"/>`;
  }

  svg += `</svg>`;
  return svg;
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
        ].join("\n");
        const svg = renderStateSvg(mode, mergedRows);

        await interaction.editReply({
          content,
          files: [
            {
              attachment: Buffer.from(svg, "utf8"),
              name: `compo-state-${mode}.svg`,
            },
          ],
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
