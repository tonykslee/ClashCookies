import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  currentWar: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  maintenanceWindowRuntimeState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PointsSyncService", () => ({
  PointsSyncService: vi.fn().mockImplementation(() => ({
    getCurrentSyncForClan: vi.fn(),
    markNeedsValidation: vi.fn().mockResolvedValue(undefined),
    clearNeedsValidation: vi.fn().mockResolvedValue(undefined),
    markConfirmedByClanMail: vi.fn().mockResolvedValue(undefined),
  })),
}));

import {
  getCurrentWarIdForClanForTest,
  resolveCurrentWarScopedSyncRowForTest,
  resolveCurrentWarSyncIdentityForTest,
} from "../src/commands/Fwa";
import { WarEventLogService } from "../src/services/WarEventLogService";

function makeWarIdentity(params: {
  currentWarId: number | null;
  currentWarStartTime: Date | null;
  currentWarOpponentTag: string | null;
  liveWarStartTime: string | null;
  liveOpponentTag: string | null;
}) {
  return resolveCurrentWarSyncIdentityForTest({
    clanTag: "#2RYGLU2UY",
    warState: "preparation",
    currentWarId: params.currentWarId,
    currentWarStartTime: params.currentWarStartTime,
    currentWarOpponentTag: params.currentWarOpponentTag,
    liveWarStartTime: params.liveWarStartTime,
    liveOpponentTag: params.liveOpponentTag,
  });
}

describe("Rocky Road war identity resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks the send path when the poller has not materialized a current-war id yet", () => {
    const identity = makeWarIdentity({
      currentWarId: null,
      currentWarStartTime: null,
      currentWarOpponentTag: null,
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.positivelyResolved).toBe(true);
    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
    expect(identity.opponentTag).toBe("LYPLQQUC");
  });

  it("reuses the current-war id safely once the poller has stamped the matching identity", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000610,
      currentWarStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentWarOpponentTag: "#LYPLQQUC",
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.positivelyResolved).toBe(true);
    expect(identity.warId).toBe("1000610");
  });

  it("drops the current-war id when the final rerender only sees a partial live identity", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000610,
      currentWarStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentWarOpponentTag: "#LYPLQQUC",
      liveWarStartTime: null,
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
    expect(identity.opponentTag).toBe("LYPLQQUC");
  });

  it("rejects a stale current-war id when the live identity has rolled to a new war", () => {
    const identity = makeWarIdentity({
      currentWarId: 1000609,
      currentWarStartTime: new Date("2026-07-11T15:22:26.000Z"),
      currentWarOpponentTag: "#OLDOPP",
      liveWarStartTime: "20260712T152226.000Z",
      liveOpponentTag: "#LYPLQQUC",
    });

    expect(identity.warId).toBeNull();
    expect(identity.warStartTime?.toISOString()).toBe("2026-07-12T15:22:26.000Z");
  });

  it("keeps scoped sync-row selection aligned to start time and opponent before reuse", () => {
    const selected = resolveCurrentWarScopedSyncRowForTest({
      rows: [
        {
          warId: "1000609",
          warStartTime: new Date("2026-07-11T15:22:26.000Z"),
          opponentTag: "#OLDOPP",
          needsValidation: false,
        } as any,
      ],
      warId: "1000610",
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      opponentTag: "LYPLQQUC",
    });

    expect(selected).toBeNull();
  });
});

