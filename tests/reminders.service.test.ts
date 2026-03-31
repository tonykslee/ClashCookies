import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderTargetClanType, ReminderType } from "@prisma/client";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  reminder: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CwlRegistryService", () => ({
  resolveCurrentCwlSeasonKey: vi.fn(() => "2026-04"),
}));

import { ReminderService } from "../src/services/reminders/ReminderService";

describe("ReminderService create-draft flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha",
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.reminder.findMany.mockResolvedValue([]);
    prismaMock.reminder.create.mockResolvedValue({
      id: "rem-new-1",
      guildId: "guild-1",
      type: ReminderType.WAR_CWL,
      channelId: "123456789012345678",
      isEnabled: true,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    prismaMock.reminder.update.mockResolvedValue({});
    prismaMock.reminder.findFirst.mockResolvedValue({
      id: "rem-new-1",
      guildId: "guild-1",
      type: ReminderType.WAR_CWL,
      channelId: "123456789012345678",
      isEnabled: true,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      times: [{ offsetSeconds: 3600 }],
      targetClans: [{ clanTag: "#PQL0289", clanType: ReminderTargetClanType.FWA }],
    });
  });

  it("creates a blank in-memory draft when /reminders create is invoked without args", async () => {
    const service = new ReminderService();
    const draft = await service.createReminderDraft({
      guildId: "guild-1",
      actorUserId: "user-1",
    });

    expect(draft.type).toBe(ReminderType.EVENT);
    expect(draft.channelId).toBe("");
    expect(draft.offsetsSeconds).toEqual([]);
    expect(draft.targets).toEqual([]);
  });

  it("filters non-selectable encoded clan targets in create draft updates", async () => {
    const service = new ReminderService();
    const draft = await service.createReminderDraft({
      guildId: "guild-1",
      actorUserId: "user-1",
    });
    const options = await service.listSelectableClanOptions("guild-1");
    const validValue = options[0]?.value ?? "";

    const count = await service.replaceReminderTargetsFromEncodedValues({
      reminderId: draft.id,
      guildId: "guild-1",
      encodedValues: [validValue, "FWA|#NOTSELECTABLE"],
      actorUserId: "user-1",
    });
    const updated = await service.getReminderWithDetails({
      reminderId: draft.id,
      guildId: "guild-1",
    });

    expect(count).toBe(1);
    expect(updated.targets).toEqual([
      expect.objectContaining({
        clanTag: "#PQL0289",
        clanType: ReminderTargetClanType.FWA,
      }),
    ]);
  });

  it("silently merges create-save into an identical existing reminder", async () => {
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "rem-existing-1",
        guildId: "guild-1",
        type: ReminderType.WAR_CWL,
        channelId: "123456789012345678",
        isEnabled: false,
        createdByUserId: "user-x",
        updatedByUserId: "user-x",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
        times: [{ offsetSeconds: 3600 }],
        targetClans: [{ clanTag: "#PQL0289", clanType: ReminderTargetClanType.FWA }],
      },
    ]);
    prismaMock.reminder.findFirst.mockImplementation(async (args: any) => {
      if (args?.where?.id === "rem-existing-1") {
        return {
          id: "rem-existing-1",
          guildId: "guild-1",
          type: ReminderType.WAR_CWL,
          channelId: "123456789012345678",
          isEnabled: true,
          createdByUserId: "user-x",
          updatedByUserId: "user-1",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          times: [{ offsetSeconds: 3600 }],
          targetClans: [{ clanTag: "#PQL0289", clanType: ReminderTargetClanType.FWA }],
        };
      }
      return null;
    });
    const service = new ReminderService();
    const draft = await service.createReminderDraft({
      guildId: "guild-1",
      type: ReminderType.WAR_CWL,
      channelId: "123456789012345678",
      offsetsSeconds: [3600],
      actorUserId: "user-1",
    });
    const options = await service.listSelectableClanOptions("guild-1");
    const validValue = options[0]?.value ?? "";
    await service.replaceReminderTargetsFromEncodedValues({
      reminderId: draft.id,
      guildId: "guild-1",
      encodedValues: [validValue],
      actorUserId: "user-1",
    });
    await service.setReminderEnabled({
      reminderId: draft.id,
      guildId: "guild-1",
      isEnabled: true,
      actorUserId: "user-1",
    });
    const saved = await service.getReminderWithDetails({
      reminderId: draft.id,
      guildId: "guild-1",
    });

    expect(prismaMock.reminder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rem-existing-1" },
      }),
    );
    expect(prismaMock.reminder.create).not.toHaveBeenCalled();
    expect(saved.id).toBe("rem-existing-1");
  });
});
