import { EmbedBuilder } from "discord.js";
import { toPositiveCompoWeight } from "../../helper/compoActualWeight";

// Pure link-list render/layout helpers.
// Keep command registration, DB calls, and interaction routing in Link.ts.

export const LINK_LIST_SORT_MODE_CYCLE = [
  "discord",
  "weight",
  "player-tags",
  "player",
  "clan-rank",
  "inactivity",
] as const;

export type LinkListSortMode = (typeof LINK_LIST_SORT_MODE_CYCLE)[number];

export const LINK_LIST_DEFAULT_SORT_MODE: LinkListSortMode = "discord";

export type LinkListColumnId =
  | "townhall"
  | "player-name"
  | "discord-display-name"
  | "discord-username"
  | "weight"
  | "inactivity"
  | "clan-role"
  | "player-tag";

export const MAX_LINK_LIST_DISPLAY_NAME_CHARS = 15;
export const MAX_PLAYER_NAME_CHARS = MAX_LINK_LIST_DISPLAY_NAME_CHARS;
export const MAX_IDENTITY_CHARS = MAX_LINK_LIST_DISPLAY_NAME_CHARS;
export const WEIGHT_PLACEHOLDER = "\u2014";

export const LINK_LIST_SELECTABLE_COLUMNS: readonly LinkListColumnId[] = [
  "townhall",
  "player-name",
  "discord-display-name",
  "discord-username",
  "weight",
  "inactivity",
  "clan-role",
  "player-tag",
];

export const LINK_LIST_COLUMN_LABELS: Record<LinkListColumnId, string> = {
  townhall: "Town Hall",
  "player-name": "Player Name",
  "discord-display-name": "Discord Display",
  "discord-username": "Discord Username",
  weight: "Weight",
  inactivity: "Inactivity",
  "clan-role": "Clan Role",
  "player-tag": "Player Tag",
};

const LINK_LIST_COLUMN_ALIASES: Record<LinkListColumnId, string> = {
  townhall: "th",
  "player-name": "pn",
  "discord-display-name": "dd",
  "discord-username": "du",
  weight: "wt",
  inactivity: "ia",
  "clan-role": "cr",
  "player-tag": "pt",
};

const LINK_LIST_COLUMN_ALIAS_TO_ID: Record<string, LinkListColumnId> = {
  th: "townhall",
  pn: "player-name",
  dd: "discord-display-name",
  du: "discord-username",
  wt: "weight",
  ia: "inactivity",
  cr: "clan-role",
  pt: "player-tag",
};

const LINK_LIST_LINKED_STATUS_EMOJI = "\u2705";
const LINK_LIST_UNLINKED_STATUS_EMOJI = "\u274C";
const EMBED_DESCRIPTION_LIMIT = 4096;
const LINK_LIST_MAX_EMBEDS = 2;
const LINK_LIST_MAX_TOTAL_DESCRIPTION_CHARS = 5200;
const LINK_LIST_EMBED_DESCRIPTION_SAFE_LIMIT = 1500;
const LINK_LIST_TRIM_SUFFIX_TEMPLATE =
  "...and {hiddenRows} more rows hidden. Use another sort/filter or Refresh Data.";
const LINK_LIST_EMBED_COLOR = 0x5865f2;

export type LinkListRowViewModel = {
  townHallLabel: string;
  playerName: string;
  displayValue: string | null;
  discordDisplayName: string;
  discordUsername: string;
  weightLabel: string;
  inactivityLabel: string;
  clanRoleLabel: string;
  playerTag: string;
  leftBadgePrefix?: string | null;
  rightMarker?: string | null;
  isLinked: boolean;
};

export type LinkListStatusIcons = {
  linked: string;
  unlinked: string;
};

export type LinkListDescriptionRenderResult = {
  embeds: EmbedBuilder[];
  renderedRows: number;
  hiddenRows: number;
  embedCount: number;
  totalDescriptionChars: number;
  trimmed: boolean;
};

