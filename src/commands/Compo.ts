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
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "../Command";
import type { HeatMapRef } from "@prisma/client";
import {
  COMPO_ADVICE_VIEW_LABELS,
  COMPO_ADVICE_VIEWS,
  stepCompoAdviceCustomBandIndexByCount,
  type CompoAdviceView,
} from "../helper/compoAdviceEngine";
import {
  COMPO_ACTUAL_STATE_VIEWS,
  getCompoActualStateViewLabel,
  type CompoActualStateView,
} from "../helper/compoActualStateView";
import {
  buildHeatMapRefDisplayRows,
  buildHeatMapRefDisplayText,
} from "../helper/heatMapRefDisplay";
import { formatError } from "../helper/formatError";
import { getCompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { prisma } from "../prisma";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  CompoAdviceService,
  type CompoAdviceReadResult,
} from "../services/CompoAdviceService";
import { CompoActualStateService } from "../services/CompoActualStateService";
import { CompoPlaceService } from "../services/CompoPlaceService";
import { CompoWarStateService } from "../services/CompoWarStateService";
import { HeatMapRefDisplayService } from "../services/HeatMapRefDisplayService";
import {
  GoogleSheetMode,
  GoogleSheetReadError,
  GoogleSheetReadErrorCode,
} from "../services/GoogleSheetsService";

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
const COL_TOTAL_WEIGHT = 3; // D
const COL_MISSING_WEIGHT = 20; // U
const COL_TOTAL_PLAYERS = 21; // V
const COL_BUCKET_START = 22; // W (was 21 / V)
const COL_BUCKET_END = 27; // AB (was 26 / AA)
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
const COMPO_HEATMAPREF_COPY_PREFIX = "compo-heatmapref-copy";
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
      mode: "war";
    }
  | {
      kind: "state";
      userId: string;
      mode: "actual";
      actualView: CompoActualStateView;
    }
  | {
      kind: "advice";
      userId: string;
      mode: "war";
      targetTag: string;
  }
  | {
      kind: "advice";
      userId: string;
      mode: "actual";
      adviceView: CompoAdviceView;
      targetTag: string;
      customBandIndex: number | null;
      customBandCount: number;
  }
  | {
      kind: "advice-clan";
      userId: string;
      mode: "war" | "actual";
      targetTag: string;
      adviceView?: CompoAdviceView;
      customBandIndex?: number | null;
      customBandCount?: number;
    }
  | {
      kind: "view";
      userId: string;
      target: "state";
      actualView: CompoActualStateView;
    }
  | {
      kind: "view";
      userId: string;
      target: "advice";
      adviceView: CompoAdviceView;
      targetTag: string;
      customBandIndex: number | null;
      customBandCount: number;
    }
  | {
      kind: "advice-band";
      userId: string;
      targetTag: string;
      customBandCount: number;
      customBandIndex: number;
      direction: "prev" | "next";
    }
  | {
      kind: "place";
      userId: string;
      weight: number;
    };

function buildCompoRefreshCustomId(payload: CompoRefreshPayload): string {
  if (payload.kind === "state") {
    if (payload.mode === "actual") {
      return `${COMPO_REFRESH_PREFIX}:state:${payload.userId}:actual:${payload.actualView ?? "raw"}`;
    }
    return `${COMPO_REFRESH_PREFIX}:state:${payload.userId}:war`;
  }
  if (payload.kind === "advice") {
    if (payload.mode === "actual") {
      const base = `${COMPO_REFRESH_PREFIX}:advice:${payload.userId}:actual:${payload.adviceView}:${payload.targetTag}:${Math.trunc(payload.customBandCount)}`;
      return payload.customBandIndex === null || payload.customBandIndex === undefined
        ? `${base}:0`
        : `${base}:${Math.trunc(payload.customBandIndex)}`;
    }
    return `${COMPO_REFRESH_PREFIX}:advice:${payload.userId}:war:${payload.targetTag}`;
  }
  if (payload.kind === "advice-clan") {
    if (payload.mode === "actual") {
      const base = `${COMPO_REFRESH_PREFIX}:advice-clan:${payload.userId}:actual:${payload.targetTag}:${payload.adviceView ?? "auto"}`;
      return `${base}:${Math.trunc(payload.customBandCount ?? 0)}:${Math.trunc(payload.customBandIndex ?? 0)}`;
    }
    return `${COMPO_REFRESH_PREFIX}:advice-clan:${payload.userId}:war:${payload.targetTag}`;
  }
  if (payload.kind === "view") {
    if (payload.target === "advice") {
      const base = `${COMPO_REFRESH_PREFIX}:view:${payload.userId}:advice:${payload.adviceView}:${payload.targetTag}:${Math.trunc(payload.customBandCount)}`;
      return payload.customBandIndex === null || payload.customBandIndex === undefined
        ? `${base}:0`
        : `${base}:${Math.trunc(payload.customBandIndex)}`;
    }
    return `${COMPO_REFRESH_PREFIX}:view:${payload.userId}:state:${payload.actualView}`;
  }
  if (payload.kind === "advice-band") {
    return `${COMPO_REFRESH_PREFIX}:advice-band:${payload.userId}:${payload.targetTag}:${Math.trunc(payload.customBandCount)}:${Math.trunc(payload.customBandIndex)}:${payload.direction}`;
  }
  return `${COMPO_REFRESH_PREFIX}:place:${payload.userId}:${Math.trunc(payload.weight)}`;
}

