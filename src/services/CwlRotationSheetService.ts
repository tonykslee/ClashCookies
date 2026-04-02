import { prisma } from "../prisma";
import { SettingsService } from "./SettingsService";
import { GoogleSheetsService } from "./GoogleSheetsService";
import {
  cwlRotationService,
  type CwlRotationPlanExport,
  type PersistImportedCwlRotationPlanResult,
} from "./CwlRotationService";
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
};

type TrackedClanMatch = {
  clanTag: string;
  clanName: string | null;
  tabTitle: string;
};

/** Purpose: own CWL planner workbook parsing and export orchestration around persisted planner tables. */
export class CwlRotationSheetService {
  private readonly sheets: GoogleSheetsService;

  constructor(private readonly settings = new SettingsService()) {
    this.sheets = new GoogleSheetsService(this.settings);
  }

  /** Purpose: parse one public workbook into clan-matched import previews without writing anything. */
  async buildImportPreview(input: {
    sheetLink: string;
    overwrite?: boolean;
    season?: string;
  }): Promise<CwlRotationSheetImportPreview> {
    const season = input.season ?? resolveCurrentCwlSeasonKey();
    const sheetId = extractSpreadsheetId(input.sheetLink);
    if (!sheetId) {
      throw new Error("Unable to parse a Google Sheet ID from the provided link.");
    }

    const [metadata, trackedClans] = await Promise.all([
      this.sheets.getSpreadsheetMetadata(sheetId),
      prisma.cwlTrackedClan.findMany({
        where: { season },
        select: { tag: true, name: true },
      }),
    ]);

    const tabTitles = metadata.sheets.filter((sheet) => !sheet.hidden).map((sheet) => sheet.title);
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
      const tabValues = await this.sheets.readValues(
        sheetId,
        `${escapeSheetTabName(match.tabTitle)}!${CWL_IMPORT_RANGE}`,
      );
      const parsed = parseCwlPlannerTab(tabValues);
      warnings.push(...parsed.warnings);

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
        importBlockedReason: existingVersion && !input.overwrite
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
      sourceSheetTitle: metadata.title,
      season,
      matchedClans,
      skippedTrackedClans,
      skippedTabs,
      warnings,
    };
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

function parseCwlPlannerTab(values: string[][]): ParsedTabImport {
  const warnings: string[] = [];
  const daysByRound = new Map<number, ParsedImportDay>();
  const rosterRows = new Map<string, { playerTag: string; playerName: string }>();
  let currentRoundDay = 1;
  let hasDayHeader = false;
  let seenMemberRow = false;

  for (const [rowIndex, row] of values.entries()) {
    const lineCells = row
      .flatMap((cell) => String(cell ?? "").split(/\r?\n/g))
      .map((cell) => sanitizeDisplayText(cell))
      .filter((cell) => cell.length > 0);
    if (lineCells.length <= 0) continue;

    for (const line of lineCells) {
      const headerRoundDay = parseRoundDayHeader(line);
      if (headerRoundDay !== null) {
        hasDayHeader = true;
        currentRoundDay = headerRoundDay;
        if (!daysByRound.has(currentRoundDay)) {
          daysByRound.set(currentRoundDay, {
            roundDay: currentRoundDay,
            rows: [],
          });
        }
        continue;
      }

      const parsed = parsePlannerMemberLine(line);
      if (!parsed) {
        warnings.push(`Row ${rowIndex + 1}: could not parse member line "${line}".`);
        continue;
      }

      if (!hasDayHeader && !seenMemberRow) {
        warnings.push("No day headers found before member rows; assuming Day 1.");
      }
      seenMemberRow = true;
      if (!daysByRound.has(currentRoundDay)) {
        daysByRound.set(currentRoundDay, {
          roundDay: currentRoundDay,
          rows: [],
        });
      }
      const day = daysByRound.get(currentRoundDay)!;
      day.rows.push({
        playerTag: parsed.playerTag,
        playerName: parsed.playerName,
        subbedOut: parsed.subbedOut,
        assignmentOrder: day.rows.length,
      });
      if (!rosterRows.has(parsed.playerTag)) {
        rosterRows.set(parsed.playerTag, {
          playerTag: parsed.playerTag,
          playerName: parsed.playerName,
        });
      }
    }
  }

  if (daysByRound.size <= 0 && rosterRows.size <= 0) {
    warnings.push("No CWL planner rows were parsed from the tab.");
  }

  const days: ParsedImportDay[] = [];
  for (let roundDay = 1; roundDay <= 7; roundDay += 1) {
    const day = daysByRound.get(roundDay);
    days.push(
      day || {
        roundDay,
        rows: [],
      },
    );
  }

  return {
    days,
    rosterRows: [...rosterRows.values()],
    warnings,
  };
}

function parseRoundDayHeader(line: string): number | null {
  const normalized = sanitizeDisplayText(line).toLowerCase();
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

function parsePlannerMemberLine(line: string): {
  playerTag: string;
  playerName: string;
  subbedOut: boolean;
} | null {
  const trimmed = sanitizeDisplayText(line);
  if (!trimmed) return null;

  const subbedOut =
    /:x:/i.test(trimmed) ||
    /\bsubbed\s*out\b/i.test(trimmed) ||
    /^\s*x\s*[:\-–—]/i.test(trimmed);

  const tagCandidates = trimmed.match(/#?[A-Z0-9]{5,15}/gi) ?? [];
  const playerTag = tagCandidates
    .map((tag) => normalizePlayerTag(tag))
    .find(Boolean);
  if (!playerTag) return null;

  let playerName = trimmed
    .replace(/:x:/gi, " ")
    .replace(/\bsubbed\s*out\b/gi, " ")
    .replace(new RegExp(escapeRegExp(playerTag), "gi"), " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[/g, " ")
    .replace(/\]/g, " ")
    .replace(/[-–—|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!playerName) {
    playerName = playerTag;
  }

  return {
    playerTag,
    playerName,
    subbedOut,
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeSheetTabName(tabName: string): string {
  return `'${String(tabName ?? "").trim().replace(/'/g, "''")}'`;
}

function extractSpreadsheetId(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  const directMatch = trimmed.match(/^[a-zA-Z0-9-_]{20,}$/);
  if (directMatch) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const match = parsed.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function sanitizeDisplayText(input: unknown): string {
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
