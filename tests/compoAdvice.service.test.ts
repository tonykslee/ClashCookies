import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import {
  CompoAdviceService,
  countRushedCompoMembers,
} from "../src/services/CompoAdviceService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterCurrent: {
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
    refreshedAt: new Date("2026-04-12T00:00:00.000Z"),
  };
}

function makeCurrentMember(input: {
  clanTag: string;
  playerTag: string;
  playerName?: string;
  townHall?: number | null;
  weight: number;
  sourceSyncedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
    playerName: input.playerName ?? `Player ${input.playerTag}`,
    townHall: input.townHall ?? 18,
    weight: input.weight,
    sourceSyncedAt:
      input.sourceSyncedAt ?? new Date("2026-04-12T00:00:00.000Z"),
  };
}

function makeWarParent(input: {
  clanTag: string;
  clanName: string;
  rosterSize?: number;
  totalEffectiveWeight?: number | null;
  sourceUpdatedAt?: Date | null;
  observedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    clanName: input.clanName,
    opponentTag: null,
    opponentName: null,
    rosterSize: input.rosterSize ?? 50,
    totalRawWeight: input.totalEffectiveWeight ?? 8_100_000,
    totalEffectiveWeight:
      input.totalEffectiveWeight === undefined ? 8_100_000 : input.totalEffectiveWeight,
    hasUnresolvedWeights: false,
    observedAt: input.observedAt ?? new Date("2026-04-12T00:00:00.000Z"),
    sourceUpdatedAt:
      input.sourceUpdatedAt === undefined
        ? new Date("2026-04-12T00:00:00.000Z")
        : input.sourceUpdatedAt,
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
  };
}

function makeWarMember(input: {
  clanTag: string;
  position: number;
  rawWeight: number;
  effectiveWeight: number;
}) {
  return {
    clanTag: input.clanTag,
    position: input.position,
    playerTag: `#P${String(input.position).padStart(6, "0")}`,
    playerName: `Player ${input.position}`,
    townHall: 18,
    rawWeight: input.rawWeight,
    effectiveWeight: input.effectiveWeight,
    effectiveWeightStatus: "RAW",
    opponentTag: null,
    opponentName: null,
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
  };
}

describe("CompoAdviceService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.fwaClanMemberCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
  });

  it("loads ACTUAL advice from DB-backed state, defaults to Auto-Detect Band, and computes rushed members without sheet reads", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000001",
        playerName: "Rusher",
        townHall: 15,
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000002",
        playerName: "Stable",
        townHall: 13,
        weight: 135000,
      }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 200_000,
        weightMaxInclusive: 300_000,
        th14Count: 2,
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

    const result = await new CompoAdviceService().readAdvice({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
    });

    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();
    expect(result.kind).toBe("ready");
    expect(result.selectedView).toBe("auto");
    expect(result.summary.viewLabel).toBe("Auto-Detect Band");
    expect(result.trackedClanChoices).toEqual([
      { tag: "#AAA111", name: "Alpha Clan-actual" },
    ]);
  });

  it("keeps ACTUAL custom advice on a manually selected target band", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000001",
        playerName: "P1",
        townHall: 15,
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000002",
        playerName: "P2",
        townHall: 15,
        weight: 135000,
      }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 1_000_000,
        weightMaxInclusive: 1_499_999,
        th14Count: 2,
      }),
      makeHeatMapRef({
        weightMinInclusive: 1_500_000,
        weightMaxInclusive: 1_999_999,
        th15Count: 2,
      }),
    ]);

    const result = await new CompoAdviceService().readAdvice({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
      view: "custom",
      customBandIndex: 1,
    });

    expect(result.kind).toBe("ready");
    expect(result.selectedView).toBe("custom");
    expect(result.summary.viewLabel).toBe("Custom");
    expect(result.summary.selectedCustomBandIndex).toBe(1);
    expect(result.summary.currentBandLabel).toContain("1,500,000");
    expect(result.summary.currentScore).toBeGreaterThanOrEqual(0);
    expect(result.trackedClanChoices).toEqual([
      { tag: "#AAA111", name: "Alpha Clan-actual" },
    ]);
  });

  it("loads WAR advice from DB-backed tracked war state without sheet reads", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-war"),
    ]);
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockResolvedValue([
      makeWarParent({
        clanTag: "#AAA111",
        clanName: "Alpha Clan-war",
        totalEffectiveWeight: 8_100_000,
      }),
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      ...Array.from({ length: 50 }, (_, index) =>
        makeWarMember({
          clanTag: "#AAA111",
          position: index + 1,
          rawWeight: 145000,
          effectiveWeight: 145000,
        }),
      ),
    ]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 8_000_001,
        weightMaxInclusive: 8_100_000,
        th15Count: 50,
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

    const result = await new CompoAdviceService().readAdvice({
      targetTag: "#AAA111",
      mode: "war",
    });

    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();
    expect(result.kind).toBe("ready");
    expect(result.selectedView).toBe("raw");
    expect(result.summary.viewLabel).toBe("Raw Data");
    expect(result.summary.currentScore).toBe(0);
    expect(result.trackedClanChoices).toEqual([
      { tag: "#AAA111", name: "Alpha Clan-war" },
    ]);
  });

  it("counts rushed members from the resolved bucket, not the collapsed display label", () => {
    expect(
      countRushedCompoMembers([
        {
          clanTag: "#AAA111",
          playerTag: "#P1",
          playerName: "Rusher",
          townHall: 15,
          resolvedWeight: 135000,
          resolvedBucket: "TH14",
        },
        {
          clanTag: "#AAA111",
          playerTag: "#P2",
          playerName: "Stable",
          townHall: 13,
          resolvedWeight: 135000,
          resolvedBucket: "TH14",
        },
        {
          clanTag: "#AAA111",
          playerTag: "#P3",
          playerName: "Low",
          townHall: 9,
          resolvedWeight: 55000,
          resolvedBucket: "TH8_OR_LOWER",
        },
      ] as any),
    ).toBe(2);
  });
});