export function sanitizeTableText(input: string): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeInlineCodeCell(input: string): string {
  const normalized = sanitizeTableText(input);
  return normalized.replace(/`/g, "\u02BC").replace(/\u200B/g, "").trim();
}

export function truncateWithEllipsis(input: string, maxLength: number): string {
  const normalized = sanitizeTableText(input);
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 3) return normalized.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function normalizeLinkListSortMode(
  input: string | null | undefined,
): LinkListSortMode {
  const value = String(input ?? "").trim().toLowerCase();
  if (
    value === "discord" ||
    value === "weight" ||
    value === "player-tags" ||
    value === "player" ||
    value === "clan-rank" ||
    value === "inactivity"
  ) {
    return value;
  }
  return LINK_LIST_DEFAULT_SORT_MODE;
}

export function getLinkListSortModeLabel(mode: LinkListSortMode): string {
  if (mode === "weight") return "Weight Desc";
  if (mode === "player-tags") return "Player Tags";
  if (mode === "player") return "Player Name";
  if (mode === "clan-rank") return "Clan Role";
  if (mode === "inactivity") return "Inactivity";
  return "Discord Name";
}

export function getNextLinkListSortMode(mode: LinkListSortMode): LinkListSortMode {
  const currentIndex = LINK_LIST_SORT_MODE_CYCLE.indexOf(mode);
  const nextIndex =
    currentIndex >= 0
      ? (currentIndex + 1) % LINK_LIST_SORT_MODE_CYCLE.length
      : 0;
  return LINK_LIST_SORT_MODE_CYCLE[nextIndex];
}

export function getLinkListSelectableColumns(): LinkListColumnId[] {
  return [...LINK_LIST_SELECTABLE_COLUMNS];
}

export function getLinkListColumnLabel(columnId: LinkListColumnId): string {
  return LINK_LIST_COLUMN_LABELS[columnId];
}

export function normalizeLinkListColumnId(
  input: string | null | undefined,
): LinkListColumnId | null {
  const normalized = sanitizeTableText(String(input ?? "")).toLowerCase();
  if (!normalized) return null;
  if (Object.prototype.hasOwnProperty.call(LINK_LIST_COLUMN_LABELS, normalized)) {
    return normalized as LinkListColumnId;
  }
  const alias = normalized.replace(/[\s\-_]+/g, "");
  return LINK_LIST_COLUMN_ALIAS_TO_ID[alias] ?? null;
}

export function normalizeLinkListColumns(
  input: readonly string[] | null | undefined,
  sortMode: LinkListSortMode = LINK_LIST_DEFAULT_SORT_MODE,
): LinkListColumnId[] {
  const result: LinkListColumnId[] = [];
  const seen = new Set<LinkListColumnId>();
  for (const rawColumn of input ?? []) {
    const columnId = normalizeLinkListColumnId(rawColumn);
    if (!columnId || seen.has(columnId)) continue;
    seen.add(columnId);
    result.push(columnId);
    if (result.length >= 5) break;
  }
  if (result.length === 0) {
    return getLinkListDefaultColumnsForSortMode(sortMode);
  }
  return result;
}

export function isLinkListDefaultColumnsForSortMode(
  columns: readonly LinkListColumnId[],
  sortMode: LinkListSortMode,
): boolean {
  const normalizedColumns = normalizeLinkListColumns(columns, sortMode);
  const defaultColumns = getLinkListDefaultColumnsForSortMode(sortMode);
  return (
    normalizedColumns.length === defaultColumns.length &&
    normalizedColumns.every((columnId, index) => columnId === defaultColumns[index])
  );
}

export function encodeLinkListColumns(columns: readonly LinkListColumnId[]): string {
  return normalizeLinkListColumns(columns)
    .map((columnId) => LINK_LIST_COLUMN_ALIASES[columnId])
    .join(".");
}

export function parseLinkListColumnsField(
  input: string | null | undefined,
  sortMode: LinkListSortMode = LINK_LIST_DEFAULT_SORT_MODE,
): LinkListColumnId[] {
  const parts = String(input ?? "")
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return normalizeLinkListColumns(parts, sortMode);
}

export function buildLinkListOrderedColumnsFromSelection(input: {
  previousColumns: readonly LinkListColumnId[];
  selectedColumns: readonly string[];
  sortMode: LinkListSortMode;
}): LinkListColumnId[] {
  const previousColumns = normalizeLinkListColumns(input.previousColumns, input.sortMode);
  const selectedColumns = normalizeLinkListColumns(input.selectedColumns, input.sortMode);
  const selectedSet = new Set(selectedColumns);
  const ordered: LinkListColumnId[] = [];

  for (const columnId of previousColumns) {
    if (!selectedSet.has(columnId) || ordered.includes(columnId)) continue;
    ordered.push(columnId);
    if (ordered.length >= 5) return ordered;
  }

  for (const columnId of selectedColumns) {
    if (ordered.includes(columnId)) continue;
    ordered.push(columnId);
    if (ordered.length >= 5) break;
  }

  return ordered.length > 0
    ? ordered
    : getLinkListDefaultColumnsForSortMode(input.sortMode);
}

export function getLinkListDefaultColumnsForSortMode(
  sortMode: LinkListSortMode,
): LinkListColumnId[] {
  if (sortMode === "discord") {
    return ["townhall", "player-name", "discord-display-name"];
  }
  if (sortMode === "weight") {
    return ["townhall", "player-name", "weight"];
  }
  if (sortMode === "player-tags") {
    return ["townhall", "player-name", "player-tag"];
  }
  if (sortMode === "player") {
    return ["townhall", "player-name"];
  }
  if (sortMode === "clan-rank") {
    return ["townhall", "player-name", "clan-role"];
  }
  if (sortMode === "inactivity") {
    return ["townhall", "player-name", "inactivity"];
  }
  return ["townhall", "player-name", "discord-display-name"];
}

function getLinkListRowColumnValue(
  row: LinkListRowViewModel,
  columnId: LinkListColumnId,
): string {
  if (columnId === "townhall") return row.townHallLabel;
  if (columnId === "player-name") return row.playerName;
  if (columnId === "discord-display-name") return row.discordDisplayName;
  if (columnId === "discord-username") return row.discordUsername;
  if (columnId === "weight") return row.weightLabel;
  if (columnId === "inactivity") return row.inactivityLabel;
  if (columnId === "clan-role") return row.clanRoleLabel;
  return row.playerTag;
}

function computeColumnWidths(
  linkedRows: LinkListRowViewModel[],
  unlinkedRows: LinkListRowViewModel[],
  columns: LinkListColumnId[],
): Record<LinkListColumnId, number> {
  const widths = Object.fromEntries(columns.map((columnId) => [columnId, 1])) as Record<
    LinkListColumnId,
    number
  >;
  for (const row of [...linkedRows, ...unlinkedRows]) {
    for (const columnId of columns) {
      const value = getLinkListRowColumnValue(row, columnId);
      widths[columnId] = Math.max(widths[columnId] ?? 1, value.length);
    }
  }
  return widths;
}

function rightAlign(value: string, width: number): string {
  if (value.length >= width) return value;
  return `${" ".repeat(width - value.length)}${value}`;
}

function renderLinkListRow(input: {
  row: LinkListRowViewModel;
  columns: LinkListColumnId[];
  widths: Record<LinkListColumnId, number>;
  statusPrefix: string;
}): string {
  const leftPrefix = input.row.leftBadgePrefix ? ` ${input.row.leftBadgePrefix}` : "";
  const cells = input.columns.map((columnId) => {
    const value = sanitizeInlineCodeCell(getLinkListRowColumnValue(input.row, columnId));
    const width = input.widths[columnId] ?? value.length;
    return ` \`${rightAlign(value, width)}\``;
  });
  const base = `${input.statusPrefix}${leftPrefix}${cells.join("")}`;
  if (!input.row.rightMarker) return base;
  return `${base} ${input.row.rightMarker}`;
}

