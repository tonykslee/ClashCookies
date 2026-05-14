import {
  ActionRowBuilder,
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
import { buildClanProfileMarkdownLink } from "../helper/clanProfileLink";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { resolveTownHallEmojiMap } from "./Accounts";
import {
  listFillerAccountsForClan,
  listFillerAccountsForDiscordUser,
  listFillerAccountsForGuild,
  listFillerEditorAccountsForDiscordUser,
  replaceFillerAccountsForLinkedUser,
  type FillerAccountViewRow,
} from "../services/FillerAccountService";
import { normalizeClanTag, normalizePlayerTag } from "../services/PlayerLinkService";

const FILLERS_TIMEOUT_MS = 10 * 60 * 1000;
const FILLERS_PAGE_SIZE = 25;
const FILLERS_MENU_SIZE = 25;
const FILLERS_EMBED_DESCRIPTION_LIMIT = 4096;
const FILLERS_SAFE_DESCRIPTION_LIMIT = 3900;
const FILLERS_LIST_DESCRIPTION_LIMIT = FILLERS_SAFE_DESCRIPTION_LIMIT;

type FillerListScope = "all" | "user" | "clan";

type ClanGroup = {
  key: string;
  clanTag: string | null;
  clanName: string | null;
  clanState: "known" | "no_clan" | "unknown";
  isTrackedFwaClan: boolean;
  trackedClanSortOrder: number | null;
  entries: FillerAccountViewRow[];
};

type FillersEditorStage =
  | "fillers_set_fetch_rows"
  | "fillers_set_build_embed"
  | "fillers_set_build_components"
  | "fillers_set_render_payload"
  | "fillers_set_edit_reply";

const FILLERS_EDITOR_FAILURE_MESSAGE =
  "Could not render the filler editor. The failure was logged with diagnostic details.";

function normalizeText(input: unknown): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePositiveInteger(input: unknown): number | null {
  const parsed = Math.trunc(Number(input));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function truncateDiagnosticText(input: string, maxLength = 220): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}…[len=${input.length}]`;
}

function safeDiagnosticJson(value: unknown, maxLength = 3000): string {
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === "string") {
          return truncateDiagnosticText(current, 220);
        }
        if (typeof current === "number" || typeof current === "boolean" || current === null) {
          return current;
        }
        if (typeof current === "bigint") {
          return current.toString();
        }
        if (typeof current === "undefined") {
          return "[undefined]";
        }
        if (current instanceof Error) {
          return {
            name: current.name,
            message: truncateDiagnosticText(current.message, 220),
            stack: current.stack ? truncateDiagnosticText(current.stack, 800) : null,
          };
        }
        if (typeof current === "object" && current !== null) {
          if (seen.has(current as object)) return "[Circular]";
          seen.add(current as object);
        }
        return current;
      },
      2,
    );
    if (!text) return "null";
    return text.length <= maxLength
      ? text
      : `${text.slice(0, maxLength)}…[len=${text.length}]`;
  } catch (error) {
    return truncateDiagnosticText(`"<unstringifiable:${formatError(error)}>"`, maxLength);
  }
}

function summarizeFillerRowForDiagnostics(row: FillerAccountViewRow): Record<string, unknown> {
  return {
    tag: row.tag,
    nameLength: normalizeText(row.name)?.length ?? 0,
    clanNameLength: normalizeText(row.clanName)?.length ?? 0,
    townHall: row.townHall,
    weight: row.weight,
    isFiller: row.isFiller,
  };
}

function summarizeErrorForDiagnostics(error: unknown): Record<string, unknown> {
  const raw = error as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  return {
    formatError: formatError(error),
    rawName: typeof raw?.name === "string" ? raw.name : typeof error,
    rawMessage: truncateDiagnosticText(
      typeof raw?.message === "string" ? raw.message : String(error ?? ""),
      300,
    ),
    stack: typeof raw?.stack === "string" ? truncateDiagnosticText(raw.stack, 1200) : null,
    errors: raw?.errors !== undefined ? safeDiagnosticJson(raw.errors, 2000) : null,
    cause: raw?.cause !== undefined ? safeDiagnosticJson(raw.cause, 2000) : null,
  };
}

function logFillersEditorDiagnostic(
  stage: FillersEditorStage,
  details: Record<string, unknown>,
  error?: unknown,
): void {
  const payload = {
    stage,
    ...details,
    ...(error ? { error: summarizeErrorForDiagnostics(error) } : {}),
  };
  console.error(`[fillers:set] ${safeDiagnosticJson(payload, 6000)}`);
}

function summarizeSelectMenuDiagnostics(menu: {
  customId?: string;
  placeholder?: string | null;
  minValues?: number;
  maxValues?: number;
  options?: Array<{
    label?: string;
    value?: string;
    description?: string | null;
  }>;
}): Record<string, unknown> {
  const options = menu.options ?? [];
  const labelLengths = options.map((option) => String(option.label ?? "").length);
  const descriptionLengths = options.map((option) => String(option.description ?? "").length);
  const valueLengths = options.map((option) => String(option.value ?? "").length);
  return {
    customIdLength: String(menu.customId ?? "").length,
    placeholderLength: String(menu.placeholder ?? "").length,
    optionCount: options.length,
    minValues: menu.minValues ?? null,
    maxValues: menu.maxValues ?? null,
    longestOptionLabelLength: labelLengths.length > 0 ? Math.max(...labelLengths) : 0,
    longestOptionDescriptionLength:
      descriptionLengths.length > 0 ? Math.max(...descriptionLengths) : 0,
    anyOptionLabelEmpty: options.some((option) => String(option.label ?? "").length === 0),
    anyOptionValueEmpty: options.some((option) => String(option.value ?? "").length === 0),
    anyOptionValueLengthOver100: valueLengths.some((length) => length > 100),
    anyOptionLabelLengthOver100: labelLengths.some((length) => length > 100),
    anyOptionDescriptionLengthOver100: descriptionLengths.some((length) => length > 100),
  };
}

function formatCompactWeightK(weight: number | null | undefined): string {
  const normalized = normalizePositiveInteger(weight);
  if (normalized === null) return "—";
  if (normalized < 1000) return String(normalized);
  return `${Math.trunc(normalized / 1000)}k`;
}

function buildPlayerProfileMarkdownLink(playerName: string | null, playerTag: string): string {
  const normalizedPlayerTag = normalizePlayerTag(playerTag);
  const label = normalizeText(playerName) || normalizedPlayerTag || "Unknown Player";
  if (!normalizedPlayerTag) return label;
  const encodedTag = normalizedPlayerTag.replace(/^#/, "");
  return `[${label}](<https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=${encodedTag}>)`;
}

function isEditorPreviewAccountLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("**")) return false;
  if (trimmed.startsWith("... ")) return false;
  return true;
}

function countEditorPreviewAccountLines(lines: string[]): number {
  return lines.reduce((count, line) => count + (isEditorPreviewAccountLine(line) ? 1 : 0), 0);
}

function getSafeEditorPreviewLineCount(lines: string[]): number {
  let current: string[] = [];
  for (const line of lines) {
    const next = current.length > 0 ? [...current, line] : [line];
    const text = next.join("\n");
    if (text.length > FILLERS_SAFE_DESCRIPTION_LIMIT && current.length > 0) {
      break;
    }
    current = next;
  }
  return current.length;
}

function buildSafeEditorDescription(lines: string[], omittedAccountCount: number): string {
  const note =
    omittedAccountCount > 0
      ? `... ${omittedAccountCount} more account(s) on this page are not shown in the preview, but remain selectable in the dropdown below.`
      : "";
  let current: string[] = [];
  for (const line of lines) {
    const next = current.length > 0 ? [...current, line] : [line];
    const candidate = next.join("\n");
    if (candidate.length > FILLERS_SAFE_DESCRIPTION_LIMIT && current.length > 0) {
      break;
    }
    current = next;
  }

  let description = current.join("\n");
  if (!note) {
    return description;
  }

  let finalDescription = description.length > 0 ? `${description}\n${note}` : note;
  while (finalDescription.length > FILLERS_EMBED_DESCRIPTION_LIMIT && current.length > 0) {
    current.pop();
    description = current.join("\n");
    finalDescription = description.length > 0 ? `${description}\n${note}` : note;
  }

  if (finalDescription.length > FILLERS_EMBED_DESCRIPTION_LIMIT) {
    return note.slice(0, FILLERS_EMBED_DESCRIPTION_LIMIT);
  }

  return finalDescription;
}

function renderTownHallIcon(
  townHall: number | null,
  townHallEmojiByLevel: Map<number, string>,
): string {
  const normalized = normalizePositiveInteger(townHall);
  if (normalized === null) return "TH?";
  return townHallEmojiByLevel.get(normalized) ?? `TH${normalized}`;
}

function renderFillerRow(
  row: FillerAccountViewRow,
  townHallEmojiByLevel: Map<number, string>,
): string {
  const marker = row.isFiller ? "🧍‍♂️ " : "";
  const crown = row.clanRole ? " :crown:" : "";
  const playerLink = buildPlayerProfileMarkdownLink(row.name, row.tag);
  return `${marker}${renderTownHallIcon(row.townHall, townHallEmojiByLevel)} ${playerLink}${crown} \`${row.tag}\` - ${formatCompactWeightK(row.weight)}`;
}

