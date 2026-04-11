import {
  ActionRowBuilder,
  APIActionRowComponent,
  APIComponentInMessageActionRow,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { getCompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { prisma } from "../prisma";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import { CompoPlaceService } from "../services/CompoPlaceService";
import { CompoWarStateService } from "../services/CompoWarStateService";
import {
  getSheetRefreshErrorHint,
  mapSheetRefreshFlowErrorToMessage,
  SheetRefreshFlowError,
  triggerSharedSheetRefresh,
} from "../services/SheetRefreshService";
import {
  GoogleSheetMode,
  GoogleSheetReadError,
  GoogleSheetReadErrorCode,
  GoogleSheetsService,
} from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function getSubcommandSafe(interaction: ChatInputCommandInteraction): string {
  try {
    return interaction.options.getSubcommand(false) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function logCompoStage(
  interaction: ChatInputCommandInteraction,
  stage: string,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const base = {
    stage,
    command: "compo",
    subcommand: getSubcommandSafe(interaction),
    guild: interaction.guildId ?? "DM",
    user: interaction.user.id,
  };
  const fields = { ...base, ...detail };
  const serialized = Object.entries(fields)
    .map(([k, v]) => `${k}=${String(v ?? "")}`)
    .join(" ");
  console.log(`[compo-command] ${serialized}`);
}

const COMPO_MODE_CHOICES = [
  { name: "Actual Roster", value: "actual" },
  { name: "War Roster", value: "war" },
];

function readMode(interaction: ChatInputCommandInteraction): GoogleSheetMode {
  const rawMode = interaction.options.getString("mode", false);
  return rawMode === "war" ? "war" : "actual";
}

const COL_CLAN_NAME = 0; // A
const COL_CLAN_TAG = 1; // B
const COL_TOTAL_WEIGHT = 3; // D
const COL_MISSING_WEIGHT = 20; // U
const COL_TOTAL_PLAYERS = 21; // V
const COL_BUCKET_START = 22; // W (was 21 / V)
const COL_BUCKET_END = 27; // AB (was 26 / AA)
const COL_ADJUSTMENT = 54; // BC (was 53 / BB)
const FIXED_LAYOUT_RANGE = "AllianceDashboard!A6:BE500";
const FIXED_LAYOUT_RANGE_START_ROW = 6;
const STATE_HEADERS = [
  "Clan",
  "Total",
  "Missing",
  "Players",
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "<=TH13",
];
const LOOKUP_REFRESH_RANGE = "Lookup!B10:B10";
const COMPO_REFRESH_PREFIX = "compo-refresh";
const COMPO_REFRESH_LABEL = "Refresh Data";
const COMPO_REFRESH_LOADING_LABEL = "Refreshing...";
const COMPO_ERROR_MESSAGE_BY_CODE: Record<GoogleSheetReadErrorCode, string> = {
  SHEET_LINK_MISSING: "No compo sheet is linked for this server.",
  SHEET_PROXY_UNAUTHORIZED:
    "The linked compo sheet could not be accessed because the sheet proxy is not authorized.",
  SHEET_ACCESS_DENIED:
    "The linked compo sheet exists, but this bot does not currently have access to read it.",
  SHEET_RANGE_INVALID:
    "The linked compo sheet does not contain the expected AllianceDashboard layout.",
  SHEET_READ_FAILURE:
    "The compo sheet could not be read due to a sheet service error.",
};

type CompoRefreshPayload =
  | {
      kind: "state";
      userId: string;
      mode: GoogleSheetMode;
    }
  | {
      kind: "place";
      userId: string;
      weight: number;
    };

function buildCompoRefreshCustomId(payload: CompoRefreshPayload): string {
  if (payload.kind === "state") {
    return `${COMPO_REFRESH_PREFIX}:state:${payload.userId}:${payload.mode}`;
  }
  return `${COMPO_REFRESH_PREFIX}:place:${payload.userId}:${Math.trunc(payload.weight)}`;
}

function parseCompoRefreshCustomId(
  customId: string,
): CompoRefreshPayload | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== COMPO_REFRESH_PREFIX) return null;
  const [, kind, userId, value] = parts;
  if (!userId || !value) return null;
  if (kind === "state") {
    if (value !== "actual" && value !== "war") return null;
    return {
      kind: "state",
      userId,
      mode: value,
    };
  }
  if (kind === "place") {
    const weight = Number(value);
    if (!Number.isFinite(weight) || weight <= 0) return null;
    return {
      kind: "place",
      userId,
      weight: Math.trunc(weight),
    };
  }
  return null;
}

export function isCompoRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${COMPO_REFRESH_PREFIX}:`);
}

function buildCompoRefreshActionRow(
  customId: string,
  options?: { loading?: boolean },
): ActionRowBuilder<ButtonBuilder> {
  const loading = options?.loading ?? false;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(loading ? COMPO_REFRESH_LOADING_LABEL : COMPO_REFRESH_LABEL)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(loading),
  );
}

function extractSupplementalRowsFromMessage(
  interaction: ButtonInteraction,
): Array<APIActionRowComponent<APIComponentInMessageActionRow>> {
  return interaction.message.components
    .map(
      (row) =>
        row.toJSON() as APIActionRowComponent<APIComponentInMessageActionRow>,
    )
    .filter(
      (row) =>
        !row.components.some(
          (component) =>
            component.type === ComponentType.Button &&
            "custom_id" in component &&
            typeof component.custom_id === "string" &&
            isCompoRefreshButtonCustomId(component.custom_id),
        ),
    );
}

function buildRefreshLine(refreshCell: string[][]): string {
  const rawRefresh = refreshCell[0]?.[0]?.trim();
  return rawRefresh && /^\d+$/.test(rawRefresh)
    ? `RAW Data last refreshed: <t:${rawRefresh}:F>`
    : "RAW Data last refreshed: (not available)";
}

function normalizeTag(value: string): string {
  return value.trim().toUpperCase().replace(/^#/, "");
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
    "THE BADLANDS": "BL",
    "LEGENDARY ROYALS": "LR",
    "STEEL EMPIRE": "SE",
    "STEEL EMPIRE 2": "SE",
    THEWISECOWBOYS: "TWC",
    MARVELS: "MV",
    "ROCKY ROAD": "RR",
    AKATSUKI: "AK",
  };

  return map[normalized] ?? value;
}

type SheetIndexedRow = {
  row: string[];
  sheetRowNumber: number;
};

function getAbsoluteSheetRowNumber(rangeRelativeIndex: number): number {
  return FIXED_LAYOUT_RANGE_START_ROW + rangeRelativeIndex;
}

function mapCompoSheetErrorToMessage(err: unknown): string {
  if (err instanceof GoogleSheetReadError) {
    return (
      COMPO_ERROR_MESSAGE_BY_CODE[err.code] ??
      COMPO_ERROR_MESSAGE_BY_CODE.SHEET_READ_FAILURE
    );
  }
  return COMPO_ERROR_MESSAGE_BY_CODE.SHEET_READ_FAILURE;
}

function isActualSheetRow(sheetRowNumber: number): boolean {
  return sheetRowNumber >= 7 && sheetRowNumber % 3 === 1;
}

function isWarSheetRow(sheetRowNumber: number): boolean {
  return sheetRowNumber >= 8 && sheetRowNumber % 3 === 2;
}

function getModeRows(
  rows: string[][],
  mode: GoogleSheetMode,
): SheetIndexedRow[] {
  return rows.flatMap((row, index) => {
    const sheetRowNumber = getAbsoluteSheetRowNumber(index);
    const include =
      mode === "actual"
        ? isActualSheetRow(sheetRowNumber)
        : isWarSheetRow(sheetRowNumber);
    return include ? [{ row, sheetRowNumber }] : [];
  });
}

function _renderStateSvg(mode: GoogleSheetMode, rows: string[][]): Buffer {
  const tableRows = rows.length > 0 ? rows : [["(NO DATA)"]];
  const colCount = Math.max(...tableRows.map((row) => row.length), 1);
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.min(
      40,
      Math.max(6, ...tableRows.map((row) => String(row[col] ?? "").length)),
    ),
  );
  const charPx = 8;
  const paddingX = 12;
  const rowHeight = 30;
  const titleHeight = 46;
  const margin = 16;
  const colWidthsPx = widths.map((w) => w * charPx + paddingX * 2);
  const tableWidth = colWidthsPx.reduce((sum, v) => sum + v, 0);
  const width = margin * 2 + tableWidth;
  const height = margin * 2 + titleHeight + tableRows.length * rowHeight;

  const xStarts: number[] = [];
  let runningX = margin;
  for (const w of colWidthsPx) {
    xStarts.push(runningX);
    runningX += w;
  }

  const cells: string[] = [];
  for (let r = 0; r < tableRows.length; r += 1) {
    const y = margin + titleHeight + r * rowHeight;
    const bg = r === 0 ? "#1f2d5a" : r % 2 === 0 ? "#171d34" : "#131a2f";
    cells.push(
      `<rect x="${margin}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${bg}" />`,
    );
    for (let c = 0; c < colCount; c += 1) {
      const raw = String(tableRows[r][c] ?? "");
      const text = raw
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const color = r === 0 ? "#9ec2ff" : "#f0f4ff";
      cells.push(
        `<text x="${xStarts[c] + paddingX}" y="${y + 20}" font-size="14" font-family="Consolas, Menlo, monospace" fill="${color}">${text}</text>`,
      );
    }
  }

  const verticalLines: string[] = [];
  for (let c = 0; c <= colCount; c += 1) {
    const x = c === colCount ? margin + tableWidth : xStarts[c];
    verticalLines.push(
      `<line x1="${x}" y1="${margin + titleHeight}" x2="${x}" y2="${margin + titleHeight + tableRows.length * rowHeight}" stroke="#2a3558" stroke-width="1" />`,
    );
  }
  const horizontalLines: string[] = [];
  for (let r = 0; r <= tableRows.length; r += 1) {
    const y = margin + titleHeight + r * rowHeight;
    horizontalLines.push(
      `<line x1="${margin}" y1="${y}" x2="${margin + tableWidth}" y2="${y}" stroke="#2a3558" stroke-width="1" />`,
    );
  }

  const title = `Alliance State (${mode.toUpperCase()})`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#101427" />`,
    `<text x="${margin}" y="${margin + 24}" font-size="20" font-family="Consolas, Menlo, monospace" fill="#9ec2ff">${title}</text>`,
    ...cells,
    ...verticalLines,
    ...horizontalLines,
    "</svg>",
  ].join("");

  return Buffer.from(svg, "utf8");
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

function clampCell(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
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

function toGlyphSafeText(input: string): string {
  const normalized = input
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const upper = normalized.toUpperCase();
  let out = "";
  for (const ch of upper) {
    out += GLYPHS[ch] ? ch : "?";
  }
  return out;
}

function _padRows(
  rows: string[][],
  rowCount: number,
  colCount: number,
): string[][] {
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

function _mergeStateRows(
  left: string[][],
  middle: string[][],
  right: string[][],
  targetBand: string[][],
): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < 9; i += 1) {
    const rightRow = right[i] ?? ["", "", "", "", "", "", ""];
    const targetBandValue = (targetBand[i] ?? [""])[0] ?? "";

    out.push([
      abbreviateClan(normalizeCompoClanDisplayName((left[i] ?? [""])[0] ?? "")),
      (middle[i] ?? ["", ""])[0] ?? "",
      targetBandValue,
      ...rightRow,
    ]);
  }
  return out;
}

function buildCompoStateRows(modeRows: SheetIndexedRow[]): string[][] {
  const contentRows = modeRows.flatMap((modeRow) => {
    const clanName = clampCell(
      normalizeCompoClanDisplayName(String(modeRow.row[COL_CLAN_NAME] ?? "")),
    );
    if (!clanName) return [];
    return [
      [
        clanName,
        clampCell(String(modeRow.row[COL_TOTAL_WEIGHT] ?? "")),
        clampCell(String(modeRow.row[COL_MISSING_WEIGHT] ?? "")),
        clampCell(String(modeRow.row[COL_TOTAL_PLAYERS] ?? "")),
        clampCell(String(modeRow.row[COL_BUCKET_START] ?? "")),
        clampCell(String(modeRow.row[COL_BUCKET_START + 1] ?? "")),
        clampCell(String(modeRow.row[COL_BUCKET_START + 2] ?? "")),
        clampCell(String(modeRow.row[COL_BUCKET_START + 3] ?? "")),
        clampCell(String(modeRow.row[COL_BUCKET_START + 4] ?? "")),
        clampCell(String(modeRow.row[COL_BUCKET_END] ?? "")),
      ],
    ];
  });
  return [STATE_HEADERS, ...contentRows];
}

type CompoRenderPayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: Array<{
    attachment: Buffer;
    name: string;
  }>;
};