function compareSortText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export function sortLinkListRows(
  rows: {
    isLinked: boolean;
    playerTag: string;
    defaultIndex: number;
    weightValue: number | null;
    inactivityDays: number | null;
    inactivityMissedWars: number | null;
    inactivityParticipationWars: number | null;
    clanRoleSortScore: number;
    playerSort: string;
    discordSort: string;
    row: LinkListRowViewModel;
  }[],
  sortMode: LinkListSortMode,
): {
  isLinked: boolean;
  playerTag: string;
  defaultIndex: number;
  weightValue: number | null;
  inactivityDays: number | null;
  inactivityMissedWars: number | null;
  inactivityParticipationWars: number | null;
  clanRoleSortScore: number;
  playerSort: string;
  discordSort: string;
  row: LinkListRowViewModel;
}[] {
  return [...rows].sort((a, b) => {
    if (sortMode === "weight" || sortMode === "player-tags") {
      const aHasWeight = a.weightValue !== null;
      const bHasWeight = b.weightValue !== null;
      if (aHasWeight !== bHasWeight) return aHasWeight ? -1 : 1;
      if (
        a.weightValue !== null &&
        b.weightValue !== null &&
        a.weightValue !== b.weightValue
      ) {
        return b.weightValue - a.weightValue;
      }
      const byDiscord = compareSortText(a.discordSort, b.discordSort);
      if (byDiscord !== 0) return byDiscord;
      const byPlayer = compareSortText(a.playerSort, b.playerSort);
      if (byPlayer !== 0) return byPlayer;
      if (a.playerTag !== b.playerTag) {
        return compareSortText(a.playerTag, b.playerTag);
      }
      return a.defaultIndex - b.defaultIndex;
    }

    if (sortMode === "clan-rank") {
      if (a.clanRoleSortScore !== b.clanRoleSortScore) {
        return b.clanRoleSortScore - a.clanRoleSortScore;
      }
      const byDiscord = compareSortText(a.discordSort, b.discordSort);
      if (byDiscord !== 0) return byDiscord;
      const byPlayer = compareSortText(a.playerSort, b.playerSort);
      if (byPlayer !== 0) return byPlayer;
      if (a.playerTag !== b.playerTag) {
        return compareSortText(a.playerTag, b.playerTag);
      }
      return a.defaultIndex - b.defaultIndex;
    }

    if (sortMode === "inactivity") {
      const aHasMissed = a.inactivityMissedWars !== null;
      const bHasMissed = b.inactivityMissedWars !== null;
      if (aHasMissed !== bHasMissed) return aHasMissed ? -1 : 1;
      if (
        a.inactivityMissedWars !== null &&
        b.inactivityMissedWars !== null &&
        a.inactivityMissedWars !== b.inactivityMissedWars
      ) {
        return b.inactivityMissedWars - a.inactivityMissedWars;
      }

      const aHasParticipation = a.inactivityParticipationWars !== null;
      const bHasParticipation = b.inactivityParticipationWars !== null;
      if (aHasParticipation !== bHasParticipation) return aHasParticipation ? -1 : 1;
      if (
        a.inactivityParticipationWars !== null &&
        b.inactivityParticipationWars !== null &&
        a.inactivityParticipationWars !== b.inactivityParticipationWars
      ) {
        return b.inactivityParticipationWars - a.inactivityParticipationWars;
      }
      const aHasDays = a.inactivityDays !== null;
      const bHasDays = b.inactivityDays !== null;
      if (aHasDays !== bHasDays) return aHasDays ? -1 : 1;
      if (
        a.inactivityDays !== null &&
        b.inactivityDays !== null &&
        a.inactivityDays !== b.inactivityDays
      ) {
        return b.inactivityDays - a.inactivityDays;
      }
      const byPlayer = compareSortText(a.playerSort, b.playerSort);
      if (byPlayer !== 0) return byPlayer;
      if (a.playerTag !== b.playerTag) {
        return compareSortText(a.playerTag, b.playerTag);
      }
      return a.defaultIndex - b.defaultIndex;
    }

    if (sortMode === "player") {
      const byPlayer = compareSortText(a.playerSort, b.playerSort);
      if (byPlayer !== 0) return byPlayer;
      const byDiscord = compareSortText(a.discordSort, b.discordSort);
      if (byDiscord !== 0) return byDiscord;
      if (a.playerTag !== b.playerTag) {
        return compareSortText(a.playerTag, b.playerTag);
      }
      return a.defaultIndex - b.defaultIndex;
    }

    const byDiscord = compareSortText(a.discordSort, b.discordSort);
    if (byDiscord !== 0) return byDiscord;
    const byPlayer = compareSortText(a.playerSort, b.playerSort);
    if (byPlayer !== 0) return byPlayer;
    if (a.playerTag !== b.playerTag) {
      return compareSortText(a.playerTag, b.playerTag);
    }
    return a.defaultIndex - b.defaultIndex;
  });
}

