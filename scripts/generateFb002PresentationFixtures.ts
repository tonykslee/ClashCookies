import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderStatePngForTest } from "../src/commands/Compo";

const outputDir = join(process.cwd(), "artifacts", "fb-002");
mkdirSync(outputDir, { recursive: true });

const nativeHeatMapRows = [
  ["Band", "TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "TH13", "TH12", "TH11", "TH10 or lower", "Clans"],
  ["7,300,001 - 7,400,000", "?", "0", "11", "12", "10", "8", "4", "3", "2", "0", "5"],
  ["7,400,001 - 7,500,000", "0", "1", "10", "12", "10", "8", "4", "3", "2", "0", "5"],
];

const actualRows = [
  ["Clan", "Resolved Total", "Planning Total", "Missing", "DF", "Players", "TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
  ["Akatsuki", "7,319,000", "7,494,000", "8", "1", "49", "0", "-1", "+2", "0", "-1", "0", "0"],
];

const warRows = [
  ["Clan", "Total", "Missing", "Players", "TH19", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
  ["Akatsuki", "7,319,000", "7", "49", "0", "-1", "+2", "0", "-1", "0", "0"],
];

function writePng(name: string, bytes: Buffer): void {
  writeFileSync(join(outputDir, name), bytes as unknown as Uint8Array);
}

writePng(
  "compo-heatmapref-provisional.png",
  renderStatePngForTest(
    "HEATMAP REF - PROVISIONAL",
    nativeHeatMapRows,
    "Reference: provisional native · generation cmwuba01p0001104anu6a4d6u · fence 1 · supported bands 11/14 · informational only; legacy Match% is not shown.",
  ),
);
writePng(
  "compo-state-actual-provisional.png",
  renderStatePngForTest(
    "ALLIANCE STATE (ACTUAL - AUTO-DETECT BAND · PROVISIONAL NATIVE)",
    actualRows,
    "Provisional native targets (informational only; no recommendations): 1 supported / 0 UNKNOWN clans · generation cmwuba01p0001104anu6a4d6u",
  ),
);
writePng(
  "compo-state-war-provisional.png",
  renderStatePngForTest(
    "ALLIANCE STATE (WAR - PROVISIONAL NATIVE)",
    warRows,
    "Provisional native targets (informational only; no recommendations): 1 supported / 0 UNKNOWN clans · generation cmwuba01p0001104anu6a4d6u",
  ),
);

console.log(`Wrote FB-002 presentation fixtures to ${outputDir}`);