function parseCompoRefreshCustomId(
  customId: string,
): CompoRefreshPayload | null {
  const parts = String(customId ?? "").split(":");
  if (parts[0] !== COMPO_REFRESH_PREFIX) return null;
  const kind = parts[1];
  const userId = parts[2];
  if (!kind || !userId) return null;
  if (kind === "state") {
    const mode = parts[3];
    if (mode === "war" && parts.length === 4) {
      return {
        kind: "state",
        userId,
        mode,
      };
    }
    if (
      mode === "actual" &&
      (parts.length === 4 || parts.length === 5)
    ) {
      const actualView = parts[4] ?? "raw";
      if (!COMPO_ACTUAL_STATE_VIEWS.includes(actualView as CompoActualStateView)) {
        return null;
      }
      return {
        kind: "state",
        userId,
        mode,
        actualView: actualView as CompoActualStateView,
      };
    }
    return null;
  }
  if (kind === "advice") {
    const mode = parts[3];
    if (mode === "war" && parts.length === 5) {
      const targetTag = normalizeTag(parts[4] ?? "");
      if (!targetTag) return null;
      return {
        kind: "advice",
        userId,
        mode,
        targetTag,
      };
    }
    if (
      mode === "actual" &&
      (parts.length === 6 || parts.length === 7 || parts.length === 8)
    ) {
      const adviceView = parts[4];
      const targetTag = normalizeTag(parts[5] ?? "");
      const customBandCount =
        parts.length >= 7 ? Number(parts[6]) : 0;
      const customBandIndexRaw =
        parts.length === 8 ? Number(parts[7]) : null;
      if (
        !targetTag ||
        !COMPO_ADVICE_VIEWS.includes(adviceView as CompoAdviceView) ||
        (parts.length >= 7 &&
          (!Number.isFinite(customBandCount) || customBandCount < 0)) ||
        (parts.length === 8 &&
          (typeof customBandIndexRaw !== "number" ||
            !Number.isFinite(customBandIndexRaw) ||
            customBandIndexRaw < 0))
      ) {
        return null;
      }
      return {
        kind: "advice",
        userId,
        mode,
        adviceView: adviceView as CompoAdviceView,
        targetTag,
        customBandCount: Math.trunc(customBandCount),
        customBandIndex:
          typeof customBandIndexRaw === "number"
            ? Math.trunc(customBandIndexRaw)
            : null,
      };
    }
    return null;
  }
  if (kind === "advice-clan") {
    const mode = parts[3];
    if (mode === "war" && parts.length === 5) {
      const targetTag = normalizeTag(parts[4] ?? "");
      if (!targetTag) return null;
      return {
        kind: "advice-clan",
        userId,
        mode,
        targetTag,
      };
    }
    if (mode === "actual" && parts.length === 8) {
      const targetTag = normalizeTag(parts[4] ?? "");
      const adviceView = parts[5];
      const customBandCount = Number(parts[6]);
      const customBandIndex = Number(parts[7]);
      if (
        !targetTag ||
        !COMPO_ADVICE_VIEWS.includes(adviceView as CompoAdviceView) ||
        !Number.isFinite(customBandCount) ||
        customBandCount < 0 ||
        !Number.isFinite(customBandIndex) ||
        customBandIndex < 0
      ) {
        return null;
      }
      return {
        kind: "advice-clan",
        userId,
        mode,
        targetTag,
        adviceView: adviceView as CompoAdviceView,
        customBandCount: Math.trunc(customBandCount),
        customBandIndex: Math.trunc(customBandIndex),
      };
    }
    return null;
  }
  if (kind === "view" && parts.length >= 5) {
    const target = parts[3];
    if (target === "state" && parts.length === 5) {
      const actualView = parts[4];
      if (!COMPO_ACTUAL_STATE_VIEWS.includes(actualView as CompoActualStateView)) {
        return null;
      }
      return {
        kind: "view",
        userId,
        target,
        actualView: actualView as CompoActualStateView,
      };
    }
    if (
      target === "advice" &&
      (parts.length === 6 || parts.length === 7 || parts.length === 8)
    ) {
      const adviceView = parts[4];
      const targetTag = normalizeTag(parts[5] ?? "");
      const customBandCount =
        parts.length >= 7 ? Number(parts[6]) : 0;
      const customBandIndexRaw =
        parts.length === 8 ? Number(parts[7]) : null;
      if (
        !targetTag ||
        !COMPO_ADVICE_VIEWS.includes(adviceView as CompoAdviceView) ||
        (parts.length >= 7 &&
          (!Number.isFinite(customBandCount) || customBandCount < 0)) ||
        (parts.length === 8 &&
          (typeof customBandIndexRaw !== "number" ||
            !Number.isFinite(customBandIndexRaw) ||
            customBandIndexRaw < 0))
      ) {
        return null;
      }
      return {
        kind: "view",
        userId,
        target,
        adviceView: adviceView as CompoAdviceView,
        targetTag,
        customBandCount: Math.trunc(customBandCount),
        customBandIndex:
          typeof customBandIndexRaw === "number"
            ? Math.trunc(customBandIndexRaw)
            : null,
      };
    }
    return null;
  }
  if (kind === "advice-band" && parts.length === 7) {
    const targetTag = normalizeTag(parts[3] ?? "");
    const customBandCount = Number(parts[4]);
    const customBandIndex = Number(parts[5]);
    const direction = parts[6];
    if (
      !targetTag ||
      !Number.isFinite(customBandCount) ||
      customBandCount < 0 ||
      !Number.isFinite(customBandIndex) ||
      customBandIndex < 0 ||
      (direction !== "prev" && direction !== "next")
    ) {
      return null;
    }
    return {
      kind: "advice-band",
      userId,
      targetTag,
      customBandCount: Math.trunc(customBandCount),
      customBandIndex: Math.trunc(customBandIndex),
      direction,
    };
  }
  if (kind === "place" && parts.length === 4) {
    const value = parts[3];
    if (!value) return null;
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

export function isCompoAdviceClanSelectMenuCustomId(customId: string): boolean {
  const parsed = parseCompoRefreshCustomId(customId);
  return parsed?.kind === "advice-clan";
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

function buildCompoActualViewActionRow(input: {
  userId: string;
  target: "state" | "advice";
  targetTag?: string;
  selectedView: CompoActualStateView;
  loading?: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const loading = input.loading ?? false;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    COMPO_ACTUAL_STATE_VIEWS.map((view) =>
      (() => {
        const payload =
          input.target === "advice"
            ? {
                kind: "view" as const,
                userId: input.userId,
                target: "advice" as const,
                adviceView: view as CompoAdviceView,
                targetTag: input.targetTag ?? "",
                customBandIndex: null,
                customBandCount: 0,
              }
            : {
                kind: "view" as const,
                userId: input.userId,
                target: "state" as const,
                actualView: view,
              };
        return new ButtonBuilder()
          .setCustomId(buildCompoRefreshCustomId(payload))
          .setLabel(getCompoActualStateViewLabel(view))
          .setStyle(
            input.selectedView === view
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary,
          )
          .setDisabled(loading);
      })(),
    ),
  );
}

type CompoAdviceClanChoice = {
  tag: string;
  name: string;
};

function buildCompoAdviceClanSelectRow(input: {
  userId: string;
  mode: "war" | "actual";
  targetTag: string | null;
  adviceView?: CompoAdviceView;
  customBandIndex?: number | null;
  customBandCount?: number;
  trackedClanChoices: readonly CompoAdviceClanChoice[];
  loading?: boolean;
}): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const choices = [...input.trackedClanChoices]
    .map((choice) => ({
      tag: normalizeTag(choice.tag),
      name: choice.name?.trim() || choice.tag,
    }))
    .filter((choice, index, list) => {
      if (!choice.tag) return false;
      return list.findIndex((entry) => entry.tag === choice.tag) === index;
    })
    .slice(0, 25);
  if (choices.length === 0) {
    return null;
  }

  const selectedChoice = choices.find(
    (choice) => choice.tag === normalizeTag(input.targetTag ?? ""),
  );
  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      buildCompoRefreshCustomId({
        kind: "advice-clan",
        userId: input.userId,
        mode: input.mode,
        targetTag: normalizeTag(input.targetTag ?? selectedChoice?.tag ?? choices[0]!.tag),
        adviceView: input.adviceView,
        customBandIndex: input.customBandIndex,
        customBandCount: input.customBandCount,
      }),
    )
    .setPlaceholder(
      selectedChoice
        ? `Viewing: ${normalizeCompoClanDisplayName(selectedChoice.name)} (#${selectedChoice.tag})`
        : "Select a tracked clan",
    )
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(input.loading ?? false);

  menu.addOptions(
    choices.map((choice) => ({
      label: `${normalizeCompoClanDisplayName(choice.name)} (#${choice.tag})`.slice(0, 100),
      value: choice.tag,
      default: choice.tag === selectedChoice?.tag,
    })),
  );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function extractCompoAdviceClanChoicesFromMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): CompoAdviceClanChoice[] {
  const rows = interaction.message.components.map(
    (row) => row.toJSON() as APIActionRowComponent<APIComponentInMessageActionRow>,
  );
  const selectRow = rows.find((row) =>
    row.components.some(
      (component) =>
        component.type === ComponentType.StringSelect &&
        "custom_id" in component &&
        typeof component.custom_id === "string" &&
        component.custom_id.startsWith(`${COMPO_REFRESH_PREFIX}:advice-clan:`),
    ),
  );
  if (!selectRow) {
    return [];
  }
  const select = selectRow.components.find(
    (component) =>
      component.type === ComponentType.StringSelect &&
      "options" in component,
  );
  if (!select || !("options" in select) || !Array.isArray(select.options)) {
    return [];
  }
  return select.options
    .map((option) => ({
      tag: normalizeTag(String(option.value ?? "")),
      name: (() => {
        const tag = normalizeTag(String(option.value ?? ""));
        const label = String(option.label ?? "").trim();
        const suffix = tag ? ` (#${tag})` : "";
        return suffix && label.endsWith(suffix)
          ? label.slice(0, -suffix.length).trimEnd()
          : label;
      })(),
    }))
    .filter((choice) => Boolean(choice.tag));
}

function buildCompoAdviceViewActionRow(input: {
  userId: string;
  targetTag: string;
  selectedView: CompoAdviceView;
  customBandIndex: number | null;
  customBandCount: number;
  loading?: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const loading = input.loading ?? false;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    COMPO_ADVICE_VIEWS.map((view) =>
      new ButtonBuilder()
        .setCustomId(
          buildCompoRefreshCustomId({
            kind: "view",
            userId: input.userId,
            target: "advice",
            adviceView: view,
            targetTag: input.targetTag,
            customBandIndex: input.customBandIndex,
            customBandCount: input.customBandCount,
          }),
        )
        .setLabel(COMPO_ADVICE_VIEW_LABELS[view])
        .setStyle(
          input.selectedView === view
            ? ButtonStyle.Primary
            : ButtonStyle.Secondary,
        )
        .setDisabled(loading),
    ),
  );
}

function buildCompoAdviceBandActionRow(input: {
  userId: string;
  targetTag: string;
  customBandIndex: number;
  customBandCount: number;
  loading?: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const loading = input.loading ?? false;
  const canStepPrev = input.customBandIndex > 0;
  const canStepNext = input.customBandIndex < input.customBandCount - 1;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildCompoRefreshCustomId({
          kind: "advice-band",
          userId: input.userId,
          targetTag: input.targetTag,
          customBandCount: input.customBandCount,
          customBandIndex: input.customBandIndex,
          direction: "prev",
        }),
      )
      .setLabel("-")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(loading || !canStepPrev),
    new ButtonBuilder()
      .setCustomId(
        buildCompoRefreshCustomId({
          kind: "advice-band",
          userId: input.userId,
          targetTag: input.targetTag,
          customBandCount: input.customBandCount,
          customBandIndex: input.customBandIndex,
          direction: "next",
        }),
      )
      .setLabel("+")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(loading || !canStepNext),
  );
}

function extractSupplementalRowsFromMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
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
    )
    .filter(
      (row) =>
        !row.components.some(
          (component) =>
            "custom_id" in component &&
            typeof component.custom_id === "string" &&
            component.custom_id.startsWith(`${COMPO_REFRESH_PREFIX}:advice-clan:`),
        ),
    );
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

function buildCompoHeatMapRefRows(
  heatMapRefs: readonly HeatMapRef[],
  matchPercentByBandKey?: ReadonlyMap<string, string>,
): string[][] {
  return buildHeatMapRefDisplayRows({
    heatMapRefs,
    matchPercentByBandKey,
  });
}

function buildCompoHeatMapRefCopyText(rows: readonly string[][]): string {
  return buildHeatMapRefDisplayText(rows);
}

function buildCompoHeatMapRefCopyCustomId(userId: string): string {
  return `${COMPO_HEATMAPREF_COPY_PREFIX}:${userId}`;
}

export function isCompoHeatMapRefCopyButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${COMPO_HEATMAPREF_COPY_PREFIX}:`);
}

function buildCompoHeatMapRefCopyButtonRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCompoHeatMapRefCopyCustomId(userId))
      .setLabel("Copy Table")
      .setStyle(ButtonStyle.Primary),
  );
}

type CompoRenderPayload = {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: Array<{
    attachment: Buffer;
    name: string;
  }>;
  components?: Array<
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  >;
};

function buildCompoStatePayloadFromRows(input: {
  mode: GoogleSheetMode;
  stateRows: string[][];
  contentLines: string[];
  titleLabel?: string;
}): CompoRenderPayload {
  const title = input.titleLabel
    ? `ALLIANCE STATE (${input.mode} - ${input.titleLabel})`
    : `ALLIANCE STATE (${input.mode})`;
  return {
    content: input.contentLines.join("\n"),
    files: [
      {
        attachment: renderStatePng(title, input.stateRows),
        name: `compo-state-${input.mode}.png`,
      },
    ],
  };
}

function buildCompoHeatMapRefPayloadFromRows(input: {
  rows: string[][];
  components?: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>>;
}): CompoRenderPayload {
  return {
    files: [
      {
        attachment: renderStatePng("HEATMAP REF", input.rows),
        name: "compo-heatmapref.png",
      },
    ],
    components: input.components,
  };
}

function formatSignedValue(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value > 0 ? `+${value}` : `${value}`;
}

function formatAdviceScore(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function buildCompoAdviceEmbed(input: { advice: CompoAdviceReadResult }): EmbedBuilder {
  const title = input.advice.clanTag
    ? `${normalizeCompoClanDisplayName(input.advice.clanName ?? input.advice.clanTag)} (${input.advice.clanTag}) - ${input.advice.mode.toUpperCase()}`
    : `Compo Advice - ${input.advice.mode.toUpperCase()}`;

  if (input.advice.kind === "ready") {
    const summary = input.advice.summary;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(
        [
          `Advice View: **${summary.viewLabel}**`,
          `Target Band: **${summary.currentBandLabel}**`,
          `Current Score: **${formatAdviceScore(summary.currentScore)}**`,
        ].join("\n"),
      );
    const currentDeltas = [
      `TH18: ${formatSignedValue(summary.currentProjection.deltaByBucket.TH18)}`,
      `TH17: ${formatSignedValue(summary.currentProjection.deltaByBucket.TH17)}`,
      `TH16: ${formatSignedValue(summary.currentProjection.deltaByBucket.TH16)}`,
      `TH15: ${formatSignedValue(summary.currentProjection.deltaByBucket.TH15)}`,
      `TH14: ${formatSignedValue(summary.currentProjection.deltaByBucket.TH14)}`,
      `<=TH13: ${formatSignedValue(summary.currentProjection.deltaByBucket["<=TH13"])}`,
    ].join("\n");

    const recommendationLines = [
      summary.recommendationText,
      `Resulting Score: ${formatAdviceScore(summary.resultingScore)}`,
      `Resulting Band: ${summary.resultingBandLabel}`,
    ];
    if (summary.statusText) {
      recommendationLines.push(summary.statusText);
    }

    embed.addFields(
      {
        name: "Overview",
        value: [
          `Members: ${summary.currentProjection.memberCount} / 50`,
          `Rushed: ${input.advice.rushedCount}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Current Deltas",
        value: currentDeltas,
        inline: false,
      },
      {
        name: "Best Recommendation",
        value: recommendationLines.join("\n"),
        inline: false,
      },
      {
        name: "Alternates",
        value:
          summary.alternateTexts.length > 0
            ? summary.alternateTexts.map((line) => `- ${line}`).join("\n")
            : "None",
        inline: false,
      },
    );

    if (input.advice.refreshLine) {
      embed.addFields({
        name: "Snapshot",
        value: input.advice.refreshLine,
        inline: false,
      });
    }
    return embed;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      [
        `Advice View: **${COMPO_ADVICE_VIEW_LABELS[input.advice.selectedView]}**`,
        input.advice.message,
      ].join("\n"),
    );

  if (input.advice.refreshLine) {
    embed.addFields({
      name: "Snapshot",
      value: input.advice.refreshLine,
      inline: false,
    });
  }
  return embed;
}