type CompoSheetSnapshot = {
  linked: Awaited<ReturnType<GoogleSheetsService["getCompoLinkedSheet"]>>;
  rows: string[][];
  modeRows: SheetIndexedRow[];
  refreshLine: string;
};

async function readCompoSheetSnapshot(
  mode: GoogleSheetMode,
): Promise<CompoSheetSnapshot> {
  const settings = new SettingsService();
  const sheets = new GoogleSheetsService(settings);
  const linked = await sheets.getCompoLinkedSheet(FIXED_LAYOUT_RANGE);
  const [rows, refreshCell] = await Promise.all([
    sheets.readCompoLinkedValues(FIXED_LAYOUT_RANGE, linked),
    sheets.readCompoLinkedValues(LOOKUP_REFRESH_RANGE, linked),
  ]);
  return {
    linked,
    rows,
    modeRows: getModeRows(rows, mode),
    refreshLine: buildRefreshLine(refreshCell),
  };
}

function buildCompoStatePayload(input: {
  mode: GoogleSheetMode;
  modeRows: SheetIndexedRow[];
  refreshLine: string;
}): CompoRenderPayload {
  return buildCompoStatePayloadFromRows({
    mode: input.mode,
    stateRows: buildCompoStateRows(input.modeRows),
    contentLines: [input.refreshLine],
  });
}

