import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { CompoPlaceService } from "../src/services/CompoPlaceService";
import { CompoReplacementService } from "../src/services/CompoReplacementService";
import { CompoFillService } from "../src/services/CompoFillService";
import { InactiveWarService } from "../src/services/InactiveWarService";
import { installLegacyHeatMapRefBucketTargetMock } from "./heatMapRefTestHelpers";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanCatalog: {
    findFirst: vi.fn(),
  },
  fwaClanMemberCurrent: {
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
  },
  heatMapRefBucketTarget: {
    findMany: vi.fn(),
  },
  fwaFeedSyncState: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  fillerAccount: {
    findMany: vi.fn(),
  },
  externalPlayerWeightCurrent: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
  weightInputDeferment: {
    findMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  CompoActualStateService,
  loadCompoActualStateContext,
  readExternalClanCurrentComposition,
  readTrackedClanCurrentComposition,
} from "../src/services/CompoActualStateService";
import { COMPO_ACTUAL_STATE_HEALTHY_DEVIATION_THRESHOLD } from "../src/helper/compoActualStateView";
import { normalizeClashTagInput } from "../src/helper/clashTag";
import { computeHeatMapRefContentHash } from "../src/helper/heatMapRefRebuild";
import {
  computeClanMembersSnapshotHash,
  toPersistedClanMembersSnapshotRow,
} from "../src/services/fwa-feeds/clanMembersSnapshot";

function makeTrackedClan(tag: string, name: string) {
  return {
    tag,
    name,
  };
}

function makeHeatMapRef(input?: Partial<{
  weightMinInclusive: number;
  weightMaxInclusive: number;
  th18Count: number;
  th17Count: number;
  th16Count: number;
  th15Count: number;
  th14Count: number;
  th13Count: number;
  th12Count: number;
  th11Count: number;
  th10OrLowerCount: number;
}>) {
  return {
    weightMinInclusive: input?.weightMinInclusive ?? 0,
    weightMaxInclusive: input?.weightMaxInclusive ?? 9_999_999,
    th18Count: input?.th18Count ?? 0,
    th17Count: input?.th17Count ?? 0,
    th16Count: input?.th16Count ?? 0,
    th15Count: input?.th15Count ?? 0,
    th14Count: input?.th14Count ?? 0,
    th13Count: input?.th13Count ?? 0,
    th12Count: input?.th12Count ?? 0,
    th11Count: input?.th11Count ?? 0,
    th10OrLowerCount: input?.th10OrLowerCount ?? 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-11T01:00:00.000Z"),
  };
}

function makeContinuousHeatMapRefs(): ReturnType<typeof makeHeatMapRef>[] {
  return Array.from({ length: 14 }, (_, index) =>
    makeHeatMapRef({
      weightMinInclusive: index * 100_000,
      weightMaxInclusive: index * 100_000 + 99_999,
      th18Count: index === 1 ? 1 : 0,
    }),
  );
}

function makeMember(input: {
  clanTag: string;
  playerTag: string;
  weight: number;
  sourceSyncedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    weight: input.weight,
    sourceSyncedAt:
      input.sourceSyncedAt ?? new Date("2026-04-11T01:30:00.000Z"),
  };
}

function hashCurrentRows(rows: Array<Record<string, unknown>>): string {
  return computeClanMembersSnapshotHash(
    rows.map((row) => toPersistedClanMembersSnapshotRow({
      clanTag: String(row.clanTag),
      playerTag: String(row.playerTag),
      ...row,
    })),
  );
}

function makeCatalog(input: { playerTag: string; latestKnownWeight: number | null }) {
  return {
    playerTag: input.playerTag,
    latestKnownWeight: input.latestKnownWeight,
  };
}

function makePlayerCurrent(input: { playerTag: string; currentWeight: number | null }) {
  return {
    playerTag: input.playerTag,
    currentWeight: input.currentWeight,
  };
}

function makeValidPlayerTag(index: number) {
  const alphabet = "PYLQGRJCUV0289";
  let value = index;
  let encoded = "";
  do {
    encoded = alphabet[value % alphabet.length] + encoded;
    value = Math.floor(value / alphabet.length);
  } while (value > 0);
  return `#PPPP${encoded}`;
}

function makeWarFallback(input: {
  clanTag: string;
  playerTag: string;
  effectiveWeight: number;
  updatedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    effectiveWeight: input.effectiveWeight,
    updatedAt: input.updatedAt ?? new Date("2026-04-11T01:35:00.000Z"),
  };
}

function makeOpenDeferment(input: {
  scopeKey: string;
  playerTag: string;
  deferredWeight: number;
  createdAt?: Date;
}) {
  return {
    scopeKey: input.scopeKey,
    playerTag: input.playerTag,
    deferredWeight: input.deferredWeight,
    createdAt: input.createdAt ?? new Date("2026-04-11T01:40:00.000Z"),
  };
}

