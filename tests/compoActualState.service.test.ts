import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { FwaClanMembersSyncService } from "../src/services/fwa-feeds/FwaClanMembersSyncService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
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
  weightInputDeferment: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { CompoActualStateService } from "../src/services/CompoActualStateService";

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

function makeCatalog(input: { playerTag: string; latestKnownWeight: number }) {
  return {
    playerTag: input.playerTag,
    latestKnownWeight: input.latestKnownWeight,
  };
}

function makePlayerCurrent(input: { playerTag: string; currentWeight: number }) {
  return {
    playerTag: input.playerTag,
    currentWeight: input.currentWeight,
  };
}

function makeValidPlayerTag(index: number) {
  const alphabet = "PYLQGRJCUV0289";
  let value = index + 1;
  let encoded = "";
  do {
    encoded = alphabet[value % alphabet.length] + encoded;
    value = Math.floor(value / alphabet.length) - 1;
  } while (value >= 0);
  return `#${encoded}`;
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
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
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
      "6",
      "2",
      "1",
      "0",
      "1",
      "1",
      "0",
    ]);
    expect(result.contentLines).toContain(
      "Raw Data: current resolved roster composition.",
    );
    expect(result.contentLines).toContain(
      "No estimated fill-ins or heatmap deltas.",
    );
    expect(result.contentLines).toContain(
      "Missing-to-50 roster fill info: 44",
    );
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
    expect(result.contentLines[0]).toContain("RAW Data last refreshed:");
    expect(result.stateRows?.[0]).toEqual([
      "Clan",
      "Resolved Total",
      "Missing",
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
    ]);
    expect(result.contentLines).toContain(
      "Raw Data: current resolved roster composition.",
    );
    expect(result.contentLines).toContain(
      "No estimated fill-ins or heatmap deltas.",
    );
  });

  it("shows projected totals separately in ACTUAL auto view while keeping displayed deltas on resolved counts", async () => {
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
      "Projected Total",
      "Missing",
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
    expect(result.stateRows?.[1]?.[4]).toBe("6");
    expect(result.stateRows?.[1]?.[5]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[6]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[7]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[8]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[9]).toEqual(expect.any(String));
    expect(result.stateRows?.[1]?.[10]).toEqual(expect.any(String));
    expect(result.contentLines).toContain(
      "Resolved roster weight is shown separately from the projected 50-player total.",
    );
    expect(result.contentLines).toContain("Selected band source: projected total.");
    expect(result.contentLines).toContain("Deltas: resolved roster vs HeatMapRef.");
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
      "47",
      "-3",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(result.contentLines).toContain("Deltas: resolved roster vs HeatMapRef.");
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
        failedClans: [],
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

    await new CompoActualStateService().refreshState("guild-1");

    expect(syncAllTrackedClansSpy).toHaveBeenCalledWith({
      force: true,
    });
    expect(refreshCurrentClanMembersSpy).toHaveBeenCalledWith(["#AAA111"]);
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
});