function buildCompoStatePayloadFromRows(input: {
  mode: GoogleSheetMode;
  stateRows: string[][];
  contentLines: string[];
}): CompoRenderPayload {
  return {
    content: input.contentLines.join("\n"),
    files: [
      {
        attachment: renderStatePng(input.mode, input.stateRows),
        name: `compo-state-${input.mode}.png`,
      },
    ],
  };
}

/*
  const recommendedRows = params.recommended.map(
    (c) =>
      `${abbreviateClan(normalizeCompoClanDisplayName(c.clanName))} — needs ${Math.abs(c.delta)} ${params.bucket}`,
  );
  const vacancyRows = params.vacancyList.map(
    (c) =>
      `${abbreviateClan(normalizeCompoClanDisplayName(c.clanName))} — ${
        c.liveMemberCount !== null ? `${c.liveMemberCount}/50` : "unknown/50"
      }`,
  );
  const compositionRows = params.compositionList.map(
    (c) =>
      `${abbreviateClan(normalizeCompoClanDisplayName(c.clanName))} — ${c.delta}`,
  );

  return new EmbedBuilder()
    .setTitle("Compo Placement Suggestions")
    .setDescription(
      `Weight: **${params.inputWeight.toLocaleString()}**\n` +
        `Bucket: **${params.bucket}**\n` +
        params.refreshLine,
    )
    .addFields(
      {
        name: "Recommended",
        value: formatPlacementRows(recommendedRows),
        inline: false,
      },
      {
        name: "Vacancy",
        value: formatPlacementRows(vacancyRows),
        inline: false,
      },
      {
        name: "Composition",
        value: formatPlacementRows(compositionRows),
        inline: false,
      },
    );
}

*/
const GLYPHS: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "'": ["00100", "00100", "00100", "00000", "00000", "00000", "00000"],
  '"': ["01010", "01010", "01010", "00000", "00000", "00000", "00000"],
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
    Math.min(
      24,
      Math.max(4, ...tableRows.map((row) => (row[col] ?? "").length)),
    ),
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
  const fillRect = (
    x: number,
    y: number,
    w: number,
    h: number,
    rgb: [number, number, number],
  ) => {
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) {
        setPixel(xx, yy, rgb);
      }
    }
  };
  const drawChar = (
    x: number,
    y: number,
    ch: string,
    rgb: [number, number, number],
  ) => {
    const glyph = GLYPHS[ch] ?? GLYPHS["?"];
    for (let gy = 0; gy < glyph.length; gy += 1) {
      for (let gx = 0; gx < glyph[gy].length; gx += 1) {
        if (glyph[gy][gx] !== "1") continue;
        fillRect(x + gx * scale, y + gy * scale, scale, scale, rgb);
      }
    }
  };
  const drawText = (
    x: number,
    y: number,
    text: string,
    rgb: [number, number, number],
  ) => {
    const glyphSafe = toGlyphSafeText(text);
    for (let i = 0; i < glyphSafe.length; i += 1) {
      drawChar(x + i * charPx, y, glyphSafe[i], rgb);
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
    fillRect(
      lineX,
      margin + titleHeight,
      1,
      tableRows.length * rowHeight,
      grid,
    );
  }
  for (let i = 0; i <= tableRows.length; i += 1) {
    const lineY = margin + titleHeight + i * rowHeight;
    fillRect(margin, lineY, tableWidth, 1, grid);
  }

  return PNG.sync.write(png);
}

