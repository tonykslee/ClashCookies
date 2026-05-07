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
  reminderTargetClan: {
    findMany: vi.fn(),
    createMany: vi.fn(),
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
    prismaMock.reminderTargetClan.findMany.mockResolvedValue([]);
    prismaMock.reminderTargetClan.createMany.mockResolvedValue({ count: 0 });
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

  it("keeps create-mode enable and disable as draft-only state before save", async () => {
    const service = new ReminderService();
    const draft = await service.createReminderDraft({
      guildId: "guild-1",
      actorUserId: "user-1",
    });

    await service.setReminderEnabled({
      reminderId: draft.id,
      guildId: "guild-1",
      isEnabled: true,
      actorUserId: "user-1",
    });
    await service.setReminderEnabled({
      reminderId: draft.id,
      guildId: "guild-1",
      isEnabled: false,
      actorUserId: "user-1",
    });
    const updated = await service.getReminderWithDetails({
      reminderId: draft.id,
      guildId: "guild-1",
    });

    expect(prismaMock.reminder.create).not.toHaveBeenCalled();
    expect(updated.isEnabled).toBe(false);
  });

  it("persists a draft only when save is invoked and keeps the saved enabled state", async () => {
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

    const saved = await service.saveDraftReminder({
      reminderId: draft.id,
      guildId: "guild-1",
      actorUserId: "user-1",
    });

    expect(prismaMock.reminder.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isEnabled: true,
        }),
      }),
    );
    expect(saved.id).toBe("rem-new-1");
    expect(saved.isEnabled).toBe(true);
  });

  it("persists a saved draft as disabled when the draft toggle is disabled", async () => {
    prismaMock.reminder.findFirst.mockImplementation(async (args: any) => {
      if (args?.where?.id === "rem-new-1") {
        return {
          id: "rem-new-1",
          guildId: "guild-1",
          type: ReminderType.WAR_CWL,
          channelId: "123456789012345678",
          isEnabled: false,
          createdByUserId: "user-1",
          updatedByUserId: "user-1",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
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

    const saved = await service.saveDraftReminder({
      reminderId: draft.id,
      guildId: "guild-1",
      actorUserId: "user-1",
    });

    expect(prismaMock.reminder.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.reminder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isEnabled: false,
        }),
      }),
    );
    expect(saved.id).toBe("rem-new-1");
    expect(saved.isEnabled).toBe(false);
  });

  it("deletes a create draft after toggles without leaving behind a persisted reminder", async () => {
    const service = new ReminderService();
    const draft = await service.createReminderDraft({
      guildId: "guild-1",
      actorUserId: "user-1",
    });

    await service.setReminderEnabled({
      reminderId: draft.id,
      guildId: "guild-1",
      isEnabled: true,
      actorUserId: "user-1",
    });
    await service.setReminderEnabled({
      reminderId: draft.id,
      guildId: "guild-1",
      isEnabled: false,
      actorUserId: "user-1",
    });
    const deleted = await service.deleteReminder({
      reminderId: draft.id,
      guildId: "guild-1",
      actorUserId: "user-1",
    });

    expect(deleted).toBe(true);
    expect(prismaMock.reminder.create).not.toHaveBeenCalled();
    expect(prismaMock.reminder.deleteMany).not.toHaveBeenCalled();
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
    await service.saveDraftReminder({
      reminderId: draft.id,
      guildId: "guild-1",
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

  it("prefers FWA option when the same clan tag exists in both FWA and CWL selectable sets", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha",
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha CWL",
      },
    ]);

    const service = new ReminderService();
    const selected = await service.findSelectableClanOptionByTag({
      guildId: "guild-1",
      clanTag: "#PQL0289",
    });

    expect(selected).toBeTruthy();
    expect(selected?.clanTag).toBe("#PQL0289");
    expect(selected?.clanType).toBe(ReminderTargetClanType.FWA);
  });

  it("prefills draft channel from tracked-clan log channel only when channel is empty", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha",
        logChannelId: "999999999999999999",
      },
    ]);
    const service = new ReminderService();
    const draft = await service.createReminderDraft({
      guildId: "guild-1",
      actorUserId: "user-1",
    });

    const prefilled = await service.tryPrefillReminderChannelFromTrackedClanLog({
      reminderId: draft.id,
      guildId: "guild-1",
      clanTag: "#PQL0289",
      actorUserId: "user-1",
    });
    const updated = await service.getReminderWithDetails({
      reminderId: draft.id,
      guildId: "guild-1",
    });

    expect(prefilled).toBe("999999999999999999");
    expect(updated.channelId).toBe("999999999999999999");
  });

  it("does not overwrite an already populated channel during log-channel autofill", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Alpha",
        logChannelId: "999999999999999999",
      },
    ]);
    const service = new ReminderService();
    const draft = await service.createReminderDraft({
      guildId: "guild-1",
      channelId: "123456789012345678",
      actorUserId: "user-1",
    });

    const prefilled = await service.tryPrefillReminderChannelFromTrackedClanLog({
      reminderId: draft.id,
      guildId: "guild-1",
      clanTag: "#PQL0289",
      actorUserId: "user-1",
    });
    const updated = await service.getReminderWithDetails({
      reminderId: draft.id,
      guildId: "guild-1",
    });

    expect(prefilled).toBeNull();
    expect(updated.channelId).toBe("123456789012345678");
  });
});

