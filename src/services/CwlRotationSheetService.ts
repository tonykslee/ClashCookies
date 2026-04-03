import { prisma } from "../prisma";
import { SettingsService } from "./SettingsService";
import { GoogleSheetsService } from "./GoogleSheetsService";
import { PublicGoogleSheetsService } from "./PublicGoogleSheetsService";
import {
  cwlRotationService,
  type CwlRotationPlanExport,
  type PersistImportedCwlRotationPlanResult,
} from "./CwlRotationService";
import { cwlStateService, type CwlSeasonRosterEntry } from "./CwlStateService";
import { normalizeClanTag, normalizePlayerTag } from "./PlayerLinkService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";

const CWL_IMPORT_RANGE = "A:AZ";

export type CwlRotationImportDayPreview = {
  roundDay: number;
  lineupSize: number;
  rows: Array<{
    playerTag: string;
    playerName: string;
    subbedOut: boolean;
    assignmentOrder: number;
  }>;
  members: Array<{
    playerTag: string;
    playerName: string;
    subbedOut: boolean;
    assignmentOrder: number;
  }>;
};

export type CwlRotationImportPreview = {
  sourceSheetId: string;
  sourceSheetTitle: string | null;
  season: string;
  matchedClans: CwlRotationSheetClanImportTab[];
  skippedTrackedClans: Array<{
    clanTag: string;
    clanName: string | null;
    reason: string;
  }>;
  skippedTabs: Array<{
    tabTitle: string;
    reason: string;
  }>;
  warnings: string[];
};

export type CwlRotationSheetClanImportTab = {
  clanTag: string;
  clanName: string | null;
  tabTitle: string;
  existingVersion: number | null;
  importable: boolean;
  importBlockedReason: string | null;
  warnings: string[];
  days: CwlRotationImportDayPreview[];
  rosterRows: Array<{ playerTag: string; playerName: string }>;
};

export type CwlRotationSheetImportPreview = {
  sourceSheetId: string;
  sourceSheetTitle: string | null;
  season: string;
  matchedClans: CwlRotationSheetClanImportTab[];
  skippedTrackedClans: Array<{
    clanTag: string;
    clanName: string | null;
    reason: string;
  }>;
  skippedTabs: Array<{
    tabTitle: string;
    reason: string;
  }>;
  warnings: string[];
};

export type CwlRotationSheetImportConfirmResult = {
  season: string;
  saved: PersistImportedCwlRotationPlanResult[];
  skippedTrackedClans: Array<{
    clanTag: string;
    clanName: string | null;
    reason: string;
  }>;
  skippedTabs: Array<{
    tabTitle: string;
    reason: string;
  }>;
};

export type CwlRotationSheetExportResult = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  tabCount: number;
};

type ParsedImportDayRow = {
  playerTag: string;
  playerName: string;
  subbedOut: boolean;
  assignmentOrder: number;
};

type ParsedImportDay = {
  roundDay: number;
  rows: ParsedImportDayRow[];
};

type ParsedTabImport = {
  days: ParsedImportDay[];
  rosterRows: Array<{ playerTag: string; playerName: string }>;
  warnings: string[];
  parsedPlayerRowCount: number;
};

type TrackedClanMatch = {
  clanTag: string;
  clanName: string | null;
  tabTitle: string;
};

/** Purpose: own CWL planner workbook parsing and export orchestration around persisted planner tables. */
export class CwlRotationSheetService {
  private readonly sheets: GoogleSheetsService;
  private readonly publicSheets: PublicGoogleSheetsService;

  constructor(private readonly settings = new SettingsService()) {
    this.sheets = new GoogleSheetsService(this.settings);
    this.publicSheets = new PublicGoogleSheetsService();
  }