function buildCompoRefreshComponents(input: {
  customId: string;
  loading: boolean;
  supplementalRows?: Array<
    APIActionRowComponent<APIComponentInMessageActionRow>
  >;
}): Array<
  | ActionRowBuilder<ButtonBuilder>
  | APIActionRowComponent<APIComponentInMessageActionRow>
> {
  const components: Array<
    | ActionRowBuilder<ButtonBuilder>
    | APIActionRowComponent<APIComponentInMessageActionRow>
  > = [buildCompoRefreshActionRow(input.customId, { loading: input.loading })];
  if (input.supplementalRows && input.supplementalRows.length > 0) {
    components.push(...input.supplementalRows);
  }
  return components.slice(0, 5);
}

function mapCompoRefreshErrorToMessage(err: unknown): string {
  if (err instanceof SheetRefreshFlowError) {
    return mapSheetRefreshFlowErrorToMessage(err);
  }
  if (err instanceof GoogleSheetReadError) {
    return mapCompoSheetErrorToMessage(err);
  }
  const refreshHint = getSheetRefreshErrorHint(err);
  return `Failed to refresh compo view. ${refreshHint}`;
}

function mapCompoWarStateErrorToMessage(action: "load" | "refresh"): string {
  return action === "refresh"
    ? "Failed to refresh DB-backed WAR state. Try again in a moment."
    : "Failed to load DB-backed WAR state. Try again in a moment.";
}

