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

export type CwlRotationImportRowSuggestion = {
  playerTag: string;
  playerName: string;
  score: number;
};

export type CwlRotationImportRowClassification =
  | "structural_row"
  | "exact_match"
  | "fuzzy_match_needs_review"
  | "ambiguous_match_needs_review"
  | "unresolved_needs_review"
  | "explicitly_ignored";

export type CwlRotationImportRow = {
  rowId: string;
  sheetRowNumber: number;
  tabTitle: string;
  clanTag: string;
  clanName: string | null;
  rawText: string;
  parsedPlayerTag: string | null;
  parsedPlayerName: string;
  classification: CwlRotationImportRowClassification;
  reason: string | null;
  suggestions: CwlRotationImportRowSuggestion[];
  dayRows: Array<{
    roundDay: number;
    subbedOut: boolean;
    assignmentOrder: number;
  }>;
  resolvedPlayerTag: string | null;
  resolvedPlayerName: string | null;
  ignored: boolean;
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
  structuralRowCount: number;
  reviewRequiredRowCount: number;
  ignoredRowCount: number;
  days: CwlRotationImportDayPreview[];
  parsedRows: CwlRotationImportRow[];
  trackedRosterRows?: Array<{ playerTag: string; playerName: string }>;
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
  ignoredRows: Array<{
    clanTag: string;
    clanName: string | null;
    tabTitle: string;
    sheetRowNumber: number;
    rawText: string;
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
  parsedRows: CwlRotationImportRow[];
  structuralRowCount: number;
  reviewRequiredRowCount: number;
  ignoredRowCount: number;
};

type ParsedCwlRotationTableHeader = {
  canonical: boolean;
  memberColumnIndex: number;
  playerTagColumnIndex: number | null;
  totalWarsColumnIndex: number | null;
  dayColumns: Array<{ roundDay: number; columnIndex: number }>;
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
        const needsReview = parsed.reviewRequiredRowCount > 0;
        const importable = (!existingVersion || Boolean(input.overwrite)) && !needsReview;
        matchedClans.push({
          clanTag: match.clanTag,
          clanName: match.clanName,
          tabTitle: match.tabTitle,
          existingVersion,
          importable,
          importBlockedReason:
            existingVersion && !input.overwrite
              ? `Active version ${existingVersion} already exists. Use overwrite:true to replace it.`
              : needsReview
                ? `${parsed.reviewRequiredRowCount} row${parsed.reviewRequiredRowCount === 1 ? "" : "s"} need review before save.`
                : null,
          warnings: parsed.warnings,
          structuralRowCount: parsed.structuralRowCount,
          reviewRequiredRowCount: parsed.reviewRequiredRowCount,
          ignoredRowCount: parsed.ignoredRowCount,
          days: buildPreviewDaysFromRows(parsed.parsedRows),
          parsedRows: parsed.parsedRows.map((row) => ({
            ...row,
            clanTag: match.clanTag,
            clanName: match.clanName,
            tabTitle: match.tabTitle,
          })),
          trackedRosterRows: rosterEntries.map((entry) => ({
            playerTag: entry.playerTag,
            playerName: entry.playerName,
          })),
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
    const ignoredRows: Array<{
      clanTag: string;
      clanName: string | null;
      tabTitle: string;
      sheetRowNumber: number;
      rawText: string;
    }> = [];

    for (const clan of input.preview.matchedClans) {
      for (const row of clan.parsedRows) {
        if (row.ignored) {
          ignoredRows.push({
            clanTag: clan.clanTag,
            clanName: clan.clanName,
            tabTitle: clan.tabTitle,
            sheetRowNumber: row.sheetRowNumber,
            rawText: row.rawText,
          });
        }
      }
    }

    const unresolvedRows = input.preview.matchedClans.flatMap((clan) =>
      clan.parsedRows.filter(
        (row) =>
          row.classification !== "structural_row" &&
          !row.ignored &&
          !row.resolvedPlayerTag &&
          row.classification !== "exact_match",
      ),
    );
    if (unresolvedRows.length > 0) {
      throw new Error(
        `Cannot save CWL rotation import while ${unresolvedRows.length} row${unresolvedRows.length === 1 ? "" : "s"} need review or explicit ignore.`,
      );
    }

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
      ignoredRows,
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

function buildPreviewDaysFromRows(rows: CwlRotationImportRow[]): CwlRotationImportDayPreview[] {
  const previewDays = new Map<number, CwlRotationImportDayPreview>();
  for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
    previewDays.set(roundDay, {
      roundDay,
      lineupSize: 0,
      rows: [],
      members: [],
    });
  }

  for (const row of rows) {
    if (row.ignored || !row.resolvedPlayerTag || !row.resolvedPlayerName) continue;
    for (const dayRow of row.dayRows) {
      const previewDay = previewDays.get(dayRow.roundDay);
      if (!previewDay) continue;
      previewDay.rows.push({
        playerTag: row.resolvedPlayerTag,
        playerName: row.resolvedPlayerName,
        subbedOut: dayRow.subbedOut,
        assignmentOrder: dayRow.assignmentOrder,
      });
      previewDay.members.push({
        playerTag: row.resolvedPlayerTag,
        playerName: row.resolvedPlayerName,
        subbedOut: dayRow.subbedOut,
        assignmentOrder: dayRow.assignmentOrder,
      });
    }
  }

  for (const previewDay of previewDays.values()) {
    previewDay.rows.sort((a, b) => a.assignmentOrder - b.assignmentOrder || a.playerName.localeCompare(b.playerName));
    previewDay.members.sort((a, b) => a.assignmentOrder - b.assignmentOrder || a.playerName.localeCompare(b.playerName));
    previewDay.lineupSize = previewDay.rows.filter((row) => !row.subbedOut).length;
  }

  return [...previewDays.values()];
}

export function rebuildCwlRotationImportTabState(
  tab: CwlRotationSheetClanImportTab,
  overwrite: boolean,
): CwlRotationSheetClanImportTab {
  const resolvedRows = tab.parsedRows.filter((row) => row.resolvedPlayerTag && !row.ignored);
  const rosterRows = [...new Map(
    resolvedRows.map((row) => [
      row.resolvedPlayerTag as string,
      {
        playerTag: row.resolvedPlayerTag as string,
        playerName: row.resolvedPlayerName ?? row.parsedPlayerName,
      },
    ]),
  ).values()];
  const pendingReviewCount = tab.parsedRows.filter(
    (row) => row.classification !== "exact_match" && !row.ignored && !row.resolvedPlayerTag,
  ).length;
  const importBlockedReason =
    tab.existingVersion && !overwrite
      ? `Active version ${tab.existingVersion} already exists. Use overwrite:true to replace it.`
      : pendingReviewCount > 0
        ? `${pendingReviewCount} row${pendingReviewCount === 1 ? "" : "s"} need review before save.`
        : null;

  return {
    ...tab,
    days: buildPreviewDaysFromRows(tab.parsedRows),
    rosterRows,
    importable: (!tab.existingVersion || overwrite) && pendingReviewCount <= 0,
    importBlockedReason,
    reviewRequiredRowCount: pendingReviewCount,
    ignoredRowCount: tab.parsedRows.filter((row) => row.ignored).length,
    structuralRowCount: tab.structuralRowCount,
    trackedRosterRows: tab.trackedRosterRows ?? [],
  };
}

function buildExportTabValues(plan: CwlRotationPlanExport): string[][] {
  const values: string[][] = [];
  values.push([`Season: ${plan.season}`]);
  values.push([`Clan: ${plan.clanName || plan.clanTag}`]);
  if (plan.warningSummary) {
    values.push([`Warnings: ${plan.warningSummary}`]);
  }
  values.push([]);

  const dayHeaders = Array.from({ length: 7 }, (_, index) => `Day ${index + 1}`);
  values.push(["Member", "Player Tag", "Total Wars", ...dayHeaders]);

  const playerRows = new Map<
    string,
    {
      playerTag: string;
      playerName: string;
      assignmentOrder: number;
      dayMap: Map<number, boolean>;
    }
  >();

  for (const day of plan.days) {
    for (const row of day.rows) {
      const existing = playerRows.get(row.playerTag) ?? {
        playerTag: row.playerTag,
        playerName: row.playerName,
        assignmentOrder: playerRows.size,
        dayMap: new Map<number, boolean>(),
      };
      existing.playerName = existing.playerName || row.playerName;
      existing.assignmentOrder = Math.min(existing.assignmentOrder, row.assignmentOrder);
      existing.dayMap.set(day.roundDay, !row.subbedOut);
      playerRows.set(row.playerTag, existing);
    }
  }

  const orderedPlayers = [...playerRows.values()].sort((a, b) => {
    if (a.assignmentOrder !== b.assignmentOrder) return a.assignmentOrder - b.assignmentOrder;
    const byName = a.playerName.localeCompare(b.playerName, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.playerTag.localeCompare(b.playerTag);
  });

  for (const player of orderedPlayers) {
    const totalWars = [...player.dayMap.values()].filter(Boolean).length;
    values.push([
      player.playerName,
      player.playerTag,
      String(totalWars),
      ...dayHeaders.map((_, index) => (player.dayMap.get(index + 1) ? "IN" : "")),
    ]);
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
  const rosterLookup = buildRosterLookup(rosterEntries);
  const rosterRows = new Map<string, { playerTag: string; playerName: string }>();
  const parsedRows: CwlRotationImportRow[] = [];
  const daysByRound = new Map<number, ParsedImportDay>();
  for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
    daysByRound.set(roundDay, { roundDay, rows: [] });
  }

  const headerIndex = rows.findIndex((row) => parseCwlRotationTableHeader(row) !== null);
  const header = headerIndex >= 0 ? parseCwlRotationTableHeader(rows[headerIndex]) : null;
  const fallbackHeader: ParsedCwlRotationTableHeader = header ?? inferFallbackCwlRotationTableHeader(rows);

  let structuralRowCount = 0;
  let parsedPlayerRowCount = 0;
  let ignoredRowCount = 0;
  let reviewRequiredRowCount = 0;

  if (headerIndex < 0) {
    warnings.push("Could not find a CWL rotation table header. Using row-based review parsing.");
  }

  for (const [rowIndex, row] of rows.entries()) {
    const sheetRowNumber = rowIndex + 1;
    if (row.every((cell) => cell.length <= 0)) {
      structuralRowCount += 1;
      continue;
    }

    if (isCwlRotationMetaRow(row) || isCwlRotationHeaderLikeRow(row) || isCwlRotationStructuralTitleRow(row)) {
      structuralRowCount += 1;
      continue;
    }

    const parsedRow = parseCwlRotationImportRow({
      row,
      sheetRowNumber,
      header: header ?? fallbackHeader,
      rosterEntries,
      rosterLookup,
      tabTitle: "",
    });
    if (!parsedRow) {
      structuralRowCount += 1;
      continue;
    }

    parsedRows.push(parsedRow);
    parsedPlayerRowCount += 1;
    if (parsedRow.ignored) {
      ignoredRowCount += 1;
    }
    if (parsedRow.classification !== "exact_match" && !parsedRow.ignored) {
      reviewRequiredRowCount += 1;
    }
    if (parsedRow.resolvedPlayerTag && !parsedRow.ignored) {
      rosterRows.set(parsedRow.resolvedPlayerTag, {
        playerTag: parsedRow.resolvedPlayerTag,
        playerName: parsedRow.resolvedPlayerName ?? parsedRow.parsedPlayerName,
      });
    }
  }

  if (structuralRowCount > 0) {
    warnings.push(`Skipped ${structuralRowCount} structural rows.`);
  }
  if (reviewRequiredRowCount > 0) {
    warnings.push(`${reviewRequiredRowCount} row${reviewRequiredRowCount === 1 ? "" : "s"} need review.`);
  }
  if (ignoredRowCount > 0) {
    warnings.push(`${ignoredRowCount} row${ignoredRowCount === 1 ? "" : "s"} explicitly ignored.`);
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

  for (const parsedRow of parsedRows) {
    if (parsedRow.ignored || !parsedRow.resolvedPlayerTag || !parsedRow.resolvedPlayerName) continue;
    for (const dayRow of parsedRow.dayRows) {
      const day = daysByRound.get(dayRow.roundDay);
      if (!day) continue;
      day.rows.push({
        playerTag: parsedRow.resolvedPlayerTag,
        playerName: parsedRow.resolvedPlayerName,
        subbedOut: dayRow.subbedOut,
        assignmentOrder: dayRow.assignmentOrder,
      });
    }
  }

  return {
    days,
    rosterRows: [...rosterRows.values()],
    warnings,
    parsedPlayerRowCount,
    parsedRows,
    structuralRowCount,
    reviewRequiredRowCount,
    ignoredRowCount,
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

function parseCwlRotationTableHeader(row: string[]): ParsedCwlRotationTableHeader | null {
  const memberColumnIndex = row.findIndex((cell) => isCwlRotationMemberHeader(cell));
  if (memberColumnIndex < 0) return null;

  const playerTagColumnIndex = row.findIndex((cell) => isCwlRotationPlayerTagHeader(cell));
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

  if (dayColumnsByRound.size <= 0 && totalWarsColumnIndex >= 0) {
    for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
      const columnIndex = totalWarsColumnIndex + roundDay;
      if (columnIndex < row.length) {
        dayColumnsByRound.set(roundDay, columnIndex);
      }
    }
  }

  if (dayColumnsByRound.size <= 0) return null;

  return {
    canonical: playerTagColumnIndex >= 0,
    memberColumnIndex,
    playerTagColumnIndex: playerTagColumnIndex >= 0 ? playerTagColumnIndex : null,
    totalWarsColumnIndex: totalWarsColumnIndex >= 0 ? totalWarsColumnIndex : null,
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

function isCwlRotationPlayerTagHeader(cell: string): boolean {
  const normalized = sanitizeDisplayText(cell).toLowerCase();
  return normalized === "player tag" || normalized === "tag";
}

function isCwlRotationTotalWarsHeader(cell: string): boolean {
  const normalized = sanitizeDisplayText(cell).toLowerCase();
  return normalized === "total wars" || normalized === "wars";
}

function isCwlRotationHeaderLikeRow(row: string[]): boolean {
  return Boolean(parseCwlRotationTableHeader(row));
}

function isCwlRotationStructuralTitleRow(row: string[]): boolean {
  return row.filter((cell) => sanitizeDisplayText(cell).length > 0).length <= 1;
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

function parseCwlRotationImportRow(input: {
  row: string[];
  sheetRowNumber: number;
  header: ParsedCwlRotationTableHeader;
  rosterEntries: CwlSeasonRosterEntry[];
  rosterLookup: Map<string, CwlSeasonRosterEntry[]>;
  tabTitle: string;
}): CwlRotationImportRow | null {
  const rawText = input.row.map((cell) => sanitizeDisplayText(cell)).join(" | ").trim();
  if (!rawText) return null;

  const memberCell = sanitizeDisplayText(input.row[input.header.memberColumnIndex] ?? "");
  const firstNonEmptyCell = sanitizeDisplayText(input.row.find((cell) => cell.length > 0) ?? "");
  const candidateCell = resolveCwlRotationImportIdentityCell({
    row: input.row,
    header: input.header,
    rawText,
  }) || memberCell || firstNonEmptyCell || rawText;
  const parsedIdentity = parseCwlRotationPlayerIdentity(candidateCell);
  const parsedPlayerName = parsedIdentity?.playerName || candidateCell;
  const explicitTag = normalizePlayerTag(
    input.header.playerTagColumnIndex !== null
      ? String(input.row[input.header.playerTagColumnIndex] ?? "")
      : parsedIdentity?.playerTag ?? "",
  );
  const dayRows = input.header.dayColumns.map((dayColumn, index) => {
    const cellValue = sanitizeDisplayText(input.row[dayColumn.columnIndex] ?? "");
    return {
      roundDay: dayColumn.roundDay,
      subbedOut: !isPlannedInCell(cellValue),
      assignmentOrder: index,
    };
  });
  const rowId = `${normalizeMatchKey(input.tabTitle)}:${input.sheetRowNumber}`;

  if (!memberCell) {
    return {
      rowId,
      sheetRowNumber: input.sheetRowNumber,
      tabTitle: input.tabTitle,
      clanTag: "",
      clanName: null,
      rawText,
      parsedPlayerTag: parsedIdentity?.playerTag ?? null,
      parsedPlayerName,
      classification: "unresolved_needs_review",
      reason: "Could not identify the player name column for this row.",
      suggestions: buildRosterSuggestions(parsedPlayerName, input.rosterEntries, []),
      dayRows,
      resolvedPlayerTag: null,
      resolvedPlayerName: null,
      ignored: false,
    };
  }

  if (explicitTag) {
    return {
      rowId,
      sheetRowNumber: input.sheetRowNumber,
      tabTitle: input.tabTitle,
      clanTag: "",
      clanName: null,
      rawText,
      parsedPlayerTag: explicitTag,
      parsedPlayerName,
      classification: "exact_match",
      reason: null,
      suggestions: [],
      dayRows,
      resolvedPlayerTag: explicitTag,
      resolvedPlayerName: parsedPlayerName,
      ignored: false,
    };
  }

  const exactRosterMatch = findExactRosterMatch(parsedPlayerName, input.rosterLookup);
  if (exactRosterMatch) {
    return {
      rowId,
      sheetRowNumber: input.sheetRowNumber,
      tabTitle: input.tabTitle,
      clanTag: "",
      clanName: null,
      rawText,
      parsedPlayerTag: exactRosterMatch.playerTag,
      parsedPlayerName: exactRosterMatch.playerName || parsedPlayerName,
      classification: "exact_match",
      reason: null,
      suggestions: [],
      dayRows,
      resolvedPlayerTag: exactRosterMatch.playerTag,
      resolvedPlayerName: exactRosterMatch.playerName || parsedPlayerName,
      ignored: false,
    };
  }

  const suggestions = buildRosterSuggestions(parsedPlayerName, input.rosterEntries, []);
  const bestScore = suggestions[0]?.score ?? 0;
  const secondScore = suggestions[1]?.score ?? 0;
  const classification =
    suggestions.length <= 0
      ? "unresolved_needs_review"
      : suggestions.length > 1 && Math.abs(bestScore - secondScore) <= 0.05
        ? "ambiguous_match_needs_review"
        : "fuzzy_match_needs_review";

  return {
    rowId,
    sheetRowNumber: input.sheetRowNumber,
    tabTitle: input.tabTitle,
    clanTag: "",
    clanName: null,
    rawText,
    parsedPlayerTag: parsedIdentity?.playerTag ?? null,
    parsedPlayerName,
    classification,
    reason:
      classification === "ambiguous_match_needs_review"
        ? "Multiple tracked players look plausible."
        : classification === "fuzzy_match_needs_review"
          ? "Player row needs review before it can be saved."
          : "Could not identify a tracked player for this row.",
    suggestions,
    dayRows,
    resolvedPlayerTag: null,
    resolvedPlayerName: null,
    ignored: false,
  };
}

function findExactRosterMatch(
  playerName: string,
  rosterLookup: Map<string, CwlSeasonRosterEntry[]>,
): CwlSeasonRosterEntry | null {
  const matches = rosterLookup.get(normalizeRosterNameKey(playerName)) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

function buildRosterSuggestions(
  playerName: string,
  rosterEntries: CwlSeasonRosterEntry[],
  excludedTags: string[] = [],
): CwlRotationImportRowSuggestion[] {
  const normalizedQuery = normalizeMatchKey(playerName);
  if (!normalizedQuery) return [];
  const excludedTagSet = new Set(excludedTags.map((tag) => normalizePlayerTag(tag)).filter(Boolean));

  return rosterEntries
    .map((entry) => {
      const normalizedCandidate = normalizeRosterNameKey(entry.playerName);
      const score = calculateMatchScore(normalizedQuery, normalizedCandidate);
      return {
        playerTag: entry.playerTag,
        playerName: entry.playerName,
        score,
      };
    })
    .filter((entry) => entry.score >= 0.55 && !excludedTagSet.has(normalizePlayerTag(entry.playerTag)))
    .sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName) || a.playerTag.localeCompare(b.playerTag))
    .slice(0, 5);
}

function calculateMatchScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const distance = levenshteinDistance(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length));
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j] ?? previous[j];
    }
  }
  return previous[b.length] ?? 0;
}

function normalizeRosterNameKey(input: string): string {
  return normalizeMatchKey(stripPlayerDisplayLabel(input));
}

function stripPlayerDisplayLabel(input: string): string {
  return sanitizeDisplayText(input)
    .replace(/\s*\(\s*#?[A-Z0-9]{5,15}\s*\)\s*$/i, "")
    .replace(/\s*`#?[A-Z0-9]{5,15}`\s*$/i, "")
    .trim();
}

function resolveCwlRotationImportIdentityCell(input: {
  row: string[];
  header: ParsedCwlRotationTableHeader;
  rawText: string;
}): string {
  const firstCell = sanitizeDisplayText(input.row[0] ?? "");
  const secondCell = sanitizeDisplayText(input.row[1] ?? "");
  const explicitIdentityCell = sanitizeDisplayText(input.row[input.header.memberColumnIndex] ?? "");

  if (isRosterIndexCell(firstCell) && secondCell) {
    return secondCell;
  }

  if (input.header.canonical && explicitIdentityCell) {
    return explicitIdentityCell;
  }

  if (explicitIdentityCell) {
    return explicitIdentityCell;
  }

  if (secondCell) {
    return secondCell;
  }

  return sanitizeDisplayText(input.rawText);
}

function isRosterIndexCell(cell: string): boolean {
  const normalized = sanitizeDisplayText(cell);
  return /^\d+$/.test(normalized);
}

function inferFallbackCwlRotationTableHeader(rows: string[][]): ParsedCwlRotationTableHeader {
  const sampleRow =
    rows.find((row) => {
      if (!row.some((cell) => sanitizeDisplayText(cell).length > 0)) return false;
      if (isCwlRotationMetaRow(row) || isCwlRotationHeaderLikeRow(row) || isCwlRotationStructuralTitleRow(row)) {
        return false;
      }
      return true;
    }) ?? [];

  const firstCell = sanitizeDisplayText(sampleRow[0] ?? "");
  const secondCell = sanitizeDisplayText(sampleRow[1] ?? "");
  if (isRosterIndexCell(firstCell) && secondCell) {
    const hasTrailingTotal = isRosterIndexCell(sanitizeDisplayText(sampleRow.at(-1) ?? ""));
    const dayColumnCount = Math.max(0, hasTrailingTotal ? sampleRow.length - 3 : sampleRow.length - 2);
    return {
      canonical: false,
      memberColumnIndex: 1,
      playerTagColumnIndex: null,
      totalWarsColumnIndex: null,
      dayColumns: Array.from({ length: Math.min(7, dayColumnCount) }, (_, index) => ({
        roundDay: index + 1,
        columnIndex: index + 2,
      })),
    };
  }

  return {
    canonical: false,
    memberColumnIndex: 0,
    playerTagColumnIndex: null,
    totalWarsColumnIndex: null,
    dayColumns: inferFallbackDayColumns(rows),
  };
}

function isPlannedInCell(cell: string): boolean {
  const normalized = sanitizeDisplayText(cell).toLowerCase();
  return normalized === "in" || normalized === "yes" || normalized === "y" || normalized === "true";
}

function normalizeMatchKey(input: string): string {
  return sanitizeDisplayText(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function inferFallbackDayColumns(rows: string[][]): Array<{ roundDay: number; columnIndex: number }> {
  const maxColumns = Math.max(0, ...rows.map((row) => row.length));
  const dayColumns: Array<{ roundDay: number; columnIndex: number }> = [];
  for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
    const columnIndex = roundDay;
    if (columnIndex < maxColumns) {
      dayColumns.push({ roundDay, columnIndex });
    }
  }
  return dayColumns;
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