  /** Purpose: parse one public workbook into clan-matched import previews without writing anything. */
  async buildImportPreview(input: {
    sheetLink: string;
    overwrite?: boolean;
    season?: string;
  }): Promise<CwlRotationSheetImportPreview> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const sheetIdResult = extractSpreadsheetId(input.sheetLink);
    if (!sheetIdResult.sheetId) {
      if (sheetIdResult.error === "unsupported_format") {
        throw new Error(
          "Unsupported Google Sheets link format. Use a standard /spreadsheets/d/<id> link or a published /spreadsheets/d/e/<published-id>/pubhtml link.",
        );
      }
      throw new Error(
        "No spreadsheet ID could be extracted from the provided Google Sheets link.",
      );
    }
    const sheetId = sheetIdResult.sheetId;
    const isPublicPublishedSheet = isPublishedGoogleSheetsLink(input.sheetLink);

    const trackedClans = await prisma.cwlTrackedClan.findMany({
      where: { season },
      select: { tag: true, name: true },
    });

    const buildPreviewFromTabs = async (
      inputTabs: Array<{
        title: string;
        readValues: () => Promise<string[][]>;
      }>,
      sourceSheetTitle: string | null,
    ): Promise<CwlRotationSheetImportPreview> => {
      const tabTitles = inputTabs.map((tab) => tab.title);
      const matchedTabs = matchTrackedClansToTabs(trackedClans, tabTitles);
      const matchedClans: CwlRotationSheetClanImportTab[] = [];
      const skippedTrackedClans: Array<{
        clanTag: string;
        clanName: string | null;
        reason: string;
      }> = [];
      const skippedTabs: Array<{
        tabTitle: string;
        reason: string;
      }> = [];
      const warnings: string[] = [];
      const usedTabTitles = new Map<string, string>();

      for (const clan of trackedClans) {
        const clanTag = normalizeClanTag(clan.tag);
        const match = matchedTabs.get(clanTag);
        if (!match) {
          skippedTrackedClans.push({
            clanTag,
            clanName: sanitizeDisplayText(clan.name) || null,
            reason: "No workbook tab name contained this tracked CWL clan name.",
          });
          continue;
        }

        const existingOwner = usedTabTitles.get(match.tabTitle);
        if (existingOwner && existingOwner !== clanTag) {
          skippedTrackedClans.push({
            clanTag,
            clanName: sanitizeDisplayText(clan.name) || null,
            reason: `Workbook tab "${match.tabTitle}" was already matched to another clan; rename tabs so each tracked clan name appears once.`,
          });
          continue;
        }

        usedTabTitles.set(match.tabTitle, clanTag);
        const tabEntry = inputTabs.find((tab) => tab.title === match.tabTitle);
        if (!tabEntry) {
          skippedTrackedClans.push({
            clanTag,
            clanName: sanitizeDisplayText(clan.name) || null,
            reason: `Workbook tab "${match.tabTitle}" was not available in the workbook payload.`,
          });
          continue;
        }

        const tabValues = await tabEntry.readValues();
        const rosterEntries = await cwlStateService.listSeasonRosterForClan({
          clanTag: match.clanTag,
          season,
        });
        const parsed = parseCwlPlannerTab(tabValues, rosterEntries);
        warnings.push(...parsed.warnings);

        if (parsed.parsedPlayerRowCount <= 0) {
          skippedTrackedClans.push({
            clanTag: match.clanTag,
            clanName: match.clanName,
            reason:
              parsed.warnings.join(" ") ||
              "Could not parse tab as a CWL rotation table. Expected a player-per-row table with day columns.",
          });
          continue;
        }

        const existingVersion = await loadActiveRotationPlanVersion({
          clanTag: match.clanTag,
          season,
        });
        const importable = !existingVersion || Boolean(input.overwrite);
        matchedClans.push({
          clanTag: match.clanTag,
          clanName: match.clanName,
          tabTitle: match.tabTitle,
          existingVersion,
          importable,
          importBlockedReason:
            existingVersion && !input.overwrite
              ? `Active version ${existingVersion} already exists. Use overwrite:true to replace it.`
              : null,
          warnings: parsed.warnings,
          days: buildPreviewDays(parsed.days),
          rosterRows: parsed.rosterRows,
        });
      }

      for (const tabTitle of tabTitles) {
        if (usedTabTitles.has(tabTitle)) continue;
        skippedTabs.push({
          tabTitle,
          reason: "Workbook tab did not match any tracked CWL clan name.",
        });
      }

      return {
        sourceSheetId: sheetId,
        sourceSheetTitle,
        season,
        matchedClans,
        skippedTrackedClans,
        skippedTabs,
        warnings,
      };
    };