function mapCompoPlaceErrorToMessage(action: "load" | "refresh"): string {
  return action === "refresh"
    ? "Failed to refresh ACTUAL placement suggestions. Try again in a moment."
    : "Failed to load ACTUAL placement suggestions. Try again in a moment.";
}

export async function handleCompoRefreshButton(
  interaction: ButtonInteraction,
  _cocService: CoCService,
): Promise<void> {
  const parsed = parseCompoRefreshCustomId(interaction.customId);
  if (!parsed) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        ephemeral: true,
        content: "Invalid refresh action.",
      });
    }
    return;
  }
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this refresh button.",
    });
    return;
  }

  const supplementalRows = extractSupplementalRowsFromMessage(interaction);
  await interaction.update({
    components: buildCompoRefreshComponents({
      customId: interaction.customId,
      loading: true,
      supplementalRows,
    }),
  });

  try {
    if (parsed.kind === "state") {
      let payload: CompoRenderPayload;
      if (parsed.mode === "war") {
        const warState = await new CompoWarStateService().refreshState();
        payload = warState.stateRows
          ? buildCompoStatePayloadFromRows({
              mode: "war",
              stateRows: warState.stateRows,
              contentLines: warState.contentLines,
            })
          : {
              content: warState.contentLines.join("\n"),
            };
      } else {
        await triggerSharedSheetRefresh({
          guildId: interaction.guildId ?? null,
          mode: parsed.mode,
        });
        const snapshot = await readCompoSheetSnapshot(parsed.mode);
        payload = buildCompoStatePayload({
          mode: parsed.mode,
          modeRows: snapshot.modeRows,
          refreshLine: snapshot.refreshLine,
        });
      }
      await interaction.editReply({
        ...payload,
        components: buildCompoRefreshComponents({
          customId: interaction.customId,
          loading: false,
          supplementalRows,
        }),
      });
      return;
    }

    const bucket = getCompoWarDisplayBucket(parsed.weight);
    if (!bucket) {
      throw new Error("Invalid placement bucket for refresh.");
    }
      const placeResult = await new CompoPlaceService().refreshPlace(
      parsed.weight,
      bucket,
      interaction.guildId ?? null,
    );
    const refreshCustomId = buildCompoRefreshCustomId({
      kind: "place",
      userId: interaction.user.id,
      weight: parsed.weight,
    });
    await interaction.editReply({
      content: placeResult.content,
      embeds: placeResult.embeds,
      components: buildCompoRefreshComponents({
        customId: refreshCustomId,
        loading: false,
        supplementalRows,
      }),
    });
  } catch (err) {
    console.error(`compo refresh button failed: ${formatError(err)}`);
    await interaction.editReply({
      components: buildCompoRefreshComponents({
        customId: interaction.customId,
        loading: false,
        supplementalRows,
      }),
    });
    await interaction.followUp({
      ephemeral: true,
      content:
        parsed.kind === "state" && parsed.mode === "war"
          ? mapCompoWarStateErrorToMessage("refresh")
          : parsed.kind === "place"
            ? mapCompoPlaceErrorToMessage("refresh")
            : mapCompoRefreshErrorToMessage(err),
    });
  }
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
          name: "tag",
          description: "Tracked clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
        {
          name: "mode",
          description: "Use ACTUAL or WAR fixed rows",
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
          description: "Use ACTUAL or WAR fixed rows",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: COMPO_MODE_CHOICES,
        },
      ],
    },
    {
      name: "place",
      description:
        "Suggest clan placement for a given war weight (uses ACTUAL compo state)",
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
    _cocService: CoCService,
  ) => {
    const visibility =
      interaction.options.getString("visibility", false) ?? "private";
    const isPublic = visibility === "public";
    try {
      logCompoStage(interaction, "handler_enter");

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: !isPublic });
        logCompoStage(interaction, "defer_reply_ok");
      }

      const subcommand = interaction.options.getSubcommand(true);
      const mode = readMode(interaction);
      logCompoStage(interaction, "options_parsed", {
        mode,
        tag: interaction.options.getString("tag", false) ?? "",
        weight: interaction.options.getString("weight", false) ?? "",
      });

      if (subcommand === "advice") {
        const tagInput = interaction.options.getString("tag", true);
        const targetTag = normalizeTag(tagInput);
        logCompoStage(interaction, "computation_start", { targetTag, mode });

        const settings = new SettingsService();
        const sheets = new GoogleSheetsService(settings);
        const linked = await sheets.getCompoLinkedSheet(FIXED_LAYOUT_RANGE);
        logCompoStage(interaction, "db_fetch", {
          entity: "sheet_link",
          mode,
          result: linked.sheetId ? "found" : "missing",
          sheetIdPresent: Boolean(linked.sheetId),
          resolutionSource: linked.source,
        });
        logCompoStage(interaction, "read_dispatch", {
          range: FIXED_LAYOUT_RANGE,
          resolutionSource: linked.source,
        });
        const rows = await sheets.readCompoLinkedValues(
          FIXED_LAYOUT_RANGE,
          linked,
        );
        const modeRows = getModeRows(rows, mode);
        logCompoStage(interaction, "db_fetch", {
          entity: "sheet_rows",
          mode,
          result: rows.length > 0 ? "found" : "missing",
          totalRows: rows.length,
          modeRows: modeRows.length,
        });

        if (modeRows.length === 0) {
          logCompoStage(interaction, "response_build", {
            reason: "no_mode_rows",
          });
          await safeReply(interaction, {
            ephemeral: !isPublic,
            content: `No ${mode.toUpperCase()} rows found in ${FIXED_LAYOUT_RANGE}.`,
          });
          logCompoStage(interaction, "response_sent", {
            reason: "no_mode_rows",
          });
          return;
        }

        for (const modeRow of modeRows) {
          const row = modeRow.row;
          const clanName = String(row[COL_CLAN_NAME] ?? "").trim();
          const displayClanName = normalizeCompoClanDisplayName(clanName);
          const clanTag = normalizeTag(String(row[COL_CLAN_TAG] ?? ""));
          const advice = String(row[COL_ADJUSTMENT] ?? "").trim();
          if (!clanName || !clanTag) continue;

          if (clanTag === targetTag) {
            logCompoStage(interaction, "computation_complete", {
              result: "target_found",
              clanTag,
            });
            logCompoStage(interaction, "response_build", {
              reason: "target_found",
            });
            await safeReply(interaction, {
              ephemeral: !isPublic,
              content:
                advice && advice.length > 0
                  ? `Mode: **${mode.toUpperCase()}**\n**${displayClanName}** (\`#${clanTag}\`) adjustment:\n${advice}`
                  : `Mode: **${mode.toUpperCase()}**\nFound **${displayClanName}** (\`#${clanTag}\`), but there is no adjustment text in column BC.`,
            });
            logCompoStage(interaction, "response_sent", {
              reason: "target_found",
            });
            return;
          }
        }

        const knownTags = modeRows
          .map((modeRow) =>
            normalizeTag(String(modeRow.row[COL_CLAN_TAG] ?? "")),
          )
          .filter((tag): tag is string => Boolean(tag));
        logCompoStage(interaction, "computation_complete", {
          result: "target_missing",
          knownTags: knownTags.length,
        });

        logCompoStage(interaction, "response_build", {
          reason: "target_missing",
        });
        await safeReply(interaction, {
          ephemeral: !isPublic,
          content:
            knownTags.length > 0
              ? `Mode: **${mode.toUpperCase()}**\nNo adjustment mapping found for tag \`#${targetTag}\`. Known tags in this mode: ${knownTags.map((t) => `#${t}`).join(", ")}`
              : `Mode: **${mode.toUpperCase()}**\nNo adjustment mapping found for tag \`#${targetTag}\`.`,
        });
        logCompoStage(interaction, "response_sent", {
          reason: "target_missing",
        });
        return;
      }

      if (subcommand === "state") {
        logCompoStage(interaction, "computation_start", { mode });
        const payload =
          mode === "war"
            ? await (async () => {
                const warState = await new CompoWarStateService().readState();
                logCompoStage(interaction, "db_fetch", {
                  entity: "tracked_war_roster_current",
                  mode,
                  renderableRows: warState.renderableClanTags.length,
                  snapshotRows: warState.snapshotClanTags.length,
                });
                logCompoStage(interaction, "db_fetch", {
                  entity: "heat_map_ref",
                  mode,
                  result: warState.stateRows ? "found" : "partial_or_missing",
                });
                return warState.stateRows
                  ? buildCompoStatePayloadFromRows({
                      mode: "war",
                      stateRows: warState.stateRows,
                      contentLines: warState.contentLines,
                    })
                  : {
                      content: warState.contentLines.join("\n"),
                    };
              })()
            : await (async () => {
                const snapshot = await readCompoSheetSnapshot(mode);
                logCompoStage(interaction, "db_fetch", {
                  entity: "sheet_link",
                  mode,
                  result: snapshot.linked.sheetId ? "found" : "missing",
                  sheetIdPresent: Boolean(snapshot.linked.sheetId),
                  resolutionSource: snapshot.linked.source,
                });
                logCompoStage(interaction, "read_dispatch", {
                  range: FIXED_LAYOUT_RANGE,
                  resolutionSource: snapshot.linked.source,
                });
                logCompoStage(interaction, "read_dispatch", {
                  range: LOOKUP_REFRESH_RANGE,
                  resolutionSource: snapshot.linked.source,
                });
                logCompoStage(interaction, "db_fetch", {
                  entity: "sheet_rows",
                  mode,
                  result: snapshot.rows.length > 0 ? "found" : "missing",
                  totalRows: snapshot.rows.length,
                  modeRows: snapshot.modeRows.length,
                });
                return buildCompoStatePayload({
                  mode,
                  modeRows: snapshot.modeRows,
                  refreshLine: snapshot.refreshLine,
                });
              })();
        const refreshCustomId = buildCompoRefreshCustomId({
          kind: "state",
          userId: interaction.user.id,
          mode,
        });

        logCompoStage(interaction, "computation_complete", {
          result: "state_rendered",
          mode,
        });
        logCompoStage(interaction, "response_build", { reason: "state_png" });
        await interaction.editReply({
          ...payload,
          components: buildCompoRefreshComponents({
            customId: refreshCustomId,
            loading: false,
          }),
        });
        logCompoStage(interaction, "response_sent", { reason: "state_png" });
        return;
      }

      if (subcommand === "place") {
        const rawWeight = interaction.options.getString("weight", true);
        const inputWeight = parseWeightInput(rawWeight);
        logCompoStage(interaction, "computation_start", {
          weightInput: rawWeight,
          parsedWeight: inputWeight ?? "",
        });
        if (!inputWeight || inputWeight <= 0) {
          logCompoStage(interaction, "response_build", {
            reason: "invalid_weight",
          });
          await safeReply(interaction, {
            ephemeral: !isPublic,
            content:
              "Invalid weight. Use formats like `145000`, `145,000`, or `145k`.",
          });
          logCompoStage(interaction, "response_sent", {
            reason: "invalid_weight",
          });
          return;
        }

        const bucket = getCompoWarDisplayBucket(inputWeight);
        if (!bucket) {
          logCompoStage(interaction, "response_build", {
            reason: "weight_out_of_range",
            parsedWeight: inputWeight,
          });
          await safeReply(interaction, {
            ephemeral: !isPublic,
            content: "Weight is outside supported ranges for ACTUAL compo buckets.",
          });
          logCompoStage(interaction, "response_sent", {
            reason: "weight_out_of_range",
          });
          return;
        }

        const placeResult = await new CompoPlaceService().readPlace(
          inputWeight,
          bucket,
          interaction.guildId ?? null,
        );
        const refreshCustomId = buildCompoRefreshCustomId({
          kind: "place",
          userId: interaction.user.id,
          weight: inputWeight,
        });
        logCompoStage(interaction, "db_fetch", {
          entity: "actual_compo_place_source",
          mode: "actual",
          candidateClans: placeResult.candidateCount,
          taggedClans: placeResult.trackedClanTags.length,
        });
        logCompoStage(interaction, "computation_complete", {
          result: "placement_candidates",
          candidates: placeResult.candidateCount,
          bucket,
        });

        logCompoStage(interaction, "response_build", {
          reason:
            placeResult.candidateCount === 0
              ? "no_candidates"
              : "placement_result",
          recommended: placeResult.recommendedCount,
          vacancy: placeResult.vacancyCount,
          composition: placeResult.compositionCount,
        });
        await interaction.editReply({
          content: placeResult.content,
          embeds: placeResult.embeds,
          components: buildCompoRefreshComponents({
            customId: refreshCustomId,
            loading: false,
          }),
        });
        logCompoStage(interaction, "response_sent", {
          reason:
            placeResult.candidateCount === 0
              ? "no_candidates"
              : "placement_result",
        });
        return;
      }

      logCompoStage(interaction, "response_build", {
        reason: "unknown_subcommand",
      });
      await safeReply(interaction, {
        ephemeral: !isPublic,
        content: "Unknown subcommand.",
      });
      logCompoStage(interaction, "response_sent", {
        reason: "unknown_subcommand",
      });
      return;
    } catch (err) {
      console.error(`compo command failed: ${formatError(err)}`);
      console.error(
        `[compo-command-error] stage=run_catch subcommand=${getSubcommandSafe(interaction)} error=${formatError(err)}`,
      );
      logCompoStage(interaction, "response_build", {
        reason: "run_catch",
        normalizedCode: err instanceof GoogleSheetReadError ? err.code : "",
        normalizedStatus:
          err instanceof GoogleSheetReadError
            ? (err.meta.httpStatus ?? "")
            : "",
        normalizedRange:
          err instanceof GoogleSheetReadError ? err.meta.range : "",
        resolutionSource:
          err instanceof GoogleSheetReadError
            ? (err.meta.resolutionSource ?? "")
            : "",
      });
      await safeReply(interaction, {
        ephemeral: !isPublic,
        content:
          getSubcommandSafe(interaction) === "state" && readMode(interaction) === "war"
            ? mapCompoWarStateErrorToMessage("load")
            : getSubcommandSafe(interaction) === "place"
              ? mapCompoPlaceErrorToMessage("load")
              : mapCompoSheetErrorToMessage(err),
      });
      logCompoStage(interaction, "response_sent", { reason: "run_catch" });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
      await interaction.respond([]);
      return;
    }

    const query = normalize(String(focused.value ?? ""));
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((c) => {
        const tag = c.tag.trim();
        const name = c.name?.trim() || tag;
        return {
          name: `${name} (${tag})`.slice(0, 100),
          value: tag,
        };
      })
      .filter(
        (c, i, arr) =>
          c.value.length > 0 && arr.findIndex((v) => v.value === c.value) === i,
      );

    const filtered = choices
      .filter(
        (choice) =>
          normalize(choice.name).includes(query) ||
          normalize(choice.value).includes(query),
      )
      .slice(0, 25)
      .map((choice) => ({ name: choice.name, value: choice.value }));

    await interaction.respond(filtered);
  },
};

export const buildCompoStateRowsForTest = buildCompoStateRows;
export const getModeRowsForTest = getModeRows;
export const getAbsoluteSheetRowNumberForTest = getAbsoluteSheetRowNumber;
export const mapCompoSheetErrorToMessageForTest = mapCompoSheetErrorToMessage;
export const buildCompoRefreshCustomIdForTest = buildCompoRefreshCustomId;
export const parseCompoRefreshCustomIdForTest = parseCompoRefreshCustomId;
export const parseWeightInputForTest = parseWeightInput;
