import { beforeEach, describe, expect, it, vi } from "vitest";

const txMock = vi.hoisted(() => ({
  cwlEventClan: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  cwlEventInstance: {
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  cwlEventWarTag: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
}));

const prismaMock = vi.hoisted(() => ({
  cwlEventClan: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { cwlEventResolutionService } from "../src/services/CwlEventResolutionService";

function makeEventSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-current",
    season: "2026-04",
    anchorWarTag: "#PYLQ0289",
    firstObservedAt: new Date("2026-04-01T00:00:00.000Z"),
    lastObservedAt: new Date("2026-04-01T01:00:00.000Z"),
    ...overrides,
  };
}

describe("CwlEventResolutionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.cwlEventClan.findMany.mockResolvedValue([]);
    txMock.cwlEventClan.findMany.mockResolvedValue([]);
    txMock.cwlEventClan.updateMany.mockResolvedValue({ count: 0 });
    txMock.cwlEventClan.upsert.mockResolvedValue(undefined);
    txMock.cwlEventInstance.create.mockResolvedValue({
      id: "event-created",
      anchorWarTag: "#PYLQ0289",
    });
    txMock.cwlEventInstance.update.mockResolvedValue(undefined);
    txMock.cwlEventInstance.findUnique.mockResolvedValue({
      anchorWarTag: "#PYLQ0289",
    });
    txMock.cwlEventWarTag.findMany.mockResolvedValue([]);
    txMock.cwlEventWarTag.updateMany.mockResolvedValue({ count: 0 });
    txMock.cwlEventWarTag.create.mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) =>
      fn(txMock),
    );
  });

  it("selects the latest current event deterministically when duplicate current rows exist", async () => {
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        eventInstance: makeEventSummary({
          id: "event-older",
          anchorWarTag: "#QGRJ2222",
          firstObservedAt: new Date("2026-04-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-04-01T01:00:00.000Z"),
        }),
      },
      {
        clanTag: "#PYLQ0289",
        eventInstance: makeEventSummary({
          id: "event-newer",
          anchorWarTag: "#PYLQ0289",
          firstObservedAt: new Date("2026-04-01T02:00:00.000Z"),
          lastObservedAt: new Date("2026-04-01T03:00:00.000Z"),
        }),
      },
      {
        clanTag: "#QGRJ2222",
        eventInstance: makeEventSummary({
          id: "event-other",
          anchorWarTag: "#JCUV2890",
          firstObservedAt: new Date("2026-04-01T00:30:00.000Z"),
          lastObservedAt: new Date("2026-04-01T00:45:00.000Z"),
        }),
      },
    ]);

    const rows = await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
      clanTags: ["#PYLQ0289", "#QGRJ2222", "#2QG2C08UP"],
    });

    expect(prismaMock.cwlEventClan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag: { in: ["#PYLQ0289", "#QGRJ2222", "#2QG2C08UP"] },
          isCurrent: true,
        },
      }),
    );
    expect(rows.get("#PYLQ0289")).toMatchObject({ id: "event-newer" });
    expect(rows.get("#QGRJ2222")).toMatchObject({ id: "event-other" });
  });

  it("filters current event summaries to the requested CWL season when one is provided", async () => {
    prismaMock.cwlEventClan.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        eventInstance: makeEventSummary({
          id: "event-june",
          season: "2026-06",
          anchorWarTag: "#JUNE",
          firstObservedAt: new Date("2026-06-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-06-01T01:00:00.000Z"),
        }),
      },
      {
        clanTag: "#PYLQ0289",
        eventInstance: makeEventSummary({
          id: "event-july",
          season: "2026-07",
          anchorWarTag: "#JULY",
          firstObservedAt: new Date("2026-07-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-07-01T01:00:00.000Z"),
        }),
      },
    ]);

    const rows = await cwlEventResolutionService.resolveCurrentCwlEventSummariesForClanTags({
      clanTags: ["#PYLQ0289"],
      season: "2026-07",
    });

    expect(prismaMock.cwlEventClan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag: { in: ["#PYLQ0289"] },
          isCurrent: true,
          season: "2026-07",
        },
      }),
    );
    expect(rows.get("#PYLQ0289")).toMatchObject({
      id: "event-july",
      season: "2026-07",
    });
  });

  it("creates one new event and flips only the resolved clan pointer current", async () => {
    txMock.cwlEventClan.findMany.mockResolvedValue([
      {
        eventInstanceId: "event-legacy",
        eventInstance: makeEventSummary({
          id: "event-legacy",
          anchorWarTag: "#QGRJ2222",
          firstObservedAt: new Date("2026-03-01T00:00:00.000Z"),
          lastObservedAt: new Date("2026-03-01T00:00:00.000Z"),
        }),
      },
    ]);
    txMock.cwlEventInstance.create.mockResolvedValue({
      id: "event-created",
      anchorWarTag: "#PYLQ0289",
    });
    txMock.cwlEventWarTag.findMany.mockResolvedValue([]);

    const result = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-04",
      clanTag: "#PYLQ0289",
      observedWarTags: ["#qgrj2222", "#pylq0289"],
      observedAt: new Date("2026-04-01T04:00:00.000Z"),
    });

    expect(result).toMatchObject({
      kind: "resolved",
      eventInstanceId: "event-created",
      created: true,
      anchorWarTag: "#PYLQ0289",
      previousCurrentEventInstanceId: "event-legacy",
      attachedWarTags: ["#PYLQ0289", "#QGRJ2222"],
    });
    expect(txMock.cwlEventInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          season: "2026-04",
          anchorWarTag: "#PYLQ0289",
          firstObservedAt: new Date("2026-04-01T04:00:00.000Z"),
          lastObservedAt: new Date("2026-04-01T04:00:00.000Z"),
        }),
      }),
    );
    expect(txMock.cwlEventWarTag.create).toHaveBeenCalledTimes(2);
    expect(txMock.cwlEventClan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clanTag: "#PYLQ0289",
          isCurrent: true,
          eventInstanceId: {
            not: "event-created",
          },
        },
        data: {
          isCurrent: false,
        },
      }),
    );
    expect(txMock.cwlEventClan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventInstanceId_clanTag: {
            eventInstanceId: "event-created",
            clanTag: "#PYLQ0289",
          },
        },
        create: expect.objectContaining({
          eventInstanceId: "event-created",
          season: "2026-04",
          clanTag: "#PYLQ0289",
          isCurrent: true,
        }),
        update: expect.objectContaining({
          season: "2026-04",
          isCurrent: true,
        }),
      }),
    );
  });

  it("reuses an already mapped event and refreshes event, war-tag, and clan timestamps", async () => {
    const observedAt = new Date("2026-04-01T05:00:00.000Z");
    txMock.cwlEventWarTag.findMany
      .mockResolvedValueOnce([
        { warTag: "#PYLQ0289", eventInstanceId: "event-existing" },
        { warTag: "#QGRJ2222", eventInstanceId: "event-existing" },
      ])
      .mockResolvedValueOnce([
        { warTag: "#PYLQ0289" },
        { warTag: "#QGRJ2222" },
      ]);
    txMock.cwlEventClan.findMany.mockResolvedValue([
      {
        eventInstanceId: "event-existing",
        eventInstance: makeEventSummary({
          id: "event-existing",
          anchorWarTag: "#PYLQ0289",
        }),
      },
    ]);
    txMock.cwlEventInstance.findUnique.mockResolvedValue({
      anchorWarTag: "#PYLQ0289",
    });

    const result = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-04",
      clanTag: "#PYLQ0289",
      observedWarTags: ["#PYLQ0289", "#QGRJ2222"],
      observedAt,
    });

    expect(result).toMatchObject({
      kind: "resolved",
      eventInstanceId: "event-existing",
      created: false,
      attachedWarTags: [],
      previousCurrentEventInstanceId: "event-existing",
    });
    expect(txMock.cwlEventInstance.create).not.toHaveBeenCalled();
    expect(txMock.cwlEventInstance.update).toHaveBeenCalledWith({
      where: { id: "event-existing" },
      data: { lastObservedAt: observedAt },
    });
    expect(txMock.cwlEventWarTag.updateMany).toHaveBeenCalledWith({
      where: {
        eventInstanceId: "event-existing",
        warTag: { in: ["#PYLQ0289", "#QGRJ2222"] },
      },
      data: { lastObservedAt: observedAt },
    });
    expect(txMock.cwlEventWarTag.create).not.toHaveBeenCalled();
    expect(txMock.cwlEventClan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          eventInstanceId_clanTag: {
            eventInstanceId: "event-existing",
            clanTag: "#PYLQ0289",
          },
        },
        update: expect.objectContaining({
          isCurrent: true,
          lastObservedAt: observedAt,
        }),
      }),
    );
  });

  it("attaches a later-observed unmapped war tag to the existing event", async () => {
    const observedAt = new Date("2026-04-01T06:00:00.000Z");
    txMock.cwlEventWarTag.findMany
      .mockResolvedValueOnce([
        { warTag: "#PYLQ0289", eventInstanceId: "event-existing" },
      ])
      .mockResolvedValueOnce([
        { warTag: "#PYLQ0289" },
      ]);
    txMock.cwlEventInstance.findUnique.mockResolvedValue({
      anchorWarTag: "#PYLQ0289",
    });

    const result = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-04",
      clanTag: "#PYLQ0289",
      observedWarTags: ["#PYLQ0289", "#2QG2C08UP"],
      observedAt,
    });

    expect(result).toMatchObject({
      kind: "resolved",
      eventInstanceId: "event-existing",
      created: false,
      attachedWarTags: ["#2QG2C08UP"],
    });
    expect(txMock.cwlEventInstance.create).not.toHaveBeenCalled();
    expect(txMock.cwlEventWarTag.create).toHaveBeenCalledTimes(1);
    expect(txMock.cwlEventWarTag.create).toHaveBeenCalledWith({
      data: {
        eventInstanceId: "event-existing",
        season: "2026-04",
        warTag: "#2QG2C08UP",
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
      },
    });
  });

  it("retains two disjoint same-month events for one clan and marks only the latest current", async () => {
    const firstObservedAt = new Date("2026-06-01T04:00:00.000Z");
    const secondObservedAt = new Date("2026-06-15T04:00:00.000Z");
    txMock.cwlEventWarTag.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    txMock.cwlEventInstance.create
      .mockResolvedValueOnce({
        id: "event-june-a",
        anchorWarTag: "#PYLQ0289",
      })
      .mockResolvedValueOnce({
        id: "event-june-b",
        anchorWarTag: "#2QG2C08UP",
      });
    txMock.cwlEventClan.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          eventInstanceId: "event-june-a",
          eventInstance: makeEventSummary({
            id: "event-june-a",
            season: "2026-06",
            anchorWarTag: "#PYLQ0289",
            firstObservedAt,
            lastObservedAt: firstObservedAt,
          }),
        },
      ]);

    const first = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-06",
      clanTag: "#PYLQ0289",
      observedWarTags: ["#PYLQ0289"],
      observedAt: firstObservedAt,
    });
    const second = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-06",
      clanTag: "#PYLQ0289",
      observedWarTags: ["#2QG2C08UP"],
      observedAt: secondObservedAt,
    });

    expect(first).toMatchObject({
      kind: "resolved",
      eventInstanceId: "event-june-a",
      created: true,
      previousCurrentEventInstanceId: null,
    });
    expect(second).toMatchObject({
      kind: "resolved",
      eventInstanceId: "event-june-b",
      created: true,
      previousCurrentEventInstanceId: "event-june-a",
    });
    expect(txMock.cwlEventInstance.create).toHaveBeenCalledTimes(2);
    expect(txMock.cwlEventClan.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          clanTag: "#PYLQ0289",
          isCurrent: true,
          eventInstanceId: {
            not: "event-june-b",
          },
        },
        data: {
          isCurrent: false,
        },
      }),
    );
    expect(txMock.cwlEventClan.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          eventInstanceId_clanTag: {
            eventInstanceId: "event-june-b",
            clanTag: "#PYLQ0289",
          },
        },
        create: expect.objectContaining({
          eventInstanceId: "event-june-b",
          season: "2026-06",
          clanTag: "#PYLQ0289",
          isCurrent: true,
          firstObservedAt: secondObservedAt,
          lastObservedAt: secondObservedAt,
        }),
      }),
    );
  });

  it("retries a transient transaction conflict before resolving the event", async () => {
    let transactionAttempts = 0;
    prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof txMock) => Promise<unknown>) => {
      transactionAttempts += 1;
      const result = await fn(txMock);
      if (transactionAttempts === 1) {
        throw { code: "P2002" };
      }
      return result;
    });
    txMock.cwlEventClan.findMany.mockResolvedValue([]);
    txMock.cwlEventWarTag.findMany.mockResolvedValue([]);

    const result = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-04",
      clanTag: "#PYLQ0289",
      observedWarTags: ["#PYLQ0289"],
      observedAt: new Date("2026-04-01T04:00:00.000Z"),
    });

    expect(transactionAttempts).toBe(2);
    expect(result).toMatchObject({
      kind: "resolved",
      eventInstanceId: "event-created",
    });
  });

  it("reports a collision when observed war tags point at different events", async () => {
    txMock.cwlEventWarTag.findMany.mockResolvedValue([
      { warTag: "#PYLQ0289", eventInstanceId: "event-a" },
      { warTag: "#QGRJ2222", eventInstanceId: "event-b" },
    ]);

    const result = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-04",
      clanTag: "#AAA111",
      observedWarTags: ["#PYLQ0289", "#QGRJ2222"],
      observedAt: new Date("2026-04-01T04:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "collision",
      reason: "WAR_TAG_EVENT_COLLISION",
      observedWarTagCount: 2,
      conflictingEventInstanceIds: ["event-a", "event-b"],
    });
    expect(txMock.cwlEventInstance.create).not.toHaveBeenCalled();
    expect(txMock.cwlEventClan.upsert).not.toHaveBeenCalled();
  });

  it("reports unresolved when no valid war tags are observed", async () => {
    const result = await cwlEventResolutionService.resolveCwlEventForClan({
      season: "2026-04",
      clanTag: "#AAA111",
      observedWarTags: ["", "#0"],
      observedAt: new Date("2026-04-01T04:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "unresolved",
      reason: "NO_VALID_WAR_TAG",
      observedWarTagCount: 0,
    });
    expect(txMock.cwlEventInstance.create).not.toHaveBeenCalled();
  });
});