    if (isPublicPublishedSheet) {
      const source = await this.publicSheets.readPublishedWorkbook(
        buildPublishedWorkbookUrl(sheetId),
      );
      return await buildPreviewFromTabs(
        source.tabs.map((tab) => ({
          title: tab.title,
          readValues: () => this.publicSheets.readPublishedSheetValues(tab.pageUrl),
        })),
        source.title,
      );
    }

    const metadata = await this.sheets.getSpreadsheetMetadata(sheetId);
    return await buildPreviewFromTabs(
      metadata.sheets
        .filter((sheet) => !sheet.hidden)
        .map((sheet) => ({
          title: sheet.title,
          readValues: () =>
            this.sheets.readValues(
              sheetId,
              `${escapeSheetTabName(sheet.title)}!${CWL_IMPORT_RANGE}`,
            ),
        })),
      metadata.title,
    );
  }

  /** Purpose: persist one confirmed import preview into the existing planner tables. */
  async confirmImport(input: {
    preview: CwlRotationSheetImportPreview;
    overwrite?: boolean;
  }): Promise<CwlRotationSheetImportConfirmResult> {
    const overwrite = Boolean(input.overwrite);
    const saved: PersistImportedCwlRotationPlanResult[] = [];
    for (const clan of input.preview.matchedClans) {
      if (!clan.importable) {
        saved.push({
          outcome: "blocked_existing",
          season: input.preview.season,
          clanTag: clan.clanTag,
          clanName: clan.clanName,
          existingVersion: clan.existingVersion ?? 0,
          sourceTabName: clan.tabTitle,
        });
        continue;
      }

      const result = await cwlRotationService.persistImportedPlan({
        clanTag: clan.clanTag,
        clanName: clan.clanName,
        sourceSheetId: input.preview.sourceSheetId,
        sourceSheetTitle: input.preview.sourceSheetTitle,
        sourceTabName: clan.tabTitle,
        season: input.preview.season,
        overwrite,
        warningSummary: clan.warnings.join(" | ") || null,
        metadata: {
          source: "sheet-import",
          skippedTrackedClans: input.preview.skippedTrackedClans,
          skippedTabs: input.preview.skippedTabs,
        },
        rosterRows: clan.rosterRows,
        days: clan.days.map((day) => ({
          roundDay: day.roundDay,
          lineupSize: day.lineupSize,
          locked: false,
          rows: day.rows,
          activeMembers: day.rows
            .filter((row) => !row.subbedOut)
            .map((row) => ({
              playerTag: row.playerTag,
              playerName: row.playerName,
              assignmentOrder: row.assignmentOrder,
            })),
        })),
      });
      saved.push(result);
    }

    return {
      season: input.preview.season,
      saved,
      skippedTrackedClans: input.preview.skippedTrackedClans,
      skippedTabs: input.preview.skippedTabs,
    };
  }

  /** Purpose: export the active CWL planner state into one brand-new public workbook. */
  async exportActivePlans(input?: {
    season?: string;
  }): Promise<CwlRotationSheetExportResult> {
    const plans = await cwlRotationService.listActivePlanExports(input);
    const tabNames = plans.map((plan) =>
      plan.clanName ? `${plan.clanName} ${plan.clanTag}` : plan.clanTag,
    );
    const spreadsheet = await this.sheets.createSpreadsheet({
      title: `ClashCookies CWL Rotation Export ${input?.season ?? resolveCurrentCwlSeasonKey()}`,
      tabNames,
    });
    const tabs = plans.map((plan) => ({
      tabName: plan.clanName ? `${plan.clanName} ${plan.clanTag}` : plan.clanTag,
      values: buildExportTabValues(plan),
    }));
    await this.sheets.writeSpreadsheetTabs({
      spreadsheetId: spreadsheet.spreadsheetId,
      tabs,
    });
    await this.sheets.makeSpreadsheetPublic(spreadsheet.spreadsheetId);

    return {
      spreadsheetId: spreadsheet.spreadsheetId,
      spreadsheetUrl: spreadsheet.spreadsheetUrl,
      tabCount: tabs.length,
    };
  }
}

