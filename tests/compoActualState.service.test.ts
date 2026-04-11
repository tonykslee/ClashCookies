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
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
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

    const result = await new CompoActualStateService().readState("guild-1");

    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();
    expect(result.trackedClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.renderableClanTags).toEqual(["#AAA111", "#BBB222"]);
    expect(result.contentLines[0]).toContain("RAW Data last refreshed:");
    expect(result.stateRows).toEqual([
      ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
      ["Alpha Clan", "466,000", "1", "4", "0", "0", "0", "-1", "0", "0"],
      ["Bravo Clan", "0", "0", "0", "0", "0", "0", "0", "0", "0"],
    ]);
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

    const result = await new CompoActualStateService().readState("guild-1");

    expect(result.stateRows).toEqual([
      ["Clan", "Total", "Missing", "Players", "TH18", "TH17", "TH16", "TH15", "TH14", "<=TH13"],
      ["Alpha Clan", "439,000", "0", "4", "0", "0", "0", "0", "0", "-3"],
    ]);
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
});