function buildClanHeadingMarkdown(group: Pick<ClanGroup, "clanName" | "clanTag" | "clanState">): string {
  if (group.clanState === "unknown") return "**Unknown Clan**";
  if (group.clanState === "no_clan") return "**No Clan**";
  const clanTag = normalizePlayerTag(String(group.clanTag ?? ""));
  return clanTag ? `**${buildClanProfileMarkdownLink(group.clanName, clanTag)}**` : "**Unknown Clan**";
}

function sortClanGroups(a: ClanGroup, b: ClanGroup): number {
  const rank = (group: ClanGroup) => {
    if (group.clanState !== "known") {
      return group.clanState === "unknown" ? 2 : 3;
    }
    return group.isTrackedFwaClan ? 0 : 1;
  };
  const rankDelta = rank(a) - rank(b);
  if (rankDelta !== 0) return rankDelta;
  if (a.clanState === "known" && b.clanState === "known") {
    if (a.isTrackedFwaClan !== b.isTrackedFwaClan) {
      return a.isTrackedFwaClan ? -1 : 1;
    }
    if (a.isTrackedFwaClan) {
      const leftSort = a.trackedClanSortOrder ?? Number.MAX_SAFE_INTEGER;
      const rightSort = b.trackedClanSortOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftSort !== rightSort) return leftSort - rightSort;
    }
  }
  const leftLabel = normalizeText(a.clanName) ?? a.clanTag ?? "";
  const rightLabel = normalizeText(b.clanName) ?? b.clanTag ?? "";
  const byLabel = leftLabel.localeCompare(rightLabel, undefined, {
    sensitivity: "base",
  });
  if (byLabel !== 0) return byLabel;
  return (a.clanTag ?? "").localeCompare(b.clanTag ?? "", undefined, {
    sensitivity: "base",
  });
}

