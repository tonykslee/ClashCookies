import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderType } from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  reminder: {
    findMany: vi.fn(),
  },
  reminderFireLog: {
    create: vi.fn(),
    update: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  todoPlayerSnapshot: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CwlRegistryService", () => ({
  resolveCurrentCwlSeasonKey: vi.fn(() => "2026-04"),
}));

import {
  runReminderSchedulerCycle,
  shouldReminderOffsetFireForTest,
} from "../src/services/reminders/ReminderSchedulerService";

function setTodoSnapshotRows(input: {
  cwlRows?: Array<{
    cwlClanTag: string | null;
    cwlClanName: string | null;
    cwlPhase: string | null;
    cwlEndsAt: Date | null;
    updatedAt: Date;
  }>;
  timedRows?: Array<{
    clanTag: string | null;
    clanName: string | null;
    cwlClanTag: string | null;
    cwlClanName: string | null;
    raidActive: boolean;
    raidEndsAt: Date | null;
    gamesActive: boolean;
    gamesEndsAt: Date | null;
    updatedAt: Date;
  }>;
}) {
  const cwlRows = input.cwlRows ?? [];
  const timedRows = input.timedRows ?? [];
  prismaMock.todoPlayerSnapshot.findMany.mockImplementation(async (args: any) => {
    if (args?.select?.cwlPhase) return cwlRows;
    if (args?.select?.raidActive || args?.select?.gamesActive) return timedRows;
    return [];
  });
}