export function formatCompactWeightK(weight: number | null | undefined): string {
  const resolvedWeight = toPositiveCompoWeight(weight);
  if (resolvedWeight === null) {
    return WEIGHT_PLACEHOLDER;
  }
  return `${Math.trunc(resolvedWeight / 1000)}k`;
}

export function formatLinkListTownHallLabel(townHall: number | null | undefined): string {
  const resolvedTownHall = normalizePositiveTownHall(townHall);
  if (resolvedTownHall === null) return "?";
  return String(resolvedTownHall);
}

export function normalizeLinkListClanRole(
  input: string | null | undefined,
): "leader" | "co" | "elder" | "member" | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, "");
  if (!normalized) return null;
  if (normalized === "leader") return "leader";
  if (normalized === "coleader" || normalized === "co") return "co";
  if (normalized === "admin" || normalized === "elder") return "elder";
  if (normalized === "member") return "member";
  return null;
}

export function formatLinkListClanRole(input: string | null | undefined): string {
  const role = normalizeLinkListClanRole(input);
  if (role === "leader") return "lead";
  if (role === "co") return "co";
  if (role === "elder") return "eld";
  if (role === "member") return "mem";
  return WEIGHT_PLACEHOLDER;
}

export function getLinkListClanRoleSortScore(input: string | null | undefined): number {
  const role = normalizeLinkListClanRole(input);
  if (role === "leader") return 4;
  if (role === "co") return 3;
  if (role === "elder") return 2;
  if (role === "member") return 1;
  return 0;
}