export const cwlRotationSheetService = new CwlRotationSheetService();

function buildPreviewDays(days: ParsedImportDay[]): CwlRotationImportDayPreview[] {
  const previewDays = new Map<number, CwlRotationImportDayPreview>();
  for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
    previewDays.set(roundDay, {
      roundDay,
      lineupSize: 0,
      rows: [],
      members: [],
    });
  }

  for (const day of days) {
    const previewDay = previewDays.get(day.roundDay);
    if (!previewDay) continue;
    previewDay.rows = day.rows.map((row) => ({
      playerTag: row.playerTag,
      playerName: row.playerName,
      subbedOut: row.subbedOut,
      assignmentOrder: row.assignmentOrder,
    }));
    previewDay.members = day.rows.map((row) => ({
      playerTag: row.playerTag,
      playerName: row.playerName,
      subbedOut: row.subbedOut,
      assignmentOrder: row.assignmentOrder,
    }));
    previewDay.lineupSize = day.rows.filter((row) => !row.subbedOut).length;
  }

  return [...previewDays.values()];
}

function buildExportTabValues(plan: CwlRotationPlanExport): string[][] {
  const values: string[][] = [];
  values.push([`Season: ${plan.season}`]);
  values.push([`Clan: ${plan.clanName || plan.clanTag}`]);
  if (plan.warningSummary) {
    values.push([`Warnings: ${plan.warningSummary}`]);
  }
  values.push([]);

  for (const day of plan.days) {
    values.push([`Day ${day.roundDay}`]);
    for (const row of day.rows) {
      const prefix = row.subbedOut ? ":x:" : ":black_circle:";
      values.push([`${prefix} ${row.playerName} (${row.playerTag})`]);
    }
    values.push([]);
  }

  while (values.length > 0 && values[values.length - 1]?.every((cell) => String(cell ?? "").trim().length <= 0)) {
    values.pop();
  }
  return values;
}

async function loadActiveRotationPlanVersion(input: {
  clanTag: string;
  season: string;
}): Promise<number | null> {
  const plan = await prisma.cwlRotationPlan.findFirst({
    where: {
      clanTag: input.clanTag,
      season: input.season,
      isActive: true,
    },
    orderBy: [{ version: "desc" }],
    select: { version: true },
  });
  return plan?.version ?? null;
}

function matchTrackedClansToTabs(
  trackedClans: Array<{ tag: string; name: string | null }>,
  tabTitles: string[],
): Map<string, TrackedClanMatch> {
  const matches = new Map<string, TrackedClanMatch>();
  const normalizedTabTitles = tabTitles.map((tabTitle) => ({
    tabTitle,
    lower: sanitizeDisplayText(tabTitle).toLowerCase(),
  }));

  for (const clan of trackedClans) {
    const clanTag = normalizeClanTag(clan.tag);
    const clanName = sanitizeDisplayText(clan.name);
    if (!clanTag || !clanName) continue;
    const matchingTabs = normalizedTabTitles.filter((tab) => tab.lower.includes(clanName.toLowerCase()));
    if (matchingTabs.length !== 1) continue;
    matches.set(clanTag, {
      clanTag,
      clanName,
      tabTitle: matchingTabs[0].tabTitle,
    });
  }

  return matches;
}

