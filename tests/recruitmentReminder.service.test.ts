import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  recruitmentReminderRule: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  recruitmentReminderDelivery: {
    create: vi.fn(),
  },
}));

const recruitmentServiceMock = vi.hoisted(() => ({
  getRecruitmentCooldown: vi.fn(),
  getRecruitmentTemplate: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/RecruitmentService", async () => {
  const actual = await vi.importActual("../src/services/RecruitmentService");
  return {
    ...actual,
    getRecruitmentCooldown: recruitmentServiceMock.getRecruitmentCooldown,
    getRecruitmentTemplate: recruitmentServiceMock.getRecruitmentTemplate,
  };
});

import {
  autocompleteRecruitmentTimeZones,
  buildRecruitmentReminderDmContent,
  getNextRecruitmentReminderSlot,
  getRecruitmentReminderSlotCandidates,
  processDueRecruitmentReminders,
  upsertRecruitmentReminderRule,
} from "../src/services/RecruitmentReminderService";

describe("recruitment reminder service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recruitmentServiceMock.getRecruitmentCooldown.mockResolvedValue(null);
    recruitmentServiceMock.getRecruitmentTemplate.mockResolvedValue(null);
    prismaMock.recruitmentReminderRule.findFirst.mockResolvedValue(null);
    prismaMock.recruitmentReminderRule.create.mockResolvedValue({
      id: "rule-1",
    });
    prismaMock.recruitmentReminderRule.update.mockResolvedValue({
      id: "rule-1",
    });
    prismaMock.recruitmentReminderRule.findMany.mockResolvedValue([]);
    prismaMock.recruitmentReminderDelivery.create.mockResolvedValue({
      id: "delivery-1",
    });
  });

  it("autocompletes IANA timezones with curated Pacific zones first", () => {
    const choices = autocompleteRecruitmentTimeZones("pac");

    expect(choices.length).toBeGreaterThan(0);
    expect(choices[0]?.value).toBe("America/Los_Angeles");
    expect(choices.every((choice) => choice.value.includes("/"))).toBe(true);
  });

  it("generates cooldown-aware 30-minute slot options in optimized windows", () => {
    const after = new Date("2026-04-08T17:17:00-07:00");
    const cooldownExpiresAt = new Date("2026-04-08T17:17:00-07:00");

    const slots = getRecruitmentReminderSlotCandidates({
      platform: "band",
      timezone: "America/Los_Angeles",
      after,
      cooldownExpiresAt,
    });

    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]?.toISOString()).toBe("2026-04-09T02:00:00.000Z");
    expect(slots.every((slot) => slot.getUTCMinutes() % 30 === 0)).toBe(true);
    expect(slots.every((slot) => slot.getTime() > cooldownExpiresAt.getTime())).toBe(true);
  });

  it("selects the next optimized slot per platform", () => {
    expect(
      getNextRecruitmentReminderSlot({
        platform: "discord",
        timezone: "America/Los_Angeles",
        after: new Date("2026-04-08T17:45:00-07:00"),
        cooldownExpiresAt: new Date("2026-04-08T18:10:00-07:00"),
      })?.toISOString(),
    ).toBe("2026-04-09T01:30:00.000Z");

    expect(
      getNextRecruitmentReminderSlot({
        platform: "band",
        timezone: "America/Los_Angeles",
        after: new Date("2026-04-08T18:45:00-07:00"),
        cooldownExpiresAt: null,
      })?.toISOString(),
    ).toBe("2026-04-09T02:00:00.000Z");

    expect(
      getNextRecruitmentReminderSlot({
        platform: "reddit",
        timezone: "America/Los_Angeles",
        after: new Date("2026-04-10T12:00:00-07:00"),
        cooldownExpiresAt: null,
      })?.toISOString(),
    ).toBe("2026-04-11T15:00:00.000Z");
  });

  it("creates then updates the active reminder rule for the same clan/platform", async () => {
    prismaMock.recruitmentReminderRule.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "rule-1" });
    prismaMock.recruitmentReminderRule.create.mockResolvedValueOnce({ id: "rule-1" });
    prismaMock.recruitmentReminderRule.update.mockResolvedValueOnce({ id: "rule-1" });

    const created = await upsertRecruitmentReminderRule({
      guildId: "guild-1",
      discordUserId: "user-1",
      clanTag: "#PYLQ0289",
      platform: "discord",
      timezone: "America/Los_Angeles",
      nextReminderAt: new Date("2026-04-08T18:30:00.000Z"),
      isActive: true,
      clanNameSnapshot: "Alpha",
      templateSubject: "Subject A",
      templateBody: "Body A",
      templateImageUrls: ["https://img.example/a.png"],
    });

    const updated = await upsertRecruitmentReminderRule({
      guildId: "guild-1",
      discordUserId: "user-1",
      clanTag: "#PYLQ0289",
      platform: "discord",
      timezone: "America/Los_Angeles",
      nextReminderAt: new Date("2026-04-08T19:00:00.000Z"),
      isActive: true,
      clanNameSnapshot: "Alpha",
      templateSubject: "Subject B",
      templateBody: "Body B",
      templateImageUrls: ["https://img.example/b.png"],
    });

    expect(prismaMock.recruitmentReminderRule.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.recruitmentReminderRule.update).toHaveBeenCalledTimes(1);
    expect(created.id).toBe("rule-1");
    expect(updated.id).toBe("rule-1");
  });

  it("sends snapshot content and schedules the next optimized reminder after delivery", async () => {
    prismaMock.recruitmentReminderRule.findMany.mockResolvedValue([
      {
        id: "rule-1",
        guildId: "guild-1",
        discordUserId: "user-1",
        clanTag: "#PYLQ0289",
        platform: "discord",
        timezone: "America/Los_Angeles",
        nextReminderAt: new Date("2026-04-08T17:45:00-07:00"),
        isActive: true,
        lastSentAt: null,
        clanNameSnapshot: "Alpha",
        templateSubject: "Snapshot Subject",
        templateBody: "Snapshot Body",
        templateImageUrls: ["https://img.example/snapshot.png"],
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    recruitmentServiceMock.getRecruitmentCooldown.mockResolvedValue({
      expiresAt: new Date("2026-04-08T18:10:00-07:00"),
    });
    recruitmentServiceMock.getRecruitmentTemplate.mockResolvedValue({
      subject: "Live Subject",
      body: "Live Body",
      imageUrls: ["https://img.example/live.png"],
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const fetchUser = vi.fn().mockResolvedValue({ send });
    const client = { users: { fetch: fetchUser } } as any;

    const counts = await processDueRecruitmentReminders({
      client,
      now: new Date("2026-04-08T17:45:00-07:00"),
    });

    expect(counts).toEqual({ evaluated: 1, sent: 1, failed: 0 });
    expect(fetchUser).toHaveBeenCalledWith("user-1");
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("Snapshot Body"),
    });
    expect(send.mock.calls[0]?.[0]?.content).not.toContain("Live Body");
    expect(prismaMock.recruitmentReminderRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: expect.objectContaining({
        lastSentAt: new Date("2026-04-08T17:45:00-07:00"),
        nextReminderAt: new Date("2026-04-08T18:30:00-07:00"),
      }),
    });
    expect(prismaMock.recruitmentReminderDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reminderRuleId: "rule-1",
        scheduledFor: new Date("2026-04-08T17:45:00-07:00"),
        status: "SENT",
        sentAt: new Date("2026-04-08T17:45:00-07:00"),
      }),
    });
  });
});
