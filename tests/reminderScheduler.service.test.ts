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
        endTime: new Date(nowMs + 60 * 60 * 1000),
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
          raidEndsAt: new Date(nowMs + 60 * 60 * 1000),
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
          raidEndsAt: new Date(nowMs + 60 * 60 * 1000),
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
          gamesEndsAt: new Date(nowMs + 60 * 60 * 1000),
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

  it("fires a 24h WAR_CWL reminder when the scheduler lands shortly after battle day start", () => {
    const eventEndsAtMs = Date.parse("2026-04-06T00:00:00.000Z");
    const battleDayStartMs = eventEndsAtMs - 24 * 60 * 60 * 1000;

    const slightlyLate = shouldReminderOffsetFireForTest({
      nowMs: battleDayStartMs + 90_000,
      intervalMs: 60_000,
      eventEndsAtMs,
      offsetSeconds: 24 * 60 * 60,
      reminderCreatedAtMs: battleDayStartMs - 10 * 60 * 1000,
    });
    const tooLate = shouldReminderOffsetFireForTest({
      nowMs: battleDayStartMs + 3 * 60 * 1000,
      intervalMs: 60_000,
      eventEndsAtMs,
      offsetSeconds: 24 * 60 * 60,
      reminderCreatedAtMs: battleDayStartMs - 10 * 60 * 1000,
    });
    const expired = shouldReminderOffsetFireForTest({
      nowMs: eventEndsAtMs + 1,
      intervalMs: 60_000,
      eventEndsAtMs,
      offsetSeconds: 24 * 60 * 60,
      reminderCreatedAtMs: battleDayStartMs - 10 * 60 * 1000,
    });

    expect(slightlyLate).toBe(true);
    expect(tooLate).toBe(false);
    expect(expired).toBe(false);
  });

  it("does not fire after the bounded grace window has passed", () => {
    const eventEndsAtMs = Date.parse("2026-04-05T02:00:00.000Z");

    const withinGrace = shouldReminderOffsetFireForTest({
      nowMs: eventEndsAtMs - 30 * 60 * 1000 + 90_000,
      intervalMs: 60_000,
      eventEndsAtMs,
      offsetSeconds: 30 * 60,
      reminderCreatedAtMs: eventEndsAtMs - 60 * 60 * 1000,
    });
    const beyondGrace = shouldReminderOffsetFireForTest({
      nowMs: eventEndsAtMs - 30 * 60 * 1000 + 3 * 60 * 1000,
      intervalMs: 60_000,
      eventEndsAtMs,
      offsetSeconds: 30 * 60,
      reminderCreatedAtMs: eventEndsAtMs - 60 * 60 * 1000,
    });

    expect(withinGrace).toBe(true);
    expect(beyondGrace).toBe(false);
  });

  it("does not backfill a reminder that was created after the trigger time", () => {
    const eventEndsAtMs = Date.parse("2026-04-06T00:00:00.000Z");
    const battleDayStartMs = eventEndsAtMs - 24 * 60 * 60 * 1000;
    const reminderCreatedAtMs = battleDayStartMs + 30_000;

    const backfillBlocked = shouldReminderOffsetFireForTest({
      nowMs: battleDayStartMs + 90_000,
      intervalMs: 60_000,
      eventEndsAtMs,
      offsetSeconds: 24 * 60 * 60,
      reminderCreatedAtMs,
    });

    expect(backfillBlocked).toBe(false);
  });

  it("skips already-missed offsets for a newly created active-war reminder", async () => {
    const nowMs = Date.parse("2026-04-05T01:00:00.000Z");
    const eventEndsAtMs = nowMs + 60 * 60 * 1000;
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-war",
        guildId: "guild-1",
        channelId: "channel-war",
        type: ReminderType.WAR_CWL,
        isEnabled: true,
        times: [
          { offsetSeconds: 24 * 60 * 60 },
          { offsetSeconds: 12 * 60 * 60 },
          { offsetSeconds: 6 * 60 * 60 },
          { offsetSeconds: 60 * 60 },
        ],
        targetClans: [{ clanTag: "#PYLQ0289", clanType: "FWA" }],
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        clanName: "War Clan",
        warId: 903,
        state: "inWar",
        startTime: new Date(nowMs - 23 * 60 * 60 * 1000),
        endTime: new Date(eventEndsAtMs),
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289", name: "War Clan" }]);
    prismaMock.reminderFireLog.create.mockImplementation(async ({ data }: any) => ({
      id: `fire-${String(data?.offsetSeconds ?? "x")}`,
    }));
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "msg-1",
      }),
    };

    const firstCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(firstCounts).toEqual({
      evaluated: 4,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
    expect(dispatch.dispatchReminder.mock.calls.map(([, payload]) => payload.offsetSeconds)).toEqual([60 * 60]);
  });

  it("fires a future offset when the scheduler crosses its boundary later", async () => {
    const nowMs = Date.parse("2026-04-05T01:00:00.000Z");
    const eventEndsAtMs = nowMs + 2 * 60 * 60 * 1000;
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-war",
        guildId: "guild-1",
        channelId: "channel-war",
        type: ReminderType.WAR_CWL,
        isEnabled: true,
        times: [
          { offsetSeconds: 24 * 60 * 60 },
          { offsetSeconds: 60 * 60 },
        ],
        targetClans: [{ clanTag: "#PYLQ0289", clanType: "FWA" }],
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        clanName: "War Clan",
        warId: 904,
        state: "inWar",
        startTime: new Date(nowMs - 22 * 60 * 60 * 1000),
        endTime: new Date(eventEndsAtMs),
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289", name: "War Clan" }]);
    prismaMock.reminderFireLog.create.mockImplementation(async ({ data }: any) => ({
      id: `fire-${String(data?.offsetSeconds ?? "x")}`,
    }));
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "msg-1",
      }),
    };

    const initialCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });
    const laterCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs: nowMs + 60 * 60 * 1000 + 30 * 1000,
      intervalMs: 60_000,
    });

    expect(initialCounts).toEqual({
      evaluated: 2,
      fired: 0,
      deduped: 0,
      failed: 0,
    });
    expect(laterCounts).toEqual({
      evaluated: 2,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
    expect(dispatch.dispatchReminder.mock.calls[0]?.[1]?.offsetSeconds).toBe(60 * 60);
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
          raidEndsAt: new Date(nowMs + 60 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
      ],
    });
    prismaMock.reminderFireLog.create.mockReset();
    let fireLogCreateCount = 0;
    prismaMock.reminderFireLog.create.mockImplementation(async () => {
      fireLogCreateCount += 1;
      if (fireLogCreateCount === 1 || fireLogCreateCount === 3) {
        return { id: `fire-${fireLogCreateCount}` };
      }
      throw { code: "P2002" };
    });
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
          raidEndsAt: new Date(nowMs + 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000),
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
      evaluated: 1,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(second).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(third).toEqual({
      evaluated: 1,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(2);
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
          raidEndsAt: new Date(nowMs + 60 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
      ],
    });
    prismaMock.reminderFireLog.create.mockReset();
    prismaMock.reminderFireLog.create.mockImplementation(async () => {
      throw { code: "P2002" };
    });
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
          raidEndsAt: new Date(nowMs + 60 * 60 * 1000),
          gamesActive: false,
          gamesEndsAt: null,
          updatedAt: new Date(nowMs),
        },
      ],
    });
    prismaMock.reminderFireLog.create.mockReset();
    let fireLogCreateCount = 0;
    prismaMock.reminderFireLog.create.mockImplementation(async () => {
      fireLogCreateCount += 1;
      if (fireLogCreateCount === 1) {
        return { id: "fire-1" };
      }
      throw { code: "P2002" };
    });
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
