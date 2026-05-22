import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}));

const preferenceServiceMock = vi.hoisted(() => ({
  isEnabled: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/RecruitmentCountdownReminderPreferenceService", () => ({
  recruitmentCountdownReminderPreferenceService: preferenceServiceMock,
}));

import { processRecruitmentCooldownReminders } from "../src/services/RecruitmentService";

describe("recruitment cooldown reminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preferenceServiceMock.isEnabled.mockResolvedValue(true);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
  });

  it("skips delivery when countdown reminders are muted for the user", async () => {
    const send = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ send });
    const client = { users: { fetch } } as any;
    const dueRows = [
      {
        id: 1,
        guildId: "guild-1",
        userId: "user-1",
        clanTag: "ABC123",
        platform: "discord",
        startedAt: new Date("2026-05-21T12:00:00.000Z"),
        expiresAt: new Date("2026-05-22T11:00:00.000Z"),
        reminded: false,
      },
    ];
    (prismaMock.$queryRaw as any).mockResolvedValueOnce(dueRows);
    (prismaMock.$executeRaw as any).mockResolvedValue(undefined);
    preferenceServiceMock.isEnabled.mockResolvedValueOnce(false);

    await processRecruitmentCooldownReminders(client, "guild-1");

    expect(preferenceServiceMock.isEnabled).toHaveBeenCalledWith("guild-1", "user-1");
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