export function formatInactivityMetricLabel(input: {
  daysInactive: number | null;
  missedWars: number | null;
}): string {
  if (input.daysInactive === null && input.missedWars === null) {
    return WEIGHT_PLACEHOLDER;
  }
  const daysText =
    input.daysInactive !== null ? `${Math.max(0, Math.trunc(input.daysInactive))}d` : WEIGHT_PLACEHOLDER;
  const warsText =
    input.missedWars !== null ? `${Math.max(0, Math.trunc(input.missedWars))}w` : WEIGHT_PLACEHOLDER;
  return `${daysText} ${warsText}`;
}

export function normalizePositiveTownHall(input: number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (!Number.isFinite(input)) return null;
  const normalized = Math.trunc(input);
  return normalized > 0 ? normalized : null;
}

export function resolveLinkListTownHall(input: {
  memberTownHall: number | null;
  catalogTownHall: number | null;
  playerCurrentTownHall: number | null;
}): number | null {
  return (
    normalizePositiveTownHall(input.memberTownHall) ??
    normalizePositiveTownHall(input.catalogTownHall) ??
    normalizePositiveTownHall(input.playerCurrentTownHall) ??
    null
  );
}

export function buildLinkListDescriptionLines(input: {
  linkedRows: LinkListRowViewModel[];
  unlinkedRows: LinkListRowViewModel[];
  statusIcons: LinkListStatusIcons;
  sortMode?: LinkListSortMode;
  columns?: LinkListColumnId[];
}): string[] {
  const { linkedRows, unlinkedRows } = input;
  const columns =
    input.columns ?? getLinkListDefaultColumnsForSortMode(input.sortMode ?? LINK_LIST_DEFAULT_SORT_MODE);
  const widths = computeColumnWidths(linkedRows, unlinkedRows, columns);
  const lines: string[] = [];

  if (linkedRows.length > 0) {
    lines.push(`Linked Users: ${linkedRows.length}`);

    lines.push(
      ...linkedRows.map((row) =>
        renderLinkListRow({
          row,
          columns,
          widths,
          statusPrefix: input.statusIcons.linked,
        }),
      ),
    );
  }

  if (unlinkedRows.length > 0) {
    lines.push(`Unlinked users: ${unlinkedRows.length}`);
    lines.push(
      ...unlinkedRows.map((row) =>
        renderLinkListRow({
          row,
          columns,
          widths,
          statusPrefix: input.statusIcons.unlinked,
        }),
      ),
    );
  }

  return lines;
}