describe("ReminderSchedulerService v1 trigger semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.reminderFireLog.update.mockResolvedValue({});
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    setTodoSnapshotRows({});
  });

  it("uses WAR_CWL war end time (not preparation boundary) for trigger eligibility", async () => {
    const nowMs = Date.parse("2026-04-05T00:00:00.000Z");
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-war",
        guildId: "guild-1",
        channelId: "channel-1",
        type: ReminderType.WAR_CWL,
        isEnabled: true,
        times: [{ offsetSeconds: 15 * 60 }],
        targetClans: [{ clanTag: "#PYLQ0289", clanType: "FWA" }],
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        clanName: "War Clan",
        warId: 901,
        state: "preparation",
        startTime: new Date(nowMs + 10 * 60 * 1000),
        endTime: new Date(nowMs + 24 * 60 * 60 * 1000 + 10 * 60 * 1000),
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289", name: "War Clan" }]);
    const dispatch = {
      dispatchReminder: vi.fn(),
    };

    const counts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(counts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).not.toHaveBeenCalled();
  });

  it("fires WAR_CWL, RAIDS, and GAMES by end-time context with per-clan independent evaluation", async () => {
    const nowMs = Date.parse("2026-04-05T00:00:00.000Z");
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-war",
        guildId: "guild-1",
        channelId: "channel-war",
        type: ReminderType.WAR_CWL,
        isEnabled: true,
        times: [{ offsetSeconds: 60 * 60 }],
        targetClans: [{ clanTag: "#PYLQ0289", clanType: "FWA" }],
      },
      {
        id: "rem-raids",
        guildId: "guild-1",
        channelId: "channel-raids",
        type: ReminderType.RAIDS,
        isEnabled: true,
        times: [{ offsetSeconds: 60 * 60 }],
        targetClans: [
          { clanTag: "#QGRJ2222", clanType: "FWA" },
          { clanTag: "#2QG2C08UP", clanType: "FWA" },
        ],
      },
      {
        id: "rem-games",
        guildId: "guild-1",
        channelId: "channel-games",
        type: ReminderType.GAMES,
        isEnabled: true,
        times: [{ offsetSeconds: 60 * 60 }],
        targetClans: [{ clanTag: "#P2YLC8R0", clanType: "FWA" }],
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        clanName: "War Clan",
        warId: 902,
        state: "inWar",
        startTime: new Date(nowMs - 6 * 60 * 60 * 1000),
        endTime: new Date(nowMs + 30 * 60 * 1000),
        updatedAt: new Date(nowMs),
      },
    ]);
    setTodoSnapshotRows({
      timedRows: [
        {
          clanTag: "#QGRJ2222",
          clanName: "Raid Clan 1",
          cwlClanTag: null,
          cwlClanName: null,
          raidActive: true,
          raidEndsAt: new Date(nowMs + 30 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
        {
          clanTag: "#2QG2C08UP",
          clanName: "Raid Clan 2",
          cwlClanTag: null,
          cwlClanName: null,
          raidActive: false,
          raidEndsAt: new Date(nowMs + 30 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
        {
          clanTag: "#P2YLC8R0",
          clanName: "Games Clan",
          cwlClanTag: null,
          cwlClanName: null,
          raidActive: false,
          raidEndsAt: null,
          gamesActive: true,
          gamesEndsAt: new Date(nowMs + 30 * 60 * 1000),
          updatedAt: new Date(nowMs),
        },
      ],
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PYLQ0289", name: "War Clan" },
      { tag: "#QGRJ2222", name: "Raid Clan 1" },
      { tag: "#2QG2C08UP", name: "Raid Clan 2" },
      { tag: "#P2YLC8R0", name: "Games Clan" },
    ]);
    let fireIndex = 0;
    prismaMock.reminderFireLog.create.mockImplementation(async () => {
      fireIndex += 1;
      return { id: `fire-${fireIndex}` };
    });
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "msg-1",
      }),
    };

    const counts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(counts).toEqual({
      evaluated: 3,
      fired: 3,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(3);
    expect(dispatch.dispatchReminder.mock.calls.map(([, payload]) => payload.clanTag).sort()).toEqual(
      ["#P2YLC8R0", "#PYLQ0289", "#QGRJ2222"],
    );
  });

  it("applies threshold crossing + late-fire before end, and never fires after event end", () => {
    const endMs = Date.parse("2026-04-05T02:00:00.000Z");

    const crossed = shouldReminderOffsetFireForTest({
      nowMs: endMs - 30 * 60 * 1000,
      intervalMs: 60_000,
      eventEndsAtMs: endMs,
      offsetSeconds: 30 * 60,
    });
    const lateFire = shouldReminderOffsetFireForTest({
      nowMs: endMs - 5 * 60 * 1000,
      intervalMs: 60_000,
      eventEndsAtMs: endMs,
      offsetSeconds: 30 * 60,
    });
    const expired = shouldReminderOffsetFireForTest({
      nowMs: endMs + 1,
      intervalMs: 60_000,
      eventEndsAtMs: endMs,
      offsetSeconds: 30 * 60,
    });

    expect(crossed).toBe(true);
    expect(lateFire).toBe(true);
    expect(expired).toBe(false);
  });

  it("dedupes multi-offset deliveries per event and resets eligibility when event identity changes", async () => {
    const nowMs = Date.parse("2026-04-05T00:00:00.000Z");
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-raids",
        guildId: "guild-1",
        channelId: "channel-raids",
        type: ReminderType.RAIDS,
        isEnabled: true,
        times: [{ offsetSeconds: 60 * 60 }, { offsetSeconds: 30 * 60 }],
        targetClans: [{ clanTag: "#QGRJ2222", clanType: "FWA" }],
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#QGRJ2222", name: "Raid Clan 1" }]);
    setTodoSnapshotRows({
      timedRows: [
        {
          clanTag: "#QGRJ2222",
          clanName: "Raid Clan 1",
          cwlClanTag: null,
          cwlClanName: null,
          raidActive: true,
          raidEndsAt: new Date(nowMs + 20 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
      ],
    });
    prismaMock.reminderFireLog.create
      .mockResolvedValueOnce({ id: "fire-1" })
      .mockResolvedValueOnce({ id: "fire-2" })
      .mockRejectedValueOnce({ code: "P2002" })
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({ id: "fire-3" })
      .mockResolvedValueOnce({ id: "fire-4" });
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "msg-1",
      }),
    };

    const first = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });
    const second = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    setTodoSnapshotRows({
      timedRows: [
        {
          clanTag: "#QGRJ2222",
          clanName: "Raid Clan 1",
          cwlClanTag: null,
          cwlClanName: null,
          raidActive: true,
          raidEndsAt: new Date(nowMs + 7 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs + 7 * 24 * 60 * 60 * 1000),
        },
      ],
    });
    const third = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs: nowMs + 7 * 24 * 60 * 60 * 1000,
      intervalMs: 60_000,
    });

    expect(first).toEqual({
      evaluated: 2,
      fired: 2,
      deduped: 0,
      failed: 0,
    });
    expect(second).toEqual({
      evaluated: 2,
      fired: 0,
      deduped: 2,
      failed: 0,
    });
    expect(third).toEqual({
      evaluated: 2,
      fired: 2,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(4);
  });

  it("keeps deduped counts but does not emit per-item dedupe log spam by default", async () => {
    const nowMs = Date.parse("2026-04-05T00:00:00.000Z");
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-raids",
        guildId: "guild-1",
        channelId: "channel-raids",
        type: ReminderType.RAIDS,
        isEnabled: true,
        times: [{ offsetSeconds: 60 * 60 }],
        targetClans: [{ clanTag: "#QGRJ2222", clanType: "FWA" }],
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#QGRJ2222", name: "Raid Clan 1" }]);
    setTodoSnapshotRows({
      timedRows: [
        {
          clanTag: "#QGRJ2222",
          clanName: "Raid Clan 1",
          cwlClanTag: null,
          cwlClanName: null,
          raidActive: true,
          raidEndsAt: new Date(nowMs + 20 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
      ],
    });
    prismaMock.reminderFireLog.create.mockRejectedValue({ code: "P2002" });
    const dispatch = {
      dispatchReminder: vi.fn(),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const counts = await runReminderSchedulerCycle({
      client: {} as any,
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
    expect(
      logSpy.mock.calls.some(([message]) =>
        String(message).includes("[reminders] deduped reminder_id="),
      ),
    ).toBe(false);
  });

  it("does not duplicate sends after disable/re-enable within the same event identity", async () => {
    const nowMs = Date.parse("2026-04-05T00:00:00.000Z");
    prismaMock.reminder.findMany
      .mockResolvedValueOnce([
        {
          id: "rem-raids",
          guildId: "guild-1",
          channelId: "channel-raids",
          type: ReminderType.RAIDS,
          isEnabled: true,
          times: [{ offsetSeconds: 60 * 60 }],
          targetClans: [{ clanTag: "#QGRJ2222", clanType: "FWA" }],
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "rem-raids",
          guildId: "guild-1",
          channelId: "channel-raids",
          type: ReminderType.RAIDS,
          isEnabled: true,
          times: [{ offsetSeconds: 60 * 60 }],
          targetClans: [{ clanTag: "#QGRJ2222", clanType: "FWA" }],
        },
      ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#QGRJ2222", name: "Raid Clan 1" }]);
    setTodoSnapshotRows({
      timedRows: [
        {
          clanTag: "#QGRJ2222",
          clanName: "Raid Clan 1",
          cwlClanTag: null,
          cwlClanName: null,
          raidActive: true,
          raidEndsAt: new Date(nowMs + 20 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
      ],
    });
    prismaMock.reminderFireLog.create
      .mockResolvedValueOnce({ id: "fire-1" })
      .mockRejectedValueOnce({ code: "P2002" });
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "msg-1",
      }),
    };

    const first = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });
    const disabledCycle = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });
    const reEnabled = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(first).toEqual({
      evaluated: 1,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(disabledCycle).toEqual({
      evaluated: 0,
      fired: 0,
      deduped: 0,
      failed: 0,
    });
    expect(reEnabled).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
  });
});
