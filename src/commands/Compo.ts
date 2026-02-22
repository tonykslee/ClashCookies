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

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const digits = value.replace(/[^0-9-]/g, "");
  if (!digits || digits === "-") return 0;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseWeightInput(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const compact = trimmed.replace(/,/g, "");
  const kMatch = compact.match(/^(\d+(?:\.\d+)?)k$/);
  if (kMatch) {
    const base = Number(kMatch[1]);
    if (!Number.isFinite(base)) return null;
    return Math.round(base * 1000);
  }

  const numeric = Number(compact);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
}

type WeightBucket = "TH18" | "TH17" | "TH16" | "TH15" | "TH14" | "<=TH13";

function getWeightBucket(weight: number): WeightBucket | null {
  if (weight >= 171000 && weight <= 180000) return "TH18";
  if (weight >= 161000 && weight <= 170000) return "TH17";
  if (weight >= 151000 && weight <= 160000) return "TH16";
  if (weight >= 141000 && weight <= 150000) return "TH15";
  if (weight >= 131000 && weight <= 140000) return "TH14";
  if (weight >= 121000 && weight <= 130000) return "<=TH13";
  return null;
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

type PlacementCandidate = {
  clanName: string;
  totalWeight: number;
  targetBand: number;
  missingCount: number;
  remainingToTarget: number;
  bucketDeltaByHeader: Record<string, number>;
};

function readPlacementCandidates(
  clanCol: string[][],
  totalCol: string[][],
  targetBandCol: string[][],
  rightBlock: string[][]
): PlacementCandidate[] {
  const missingHeaderRow = rightBlock[0] ?? [];
  const missingIndex = missingHeaderRow.findIndex((v) =>
    normalize(v).includes("missing")
  );

  const candidates: PlacementCandidate[] = [];
  for (let i = 1; i < 9; i += 1) {
    const clanName = (clanCol[i]?.[0] ?? "").trim();
    if (!clanName) continue;

    const totalWeight = parseNumber(totalCol[i]?.[0]);
    const targetBand = parseNumber(targetBandCol[i]?.[0]);
    const missingRaw =
      missingIndex >= 0 ? rightBlock[i]?.[missingIndex] : rightBlock[i]?.[0];
    const missingCount = parseNumber(missingRaw);
    const remainingToTarget = targetBand - totalWeight;
    const bucketDeltaByHeader: Record<string, number> = {};
    for (let c = 0; c < missingHeaderRow.length; c += 1) {
      const key = normalize(missingHeaderRow[c] ?? "");
      if (!key) continue;
      bucketDeltaByHeader[key] = parseNumber(rightBlock[i]?.[c]);
    }

    candidates.push({
      clanName,
      totalWeight,
      targetBand,
      missingCount,
      remainingToTarget,
      bucketDeltaByHeader,
    });
  }

  return candidates;
}

const GLYPHS: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00110", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
  "<": ["00010", "00100", "01000", "10000", "01000", "00100", "00010"],
  "=": ["00000", "11111", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
};

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function renderStatePng(mode: GoogleSheetMode, rows: string[][]): Buffer {
  const { PNG } = require("pngjs");
  const tableRows = rows.length > 0 ? rows : [["(NO DATA)"]];
  const colCount = Math.max(...tableRows.map((row) => row.length), 1);
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.min(24, Math.max(4, ...tableRows.map((row) => (row[col] ?? "").length)))
  );

  const scale = 3;
  const glyphW = 5 * scale;
  const glyphH = 7 * scale;
  const glyphGap = scale;
  const charPx = glyphW + glyphGap;
  const cellPadX = 12;
  const rowHeight = glyphH + 18;
  const titleHeight = glyphH + 26;
  const margin = 20;

  const colPixelWidths = widths.map((w) => w * charPx + cellPadX * 2);
  const tableWidth = colPixelWidths.reduce((a, b) => a + b, 0);
  const width = margin * 2 + tableWidth;
  const height = margin * 2 + titleHeight + tableRows.length * rowHeight;
  const png = new PNG({ width, height });

  const setPixel = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = (width * y + x) * 4;
    png.data[idx] = rgb[0];
    png.data[idx + 1] = rgb[1];
    png.data[idx + 2] = rgb[2];
    png.data[idx + 3] = 255;
  };
  const fillRect = (x: number, y: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) {
        setPixel(xx, yy, rgb);
      }
    }
  };
  const drawChar = (x: number, y: number, ch: string, rgb: [number, number, number]) => {
    const glyph = GLYPHS[ch] ?? GLYPHS["?"];
    for (let gy = 0; gy < glyph.length; gy += 1) {
      for (let gx = 0; gx < glyph[gy].length; gx += 1) {
        if (glyph[gy][gx] !== "1") continue;
        fillRect(x + gx * scale, y + gy * scale, scale, scale, rgb);
      }
    }
  };
  const drawText = (x: number, y: number, text: string, rgb: [number, number, number]) => {
    const upper = text.toUpperCase();
    for (let i = 0; i < upper.length; i += 1) {
      drawChar(x + i * charPx, y, upper[i], rgb);
    }
  };

  const bg = hexToRgb("#101427");
  const rowA = hexToRgb("#171d34");
  const rowB = hexToRgb("#131a2f");
  const grid = hexToRgb("#2a3558");
  const text = hexToRgb("#f0f4ff");
  const title = hexToRgb("#9ec2ff");
  fillRect(0, 0, width, height, bg);
  drawText(margin, margin + 2, `ALLIANCE STATE (${mode})`, title);

  const xStarts: number[] = [];
  let x = margin;
  for (const w of colPixelWidths) {
    xStarts.push(x);
    x += w;
  }
  for (let r = 0; r < tableRows.length; r += 1) {
    const y = margin + titleHeight + r * rowHeight;
    fillRect(margin, y, tableWidth, rowHeight, r % 2 === 0 ? rowA : rowB);
    for (let c = 0; c < colCount; c += 1) {
      const cell = (tableRows[r][c] ?? "").slice(0, widths[c]);
      drawText(xStarts[c] + cellPadX, y + 8, cell, r === 0 ? title : text);
    }
  }
  for (let i = 0; i <= colCount; i += 1) {
    const lineX = i === colCount ? margin + tableWidth : xStarts[i];
    fillRect(lineX, margin + titleHeight, 1, tableRows.length * rowHeight, grid);
  }
  for (let i = 0; i <= tableRows.length; i += 1) {
    const lineY = margin + titleHeight + i * rowHeight;
    fillRect(margin, lineY, tableWidth, 1, grid);
  }

  return PNG.sync.write(png);
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
    {
      name: "place",
      description: "Suggest clan placement for a given war weight (uses ACTUAL state)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "weight",
          description: "Member war weight",
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

        const [leftBlock, middleBlock, rightBlock, targetBandBlock, refreshCell] = await Promise.all([
          sheets.readLinkedValues("AllianceDashboard!A1:A9", mode),
          sheets.readLinkedValues("AllianceDashboard!D1:E9", mode),
          sheets.readLinkedValues("AllianceDashboard!U1:AA9", mode),
          sheets.readLinkedValues("AllianceDashboard!AW1:AW9", mode),
          sheets.readLinkedValues("Lookup!B10:B10", mode),
        ]);

        const mergedRows = mergeStateRows(
          padRows(leftBlock, 9, 1),
          padRows(middleBlock, 9, 2),
          padRows(rightBlock, 9, 7),
          padRows(targetBandBlock, 9, 1)
        );

        const rawRefresh = refreshCell[0]?.[0]?.trim();
        const refreshLine =
          rawRefresh && /^\d+$/.test(rawRefresh)
            ? `RAW Data last refreshed: <t:${rawRefresh}:F>`
            : "RAW Data last refreshed: (not available)";

        const content = [`Mode Displayed: **${mode.toUpperCase()}**`, refreshLine].join("\n");
        const png = await renderStatePng(mode, mergedRows);

        await interaction.editReply({
          content,
          files: [
            {
              attachment: png,
              name: `compo-state-${mode}.png`,
            },
          ],
        });
        return;
      }

      if (subcommand === "place") {
        const rawWeight = interaction.options.getString("weight", true);
        const inputWeight = parseWeightInput(rawWeight);
        if (!inputWeight || inputWeight <= 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              "Invalid weight. Use formats like `145000`, `145,000`, or `145k`.",
          });
          return;
        }

        const bucket = getWeightBucket(inputWeight);
        if (!bucket) {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              "Weight is outside supported ranges (121,000 to 180,000).",
          });
          return;
        }

        const stateMode: GoogleSheetMode = "actual";
        const settings = new SettingsService();
        const sheets = new GoogleSheetsService(settings);

        const [clanCol, totalCol, targetBandCol, rightBlock] = await Promise.all([
          sheets.readLinkedValues("AllianceDashboard!A1:A9", stateMode),
          sheets.readLinkedValues("AllianceDashboard!D1:D9", stateMode),
          sheets.readLinkedValues("AllianceDashboard!AW1:AW9", stateMode),
          sheets.readLinkedValues("AllianceDashboard!U1:AA9", stateMode),
        ]);

        const candidates = readPlacementCandidates(
          clanCol,
          totalCol,
          targetBandCol,
          rightBlock
        );

        if (candidates.length === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "No placement data found in ACTUAL state ranges.",
          });
          return;
        }

        const vacancyChoice = candidates
          .filter((c) => c.missingCount > 0)
          .sort((a, b) => {
            if (b.missingCount !== a.missingCount) return b.missingCount - a.missingCount;
            return Math.abs(a.remainingToTarget - inputWeight) - Math.abs(b.remainingToTarget - inputWeight);
          });

        const compositionNeeds = candidates
          .map((c) => {
            const key = normalize(`${bucket}-delta`);
            const delta = c.bucketDeltaByHeader[key] ?? 0;
            return { ...c, delta };
          })
          .filter((c) => c.delta < 0)
          .sort((a, b) => {
            if (a.delta !== b.delta) return a.delta - b.delta;
            return b.missingCount - a.missingCount;
          });

        const recommended = compositionNeeds.filter((c) => c.missingCount > 0);
        const vacancyList = vacancyChoice;
        const compositionList = compositionNeeds;

        const recommendedText =
          recommended.length > 0
            ? recommended
                .map(
                  (c) =>
                    `${abbreviateClan(c.clanName)} (Missing ${c.missingCount}, ${bucket.toLowerCase()}-delta: ${c.delta})`
                )
                .join(", ")
            : "None";

        const vacancyText =
          vacancyList.length > 0
            ? vacancyList
                .map((c) => `${abbreviateClan(c.clanName)} (${c.missingCount})`)
                .join(", ")
            : "None";

        const compositionText =
          compositionList.length > 0
            ? compositionList
                .map((c) => `${abbreviateClan(c.clanName)} (${c.delta})`)
                .join(", ")
            : "None";

        await safeReply(interaction, {
          ephemeral: true,
          content:
            `ACTUAL placement suggestions for weight **${inputWeight.toLocaleString()}** (${bucket} bucket):\n` +
            `- Recommended: ${recommendedText}\n` +
            `- Vacancy: ${vacancyText}\n` +
            `- Composition: ${compositionText}`,
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
