import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UserActivityReminderDeliveryStatus,
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  userActivityReminderRule: {
    findMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  userActivityReminderDelivery: {
    create: vi.fn(),
    update: vi.fn(),
  },
}));

const todoSnapshotServiceMock = vi.hoisted(() => ({
  refreshSnapshotsForPlayerTags: vi.fn(),
  listSnapshotsByPlayerTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/TodoSnapshotService", async () => {
  const actual = await vi.importActual("../src/services/TodoSnapshotService");
  return {
    ...actual,
    todoSnapshotService: todoSnapshotServiceMock,
  };
});

import {
  runUserActivityReminderSchedulerCycle,
  shouldReminderOffsetFireForTest,
} from "../src/services/remindme/UserActivityReminderSchedulerService";

function snapshotRow(input: {
  playerTag: string;
  clanTag?: string | null;
  clanName?: string | null;
  cwlClanTag?: string | null;
  cwlClanName?: string | null;
  warActive?: boolean;
  warEndsAt?: Date | null;
  cwlActive?: boolean;
  cwlEndsAt?: Date | null;
  raidActive?: boolean;
  raidEndsAt?: Date | null;
  gamesActive?: boolean;
  gamesEndsAt?: Date | null;
  gamesCycleKey?: string | null;
}) {
  return {
    playerTag: input.playerTag,
    playerName: `Player ${input.playerTag}`,
    clanTag: input.clanTag ?? "#PYLQ0289",
    clanName: input.clanName ?? "Clan A",
    cwlClanTag: input.cwlClanTag ?? "#QGRJ2222",
    cwlClanName: input.cwlClanName ?? "CWL Clan",
    warActive: input.warActive ?? false,
    warAttacksUsed: 0,
    warAttacksMax: 2,
    warPhase: "battle day",
    warEndsAt: input.warEndsAt ?? null,
    cwlActive: input.cwlActive ?? false,
    cwlAttacksUsed: 0,
    cwlAttacksMax: 1,
    cwlPhase: "battle day",
    cwlEndsAt: input.cwlEndsAt ?? null,
    raidActive: input.raidActive ?? false,
    raidAttacksUsed: 0,
    raidAttacksMax: 6,
    raidEndsAt: input.raidEndsAt ?? null,
    gamesActive: input.gamesActive ?? false,
    gamesPoints: 1000,
    gamesTarget: 4000,
    gamesChampionTotal: 1000,
    gamesSeasonBaseline: 0,
    gamesCycleKey: input.gamesCycleKey ?? null,
    gamesEndsAt: input.gamesEndsAt ?? null,
    lastUpdatedAt: new Date("2026-03-27T00:00:00.000Z"),
    updatedAt: new Date("2026-03-27T00:00:00.000Z"),
  } as any;
}

describe("UserActivityReminderSchedulerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.userActivityReminderRule.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.userActivityReminderDelivery.create.mockResolvedValue({ id: "delivery-1" });
    prismaMock.userActivityReminderDelivery.update.mockResolvedValue({});
    todoSnapshotServiceMock.refreshSnapshotsForPlayerTags.mockResolvedValue({
      playerCount: 0,
      updatedCount: 0,
    });
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([]);
  });

  it("fires one due reminder per active type context (WAR/CWL/RAIDS/GAMES)", async () => {
    const nowMs = Date.parse("2026-03-27T12:00:00.000Z");
    prismaMock.userActivityReminderRule.findMany.mockResolvedValue([
      {
        id: "rule-war",
        discordUserId: "111111111111111111",
        type: UserActivityReminderType.WAR,
        playerTag: "#P1111111",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: 60,
        isActive: true,
        surfaceChannelId: null,
      },
      {
        id: "rule-cwl",
        discordUserId: "111111111111111111",
        type: UserActivityReminderType.CWL,
        playerTag: "#P2222222",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: 60,
        isActive: true,
        surfaceChannelId: null,
      },
      {
        id: "rule-raids",
        discordUserId: "111111111111111111",
        type: UserActivityReminderType.RAIDS,
        playerTag: "#P3333333",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: 60,
        isActive: true,
        surfaceChannelId: null,
      },
      {
        id: "rule-games",
        discordUserId: "111111111111111111",
        type: UserActivityReminderType.GAMES,
        playerTag: "#P4444444",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: 60,
        isActive: true,
        surfaceChannelId: null,
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        warId: 991,
        startTime: new Date(nowMs - 6 * 60 * 60 * 1000),
        endTime: new Date(nowMs + 30 * 60 * 1000),
        state: "inWar",
        updatedAt: new Date(nowMs),
      },
    ]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([
      snapshotRow({
        playerTag: "#P1111111",
        clanTag: "#PYLQ0289",
        clanName: "War Clan",
        warActive: true,
        warEndsAt: new Date(nowMs + 30 * 60 * 1000),
      }),
      snapshotRow({
        playerTag: "#P2222222",
        cwlClanTag: "#QGRJ2222",
        cwlClanName: "CWL Clan",
        cwlActive: true,
        cwlEndsAt: new Date(nowMs + 30 * 60 * 1000),
      }),
      snapshotRow({
        playerTag: "#P3333333",
        clanTag: "#2QG2C08UP",
        clanName: "Raid Clan",
        raidActive: true,
        raidEndsAt: new Date(nowMs + 30 * 60 * 1000),
      }),
      snapshotRow({
        playerTag: "#P4444444",
        clanTag: "#P2YLC8R0",
        clanName: "Games Clan",
        gamesActive: true,
        gamesEndsAt: new Date(nowMs + 30 * 60 * 1000),
        gamesCycleKey: "cycle-2026-03",
      }),
    ]);
    prismaMock.userActivityReminderDelivery.create
      .mockResolvedValueOnce({ id: "delivery-1" })
      .mockResolvedValueOnce({ id: "delivery-2" })
      .mockResolvedValueOnce({ id: "delivery-3" })
      .mockResolvedValueOnce({ id: "delivery-4" });
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "msg-1",
        deliverySurface: "DM:123",
      }),
    };

    const counts = await runUserActivityReminderSchedulerCycle({
      client: {} as any,
      cocService: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(counts).toEqual({
      evaluated: 4,
      fired: 4,
      deduped: 0,
      failed: 0,
    });
    expect(todoSnapshotServiceMock.refreshSnapshotsForPlayerTags).toHaveBeenCalledWith({
      playerTags: ["#P1111111", "#P2222222", "#P3333333", "#P4444444"],
      cocService: {},
      nowMs,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(4);
    expect(
      dispatch.dispatchReminder.mock.calls.map((call: any[]) => call[1].eventInstanceKey),
    ).toEqual(
      expect.arrayContaining([
        "WAR:#PYLQ0289:war-id:991",
        `CWL:#QGRJ2222:${new Date(nowMs + 30 * 60 * 1000).getTime()}`,
        `RAIDS:#2QG2C08UP:${new Date(nowMs + 30 * 60 * 1000).getTime()}`,
        "GAMES:#P2YLC8R0:cycle-2026-03",
      ]),
    );
    expect(prismaMock.userActivityReminderDelivery.update).toHaveBeenCalledWith({
      where: { id: "delivery-1" },
      data: {
        deliveryStatus: UserActivityReminderDeliveryStatus.SENT,
        sentAt: new Date(nowMs),
        deliverySurface: "DM:123",
      },
    });
  });

  it("dedupes already-sent rule/event identities before dispatch", async () => {
    const nowMs = Date.parse("2026-03-27T12:00:00.000Z");
    prismaMock.userActivityReminderRule.findMany.mockResolvedValue([
      {
        id: "rule-raids",
        discordUserId: "111111111111111111",
        type: UserActivityReminderType.RAIDS,
        playerTag: "#P3333333",
        method: UserActivityReminderMethod.DM,
        offsetMinutes: 60,
        isActive: true,
        surfaceChannelId: null,
      },
    ]);
    todoSnapshotServiceMock.listSnapshotsByPlayerTags.mockResolvedValue([
      snapshotRow({
        playerTag: "#P3333333",
        clanTag: "#2QG2C08UP",
        clanName: "Raid Clan",
        raidActive: true,
        raidEndsAt: new Date(nowMs + 30 * 60 * 1000),
      }),
    ]);
    prismaMock.userActivityReminderDelivery.create.mockRejectedValue({ code: "P2002" });
    const dispatch = {
      dispatchReminder: vi.fn(),
    };

    const counts = await runUserActivityReminderSchedulerCycle({
      client: {} as any,
      cocService: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(counts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).not.toHaveBeenCalled();
  });

  it("fires when trigger window crossed or late before end, but never after end", () => {
    const endMs = Date.parse("2026-03-27T14:00:00.000Z");

    expect(
      shouldReminderOffsetFireForTest({
        nowMs: endMs - 30 * 60 * 1000,
        intervalMs: 60_000,
        eventEndsAtMs: endMs,
        offsetMinutes: 30,
      }),
    ).toBe(true);
    expect(
      shouldReminderOffsetFireForTest({
        nowMs: endMs - 5 * 60 * 1000,
        intervalMs: 60_000,
        eventEndsAtMs: endMs,
        offsetMinutes: 30,
      }),
    ).toBe(true);
    expect(
      shouldReminderOffsetFireForTest({
        nowMs: endMs + 1,
        intervalMs: 60_000,
        eventEndsAtMs: endMs,
        offsetMinutes: 30,
      }),
    ).toBe(false);
  });
});
