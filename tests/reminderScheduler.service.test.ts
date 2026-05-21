import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderDispatchStatus, ReminderType } from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  reminder: {
    findMany: vi.fn(),
  },
  reminderFireLog: {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  maintenanceWindowRuntimeState: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
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
  ReminderSchedulerService,
  fireBattleDayTransitionWar24hRemindersForClan,
  runReminderSchedulerCycle,
  resetReminderRetryWindowExpiredLogStateForTest,
  shouldReminderOffsetFireForTest,
  shouldLogReminderRetryWindowExpiredForTest,
} from "../src/services/reminders/ReminderSchedulerService";
import { dozzleConsoleSink } from "../src/helper/dozzleLogger";

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
    prismaMock.reminderFireLog.findUnique.mockResolvedValue(null);
    prismaMock.reminderFireLog.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.reminderFireLog.update.mockResolvedValue({});
    prismaMock.maintenanceWindowRuntimeState.findUnique.mockResolvedValue(null);
    prismaMock.maintenanceWindowRuntimeState.upsert.mockResolvedValue({});
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

  it("fires the latest missed offset first and later fires the next offset when it becomes due", async () => {
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
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(laterCounts).toEqual({
      evaluated: 2,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(2);
    expect(dispatch.dispatchReminder.mock.calls.map(([, payload]) => payload.offsetSeconds)).toEqual([
      24 * 60 * 60,
      60 * 60,
    ]);
  });

  it("skips a catch-up reminder when the latest missed offset is already logged", async () => {
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
        warId: 905,
        state: "inWar",
        startTime: new Date(nowMs - 22 * 60 * 60 * 1000),
        endTime: new Date(eventEndsAtMs),
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289", name: "War Clan" }]);
    prismaMock.reminderFireLog.findUnique.mockResolvedValue({
      id: "fire-existing",
      dispatchStatus: ReminderDispatchStatus.SENT,
      errorMessage: null,
    });
    const dispatch = {
      dispatchReminder: vi.fn(),
    };
    const logSpy = vi.spyOn(dozzleConsoleSink, "info").mockImplementation(() => undefined);

    const counts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(counts).toEqual({
      evaluated: 2,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some(([message]) =>
        String(message).includes("catchup_skip reason=already_fired"),
      ),
    ).toBe(true);
  });

  it("logs a stale no-active-event skip during catch-up", async () => {
    const nowMs = Date.parse("2026-04-05T01:00:00.000Z");
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
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        clanName: "War Clan",
        warId: 906,
        state: "preparation",
        startTime: new Date(nowMs + 30 * 60 * 1000),
        endTime: new Date(nowMs - 10 * 60 * 1000),
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289", name: "War Clan" }]);
    const dispatch = {
      dispatchReminder: vi.fn(),
    };
    const logSpy = vi.spyOn(dozzleConsoleSink, "info").mockImplementation(() => undefined);

    const counts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    expect(counts).toEqual({
      evaluated: 0,
      fired: 0,
      deduped: 0,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).not.toHaveBeenCalled();
    expect(
      logSpy.mock.calls.some(([message]) =>
        String(message).includes("catchup_skip reason=stale_no_active_event"),
      ),
    ).toBe(true);
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
    const logSpy = vi.spyOn(dozzleConsoleSink, "info").mockImplementation(() => undefined);

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

describe("ReminderSchedulerService startup logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const flushEventLoop = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  it("logs startup and registers the scheduler timer", () => {
    const scheduler = new ReminderSchedulerService({} as any, { dispatchReminder: vi.fn() } as any, 12_345);
    const runCycleSpy = vi.spyOn(scheduler, "runCycle").mockResolvedValue({
      evaluated: 0,
      fired: 0,
      deduped: 0,
      failed: 0,
    });
    const logSpy = vi.spyOn(dozzleConsoleSink, "info").mockImplementation(() => undefined);
    let intervalHandler: (() => void) | null = null;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      intervalHandler = handler as () => void;
      expect(timeout).toBe(12_345);
      return 1 as any;
    }) as any);

    const result = scheduler.start();

    expect(result).toEqual({ started: true });
    expect(intervalHandler).toEqual(expect.any(Function));
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[info] [reminders] scheduler start requested interval_ms=12345 has_timer=false");
    expect(logSpy).toHaveBeenCalledWith("[info] [reminders] scheduler started interval_ms=12345");
    expect(runCycleSpy).toHaveBeenCalledTimes(1);
  });

  it("logs immediate scheduler cycle failures", async () => {
    const scheduler = new ReminderSchedulerService({} as any, { dispatchReminder: vi.fn() } as any, 12_345);
    vi.spyOn(scheduler, "runCycle").mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(dozzleConsoleSink, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      expect(timeout).toBe(12_345);
      return 1 as any;
    }) as any);

    const result = scheduler.start();

    expect(result).toEqual({ started: true });
    await flushEventLoop();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[error] [reminders] scheduler immediate_cycle_failed error="),
    );
  });

  it("logs interval scheduler cycle failures", async () => {
    const scheduler = new ReminderSchedulerService({} as any, { dispatchReminder: vi.fn() } as any, 12_345);
    const runCycleSpy = vi
      .spyOn(scheduler, "runCycle")
      .mockResolvedValueOnce({
        evaluated: 0,
        fired: 0,
        deduped: 0,
        failed: 0,
      })
      .mockRejectedValueOnce(new Error("interval boom"));
    const errorSpy = vi.spyOn(dozzleConsoleSink, "error").mockImplementation(() => undefined);
    let intervalHandler: (() => void) | null = null;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
      intervalHandler = handler as () => void;
      expect(timeout).toBe(12_345);
      return 1 as any;
    }) as any);

    const result = scheduler.start();

    expect(result).toEqual({ started: true });
    expect(intervalHandler).toEqual(expect.any(Function));
    intervalHandler?.();
    await flushEventLoop();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[error] [reminders] scheduler interval_cycle_failed error="),
    );
    expect(runCycleSpy).toHaveBeenCalledTimes(2);
  });
});