function groupRowsByClan(rows: FillerAccountViewRow[]): ClanGroup[] {
  const grouped = new Map<string, ClanGroup>();
  for (const row of rows) {
    const clanTag = row.clanTag ? normalizeClanTag(row.clanTag) : null;
    const key =
      clanTag ?? (row.clanState === "unknown" ? "__UNKNOWN_CLAN__" : "__NO_CLAN__");
    const bucket = grouped.get(key);
    if (!bucket) {
      grouped.set(key, {
        key,
        clanTag,
        clanName: normalizeText(row.clanName),
        clanState: row.clanState,
        isTrackedFwaClan: row.isTrackedFwaClan,
        trackedClanSortOrder: row.trackedClanSortOrder,
        entries: [row],
      });
      continue;
    }

    if (normalizeText(row.clanName) && !bucket.clanName) {
      bucket.clanName = normalizeText(row.clanName);
    }
    if (bucket.clanState === "unknown" && row.clanState !== "unknown") {
      bucket.clanState = row.clanState;
    }
    if (!bucket.isTrackedFwaClan && row.isTrackedFwaClan) {
      bucket.isTrackedFwaClan = true;
    }
    if (
      bucket.trackedClanSortOrder === null &&
      row.trackedClanSortOrder !== null &&
      row.trackedClanSortOrder !== undefined
    ) {
      bucket.trackedClanSortOrder = row.trackedClanSortOrder;
    }
    bucket.entries.push(row);
  }

  const groups = [...grouped.values()].sort(sortClanGroups);
  for (const group of groups) {
    group.entries.sort((a, b) => {
      const townHallDelta = (normalizePositiveInteger(b.townHall) ?? -1) - (normalizePositiveInteger(a.townHall) ?? -1);
      if (townHallDelta !== 0) return townHallDelta;
      const weightDelta = (normalizePositiveInteger(b.weight) ?? -1) - (normalizePositiveInteger(a.weight) ?? -1);
      if (weightDelta !== 0) return weightDelta;
      const byName = normalizeText(a.name) ?? a.tag;
      const otherName = normalizeText(b.name) ?? b.tag;
      const nameDelta = byName.localeCompare(otherName, undefined, { sensitivity: "base" });
      if (nameDelta !== 0) return nameDelta;
      return a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" });
    });
  }

  return groups;
}

function buildClanGroupLines(
  group: ClanGroup,
  townHallEmojiByLevel: Map<number, string>,
): string[] {
  const lines: string[] = [buildClanHeadingMarkdown(group)];
  for (const row of group.entries) {
    lines.push(renderFillerRow(row, townHallEmojiByLevel));
  }
  return lines;
}

