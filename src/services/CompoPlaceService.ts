import { EmbedBuilder } from "discord.js";
import { normalizeCompoClanDisplayName } from "../helper/compoDisplay";
import { type CompoWarDisplayBucket } from "../helper/compoWarWeightBuckets";
import {
  triggerSharedSheetRefresh,
} from "./SheetRefreshService";
import {
  GoogleSheetsService,
  type GoogleSheetMode,
} from "./GoogleSheetsService";
import { SettingsService } from "./SettingsService";

const COL_CLAN_NAME = 0; // A
const COL_CLAN_TAG = 1; // B
const COL_TOTAL_WEIGHT = 3; // D
const COL_TARGET_BAND = 49; // AX
const COL_MISSING_WEIGHT = 20; // U
const COL_TOTAL_PLAYERS = 21; // V
const COL_BUCKET_START = 22; // W
const COL_BUCKET_END = 27; // AB
const FIXED_LAYOUT_RANGE = "AllianceDashboard!A6:BE500";
const FIXED_LAYOUT_RANGE_START_ROW = 6;
const LOOKUP_REFRESH_RANGE = "Lookup!B10:B10";

type SheetIndexedRow = {
  row: string[];
  sheetRowNumber: number;
};

type PlacementCandidate = {
  clanName: string;
  clanTag: string;
  totalWeight: number;
  targetBand: number;
  missingCount: number;
  remainingToTarget: number;
  bucketDeltaByHeader: Record<string, number>;
  liveMemberCount: number | null;
  vacancySlots: number;
  hasVacancy: boolean;
};

type PlacementCandidateWithDelta = PlacementCandidate & {
  delta: number;
};

