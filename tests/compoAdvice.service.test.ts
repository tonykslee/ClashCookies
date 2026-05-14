import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { HeatMapRefDisplayService } from "../src/services/HeatMapRefDisplayService";
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
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
  fwaClanCatalog: {
    findMany: vi.fn(),
  },
  fwaWarMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterCurrent: {
    findMany: vi.fn(),
  },
  fwaTrackedClanWarRosterMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaClanMatchStatsCurrent: {
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
    prismaMock.fwaPlayerCatalog.findMany.mockReset();
    prismaMock.playerCurrent.findMany.mockReset();
    prismaMock.fwaClanCatalog.findMany.mockReset();
    prismaMock.fwaWarMemberCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterCurrent.findMany.mockReset();
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockReset();
    prismaMock.fwaClanMatchStatsCurrent.findMany.mockReset();
    prismaMock.heatMapRef.findMany.mockReset();
    prismaMock.weightInputDeferment.findMany.mockReset();
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([]);
    prismaMock.fwaWarMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMatchStatsCurrent.findMany.mockResolvedValue([]);
  });

  it("uses link-list fallback weights before deferred and war fallbacks in ACTUAL advice", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000002",
        playerName: "Feed",
        townHall: 15,
        weight: 145000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000008",
        playerName: "Catalog",
        townHall: 15,
        weight: 0,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000009",
        playerName: "PlayerCurrent",
        townHall: 15,
        weight: 0,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000020",
        playerName: "Deferred",
        townHall: 15,
        weight: 0,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000028",
        playerName: "War",
        townHall: 15,
        weight: 0,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000088",
        playerName: "Missing",
        townHall: 15,
        weight: 0,
      }),
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
      {
        scopeKey: "guild:guild-1|clan:AAA111",
        playerTag: "#P000020",
        deferredWeight: 136000,
        createdAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        playerTag: "#P000028",
        effectiveWeight: 174000,
        updatedAt: new Date("2026-04-12T00:00:00.000Z"),
      },
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

    const result = await new CompoAdviceService().readAdvice({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
      view: "raw",
    });

    expect(result.kind).toBe("ready");
    expect(result.summary.resolvedRosterWeight).toBe(798000);
    expect(result.summary.currentWeight).toBe(798000);
    expect(result.summary.currentProjection.totalWeight).toBe(798000);
    expect(result.summary.currentProjection.deferredWeightCount).toBe(1);
    // missingWeights includes unresolved weights plus WAR fallback-only resolved members.
    expect(result.summary.currentProjection.missingWeights).toBe(2);
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
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([{ clanTag: "#AAA111" }]);
    prismaMock.fwaClanMatchStatsCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        matchRate: 0.72,
        evaluatedWarCount: 10,
      },
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
    expect(result.summary.resolvedRosterWeight).toBeGreaterThan(0);
    expect(result.summary.currentWeight).toBe(result.summary.resolvedRosterWeight);
    expect(result.trackedClanChoices).toEqual([
      { tag: "#AAA111", name: "Alpha Clan-actual" },
    ]);
  });

  it("keeps ACTUAL auto advice projected band selection while showing resolved-count deltas", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue(
      Array.from({ length: 47 }, (_, index) =>
        makeCurrentMember({
          clanTag: "#AAA111",
          playerTag: makeValidPlayerTag(index),
          playerName: `Player ${index + 1}`,
          townHall: 14,
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
    const readHeatMapRefBandMatchRatesSpy = vi
      .spyOn(
        HeatMapRefDisplayService.prototype,
        "readHeatMapRefBandMatchRates",
      )
      .mockResolvedValue(new Map());

    const result = await new CompoAdviceService().readAdvice({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
    });

    expect(result.kind).toBe("ready");
    expect(result.selectedView).toBe("auto");
    expect(result.summary.currentProjection.totalWeight).toBe(6870000);
    expect(result.summary.currentProjection.deltaByBucket.TH18).toBe(-3);
    expect(result.summary.currentProjection.deltaByBucket.TH14).toBe(0);
    expect(readHeatMapRefBandMatchRatesSpy).toHaveBeenCalledTimes(1);
  });

  it("logs a narrow Rocky Road ACTUAL diagnostics line for advice when the selected HeatMapRef band is missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#2RYGLU2UY", "Rocky Road"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMember({
        clanTag: "#2RYGLU2UY",
        playerTag: "#P000001",
        playerName: "Member",
        townHall: 15,
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
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([{ clanTag: "#2RYGLU2UY" }]);
    prismaMock.fwaClanMatchStatsCurrent.findMany.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await new CompoAdviceService().readAdvice({
      guildId: "guild-1",
      targetTag: "#2RYGLU2UY",
      mode: "actual",
    });

    expect(result.kind).toBe("ready");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "[compo-actual-debug]",
    );
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("surface=advice");
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "selectedHeatMapRefBandKey=null",
    );
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain(
      "coverageReason=out_of_range_low",
    );
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
    expect(result.summary.resolvedRosterWeight).toBeGreaterThan(0);
    expect(result.summary.selectedCustomBandIndex).toBe(1);
    expect(result.summary.currentBandLabel).toBe("(no band)");
    expect(result.summary.targetBandLabel).toContain("1,500,000");
    expect(result.summary.currentScore).toBeNull();
    expect(result.trackedClanChoices).toEqual([
      { tag: "#AAA111", name: "Alpha Clan-actual" },
    ]);
  });

  it("keeps Custom current score and matchrate populated while shifting the target band", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      makeTrackedClan("#AAA111", "Alpha Clan-actual"),
    ]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000001",
        playerName: "P1",
        townHall: 15,
        weight: 175000,
      }),
      makeCurrentMember({
        clanTag: "#AAA111",
        playerTag: "#P000002",
        playerName: "P2",
        townHall: 15,
        weight: 175000,
      }),
    ]);
    prismaMock.weightInputDeferment.findMany.mockResolvedValue([]);
    prismaMock.fwaTrackedClanWarRosterMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.heatMapRef.findMany.mockResolvedValue([
      makeHeatMapRef({
        weightMinInclusive: 0,
        weightMaxInclusive: 299_999,
        th14Count: 50,
      }),
      makeHeatMapRef({
        weightMinInclusive: 300_000,
        weightMaxInclusive: 599_999,
        th15Count: 50,
      }),
    ]);
    vi.spyOn(
      HeatMapRefDisplayService.prototype,
      "readHeatMapRefBandMatchRates",
    ).mockResolvedValue(
      new Map([
        ["0-299999", 0.7025],
        ["300000-599999", 0.7412],
      ]),
    );

    const first = await new CompoAdviceService().readAdvice({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
      view: "custom",
      customBandIndex: 0,
    });
    const second = await new CompoAdviceService().readAdvice({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
      view: "custom",
      customBandIndex: 1,
    });

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    expect(first.summary.viewLabel).toBe("Custom");
    expect(second.summary.viewLabel).toBe("Custom");
    expect(first.summary.currentBandLabel).not.toBe("(no band)");
    expect(first.summary.currentBandLabel).toBe(second.summary.currentBandLabel);
    expect(first.summary.currentScore).not.toBeNull();
    expect(first.summary.currentMatchrate).not.toBeNull();
    expect(first.summary.currentScore).toBe(second.summary.currentScore);
    expect(first.summary.currentMatchrate).toBeCloseTo(
      second.summary.currentMatchrate ?? 0,
      6,
    );
    expect(first.summary.targetBandLabel).not.toBe(second.summary.targetBandLabel);
    expect(first.summary.targetBandMatchrate).not.toBe(second.summary.targetBandMatchrate);
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
    prismaMock.fwaClanCatalog.findMany.mockResolvedValue([{ clanTag: "#AAA111" }]);
    prismaMock.fwaClanMatchStatsCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        matchRate: 0.72,
        evaluatedWarCount: 10,
      },
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
