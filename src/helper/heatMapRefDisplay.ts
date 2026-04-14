import type { HeatMapRef } from "@prisma/client";
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

/** Purpose: serialize the displayed HeatMapRef table into tab-separated text for copy/paste flows. */
export function buildHeatMapRefDisplayText(rows: readonly string[][]): string {
  return rows.map((row) => row.join("\t")).join("\n");
}
