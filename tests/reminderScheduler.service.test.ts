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
  resolveCurrentCwlSeasonKey: vi.fn(() => "2026-03"),
}));

import { runReminderSchedulerCycle } from "../src/services/reminders/ReminderSchedulerService";

describe("ReminderSchedulerService cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.reminderFireLog.update.mockResolvedValue({});
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.todoPlayerSnapshot.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
  });

  it("evaluates and fires due reminders across WAR_CWL, RAIDS, GAMES, and EVENT types", async () => {
    const nowMs = Date.parse("2026-03-27T08:00:00.000Z");
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-war",
        guildId: "guild-1",
        channelId: "channel-1",
        type: ReminderType.WAR_CWL,
        isEnabled: true,
        times: [{ offsetSeconds: 3600 }],
        targetClans: [{ clanTag: "#WAR1", clanType: "FWA" }],
      },
      {
        id: "rem-raids",
        guildId: "guild-1",
        channelId: "channel-2",
        type: ReminderType.RAIDS,
        isEnabled: true,
        times: [{ offsetSeconds: 288000 }],
        targetClans: [{ clanTag: "#RAID1", clanType: "FWA" }],
      },
      {
        id: "rem-games",
        guildId: "guild-1",
        channelId: "channel-3",
        type: ReminderType.GAMES,
        isEnabled: true,
        times: [{ offsetSeconds: 108000 }],
        targetClans: [{ clanTag: "#GAME1", clanType: "FWA" }],
      },
      {
        id: "rem-event",
        guildId: "guild-1",
        channelId: "channel-4",
        type: ReminderType.EVENT,
        isEnabled: true,
        times: [{ offsetSeconds: 604800 }],
        targetClans: [{ clanTag: "#EVENT1", clanType: "CWL" }],
      },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#WAR1",
        clanName: "War Clan",
        state: "inWar",
        startTime: new Date(nowMs - 3 * 60 * 60 * 1000),
        endTime: new Date(nowMs + 30 * 60 * 1000),
        updatedAt: new Date(nowMs),
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#WAR1", name: "War Clan" },
      { tag: "#RAID1", name: "Raid Clan" },
      { tag: "#GAME1", name: "Games Clan" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#EVENT1", name: "Event Clan" },
    ]);
    let fireIndex = 0;
    prismaMock.reminderFireLog.create.mockImplementation(async () => {
      fireIndex += 1;
      return { id: `fire-${fireIndex}` };
    });
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "message-1",
      }),
    };

    const counts = await runReminderSchedulerCycle({
      client: {} as any,
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
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(4);
    expect(
      dispatch.dispatchReminder.mock.calls
        .map(([, payload]) => payload.type)
        .sort(),
    ).toEqual(
      [
        ReminderType.WAR_CWL,
        ReminderType.RAIDS,
        ReminderType.GAMES,
        ReminderType.EVENT,
      ].sort(),
    );
  });

  it("dedupes repeated scheduler runs for the same reminder+clan+event+offset key", async () => {
    const nowMs = Date.parse("2026-03-27T08:00:00.000Z");
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-raids",
        guildId: "guild-1",
        channelId: "channel-2",
        type: ReminderType.RAIDS,
        isEnabled: true,
        times: [{ offsetSeconds: 288000 }],
        targetClans: [{ clanTag: "#RAID1", clanType: "FWA" }],
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#RAID1", name: "Raid Clan" }]);
    prismaMock.reminderFireLog.create
      .mockResolvedValueOnce({ id: "fire-1" })
      .mockRejectedValueOnce({ code: "P2002" });
    const dispatch = {
      dispatchReminder: vi.fn().mockResolvedValue({
        status: "sent",
        messageId: "message-1",
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
    expect(dispatch.dispatchReminder).toHaveBeenCalledTimes(1);
    expect(prismaMock.reminderFireLog.update).toHaveBeenCalledTimes(1);
  });
});