describe("ReminderService reminder listing and autocomplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        tag: "#PQL0289",
        name: "Rising Dawn",
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      {
        tag: "#2QG2C08UP",
        name: "Zero Gravity",
      },
    ]);
    prismaMock.reminderTargetClan.findMany.mockResolvedValue([]);
    prismaMock.reminderTargetClan.createMany.mockResolvedValue({ count: 0 });
  });

  it("resolves reminder list targets to clan names and tag fallbacks", async () => {
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "reminder-1",
        guildId: "guild-1",
        type: ReminderType.WAR_CWL,
        channelId: "123456789012345678",
        isEnabled: true,
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        times: [{ offsetSeconds: 3600 }],
        targetClans: [
          { clanTag: "#PQL0289", clanType: ReminderTargetClanType.FWA },
          { clanTag: "#MISSINGTAG", clanType: ReminderTargetClanType.FWA },
          { clanTag: "#2QG2C08UP", clanType: ReminderTargetClanType.CWL },
        ],
        _count: { targetClans: 3 },
      },
    ]);

    const service = new ReminderService();
    const rows = await service.listReminderSummariesForGuild("guild-1");

    expect(prismaMock.reminder.findMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        include: expect.objectContaining({
          targetClans: expect.objectContaining({
            select: { clanTag: true, clanType: true },
          }),
        }),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targets).toEqual([
      expect.objectContaining({
        clanTag: "#PQL0289",
        name: "Rising Dawn",
      }),
      expect.objectContaining({
        clanTag: "#MISSINGTAG",
        name: null,
      }),
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        name: "Zero Gravity",
      }),
    ]);
  });

  it("filters reminder autocomplete rows by query and keeps labels guild-scoped", async () => {
    prismaMock.reminder.findMany.mockResolvedValue([
      {
        id: "reminder-abc12345",
        guildId: "guild-1",
        type: ReminderType.WAR_CWL,
        channelId: "123456789012345678",
        isEnabled: true,
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        times: [{ offsetSeconds: 3600 }, { offsetSeconds: 43200 }],
        targetClans: [
          { clanTag: "#PQL0289", clanType: ReminderTargetClanType.FWA },
          { clanTag: "#2QG2C08UP", clanType: ReminderTargetClanType.CWL },
        ],
        _count: { targetClans: 2 },
      },
      {
        id: "reminder-xyz98765",
        guildId: "guild-1",
        type: ReminderType.RAIDS,
        channelId: "987654321098765432",
        isEnabled: false,
        createdByUserId: "user-1",
        updatedByUserId: "user-1",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        times: [{ offsetSeconds: 1800 }],
        targetClans: [{ clanTag: "#MISSINGTAG", clanType: ReminderTargetClanType.FWA }],
        _count: { targetClans: 1 },
      },
    ]);

    const service = new ReminderService();
    const rows = await service.listReminderAutocompleteRowsForGuild("guild-1", "gravity");

    expect(prismaMock.reminder.findMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        include: expect.objectContaining({
          targetClans: expect.any(Object),
        }),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: "reminder-abc12345",
        value: "reminder-abc12345",
        label: "WAR_CWL reminder | 1h, 12h | Rising Dawn, Zero Gravity | enabled",
      }),
    );
  });
});