function buildLinesForUserSections(
  rows: FillerAccountViewRow[],
  townHallEmojiByLevel: Map<number, string>,
): string[] {
  const sections = new Map<string, FillerAccountViewRow[]>();
  for (const row of rows) {
    const userKey = row.discordUserId ?? "__UNLINKED__";
    const bucket = sections.get(userKey) ?? [];
    bucket.push(row);
    sections.set(userKey, bucket);
  }

  const ordered = [...sections.entries()].sort((a, b) => {
    const leftLabel = a[0] === "__UNLINKED__" ? "zzzzzzzzzz" : a[0];
    const rightLabel = b[0] === "__UNLINKED__" ? "zzzzzzzzzz" : b[0];
    return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
  });

  const lines: string[] = [];
  for (const [userKey, userRows] of ordered) {
    lines.push(userKey === "__UNLINKED__" ? "**Unlinked**" : `**<@${userKey}>**`);
    for (const clanGroup of groupRowsByClan(userRows)) {
      lines.push(...buildClanGroupLines(clanGroup, townHallEmojiByLevel));
      lines.push("");
    }
    if (lines.at(-1) === "") {
      lines.pop();
    }
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function buildLinesForClanScopedView(
  rows: FillerAccountViewRow[],
  townHallEmojiByLevel: Map<number, string>,
): string[] {
  const sections = new Map<string, FillerAccountViewRow[]>();
  for (const row of rows) {
    const userKey = row.discordUserId ?? "__UNLINKED__";
    const bucket = sections.get(userKey) ?? [];
    bucket.push(row);
    sections.set(userKey, bucket);
  }

  const ordered = [...sections.entries()].sort((a, b) => {
    const leftLabel = a[0] === "__UNLINKED__" ? "zzzzzzzzzz" : a[0];
    const rightLabel = b[0] === "__UNLINKED__" ? "zzzzzzzzzz" : b[0];
    return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
  });

  const lines: string[] = [];
  for (const [userKey, userRows] of ordered) {
    lines.push(userKey === "__UNLINKED__" ? "**Unlinked**" : `**<@${userKey}>**`);
    for (const row of userRows.sort((a, b) => {
      const townHallDelta = (normalizePositiveInteger(b.townHall) ?? -1) - (normalizePositiveInteger(a.townHall) ?? -1);
      if (townHallDelta !== 0) return townHallDelta;
      const weightDelta = (normalizePositiveInteger(b.weight) ?? -1) - (normalizePositiveInteger(a.weight) ?? -1);
      if (weightDelta !== 0) return weightDelta;
      const byName = normalizeText(a.name) ?? a.tag;
      const otherName = normalizeText(b.name) ?? b.tag;
      const nameDelta = byName.localeCompare(otherName, undefined, { sensitivity: "base" });
      if (nameDelta !== 0) return nameDelta;
      return a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" });
    })) {
      lines.push(renderFillerRow(row, townHallEmojiByLevel));
    }
    lines.push("");
  }
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function paginateDescriptionLines(lines: string[]): string[] {
  const pages: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const next = current.length > 0 ? [...current, line] : [line];
    const text = next.join("\n");
    if (text.length > FILLERS_LIST_DESCRIPTION_LIMIT && current.length > 0) {
      pages.push(current.join("\n"));
      current = [line];
      continue;
    }
    current = next;
  }

  if (current.length > 0) {
    pages.push(current.join("\n"));
  }

  return pages.length > 0 ? pages : [""];
}

function buildListEmbed(title: string, description: string, page: number, totalPages: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0x5865f2)
    .setDescription(description || " ")
    .setFooter({ text: `Page ${page + 1}/${totalPages}` });
}

function buildPagerRow(
  prefix: string,
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> | null {
  if (totalPages <= 1) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

function sortDisplayRows(rows: FillerAccountViewRow[]): FillerAccountViewRow[] {
  return [...rows].sort((a, b) => {
    const townHallDelta = (normalizePositiveInteger(b.townHall) ?? -1) - (normalizePositiveInteger(a.townHall) ?? -1);
    if (townHallDelta !== 0) return townHallDelta;
    const weightDelta = (normalizePositiveInteger(b.weight) ?? -1) - (normalizePositiveInteger(a.weight) ?? -1);
    if (weightDelta !== 0) return weightDelta;
    const byName = normalizeText(a.name) ?? a.tag;
    const otherName = normalizeText(b.name) ?? b.tag;
    const nameDelta = byName.localeCompare(otherName, undefined, { sensitivity: "base" });
    if (nameDelta !== 0) return nameDelta;
    return a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" });
  });
}

function chunkRows(rows: FillerAccountViewRow[], chunkSize: number): FillerAccountViewRow[][] {
  if (chunkSize <= 0) return [rows];
  const chunks: FillerAccountViewRow[][] = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks.length > 0 ? chunks : [[]];
}

function buildEditorRows(
  sessionId: string,
  pageIndex: number,
  rows: FillerAccountViewRow[],
  selectedTags: Set<string>,
  townHallEmojiByLevel: Map<number, string>,
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const rowsPerPage = FILLERS_PAGE_SIZE;
  const pageRows = rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage);
  const buckets = chunkRows(pageRows, FILLERS_MENU_SIZE);
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
    const bucket = buckets[bucketIndex] ?? [];
    const start = pageIndex * rowsPerPage + bucketIndex * FILLERS_MENU_SIZE + 1;
    const end = start + bucket.length - 1;
    const optionEntries = bucket.map((row) => ({
      label: `${renderTownHallIcon(row.townHall, townHallEmojiByLevel)} ${formatCompactWeightK(row.weight)} ${normalizeText(row.name) ?? row.tag}`.slice(0, 100),
      value: row.tag,
      default: selectedTags.has(row.tag),
      description: normalizeText(
        [row.tag, row.clanName ? `clan: ${row.clanName}` : null].filter(Boolean).join(" | "),
      )?.slice(0, 100),
    }));
    const menuPreview = {
      customId: `fillers:editor:${sessionId}:page:${pageIndex}:bucket:${bucketIndex}`,
      placeholder: `${start}-${end}`,
      minValues: 0,
      maxValues: Math.max(1, bucket.length),
      options: optionEntries,
    };

    try {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(menuPreview.customId)
        .setPlaceholder(menuPreview.placeholder)
        .setMinValues(menuPreview.minValues)
        .setMaxValues(menuPreview.maxValues)
        .addOptions(optionEntries);
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
    } catch (error) {
      logFillersEditorDiagnostic(
        "fillers_set_build_components",
        {
          phase: "menu_build_failed",
          pageIndex,
          bucketIndex,
          rowCount: bucket.length,
          menu: summarizeSelectMenuDiagnostics(menuPreview),
        },
        error,
      );
      throw error;
    }
  }

  return components;
}

function buildEditorEmbed(input: {
  title: string;
  introLines?: string[];
  rows: FillerAccountViewRow[];
  selectedCount: number;
  totalCount: number;
  townHallEmojiByLevel: Map<number, string>;
  page: number;
  totalPages: number;
}): EmbedBuilder {
  const groups = groupRowsByClan(input.rows);
  const accountLines: string[] = [];
  for (const group of groups) {
    accountLines.push(...buildClanGroupLines(group, input.townHallEmojiByLevel));
    accountLines.push("");
  }
  if (accountLines.at(-1) === "") {
    accountLines.pop();
  }
  if (accountLines.length === 0) {
    accountLines.push("No linked accounts found.");
  }
  const introLines = input.introLines ?? [];
  const lines = [...introLines, ...accountLines];
  const safeLineCount = getSafeEditorPreviewLineCount(lines);
  const previewLines = lines.slice(0, safeLineCount);
  const omittedAccountCount = countEditorPreviewAccountLines(lines.slice(safeLineCount));
  const description = buildSafeEditorDescription(previewLines, omittedAccountCount);
  const embedMetrics = {
    titleLength: input.title.length,
    descriptionLength: description.length,
    lineCount: lines.length,
    previewLineCount: previewLines.length,
    omittedAccountCount,
    selectedCount: input.selectedCount,
    totalCount: input.totalCount,
    page: input.page,
    totalPages: input.totalPages,
  };

  try {
    const embed = new EmbedBuilder()
      .setTitle(input.title)
      .setColor(0x5865f2)
      .setDescription(description)
      .setFooter({
        text: `${input.selectedCount}/${input.totalCount} filler accounts selected | Page ${input.page + 1}/${input.totalPages}`,
      });
    logFillersEditorDiagnostic("fillers_set_build_embed", {
      phase: "embed_built",
      ...embedMetrics,
    });
    return embed;
  } catch (error) {
    logFillersEditorDiagnostic(
      "fillers_set_build_embed",
      {
        phase: "embed_build_failed",
        ...embedMetrics,
      },
      error,
    );
    throw error;
  }
}

function buildTargetUserLine(userId: string): string {
  return `User: <@${userId}>`;
}

function buildEditorTitle(totalCount: number): string {
  return `Filler Accounts (${totalCount})`;
}

async function renderListReply(input: {
  interaction: ChatInputCommandInteraction;
  rows: FillerAccountViewRow[];
  title: string;
  scope: FillerListScope;
  targetUserId?: string | null;
  targetClanTag?: string | null;
}): Promise<void> {
  const townHallEmojiByLevel = await resolveTownHallEmojiMap(input.interaction.client);
  const pages = paginateDescriptionLines(
    input.scope === "clan"
      ? buildLinesForClanScopedView(input.rows, townHallEmojiByLevel)
      : buildLinesForUserSections(input.rows, townHallEmojiByLevel),
  );
  const totalPages = pages.length;
  let page = 0;
  const prefix = `fillers:list:${input.interaction.id}`;
  const descriptionParts = input.targetUserId
    ? [buildTargetUserLine(input.targetUserId), pages[page] ?? ""]
    : [pages[page] ?? ""];

  const embed = buildListEmbed(
    input.title,
    descriptionParts.filter((part) => part.length > 0).join("\n\n"),
    page,
    totalPages,
  );
  const components = buildPagerRow(prefix, page, totalPages);
  await input.interaction.editReply({
    embeds: [embed],
    components: components ? [components] : [],
  });

  if (totalPages <= 1) return;

  const message = await input.interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: FILLERS_TIMEOUT_MS,
    filter: (button) =>
      button.user.id === input.interaction.user.id &&
      (button.customId === `${prefix}:prev` || button.customId === `${prefix}:next`),
  });

  collector.on("collect", async (button: ButtonInteraction) => {
    try {
      if (button.customId === `${prefix}:prev`) {
        page = Math.max(0, page - 1);
      } else if (button.customId === `${prefix}:next`) {
        page = Math.min(totalPages - 1, page + 1);
      }
      await button.update({
        embeds: [
          buildListEmbed(
            input.title,
            [
              ...(input.targetUserId ? [buildTargetUserLine(input.targetUserId)] : []),
              pages[page] ?? "",
            ]
              .filter((part) => part.length > 0)
              .join("\n\n"),
            page,
            totalPages,
          ),
        ],
        components: [buildPagerRow(prefix, page, totalPages)!],
      });
    } catch (error) {
      console.error(`fillers list paginator failed: ${formatError(error)}`);
      if (!button.replied && !button.deferred) {
        await button.reply({
          ephemeral: true,
          content: "Failed to update filler list page.",
        });
      }
    }
  });

  collector.on("end", async () => {
    try {
      await input.interaction.editReply({ components: [] });
    } catch {
      // no-op
    }
  });
}

