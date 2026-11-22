import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { InactiveWarService } from "../src/services/InactiveWarService";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";
import { CompoReplacementService } from "../src/services/CompoReplacementService";
import { WarPlanViolationHistoryService } from "../src/services/WarPlanViolationHistoryService";
import { computeHeatMapRefContentHash } from "../src/helper/heatMapRefRebuild";
import { installLegacyHeatMapRefBucketTargetMock } from "./heatMapRefTestHelpers";
import {
  computeClanMembersSnapshotHash,
  toPersistedClanMembersSnapshotRow,
} from "../src/services/fwa-feeds/clanMembersSnapshot";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaFeedSyncState: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  heatMapRef: {
    findMany: vi.fn(),
  },
  heatMapRefBucketTarget: {
    findMany: vi.fn(),
  },
  weightInputDeferment: {
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  fillerAccount: {
    findMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  buildBucketDeltaByHeaderForTest,
  CompoPlaceService,
  resolvePlacementWeightForTest,
} from "../src/services/CompoPlaceService";

function makeTrackedClan(tag: string, name: string, shortName: string | null = null) {
  return {
    tag,
    name,
    shortName,
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
    th18Count: input?.th18Count ?? 19,
    th17Count: input?.th17Count ?? 11,
    th16Count: input?.th16Count ?? 7,
    th15Count: input?.th15Count ?? 6,
    th14Count: input?.th14Count ?? 4,
    th13Count: input?.th13Count ?? 2,
    th12Count: input?.th12Count ?? 1,
    th11Count: input?.th11Count ?? 0,
    th10OrLowerCount: input?.th10OrLowerCount ?? 0,
    sourceVersion: "test",
    refreshedAt: new Date("2026-04-10T16:00:00.000Z"),
  };
}

function bucketWeight(bucket: string): number {
  if (bucket === "TH18") return 175000;
  if (bucket === "TH17") return 165000;
  if (bucket === "TH16") return 155000;
  if (bucket === "TH15") return 145000;
  if (bucket === "TH14") return 135000;
  if (bucket === "TH13") return 125000;
  if (bucket === "TH12") return 115000;
  if (bucket === "TH11") return 100000;
  if (bucket === "TH10") return 80000;
  if (bucket === "TH9") return 65000;
  return 55000;
}

function validPlayerTag(index: number): string {
  const digits = ["0", "2", "8", "9"];
  let value = Math.max(0, Math.trunc(index));
  let suffix = "";
  do {
    suffix = digits[value % 4] + suffix;
    value = Math.floor(value / 4);
  } while (value > 0);
  return `#P${suffix.padStart(6, "0")}`;
}

function serializedDiscordEmbedCharacterCount(embed: ReturnType<EmbedBuilder["toJSON"]>): number {
  return (embed.title?.length ?? 0)
    + (embed.description?.length ?? 0)
    + (embed.footer?.text?.length ?? 0)
    + (embed.author?.name?.length ?? 0)
    + (embed.fields ?? []).reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0,
    );
}

function makeCurrentMembers(input: {
  clanTag: string;
  counts: Partial<
    Record<
      "TH18" | "TH17" | "TH16" | "TH15" | "TH14" | "TH13" | "TH12" | "TH11" | "TH10" | "TH9" | "TH8_OR_LOWER",
      number
    >
  >;
  startIndex?: number;
  sourceSyncedAt?: Date;
  townHall?: number;
}) {
  const sourceSyncedAt = input.sourceSyncedAt ?? new Date("2026-04-10T16:30:00.000Z");
  const rows: Array<{
    clanTag: string;
    playerTag: string;
    weight: number;
    sourceSyncedAt: Date;
    townHall: number;
  }> = [];
  let index = input.startIndex ?? 1;
  for (const [bucket, count] of Object.entries(input.counts)) {
    for (let current = 0; current < (count ?? 0); current += 1) {
      rows.push({
        clanTag: input.clanTag,
        playerTag: validPlayerTag(index),
        playerName: "Player " + index,
        weight: bucketWeight(bucket),
        sourceSyncedAt,
        townHall: input.townHall ?? 18,
      });
      index += 1;
    }
  }
  return rows;
}