describe("Current-war lookup and allocation diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the persisted current-war id without validating the supplied war-start time", async () => {
    prismaMock.currentWar.findUnique.mockResolvedValueOnce({
      warId: 1000609,
    });

    const warId = await getCurrentWarIdForClanForTest(
      "guild-1",
      "2RYGLU2UY",
      new Date("2026-07-12T15:22:26.000Z").getTime(),
    );

    expect(warId).toBe(1000609);
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledWith({
      where: {
        clanTag_guildId: {
          guildId: "guild-1",
          clanTag: "#2RYGLU2UY",
        },
      },
      select: { warId: true },
    });
  });

  it("allocates the same next war id for overlapping poll cycles that observe the same max snapshot", async () => {
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.$queryRaw.mockResolvedValue([{ warId: 1000610 }]);
    const service = new WarEventLogService({} as any, {} as any);
    const args = {
      sub: {
        clanTag: "#2RYGLU2UY",
        warId: null,
        startTime: null,
      },
      warStartTime: new Date("2026-07-12T15:22:26.000Z"),
      currentState: "preparation" as const,
    };

    const [first, second] = await Promise.all([
      (service as any).ensureCurrentWarId(args),
      (service as any).ensureCurrentWarId(args),
    ]);

    expect(first).toBe(1000610);
    expect(second).toBe(1000610);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("leaves the next render with a stale or null current-war id when persistence fails after allocation", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          guildId: "guild-1",
          clanTag: "#2RYGLU2UY",
          warId: null,
          syncNum: 532,
          channelId: "mail-channel-1",
          notify: true,
          pingRole: false,
          embedEnabled: true,
          notifyRole: "notify-role-1",
          inferredMatchType: false,
          fwaPoints: null,
          opponentFwaPoints: null,
          outcome: null,
          matchType: "FWA",
          warStartFwaPoints: null,
          warEndFwaPoints: null,
          clanStars: null,
          opponentStars: null,
          state: "preparation",
          prepStartTime: new Date("2026-07-11T15:22:26.000Z"),
          startTime: null,
          endTime: null,
          opponentTag: null,
          opponentName: null,
          clanName: "Rocky Road",
          clanRoleId: null,
          pointsConfirmedByClanMail: false,
          pointsNeedsValidation: true,
          pointsLastSuccessfulFetchAt: null,
          pointsLastKnownSyncNumber: null,
          pointsLastKnownPoints: null,
          pointsLastKnownMatchType: null,
          pointsLastKnownOutcome: null,
          pointsWarId: null,
          pointsOpponentTag: null,
          pointsWarStartTime: null,
        },
      ])
      .mockResolvedValueOnce([{ warId: 1000610 }]);
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.currentWar.updateMany.mockRejectedValueOnce(
      new Error("write failed"),
    );

    const service = new WarEventLogService({ channels: { fetch: vi.fn() } } as any, {
      getCurrentWar: vi.fn().mockResolvedValue({
        state: "preparation",
        startTime: "20260712T152226.000Z",
        opponent: {
          tag: "#LYPLQQUC",
          name: "War Farmers x44",
        },
        clan: {
          name: "Rocky Road",
        },
      }),
    } as any);
    (service as any).hasWarEndRecorded = vi.fn().mockResolvedValue(false);
    (service as any).getCurrentWarSnapshot = vi.fn().mockResolvedValue({
      war: {
        state: "preparation",
        startTime: "20260712T152226.000Z",
        opponent: {
          tag: "#LYPLQQUC",
          name: "War Farmers x44",
        },
        clan: {
          name: "Rocky Road",
        },
      },
      observation: { kind: "success" },
      error: null,
    });
    (service as any).syncWarAttacksFromWarSnapshot = vi.fn().mockResolvedValue(0);
    (service as any).dispatchDetectedEvent = vi.fn().mockResolvedValue(undefined);
    (service as any).reconcileWarEndedPointsDiscrepancy = vi.fn().mockResolvedValue(undefined);
    (service as any).pointsGate = {
      evaluatePollerFetch: vi.fn().mockReturnValue({
        allowed: false,
        fetchReason: "post_war_reconciliation",
      }),
    };
    (service as any).pointsSync = {
      resetWarStartPointsJob: vi.fn().mockResolvedValue(undefined),
      maybeRunWarStartPointsCheck: vi.fn().mockResolvedValue(undefined),
      getPreviousSyncNum: vi.fn().mockResolvedValue(532),
    };
    (service as any).currentSyncs = {
      markNeedsValidation: vi.fn().mockResolvedValue(undefined),
      getCurrentSyncForClan: vi.fn().mockResolvedValue(null),
    };
    (service as any).history = {
      resolveExactCanonicalWarEndedHistoryRow: vi.fn().mockResolvedValue(null),
      getWarEndResultSnapshot: vi.fn().mockResolvedValue({
        clanStars: null,
        opponentStars: null,
        clanDestruction: null,
        opponentDestruction: null,
        warEndTime: null,
        resultLabel: "UNKNOWN",
      }),
    };

    await expect(
      (service as any).processSubscription("guild-1", "#2RYGLU2UY", {
        previousSync: 532,
        activeSync: 533,
      }),
    ).resolves.toBe(false);

    const rerenderWarId = await getCurrentWarIdForClanForTest(
      "guild-1",
      "2RYGLU2UY",
      new Date("2026-07-12T15:22:26.000Z").getTime(),
    );
    expect(rerenderWarId).toBeNull();
  });
});

type IdentityCompletionRow = {
  warId: number | null;
  state: "preparation" | "inWar";
  startTime: Date;
  opponentTag: string | null;
  updatedAt: Date;
};

function makeIdentityCompletionRow(
  overrides?: Partial<IdentityCompletionRow>,
): IdentityCompletionRow {
  return {
    warId: null,
    state: "preparation",
    startTime: new Date("2026-07-16T20:03:41.000Z"),
    opponentTag: "2RU0J9QQJ",
    updatedAt: new Date("2026-07-16T05:40:28.027Z"),
    ...overrides,
  };
}

