import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  recruitmentCountdownReminderPreference: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  recruitmentCountdownReminderPreferenceService,
} from "../src/services/RecruitmentCountdownReminderPreferenceService";

describe("recruitment countdown reminder preference service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.recruitmentCountdownReminderPreference.findUnique.mockResolvedValue(null);
    prismaMock.recruitmentCountdownReminderPreference.upsert.mockResolvedValue({
      guildId: "guild-1",
      userId: "user-1",
      remindersEnabled: true,
    });
  });

  it("defaults to enabled when no row exists", async () => {
    await expect(
      recruitmentCountdownReminderPreferenceService.isEnabled("guild-1", "user-1"),
    ).resolves.toBe(true);
    expect(prismaMock.recruitmentCountdownReminderPreference.findUnique).toHaveBeenCalledWith({
      where: { guildId_userId: { guildId: "guild-1", userId: "user-1" } },
      select: { remindersEnabled: true },
    });
  });

  it("persists the enabled flag per guild and user", async () => {
    await recruitmentCountdownReminderPreferenceService.setEnabled({
      guildId: "guild-1",
      userId: "user-1",
      enabled: false,
    });

    expect(prismaMock.recruitmentCountdownReminderPreference.upsert).toHaveBeenCalledWith({
      where: { guildId_userId: { guildId: "guild-1", userId: "user-1" } },
      create: {
        guildId: "guild-1",
        userId: "user-1",
        remindersEnabled: false,
      },
      update: { remindersEnabled: false },
    });
  });
});
