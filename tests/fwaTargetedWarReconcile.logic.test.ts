import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  currentWar: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
}));

const warEventLogServiceMock = vi.hoisted(() => ({
  pollClan: vi.fn(),
  poll: vi.fn(),
  refreshBattleDayPosts: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/WarEventLogService", () => ({
  WarEventLogService: class {
    pollClan = warEventLogServiceMock.pollClan;
    poll = warEventLogServiceMock.poll;
    refreshBattleDayPosts = warEventLogServiceMock.refreshBattleDayPosts;
  },
}));

import {
  buildWarMailCurrentWarRenderStateForTest,
  loadWarMailCurrentWarRenderRowForTest,
  resolveExactCurrentWarMailIdentityForTagForTest,
  resolveWarMailCurrentWarRenderContextForTest,
} from "../src/commands/Fwa";

const liveStartMs = new Date("2026-07-12T15:22:26.000Z").getTime();
const liveStartTime = new Date("2026-07-12T15:22:26.000Z");
const staleStartTime = new Date("2026-07-11T15:22:26.000Z");

function buildRenderRow(overrides: Record<string, unknown> = {}) {
  return {
    warId: 1000610,
    matchType: "FWA",
    inferredMatchType: true,
    outcome: "WIN",
    fwaPoints: 111,
    opponentFwaPoints: 99,
    startTime: liveStartTime,
    state: "preparation",
    endTime: new Date("2026-07-12T18:22:26.000Z"),
    opponentTag: "#LYPLQQUC",
    opponentName: "Old Opponent",
    clanStars: 30,
    opponentStars: 27,
    ...overrides,
  } as any;
}

function buildActiveIdentity(overrides: Record<string, unknown> = {}) {
  return {
    warState: "preparation",
    warId: null,
    warStartTime: null,
    opponentTag: null,
    positivelyResolved: false,
    ...overrides,
  } as any;
}

function expectNoMutatingWrites(): void {
  expect(prismaMock.currentWar.update).not.toHaveBeenCalled();
  expect(prismaMock.currentWar.upsert).not.toHaveBeenCalled();
}

function expectNoGlobalPolls(): void {
  expect(warEventLogServiceMock.poll).not.toHaveBeenCalled();
  expect(warEventLogServiceMock.refreshBattleDayPosts).not.toHaveBeenCalled();
}