describe("Current-war identity completion CAS", () => {
  const guildId = "1324040917602013261";
  const clanTag = "#2YUYLJCGV";
  const liveStartTime = new Date("2026-07-16T20:03:41.000Z");
  const liveOpponentTag = "#2RU0J9QQJ";
  const expectedRevisionAt = new Date("2026-07-16T05:40:28.027Z");

  function buildHarness(input: {
    exactRow: IdentityCompletionRow | null;
    rereadRow?: IdentityCompletionRow | null;
    allocatedWarId?: number;
    updateCount?: number;
  }) {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new WarEventLogService({} as any, {} as any);
    const readRows = [input.exactRow, input.rereadRow];

    prismaMock.$queryRaw.mockResolvedValue([
      { warId: input.allocatedWarId ?? 1000611 },
    ]);
    prismaMock.currentWar.findUnique.mockImplementation(async () => readRows.shift() ?? null);
    prismaMock.currentWar.updateMany.mockImplementation(async () => ({
      count: input.updateCount ?? 1,
    }));

    return {
      service,
      infoSpy,
      warnSpy,
      queryRawSpy: prismaMock.$queryRaw,
      findUniqueSpy: prismaMock.currentWar.findUnique,
      updateManySpy: prismaMock.currentWar.updateMany,
    };
  }

  async function runIdentityCompletion(
    service: WarEventLogService,
    opponentTag = liveOpponentTag,
    warStartTime = liveStartTime,
  ) {
    return (service as any).ensureCurrentWarIdentityCompletion({
      guildId,
      clanTag,
      warState: "preparation",
      warStartTime,
      opponentTag,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("self-heals a bare stored opponent by matching the raw tag in the CAS and canonicalizing on write", async () => {
    const harness = buildHarness({
      exactRow: makeIdentityCompletionRow({
        opponentTag: "2RU0J9QQJ",
      }),
      allocatedWarId: 1000611,
    });

    const result = await runIdentityCompletion(harness.service);

    expect(result).toEqual({
      state: "saved",
      warId: 1000611,
      persistedRevisionAt: expect.any(Date),
    });
    expect(harness.findUniqueSpy).toHaveBeenCalledTimes(1);
    expect(harness.queryRawSpy).toHaveBeenCalledTimes(1);
    expect(harness.updateManySpy).toHaveBeenCalledTimes(1);
    expect(harness.updateManySpy.mock.calls[0]?.[0]).toMatchObject({
      where: {
        guildId,
        clanTag,
        updatedAt: expectedRevisionAt,
        state: "preparation",
        startTime: liveStartTime,
        opponentTag: "2RU0J9QQJ",
        warId: null,
      },
      data: {
        warId: 1000611,
        opponentTag: "#2RU0J9QQJ",
        updatedAt: expect.any(Date),
      },
    });
    expect(harness.infoSpy.mock.calls.at(-1)?.[0]).toContain(
      "stored_opponent_tag_form=bare",
    );
    expect(harness.warnSpy).not.toHaveBeenCalled();
  });

  it("keeps a canonical stored opponent idempotent without writing again", async () => {
    const harness = buildHarness({
      exactRow: makeIdentityCompletionRow({
        opponentTag: "#2RU0J9QQJ",
        warId: 1000611,
      }),
    });

    const result = await runIdentityCompletion(harness.service);

    expect(result).toEqual({
      state: "idempotent",
      warId: 1000611,
      persistedRevisionAt: expectedRevisionAt,
    });
    expect(harness.findUniqueSpy).toHaveBeenCalledTimes(1);
    expect(harness.queryRawSpy).not.toHaveBeenCalled();
    expect(harness.updateManySpy).not.toHaveBeenCalled();
  });

  it("fails closed when the live opponent is a different physical war", async () => {
    const harness = buildHarness({
      exactRow: makeIdentityCompletionRow({
        opponentTag: "#OLDOPP",
      }),
    });

    const result = await runIdentityCompletion(harness.service);

    expect(result).toEqual({
      state: "identity_changed",
      warId: null,
      persistedRevisionAt: expectedRevisionAt,
    });
    expect(harness.findUniqueSpy).toHaveBeenCalledTimes(1);
    expect(harness.queryRawSpy).not.toHaveBeenCalled();
    expect(harness.updateManySpy).not.toHaveBeenCalled();
    expect(harness.warnSpy.mock.calls.at(-1)?.[0]).toContain(
      "stored_opponent_tag_form=canonical",
    );
  });

  it("accepts a reread that upgrades the raw representation and already owns a positive war id", async () => {
    const harness = buildHarness({
      exactRow: makeIdentityCompletionRow({
        opponentTag: "2RU0J9QQJ",
      }),
      rereadRow: makeIdentityCompletionRow({
        warId: 1000611,
        opponentTag: "#2RU0J9QQJ",
        updatedAt: new Date("2026-07-16T05:40:28.028Z"),
      }),
      updateCount: 0,
    });

    const result = await runIdentityCompletion(harness.service);

    expect(result).toEqual({
      state: "idempotent",
      warId: 1000611,
      persistedRevisionAt: new Date("2026-07-16T05:40:28.028Z"),
    });
    expect(harness.findUniqueSpy).toHaveBeenCalledTimes(2);
    expect(harness.queryRawSpy).toHaveBeenCalledTimes(1);
    expect(harness.updateManySpy).toHaveBeenCalledTimes(1);
    expect(harness.infoSpy.mock.calls.at(-1)?.[0]).toContain(
      "stored_opponent_tag_form=bare",
    );
    expect(harness.infoSpy.mock.calls.at(-1)?.[0]).toContain(
      "reread_opponent_tag_form=canonical",
    );
  });

  it("keeps a reread with the same physical identity and null war id in conflict", async () => {
    const harness = buildHarness({
      exactRow: makeIdentityCompletionRow({
        opponentTag: "2RU0J9QQJ",
      }),
      rereadRow: makeIdentityCompletionRow({
        warId: null,
        opponentTag: "#2RU0J9QQJ",
        updatedAt: new Date("2026-07-16T05:40:28.029Z"),
      }),
      updateCount: 0,
    });

    const result = await runIdentityCompletion(harness.service);

    expect(result).toEqual({
      state: "conflict",
      warId: null,
      persistedRevisionAt: null,
    });
    expect(harness.findUniqueSpy).toHaveBeenCalledTimes(2);
    expect(harness.queryRawSpy).toHaveBeenCalledTimes(1);
    expect(harness.updateManySpy).toHaveBeenCalledTimes(1);
    expect(harness.warnSpy.mock.calls.at(-1)?.[0]).toContain(
      "stored_opponent_tag_form=bare",
    );
    expect(harness.warnSpy.mock.calls.at(-1)?.[0]).toContain(
      "reread_opponent_tag_form=canonical",
    );
  });

  it("treats a reread identity change as identity_changed and does not reuse any fallback id", async () => {
    const harness = buildHarness({
      exactRow: makeIdentityCompletionRow({
        opponentTag: "2RU0J9QQJ",
      }),
      rereadRow: makeIdentityCompletionRow({
        warId: null,
        startTime: new Date("2026-07-16T20:04:41.000Z"),
        opponentTag: "#2RU0J9QQJ",
        updatedAt: new Date("2026-07-16T05:40:28.030Z"),
      }),
      updateCount: 0,
    });

    const result = await runIdentityCompletion(harness.service);

    expect(result).toEqual({
      state: "identity_changed",
      warId: null,
      persistedRevisionAt: new Date("2026-07-16T05:40:28.030Z"),
    });
    expect(harness.findUniqueSpy).toHaveBeenCalledTimes(2);
    expect(harness.queryRawSpy).toHaveBeenCalledTimes(1);
    expect(harness.updateManySpy).toHaveBeenCalledTimes(1);
    expect(harness.warnSpy.mock.calls.at(-1)?.[0]).toContain(
      "reread_opponent_tag_form=canonical",
    );
  });

  it.each([
    {
      guildId: "1324040917602013261",
      clanTag: "#2YUYLJCGV",
      opponentTag: "2RU0J9QQJ",
      allocatedWarId: 1000611,
    },
    {
      guildId: "1324040917602013262",
      clanTag: "#7ABC1234",
      opponentTag: "2XTEST99",
      allocatedWarId: 1000612,
    },
  ])(
    "repairs bare stored opponents independently for %s",
    async ({ guildId: rowGuildId, clanTag: rowClanTag, opponentTag, allocatedWarId }) => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const service = new WarEventLogService({} as any, {} as any);
      prismaMock.$queryRaw.mockResolvedValue([{ warId: allocatedWarId }]);
      prismaMock.currentWar.findUnique.mockResolvedValue(
        makeIdentityCompletionRow({
          opponentTag,
        }),
      );
      prismaMock.currentWar.updateMany.mockResolvedValue({ count: 1 });
      const liveOpponentTagForRow = opponentTag.startsWith("#")
        ? opponentTag
        : `#${opponentTag}`;

      const result = await (service as any).ensureCurrentWarIdentityCompletion({
        guildId: rowGuildId,
        clanTag: rowClanTag,
        warState: "preparation",
        warStartTime: liveStartTime,
        opponentTag: liveOpponentTagForRow,
      });

      expect(result).toEqual({
        state: "saved",
        warId: allocatedWarId,
        persistedRevisionAt: expect.any(Date),
      });
      expect(prismaMock.currentWar.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            guildId: rowGuildId,
            clanTag: rowClanTag,
            opponentTag,
          }),
          data: expect.objectContaining({
            opponentTag: liveOpponentTagForRow,
          }),
        }),
      );
      expect(infoSpy.mock.calls.at(-1)?.[0]).toContain(
        "stored_opponent_tag_form=bare",
      );
    },
  );
});