export function resolveLinkListStatusIcons(): LinkListStatusIcons {
  return {
    linked: LINK_LIST_LINKED_STATUS_EMOJI,
    unlinked: LINK_LIST_UNLINKED_STATUS_EMOJI,
  };
}

function isLinkListRowLine(line: string): boolean {
  return /^(?:[\u2705\u274C])(?:\s+[^\n`]+)*(?:\s+`[^`]+`)+(?:\s+\u{1F9CD})?$/u.test(
    String(line ?? "").trim(),
  );
}

function chunkDescriptionLines(
  lines: string[],
  safeLimit = EMBED_DESCRIPTION_LIMIT,
): {
  text: string;
  lineCount: number;
  rowCount: number;
  lines: string[];
}[] {
  const chunks: {
    text: string;
    lineCount: number;
    rowCount: number;
    lines: string[];
  }[] = [];
  let currentLines: string[] = [];
  let currentCount = 0;
  let currentRowCount = 0;
  const effectiveLimit = Math.max(1, Math.min(safeLimit, EMBED_DESCRIPTION_LIMIT));

  for (const rawLine of lines) {
    const line =
      rawLine.length <= EMBED_DESCRIPTION_LIMIT
        ? rawLine
        : `${rawLine.slice(0, EMBED_DESCRIPTION_LIMIT - 12)}...truncated`;
    const candidate = currentLines.length > 0 ? [...currentLines, line].join("\n") : line;

    if (candidate.length <= effectiveLimit) {
      currentLines.push(line);
      currentCount += 1;
      if (isLinkListRowLine(line)) currentRowCount += 1;
      continue;
    }

    if (currentLines.length > 0) {
      chunks.push({
        text: currentLines.join("\n"),
        lineCount: currentCount,
        rowCount: currentRowCount,
        lines: [...currentLines],
      });
    }
    currentLines = [line];
    currentCount = 1;
    currentRowCount = isLinkListRowLine(line) ? 1 : 0;
  }

  if (currentLines.length > 0) {
    chunks.push({
      text: currentLines.join("\n"),
      lineCount: currentCount,
      rowCount: currentRowCount,
      lines: [...currentLines],
    });
  }

  return chunks;
}

function trimLinkListDescriptionChunks(chunks: {
  text: string;
  lineCount: number;
  rowCount: number;
  lines: string[];
}[]): {
  chunks: {
    text: string;
    lineCount: number;
    rowCount: number;
    lines: string[];
  }[];
  hiddenRows: number;
  trimmed: boolean;
} {
  const kept = chunks.slice(0, LINK_LIST_MAX_EMBEDS).map((chunk) => ({
    ...chunk,
    lines: [...chunk.lines],
  }));
  let hiddenRows = chunks.slice(LINK_LIST_MAX_EMBEDS).reduce((sum, chunk) => sum + chunk.rowCount, 0);
  let trimmed = chunks.length > LINK_LIST_MAX_EMBEDS;

  const suffixText = (count: number) =>
    LINK_LIST_TRIM_SUFFIX_TEMPLATE.replace("{hiddenRows}", String(count));

  const totalChars = (value: { text: string }[]): number =>
    value.reduce((sum, chunk) => sum + chunk.text.length, 0);

  const rebuildChunk = (chunk: {
    text: string;
    lineCount: number;
    rowCount: number;
    lines: string[];
  }): void => {
    chunk.text = chunk.lines.join("\n");
    chunk.lineCount = chunk.lines.length;
    chunk.rowCount = chunk.lines.filter((line) => isLinkListRowLine(line)).length;
  };

  const dropLastLine = (): boolean => {
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const chunk = kept[index];
      if (chunk.lines.length === 0) continue;
      const removed = chunk.lines.pop();
      if (removed && isLinkListRowLine(removed)) {
        hiddenRows += 1;
      }
      rebuildChunk(chunk);
      while (kept.length > 0 && kept[kept.length - 1].lines.length === 0) {
        kept.pop();
      }
      return true;
    }
    return false;
  };

  while (kept.length > 0) {
    const suffix = hiddenRows > 0 ? suffixText(hiddenRows) : "";
    const nextTotal = totalChars(kept) + suffix.length;
    const last = kept[kept.length - 1];
    const nextLastLength = last.text.length + suffix.length + (last.text.length > 0 ? 1 : 0);
    if (
      nextTotal <= LINK_LIST_MAX_TOTAL_DESCRIPTION_CHARS &&
      nextLastLength <= EMBED_DESCRIPTION_LIMIT
    ) {
      break;
    }
    if (!dropLastLine()) break;
    trimmed = true;
  }

  if (hiddenRows > 0 && kept.length > 0) {
    const suffix = suffixText(hiddenRows);
    const last = kept[kept.length - 1];
    last.text = last.text.length > 0 ? `${last.text}\n${suffix}` : suffix;
    last.lineCount = last.lines.length + 1;
  }

  return { chunks: kept, hiddenRows, trimmed };
}

// Description/embed helpers used by the command to render the list output.
export function buildDescriptionEmbeds(
  title: string,
  lines: string[],
  sortMode: LinkListSortMode,
): LinkListDescriptionRenderResult {
  const sortLabel = getLinkListSortModeLabel(sortMode);
  const chunks = chunkDescriptionLines(lines, LINK_LIST_EMBED_DESCRIPTION_SAFE_LIMIT);
  if (chunks.length === 0) {
    const embeds = [
      new EmbedBuilder()
        .setColor(LINK_LIST_EMBED_COLOR)
        .setTitle(title)
        .setFooter({ text: `Sort: ${sortLabel}` })
        .setDescription("empty_list: no rows to render."),
    ];
    return {
      embeds,
      renderedRows: 0,
      hiddenRows: 0,
      embedCount: embeds.length,
      totalDescriptionChars: embeds[0]?.data?.description?.length ?? 0,
      trimmed: false,
    };
  }

  const totalRows = lines.filter((line) => isLinkListRowLine(line)).length;
  const trimmedChunks = trimLinkListDescriptionChunks(chunks);
  const embeds = trimmedChunks.chunks.map((chunk, index) => {
    const embed = new EmbedBuilder().setColor(LINK_LIST_EMBED_COLOR).setDescription(chunk.text);
    if (index === 0) {
      embed.setTitle(title);
    }
    if (index === trimmedChunks.chunks.length - 1) {
      embed.setFooter({ text: `Sort: ${sortLabel}` });
    }
    return embed;
  });

  if (embeds.length === 0) {
    const suffix = LINK_LIST_TRIM_SUFFIX_TEMPLATE.replace(
      "{hiddenRows}",
      String(trimmedChunks.hiddenRows),
    );
    embeds.push(
      new EmbedBuilder()
        .setColor(LINK_LIST_EMBED_COLOR)
        .setTitle(title)
        .setFooter({ text: `Sort: ${sortLabel}` })
        .setDescription(suffix),
    );
  }

  return {
    embeds,
    renderedRows: Math.max(0, totalRows - trimmedChunks.hiddenRows),
    hiddenRows: trimmedChunks.hiddenRows,
    embedCount: embeds.length,
    totalDescriptionChars: embeds.reduce(
      (sum, embed) => sum + String(embed.data?.description ?? "").length,
      0,
    ),
    trimmed: trimmedChunks.trimmed,
  };
}

// Title formatting stays here because it is pure presentation data.
export function buildTitleWithBadge(input: {
  clanName: string;
  clanTag: string;
  badge: string | null;
}): string {
  const pieces = [
    input.badge?.trim() ?? "",
    input.clanName.trim(),
    input.clanTag.trim(),
  ].filter((piece) => piece.length > 0);
  return pieces.join(" ");
}