describe("ReminderSchedulerService retry-window-expired log suppression", () => {
  beforeEach(() => {
    resetReminderRetryWindowExpiredLogStateForTest();
  });

  it("logs once per reminder identity and offset", () => {
    expect(shouldLogReminderRetryWindowExpiredForTest("reminder-1|event-1|0")).toBe(true);
    expect(shouldLogReminderRetryWindowExpiredForTest("reminder-1|event-1|0")).toBe(false);
    expect(shouldLogReminderRetryWindowExpiredForTest("reminder-1|event-1|300")).toBe(true);
    expect(shouldLogReminderRetryWindowExpiredForTest("reminder-2|event-1|0")).toBe(true);
  });
});

type SchedulerFireLogRecord = {
  id: string;
  dedupeKey: string;
  dispatchStatus: ReminderDispatchStatus;
  errorMessage: string | null;
  messageId: string | null;
  dispatchedAt: Date;
};

function installReminderFireLogStore() {
  const byId = new Map<string, SchedulerFireLogRecord>();
  const byDedupeKey = new Map<string, SchedulerFireLogRecord>();
  let nextId = 1;

  prismaMock.reminderFireLog.create.mockImplementation(async ({ data }: any) => {
    const dedupeKey = String(data?.dedupeKey ?? "");
    if (byDedupeKey.has(dedupeKey)) {
      throw { code: "P2002" };
    }
    const record: SchedulerFireLogRecord = {
      id: `fire-${nextId++}`,
      dedupeKey,
      dispatchStatus: ReminderDispatchStatus.FAILED,
      errorMessage: null,
      messageId: null,
      dispatchedAt: new Date(),
    };
    byId.set(record.id, record);
    byDedupeKey.set(record.dedupeKey, record);
    return { id: record.id };
  });
  prismaMock.reminderFireLog.findUnique.mockImplementation(async ({ where }: any) => {
    const record = byDedupeKey.get(String(where?.dedupeKey ?? ""));
    if (!record) return null;
    return {
      id: record.id,
      dispatchStatus: record.dispatchStatus,
      errorMessage: record.errorMessage,
    };
  });
  prismaMock.reminderFireLog.updateMany.mockImplementation(async ({ where, data }: any) => {
    const record = byId.get(String(where?.id ?? ""));
    if (
      !record ||
      String(where?.dedupeKey ?? "") !== record.dedupeKey ||
      String(where?.dispatchStatus ?? "") !== record.dispatchStatus ||
      String(where?.errorMessage ?? "") !== String(record.errorMessage ?? "")
    ) {
      return { count: 0 };
    }
    if (Object.prototype.hasOwnProperty.call(data ?? {}, "errorMessage")) {
      record.errorMessage = data.errorMessage ?? null;
    }
    return { count: 1 };
  });
  prismaMock.reminderFireLog.update.mockImplementation(async ({ where, data }: any) => {
    const record = byId.get(String(where?.id ?? ""));
    if (!record) return {};
    if (Object.prototype.hasOwnProperty.call(data ?? {}, "dispatchStatus")) {
      record.dispatchStatus = data.dispatchStatus;
    }
    if (Object.prototype.hasOwnProperty.call(data ?? {}, "errorMessage")) {
      record.errorMessage = data.errorMessage ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(data ?? {}, "messageId")) {
      record.messageId = data.messageId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(data ?? {}, "dispatchedAt")) {
      record.dispatchedAt = data.dispatchedAt ?? record.dispatchedAt;
    }
    return {};
  });

  return {
    byId,
    byDedupeKey,
  };
}