describe("CompoActualStateService", () => {
  it("generates valid unique Clash tags for the test index range", () => {
    const tags = Array.from({ length: 50 }, (_, index) => makeValidPlayerTag(index));
    const normalizedTags = tags.map((tag) => normalizeClashTagInput(tag));

    expect(new Set(tags).size).toBe(50);
    expect(new Set(normalizedTags).size).toBe(50);
    for (const tag of tags) {
      expect(tag).toMatch(/^#[PYLQGRJCUV0289]{4,15}$/);
      expect(normalizeClashTagInput(tag)).toBe(tag);
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanCatalog.findFirst.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.deleteMany.mockReset();
    prismaMock.fwaClanMemberCurrent.upsert.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.upsert.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.heatMapRefBucketTarget.findMany.mockReset();
    prismaMock.fwaFeedSyncState.findMany.mockReset();
    prismaMock.fwaFeedSyncState.findUnique.mockReset();
    prismaMock.fwaFeedSyncState.upsert.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerLink.updateMany.mockReset();
    prismaMock.playerActivity.findMany.mockReset();
    prismaMock.fillerAccount.findMany.mockReset();
    prismaMock.externalPlayerWeightCurrent.findMany.mockReset();
    prismaMock.$transaction.mockReset();
    prismaMock.$executeRaw.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
    installLegacyHeatMapRefBucketTargetMock(prismaMock);
    prismaMock.$queryRaw.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([]);
    prismaMock.fwaFeedSyncState.findUnique.mockResolvedValue(null);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock));
    prismaMock.$executeRaw.mockResolvedValue(0);
    prismaMock.$queryRaw.mockImplementation(async () => {
      const last = prismaMock.heatMapRef.findMany.mock.results.at(-1);
      const refs = last?.type === "return" ? await last.value : [];
      return [{ value: JSON.stringify({
        version: 1,
        status: "validated",
        blockReasonCode: null,
        reason: null,
        validatedAtIso: "2026-04-12T00:00:00.000Z",
        updatedAtIso: "2026-04-12T00:00:00.000Z",
        contentHash: computeHeatMapRefContentHash(refs as never),
      }) }];
    });
  });

  it("round-trips FWA then CoC persistence into authoritative ACTUAL placement, replacement, and fill context", async () => {
    const persistedRows: any[] = [];
    const syncState: any = {
      scopeKey: "#AAA111",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastStatus: "IDLE",
      lastRowCount: null,
      lastChangedRowCount: null,
      lastContentHash: null,
      nextEligibleAt: null,
    };
    const now = new Date(Date.now() - 5_000);
    const ref = makeHeatMapRef({ th15Count: 1 });
    prismaMock.trackedClan.findMany.mockResolvedValue([{
      tag: "#AAA111",
      name: "Alpha Clan",
      shortName: "AC",
      clanBadge: null,
    }]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([ref]);
    prismaMock.fwaClanMemberCurrent.findMany.mockImplementation(async () => [...persistedRows]);
    prismaMock.fwaFeedSyncState.findMany.mockImplementation(async () => [syncState]);
    prismaMock.fwaFeedSyncState.findUnique.mockImplementation(async () => syncState);
    const applyStateUpsert = (args: any) => {
      Object.assign(syncState, args.update ?? args.create ?? {});
      return undefined;
    };
    prismaMock.fwaFeedSyncState.upsert.mockImplementation(applyStateUpsert);
    prismaMock.fwaClanMemberCurrent.deleteMany.mockImplementation(async (args: any) => {
      const before = persistedRows.length;
      const notIn = args.where.playerTag?.notIn as string[] | undefined;
      if (notIn) {
        for (let index = persistedRows.length - 1; index >= 0; index -= 1) {
          if (!notIn.includes(persistedRows[index]?.playerTag)) persistedRows.splice(index, 1);
        }
      } else {
        persistedRows.splice(0, persistedRows.length);
      }
      return { count: before - persistedRows.length };
    });
    prismaMock.fwaClanMemberCurrent.upsert.mockImplementation(async (args: any) => {
      const playerTag = args.where.clanTag_playerTag.playerTag;
      const existing = persistedRows.find((row) => row.playerTag === playerTag);
      if (existing) Object.assign(existing, args.update);
      else persistedRows.push({ ...args.create });
      return {};
    });
    prismaMock.fwaPlayerCatalog.upsert.mockResolvedValue({});
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({ results: [] } as any);

    const fwaRows = [{
      clanTag: "#AAA111",
      playerTag: "#PYLQ0289",
      playerName: "FWA Name",
      role: "member",
      level: 10,
      donated: 1,
      received: 2,
      rank: 1,
      trophies: 1000,
      league: "Gold",
      townHall: 14,
      weight: 145000,
      inWar: true,
    }];
    const fwaService = new FwaClanMembersSyncService({
      fetchClanMembers: vi.fn().mockResolvedValue(fwaRows),
    } as any);
    const fwaResult = await fwaService.syncTrackedClan("#AAA111", { force: true, now });
    expect(fwaResult.status).toBe("SUCCESS");

    const cocResult = await fwaService.refreshCurrentClanMembersForClanTags(["#AAA111"], {
      now: new Date(Date.now() - 3_000),
      cocService: {
        getClan: vi.fn().mockResolvedValue({
          tag: "#AAA111",
          memberListPresent: true,
          declaredMemberCountPresent: false,
          declaredMemberCountValid: true,
          declaredMemberCount: null,
          members: [{
            tag: "#PYLQ0289",
            name: "CoC Name",
            role: "member",
            expLevel: 10,
            donations: 3,
            donationsReceived: 4,
            clanRank: 1,
            trophies: 1100,
            league: { name: "Gold" },
            townHallLevel: 15,
          }],
        }),
      } as any,
    });
    expect(cocResult.failedClans).toEqual([]);
    expect(syncState).toMatchObject({ lastStatus: "SUCCESS", lastSuccessAt: expect.any(Date) });
    expect(persistedRows[0]).toMatchObject({
      playerName: "CoC Name",
      weight: 145000,
      inWar: true,
    });
    expect(syncState.lastContentHash).toBe(hashCurrentRows(persistedRows));

    const context = await loadCompoActualStateContext("guild-1");
    expect(context.clans[0]?.base).toMatchObject({
      rosterCoverage: "complete",
      memberCount: 1,
      memberCountEvidence: "observed",
    });
    expect(context.clans[0]?.members[0]).toMatchObject({
      playerName: "CoC Name",
      resolvedWeight: 145000,
      resolvedWeightSource: "member",
    });

    const placement = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");
    expect(placement.eligibleClanTags).toEqual(["#AAA111"]);
    expect(placement.embeds[0]?.toJSON().fields?.some((field) =>
      field.name === "Factual observations" && String(field.value).includes("observed 1 TH15"),
    )).toBe(true);

    const replacement = await new CompoReplacementService().resolveReplacementCandidates({
      guildId: "guild-1",
      weight: 145000,
      bucket: "TH15",
      context,
    });
    expect(replacement.evaluation.eligibleClanTags).toEqual(["#AAA111"]);
    expect(replacement.evaluation.status).not.toBe("unavailable");

    const fill = await new CompoFillService().readFill("guild-1");
    expect(fill.trackedClanTags).toEqual(["#AAA111"]);
    expect(fill.content).not.toContain("Reference validation is unavailable");
  });

  it.each([
    {
      name: "missing",
      state: [],
      expectedCoverage: "unavailable",
    },
    {
      name: "partial row count",
      state: [{ lastRowCount: null, lastStatus: "SUCCESS" }],
      expectedCoverage: "partial",
    },
    {
      name: "contradictory row count",
      state: [{ lastRowCount: 99, lastStatus: "SUCCESS" }],
      expectedCoverage: "contradictory",
    },
    {
      name: "stale success",
      state: [{ lastRowCount: 1, lastStatus: "SUCCESS", lastSuccessAt: new Date("2026-01-01T00:00:00.000Z") }],
      expectedCoverage: "stale",
    },
  ])("fails closed for $name CLAN_MEMBERS evidence", async ({ state, expectedCoverage }) => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef({
      weightMinInclusive: 0,
      weightMaxInclusive: 1_000_000,
    })]);
    const now = new Date();
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue(state.map((row) => ({
      scopeKey: "#AAA111",
      lastAttemptAt: (row as { lastSuccessAt?: Date }).lastSuccessAt ?? now,
      lastSuccessAt: (row as { lastSuccessAt?: Date }).lastSuccessAt ?? now,
      lastStatus: row.lastStatus,
      lastRowCount: row.lastRowCount,
      lastChangedRowCount: 1,
      lastContentHash:
        row.lastRowCount === 1
          ? hashCurrentRows([makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 })])
          : null,
    })));

    const context = await loadCompoActualStateContext("guild-1");
    expect(context.clans[0]?.base.rosterCoverage).toBe(expectedCoverage);
    expect(context.clans[0]?.base.memberCountEvidence).toBe("unknown");
  });

  it("accepts a fresh current-row-count NOOP as authoritative roster coverage", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef({
      weightMinInclusive: 0,
      weightMaxInclusive: 1_000_000,
    })]);
    const now = new Date();
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([{
      scopeKey: "#AAA111",
      lastAttemptAt: now,
      lastSuccessAt: new Date(now.getTime() - 60_000),
      lastStatus: "NOOP",
      lastRowCount: 1,
      lastChangedRowCount: 0,
      lastContentHash: hashCurrentRows([
        makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
      ]),
    }]);

    const context = await loadCompoActualStateContext("guild-1");
    expect(context.clans[0]?.base.rosterCoverage).toBe("complete");
    expect(context.clans[0]?.base.memberCountEvidence).toBe("observed");
    expect(context.clans[0]?.base.rosterEvidenceReason).toBe("sync_noop_current");
  });

  it("rejects future, non-authoritative, and same-cardinality snapshot evidence", async () => {
    const member = makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 });
    prismaMock.trackedClan.findMany.mockResolvedValue([makeTrackedClan("#AAA111", "Alpha Clan")]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([member]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef({ weightMinInclusive: 0, weightMaxInclusive: 1_000_000 })]);

    const hash = hashCurrentRows([member]);
    const futureTimestamp = new Date(Date.now() + 60_000);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValueOnce([{
      scopeKey: "#AAA111",
      lastAttemptAt: futureTimestamp,
      lastSuccessAt: futureTimestamp,
      lastStatus: "SUCCESS",
      lastRowCount: 1,
      lastChangedRowCount: 1,
      lastContentHash: hash,
    }]);
    const future = await loadCompoActualStateContext("guild-1");
    expect(future.clans[0]?.base.rosterCoverage).toBe("contradictory");

    prismaMock.fwaFeedSyncState.findMany.mockResolvedValueOnce([{
      scopeKey: "#AAA111",
      lastAttemptAt: new Date("2026-05-20T11:00:00.000Z"),
      lastSuccessAt: new Date("2026-05-20T10:00:00.000Z"),
      lastStatus: "SKIPPED",
      lastRowCount: 1,
      lastChangedRowCount: 0,
      lastContentHash: hash,
    }]);
    const skipped = await loadCompoActualStateContext("guild-1");
    expect(skipped.clans[0]?.base.rosterCoverage).toBe("unavailable");

    prismaMock.fwaFeedSyncState.findMany.mockResolvedValueOnce([{
      scopeKey: "#AAA111",
      lastAttemptAt: new Date("2026-05-20T11:00:00.000Z"),
      lastSuccessAt: new Date("2026-05-20T10:00:00.000Z"),
      lastStatus: "NOOP",
      lastRowCount: 1,
      lastChangedRowCount: 0,
      lastContentHash: "different-same-cardinality-snapshot",
    }]);
    const changed = await loadCompoActualStateContext("guild-1");
    expect(changed.clans[0]?.base.rosterCoverage).toBe("contradictory");
  });

  it("renders observed TH19 in ACTUAL state without target deltas", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 181000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({ weightMinInclusive: 0, weightMaxInclusive: 1_000_000 }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "raw",
    });

    expect(result.stateRows?.[0]).toEqual([
      "Clan",
      "Resolved Total",
      "Missing",
      "DF",
      "Players",
      "TH19",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "<=TH13",
    ]);
    expect(result.stateRows?.[1]).toEqual([
      "Alpha Clan",
      "181,000",
      "0",
      "0",
      "1",
      "1",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
  });

  it("classifies a TH19 Town Hall by its resolved war-weight bucket", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 180000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({ weightMinInclusive: 0, weightMaxInclusive: 1_000_000 }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", { view: "raw" });
    expect(result.stateRows?.[1]).toEqual([
      "Alpha Clan",
      "180,000",
      "0",
      "0",
      "1",
      "1",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
  });

  it("preserves factual TH18 composition while withholding retained refs after an integrity block", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 175000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({ weightMinInclusive: 0, weightMaxInclusive: 1_000_000, th18Count: 1 }),
    ]);
    prismaMock.$queryRaw.mockResolvedValue([
      {
        value: JSON.stringify({
          version: 1,
          status: "blocked",
          blockReasonCode: "th19_integrity",
          reason: "TH19 evidence",
          validatedAtIso: "2026-04-12T00:00:00.000Z",
          updatedAtIso: "2026-04-12T01:00:00.000Z",
          contentHash: null,
        }),
      },
    ]);

    const context = await loadCompoActualStateContext("guild-1");
    const result = await new CompoActualStateService().readState("guild-1", {
      view: "auto",
    });

    expect(context.referenceAvailability.status).toBe("retained_unverified");
    expect(context.clans[0]?.base.bucketCounts.TH18).toBe(1);
    expect(context.heatMapRefParents).toHaveLength(1);
    expect(context.heatMapRefs).toEqual([]);
    expect(result.stateRows?.[1]?.slice(-6)).toEqual(["?", "?", "?", "?", "?", "?"]);
    const content = result.contentLines.join(" ");
    expect(content).toContain("HeatMapRef parent bands are present");
    expect(content).toContain("retained historical data");
    expect(content).not.toContain("Missing HeatMapRef band for displayed ACTUAL totals");
    expect(result.imageNotice).toBe("TH comparisons unavailable - HeatMapRef validation blocked");
  });

  it("keeps Auto-Detect UNKNOWN for populated references when provenance is absent", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 175000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    const parents = makeContinuousHeatMapRefs();
    prismaMock.heatMapRef.findMany.mockResolvedValue(parents);
    prismaMock.$queryRaw.mockResolvedValue([]);

    const context = await loadCompoActualStateContext("guild-1");
    const result = await new CompoActualStateService().readState("guild-1", {
      view: "auto",
    });

    expect(context.heatMapRefParents).toHaveLength(14);
    expect(context.heatMapRefs).toEqual([]);
    expect(context.referenceAvailability.status).toBe("unknown");
    expect(result.stateRows?.[1]?.slice(-6)).toEqual(["?", "?", "?", "?", "?", "?"]);
    expect(result.stateRows?.[1]?.[1]).toBe("175,000");
    const rawResult = await new CompoActualStateService().readState("guild-1", {
      view: "raw",
    });
    expect(rawResult.stateRows?.[1]?.[5]).toBe("1");
    const content = result.contentLines.join(" ");
    expect(content).toContain("HeatMapRef parent bands are present");
    expect(content).toContain("provenance is unavailable");
    expect(content).not.toContain("Missing HeatMapRef band for displayed ACTUAL totals");
    expect(result.imageNotice).toBe("TH comparisons unavailable - HeatMapRef not validated");
  });

  it("does not show an unavailable-reference notice for validated supported references", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 175000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({ weightMinInclusive: 0, weightMaxInclusive: 1_000_000 }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "auto",
    });

    expect(result.imageNotice).toBeNull();
    expect(result.contentLines.join(" ")).not.toContain("TH comparisons unavailable");
  });

  it("retains the missing-band message for a weight outside parent coverage", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 175000 }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({ weightMinInclusive: 0, weightMaxInclusive: 100_000 }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "auto",
    });

    expect(result.contentLines.join(" ")).toContain(
      "Missing HeatMapRef band for displayed ACTUAL totals: Alpha Clan (175,000)",
    );
    expect(result.imageNotice).toBeNull();
  });

  it("explains clan-specific TH19 unavailability when references are validated", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) =>
        makeMember({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: index === 0 ? 181000 : 175000,
        }),
      ),
    );
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 10_000_000,
        th18Count: 49,
      }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "auto",
    });

    expect(result.stateRows?.[1]?.slice(-6)).toEqual(["?", "?", "?", "?", "?", "?"]);
    const rawResult = await new CompoActualStateService().readState("guild-1", {
      view: "raw",
    });
    expect(rawResult.stateRows?.[0]).toContain("TH19");
    expect(rawResult.stateRows?.[1]?.[5]).toBe("1");
    expect(result.contentLines.join(" ")).toContain(
      "TH19 comparison unavailable for: Alpha Clan (legacy HeatMapRef targets do not support observed TH19)",
    );
    expect(result.contentLines.join(" ")).not.toContain(
      "Missing HeatMapRef band for displayed ACTUAL totals",
    );
    expect(result.imageNotice).toBe(
      "TH comparisons unavailable - observed TH19 unsupported by legacy HeatMapRef",
    );
  });

  it("uses feed, catalog, player-current, deferred, and war fallbacks in order for ACTUAL state totals", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000008", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000009", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000020", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000028", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000088", weight: 0 }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeCatalog({ playerTag: "#P000008", latestKnownWeight: 166000 }),
      makeCatalog({ playerTag: "#P000009", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000020", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000028", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000088", latestKnownWeight: 0 }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrent({ playerTag: "#P000009", currentWeight: 177000 }),
      makePlayerCurrent({ playerTag: "#P000020", currentWeight: 0 }),
      makePlayerCurrent({ playerTag: "#P000028", currentWeight: 0 }),
      makePlayerCurrent({ playerTag: "#P000088", currentWeight: 0 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      makeOpenDeferment({
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000020",
        deferredWeight: 136000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeWarFallback({
        clanTag: "#AAA111",
        playerTag: "#P000028",
        effectiveWeight: 174000,
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 1_000_000,
        th18Count: 2,
        th17Count: 1,
        th15Count: 1,
        th14Count: 1,
      }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "raw",
    });

    expect(result.stateRows?.[0]).toEqual([
      "Clan",
      "Resolved Total",
      "Missing",
      "DF",
      "Players",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "<=TH13",
    ]);
    expect(result.stateRows?.[1]).toEqual([
      "Alpha Clan",
      "798,000",
      "2",
      "1",
      "6",
      "2",
      "1",
      "0",
      "1",
      "1",
      "0",
    ]);
    expect(result.contentLines).toHaveLength(2);
    expect(result.contentLines[0]).toContain("ACTUAL · View: **Raw Data** · refreshed");
    expect(result.contentLines[1]).toContain(
      "Columns: Total=resolved weight; Missing=unresolved/fallback",
    );
    expect(result.contentLines[1]).toContain("DF=deferred-weight count");
    expect(result.contentLines[1]).toContain("TH=resolved composition counts");
  });

  it("selects ACTUAL sources by explicit precedence and only counts war fallback rows as missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000008", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000009", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000020", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000028", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000088", weight: 0 }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeCatalog({ playerTag: "#P000008", latestKnownWeight: 166000 }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrent({ playerTag: "#P000008", currentWeight: 177000 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      makeOpenDeferment({
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000009",
        deferredWeight: 146000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeWarFallback({
        clanTag: "#AAA111",
        playerTag: "#P000020",
        effectiveWeight: 174000,
      }),
      makeWarFallback({
        clanTag: "#BBB222",
        playerTag: "#P000028",
        effectiveWeight: 175000,
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 1_000_000,
        th18Count: 2,
        th17Count: 1,
        th16Count: 1,
        th15Count: 1,
      }),
    ]);

    const context = await loadCompoActualStateContext("guild-1");
    const clan = context.clans[0];

    expect(clan?.base.resolvedTotalWeight).toBe(806000);
    expect(clan?.base.unresolvedWeightCount).toBe(3);
    expect(clan?.members.find((member) => member.playerTag === "#P000002")?.resolvedWeightSource).toBe("member");
    expect(clan?.members.find((member) => member.playerTag === "#P000008")?.resolvedWeightSource).toBe("catalog");
    expect(clan?.members.find((member) => member.playerTag === "#P000009")?.resolvedWeightSource).toBe("defer");
    expect(clan?.members.find((member) => member.playerTag === "#P000020")?.resolvedWeightSource).toBe("war");
    expect(clan?.members.find((member) => member.playerTag === "#P000028")?.resolvedWeightSource).toBe("war");
    expect(clan?.members.find((member) => member.playerTag === "#P000088")?.resolvedWeightSource).toBeNull();
  });

  it("prefers the higher of FWA and deferred weights and keeps FWA on ties before current and war fallbacks", async () => {
    const clanTag = makeValidPlayerTag(0);
    const playerTagA = makeValidPlayerTag(1);
    const playerTagB = makeValidPlayerTag(2);
    const playerTagC = makeValidPlayerTag(3);
    const playerTagD = makeValidPlayerTag(4);
    const playerTagE = makeValidPlayerTag(5);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan(clanTag, "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag, playerTag: playerTagA, weight: 145000 }),
      makeMember({ clanTag, playerTag: playerTagB, weight: 150000 }),
      makeMember({ clanTag, playerTag: playerTagC, weight: 150000 }),
      makeMember({ clanTag, playerTag: playerTagD, weight: 0 }),
      makeMember({ clanTag, playerTag: playerTagE, weight: 0 }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeCatalog({ playerTag: playerTagC, latestKnownWeight: 150000 }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrent({ playerTag: playerTagD, currentWeight: 160000 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      makeOpenDeferment({
        scopeKey: `guild:guild-1|clan:${clanTag.replace(/^#/, "")}`,
        playerTag: playerTagA,
        deferredWeight: 150000,
      }),
      makeOpenDeferment({
        scopeKey: `guild:guild-1|clan:${clanTag.replace(/^#/, "")}`,
        playerTag: playerTagB,
        deferredWeight: 145000,
      }),
      makeOpenDeferment({
        scopeKey: `guild:guild-1|clan:${clanTag.replace(/^#/, "")}`,
        playerTag: playerTagC,
        deferredWeight: 145000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeWarFallback({
        clanTag,
        playerTag: playerTagE,
        effectiveWeight: 170000,
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 1_000_000,
        th18Count: 1,
      }),
    ]);

    const context = await loadCompoActualStateContext("guild-1");
    const clan = context.clans[0];

    expect(clan?.members.find((member) => member.playerTag === playerTagA)?.resolvedWeight).toBe(150000);
    expect(clan?.members.find((member) => member.playerTag === playerTagA)?.resolvedWeightSource).toBe("defer");
    expect(clan?.members.find((member) => member.playerTag === playerTagB)?.resolvedWeight).toBe(150000);
    expect(clan?.members.find((member) => member.playerTag === playerTagB)?.resolvedWeightSource).toBe("member");
    expect(clan?.members.find((member) => member.playerTag === playerTagC)?.resolvedWeight).toBe(150000);
    expect(clan?.members.find((member) => member.playerTag === playerTagC)?.resolvedWeightSource).toBe("member");
    expect(clan?.members.find((member) => member.playerTag === playerTagD)?.resolvedWeight).toBe(160000);
    expect(clan?.members.find((member) => member.playerTag === playerTagD)?.resolvedWeightSource).toBe("current");
    expect(clan?.members.find((member) => member.playerTag === playerTagE)?.resolvedWeight).toBe(170000);
    expect(clan?.members.find((member) => member.playerTag === playerTagE)?.resolvedWeightSource).toBe("war");
  });

  it("counts DF only when the open deferment is the resolved source and lets PlayerCurrent win when no defer exists", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000008", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000009", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000020", weight: 0 }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeCatalog({ playerTag: "#P000002", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000008", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000009", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000020", latestKnownWeight: 0 }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrent({ playerTag: "#P000002", currentWeight: 145000 }),
      makePlayerCurrent({ playerTag: "#P000008", currentWeight: 145000 }),
      makePlayerCurrent({ playerTag: "#P000009", currentWeight: 145000 }),
      makePlayerCurrent({ playerTag: "#P000020", currentWeight: 155000 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      makeOpenDeferment({
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000002",
        deferredWeight: 140000,
      }),
      makeOpenDeferment({
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000009",
        deferredWeight: 145000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 1_000_000,
        th18Count: 1,
        th17Count: 1,
      }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "raw",
    });

    expect(result.stateRows?.[1]?.[3]).toBe("1");
    const clan = await loadCompoActualStateContext("guild-1");
    expect(clan.clans[0]?.members.find((member) => member.playerTag === "#P000002")?.resolvedWeightSource).toBe("member");
    expect(clan.clans[0]?.members.find((member) => member.playerTag === "#P000008")?.resolvedWeightSource).toBe("current");
    expect(clan.clans[0]?.members.find((member) => member.playerTag === "#P000009")?.resolvedWeightSource).toBe("defer");
    expect(clan.clans[0]?.members.find((member) => member.playerTag === "#P000020")?.resolvedWeightSource).toBe("current");
  });

  it("renders ACTUAL state from persisted current-member data without sheet reads and still counts unresolved missing weights", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
      makeTrackedClan("#BBB222", "Bravo Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000008", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000009", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000020", weight: 0 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      makeOpenDeferment({
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000008",
        deferredWeight: 166000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeWarFallback({
        clanTag: "#AAA111",
        playerTag: "#P000009",
        effectiveWeight: 155000,
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 0,
      }),
      makeHeatMapRef({
        weightMinInclusive: 400001,
        weightMaxInclusive: 500000,
        th17Count: 1,
        th16Count: 1,
        th15Count: 2,
      }),
    ]);
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );
    const readCompoLinkedValuesSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "readCompoLinkedValues",
    );

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "raw",
    });

    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();
    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.renderableClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.contentLines[0]).toContain("ACTUAL · View: **Raw Data** · refreshed");
    expect(result.stateRows?.[0]).toEqual([
      "Clan",
      "Resolved Total",
      "Missing",
      "DF",
      "Players",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "<=TH13",
    ]);
    expect(result.stateRows?.[1]).toEqual([
      "Alpha Clan",
      "466,000",
      "2",
      "1",
      "4",
      "0",
      "1",
      "1",
      "1",
      "0",
      "0",
    ]);
    expect(result.stateRows?.[2]).toEqual([
      "Bravo Clan",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(result.contentLines).toHaveLength(3);
    expect(result.contentLines[1]).toContain("DF=deferred-weight count");
    expect(result.contentLines[1]).toContain("TH=resolved composition counts");
    expect(result.contentLines[2]).toContain("Reference warning:");
    expect(result.contentLines[2]).toContain("target comparisons remain UNKNOWN");
  });

  it("shows planning totals separately in ACTUAL auto view while keeping displayed deltas on resolved counts", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000008", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000009", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000020", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000028", weight: 0 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000088", weight: 0 }),
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      makeCatalog({ playerTag: "#P000008", latestKnownWeight: 166000 }),
      makeCatalog({ playerTag: "#P000009", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000020", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000028", latestKnownWeight: 0 }),
      makeCatalog({ playerTag: "#P000088", latestKnownWeight: 0 }),
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      makePlayerCurrent({ playerTag: "#P000009", currentWeight: 177000 }),
      makePlayerCurrent({ playerTag: "#P000020", currentWeight: 0 }),
      makePlayerCurrent({ playerTag: "#P000028", currentWeight: 0 }),
      makePlayerCurrent({ playerTag: "#P000088", currentWeight: 0 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([
      makeOpenDeferment({
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000020",
        deferredWeight: 136000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      makeWarFallback({
        clanTag: "#AAA111",
        playerTag: "#P000028",
        effectiveWeight: 174000,
      }),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 1_000_000,
        th18Count: 2,
        th17Count: 1,
        th15Count: 1,
        th14Count: 1,
      }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "auto",
    });

    expect(result.stateRows?.[0]).toEqual([
      "Clan",
      "Resolved Total",
      "Planning Total",
      "Missing",
      "DF",
      "Players",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "<=TH13",
    ]);
    expect(result.stateRows?.[1]?.[0]).toBe("Alpha Clan");
    expect(result.stateRows?.[1]?.[1]).toBe("798,000");
    expect(result.stateRows?.[1]?.[2]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[3]).toBe("46");
    expect(result.stateRows?.[1]?.[4]).toBe("1");
    expect(result.stateRows?.[1]?.[5]).toBe("6");
    expect(result.stateRows?.[1]?.[6]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[7]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[8]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[9]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[10]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[11]).toEqual(expect.any(String));
    expect(result.contentLines).toHaveLength(2);
    expect(result.contentLines[0]).toContain("ACTUAL · View: **Auto-Detect Band** · refreshed");
    expect(result.contentLines[1]).toContain("Plan=projected 50-player total");
    expect(result.contentLines[1]).toContain("DF=deferred-weight count");
    expect(result.contentLines[1]).toContain("TH=roster delta vs HeatMapRef");
  });

  it("keeps auto-detect projected band selection but shows resolved-count deltas against the selected band", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 47 }, (_, index) =>
        makeMember({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: 135000,
        }),
      ),
    );
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 10_000_000,
        th18Count: 3,
        th14Count: 47,
      }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "auto",
    });

    expect(result.stateRows?.[1]).toEqual([
      "Alpha Clan",
      "6,345,000",
      "6,870,000",
      "3",
      "0",
      "47",
      "-3",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(result.contentLines[1]).toContain("DF=deferred-weight count");
    expect(result.contentLines[1]).toContain("TH=roster delta vs HeatMapRef");
  });

  it("uses total resolved ACTUAL weight for HeatMapRef matching and collapses TH13-and-below by resolved weight bucket", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 119000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000008", weight: 80000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000009", weight: 65000 }),
      makeMember({ clanTag: "#AAA111", playerTag: "#P000020", weight: 175000 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 300000,
        th18Count: 0,
        th11Count: 0,
        th10OrLowerCount: 0,
      }),
      makeHeatMapRef({
        weightMinInclusive: 300001,
        weightMaxInclusive: 500000,
        th18Count: 1,
        th13Count: 2,
        th12Count: 2,
        th11Count: 2,
        th10OrLowerCount: 0,
      }),
    ]);

    const result = await new CompoActualStateService().readState("guild-1", {
      view: "raw",
    });

    expect(result.stateRows?.[0]).toEqual([
      "Clan",
      "Resolved Total",
      "Missing",
      "DF",
      "Players",
      "TH18",
      "TH17",
      "TH16",
      "TH15",
      "TH14",
      "<=TH13",
    ]);
    expect(result.stateRows?.[1]).toEqual([
      "Alpha Clan",
      "439,000",
      "0",
      "0",
      "4",
      "1",
      "0",
      "0",
      "0",
      "0",
      "3",
    ]);
    expect(result.contentLines).not.toContain(
      "Missing HeatMapRef band for displayed ACTUAL totals:",
    );
  });

  it("refreshes ACTUAL member weights and live member counts for all tracked clans before rereading persisted ACTUAL state", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({ clanTag: "#AAA111", playerTag: "#P000002", weight: 145000 }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        th15Count: 1,
      }),
    ]);
    const syncAllTrackedClansSpy = vi
      .spyOn(FwaClanMembersSyncService.prototype, "syncAllTrackedClans")
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 1,
        changedRowCount: 1,
        failedClans: ["#AAA111"],
      });
    const refreshCurrentClanMembersSpy = vi
      .spyOn(
        FwaClanMembersSyncService.prototype,
        "refreshCurrentClanMembersForClanTags",
      )
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 1,
        changedRowCount: 1,
        failedClans: [],
      });

    const result = await new CompoActualStateService().refreshState("guild-1");

    expect(syncAllTrackedClansSpy).toHaveBeenCalledWith({
      force: true,
    });
    expect(refreshCurrentClanMembersSpy).toHaveBeenCalledWith(["#AAA111"]);
    expect(result.contentLines.at(-1)).toContain("ACTUAL data may be stale");
  });

  it("logs a narrow Rocky Road ACTUAL diagnostics line when the selected HeatMapRef band is missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#2RYGLU2UY", "Rocky Road"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeMember({
        clanTag: "#2RYGLU2UY",
        playerTag: "#P000001",
        weight: 100,
      }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 200,
        weightMaxInclusive: 300,
      }),
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await new CompoActualStateService().readState("guild-1");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "[compo-actual-debug]",
    );
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("surface=state");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "clanTag=#2RYGLU2UY",
    );
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "selectedHeatMapRefBandKey=null",
    );
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "coverageReason=out_of_range_low",
    );
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "deltaByBucketNull=true",
    );
  });

  describe("tracked clan composition snapshot", () => {
    async function loadComposition(input: {
      members: Array<{
        clanTag: string;
        playerTag: string;
        weight: number;
        sourceSyncedAt?: Date;
      }>;
      heatMapRefs: ReturnType<typeof makeHeatMapRef>[];
      now?: Date;
    }) {
      prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(input.members);
      prismaMock.heatMapRef.findMany.mockResolvedValue(input.heatMapRefs);
      prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
      prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
      prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
      prismaMock.playerCurrent.findMany.mockResolvedValue([]);

      return readTrackedClanCurrentComposition({
        guildId: "guild-1",
        trackedClan: makeTrackedClan("#AAA111", "Alpha Clan"),
        now: input.now ?? new Date("2026-03-09T12:00:00.000Z"),
      });
    }

    it("loads one tracked clan without loading the full tracked-clan list", async () => {
      const result = await loadComposition({
        members: Array.from({ length: 50 }, (_, index) => ({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: 150000,
          sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
        })),
        heatMapRefs: [
          makeHeatMapRef({
            weightMinInclusive: 7_400_000,
            weightMaxInclusive: 7_600_000,
            th15Count: 50,
          }),
        ],
      });

      expect(result).not.toBeNull();
      expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
      expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clanTag: { in: ["#AAA111"] } },
        }),
      );
      expect(result?.memberCount).toBe(50);
      expect(result?.displayCounts.TH15).toBe(50);
      expect(result?.selectedHeatMapRefAvailable).toBe(true);
      expect(result?.deviationScore).toBe(0);
      expect(result?.healthy).toBe(true);
      expect(result?.sourceAgeMs).toBe(3_600_000);
    });

    it("fails closed for readiness and downstream goal inputs when TH19 is observed", async () => {
      const result = await loadComposition({
        members: Array.from({ length: 50 }, (_, index) => ({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: index === 0 ? 181_000 : 175_000,
          sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
        })),
        heatMapRefs: [
          makeHeatMapRef({
            weightMinInclusive: 0,
            weightMaxInclusive: 10_000_000,
            th15Count: 50,
          }),
        ],
      });

      expect(result?.selectedHeatMapRefAvailable).toBe(false);
      expect(result?.deviationScore).toBeNull();
      expect(result?.healthy).toBe(false);
      expect(result?.projection.deltaByBucket.TH18).toBeNull();
    });

    it("marks a healthy 50/50 roster with a shared deviation at or below the threshold", async () => {
      const result = await loadComposition({
        members: Array.from({ length: 50 }, (_, index) => ({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: 150000,
          sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
        })),
        heatMapRefs: [
          makeHeatMapRef({
            weightMinInclusive: 7_400_000,
            weightMaxInclusive: 7_600_000,
            th15Count: 50,
          }),
        ],
      });

      expect(result?.memberCount).toBe(50);
      expect(result?.unresolvedWeightCount).toBe(0);
      expect(result?.selectedHeatMapRefAvailable).toBe(true);
      expect(result?.deviationScore).toBe(0);
      expect(result?.healthy).toBe(true);
    });

    it("marks a complete roster with a large deviation as unhealthy", async () => {
      const result = await loadComposition({
        members: Array.from({ length: 50 }, (_, index) => ({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: 175000,
          sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
        })),
        heatMapRefs: [
          makeHeatMapRef({
            weightMinInclusive: 8_700_000,
            weightMaxInclusive: 8_900_000,
            th15Count: 50,
          }),
        ],
      });

      expect(result?.memberCount).toBe(50);
      expect(result?.selectedHeatMapRefAvailable).toBe(true);
      expect(result?.deviationScore).toBeGreaterThan(COMPO_ACTUAL_STATE_HEALTHY_DEVIATION_THRESHOLD);
      expect(result?.healthy).toBe(false);
    });

    it("keeps an underfilled roster unhealthy even when deviation is low", async () => {
      const result = await loadComposition({
        members: Array.from({ length: 48 }, (_, index) => ({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: 150000,
          sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
        })),
        heatMapRefs: [
          makeHeatMapRef({
            weightMinInclusive: 7_000_000,
            weightMaxInclusive: 7_600_000,
            th15Count: 50,
          }),
        ],
      });

      expect(result?.memberCount).toBe(48);
      expect(result?.unresolvedWeightCount).toBe(0);
      expect(result?.selectedHeatMapRefAvailable).toBe(true);
      expect(result?.healthy).toBe(false);
      expect(result?.displayCounts.TH15).toBe(48);
    });

    it("keeps resolved counts when one member weight is unresolved", async () => {
      const result = await loadComposition({
        members: [
          {
            clanTag: "#AAA111",
            playerTag: makeValidPlayerTag(0),
            weight: 0,
            sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
          },
          ...Array.from({ length: 49 }, (_, index) => ({
            clanTag: "#AAA111",
            playerTag: makeValidPlayerTag(index + 1),
            weight: 150000,
            sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
          })),
        ],
        heatMapRefs: [
          makeHeatMapRef({
            weightMinInclusive: 7_200_000,
            weightMaxInclusive: 7_600_000,
            th15Count: 50,
          }),
        ],
      });

      expect(result?.memberCount).toBe(50);
      expect(result?.unresolvedWeightCount).toBe(1);
      expect(result?.displayCounts.TH15).toBe(49);
      expect(result?.selectedHeatMapRefAvailable).toBe(true);
      expect(result?.healthy).toBe(false);
    });

    it("shows n/a when no valid HeatMapRef can be selected", async () => {
      const result = await loadComposition({
        members: Array.from({ length: 50 }, (_, index) => ({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          weight: 150000,
          sourceSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
        })),
        heatMapRefs: [],
      });

      expect(result?.memberCount).toBe(50);
      expect(result?.selectedHeatMapRefAvailable).toBe(false);
      expect(result?.deviationScore).toBeNull();
      expect(result?.healthy).toBe(false);
    });
  });

  describe("external clan composition snapshot", () => {
    it("collapses catalog counts and selects the matching HeatMapRef from estimated weight", async () => {
      prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
        clanTag: "#EXT111",
        name: "External Alpha",
        th18Count: 5,
        th17Count: 7,
        th16Count: 8,
        th15Count: 10,
        th14Count: 9,
        th13Count: 4,
        th12Count: 3,
        th11Count: 2,
      th10Count: 1,
      th9Count: 0,
      th8Count: 1,
      thLowCount: 0,
      estimatedWeight: 145000,
        lastSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      });
      prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 140000,
        weightMaxInclusive: 150000,
        th18Count: 5,
        th17Count: 7,
        th16Count: 8,
        th15Count: 10,
        th14Count: 9,
        th13Count: 4,
        th12Count: 3,
        th11Count: 2,
        th10OrLowerCount: 2,
      }),
    ]);

      const result = await readExternalClanCurrentComposition({
        clanTag: "ext111",
        now: new Date("2026-03-09T12:00:00.000Z"),
      });

      expect(result).not.toBeNull();
      expect(result?.displayCounts).toEqual({
        TH18: 5,
        TH17: 7,
        TH16: 8,
        TH15: 10,
        TH14: 9,
        "<=TH13": 11,
      });
      expect(result?.memberCount).toBe(50);
      expect(result?.estimatedWeight).toBe(145000);
      expect(result?.sourceAgeMs).toBe(3_600_000);
      expect(result?.selectedHeatMapRefAvailable).toBe(true);
      expect(result?.deviationScore).toBe(0);
      expect(result?.unresolvedWeightCount).toBe(0);
      expect(result?.compositionComplete).toBe(true);
      expect(result?.healthy).toBe(true);
    });

    it("preserves known catalog counts and reports n/a when composition data is incomplete", async () => {
      prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
        clanTag: "#EXT222",
        name: "External Bravo",
        th18Count: 3,
        th17Count: null,
        th16Count: 6,
        th15Count: 8,
        th14Count: 9,
        th13Count: 1,
        th12Count: 1,
        th11Count: 1,
        th10Count: 1,
        th9Count: 1,
        th8Count: 1,
        thLowCount: 1,
        estimatedWeight: null,
        lastSyncedAt: null,
      });
      prismaMock.heatMapRef.findMany.mockResolvedValue([
        makeHeatMapRef({
          weightMinInclusive: 140000,
          weightMaxInclusive: 150000,
          th15Count: 50,
        }),
      ]);

      const result = await readExternalClanCurrentComposition({
        clanTag: "#EXT222",
        now: new Date("2026-03-09T12:00:00.000Z"),
      });

      expect(result).not.toBeNull();
      expect(result?.displayCounts.TH18).toBe(3);
      expect(result?.displayCounts.TH17).toBeNull();
      expect(result?.displayCounts["<=TH13"]).toBe(7);
      expect(result?.memberCount).toBeNull();
      expect(result?.unresolvedWeightCount).toBe(2);
      expect(result?.estimatedWeight).toBeNull();
      expect(result?.sourceAgeMs).toBeNull();
      expect(result?.selectedHeatMapRefAvailable).toBe(false);
      expect(result?.deviationScore).toBeNull();
      expect(result?.compositionComplete).toBe(false);
      expect(result?.healthy).toBe(false);
    });

    it("preserves the exact member total when estimated weight is missing", async () => {
      prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
        clanTag: "#EXT333",
        name: "External Charlie",
        th18Count: 4,
        th17Count: 5,
        th16Count: 6,
        th15Count: 7,
        th14Count: 8,
        th13Count: 5,
        th12Count: 4,
        th11Count: 3,
        th10Count: 2,
        th9Count: 1,
        th8Count: 3,
        thLowCount: 2,
        estimatedWeight: null,
        lastSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      });
      prismaMock.heatMapRef.findMany.mockResolvedValue([
        makeHeatMapRef({
          weightMinInclusive: 140000,
          weightMaxInclusive: 150000,
          th18Count: 4,
          th17Count: 5,
          th16Count: 6,
          th15Count: 7,
          th14Count: 8,
          th13Count: 15,
        }),
      ]);

      const result = await readExternalClanCurrentComposition({
        clanTag: "#EXT333",
        now: new Date("2026-03-09T12:00:00.000Z"),
      });

      expect(result).not.toBeNull();
      expect(result?.memberCount).toBe(50);
      expect(result?.unresolvedWeightCount).toBe(1);
      expect(result?.selectedHeatMapRefAvailable).toBe(false);
      expect(result?.deviationScore).toBeNull();
      expect(result?.healthy).toBe(false);
      expect(result?.compositionComplete).toBe(false);
    });

    it("keeps ACTUAL factual rows and warns when the normalized target query fails", async () => {
      prismaMock.fwaClanCatalog.findFirst.mockResolvedValue({
        clanTag: "#EXT444",
        name: "External Delta",
        th18Count: 1,
        th17Count: 2,
        th16Count: 3,
        th15Count: 4,
        th14Count: 5,
        th13Count: 6,
        th12Count: 7,
        th11Count: 8,
        th10Count: 4,
        th9Count: 3,
        th8Count: 2,
        thLowCount: 5,
        estimatedWeight: 145000,
        lastSyncedAt: new Date("2026-03-09T11:00:00.000Z"),
      });
      prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef({
        weightMinInclusive: 140000,
        weightMaxInclusive: 150000,
      })]);
      prismaMock.heatMapRefBucketTarget.findMany.mockRejectedValueOnce(
        new Error("normalized child unavailable"),
      );

      const result = await readExternalClanCurrentComposition({
        clanTag: "#EXT444",
        now: new Date("2026-03-09T12:00:00.000Z"),
      });

      expect(result).not.toBeNull();
      expect(result?.displayCounts.TH18).toBe(1);
      expect(result?.memberCount).toBe(50);
      expect(result?.selectedHeatMapRefAvailable).toBe(false);
      expect(result?.deviationScore).toBeNull();
      expect(result?.healthy).toBe(false);
    });
  });
});