function makeZeroWeightMember(input: {
  clanTag: string;
  playerTag: string;
  sourceSyncedAt?: Date;
  townHall?: number;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    weight: 0,
    sourceSyncedAt: input.sourceSyncedAt ?? new Date("2026-04-10T16:30:00.000Z"),
    townHall: input.townHall ?? 18,
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
    updatedAt: input.updatedAt ?? new Date("2026-04-10T16:45:00.000Z"),
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
    createdAt: input.createdAt ?? new Date("2026-04-10T16:40:00.000Z"),
  };
}

describe("CompoPlaceService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaFeedSyncState.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.heatMapRefBucketTarget.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
    prismaMock.clanWarHistory.findMany.mockReset();
    prismaMock.playerLink.findMany.mockReset();
    prismaMock.playerActivity.findMany.mockReset();
    prismaMock.fillerAccount.findMany.mockReset();
    prismaMock.$queryRaw.mockReset();
    installLegacyHeatMapRefBucketTargetMock(prismaMock);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.clanWarHistory.findMany.mockResolvedValue([]);
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.playerActivity.findMany.mockResolvedValue([]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([]);
    prismaMock.fwaFeedSyncState.findMany.mockImplementation(async (args: any) => {
      const memberResult = prismaMock.fwaClanMemberCurrent.findMany.mock.results.at(-1);
      const rows = memberResult?.type === "return" ? await memberResult.value : [];
      const countByClan = new Map<string, number>();
      for (const row of rows as Array<{ clanTag: string }>) {
        countByClan.set(row.clanTag, (countByClan.get(row.clanTag) ?? 0) + 1);
      }
      return (args?.where?.scopeKey?.in ?? []).map((scopeKey: string) => ({
        scopeKey,
        lastAttemptAt: new Date("2026-05-20T12:00:00.000Z"),
        lastSuccessAt: new Date("2026-05-20T12:00:00.000Z"),
        lastStatus: "SUCCESS",
        lastRowCount: countByClan.get(scopeKey) ?? 0,
        lastChangedRowCount: countByClan.get(scopeKey) ?? 0,
        lastContentHash: hashCurrentRows(
          (rows as Array<Record<string, unknown>>).filter((row) => row.clanTag === scopeKey),
        ),
      }));
    });
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
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [],
      trackedTags: [],
      trackedNameByTag: new Map(),
      trackedBadgeByTag: new Map(),
      warnings: [],
      diagnosticNote: null,
    } as Awaited<ReturnType<InactiveWarService["listInactiveWarPlayers"]>>);
  });

  it("shows TH19 placement input but withholds unsupported rankings", async () => {
    const result = await new CompoPlaceService().readPlace(181000, "TH19", "guild-1");

    expect(result.content).toContain("Bucket: **TH19**");
    expect(result.content).toContain("Input weight: **181,000**");
    expect(result.content).toContain("Factual roster observations: **UNKNOWN — no tracked clans configured**");
    expect(result.content).toContain("Target comparison: **UNKNOWN**");
    expect(result.content).toContain("placement rankings and replacement suggestions are withheld");
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]?.toJSON().fields?.find((field) => field.name === "Recommended")?.value).toContain("UNKNOWN");
    expect(result.candidateCount).toBe(0);
  });

  it.each([
    [100000, "<=TH13"],
    [145000, "TH15"],
    [181000, "TH19"],
  ] as const)("uses the same truthful no-tracked-clans response for %s", async (weight, bucket) => {
    const result = await new CompoPlaceService().readPlace(weight, bucket, "guild-1");
    expect(result.content).toContain(`Bucket: **${bucket}**`);
    expect(result.content).toContain("Factual roster observations: **UNKNOWN — no tracked clans configured**");
    expect(result.content).toContain("Target comparison: **UNKNOWN**");
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]?.toJSON().fields?.find((field) => field.name === "Composition")?.value).toContain("UNKNOWN");
    expect(result.candidateCount).toBe(0);
  });

  it.each([181000, 190000])("renders persisted factual observations for TH19 input %s without target advice", async (weight) => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
      makeTrackedClan("#BBB222", "Bravo Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        playerTag: "#P000002",
        playerName: "Alpha One",
        townHall: 19,
        weight,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
      },
      ...makeCurrentMembers({ clanTag: "#BBB222", counts: { TH18: 1 } }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(weight, "TH19", "guild-1");
    const embed = result.embeds[0]?.toJSON();
    const factual = embed?.fields?.find((field) => field.name === "Factual observations")?.value ?? "";

    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.eligibleClanTags).toEqual([]);
    expect(factual).toContain("Alpha Clan - observed 1 TH19");
    expect(factual).toContain("Bravo Clan - observed 0 TH19");
    expect(result.content).toContain("Target comparison is UNKNOWN for TH19");
    expect(embed?.fields?.find((field) => field.name === "Recommended")?.value).toContain("UNKNOWN");
    expect(embed?.fields?.find((field) => field.name === "Composition")?.value).toContain("UNKNOWN");
    expect(embed?.fields?.find((field) => field.name === "Possible replacements")?.value).toContain("UNKNOWN");
  });

  it("does not turn an absent persisted roster into 50 factual vacancies", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(175000, "TH18", "guild-1");
    const embed = result.embeds[0]?.toJSON();
    expect(result.vacancyCount).toBe(0);
    expect(embed?.fields?.find((field) => field.name === "Vacancy")?.value).toContain("unknown/50");
    expect(embed?.fields?.find((field) => field.name === "Factual observations")?.value).toContain("unknown/50");
  });

  it("keeps stale roster rows factual but withholds exact vacancies and target eligibility", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      makeCurrentMembers({ clanTag: "#AAA111", counts: { TH18: 1 } }),
    );
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([{
      scopeKey: "#AAA111",
      lastAttemptAt: new Date("2026-05-20T11:00:00.000Z"),
      lastSuccessAt: new Date("2026-04-01T12:00:00.000Z"),
      lastStatus: "SUCCESS",
      lastRowCount: 1,
      lastChangedRowCount: 1,
      lastContentHash: hashCurrentRows(makeCurrentMembers({ clanTag: "#AAA111", counts: { TH18: 1 } })),
    }]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(175000, "TH18", "guild-1");
    const embed = result.embeds[0]?.toJSON();
    const factual = embed?.fields?.find((field) => field.name === "Factual observations")?.value ?? "";

    expect(factual).toContain("coverage stale");
    expect(factual).toContain("target UNKNOWN");
    expect(factual).toContain("source <t:");
    expect(result.eligibleClanTags).toEqual([]);
    expect(result.vacancyCount).toBe(0);
    expect(embed?.fields?.find((field) => field.name === "Vacancy")?.value).toContain("unknown/50");
  });

  it("keeps contradictory sync row counts factual but ineligible", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      makeCurrentMembers({ clanTag: "#AAA111", counts: { TH18: 2 } }),
    );
    prismaMock.fwaFeedSyncState.findMany.mockResolvedValue([{
      scopeKey: "#AAA111",
      lastAttemptAt: new Date("2026-05-20T11:00:00.000Z"),
      lastSuccessAt: new Date("2026-05-20T11:00:00.000Z"),
      lastStatus: "NOOP",
      lastRowCount: 1,
      lastChangedRowCount: 0,
      lastContentHash: "contradictory-fixture-hash",
    }]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(175000, "TH18", "guild-1");
    const factual = result.embeds[0]?.toJSON().fields?.find((field) => field.name === "Factual observations")?.value ?? "";

    expect(factual).toContain("coverage contradictory");
    expect(factual).toContain("target UNKNOWN");
    expect(result.eligibleClanTags).toEqual([]);
  });

  it.each([50, 100])("bounds serialized placement payloads for %s tracked clans", async (clanCount) => {
    const tracked = Array.from({ length: clanCount }, (_, index) => ({
      tag: `#C${String(index).padStart(7, "0")}`,
      name: `Clan ${index} with a deliberately long representative display name`,
      shortName: null,
    }));
    prismaMock.trackedClan.findMany.mockResolvedValue(tracked);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      tracked.map((clan, index) => ({
        clanTag: clan.tag,
        playerTag: validPlayerTag(index + 1),
        playerName: `Player ${index}`,
        weight: 175000,
        townHall: 18,
        sourceSyncedAt: new Date("2026-05-20T12:00:00.000Z"),
      })),
    );
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(175000, "TH18", "guild-1");
    const payloads = result.embeds.map((embed) => embed.toJSON());
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.length).toBeLessThanOrEqual(10);
    expect(payloads.every((embed) => (embed.fields?.length ?? 0) <= 25)).toBe(true);
    expect(payloads.every((embed) =>
      (embed.fields ?? []).every((field) => (field.value?.length ?? 0) <= 1024),
    )).toBe(true);
    expect(payloads.every((embed) => serializedDiscordEmbedCharacterCount(embed) <= 6000)).toBe(true);
    const serialized = JSON.stringify(payloads);
    for (const clan of tracked) {
      expect(serialized).toContain(clan.name);
    }
  });

  it("keeps factual rows for unsupported clans while ranking only supported legacy clans", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
      makeTrackedClan("#BBB222", "Bravo Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      ...makeCurrentMembers({ clanTag: "#AAA111", counts: { TH18: 1 } }),
      {
        clanTag: "#BBB222",
        playerTag: "#P000020",
        playerName: "TH19 Player",
        townHall: 19,
        weight: 181000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(175000, "TH18", "guild-1");
    const factual = result.embeds[0]?.toJSON().fields?.find((field) => field.name === "Factual observations")?.value ?? "";
    expect(factual).toContain("Alpha Clan - observed 1 TH18");
    expect(factual).toContain("Bravo Clan - observed 0 TH18");
    expect(result.eligibleClanTags).toEqual(["#AAA111"]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads ACTUAL placement suggestions from persisted tracked clans, current members, and HeatMapRef without sheet services", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
      makeTrackedClan("#BBB222", "Bravo Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      ...makeCurrentMembers({
        clanTag: "#AAA111",
        counts: { TH18: 19, TH17: 11, TH16: 7, TH15: 4, TH14: 4, TH13: 2, TH12: 1, TH11: 2 },
      }),
      ...makeCurrentMembers({
        clanTag: "#BBB222",
        counts: { TH18: 17, TH17: 11, TH16: 7, TH15: 5, TH14: 4, TH13: 2, TH12: 1, TH11: 1 },
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );
    const readCompoLinkedValuesSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "readCompoLinkedValues",
    );

    const result = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");

    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();
    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.eligibleClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.candidateCount).toBe(2);
    expect(result.recommendedCount).toBe(1);
    expect(result.vacancyCount).toBe(1);
    expect(result.compositionCount).toBe(2);

    const embed = result.embeds[0]?.toJSON();
    expect(embed?.description).toContain("Mode: **ACTUAL Auto-Detect**");
    expect(embed?.description).toContain("Deltas: **resolved roster vs HeatMapRef**");
    expect(embed?.description).toContain("Weight: **145,000**");
    expect(embed?.description).toContain("Bucket: **TH15**");
    expect(embed?.description).toContain("RAW Data last refreshed:");
    expect(embed?.fields?.find((field) => field.name === "Recommended")?.value).toContain(
      "Bravo Clan - needs 1 TH15",
    );
    expect(embed?.fields?.find((field) => field.name === "Vacancy")?.value).toContain(
      "Bravo Clan - 48/50",
    );
    const compositionValue =
      embed?.fields?.find((field) => field.name === "Composition")?.value ?? "";
    expect(compositionValue).toContain("Alpha Clan - -2");
    expect(compositionValue).toContain("Bravo Clan - -1");
    expect(compositionValue.indexOf("Alpha Clan - -2")).toBeLessThan(
      compositionValue.indexOf("Bravo Clan - -1"),
    );
  });

  it("uses ACTUAL Auto-Detect projection totals and resolved-count deltas for placement recommendations", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      ...makeCurrentMembers({
        clanTag: "#AAA111",
        counts: { TH18: 1, TH14: 47 },
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 6_600_000,
        th18Count: 1,
        th14Count: 47,
      }),
      makeHeatMapRef({
        weightMinInclusive: 6_600_001,
        weightMaxInclusive: 7_500_000,
        th18Count: 3,
        th14Count: 47,
      }),
    ]);

    const result = await new CompoPlaceService().readPlace(175000, "TH18", "guild-1");

    expect(result.candidateCount).toBe(1);
    expect(result.recommendedCount).toBe(0);
    const embed = result.embeds[0]?.toJSON();
    expect(embed?.description).toContain("Mode: **ACTUAL Auto-Detect**");
    expect(embed?.description).toContain("Deltas: **resolved roster vs HeatMapRef**");
    expect(embed?.fields?.find((field) => field.name === "Composition")?.value).toBe("None");
    expect(embed?.fields?.find((field) => field.name === "Recommended")?.value).toBe("None");
  });

  it("adds a compact Possible replacements summary after Composition and reuses the loaded ACTUAL context once", async () => {
    const replacementResolveSpy = vi.spyOn(
      CompoReplacementService.prototype,
      "resolveReplacementCandidates",
    );
    const violationCountSpy = vi.spyOn(
      WarPlanViolationHistoryService.prototype,
      "getClanPlayerViolationCounts",
    );
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan", "RR"),
      makeTrackedClan("#BBB222", "Bravo Clan", "RD"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      ...makeCurrentMembers({
        clanTag: "#AAA111",
        counts: { TH15: 3 },
        startIndex: 1,
      }),
      ...makeCurrentMembers({
        clanTag: "#BBB222",
        counts: { TH15: 2 },
        startIndex: 100,
      }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        th15Count: 5,
      }),
    ]);
    prismaMock.playerLink.findMany.mockResolvedValue([
      { playerTag: validPlayerTag(2), discordUserId: "555555555555555555" },
      { playerTag: validPlayerTag(100), discordUserId: "666666666666666666" },
      { playerTag: validPlayerTag(101), discordUserId: "777777777777777777" },
    ]);
    prismaMock.playerActivity.findMany.mockResolvedValue([
      { tag: validPlayerTag(2), lastSeenAt: new Date("2026-04-01T00:00:00.000Z") },
      { tag: validPlayerTag(3), lastSeenAt: new Date("2026-04-01T00:00:00.000Z") },
      { tag: validPlayerTag(100), lastSeenAt: new Date("2026-05-14T00:00:00.000Z") },
      { tag: validPlayerTag(101), lastSeenAt: new Date("2026-05-14T00:00:00.000Z") },
    ]);
    prismaMock.fillerAccount.findMany.mockResolvedValue([
      { playerTag: validPlayerTag(1) },
      { playerTag: validPlayerTag(2) },
    ]);
    vi.spyOn(InactiveWarService.prototype, "listInactiveWarPlayers").mockResolvedValue({
      results: [
        {
          clanTag: "#AAA111",
          playerTag: "#P000002",
          playerName: "Alpha Two",
          townHall: 15,
          missedWars: 2,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [],
        },
        {
          clanTag: "#AAA111",
          playerTag: "#P000008",
          playerName: "Alpha Three",
          townHall: 15,
          missedWars: 2,
          participationWars: 3,
          totalTrueStars: 0,
          avgAttackDelay: null,
          lateAttacks: 0,
          warsAvailable: 3,
          missedWarStates: [],
        },
      ],
      trackedTags: ["#AAA111", "#BBB222"],
      trackedNameByTag: new Map([
        ["#AAA111", "Alpha Clan"],
        ["#BBB222", "Bravo Clan"],
      ]),
      trackedBadgeByTag: new Map([
        ["#AAA111", null],
        ["#BBB222", null],
      ]),
      warnings: [],
      diagnosticNote: null,
    });

    const result = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");

    expect(replacementResolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "guild-1", weight: 145000 }),
    );
    expect(replacementResolveSpy.mock.calls[0]?.[0]).not.toHaveProperty(
      "includeViolationCounts",
      true,
    );
    expect(violationCountSpy).not.toHaveBeenCalled();

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    const embed = result.embeds[0]?.toJSON();
    const fieldNames = (embed?.fields ?? []).map((field) => field.name);
    expect(fieldNames).toEqual([
      "Factual observations",
      "Recommended",
      "Vacancy",
      "Composition",
      "Possible replacements",
    ]);
    const possibleReplacements =
      embed?.fields?.find((field) => field.name === "Possible replacements")?.value ?? "";
    expect(possibleReplacements).toContain("Legend: 🧍 fillers · 😴 inactive · 📵 unlinked · 📈 surplus bucket");
    expect(possibleReplacements).toContain("RR: 3 candidates · 🧍2 😴3 📵2");
    expect(possibleReplacements).toContain("RD: none");
    expect(possibleReplacements).not.toContain("stale");
    expect(possibleReplacements).not.toContain("missing");
  });

  it("uses member weight, then deferred weight, then WAR effective weight, and ignores unresolved zero-weight rows", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        playerTag: "#P000002",
        weight: 145000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000008" }),
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000009" }),
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000020" }),
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
        th18Count: 0,
        th17Count: 1,
        th16Count: 1,
        th15Count: 2,
      }),
    ]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");

    expect(result.candidateCount).toBe(0);
    expect(result.compositionCount).toBe(0);
    const embed = result.embeds[0]?.toJSON();
    expect(embed?.fields?.find((field) => field.name === "Factual observations")?.value).toContain(
      "Alpha Clan - observed 1 TH15 (coverage not complete)",
    );
    expect(resolvePlacementWeightForTest({
      memberWeight: 145000,
      deferredWeight: 166000,
      sameClanWarWeight: 155000,
      anyWarWeight: 170000,
    })).toBe(145000);
    expect(resolvePlacementWeightForTest({
      memberWeight: 0,
      deferredWeight: 166000,
      sameClanWarWeight: 155000,
      anyWarWeight: 170000,
    })).toBe(166000);
    expect(resolvePlacementWeightForTest({
      memberWeight: 0,
      deferredWeight: null,
      sameClanWarWeight: 155000,
      anyWarWeight: 170000,
    })).toBe(155000);
    expect(resolvePlacementWeightForTest({
      memberWeight: 0,
      deferredWeight: null,
      sameClanWarWeight: null,
      anyWarWeight: null,
    })).toBeNull();
  });

  it("derives placement buckets from resolved weights and collapses TH13-and-lower display deltas", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        playerTag: "#P000002",
        weight: 119000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
      {
        clanTag: "#AAA111",
        playerTag: "#P000008",
        weight: 80000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
      {
        clanTag: "#AAA111",
        playerTag: "#P000009",
        weight: 65000,
        sourceSyncedAt: new Date("2026-04-10T16:30:00.000Z"),
        townHall: 18,
      },
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        th18Count: 0,
        th17Count: 0,
        th16Count: 0,
        th15Count: 0,
        th14Count: 0,
        th13Count: 2,
        th12Count: 2,
        th11Count: 2,
        th10OrLowerCount: 0,
      }),
    ]);

    const result = await new CompoPlaceService().readPlace(100000, "<=TH13", "guild-1");

    expect(result.candidateCount).toBe(1);
    const embed = result.embeds[0]?.toJSON();
    expect(embed?.fields?.find((field) => field.name === "Composition")?.value).toContain(
      "Alpha Clan - -3",
    );
    expect(
      buildBucketDeltaByHeaderForTest(makeHeatMapRef({
        th13Count: 2,
        th12Count: 2,
        th11Count: 2,
      }), {
        TH18: 0,
        TH17: 0,
        TH16: 0,
        TH15: 0,
        TH14: 0,
        "<=TH13": 3,
      })["<=th13-delta"],
    ).toBe(-3);
  });

  it("returns honest text when tracked clans lack eligible persisted ACTUAL placement data", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
      makeTrackedClan("#BBB222", "Bravo Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeZeroWeightMember({ clanTag: "#AAA111", playerTag: "#P000002" }),
      makeZeroWeightMember({ clanTag: "#BBB222", playerTag: "#P000008" }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);

    const result = await new CompoPlaceService().readPlace(145000, "TH15", "guild-1");

    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.eligibleClanTags).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(result.embeds).toHaveLength(1);
    expect(result.content).toContain(
      "No eligible placement data found in persisted ACTUAL current-member state.",
    );
  });

  it("refreshes ACTUAL member weights and live member counts for all tracked clans before rereading persisted place data", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      makeCurrentMembers({
        clanTag: "#AAA111",
        counts: { TH15: 50 },
      }),
    );
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([makeHeatMapRef()]);
    const syncAllTrackedClansSpy = vi
      .spyOn(FwaClanMembersSyncService.prototype, "syncAllTrackedClans")
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 50,
        changedRowCount: 50,
        failedClans: [],
      });
    const refreshCurrentClanMembersSpy = vi
      .spyOn(FwaClanMembersSyncService.prototype, "refreshCurrentClanMembersForClanTags")
      .mockResolvedValue({
        clanCount: 1,
        rowCount: 50,
        changedRowCount: 50,
        failedClans: [],
      });
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );

    await new CompoPlaceService().refreshPlace(145000, "TH15", "guild-1");

    expect(syncAllTrackedClansSpy).toHaveBeenCalledWith({
      force: true,
    });
    expect(refreshCurrentClanMembersSpy).toHaveBeenCalledWith(["#AAA111"]);
    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
  });
});