describe("ReminderSchedulerService retryable 24h WAR reminder dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.reminderFireLog.findUnique.mockResolvedValue(null);
    prismaMock.reminderFireLog.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.reminderFireLog.update.mockResolvedValue({});
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    setTodoSnapshotRows({});
  });

  it("retries a failed 24h WAR_CWL attack_window_not_active reminder while battle day becomes active", async () => {
    const nowMs = Date.parse("2026-04-29T13:01:38.901Z");
    const eventEndsAt = new Date(nowMs + 24 * 60 * 60 * 1000);
    const reminder = {
      id: "rem-war",
      guildId: "guild-1",
      channelId: "channel-war",
      type: ReminderType.WAR_CWL,
      isEnabled: true,
      createdAt: new Date("2026-04-28T00:00:00.000Z"),
      times: [{ offsetSeconds: 24 * 60 * 60 }],
      targetClans: [{ clanTag: "#R80L8VYG", clanType: "FWA" }],
    };
    prismaMock.reminder.findMany.mockResolvedValue([reminder]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#R80L8VYG", name: "Tracked Clan" }]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#R80L8VYG",
        clanName: "Tracked Clan",
        warId: 1000267,
        state: "preparation",
        startTime: new Date("2026-04-28T14:03:35.852Z"),
        endTime: eventEndsAt,
        updatedAt: new Date(nowMs),
      },
    ]);
    let currentWarState: "preparation" | "inWar" = "preparation";
    prismaMock.currentWar.findFirst.mockImplementation(async () => ({
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      state: currentWarState,
      startTime: new Date("2026-04-28T14:03:35.852Z"),
      endTime: eventEndsAt,
      updatedAt: new Date(nowMs),
    } as any));

    const fireLogs = installReminderFireLogStore();
    const dispatch = {
      dispatchReminder: vi
        .fn()
        .mockResolvedValueOnce({
          status: "failed",
          errorMessage: "attack_window_not_active",
        })
        .mockResolvedValueOnce({
          status: "sent",
          messageId: "msg-retry",
        }),
    };

    const firstCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });

    currentWarState = "inWar";
    const secondCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs: nowMs + 90_000,
      intervalMs: 60_000,
    });
    const thirdCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs: nowMs + 150_000,
      intervalMs: 60_000,
    });

    expect(firstCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 0,
      failed: 1,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(thirdCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(2);
    expect(prismaMock.reminderFireLog.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.reminderFireLog.updateMany).toHaveBeenCalledTimes(1);
    expect(fireLogs.byDedupeKey.size).toBe(1);
    expect(fireLogs.byId.values().next().value).toMatchObject({
      dispatchStatus: ReminderDispatchStatus.SENT,
      messageId: "msg-retry",
      errorMessage: null,
    });
  });

  it("does not retry a 12h attack_window_not_active reminder", async () => {
    const nowMs = Date.parse("2026-04-29T01:01:38.901Z");
    const eventEndsAt = new Date(nowMs + 12 * 60 * 60 * 1000);
    const reminder = {
      id: "rem-war",
      guildId: "guild-1",
      channelId: "channel-war",
      type: ReminderType.WAR_CWL,
      isEnabled: true,
      createdAt: new Date("2026-04-28T00:00:00.000Z"),
      times: [{ offsetSeconds: 12 * 60 * 60 }],
      targetClans: [{ clanTag: "#R80L8VYG", clanType: "FWA" }],
    };
    prismaMock.reminder.findMany.mockResolvedValue([reminder]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#R80L8VYG", name: "Tracked Clan" }]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#R80L8VYG",
        clanName: "Tracked Clan",
        warId: 1000268,
        state: "preparation",
        startTime: new Date("2026-04-28T14:03:35.852Z"),
        endTime: eventEndsAt,
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000268,
      state: "inWar",
      startTime: new Date("2026-04-28T14:03:35.852Z"),
      endTime: eventEndsAt,
      updatedAt: new Date(nowMs),
    });
    installReminderFireLogStore();
    const dispatch = {
      dispatchReminder: vi
        .fn()
        .mockResolvedValueOnce({
          status: "failed",
          errorMessage: "attack_window_not_active",
        })
        .mockResolvedValueOnce({
          status: "sent",
          messageId: "msg-should-not-send",
        }),
    };

    const firstCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });
    const secondCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs: nowMs + 90_000,
      intervalMs: 60_000,
    });

    expect(firstCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 0,
      failed: 1,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
  });

  it("does not retry a channel failure for a 24h WAR_CWL reminder", async () => {
    const nowMs = Date.parse("2026-04-29T13:01:38.901Z");
    const eventEndsAt = new Date(nowMs + 24 * 60 * 60 * 1000);
    const reminder = {
      id: "rem-war",
      guildId: "guild-1",
      channelId: "channel-war",
      type: ReminderType.WAR_CWL,
      isEnabled: true,
      createdAt: new Date("2026-04-28T00:00:00.000Z"),
      times: [{ offsetSeconds: 24 * 60 * 60 }],
      targetClans: [{ clanTag: "#R80L8VYG", clanType: "FWA" }],
    };
    prismaMock.reminder.findMany.mockResolvedValue([reminder]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#R80L8VYG", name: "Tracked Clan" }]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#R80L8VYG",
        clanName: "Tracked Clan",
        warId: 1000267,
        state: "preparation",
        startTime: new Date("2026-04-28T14:03:35.852Z"),
        endTime: eventEndsAt,
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      state: "inWar",
      startTime: new Date("2026-04-28T14:03:35.852Z"),
      endTime: eventEndsAt,
      updatedAt: new Date(nowMs),
    });
    installReminderFireLogStore();
    const dispatch = {
      dispatchReminder: vi
        .fn()
        .mockResolvedValueOnce({
          status: "failed",
          errorMessage: "channel_unavailable_or_not_text_based",
        })
        .mockResolvedValueOnce({
          status: "sent",
          messageId: "msg-should-not-send",
        }),
    };

    const firstCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });
    const secondCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs: nowMs + 90_000,
      intervalMs: 60_000,
    });

    expect(firstCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 0,
      failed: 1,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
  });

  it("stops retrying a 24h WAR_CWL attack_window_not_active reminder after the retry window expires", async () => {
    const nowMs = Date.parse("2026-04-29T13:01:38.901Z");
    const eventEndsAt = new Date(nowMs + 24 * 60 * 60 * 1000);
    const reminder = {
      id: "rem-war",
      guildId: "guild-1",
      channelId: "channel-war",
      type: ReminderType.WAR_CWL,
      isEnabled: true,
      createdAt: new Date("2026-04-28T00:00:00.000Z"),
      times: [{ offsetSeconds: 24 * 60 * 60 }],
      targetClans: [{ clanTag: "#R80L8VYG", clanType: "FWA" }],
    };
    prismaMock.reminder.findMany.mockResolvedValue([reminder]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#R80L8VYG", name: "Tracked Clan" }]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#R80L8VYG",
        clanName: "Tracked Clan",
        warId: 1000267,
        state: "preparation",
        startTime: new Date("2026-04-28T14:03:35.852Z"),
        endTime: eventEndsAt,
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      state: "inWar",
      startTime: new Date("2026-04-28T14:03:35.852Z"),
      endTime: eventEndsAt,
      updatedAt: new Date(nowMs),
    });
    const fireLogs = installReminderFireLogStore();
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "failed",
        errorMessage: "attack_window_not_active",
      }),
    };

    const firstCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs,
      intervalMs: 60_000,
    });
    const secondCounts = await runReminderSchedulerCycle({
      client: {} as any,
      dispatch: dispatch as any,
      nowMs: nowMs + 16 * 60 * 1000,
      intervalMs: 60_000,
    });

    expect(firstCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 0,
      failed: 1,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
    expect(fireLogs.byId.values().next().value).toMatchObject({
      dispatchStatus: ReminderDispatchStatus.FAILED,
      errorMessage: "attack_window_not_active",
    });
  });
});

