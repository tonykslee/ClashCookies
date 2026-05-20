import type { BlacklistHeatMapRef, HeatMapRef } from "@prisma/client";
import { formatHeatMapRefBandLabel, getHeatMapRefBandKey } from "./compoHeatMap";

export const HEAT_MAP_REF_DISPLAY_HEADERS = [
  "Band",
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "TH13",
  "TH12",
  "TH11+",
  "Match%",
  "Clans",
];

export const HEAT_MAP_REF_COPY_HEADERS = [
  "WeightMin",
  "WeightMax",
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "TH13",
  "TH12",
  "TH11+",
  "Match%",
  "# Clans",
];

export const BLACKLIST_HEAT_MAP_REF_DISPLAY_HEADERS = [
  "Band",
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "TH13",
  "TH12",
  "TH11+",
  "Samples",
  "Src Clans",
  "Opponents",
  "Confidence",
  "Generated",
];

export const BLACKLIST_HEAT_MAP_REF_COPY_HEADERS = [
  "WeightMin",
  "WeightMax",
  "TH18",
  "TH17",
  "TH16",
  "TH15",
  "TH14",
  "TH13",
  "TH12",
  "TH11+",
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

/** Purpose: build the displayed HeatMapRef table rows with band-level match percentages. */
export function buildHeatMapRefDisplayRows(input: {
  heatMapRefs: readonly HeatMapRef[];
  matchPercentByBandKey?: ReadonlyMap<string, string>;
}): string[][] {
  const matchPercentByBandKey = input.matchPercentByBandKey ?? new Map<string, string>();
  const contentRows = input.heatMapRefs.map((heatMapRef) => {
    const bandKey = getHeatMapRefBandKey(heatMapRef);
    return [
      clampCell(formatHeatMapRefBandLabel(heatMapRef)),
      clampCell(String(heatMapRef.th18Count)),
      clampCell(String(heatMapRef.th17Count)),
      clampCell(String(heatMapRef.th16Count)),
      clampCell(String(heatMapRef.th15Count)),
      clampCell(String(heatMapRef.th14Count)),
      clampCell(String(heatMapRef.th13Count)),
      clampCell(String(heatMapRef.th12Count)),
      clampCell(String(heatMapRef.th11Count + heatMapRef.th10OrLowerCount)),
      formatMatchPercentText(matchPercentByBandKey.get(bandKey)),
      clampCell(String(heatMapRef.contributingClanCount)),
    ];
  });
  return [HEAT_MAP_REF_DISPLAY_HEADERS, ...contentRows];
}

/** Purpose: build the copy/export HeatMapRef rows with split band boundaries for CSV paste. */
export function buildHeatMapRefCopyRows(input: {
  heatMapRefs: readonly HeatMapRef[];
  matchPercentByBandKey?: ReadonlyMap<string, string>;
}): string[][] {
  const matchPercentByBandKey = input.matchPercentByBandKey ?? new Map<string, string>();
  const contentRows = input.heatMapRefs.map((heatMapRef) => {
    const bandKey = getHeatMapRefBandKey(heatMapRef);
    return [
      formatWeightBoundary(heatMapRef.weightMinInclusive),
      formatWeightBoundary(heatMapRef.weightMaxInclusive),
      clampCell(String(heatMapRef.th18Count)),
      clampCell(String(heatMapRef.th17Count)),
      clampCell(String(heatMapRef.th16Count)),
      clampCell(String(heatMapRef.th15Count)),
      clampCell(String(heatMapRef.th14Count)),
      clampCell(String(heatMapRef.th13Count)),
      clampCell(String(heatMapRef.th12Count)),
      clampCell(String(heatMapRef.th11Count + heatMapRef.th10OrLowerCount)),
      formatMatchPercentText(matchPercentByBandKey.get(bandKey)),
      clampCell(String(heatMapRef.contributingClanCount)),
    ];
  });
  return [HEAT_MAP_REF_COPY_HEADERS, ...contentRows];
}

/** Purpose: serialize the displayed HeatMapRef table into comma-separated text for copy/paste flows. */
export function buildHeatMapRefDisplayText(rows: readonly string[][]): string {
  return rows.map((row) => row.join(",")).join("\n");
}

/** Purpose: serialize the HeatMapRef copy/export rows into comma-separated text for spreadsheet paste. */
export function buildHeatMapRefCopyText(input: {
  heatMapRefs: readonly HeatMapRef[];
  matchPercentByBandKey?: ReadonlyMap<string, string>;
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
      clampCell(String(heatMapRef.th18Count)),
      clampCell(String(heatMapRef.th17Count)),
      clampCell(String(heatMapRef.th16Count)),
      clampCell(String(heatMapRef.th15Count)),
      clampCell(String(heatMapRef.th14Count)),
      clampCell(String(heatMapRef.th13Count)),
      clampCell(String(heatMapRef.th12Count)),
      clampCell(String(heatMapRef.th11PlusCount)),
      clampCell(String(heatMapRef.sampleCount)),
      clampCell(String(heatMapRef.uniqueSourceClanCount)),
      clampCell(String(heatMapRef.uniqueOpponentCount)),
      formatConfidenceCell(heatMapRef.confidenceLabel, heatMapRef.confidenceScore),
      formatUtcTimestamp(heatMapRef.generatedAt),
    ];
  });
  return [BLACKLIST_HEAT_MAP_REF_DISPLAY_HEADERS, ...contentRows];
}

/** Purpose: build the copy/export blacklist HeatMapRef rows for CSV paste. */
export function buildBlacklistHeatMapRefCopyRows(input: {
  heatMapRefs: readonly BlacklistHeatMapRefLike[];
}): string[][] {
  const contentRows = input.heatMapRefs.map((heatMapRef) => {
    return [
      formatWeightBoundary(heatMapRef.weightMinInclusive),
      formatWeightBoundary(heatMapRef.weightMaxInclusive),
      clampCell(String(heatMapRef.th18Count)),
      clampCell(String(heatMapRef.th17Count)),
      clampCell(String(heatMapRef.th16Count)),
      clampCell(String(heatMapRef.th15Count)),
      clampCell(String(heatMapRef.th14Count)),
      clampCell(String(heatMapRef.th13Count)),
      clampCell(String(heatMapRef.th12Count)),
      clampCell(String(heatMapRef.th11PlusCount)),
      clampCell(String(heatMapRef.sampleCount)),
      clampCell(String(heatMapRef.uniqueSourceClanCount)),
      clampCell(String(heatMapRef.uniqueOpponentCount)),
      formatConfidenceCell(heatMapRef.confidenceLabel, heatMapRef.confidenceScore),
      formatUtcTimestamp(heatMapRef.generatedAt),
    ];
  });
  return [BLACKLIST_HEAT_MAP_REF_COPY_HEADERS, ...contentRows];
}

/** Purpose: serialize the displayed blacklist HeatMapRef table into comma-separated text for copy/paste flows. */
export function buildBlacklistHeatMapRefCopyText(input: {
  heatMapRefs: readonly BlacklistHeatMapRefLike[];
}): string {
  return buildHeatMapRefDisplayText(buildBlacklistHeatMapRefCopyRows(input));
}