function parseCwlPlannerTab(
  values: string[][],
  rosterEntries: CwlSeasonRosterEntry[] = [],
): ParsedTabImport {
  const rows = values.map((row) => row.map((cell) => sanitizeDisplayText(cell)));
  const warnings: string[] = [];
  const rosterRows = new Map<string, { playerTag: string; playerName: string }>();
  const rosterLookup = buildRosterLookup(rosterEntries);
  const daysByRound = new Map<number, ParsedImportDay>();
  for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
    daysByRound.set(roundDay, { roundDay, rows: [] });
  }

  const headerIndex = rows.findIndex((row) => parseCwlRotationTableHeader(row) !== null);
  if (headerIndex < 0) {
    warnings.push(
      "Could not parse tab as a CWL rotation table. Expected a player-per-row table with day columns.",
    );
    return {
      days: [...daysByRound.values()],
      rosterRows: [],
      warnings,
      parsedPlayerRowCount: 0,
    };
  }

  const header = parseCwlRotationTableHeader(rows[headerIndex]);
  if (!header) {
    warnings.push(
      "Could not parse tab as a CWL rotation table. Expected a player-per-row table with day columns.",
    );
    return {
      days: [...daysByRound.values()],
      rosterRows: [],
      warnings,
      parsedPlayerRowCount: 0,
    };
  }

  const missingDays = [...Array.from({ length: 7 }, (_, index) => index + 1)].filter(
    (roundDay) => !header.dayColumns.some((entry) => entry.roundDay === roundDay),
  );
  if (missingDays.length > 0) {
    warnings.push(`Missing day columns: Day ${missingDays.join(", Day ")}.`);
  }

  let skippedNonDataRows = 0;
  let skippedMalformedRows = 0;
  let skippedDuplicateRows = 0;
  let parsedPlayerRowCount = 0;

  for (const [rowIndex, row] of rows.entries()) {
    if (rowIndex <= headerIndex) {
      if (row.some((cell) => cell.length > 0)) skippedNonDataRows += 1;
      continue;
    }

    if (row.every((cell) => cell.length <= 0)) {
      continue;
    }

    if (isCwlRotationMetaRow(row)) {
      skippedNonDataRows += 1;
      continue;
    }

    if (isCwlRotationHeaderLikeRow(row)) {
      skippedNonDataRows += 1;
      continue;
    }

    const parsed = parseCwlRotationPlayerRow(row, header.memberColumnIndex, rosterLookup);
    if (!parsed) {
      skippedMalformedRows += 1;
      continue;
    }

    if (rosterRows.has(parsed.playerTag)) {
      skippedDuplicateRows += 1;
      continue;
    }

    const assignmentOrder = parsedPlayerRowCount;
    parsedPlayerRowCount += 1;
    rosterRows.set(parsed.playerTag, {
      playerTag: parsed.playerTag,
      playerName: parsed.playerName,
    });

    for (const dayColumn of header.dayColumns) {
      const day = daysByRound.get(dayColumn.roundDay);
      if (!day) continue;
      const cellValue = sanitizeDisplayText(row[dayColumn.columnIndex] ?? "");
      day.rows.push({
        playerTag: parsed.playerTag,
        playerName: parsed.playerName,
        subbedOut: !isPlannedInCell(cellValue),
        assignmentOrder,
      });
    }
  }

  if (skippedNonDataRows > 0) {
    warnings.push(`Skipped ${skippedNonDataRows} non-data rows.`);
  }
  if (skippedMalformedRows > 0) {
    warnings.push(`Skipped ${skippedMalformedRows} malformed player rows.`);
  }
  if (skippedDuplicateRows > 0) {
    warnings.push(`Skipped ${skippedDuplicateRows} duplicate player rows.`);
  }
  if (parsedPlayerRowCount <= 0) {
    warnings.push(
      "Could not parse tab as a CWL rotation table. Expected a player-per-row table with day columns.",
    );
  }

  const days: ParsedImportDay[] = [];
  for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
    days.push(daysByRound.get(roundDay) ?? { roundDay, rows: [] });
  }

  return {
    days,
    rosterRows: [...rosterRows.values()],
    warnings,
    parsedPlayerRowCount,
  };
}