function buildCompoAdviceResponsePayload(input: {
  advice: CompoAdviceReadResult;
}): CompoRenderPayload {
  return {
    embeds: [buildCompoAdviceEmbed({ advice: input.advice })],
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
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00110", "00100"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ":": ["00000", "00110", "00110", "00000", "00110", "00110", "00000"],
  "<": ["00010", "00100", "01000", "10000", "01000", "00100", "00010"],
  "=": ["00000", "11111", "00000", "11111", "00000", "00000", "00000"],
  "%": ["11001", "11010", "00100", "01000", "10011", "10011", "00000"],
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

function renderStatePng(titleText: string, rows: string[][]): Buffer {
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
  drawText(margin, margin + 2, titleText, title);

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
  refreshPayload: Extract<CompoRefreshPayload, { kind: "state" | "advice" | "place" }>;
  loading: boolean;
  adviceClanChoices?: readonly CompoAdviceClanChoice[];
  selectedAdviceClanTag?: string | null;
  supplementalRows?: Array<
    APIActionRowComponent<APIComponentInMessageActionRow>
  >;
}): Array<
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>
  | APIActionRowComponent<APIComponentInMessageActionRow>
> {
  const refreshCustomId = buildCompoRefreshCustomId(input.refreshPayload);
  const components: Array<
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
    | APIActionRowComponent<APIComponentInMessageActionRow>
  > = [buildCompoRefreshActionRow(refreshCustomId, { loading: input.loading })];
  if (input.refreshPayload.kind === "state" && input.refreshPayload.mode === "actual") {
    components.push(
      buildCompoActualViewActionRow({
        userId: input.refreshPayload.userId,
        target: "state",
        selectedView: input.refreshPayload.actualView,
        loading: input.loading,
      }),
    );
  }
  if (input.refreshPayload.kind === "advice" && input.refreshPayload.mode === "actual") {
    const clanRow = buildCompoAdviceClanSelectRow({
      userId: input.refreshPayload.userId,
      mode: input.refreshPayload.mode,
      targetTag: input.selectedAdviceClanTag ?? input.refreshPayload.targetTag,
      adviceView: input.refreshPayload.adviceView,
      customBandIndex: input.refreshPayload.customBandIndex,
      customBandCount: input.refreshPayload.customBandCount,
      trackedClanChoices: input.adviceClanChoices ?? [],
      loading: input.loading,
    });
    if (clanRow) {
      components.push(clanRow);
    }
    components.push(
      buildCompoAdviceViewActionRow({
        userId: input.refreshPayload.userId,
        targetTag: input.refreshPayload.targetTag,
        selectedView: input.refreshPayload.adviceView,
        customBandIndex: input.refreshPayload.customBandIndex,
        customBandCount: input.refreshPayload.customBandCount,
        loading: input.loading,
      }),
    );
    if (
      input.refreshPayload.adviceView === "custom" &&
      input.refreshPayload.customBandIndex !== null &&
      input.refreshPayload.customBandCount > 0
    ) {
      components.push(
        buildCompoAdviceBandActionRow({
          userId: input.refreshPayload.userId,
          targetTag: input.refreshPayload.targetTag,
          customBandIndex: input.refreshPayload.customBandIndex,
          customBandCount: input.refreshPayload.customBandCount,
          loading: input.loading,
        }),
      );
    }
  }
  if (input.refreshPayload.kind === "advice" && input.refreshPayload.mode === "war") {
    const clanRow = buildCompoAdviceClanSelectRow({
      userId: input.refreshPayload.userId,
      mode: input.refreshPayload.mode,
      targetTag: input.selectedAdviceClanTag ?? input.refreshPayload.targetTag,
      trackedClanChoices: input.adviceClanChoices ?? [],
      loading: input.loading,
    });
    if (clanRow) {
      components.push(clanRow);
    }
  }
  if (input.supplementalRows && input.supplementalRows.length > 0) {
    components.push(...input.supplementalRows);
  }
  return components.slice(0, 5);
}

function mapCompoActualStateErrorToMessage(action: "load" | "refresh"): string {
  return action === "refresh"
    ? "Failed to refresh DB-backed ACTUAL state. Try again in a moment."
    : "Failed to load DB-backed ACTUAL state. Try again in a moment.";
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

function mapCompoAdviceErrorToMessage(action: "load" | "refresh"): string {
  return action === "refresh"
    ? "Failed to refresh DB-backed compo advice. Try again in a moment."
    : "Failed to load DB-backed compo advice. Try again in a moment.";
}

function mapCompoHeatMapRefErrorToMessage(action: "load" | "refresh"): string {
  return action === "refresh"
    ? "Failed to refresh HeatMapRef snapshot. Try again in a moment."
    : "Failed to load HeatMapRef snapshot. Try again in a moment.";
}

function getCompoRefreshFailureMessage(payload: CompoRefreshPayload): string {
  if (payload.kind === "state" && payload.mode === "war") {
    return mapCompoWarStateErrorToMessage("refresh");
  }
  if (payload.kind === "state") {
    return mapCompoActualStateErrorToMessage("refresh");
  }
  if (payload.kind === "advice") {
    return mapCompoAdviceErrorToMessage("refresh");
  }
  if (payload.kind === "advice-band") {
    return mapCompoAdviceErrorToMessage("refresh");
  }
  if (payload.kind === "view" && payload.target === "advice") {
    return mapCompoAdviceErrorToMessage("refresh");
  }
  if (payload.kind === "view") {
    return mapCompoActualStateErrorToMessage("refresh");
  }
  if (payload.kind === "place") {
    return mapCompoPlaceErrorToMessage("refresh");
  }
  return "Failed to refresh compo view. Try again in a moment.";
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
  const adviceClanChoices = extractCompoAdviceClanChoicesFromMessage(interaction);
  let adviceRefreshPayload: Extract<CompoRefreshPayload, { kind: "advice" }> | null = null;
  let loadingRefreshPayload: Extract<
    CompoRefreshPayload,
    { kind: "state" | "advice" | "place" }
  >;
  if (parsed.kind === "view" && parsed.target === "advice") {
    adviceRefreshPayload = {
      kind: "advice",
      userId: parsed.userId,
      mode: "actual",
      adviceView: parsed.adviceView,
      targetTag: parsed.targetTag,
      customBandIndex: parsed.customBandIndex ?? 0,
      customBandCount: parsed.customBandCount,
    };
    loadingRefreshPayload = adviceRefreshPayload;
  } else if (parsed.kind === "advice-band") {
    const nextBandIndex = stepCompoAdviceCustomBandIndexByCount({
      currentBandIndex: parsed.customBandIndex,
      bandCount: parsed.customBandCount,
      direction: parsed.direction,
    });
    adviceRefreshPayload = {
      kind: "advice",
      userId: parsed.userId,
      mode: "actual",
      adviceView: "custom",
      targetTag: parsed.targetTag,
      customBandIndex: nextBandIndex,
      customBandCount: parsed.customBandCount,
    };
    loadingRefreshPayload = adviceRefreshPayload;
  } else if (parsed.kind === "advice") {
    adviceRefreshPayload = parsed;
    loadingRefreshPayload = parsed;
  } else if (parsed.kind === "advice-clan") {
    adviceRefreshPayload =
      parsed.mode === "actual"
        ? {
            kind: "advice",
            userId: parsed.userId,
            mode: "actual",
            adviceView: parsed.adviceView ?? "auto",
            targetTag: parsed.targetTag,
            customBandIndex: parsed.customBandIndex ?? 0,
            customBandCount: parsed.customBandCount ?? 0,
          }
        : {
            kind: "advice",
            userId: parsed.userId,
            mode: "war",
            targetTag: parsed.targetTag,
          };
    loadingRefreshPayload = adviceRefreshPayload;
  } else if (parsed.kind === "view" && parsed.target === "state") {
    loadingRefreshPayload = {
      kind: "state",
      userId: parsed.userId,
      mode: "actual",
      actualView: parsed.actualView,
    };
  } else {
    loadingRefreshPayload = parsed;
  }
  await interaction.update({
    components: buildCompoRefreshComponents({
      refreshPayload: loadingRefreshPayload,
      loading: true,
      adviceClanChoices,
      selectedAdviceClanTag:
        adviceRefreshPayload?.targetTag ??
        (parsed.kind === "advice-clan" ? parsed.targetTag : null),
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
        const actualState = await new CompoActualStateService().refreshState(
          interaction.guildId ?? null,
          {
            view: parsed.actualView,
          },
        );
        payload = actualState.stateRows
          ? buildCompoStatePayloadFromRows({
              mode: "actual",
              stateRows: actualState.stateRows,
              contentLines: actualState.contentLines,
              titleLabel: getCompoActualStateViewLabel(
                actualState.view ?? "raw",
              ).toUpperCase(),
            })
          : {
              content: actualState.contentLines.join("\n"),
            };
      }
      await interaction.editReply({
        ...payload,
        components: buildCompoRefreshComponents({
          refreshPayload: parsed,
          loading: false,
          adviceClanChoices,
          selectedAdviceClanTag: null,
          supplementalRows,
        }),
      });
      return;
    }

    if (adviceRefreshPayload) {
      const adviceService = new CompoAdviceService();
      const advice = await adviceService.refreshAdvice({
        guildId: interaction.guildId ?? null,
        targetTag: adviceRefreshPayload.targetTag,
        mode: adviceRefreshPayload.mode,
        view:
          adviceRefreshPayload.mode === "actual"
            ? adviceRefreshPayload.adviceView
            : "raw",
        customBandIndex:
          adviceRefreshPayload.mode === "actual"
            ? adviceRefreshPayload.customBandIndex
            : null,
      });
      await interaction.editReply({
        ...buildCompoAdviceResponsePayload({ advice }),
        components: buildCompoRefreshComponents({
          refreshPayload: adviceRefreshPayload,
          loading: false,
          adviceClanChoices: advice.trackedClanChoices,
          selectedAdviceClanTag: advice.clanTag,
          supplementalRows,
        }),
      });
      return;
    }

    if (parsed.kind === "view") {
      if (parsed.target === "state") {
        const actualState = await new CompoActualStateService().readState(
          interaction.guildId ?? null,
          {
            view: parsed.actualView,
          },
        );
        const payload = actualState.stateRows
          ? buildCompoStatePayloadFromRows({
              mode: "actual",
              stateRows: actualState.stateRows,
              contentLines: actualState.contentLines,
              titleLabel: getCompoActualStateViewLabel(
                actualState.view ?? "raw",
              ).toUpperCase(),
            })
          : {
              content: actualState.contentLines.join("\n"),
            };
        await interaction.editReply({
          ...payload,
          components: buildCompoRefreshComponents({
            refreshPayload: {
              kind: "state",
              userId: parsed.userId,
              mode: "actual",
              actualView: parsed.actualView,
            },
            loading: false,
            adviceClanChoices,
            selectedAdviceClanTag: null,
            supplementalRows,
          }),
        });
        return;
      }
      return;
    }

    if (parsed.kind === "place") {
      const bucket = getCompoWarDisplayBucket(parsed.weight);
      if (!bucket) {
        throw new Error("Invalid placement bucket for refresh.");
      }
      const placeResult = await new CompoPlaceService().refreshPlace(
        parsed.weight,
        bucket,
        interaction.guildId ?? null,
      );
      await interaction.editReply({
        content: placeResult.content,
        embeds: placeResult.embeds,
        components: buildCompoRefreshComponents({
          refreshPayload: {
            kind: "place",
            userId: interaction.user.id,
            weight: parsed.weight,
          },
          loading: false,
          adviceClanChoices,
          selectedAdviceClanTag: null,
          supplementalRows,
        }),
      });
    }
  } catch (err) {
    console.error(`compo refresh button failed: ${formatError(err)}`);
    await interaction.editReply({
      components: buildCompoRefreshComponents({
        refreshPayload: loadingRefreshPayload,
        loading: false,
        adviceClanChoices,
        selectedAdviceClanTag: adviceRefreshPayload?.targetTag ?? null,
        supplementalRows,
      }),
    });
    await interaction.followUp({
      ephemeral: true,
      content: getCompoRefreshFailureMessage(parsed),
    });
  }
}

/** Purpose: reply with the copy-ready HeatMapRef table text for the requester. */
export async function handleCompoHeatMapRefCopyButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = String(interaction.customId ?? "");
  if (!isCompoHeatMapRefCopyButtonCustomId(customId)) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        ephemeral: true,
        content: "Invalid HeatMapRef copy action.",
      });
    }
    return;
  }

  const requesterId = customId.split(":")[1] ?? "";
  if (interaction.user.id !== requesterId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this copy button.",
    });
    return;
  }

  try {
    await interaction.deferReply({ ephemeral: true });
    const display = await new HeatMapRefDisplayService().readHeatMapRefDisplayTable();
    const copyText = buildCompoHeatMapRefCopyText(display.rows);
    await interaction.editReply({
      content: copyText,
    });
  } catch (error) {
    console.error(`compo heatmapref copy button failed: ${formatError(error)}`);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: "Failed to build HeatMapRef copy text. Try again in a moment.",
      }).catch(() => undefined);
      return;
    }
    await interaction.reply({
      ephemeral: true,
      content: "Failed to build HeatMapRef copy text. Try again in a moment.",
    });
  }
}

