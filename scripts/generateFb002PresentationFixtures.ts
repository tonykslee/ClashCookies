import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderStatePngForTest } from "../src/commands/Compo";
import { prisma } from "../src/prisma";
import { buildDeferScopeKey } from "../src/services/WeightInputDefermentService";
import { CompoActualStateService } from "../src/services/CompoActualStateService";
import { CompoWarStateService } from "../src/services/CompoWarStateService";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";
import {
  NativeHeatMapReferencePublicationService,
  type NativeHeatMapReferenceRead,
} from "../src/services/NativeHeatMapReferencePublicationService";
import { HEAT_MAP_REF_SEED_ROWS } from "../src/services/HeatMapRefSeedData";

const outputDir = join(process.cwd(), "artifacts", "fb-002");
mkdirSync(outputDir, { recursive: true });

const clanTag = "#2RVV0L0VP";
const sourceSyncedAt = new Date("2026-11-23T18:00:00.000Z");
const playerTags = Array.from({ length: 50 }, (_, index) => {
  const alphabet = "PYLQGRJCUV0289";
  let value = index;
  let encoded = "";
  do {
    encoded = alphabet[value % alphabet.length] + encoded;
    value = Math.floor(value / alphabet.length);
  } while (value > 0);
  return `#PPPP${encoded}`;
});

const actualMembers = [
  ...Array.from({ length: 41 }, (_, index) => ({
    clanTag,
    playerTag: playerTags[index]!,
    playerName: `Akatsuki ${index + 1}`,
    townHall: 15,
    weight: 150_000,
    sourceSyncedAt,
  })),
  {
    clanTag,
    playerTag: playerTags[41]!,
    playerName: "Akatsuki deferred",
    townHall: 14,
    weight: 0,
    sourceSyncedAt,
  },
  ...Array.from({ length: 6 }, (_, index) => ({
    clanTag,
    playerTag: playerTags[42 + index]!,
    playerName: `Akatsuki WAR fallback ${index + 1}`,
    townHall: 18,
    weight: 0,
    sourceSyncedAt,
  })),
  {
    clanTag,
    playerTag: playerTags[48]!,
    playerName: "Akatsuki unresolved",
    townHall: 15,
    weight: 0,
    sourceSyncedAt,
  },
];

const warMembers = [
  ...Array.from({ length: 41 }, (_, index) => ({
    clanTag,
    playerTag: playerTags[index]!,
    playerName: `Akatsuki ${index + 1}`,
    position: index + 1,
    townHall: 15,
    rawWeight: 150_000,
    effectiveWeight: 150_000,
  })),
  {
    clanTag,
    playerTag: playerTags[41]!,
    playerName: "Akatsuki deferred",
    position: 42,
    townHall: 14,
    rawWeight: 0,
    effectiveWeight: 136_000,
  },
  ...Array.from({ length: 6 }, (_, index) => ({
    clanTag,
    playerTag: playerTags[42 + index]!,
    playerName: `Akatsuki WAR fallback ${index + 1}`,
    position: 43 + index,
    townHall: 18,
    rawWeight: 0,
    effectiveWeight: index === 5 ? 173_000 : 172_000,
  })),
  {
    clanTag,
    playerTag: playerTags[48]!,
    playerName: "Akatsuki unresolved",
    position: 49,
    townHall: 15,
    rawWeight: 0,
    effectiveWeight: 0,
  },
  {
    clanTag,
    playerTag: playerTags[49]!,
    playerName: "Akatsuki vacant-slot placeholder",
    position: 50,
    townHall: 13,
    rawWeight: 0,
    effectiveWeight: 0,
  },
];

const nativeTargetCountsByBand = HEAT_MAP_REF_SEED_ROWS.map((_, bandOrdinal) =>
  bandOrdinal === 3
    ? { TH19: 0, TH18: 6, TH17: 0, TH16: 0, TH15: 41, TH14: 1, TH13: 0, TH12: 0, TH11: 0, TH10_OR_LOWER: 2 }
    : { TH19: 0, TH18: 6, TH17: 8, TH16: 8, TH15: 9, TH14: 8, TH13: 5, TH12: 3, TH11: 2, TH10_OR_LOWER: 1 },
);

const nativeReference: NativeHeatMapReferenceRead = {
  status: "CURRENT",
  informationalOnly: true,
  reason: null,
  generationId: "cmwuba01p0001104anu6a4d6u",
  fenceToken: 1n,
  profileVersion: "native-reference-v2",
  policyVersion: "native-provisional-v1",
  sampleThreshold: 5,
  evaluationAt: sourceSyncedAt,
  createdAt: sourceSyncedAt,
  bands: HEAT_MAP_REF_SEED_ROWS.map(({ weightMinInclusive, weightMaxInclusive }) => ({
    weightMinInclusive,
    weightMaxInclusive,
  })),
  targets: HEAT_MAP_REF_SEED_ROWS.flatMap((_, bandOrdinal) =>
    Object.entries(nativeTargetCountsByBand[bandOrdinal]!).map(([bucketId, targetCount]) => ({
      bandOrdinal,
      bucketId,
      status: bandOrdinal < 11 ? "SUPPORTED" as const : "UNKNOWN" as const,
      targetCount: bandOrdinal < 11 ? targetCount : null,
      qualifyingClanCount: bandOrdinal < 11 ? 5 : 0,
      sampleCount: bandOrdinal < 11 ? 5 : 0,
      reasonCode: bandOrdinal < 11 ? null : "partial_native_coverage",
    })),
  ),
};