describe("ReminderSchedulerService battle-day transition trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.reminder.findMany.mockResolvedValue([]);
    prismaMock.reminderFireLog.findUnique.mockResolvedValue(null);
    prismaMock.reminderFireLog.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.reminderFireLog.update.mockResolvedValue({});
    prismaMock.maintenanceWindowRuntimeState.findUnique.mockResolvedValue(null);
    prismaMock.maintenanceWindowRuntimeState.upsert.mockResolvedValue({});
    prismaMock.currentWar.findFirst.mockResolvedValue(null);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    setTodoSnapshotRows({});
  });

  it("defers a 24h WAR_CWL reminder while maintenance is active and still sends once after maintenance over", async () => {
    const nowMs = Date.parse("2026-04-29T13:01:38.901Z");
    const battleDayStartMs = nowMs - 20 * 60 * 1000;
    const eventEndsAt = new Date(nowMs + 23 * 60 * 60 * 1000 + 40 * 60 * 1000);
    const warStartTime = new Date(battleDayStartMs - 6 * 60 * 60 * 1000);
    const reminder = {
      id: "rem-war-transition-maintenance",
      guildId: "guild-1",
      channelId: "channel-war",
      type: ReminderType.WAR_CWL,
      isEnabled: true,
      createdAt: new Date("2026-04-28T00:00:00.000Z"),
      times: [{ offsetSeconds: 24 * 60 * 60 }],
      targetClans: [{ clanTag: "#R80L8VYG", clanType: "FWA" }],
    };
    prismaMock.reminder.findMany.mockResolvedValue([reminder]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      state: "inWar",
      startTime: warStartTime,
      endTime: eventEndsAt,
      updatedAt: new Date(nowMs),
    });

    const fireLogs = installReminderFireLogStore();
    const dedupeKey =
      "rem-war-transition-maintenance|FWA|#R80L8VYG|WAR:war-id:1000267|86400";
    const seedRecord: SchedulerFireLogRecord = {
      id: "fire-seeded-maintenance",
      dedupeKey,
      dispatchStatus: ReminderDispatchStatus.FAILED,
      errorMessage: "attack_window_not_active",
      messageId: null,
      dispatchedAt: new Date(nowMs - 30 * 60 * 1000),
    };
    fireLogs.byId.set(seedRecord.id, seedRecord);
    fireLogs.byDedupeKey.set(dedupeKey, seedRecord);

    const maintenanceRow = {
      guildId: "guild-1",
      active: true,
      detectedAt: new Date(nowMs - 35 * 60 * 1000),
      lastObservedAt: new Date(nowMs - 10 * 60 * 1000),
      lastOverAt: null,
      detectedClanTag: "#R80L8VYG",
      detectedStatusCode: 503,
      lastChannelId: "maintenance-channel",
      lastChannelSource: "maintenance" as const,
      createdAt: new Date(nowMs - 35 * 60 * 1000),
      updatedAt: new Date(nowMs - 10 * 60 * 1000),
    };
    let maintenanceActive = true;
    prismaMock.maintenanceWindowRuntimeState.findUnique.mockImplementation(async () =>
      maintenanceActive ? maintenanceRow : null,
    );

    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "msg-retry",
      }),
    };
    const warnSpy = vi.spyOn(dozzleConsoleSink, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(dozzleConsoleSink, "error").mockImplementation(() => undefined);

    const firstCounts = await fireBattleDayTransitionWar24hRemindersForClan({
      client: {} as any,
      dispatch: dispatch as any,
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      warStartTime,
      warEndTime: eventEndsAt,
      nowMs,
    });

    maintenanceActive = false;
    const secondCounts = await fireBattleDayTransitionWar24hRemindersForClan({
      client: {} as any,
      dispatch: dispatch as any,
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      warStartTime,
      warEndTime: eventEndsAt,
      nowMs: nowMs + 20 * 60_000,
      triggerSource: "maintenance_over",
    });

    const thirdCounts = await fireBattleDayTransitionWar24hRemindersForClan({
      client: {} as any,
      dispatch: dispatch as any,
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      warStartTime,
      warEndTime: eventEndsAt,
      nowMs: nowMs + 21 * 60_000,
      triggerSource: "maintenance_over",
    });

    expect(firstCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 0,
      failed: 0,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(thirdCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("event=skipped_maintenance_active"),
      ),
    ).toBe(true);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("reason=persisted_maintenance_active"),
      ),
    ).toBe(true);
    expect(errorSpy.mock.calls.some(([message]) => String(message).includes("event=failed"))).toBe(
      false,
    );
    expect(fireLogs.byId.get("fire-seeded-maintenance")?.dispatchStatus).toBe(
      ReminderDispatchStatus.SENT,
    );
    expect(fireLogs.byId.get("fire-seeded-maintenance")?.messageId).toBe("msg-retry");
  });

  it("re-fires a 24h WAR_CWL reminder after maintenance clears and dedupes once sent", async () => {
    const nowMs = Date.parse("2026-04-29T13:01:38.901Z");
    const battleDayStartMs = nowMs - 10 * 60 * 1000;
    const eventEndsAt = new Date(nowMs + 23 * 60 * 60 * 1000 + 50 * 60 * 1000);
    const warStartTime = new Date(battleDayStartMs - 6 * 60 * 60 * 1000);
    const reminder = {
      id: "rem-war-transition",
      guildId: "guild-1",
      channelId: "channel-war",
      type: ReminderType.WAR_CWL,
      isEnabled: true,
      createdAt: new Date("2026-04-28T00:00:00.000Z"),
      times: [{ offsetSeconds: 24 * 60 * 60 }],
      targetClans: [{ clanTag: "#R80L8VYG", clanType: "FWA" }],
    };
    prismaMock.reminder.findMany.mockResolvedValue([reminder]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      state: "inWar",
      startTime: warStartTime,
      endTime: eventEndsAt,
      updatedAt: new Date(nowMs),
    });

    const fireLogs = installReminderFireLogStore();
    const dedupeKey = "rem-war-transition|FWA|#R80L8VYG|WAR:war-id:1000267|86400";
    const seedRecord: SchedulerFireLogRecord = {
      id: "fire-seeded",
      dedupeKey,
      dispatchStatus: ReminderDispatchStatus.FAILED,
      errorMessage: "attack_window_not_active",
      messageId: null,
      dispatchedAt: new Date(nowMs - 30 * 60 * 1000),
    };
    fireLogs.byId.set(seedRecord.id, seedRecord);
    fireLogs.byDedupeKey.set(dedupeKey, seedRecord);

    const dispatch = {
      dispatchReminder: vi
        .fn()
        .mockResolvedValueOnce({
          status: "failed",
          errorMessage: "attack_window_not_active",
        })
        .mockResolvedValueOnce({
          status: "sent",
          messageId: "msg-retry",
        }),
    };
    const infoSpy = vi.spyOn(dozzleConsoleSink, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(dozzleConsoleSink, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(dozzleConsoleSink, "error").mockImplementation(() => undefined);

    const firstCounts = await fireBattleDayTransitionWar24hRemindersForClan({
      client: {} as any,
      dispatch: dispatch as any,
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      warStartTime,
      warEndTime: eventEndsAt,
      nowMs,
    });
    const secondCounts = await fireBattleDayTransitionWar24hRemindersForClan({
      client: {} as any,
      dispatch: dispatch as any,
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      warStartTime,
      warEndTime: eventEndsAt,
      nowMs: nowMs + 3 * 60_000,
    });
    const thirdCounts = await fireBattleDayTransitionWar24hRemindersForClan({
      client: {} as any,
      dispatch: dispatch as any,
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      warStartTime,
      warEndTime: eventEndsAt,
      nowMs: nowMs + 4 * 60_000,
    });

    expect(firstCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 0,
      failed: 1,
    });
    expect(secondCounts).toEqual({
      evaluated: 1,
      fired: 1,
      deduped: 0,
      failed: 0,
    });
    expect(thirdCounts).toEqual({
      evaluated: 1,
      fired: 0,
      deduped: 1,
      failed: 0,
    });
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(2);
    expect(
      infoSpy.mock.calls.some(([message]) =>
        String(message).includes("event=transition_triggered"),
      ),
    ).toBe(true);
    expect(
      infoSpy.mock.calls.some(([message]) =>
        String(message).includes("event=sent"),
      ),
    ).toBe(true);
    expect(
      infoSpy.mock.calls.some(([message]) =>
        String(message).includes("event=deduped"),
      ),
    ).toBe(true);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("event=skipped_maintenance_active"),
      ),
    ).toBe(true);
    expect(
      errorSpy.mock.calls.some(([message]) =>
        String(message).includes("event=failed"),
      ),
    ).toBe(false);
    expect(fireLogs.byId.get("fire-seeded")?.dispatchStatus).toBe(
      ReminderDispatchStatus.SENT,
    );
    expect(fireLogs.byId.get("fire-seeded")?.messageId).toBe("msg-retry");
  });

  it("logs skipped_no_reminder when no 24h reminder exists", async () => {
    const nowMs = Date.parse("2026-04-29T13:01:38.901Z");
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-war-short",
        guildId: "guild-1",
        channelId: "channel-war",
        type: ReminderType.WAR_CWL,
        isEnabled: true,
        createdAt: new Date("2026-04-28T00:00:00.000Z"),
        times: [{ offsetSeconds: 60 * 60 }],
        targetClans: [{ clanTag: "#R80L8VYG", clanType: "FWA" }],
      },
    ]);
    prismaMock.currentWar.findFirst.mockResolvedValue({
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      state: "inWar",
      startTime: new Date("2026-04-28T14:03:35.852Z"),
      endTime: new Date(nowMs + 60 * 60 * 1000),
      updatedAt: new Date(nowMs),
    });
    const infoSpy = vi.spyOn(dozzleConsoleSink, "info").mockImplementation(() => undefined);

    const counts = await fireBattleDayTransitionWar24hRemindersForClan({
      client: {} as any,
      guildId: "guild-1",
      clanTag: "#R80L8VYG",
      clanName: "Tracked Clan",
      warId: 1000267,
      warStartTime: new Date("2026-04-28T14:03:35.852Z"),
      warEndTime: new Date(nowMs + 60 * 60 * 1000),
      nowMs,
    });

    expect(counts).toEqual({
      evaluated: 0,
      fired: 0,
      deduped: 0,
      failed: 0,
    });
    expect(
      infoSpy.mock.calls.some(([message]) =>
        String(message).includes("event=skipped_no_reminder"),
      ),
    ).toBe(true);
  });
});