describe("fwa targeted war-mail identity reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.currentWar.findUnique.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.currentWar.update.mockResolvedValue({});
    prismaMock.currentWar.upsert.mockResolvedValue({});
    warEventLogServiceMock.pollClan.mockResolvedValue({
      processed: true,
      warEnded: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the shared render-row select for the exact clan row", async () => {
    prismaMock.currentWar.findUnique.mockResolvedValueOnce(null);

    const result = await loadWarMailCurrentWarRenderRowForTest({
      guildId: " guild-1 ",
      normalizedTag: "LYPLQQUC",
    });

    expect(result).toBeNull();
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledWith({
      where: {
        clanTag_guildId: {
          guildId: " guild-1 ",
          clanTag: "#LYPLQQUC",
        },
      },
      select: expect.objectContaining({
        warId: true,
        matchType: true,
        inferredMatchType: true,
        outcome: true,
        fwaPoints: true,
        opponentFwaPoints: true,
        startTime: true,
        state: true,
        endTime: true,
        opponentTag: true,
        opponentName: true,
        clanStars: true,
        opponentStars: true,
      }),
    });
  });

  it("accepts an already exact active CurrentWar row without polling", async () => {
    const exactRow = buildRenderRow({
      warId: 1000610,
      state: "preparation",
      opponentTag: "#LYPLQQUC",
      opponentName: "Exact Opponent",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: 120,
      opponentFwaPoints: 108,
      clanStars: 28,
      opponentStars: 26,
    });
    expect(
      resolveExactCurrentWarMailIdentityForTagForTest(exactRow, {
        liveWarState: "preparation",
        liveWarStartMs: liveStartMs,
        liveOpponentTag: "LYPLQQUC",
      }),
    ).toEqual({
      warId: 1000610,
      startTime: liveStartTime,
      opponentTag: "LYPLQQUC",
    });

    const result = await resolveWarMailCurrentWarRenderContextForTest({
      client: { channels: { fetch: vi.fn() } } as any,
      cocService: {} as any,
      guildId: "guild-1",
      normalizedTag: "LYPLQQUC",
      liveWarState: "preparation",
      liveWarStartMs: liveStartMs,
      liveOpponentTag: "LYPLQQUC",
      activeWarSyncIdentity: buildActiveIdentity({
        warId: "1000610",
        warStartTime: liveStartTime,
        opponentTag: "LYPLQQUC",
        positivelyResolved: true,
      }),
      currentWarRow: exactRow,
    });

    expect(result).toEqual({
      identity: {
        warId: 1000610,
        startTime: liveStartTime,
        opponentTag: "LYPLQQUC",
      },
      currentWarRow: exactRow,
      reconciled: false,
    });
    expect(warEventLogServiceMock.pollClan).not.toHaveBeenCalled();
    expectNoGlobalPolls();
    expectNoMutatingWrites();
  });

  it("reconciles a stale row through pollClan and replaces the render row with the fresh exact row", async () => {
    const staleRow = buildRenderRow({
      warId: 1000609,
      matchType: "FWA",
      inferredMatchType: true,
      outcome: "WIN",
      fwaPoints: 211,
      opponentFwaPoints: 198,
      startTime: staleStartTime,
      state: "preparation",
      endTime: new Date("2026-07-11T18:22:26.000Z"),
      opponentTag: "#OLDTAG",
      opponentName: "Old Opponent",
      clanStars: 31,
      opponentStars: 29,
    });
    const freshRow = buildRenderRow({
      warId: 1000610,
      matchType: "MM",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: null,
      opponentFwaPoints: null,
      startTime: liveStartTime,
      state: "preparation",
      endTime: null,
      opponentTag: "#LYPLQQUC",
      opponentName: "Fresh Opponent",
      clanStars: 17,
      opponentStars: 14,
    });
    prismaMock.currentWar.findUnique.mockResolvedValueOnce(freshRow);

    const result = await resolveWarMailCurrentWarRenderContextForTest({
      client: { channels: { fetch: vi.fn() } } as any,
      cocService: {} as any,
      guildId: "guild-1",
      normalizedTag: "LYPLQQUC",
      liveWarState: "preparation",
      liveWarStartMs: liveStartMs,
      liveOpponentTag: "LYPLQQUC",
      activeWarSyncIdentity: buildActiveIdentity({
        warId: null,
        warStartTime: liveStartTime,
        opponentTag: "LYPLQQUC",
        positivelyResolved: true,
      }),
      currentWarRow: staleRow,
    });

    expect(result).toEqual({
      identity: {
        warId: 1000610,
        startTime: liveStartTime,
        opponentTag: "LYPLQQUC",
      },
      currentWarRow: freshRow,
      reconciled: true,
    });
    expect(warEventLogServiceMock.pollClan).toHaveBeenCalledTimes(1);
    expect(warEventLogServiceMock.pollClan).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "LYPLQQUC",
      sendBattleDaySwapReminders: false,
    });
    expect(warEventLogServiceMock.poll).not.toHaveBeenCalled();
    expect(warEventLogServiceMock.refreshBattleDayPosts).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledTimes(1);
    expectNoMutatingWrites();

    const freshState = buildWarMailCurrentWarRenderStateForTest(
      result.currentWarRow,
    );
    expect(freshState).toMatchObject({
      warId: 1000610,
      matchType: "MM",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: null,
      opponentFwaPoints: null,
      opponentTag: "LYPLQQUC",
      opponentName: "Fresh Opponent",
      clanStars: 17,
      opponentStars: 14,
    });
    expect(freshState.matchType).not.toBe(staleRow.matchType);
    expect(freshState.inferredMatchType).not.toBe(Boolean(staleRow.inferredMatchType));
    expect(freshState.outcome).not.toBe(staleRow.outcome);
    expect(freshState.fwaPoints).not.toBe(staleRow.fwaPoints);
    expect(freshState.opponentFwaPoints).not.toBe(staleRow.opponentFwaPoints);
    expect(freshState.clanStars).not.toBe(staleRow.clanStars);
    expect(freshState.opponentStars).not.toBe(staleRow.opponentStars);
  });

  it.each([
    ["poll throws", async () => {
      warEventLogServiceMock.pollClan.mockRejectedValueOnce(new Error("poll boom"));
    }],
    ["processed false", async () => {
      warEventLogServiceMock.pollClan.mockResolvedValueOnce({
        processed: false,
        warEnded: false,
      });
    }],
    ["missing reread", async () => {
      prismaMock.currentWar.findUnique.mockResolvedValueOnce(null);
    }],
    ["reread ID null", async () => {
      prismaMock.currentWar.findUnique.mockResolvedValueOnce(
        buildRenderRow({ warId: null }),
      );
    }],
    ["reread ID zero", async () => {
      prismaMock.currentWar.findUnique.mockResolvedValueOnce(
        buildRenderRow({ warId: 0 }),
      );
    }],
    ["reread ID negative", async () => {
      prismaMock.currentWar.findUnique.mockResolvedValueOnce(
        buildRenderRow({ warId: -7 }),
      );
    }],
    ["reread start differs", async () => {
      prismaMock.currentWar.findUnique.mockResolvedValueOnce(
        buildRenderRow({ startTime: staleStartTime }),
      );
    }],
    ["reread opponent differs", async () => {
      prismaMock.currentWar.findUnique.mockResolvedValueOnce(
        buildRenderRow({ opponentTag: "#ANOTHER" }),
      );
    }],
    ["reread state is notInWar", async () => {
      prismaMock.currentWar.findUnique.mockResolvedValueOnce(
        buildRenderRow({ state: "notInWar" }),
      );
    }],
  ])(
    "fails closed when %s",
    async (
      _label,
      setup,
    ) => {
      const staleRow = buildRenderRow({
        warId: null,
        state: "preparation",
        opponentTag: "#OLDTAG",
        opponentName: "Old Opponent",
        startTime: staleStartTime,
      });
      await setup();

      const result = await resolveWarMailCurrentWarRenderContextForTest({
        client: { channels: { fetch: vi.fn() } } as any,
        cocService: {} as any,
        guildId: "guild-1",
        normalizedTag: "LYPLQQUC",
        liveWarState: "preparation",
        liveWarStartMs: liveStartMs,
        liveOpponentTag: "LYPLQQUC",
        activeWarSyncIdentity: buildActiveIdentity({
          warId: null,
          warStartTime: liveStartTime,
          opponentTag: "LYPLQQUC",
          positivelyResolved: true,
        }),
        currentWarRow: staleRow,
      });

      expect(result.identity).toBeNull();
      expect(result.currentWarRow).toBe(staleRow);
      expect(result.reconciled).toBe(false);
      expect(warEventLogServiceMock.pollClan).toHaveBeenCalledTimes(1);
      expect(warEventLogServiceMock.poll).not.toHaveBeenCalled();
      expect(warEventLogServiceMock.refreshBattleDayPosts).not.toHaveBeenCalled();
      expectNoMutatingWrites();
    },
  );

  it.each([
    ["missing live start", null, "LYPLQQUC"],
    ["missing live opponent", liveStartMs, null],
    ["live state is notInWar", liveStartMs, "LYPLQQUC"],
    ["interactive client absent", liveStartMs, "LYPLQQUC"],
  ])(
    "does not poll when %s",
    async (label, testLiveStartMs, testOpponentTag) => {
      const staleRow = buildRenderRow({
        warId: null,
        state: "preparation",
        opponentTag: "#OLDTAG",
        opponentName: "Old Opponent",
        startTime: staleStartTime,
      });
      const result = await resolveWarMailCurrentWarRenderContextForTest({
        client: label === "interactive client absent" ? null : { channels: { fetch: vi.fn() } } as any,
        cocService: {} as any,
        guildId: "guild-1",
        normalizedTag: "LYPLQQUC",
        liveWarState: label === "live state is notInWar" ? "notInWar" : "preparation",
        liveWarStartMs: testLiveStartMs,
        liveOpponentTag: label === "missing live opponent" ? null : testOpponentTag,
        activeWarSyncIdentity: buildActiveIdentity({
          warId: null,
          warStartTime: liveStartTime,
          opponentTag: "LYPLQQUC",
          positivelyResolved: false,
        }),
        currentWarRow: staleRow,
      });

      expect(result.identity).toBeNull();
      expect(result.currentWarRow).toBe(staleRow);
      expect(result.reconciled).toBe(false);
      expect(warEventLogServiceMock.pollClan).not.toHaveBeenCalled();
      expectNoGlobalPolls();
      expectNoMutatingWrites();
    },
  );

  it("preserves the fail-closed render row when no usable positive identity exists", async () => {
    const staleRow = buildRenderRow({
      warId: null,
      state: "preparation",
      opponentTag: "#OLDTAG",
      opponentName: "Old Opponent",
      startTime: staleStartTime,
      matchType: "FWA",
      inferredMatchType: true,
      outcome: "WIN",
      fwaPoints: 200,
      opponentFwaPoints: 170,
      clanStars: 31,
      opponentStars: 30,
    });
    const result = await resolveWarMailCurrentWarRenderContextForTest({
      client: { channels: { fetch: vi.fn() } } as any,
      cocService: {} as any,
      guildId: "guild-1",
      normalizedTag: "LYPLQQUC",
      liveWarState: "preparation",
      liveWarStartMs: liveStartMs,
      liveOpponentTag: "LYPLQQUC",
      activeWarSyncIdentity: buildActiveIdentity({
        warId: null,
        warStartTime: liveStartTime,
        opponentTag: "LYPLQQUC",
        positivelyResolved: false,
      }),
      currentWarRow: staleRow,
    });

    expect(result.identity).toBeNull();
    expect(result.currentWarRow).toBe(staleRow);
    expect(result.reconciled).toBe(false);
    expect(warEventLogServiceMock.pollClan).toHaveBeenCalledTimes(1);
    expectNoGlobalPolls();
    expectNoMutatingWrites();
  });

  it("exposes the fresh row's render state rather than the stale row's values", () => {
    const staleRow = buildRenderRow({
      warId: 1000609,
      matchType: "FWA",
      inferredMatchType: true,
      outcome: "WIN",
      fwaPoints: 400,
      opponentFwaPoints: 380,
      startTime: staleStartTime,
      endTime: new Date("2026-07-11T18:22:26.000Z"),
      opponentTag: "#OLDTAG",
      opponentName: "Old Opponent",
      clanStars: 42,
      opponentStars: 35,
    });
    const freshRow = buildRenderRow({
      warId: 1000610,
      matchType: "MM",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: null,
      opponentFwaPoints: null,
      startTime: liveStartTime,
      endTime: null,
      opponentTag: "#LYPLQQUC",
      opponentName: "Fresh Opponent",
      clanStars: 18,
      opponentStars: 12,
    });

    const staleState = buildWarMailCurrentWarRenderStateForTest(staleRow);
    const freshState = buildWarMailCurrentWarRenderStateForTest(freshRow);

    expect(staleState).toMatchObject({
      warId: 1000609,
      matchType: "FWA",
      inferredMatchType: true,
      outcome: "WIN",
      fwaPoints: 400,
      opponentFwaPoints: 380,
      opponentTag: "OLDTAG",
      opponentName: "Old Opponent",
      clanStars: 42,
      opponentStars: 35,
    });
    expect(freshState).toMatchObject({
      warId: 1000610,
      matchType: "MM",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: null,
      opponentFwaPoints: null,
      opponentTag: "LYPLQQUC",
      opponentName: "Fresh Opponent",
      clanStars: 18,
      opponentStars: 12,
    });
    expect(freshState.matchType).not.toBe(staleState.matchType);
    expect(freshState.inferredMatchType).not.toBe(staleState.inferredMatchType);
    expect(freshState.outcome).not.toBe(staleState.outcome);
    expect(freshState.fwaPoints).not.toBe(staleState.fwaPoints);
    expect(freshState.opponentFwaPoints).not.toBe(staleState.opponentFwaPoints);
    expect(freshState.clanStars).not.toBe(staleState.clanStars);
    expect(freshState.opponentStars).not.toBe(staleState.opponentStars);
  });

  it("accepts the exact reread row when the live state is active and the reread remains exact", async () => {
    const exactRow = buildRenderRow({
      warId: 1000610,
      matchType: "MM",
      inferredMatchType: false,
      outcome: null,
      fwaPoints: null,
      opponentFwaPoints: null,
      startTime: liveStartTime,
      state: "preparation",
      endTime: null,
      opponentTag: "#LYPLQQUC",
      opponentName: "Fresh Opponent",
      clanStars: 18,
      opponentStars: 12,
    });
    prismaMock.currentWar.findUnique.mockResolvedValueOnce(exactRow);

    const reread = await resolveWarMailCurrentWarRenderContextForTest({
      client: { channels: { fetch: vi.fn() } } as any,
      cocService: {} as any,
      guildId: "guild-1",
      normalizedTag: "LYPLQQUC",
      liveWarState: "preparation",
      liveWarStartMs: liveStartMs,
      liveOpponentTag: "LYPLQQUC",
      activeWarSyncIdentity: buildActiveIdentity({
        warId: null,
        warStartTime: liveStartTime,
        opponentTag: "LYPLQQUC",
        positivelyResolved: true,
      }),
      currentWarRow: buildRenderRow({
        warId: null,
        matchType: "FWA",
        inferredMatchType: true,
        outcome: "WIN",
        fwaPoints: 100,
        opponentFwaPoints: 90,
        startTime: staleStartTime,
        state: "preparation",
        endTime: new Date("2026-07-11T18:22:26.000Z"),
        opponentTag: "#OLDTAG",
        opponentName: "Old Opponent",
        clanStars: 40,
        opponentStars: 38,
      }),
    });

    expect(reread.identity).toEqual({
      warId: 1000610,
      startTime: liveStartTime,
      opponentTag: "LYPLQQUC",
    });
    expect(reread.currentWarRow).toBe(exactRow);
    expect(reread.reconciled).toBe(true);
    expect(warEventLogServiceMock.pollClan).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.update).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.upsert).not.toHaveBeenCalled();
  });
});
