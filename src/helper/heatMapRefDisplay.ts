import type { BlacklistHeatMapRef, HeatMapRef } from "@prisma/client";
import { formatHeatMapRefBandLabel, getHeatMapRefBandKey } from "./compoHeatMap";
import {
  getCompoLegacyReferenceBucketCount,
  getCompoProfileReferenceDisplayColumns,
  LEGACY_COMPO_CALCULATION_PROFILE,
  type CompoCalculationProfile,
  type CompoProfileReferenceCountReader,
  type CompoReferenceDisplayColumn,
} from "./compoCalculationProfile";

export const HEAT_MAP_REF_DISPLAY_COLUMNS = getCompoProfileReferenceDisplayColumns(
  LEGACY_COMPO_CALCULATION_PROFILE,
);

export const HEAT_MAP_REF_DISPLAY_HEADERS = [
  "Band",
  ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => column.label),
  "Match%",
  "Clans",
];

export const HEAT_MAP_REF_COPY_HEADERS = [
  "WeightMin",
  "WeightMax",
  ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => column.label),
  "Match%",
  "# Clans",
];

export const BLACKLIST_HEAT_MAP_REF_DISPLAY_HEADERS = [
  "Band",
  ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => column.label),
  "Samples",
  "Src Clans",
  "Opponents",
  "Confidence",
  "Generated",
];

export const BLACKLIST_HEAT_MAP_REF_COPY_HEADERS = [
  "WeightMin",
  "WeightMax",
  ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => column.label),
  "Samples",
  "Src Clans",
  "Opponents",
  "Confidence",
  "Generated",
];

function clampCell(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 32 ? `${sanitized.slice(0, 29)}...` : sanitized;
}

function formatMatchPercentText(matchPercent: string | null | undefined): string {
  return clampCell(matchPercent?.trim() || "0%");
}

function formatWeightBoundary(value: number): string {
  return clampCell(String(value));
}

function formatUtcTimestamp(value: Date | null | undefined): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return clampCell("n/a");
  }
  return clampCell(`${value.toISOString().slice(0, 16).replace("T", " ")}Z`);
}

function formatConfidenceCell(label: string | null | undefined, score: number | null | undefined): string {
  const normalizedLabel = clampCell(label?.trim() || "n/a");
  const normalizedScore =
    typeof score === "number" && Number.isFinite(score) ? Math.trunc(score) : null;
  if (normalizedScore === null) {
    return normalizedLabel;
  }
  return clampCell(`${normalizedLabel} (${normalizedScore})`);
}

function formatReferenceDisplayCell<TReference>(input: {
  reference: TReference;
  column: CompoReferenceDisplayColumn;
  readCount: CompoProfileReferenceCountReader<TReference>;
}): string {
  if (input.column.status === "unsupported") return "—";
  let total = 0;
  for (const referenceBucketId of input.column.referenceBucketIds) {
    const count = input.readCount(input.reference, referenceBucketId);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || total > Number.MAX_SAFE_INTEGER - count) {
      return "—";
    }
    total += count;
  }
  return clampCell(String(total));
}

function readBlacklistReferenceCount(
  reference: BlacklistHeatMapRefLike,
  referenceBucketId: string,
): number | null {
  const values: Record<string, unknown> = {
    TH18: reference.th18Count,
    TH17: reference.th17Count,
    TH16: reference.th16Count,
    TH15: reference.th15Count,
    TH14: reference.th14Count,
    TH13: reference.th13Count,
    TH12: reference.th12Count,
    TH11: reference.th11PlusCount,
    TH10_OR_LOWER: 0,
  };
  return Number.isSafeInteger(values[referenceBucketId]) && Number(values[referenceBucketId]) >= 0
    ? Number(values[referenceBucketId])
    : null;
}

/** Purpose: build the displayed HeatMapRef table rows with band-level match percentages. */
export function buildHeatMapRefDisplayRows(input: {
  heatMapRefs: readonly HeatMapRef[];
  matchPercentByBandKey?: ReadonlyMap<string, string>;
  profile?: CompoCalculationProfile;
  profileReferenceCountReader?: CompoProfileReferenceCountReader<HeatMapRef>;
}): string[][] {
  const matchPercentByBandKey = input.matchPercentByBandKey ?? new Map<string, string>();
  const columns = input.profile
    ? getCompoProfileReferenceDisplayColumns(input.profile)
    : HEAT_MAP_REF_DISPLAY_COLUMNS;
  const readCount = input.profileReferenceCountReader ?? getCompoLegacyReferenceBucketCount;
  const contentRows = input.heatMapRefs.map((heatMapRef) => {
    const bandKey = getHeatMapRefBandKey(heatMapRef);
    return [
      clampCell(formatHeatMapRefBandLabel(heatMapRef)),
      ...columns.map((column) => formatReferenceDisplayCell({
        reference: heatMapRef,
        column,
        readCount,
      })),
      formatMatchPercentText(matchPercentByBandKey.get(bandKey)),
      clampCell(String(heatMapRef.contributingClanCount)),
    ];
  });
  return [["Band", ...columns.map((column) => column.label), "Match%", "Clans"], ...contentRows];
}