describe("ReminderService CWL target reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      {
        tag: "#2C00C0JQ2",
        name: "Rising Queens",
      },
      {
        tag: "#2CL0LQJ88",
        name: "Rising Wood",
      },
      {
        tag: "#2CL2JGJPC",
        name: "Rising Kings",
      },
    ]);
    prismaMock.reminder.findFirst.mockResolvedValue({
      id: "reminder-1",
      guildId: "guild-1",
      type: ReminderType.WAR_CWL,
      channelId: "123456789012345678",
      isEnabled: true,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      times: [{ offsetSeconds: 24 * 60 * 60 }],
      targetClans: [],
    });
    prismaMock.reminderTargetClan.findMany.mockResolvedValue([]);
    prismaMock.reminderTargetClan.createMany.mockResolvedValue({ count: 0 });
  });

  it("reconciles missing current-season CWL target rows without duplicating existing rows", async () => {
    prismaMock.reminderTargetClan.findMany.mockResolvedValue([
      {
        clanTag: "#2C00C0JQ2",
        clanType: ReminderTargetClanType.CWL,
      },
    ]);

    const service = new ReminderService();
    const summary = await service.reconcileCurrentSeasonCwlTargets({
      guildId: "guild-1",
      reminderId: "reminder-1",
      actorUserId: "user-1",
    });

    expect(summary.currentSeasonCwlClanCount).toBe(3);
    expect(summary.existingCwlTargetCount).toBe(1);
    expect(summary.addedTargetCount).toBe(2);
    expect(summary.skippedExistingCount).toBe(1);
    expect(summary.addedClans.map((row) => row.clanTag)).toEqual([
      "#2CL0LQJ88",
      "#2CL2JGJPC",
    ]);
    expect(prismaMock.reminderTargetClan.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            reminderId: "reminder-1",
            clanTag: "#2CL0LQJ88",
            clanType: ReminderTargetClanType.CWL,
          }),
          expect.objectContaining({
            reminderId: "reminder-1",
            clanTag: "#2CL2JGJPC",
            clanType: ReminderTargetClanType.CWL,
          }),
        ],
        skipDuplicates: true,
      }),
    );
  });

  it("does not add CWL targets for reminders that are not WAR_CWL", async () => {
    prismaMock.reminder.findFirst.mockResolvedValueOnce({
      id: "reminder-1",
      guildId: "guild-1",
      type: ReminderType.RAIDS,
      channelId: "123456789012345678",
      isEnabled: true,
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      times: [{ offsetSeconds: 24 * 60 * 60 }],
      targetClans: [{ clanTag: "#2C00C0JQ2", clanType: ReminderTargetClanType.CWL }],
    });

    const service = new ReminderService();
    const summary = await service.reconcileCurrentSeasonCwlTargets({
      guildId: "guild-1",
      reminderId: "reminder-1",
      actorUserId: "user-1",
    });

    expect(summary.warning).toContain("Reminder type is RAIDS");
    expect(summary.addedTargetCount).toBe(0);
    expect(prismaMock.reminderTargetClan.createMany).not.toHaveBeenCalled();
  });

  it("audits missing and extra current-season CWL target rows and reports 24h offsets", async () => {
    prismaMock.reminderTargetClan.findMany.mockResolvedValue([
      {
        clanTag: "#2C00C0JQ2",
        clanType: ReminderTargetClanType.CWL,
      },
      {
        clanTag: "#STALEROW",
        clanType: ReminderTargetClanType.CWL,
      },
    ]);

    const service = new ReminderService();
    const summary = await service.auditCurrentSeasonCwlTargets({
      guildId: "guild-1",
      reminderId: "reminder-1",
    });

    expect(summary.currentSeasonCwlClanCount).toBe(3);
    expect(summary.existingCwlTargetCount).toBe(2);
    expect(summary.has24hOffset).toBe(true);
    expect(summary.missingCurrentSeasonCwlTargets.map((row) => row.clanTag)).toEqual([
      "#2CL0LQJ88",
      "#2CL2JGJPC",
    ]);
    expect(summary.extraCwlTargets.map((row) => row.clanTag)).toEqual(["#STALEROW"]);
  });
});