type MockPrisma = {
  trackedClan: { findMany: (...args: unknown[]) => Promise<unknown> };
  fwaClanMemberCurrent: { findMany: (...args: unknown[]) => Promise<unknown> };
  fwaPlayerCatalog: { findMany: (...args: unknown[]) => Promise<unknown> };
  playerCurrent: { findMany: (...args: unknown[]) => Promise<unknown> };
  fwaTrackedClanWarRosterMemberCurrent: { findMany: (...args: unknown[]) => Promise<unknown> };
  fwaTrackedClanWarRosterCurrent: { findMany: (...args: unknown[]) => Promise<unknown> };
  fwaFeedSyncState: { findMany: (...args: unknown[]) => Promise<unknown> };
  weightInputDeferment: { findMany: (...args: unknown[]) => Promise<unknown> };
  heatMapRef: { findMany: (...args: unknown[]) => Promise<unknown> };
  heatMapRefBucketTarget: { findMany: (...args: unknown[]) => Promise<unknown> };
  fwaClanCatalog: { findMany: (...args: unknown[]) => Promise<unknown> };
  nativeHeatMapReferenceHead?: unknown;
};

function writePng(name: string, bytes: Buffer): void {
  writeFileSync(join(outputDir, name), bytes as unknown as Uint8Array);
}

async function main(): Promise<void> {
  const db = prisma as unknown as MockPrisma;
  db.trackedClan = { findMany: async () => [{ tag: clanTag, name: "Akatsuki", shortName: "AK" }] };
  db.fwaClanMemberCurrent = { findMany: async () => actualMembers };
  db.fwaPlayerCatalog = { findMany: async () => [] };
  db.playerCurrent = { findMany: async () => [] };
  db.fwaTrackedClanWarRosterMemberCurrent = {
    findMany: async (args: unknown) => {
      const where = (args as { where?: { clanTag?: unknown } } | undefined)?.where;
      if (where?.clanTag) return warMembers;
      return actualMembers.slice(42, 48).map((member, index) => ({
        clanTag,
        playerTag: member.playerTag,
        effectiveWeight: index === 5 ? 173_000 : 172_000,
        updatedAt: sourceSyncedAt,
      }));
    },
  };
  db.fwaTrackedClanWarRosterCurrent = {
    findMany: async () => [{
      clanTag,
      clanName: "Akatsuki",
      rosterSize: 50,
      totalRawWeight: 7_319_000,
      totalEffectiveWeight: 7_319_000,
      hasUnresolvedWeights: false,
      observedAt: sourceSyncedAt,
      sourceUpdatedAt: sourceSyncedAt,
      createdAt: sourceSyncedAt,
      updatedAt: sourceSyncedAt,
    }],
  };
  db.fwaFeedSyncState = { findMany: async () => [] };
  db.weightInputDeferment = {
    findMany: async () => [{
      scopeKey: buildDeferScopeKey("guild-1", clanTag),
      playerTag: playerTags[41],
      deferredWeight: 136_000,
      createdAt: sourceSyncedAt,
    }],
  };
  // Empty legacy tables intentionally exercise the blocked legacy-validation path.
  db.heatMapRef = { findMany: async () => [] };
  db.heatMapRefBucketTarget = { findMany: async () => [] };
  db.fwaClanCatalog = { findMany: async () => [] };
  db.nativeHeatMapReferenceHead = {};

  const originalReadCurrent = NativeHeatMapReferencePublicationService.prototype.readCurrent;
  NativeHeatMapReferencePublicationService.prototype.readCurrent = async () => nativeReference;
  try {
    const [heatmap, actual, war] = await Promise.all([
      new HeatMapRefDisplayService().readHeatMapRefDisplayTable({ guildId: "guild-1" }),
      new CompoActualStateService().readState("guild-1", { view: "auto" }),
      new CompoWarStateService().readState("guild-1"),
    ]);
    if (!actual.stateRows || !war.stateRows) {
      throw new Error("fixture services did not return renderable rows");
    }
    writePng(
      "compo-heatmapref-provisional.png",
      renderStatePngForTest("HEATMAP REF - PROVISIONAL", heatmap.rows, heatmap.referenceState.notice),
    );
    writePng(
      "compo-state-actual-provisional.png",
      renderStatePngForTest("ALLIANCE STATE (ACTUAL - AUTO-DETECT BAND · PROVISIONAL NATIVE)", actual.stateRows, actual.contentLines.join("\n")),
    );
    writePng(
      "compo-state-war-provisional.png",
      renderStatePngForTest("ALLIANCE STATE (WAR - PROVISIONAL NATIVE)", war.stateRows, war.contentLines.join("\n")),
    );
  } finally {
    NativeHeatMapReferencePublicationService.prototype.readCurrent = originalReadCurrent;
  }
  console.log(`Wrote service-generated FB-002 fixtures to ${outputDir}`);
}

void main();