function buildRosterLookup(rosterEntries: CwlSeasonRosterEntry[]): Map<string, CwlSeasonRosterEntry[]> {
  const lookup = new Map<string, CwlSeasonRosterEntry[]>();
  for (const entry of rosterEntries) {
    const key = normalizeRosterNameKey(entry.playerName);
    if (!key) continue;
    const list = lookup.get(key) ?? [];
    list.push(entry);
    lookup.set(key, list);
  }
  return lookup;
}

function parseCwlRotationTableHeader(row: string[]): {
  memberColumnIndex: number;
  totalWarsColumnIndex: number | null;
  dayColumns: Array<{ roundDay: number; columnIndex: number }>;
} | null {
  const memberColumnIndex = row.findIndex((cell) => isCwlRotationMemberHeader(cell));
  if (memberColumnIndex < 0) return null;

  const totalWarsColumnIndex = row.findIndex((cell) => isCwlRotationTotalWarsHeader(cell));
  const explicitDayColumns = row
    .map((cell, columnIndex) => ({
      roundDay: parseRoundDayHeader(cell),
      columnIndex,
    }))
    .filter((entry): entry is { roundDay: number; columnIndex: number } => entry.roundDay !== null);

  const dayColumnsByRound = new Map<number, number>();
  for (const entry of explicitDayColumns) {
    if (!dayColumnsByRound.has(entry.roundDay)) {
      dayColumnsByRound.set(entry.roundDay, entry.columnIndex);
    }
  }

  if (dayColumnsByRound.size <= 0 && totalWarsColumnIndex !== null) {
    for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
      const columnIndex = totalWarsColumnIndex + roundDay;
      if (columnIndex < row.length) {
        dayColumnsByRound.set(roundDay, columnIndex);
      }
    }
  }

  if (dayColumnsByRound.size <= 0) return null;

  return {
    memberColumnIndex,
    totalWarsColumnIndex,
    dayColumns: [...dayColumnsByRound.entries()]
      .map(([roundDay, columnIndex]) => ({ roundDay, columnIndex }))
      .sort((a, b) => a.roundDay - b.roundDay),
  };
}

function parseRoundDayHeader(cell: string): number | null {
  const normalized = sanitizeDisplayText(cell).toLowerCase();
  const directNumber = normalized.match(/^\d{1,2}$/);
  if (directNumber) {
    const roundDay = Number(directNumber[0]);
    return roundDay >= 1 && roundDay <= 7 ? roundDay : null;
  }

  const match = normalized.match(/\b(?:day|round)\s*(\d{1,2})\b/);
  if (!match) return null;
  const roundDay = Number(match[1]);
  return roundDay >= 1 && roundDay <= 7 ? roundDay : null;
}

function isCwlRotationMemberHeader(cell: string): boolean {
  const normalized = sanitizeDisplayText(cell).toLowerCase();
  return normalized === "member" || normalized === "player" || normalized === "player name";
}

function isCwlRotationTotalWarsHeader(cell: string): boolean {
  const normalized = sanitizeDisplayText(cell).toLowerCase();
  return normalized === "total wars" || normalized === "wars";
}

function isCwlRotationHeaderLikeRow(row: string[]): boolean {
  return Boolean(parseCwlRotationTableHeader(row));
}

