import { describe, expect, it, vi } from "vitest";
import {
  UserActivityReminderMethod,
  UserActivityReminderType,
} from "@prisma/client";

import {
  UserActivityReminderDispatchService,
  buildUserActivityReminderContentsForTest,
} from "../src/services/remindme/UserActivityReminderDispatchService";

describe("UserActivityReminderDispatchService", () => {
  it("builds plain-text ping-here content with the mention inline", () => {
    const contents = buildUserActivityReminderContentsForTest({
      discordUserId: "111111111111111111",
      method: UserActivityReminderMethod.PING_HERE,
      surfaceChannelId: "channel-1",
      reminderType: UserActivityReminderType.WAR,
      playerTag: "#P1111111",
      playerName: "Player One",
      clanName: "War Clan",
      eventInstanceKey: "WAR:#PYLQ0289:war-id:991",
      eventEndsAt: new Date("2026-03-27T12:30:00.000Z"),
      offsetMinutes: 60,
    });

    expect(contents).toHaveLength(1);
    expect(contents[0].split("\n")[0]).toBe(
      "### <@111111111111111111> Activity Reminder - WAR",
    );
    expect(contents[0]).toContain("Player: Player One (#P1111111)");
    expect(contents[0]).toContain("Clan: War Clan");
  });

  it("sends ping-here reminders as plain text without embeds", async () => {
    const send = vi.fn().mockResolvedValue({ id: "message-1" });
    const service = new UserActivityReminderDispatchService();
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          send,
        }),
      },
    } as any;

    const result = await service.dispatchReminder(client, {
      discordUserId: "111111111111111111",
      method: UserActivityReminderMethod.PING_HERE,
      surfaceChannelId: "channel-1",
      reminderType: UserActivityReminderType.RAIDS,
      playerTag: "#P3333333",
      playerName: "Player Three",
      clanName: "Raid Clan",
      eventInstanceKey: "RAIDS:#2QG2C08UP:1774614600000",
      eventEndsAt: new Date("2026-03-27T12:30:00.000Z"),
      offsetMinutes: 60,
    });

    expect(result).toEqual({
      status: "sent",
      messageId: "message-1",
      deliverySurface: "CHANNEL:channel-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining(
        "### <@111111111111111111> Activity Reminder - RAIDS",
      ),
      allowedMentions: {
        users: ["111111111111111111"],
      },
    });
    expect(send.mock.calls[0][0]).not.toHaveProperty("embeds");
  });

  it("sends DM reminders as plain text without embeds", async () => {
    const send = vi.fn().mockResolvedValue({ id: "dm-message-1" });
    const service = new UserActivityReminderDispatchService();
    const client = {
      users: {
        fetch: vi.fn().mockResolvedValue({
          createDM: vi.fn().mockResolvedValue({
            id: "dm-1",
            send,
          }),
        }),
      },
    } as any;

    const result = await service.dispatchReminder(client, {
      discordUserId: "111111111111111111",
      method: UserActivityReminderMethod.DM,
      surfaceChannelId: null,
      reminderType: UserActivityReminderType.GAMES,
      playerTag: "#P4444444",
      playerName: "Player Four",
      clanName: "Games Clan",
      eventInstanceKey: "GAMES:#P2YLC8R0:cycle-2026-03",
      eventEndsAt: new Date("2026-03-27T12:30:00.000Z"),
      offsetMinutes: 60,
    });

    expect(result).toEqual({
      status: "sent",
      messageId: "dm-message-1",
      deliverySurface: "DM:dm-1",
    });
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("### Activity Reminder - GAMES"),
    });
    expect(send.mock.calls[0][0]).not.toHaveProperty("embeds");
  });
});