async function renderEditorReply(input: {
  interaction: ChatInputCommandInteraction;
  targetUserId: string;
  rows: FillerAccountViewRow[];
}): Promise<void> {
  const sortedRows = sortDisplayRows(input.rows);
  const selectedTags = new Set(
    sortedRows.filter((row) => row.isFiller).map((row) => row.tag),
  );
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / FILLERS_PAGE_SIZE));
  let page = 0;
  const sessionId = input.interaction.id;
  const title = buildEditorTitle(sortedRows.length);
  const townHallEmojiByLevel = await resolveTownHallEmojiMap(input.interaction.client);
  const introLines = [buildTargetUserLine(input.targetUserId), ""];

  const buildRenderPayload = () => {
    const renderRows = sortedRows.map((row) => ({
      ...row,
      isFiller: selectedTags.has(row.tag),
    }));
    const pageRows = renderRows.slice(page * FILLERS_PAGE_SIZE, (page + 1) * FILLERS_PAGE_SIZE);
    logFillersEditorDiagnostic("fillers_set_render_payload", {
      phase: "pre_build",
      guildId: input.interaction.guildId ?? "",
      targetUserId: input.targetUserId,
      actorUserId: input.interaction.user.id,
      sortedRowsLength: sortedRows.length,
      totalPages,
      page,
      selectedTagsSize: selectedTags.size,
      renderRowsLength: renderRows.length,
      pageRowsLength: pageRows.length,
    });

    let embed: EmbedBuilder;
    try {
      embed = buildEditorEmbed({
        title,
        introLines,
        rows: pageRows,
        selectedCount: selectedTags.size,
        totalCount: sortedRows.length,
        townHallEmojiByLevel,
        page,
        totalPages,
      });
    } catch (error) {
      logFillersEditorDiagnostic(
        "fillers_set_render_payload",
        {
          phase: "build_embed_failed",
          guildId: input.interaction.guildId ?? "",
          targetUserId: input.targetUserId,
          actorUserId: input.interaction.user.id,
          sortedRowsLength: sortedRows.length,
          totalPages,
          page,
          selectedTagsSize: selectedTags.size,
          renderRowsLength: renderRows.length,
          pageRowsLength: pageRows.length,
        },
        error,
      );
      throw error;
    }

    let editorRows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
    try {
      editorRows = buildEditorRows(sessionId, page, renderRows, selectedTags, townHallEmojiByLevel);
    } catch (error) {
      logFillersEditorDiagnostic(
        "fillers_set_render_payload",
        {
          phase: "build_components_failed",
          guildId: input.interaction.guildId ?? "",
          targetUserId: input.targetUserId,
          actorUserId: input.interaction.user.id,
          sortedRowsLength: sortedRows.length,
          totalPages,
          page,
          selectedTagsSize: selectedTags.size,
          renderRowsLength: renderRows.length,
          pageRowsLength: pageRows.length,
        },
        error,
      );
      throw error;
    }

    const pagerRow = buildPagerRow(`fillers:editor:${sessionId}`, page, totalPages);
    const components = [...editorRows, ...(pagerRow ? [pagerRow] : [])];
    const embedJson = embed.toJSON() as { title?: string; description?: string | null };
    const componentJson = components.map((component) => component.toJSON() as {
      components?: Array<{
        options?: Array<{ label?: string; value?: string; description?: string | null }>;
        custom_id?: string;
        placeholder?: string | null;
        min_values?: number;
        max_values?: number;
      }>;
    });
    const flatComponents = componentJson.flatMap((row) => row.components ?? []);
    const selectMenus = flatComponents.filter((component) => Array.isArray(component.options));
    const buttonCount = flatComponents.length - selectMenus.length;
    const payloadMetrics = {
      embedTitleLength: String(embedJson.title ?? "").length,
      embedDescriptionLength: String(embedJson.description ?? "").length,
      componentRowCount: componentJson.length,
      selectMenuCount: selectMenus.length,
      buttonCount,
      selectMenus: selectMenus.map((menu) =>
        summarizeSelectMenuDiagnostics({
          customId: menu.custom_id,
          placeholder: menu.placeholder,
          minValues: menu.min_values,
          maxValues: menu.max_values,
          options: menu.options,
        }),
      ),
    };
    logFillersEditorDiagnostic("fillers_set_render_payload", {
      phase: "payload_metrics",
      guildId: input.interaction.guildId ?? "",
      targetUserId: input.targetUserId,
      actorUserId: input.interaction.user.id,
      sortedRowsLength: sortedRows.length,
      totalPages,
      page,
      selectedTagsSize: selectedTags.size,
      renderRowsLength: renderRows.length,
      pageRowsLength: pageRows.length,
      ...payloadMetrics,
    });

    return {
      embeds: [embed],
      components,
    };
  };

  let renderPayload;
  try {
    renderPayload = buildRenderPayload();
  } catch (error) {
    logFillersEditorDiagnostic(
      "fillers_set_render_payload",
      {
        phase: "render_payload_failed",
        guildId: input.interaction.guildId ?? "",
        targetUserId: input.targetUserId,
        actorUserId: input.interaction.user.id,
        sortedRowsLength: sortedRows.length,
        totalPages,
        page,
        selectedTagsSize: selectedTags.size,
      },
      error,
    );
    throw error;
  }

  try {
    await input.interaction.editReply(renderPayload);
  } catch (error) {
    const embedJson = renderPayload.embeds[0]?.toJSON() as {
      title?: string;
      description?: string | null;
    };
    const componentJson = renderPayload.components.map((component) => component.toJSON() as {
      components?: Array<{
        options?: Array<{ label?: string; value?: string; description?: string | null }>;
        custom_id?: string;
        placeholder?: string | null;
        min_values?: number;
        max_values?: number;
      }>;
    });
    const flatComponents = componentJson.flatMap((row) => row.components ?? []);
    logFillersEditorDiagnostic(
      "fillers_set_edit_reply",
      {
        guildId: input.interaction.guildId ?? "",
        targetUserId: input.targetUserId,
        actorUserId: input.interaction.user.id,
        embedTitleLength: String(embedJson?.title ?? "").length,
        embedDescriptionLength: String(embedJson?.description ?? "").length,
        componentRowCount: componentJson.length,
        selectMenuCount: flatComponents.filter((component) => Array.isArray(component.options)).length,
        buttonCount: flatComponents.filter((component) => !Array.isArray(component.options)).length,
      },
      error,
    );
    throw error;
  }

  const message = await input.interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    time: FILLERS_TIMEOUT_MS,
    filter: (component) =>
      component.user.id === input.interaction.user.id &&
      (component.customId.startsWith(`fillers:editor:${sessionId}:page:`) ||
        component.customId === `fillers:editor:${sessionId}:prev` ||
        component.customId === `fillers:editor:${sessionId}:next`),
  });

  collector.on("collect", async (component: ButtonInteraction | StringSelectMenuInteraction) => {
    try {
      if (component.isButton()) {
        if (component.customId.endsWith(":prev")) {
          page = Math.max(0, page - 1);
        } else if (component.customId.endsWith(":next")) {
          page = Math.min(totalPages - 1, page + 1);
        }
        await component.update(buildRenderPayload());
        return;
      }

      const parts = component.customId.split(":");
      const pageIndex = Number(parts[4] ?? "0");
      const bucketIndex = Number(parts[6] ?? "0");
      const pageRows = sortedRows.slice(pageIndex * FILLERS_PAGE_SIZE, (pageIndex + 1) * FILLERS_PAGE_SIZE);
      const bucket = chunkRows(pageRows, FILLERS_MENU_SIZE)[bucketIndex] ?? [];
      const bucketTagSet = new Set(bucket.map((row) => row.tag));
      const selectedValues = new Set(component.values.map((value) => normalizePlayerTag(value)).filter(Boolean));

      for (const tag of bucketTagSet) {
        selectedTags.delete(tag);
      }
      for (const tag of selectedValues) {
        selectedTags.add(tag);
      }

      await replaceFillerAccountsForLinkedUser({
        guildId: input.interaction.guildId ?? "",
        actorDiscordUserId: input.interaction.user.id,
        linkedPlayerTags: sortedRows.map((row) => row.tag),
        selectedPlayerTags: [...selectedTags],
      });
      await component.update(buildRenderPayload());
    } catch (error) {
      console.error(`fillers editor collector failed: ${formatError(error)}`);
      if (!component.replied && !component.deferred) {
        await component.reply({
          ephemeral: true,
          content: FILLERS_EDITOR_FAILURE_MESSAGE,
        });
      }
    }
  });

  collector.on("end", async () => {
    try {
      await input.interaction.editReply({ components: [] });
    } catch {
      // no-op
    }
  });
}

