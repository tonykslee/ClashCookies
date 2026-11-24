import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCompoHeatMapRefPayloadFromRowsForTest,
  buildCompoStatePayloadFromRowsForTest,
} from "../src/commands/Compo";
import { prisma } from "../src/prisma";
import { buildDeferScopeKey } from "../src/services/WeightInputDefermentService";
import { CompoActualStateService } from "../src/services/CompoActualStateService";
import { CompoWarStateService } from "../src/services/CompoWarStateService";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";
import {
  NativeHeatMapReferencePublicationService,
  type NativeHeatMapReferenceRead,
} from "../src/services/NativeHeatMapReferencePublicationService";

const outputDir = join(process.cwd(), "artifacts", "fb-002");
mkdirSync(outputDir, { recursive: true });
const candidatePath = join(process.env.TEMP ?? process.env.TMP ?? process.cwd(), "native-heatmap-candidate-fresh.json");

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

type FreshCandidate = {
  overallStatus: string;
  profileVersion: string;
  sampleThreshold: number;
  evaluationAtIso: string;
  bandDefinitions: readonly { weightMinInclusive: number; weightMaxInclusive: number }[];
  diagnostics: readonly {
    status: "SUPPORTED" | "UNKNOWN";
    observedCandidateCount: number;
    distinctQualifyingClanCount: number;
    reasonCode: string | null;
    normalizedTargets: readonly {
      bucketId: string;
      status: "SUPPORTED" | "UNKNOWN";
      targetCount: number | null;
      reasonCode: string | null;
    }[];
  }[];
};

const freshCandidate = JSON.parse(readFileSync(candidatePath, "utf8")) as FreshCandidate;

const nativeReference: NativeHeatMapReferenceRead = {
  status: "CURRENT",
  informationalOnly: true,
  reason: `offline candidate artifact: ${freshCandidate.overallStatus}`,
  generationId: "cmwuba01p0001104anu6a4d6u",
  fenceToken: 1n,
  profileVersion: freshCandidate.profileVersion,
  policyVersion: "native-provisional-v1",
  sampleThreshold: freshCandidate.sampleThreshold,
  evaluationAt: new Date(freshCandidate.evaluationAtIso),
  createdAt: new Date(freshCandidate.evaluationAtIso),
  bands: freshCandidate.bandDefinitions.map(({ weightMinInclusive, weightMaxInclusive }) => ({
    weightMinInclusive,
    weightMaxInclusive,
  })),
  targets: freshCandidate.diagnostics.flatMap((diagnostic, bandOrdinal) =>
    diagnostic.normalizedTargets.map(({ bucketId, status, targetCount, reasonCode }) => ({
      bandOrdinal,
      bucketId,
      status,
      targetCount,
      qualifyingClanCount: diagnostic.distinctQualifyingClanCount,
      sampleCount: diagnostic.observedCandidateCount,
      reasonCode,
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

function firstAttachment(payload: { files?: Array<{ attachment: Buffer }> }, name: string): Buffer {
  const attachment = payload.files?.[0]?.attachment;
  if (!attachment) throw new Error(`command payload did not include ${name}`);
  return attachment;
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
    const actualRow = actual.stateRows[1];
    if (
      actualRow?.[0] !== "Akatsuki" ||
      actualRow?.[1] !== "7,319,000" ||
      actualRow?.[3] !== "8" ||
      actualRow?.[4] !== "1" ||
      actualRow?.[5] !== "49" ||
      actualRow.slice(6).some((value) => value === "?")
    ) {
      throw new Error(`candidate-backed Akatsuki ACTUAL row was not fully projected: ${JSON.stringify(actualRow)}`);
    }
    if (heatmap.rows.length !== freshCandidate.bandDefinitions.length + 1) {
      throw new Error("candidate-backed heatmap display did not preserve the published band distribution");
    }
    if ((actual.imageNotice?.length ?? 0) > 240) {
      throw new Error("ACTUAL PNG notice unexpectedly contains the full Discord content message");
    }
    const heatmapPayload = buildCompoHeatMapRefPayloadFromRowsForTest({
      rows: heatmap.rows,
      content: heatmap.referenceState.notice,
      title: "HEATMAP REF - PROVISIONAL",
      fileName: "compo-heatmapref-provisional.png",
    });
    const actualPayload = buildCompoStatePayloadFromRowsForTest({
      mode: "actual",
      stateRows: actual.stateRows,
      contentLines: actual.contentLines,
      imageNotice: actual.imageNotice,
      titleLabel: "AUTO-DETECT BAND · PROVISIONAL NATIVE",
    });
    const warPayload = buildCompoStatePayloadFromRowsForTest({
      mode: "war",
      stateRows: war.stateRows,
      contentLines: war.contentLines,
      titleLabel: "PROVISIONAL NATIVE",
    });
    writePng(
      "compo-heatmapref-provisional.png",
      firstAttachment(heatmapPayload, "heatmap reference PNG"),
    );
    writePng(
      "compo-state-actual-provisional.png",
      firstAttachment(actualPayload, "actual state PNG"),
    );
    writePng(
      "compo-state-war-provisional.png",
      firstAttachment(warPayload, "war state PNG"),
    );
  } finally {
    NativeHeatMapReferencePublicationService.prototype.readCurrent = originalReadCurrent;
  }
  console.log(`Wrote service-generated FB-002 fixtures to ${outputDir}`);
  console.log(`Candidate evidence: ${candidatePath} (${freshCandidate.overallStatus}; ${freshCandidate.bandDefinitions.length - freshCandidate.diagnostics.filter((diagnostic) => diagnostic.status === "UNKNOWN").length} supported / ${freshCandidate.diagnostics.filter((diagnostic) => diagnostic.status === "UNKNOWN").length} unknown bands)`);
  console.log("Roster evidence: simulated production-shaped Akatsuki fixture; candidate targets are from the saved production artifact.");
}

void main();