export type CompoPlaceReadResult = {
  content: string;
  embeds: EmbedBuilder[];
  trackedClanTags: string[];
  eligibleClanTags: string[];
  candidateCount: number;
  recommendedCount: number;
  vacancyCount: number;
  compositionCount: number;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTag(value: string): string {
  return value.trim().toUpperCase().replace(/^#/, "");
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const digits = value.replace(/[^0-9-]/g, "");
  if (!digits || digits === "-") return 0;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : 0;
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

function normalizePlaceClanDisplayName(value: string): string {
  const normalized = normalizeCompoClanDisplayName(value).trimEnd();
  if (normalized.endsWith("-war")) {
    return normalized.slice(0, -"-war".length).trimEnd();
  }
  return normalized;
}

function getAbsoluteSheetRowNumber(rangeRelativeIndex: number): number {
  return FIXED_LAYOUT_RANGE_START_ROW + rangeRelativeIndex;
}

function isActualSheetRow(sheetRowNumber: number): boolean {
  return sheetRowNumber >= 7 && sheetRowNumber % 3 === 1;
}

function getModeRows(rows: string[][], mode: GoogleSheetMode): SheetIndexedRow[] {
  return rows.flatMap((row, index) => {
    const sheetRowNumber = getAbsoluteSheetRowNumber(index);
    const include = mode === "actual" ? isActualSheetRow(sheetRowNumber) : false;
    return include ? [{ row, sheetRowNumber }] : [];
  });
}

function buildRefreshLine(refreshCell: string[][]): string {
  const rawRefresh = refreshCell[0]?.[0]?.trim();
  return rawRefresh && /^\d+$/.test(rawRefresh)
    ? `RAW Data last refreshed: <t:${rawRefresh}:F>`
    : "RAW Data last refreshed: (not available)";
}

function normalizeBucketDeltaKey(bucket: CompoWarDisplayBucket): string {
  return bucket === "<=TH13" ? "<=th13-delta" : `${bucket.toLowerCase()}-delta`;
}

function formatPlacementRows(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "None";
}

function buildCompoPlaceEmbed(params: {
  inputWeight: number;
  bucket: CompoWarDisplayBucket;
  recommended: PlacementCandidateWithDelta[];
  vacancyList: PlacementCandidate[];
  compositionList: PlacementCandidateWithDelta[];
  refreshLine: string;
}): EmbedBuilder {
  const recommendedRows = params.recommended.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - needs ${Math.abs(candidate.delta)} ${params.bucket}`,
  );
  const vacancyRows = params.vacancyList.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - ${
        candidate.liveMemberCount !== null
          ? `${candidate.liveMemberCount}/50`
          : "unknown/50"
      }`,
  );
  const compositionRows = params.compositionList.map(
    (candidate) =>
      `${abbreviateClan(normalizePlaceClanDisplayName(candidate.clanName))} - ${candidate.delta}`,
  );

  return new EmbedBuilder()
    .setTitle("Compo Placement Suggestions")
    .setDescription(
      `Weight: **${params.inputWeight.toLocaleString("en-US")}**\n` +
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

function readPlacementCandidates(modeRows: SheetIndexedRow[]): PlacementCandidate[] {
  const candidates: PlacementCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const { row } of modeRows) {
    const clanName = String(row[COL_CLAN_NAME] ?? "").trim();
    if (!clanName) continue;

    const clanTag = normalizeTag(String(row[COL_CLAN_TAG] ?? ""));
    const dedupeKey = clanTag ? `tag:${clanTag}` : `name:${normalize(clanName)}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const totalWeight = parseNumber(row[COL_TOTAL_WEIGHT]);
    const targetBand = parseNumber(row[COL_TARGET_BAND]);
    const missingCount = parseNumber(row[COL_MISSING_WEIGHT]);
    const liveMemberCount = parseNumber(row[COL_TOTAL_PLAYERS]);
    const safeLiveMemberCount =
      Number.isFinite(liveMemberCount) && liveMemberCount > 0
        ? Math.max(0, Math.min(50, Math.trunc(liveMemberCount)))
        : null;
    const remainingToTarget = targetBand - totalWeight;
    const vacancySlots =
      safeLiveMemberCount !== null ? Math.max(0, 50 - safeLiveMemberCount) : 0;

    const bucketDeltaByHeader: Record<string, number> = {
      [normalize("TH18-delta")]: parseNumber(row[COL_BUCKET_START]),
      [normalize("TH17-delta")]: parseNumber(row[COL_BUCKET_START + 1]),
      [normalize("TH16-delta")]: parseNumber(row[COL_BUCKET_START + 2]),
      [normalize("TH15-delta")]: parseNumber(row[COL_BUCKET_START + 3]),
      [normalize("TH14-delta")]: parseNumber(row[COL_BUCKET_START + 4]),
      [normalize("<=TH13-delta")]: parseNumber(row[COL_BUCKET_END]),
    };

    candidates.push({
      clanName,
      clanTag,
      totalWeight,
      targetBand,
      missingCount,
      remainingToTarget,
      bucketDeltaByHeader,
      liveMemberCount: safeLiveMemberCount,
      vacancySlots,
      hasVacancy: safeLiveMemberCount !== null && safeLiveMemberCount < 50,
    });
  }

  return candidates;
}

async function readActualSheetSnapshot(): Promise<{
  modeRows: SheetIndexedRow[];
  refreshLine: string;
}> {
  const settings = new SettingsService();
  const sheets = new GoogleSheetsService(settings);
  const linked = await sheets.getCompoLinkedSheet(FIXED_LAYOUT_RANGE);
  const [rows, refreshCell] = await Promise.all([
    sheets.readCompoLinkedValues(FIXED_LAYOUT_RANGE, linked),
    sheets.readCompoLinkedValues(LOOKUP_REFRESH_RANGE, linked),
  ]);
  return {
    modeRows: getModeRows(rows, "actual"),
    refreshLine: buildRefreshLine(refreshCell),
  };
}

/** Purpose: derive `/compo place` suggestions from the ACTUAL AllianceDashboard composition source. */
export class CompoPlaceService {
  async readPlace(
    inputWeight: number,
    bucket: CompoWarDisplayBucket,
  ): Promise<CompoPlaceReadResult> {
    const snapshot = await readActualSheetSnapshot();
    const candidates = readPlacementCandidates(snapshot.modeRows);

    if (candidates.length === 0) {
      return {
        content: "No placement data found in ACTUAL rows from AllianceDashboard!A6:BE500.",
        embeds: [],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      };
    }

    const compositionNeeds = candidates
      .map((candidate) => ({
        ...candidate,
        delta: candidate.bucketDeltaByHeader[normalizeBucketDeltaKey(bucket)] ?? 0,
      }))
      .filter((candidate) => candidate.delta < 0)
      .sort((a, b) => {
        if (a.delta !== b.delta) return a.delta - b.delta;
        if (b.missingCount !== a.missingCount) return b.missingCount - a.missingCount;
        return normalizePlaceClanDisplayName(a.clanName).localeCompare(
          normalizePlaceClanDisplayName(b.clanName),
        );
      });

    const vacancyList = candidates
      .filter((candidate) => candidate.hasVacancy)
      .sort((a, b) => {
        if (b.vacancySlots !== a.vacancySlots) return b.vacancySlots - a.vacancySlots;
        const distance = Math.abs(a.remainingToTarget - inputWeight) - Math.abs(b.remainingToTarget - inputWeight);
        if (distance !== 0) return distance;
        return normalizePlaceClanDisplayName(a.clanName).localeCompare(
          normalizePlaceClanDisplayName(b.clanName),
        );
      });

    const recommended = compositionNeeds.filter((candidate) => candidate.hasVacancy);

    return {
      content: "",
      embeds: [
        buildCompoPlaceEmbed({
          inputWeight,
          bucket,
          recommended,
          vacancyList,
          compositionList: compositionNeeds,
          refreshLine: snapshot.refreshLine,
        }),
      ],
      trackedClanTags: candidates
        .map((candidate) => candidate.clanTag)
        .filter((tag): tag is string => Boolean(tag)),
      eligibleClanTags: candidates
        .map((candidate) => candidate.clanTag)
        .filter((tag): tag is string => Boolean(tag)),
      candidateCount: candidates.length,
      recommendedCount: recommended.length,
      vacancyCount: vacancyList.length,
      compositionCount: compositionNeeds.length,
    };
  }

  async refreshPlace(
    inputWeight: number,
    bucket: CompoWarDisplayBucket,
    guildId?: string | null,
  ): Promise<CompoPlaceReadResult> {
    await triggerSharedSheetRefresh({
      guildId: guildId ?? null,
      mode: "actual",
    });
    return this.readPlace(inputWeight, bucket);
  }
}

export const buildCompoPlaceEmbedForTest = buildCompoPlaceEmbed;
export const readPlacementCandidatesForTest = readPlacementCandidates;