function buildAllRowsTitle(count: number): string {
  return `Filler Accounts (${count})`;
}

function buildClanRowsTitle(clanName: string | null, clanTag: string, count: number): string {
  const label = normalizeText(clanName) ?? clanTag;
  return `Filler Accounts in ${label} (${count})`;
}

function buildUserRowsTitle(count: number): string {
  return `Filler Accounts (${count})`;
}

export const Fillers: Command = {
  name: "fillers",
  description: "Mark linked player accounts as filler accounts and list them by guild, user, or current clan",
  options: [
    {
      name: "list",
      description: "List filler accounts",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "Discord user to filter by",
          type: ApplicationCommandOptionType.User,
          required: false,
        },
        {
          name: "clan",
          description: "Tracked clan to filter by",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "set",
      description: "Mark linked accounts as filler accounts for one user",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "user",
          description: "Discord user whose linked accounts should be edited",
          type: ApplicationCommandOptionType.User,
          required: true,
        },
      ],
    },
  ],
  run: async (
    client: Client,
    interaction: ChatInputCommandInteraction,
  ) => {
    if (!interaction.guildId) {
      await interaction.reply({
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "set") {
      const targetUser = interaction.options.getUser("user", true);
      let rows: FillerAccountViewRow[];
      try {
        rows = await listFillerEditorAccountsForDiscordUser({
          guildId: interaction.guildId,
          discordUserId: targetUser.id,
        });
      } catch (error) {
        logFillersEditorDiagnostic(
          "fillers_set_fetch_rows",
          {
            guildId: interaction.guildId,
            targetUserId: targetUser.id,
            actorUserId: interaction.user.id,
          },
          error,
        );
        await interaction.editReply({
          content: FILLERS_EDITOR_FAILURE_MESSAGE,
        });
        return;
      }
      logFillersEditorDiagnostic("fillers_set_fetch_rows", {
        guildId: interaction.guildId,
        targetUserId: targetUser.id,
        actorUserId: interaction.user.id,
        linkedRowCount: rows.length,
        firstRows: rows.slice(0, 5).map(summarizeFillerRowForDiagnostics),
      });
      if (rows.length === 0) {
        await interaction.editReply({
          content: `No linked accounts were found for <@${targetUser.id}>.`,
        });
        return;
      }

      try {
        await renderEditorReply({
          interaction,
          targetUserId: targetUser.id,
          rows,
        });
      } catch (error) {
        logFillersEditorDiagnostic(
          "fillers_set_render_payload",
          {
            phase: "command_failed",
            guildId: interaction.guildId,
            targetUserId: targetUser.id,
            actorUserId: interaction.user.id,
            linkedRowCount: rows.length,
          },
          error,
        );
        await interaction.editReply({
          content: FILLERS_EDITOR_FAILURE_MESSAGE,
        });
      }
      return;
    }

    const user = interaction.options.getUser("user", false);
    const clanTagInput = interaction.options.getString("clan", false);
    if (user && clanTagInput) {
      await interaction.editReply({
        content: "Use only one of `user` or `clan`.",
      });
      return;
    }

    if (user) {
      const rows = await listFillerAccountsForDiscordUser({
        guildId: interaction.guildId,
        discordUserId: user.id,
      });
      if (rows.length === 0) {
        await interaction.editReply({
          content: `No filler accounts are currently linked to <@${user.id}>.`,
        });
        return;
      }

      await renderListReply({
        interaction,
        rows,
        title: buildUserRowsTitle(rows.length),
        scope: "user",
        targetUserId: user.id,
      });
      return;
    }

    if (clanTagInput) {
      const normalizedClanTag = normalizeClanTag(clanTagInput);
      if (!normalizedClanTag) {
        await interaction.editReply({
          content: "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
        });
        return;
      }

      const rows = await listFillerAccountsForClan({
        guildId: interaction.guildId,
        clanTag: normalizedClanTag,
      });
      if (rows.length === 0) {
        await interaction.editReply({
          content: `No filler accounts are currently in clan ${normalizedClanTag}.`,
        });
        return;
      }

      await renderListReply({
        interaction,
        rows,
        title: buildClanRowsTitle(rows[0]?.clanName ?? null, normalizedClanTag, rows.length),
        scope: "clan",
        targetClanTag: normalizedClanTag,
      });
      return;
    }

    const rows = await listFillerAccountsForGuild({
      guildId: interaction.guildId,
    });
    if (rows.length === 0) {
      await interaction.editReply({
        content: "No filler accounts are currently saved for this guild.",
      });
      return;
    }

    await renderListReply({
      interaction,
      rows,
      title: buildAllRowsTitle(rows.length),
      scope: "all",
    });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const rows = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = rows
      .map((row) => {
        const tag = normalizeClanTag(row.tag);
        const label = row.name?.trim() ? `${row.name.trim()} (${tag})` : tag;
        return { name: label.slice(0, 100), value: tag };
      })
      .filter(
        (choice) =>
          choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query),
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