export async function handleCompoAdviceClanSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const parsed = parseCompoRefreshCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "advice-clan") {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        ephemeral: true,
        content: "Invalid advice clan selection.",
      });
    }
    return;
  }
  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command requester can use this clan selector.",
    });
    return;
  }

  const selectedTargetTag = normalizeTag(interaction.values[0] ?? "");
  if (!selectedTargetTag) {
    await interaction.reply({
      ephemeral: true,
      content: "Invalid clan selection.",
    });
    return;
  }

  const supplementalRows = extractSupplementalRowsFromMessage(interaction);
  const adviceClanChoices = extractCompoAdviceClanChoicesFromMessage(interaction);
  const adviceRefreshPayload: Extract<CompoRefreshPayload, { kind: "advice" }> =
    parsed.mode === "actual"
      ? {
          kind: "advice",
          userId: parsed.userId,
          mode: "actual",
          adviceView: parsed.adviceView ?? "auto",
          targetTag: selectedTargetTag,
          customBandIndex: parsed.customBandIndex ?? 0,
          customBandCount: parsed.customBandCount ?? 0,
        }
      : {
          kind: "advice",
          userId: parsed.userId,
          mode: "war",
          targetTag: selectedTargetTag,
        };

  await interaction.update({
    components: buildCompoRefreshComponents({
      refreshPayload: adviceRefreshPayload,
      loading: true,
      adviceClanChoices,
      selectedAdviceClanTag: selectedTargetTag,
      supplementalRows,
    }),
  });

  try {
    const advice = await new CompoAdviceService().refreshAdvice({
      guildId: interaction.guildId ?? null,
      targetTag: selectedTargetTag,
      mode: parsed.mode,
      view: parsed.mode === "actual" ? parsed.adviceView : "raw",
      customBandIndex:
        parsed.mode === "actual" ? parsed.customBandIndex ?? 0 : null,
    });
    await interaction.editReply({
      ...buildCompoAdviceResponsePayload({ advice }),
      components: buildCompoRefreshComponents({
        refreshPayload: adviceRefreshPayload,
        loading: false,
        adviceClanChoices: advice.trackedClanChoices,
        selectedAdviceClanTag: advice.clanTag ?? selectedTargetTag,
        supplementalRows,
      }),
    });
  } catch (err) {
    console.error(`compo advice clan selector failed: ${formatError(err)}`);
    await interaction.editReply({
      components: buildCompoRefreshComponents({
        refreshPayload: adviceRefreshPayload,
        loading: false,
        adviceClanChoices,
        selectedAdviceClanTag: selectedTargetTag,
        supplementalRows,
      }),
    });
    await interaction.followUp({
      ephemeral: true,
      content: getCompoRefreshFailureMessage(adviceRefreshPayload),
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
      name: "heatmapref",
      description: "Show the persisted HeatMapRef table as an image with copyable table text",
      type: ApplicationCommandOptionType.Subcommand,
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
        const adviceService = new CompoAdviceService();
        const advice = await adviceService.readAdvice({
          guildId: interaction.guildId ?? null,
          targetTag,
          mode,
        });
        logCompoStage(interaction, "db_fetch", {
          entity: mode === "war" ? "tracked_war_advice_source" : "actual_compo_advice_source",
          mode,
          trackedClans: advice.trackedClanTags.length,
        });
        logCompoStage(interaction, "computation_complete", {
          result: "advice_rendered",
          mode,
        });
        const adviceRefreshPayload =
          mode === "actual"
            ? {
                kind: "advice" as const,
                userId: interaction.user.id,
                mode: "actual" as const,
                adviceView: advice.selectedView,
                targetTag,
                customBandIndex:
                  advice.kind === "ready"
                    ? advice.summary.selectedCustomBandIndex
                    : null,
                customBandCount:
                  advice.kind === "ready" ? advice.summary.customBandCount : 0,
              }
            : {
                kind: "advice" as const,
                userId: interaction.user.id,
                mode: "war" as const,
                targetTag,
              };
        await interaction.editReply({
          ...buildCompoAdviceResponsePayload({ advice }),
          components: buildCompoRefreshComponents({
            refreshPayload: adviceRefreshPayload,
            loading: false,
            adviceClanChoices: advice.trackedClanChoices,
            selectedAdviceClanTag: advice.clanTag,
          }),
        });
        logCompoStage(interaction, "response_sent", {
          reason: "advice_rendered",
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
                const actualState = await new CompoActualStateService().readState(
                  interaction.guildId ?? null,
                  {
                    view: "raw",
                  },
                );
                logCompoStage(interaction, "db_fetch", {
                  entity: "actual_compo_state_source",
                  mode,
                  trackedClans: actualState.trackedClanTags.length,
                  renderableRows: actualState.renderableClanTags.length,
                });
                logCompoStage(interaction, "db_fetch", {
                  entity: "heat_map_ref",
                  mode,
                  result: actualState.stateRows ? "found" : "partial_or_missing",
                });
                return actualState.stateRows
                  ? buildCompoStatePayloadFromRows({
                      mode: "actual",
                      stateRows: actualState.stateRows,
                      contentLines: actualState.contentLines,
                      titleLabel: getCompoActualStateViewLabel(
                        actualState.view ?? "raw",
                      ).toUpperCase(),
                    })
                  : {
                      content: actualState.contentLines.join("\n"),
                    };
              })();
        logCompoStage(interaction, "computation_complete", {
          result: "state_rendered",
          mode,
        });
        logCompoStage(interaction, "response_build", { reason: "state_png" });
        await interaction.editReply({
          ...payload,
          components: buildCompoRefreshComponents({
            refreshPayload:
              mode === "actual"
                ? {
                    kind: "state",
                    userId: interaction.user.id,
                    mode: "actual",
                    actualView: "raw",
                  }
                : {
                    kind: "state",
                    userId: interaction.user.id,
                    mode: "war",
                  },
            loading: false,
          }),
        });
        logCompoStage(interaction, "response_sent", { reason: "state_png" });
        return;
      }

      if (subcommand === "heatmapref") {
        logCompoStage(interaction, "computation_start", { mode });
        const display = await new HeatMapRefDisplayService().readHeatMapRefDisplayTable();
        logCompoStage(interaction, "db_fetch", {
          entity: "heat_map_ref",
          mode,
          rows: Math.max(0, display.rows.length - 1),
        });
        logCompoStage(interaction, "computation_complete", {
          result: "heatmapref_rendered",
          mode,
          rows: Math.max(0, display.rows.length - 1),
        });
        logCompoStage(interaction, "response_build", { reason: "heatmapref_png" });
        await interaction.editReply({
          ...buildCompoHeatMapRefPayloadFromRows({
            rows: display.rows,
            components: [buildCompoHeatMapRefCopyButtonRow(interaction.user.id)],
          }),
        });
        logCompoStage(interaction, "response_sent", { reason: "heatmapref_png" });
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
            refreshPayload: {
              kind: "place",
              userId: interaction.user.id,
              weight: inputWeight,
            },
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
            : getSubcommandSafe(interaction) === "state"
              ? mapCompoActualStateErrorToMessage("load")
              : getSubcommandSafe(interaction) === "heatmapref"
                ? mapCompoHeatMapRefErrorToMessage("load")
              : getSubcommandSafe(interaction) === "place"
                ? mapCompoPlaceErrorToMessage("load")
                : getSubcommandSafe(interaction) === "advice"
                  ? mapCompoAdviceErrorToMessage("load")
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
export const buildCompoHeatMapRefRowsForTest = buildCompoHeatMapRefRows;
export const buildCompoHeatMapRefCopyTextForTest = buildCompoHeatMapRefCopyText;
export const buildCompoHeatMapRefCopyCustomIdForTest = buildCompoHeatMapRefCopyCustomId;
export const isCompoHeatMapRefCopyButtonCustomIdForTest = isCompoHeatMapRefCopyButtonCustomId;
export const toGlyphSafeTextForTest = toGlyphSafeText;
export const getModeRowsForTest = getModeRows;
export const getAbsoluteSheetRowNumberForTest = getAbsoluteSheetRowNumber;
export const mapCompoSheetErrorToMessageForTest = mapCompoSheetErrorToMessage;
export const buildCompoRefreshCustomIdForTest = buildCompoRefreshCustomId;
export const parseCompoRefreshCustomIdForTest = parseCompoRefreshCustomId;
export const parseWeightInputForTest = parseWeightInput;