function isCwlRotationMetaRow(row: string[]): boolean {
  const firstCell = sanitizeDisplayText(row.find((cell) => cell.length > 0) ?? "").toLowerCase();
  return (
    firstCell.startsWith("season:") ||
    firstCell.startsWith("clan:") ||
    firstCell.startsWith("league:") ||
    firstCell.startsWith("warnings:") ||
    firstCell.startsWith("note:") ||
    firstCell.startsWith("source:")
  );
}

function parseCwlRotationPlayerRow(
  row: string[],
  memberColumnIndex: number,
  rosterLookup: Map<string, CwlSeasonRosterEntry[]>,
): { playerTag: string; playerName: string } | null {
  const memberCell = sanitizeDisplayText(row[memberColumnIndex] ?? row.find((cell) => cell.length > 0) ?? "");
  if (!memberCell) return null;

  const parsedIdentity = parseCwlRotationPlayerIdentity(memberCell);
  if (parsedIdentity?.playerTag) {
    return {
      playerTag: parsedIdentity.playerTag,
      playerName: parsedIdentity.playerName,
    };
  }

  const rosterMatches = rosterLookup.get(normalizeRosterNameKey(parsedIdentity?.playerName ?? memberCell)) ?? [];
  if (rosterMatches.length !== 1) return null;
  return {
    playerTag: rosterMatches[0].playerTag,
    playerName: rosterMatches[0].playerName || parsedIdentity?.playerName || memberCell,
  };
}

function parseCwlRotationPlayerIdentity(cell: string): { playerTag: string | null; playerName: string } | null {
  const trimmed = sanitizeDisplayText(cell);
  if (!trimmed) return null;

  const tagCandidates = trimmed.match(/#?[A-Z0-9]{5,15}/gi) ?? [];
  const playerTag = tagCandidates
    .map((tag) => normalizePlayerTag(tag))
    .find(Boolean) ?? null;

  let playerName = trimmed
    .replace(/:x:/gi, " ")
    .replace(/\bsubbed\s*out\b/gi, " ")
    .replace(/\bIN\b/gi, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[-–—|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!playerName) {
    playerName = trimmed;
  }

  return {
    playerTag,
    playerName,
  };
}

function normalizeRosterNameKey(input: string): string {
  return sanitizeDisplayText(input).toLowerCase();
}

function isPlannedInCell(cell: string): boolean {
  const normalized = sanitizeDisplayText(cell).toLowerCase();
  return normalized === "in" || normalized === "yes" || normalized === "y" || normalized === "true";
}
function escapeSheetTabName(tabName: string): string {
  return `'${String(tabName ?? "").trim().replace(/'/g, "''")}'`;
}

function buildPublishedWorkbookUrl(publishedSheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/e/${encodeURIComponent(
    publishedSheetId,
  )}/pubhtml`;
}

function isPublishedGoogleSheetsLink(input: string): boolean {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.hostname === "docs.google.com" &&
      parsed.pathname.includes("/spreadsheets/d/e/") &&
      parsed.pathname.includes("/pub")
    );
  } catch {
    return false;
  }
}

function extractSpreadsheetId(input: string): {
  sheetId: string | null;
  error: "unsupported_format" | "missing_id" | null;
} {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return { sheetId: null, error: "missing_id" };
  }

  const directMatch = trimmed.match(/^[a-zA-Z0-9-_]{20,}$/);
  if (directMatch) {
    return { sheetId: trimmed, error: null };
  }

  try {
    const parsed = new URL(trimmed);
    const publishedMatch = parsed.pathname.match(
      /\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/,
    );
    if (publishedMatch?.[1]) {
      return { sheetId: publishedMatch[1], error: null };
    }
    const standardMatch = parsed.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (standardMatch?.[1]) {
      return { sheetId: standardMatch[1], error: null };
    }
    return { sheetId: null, error: "missing_id" };
  } catch {
    return { sheetId: null, error: "unsupported_format" };
  }
}

function sanitizeDisplayText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