/** Purpose: build the copy/export HeatMapRef rows with split band boundaries for CSV paste. */
export function buildHeatMapRefCopyRows(input: {
  heatMapRefs: readonly HeatMapRef[];
  matchPercentByBandKey?: ReadonlyMap<string, string>;
  profile?: CompoCalculationProfile;
  profileReferenceCountReader?: CompoProfileReferenceCountReader<HeatMapRef>;
}): string[][] {
  const matchPercentByBandKey = input.matchPercentByBandKey ?? new Map<string, string>();
  const columns = input.profile
    ? getCompoProfileReferenceDisplayColumns(input.profile)
    : HEAT_MAP_REF_DISPLAY_COLUMNS;
  const readCount = input.profileReferenceCountReader ?? getCompoLegacyReferenceBucketCount;
  const contentRows = input.heatMapRefs.map((heatMapRef) => {
    const bandKey = getHeatMapRefBandKey(heatMapRef);
    return [
      formatWeightBoundary(heatMapRef.weightMinInclusive),
      formatWeightBoundary(heatMapRef.weightMaxInclusive),
      ...columns.map((column) => formatReferenceDisplayCell({
        reference: heatMapRef,
        column,
        readCount,
      })),
      formatMatchPercentText(matchPercentByBandKey.get(bandKey)),
      clampCell(String(heatMapRef.contributingClanCount)),
    ];
  });
  return [["WeightMin", "WeightMax", ...columns.map((column) => column.label), "Match%", "# Clans"], ...contentRows];
}

/** Purpose: serialize the displayed HeatMapRef table into comma-separated text for copy/paste flows. */
export function buildHeatMapRefDisplayText(rows: readonly string[][]): string {
  return rows.map((row) => row.join(",")).join("\n");
}

/** Purpose: serialize the HeatMapRef copy/export rows into comma-separated text for spreadsheet paste. */
export function buildHeatMapRefCopyText(input: {
  heatMapRefs: readonly HeatMapRef[];
  matchPercentByBandKey?: ReadonlyMap<string, string>;
  profile?: CompoCalculationProfile;
  profileReferenceCountReader?: CompoProfileReferenceCountReader<HeatMapRef>;
}): string {
  return buildHeatMapRefDisplayText(buildHeatMapRefCopyRows(input));
}

type BlacklistHeatMapRefLike = Pick<
  BlacklistHeatMapRef,
  | "weightMinInclusive"
  | "weightMaxInclusive"
  | "th18Count"
  | "th17Count"
  | "th16Count"
  | "th15Count"
  | "th14Count"
  | "th13Count"
  | "th12Count"
  | "th11PlusCount"
  | "sampleCount"
  | "uniqueSourceClanCount"
  | "uniqueOpponentCount"
  | "confidenceLabel"
  | "confidenceScore"
  | "generatedAt"
>;

/** Purpose: build the displayed blacklist HeatMapRef table rows from persisted profile rows. */
export function buildBlacklistHeatMapRefDisplayRows(input: {
  heatMapRefs: readonly BlacklistHeatMapRefLike[];
}): string[][] {
  const contentRows = input.heatMapRefs.map((heatMapRef) => {
    return [
      clampCell(formatHeatMapRefBandLabel(heatMapRef)),
      ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => formatReferenceDisplayCell({
        reference: heatMapRef,
        column,
        readCount: readBlacklistReferenceCount,
      })),
      clampCell(String(heatMapRef.sampleCount)),
      clampCell(String(heatMapRef.uniqueSourceClanCount)),
      clampCell(String(heatMapRef.uniqueOpponentCount)),
      formatConfidenceCell(heatMapRef.confidenceLabel, heatMapRef.confidenceScore),
      formatUtcTimestamp(heatMapRef.generatedAt),
    ];
  });
  return [["Band", ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => column.label), "Samples", "Src Clans", "Opponents", "Confidence", "Generated"], ...contentRows];
}

/** Purpose: build the copy/export blacklist HeatMapRef rows for CSV paste. */
export function buildBlacklistHeatMapRefCopyRows(input: {
  heatMapRefs: readonly BlacklistHeatMapRefLike[];
}): string[][] {
  const contentRows = input.heatMapRefs.map((heatMapRef) => {
    return [
      formatWeightBoundary(heatMapRef.weightMinInclusive),
      formatWeightBoundary(heatMapRef.weightMaxInclusive),
      ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => formatReferenceDisplayCell({
        reference: heatMapRef,
        column,
        readCount: readBlacklistReferenceCount,
      })),
      clampCell(String(heatMapRef.sampleCount)),
      clampCell(String(heatMapRef.uniqueSourceClanCount)),
      clampCell(String(heatMapRef.uniqueOpponentCount)),
      formatConfidenceCell(heatMapRef.confidenceLabel, heatMapRef.confidenceScore),
      formatUtcTimestamp(heatMapRef.generatedAt),
    ];
  });
  return [["WeightMin", "WeightMax", ...HEAT_MAP_REF_DISPLAY_COLUMNS.map((column) => column.label), "Samples", "Src Clans", "Opponents", "Confidence", "Generated"], ...contentRows];
}

/** Purpose: serialize the displayed blacklist HeatMapRef table into comma-separated text for copy/paste flows. */
export function buildBlacklistHeatMapRefCopyText(input: {
  heatMapRefs: readonly BlacklistHeatMapRefLike[];
}): string {
  return buildHeatMapRefDisplayText(buildBlacklistHeatMapRefCopyRows(input));
}
