import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { CompoAdviceService } from "../src/services/CompoAdviceService";

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
  weight: number;
  sourceSyncedAt?: Date;
}) {
  return {
    clanTag: input.clanTag,
    playerTag: input.playerTag,
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

  it("loads ACTUAL advice from DB-backed state and defaults to Auto-Detect Band without sheet reads", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000001",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000002",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000003",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000004",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000005",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000006",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000007",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000008",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000009",
        weight: 135000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000010",
        weight: 135000,
      }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 1_300_000,
        weightMaxInclusive: 2_000_000,
        th14Count: 10,
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
    expect(result.selectedView).toBe("auto");
    expect(result.content).toContain("Mode: **ACTUAL**");
    expect(result.content).toContain("Advice View: **Auto-Detect Band**");
    expect(result.content).toContain("Current Score:");
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
    expect(result.selectedView).toBe("raw");
    expect(result.content).toContain("Mode: **WAR**");
    expect(result.content).toContain("Advice View: **Raw Data**");
    expect(result.content).toContain("Current Score:");
  });
});
