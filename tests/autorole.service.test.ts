import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoRoleService } from "../src/services/AutoRoleService";

const prismaMock = vi.hoisted(() => ({
  autoRoleGuildConfig: {
    upsert: vi.fn(),
  },
  autoRoleRule: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  autoRoleUserExclusion: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  autoRoleRoleExclusion: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-1",
    guildId: "111111111111111111",
    type: "CLAN",
    targetValue: "#2QG2C08UP",
    discordRoleId: "222222222222222222",
    priority: 200,
    enabled: true,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("AutoRoleService", () => {
  const service = new AutoRoleService();

  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.autoRoleGuildConfig.upsert.mockResolvedValue({
      id: "config-1",
      guildId: "111111111111111111",
      enabled: false,
      killSwitchEnabled: false,
      removeStaleManagedRoles: false,
      applyNicknames: false,
      nicknameTemplate: null,
      trustedLinksAllowed: true,
      verifiedOnlyMode: false,
      syncEnabled: false,
      syncIntervalMinutes: null,
      verifiedRoleId: null,
      familyRoleId: null,
      cwlClanRoleId: null,
      clanRoleRemovalDelayMinutes: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    prismaMock.autoRoleRule.findFirst.mockResolvedValue(null);
    prismaMock.autoRoleRule.create.mockImplementation(async (args: any) => ({
      id: "created-rule",
      guildId: args.data.guildId,
      type: args.data.type,
      targetValue: args.data.targetValue,
      discordRoleId: args.data.discordRoleId,
      priority: args.data.priority,
      enabled: args.data.enabled,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    }));
    prismaMock.autoRoleRule.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      guildId: "111111111111111111",
      type: args.data.type,
      targetValue: args.data.targetValue,
      discordRoleId: args.data.discordRoleId,
      priority: args.data.priority,
      enabled: args.data.enabled,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    }));

    prismaMock.autoRoleUserExclusion.findFirst.mockResolvedValue(null);
    prismaMock.autoRoleUserExclusion.create.mockImplementation(async (args: any) => ({
      id: "user-exclusion-1",
      guildId: args.data.guildId,
      discordUserId: args.data.discordUserId,
      reason: args.data.reason,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    }));

    prismaMock.autoRoleRoleExclusion.findFirst.mockResolvedValue(null);
    prismaMock.autoRoleRoleExclusion.create.mockImplementation(async (args: any) => ({
      id: "role-exclusion-1",
      guildId: args.data.guildId,
      discordRoleId: args.data.discordRoleId,
      reason: args.data.reason,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    }));
  });

  it("creates, reads, and updates guild config", async () => {
    await service.getOrCreateGuildConfig("111111111111111111");
    expect(prismaMock.autoRoleGuildConfig.upsert).toHaveBeenCalledWith({
      where: { guildId: "111111111111111111" },
      create: { guildId: "111111111111111111" },
      update: {},
    });

    await service.updateGuildConfig("111111111111111111", {
      enabled: true,
      trustedLinksAllowed: false,
      nicknameTemplate: "TH{th} {name}",
      verifiedRoleId: "222222222222222222",
      cwlClanRoleId: "333333333333333333",
    });
    expect(prismaMock.autoRoleGuildConfig.upsert).toHaveBeenLastCalledWith({
      where: { guildId: "111111111111111111" },
      create: {
        guildId: "111111111111111111",
        enabled: true,
        trustedLinksAllowed: false,
        nicknameTemplate: "TH{th} {name}",
        verifiedRoleId: "222222222222222222",
        cwlClanRoleId: "333333333333333333",
      },
      update: {
        enabled: true,
        trustedLinksAllowed: false,
        nicknameTemplate: "TH{th} {name}",
        verifiedRoleId: "222222222222222222",
        cwlClanRoleId: "333333333333333333",
      },
    });
  });

  it("creates every supported rule type with normalized targets", async () => {
    const cases = [
      {
        type: "VERIFIED",
        targetValue: undefined,
        expectedTarget: "__verified__",
      },
      {
        type: "FAMILY",
        targetValue: undefined,
        expectedTarget: "__family__",
      },
      {
        type: "CLAN",
        targetValue: "2QG2C08UP",
        expectedTarget: "#2QG2C08UP",
      },
      {
        type: "CLAN_ROLE",
        targetValue: "leader",
        expectedTarget: "leader",
      },
      {
        type: "LEAGUE",
        targetValue: "  Legend   League  ",
        expectedTarget: "Legend League",
      },
      {
        type: "TOWN_HALL",
        targetValue: 18,
        expectedTarget: "18",
      },
      {
        type: "LABEL",
        targetValue: "family-group",
        expectedTarget: "family-group",
      },
    ] as const;

    for (const entry of cases) {
      prismaMock.autoRoleRule.findFirst.mockResolvedValueOnce(null);
      await service.createRule("111111111111111111", {
        type: entry.type as any,
        discordRoleId: "222222222222222222",
        targetValue: entry.targetValue as any,
      });
      expect(prismaMock.autoRoleRule.create).toHaveBeenLastCalledWith({
        data: {
          guildId: "111111111111111111",
          type: entry.type,
          targetValue: entry.expectedTarget,
          discordRoleId: "222222222222222222",
          priority: expect.any(Number),
          enabled: true,
        },
      });
    }
  });

  it("rejects duplicate rules and duplicate exclusions cleanly", async () => {
    prismaMock.autoRoleRule.findFirst.mockResolvedValueOnce(makeRule());
    await expect(
      service.createRule("111111111111111111", {
        type: "CLAN",
        targetValue: "#2QG2C08UP",
        discordRoleId: "222222222222222222",
      }),
    ).rejects.toThrow("That autorole rule already exists for this guild.");

    prismaMock.autoRoleUserExclusion.findFirst.mockResolvedValueOnce({
      id: "user-exclusion-1",
      guildId: "111111111111111111",
      discordUserId: "333333333333333333",
      reason: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    await expect(
      service.addUserExclusion("111111111111111111", "333333333333333333"),
    ).rejects.toThrow("That user exclusion already exists for this guild.");

    prismaMock.autoRoleRoleExclusion.findFirst.mockResolvedValueOnce({
      id: "role-exclusion-1",
      guildId: "111111111111111111",
      discordRoleId: "444444444444444444",
      reason: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    await expect(
      service.addRoleExclusion("111111111111111111", "444444444444444444"),
    ).rejects.toThrow("That role exclusion already exists for this guild.");
  });

  it("rejects invalid rule targets", async () => {
    await expect(
      service.createRule("111111111111111111", {
        type: "CLAN",
        targetValue: "BADTAG",
        discordRoleId: "222222222222222222",
      }),
    ).rejects.toThrow("CLAN rules require a valid clan tag target.");

    await expect(
      service.createRule("111111111111111111", {
        type: "CLAN_ROLE",
        targetValue: "peasant",
        discordRoleId: "222222222222222222",
      }),
    ).rejects.toThrow("CLAN_ROLE rules require one of: member, elder, coLeader, leader.");

    await expect(
      service.createRule("111111111111111111", {
        type: "TOWN_HALL",
        targetValue: 19,
        discordRoleId: "222222222222222222",
      }),
    ).rejects.toThrow("TOWN_HALL rules require a TH value between 1 and 18.");

    await expect(
      service.createRule("111111111111111111", {
        type: "LEAGUE",
        targetValue: "   ",
        discordRoleId: "222222222222222222",
      }),
    ).rejects.toThrow("LEAGUE rules require a non-empty target value.");
  });

  it("preserves canonical verified/family targets when a rule type changes", async () => {
    prismaMock.autoRoleRule.findFirst.mockResolvedValueOnce(makeRule());
    prismaMock.autoRoleRule.update.mockResolvedValueOnce(
      makeRule({ id: "rule-1", type: "VERIFIED", targetValue: "__verified__" }),
    );

    const updated = await service.updateRule("111111111111111111", "rule-1", {
      type: "VERIFIED",
    });

    expect(updated?.type).toBe("VERIFIED");
    expect(updated?.targetValue).toBe("__verified__");
    expect(prismaMock.autoRoleRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: {
        type: "VERIFIED",
        targetValue: "__verified__",
        discordRoleId: "222222222222222222",
        priority: 200,
        enabled: true,
      },
    });
  });

  it("lists rules deterministically", async () => {
    prismaMock.autoRoleRule.findMany.mockResolvedValue([
      makeRule({ id: "rule-c", type: "CLAN_ROLE", targetValue: "leader", priority: 100 }),
      makeRule({ id: "rule-a", type: "VERIFIED", targetValue: "__verified__", priority: 100 }),
      makeRule({ id: "rule-b", type: "FAMILY", targetValue: "__family__", priority: 100 }),
    ]);

    const rules = await service.listRules("111111111111111111");
    expect(rules.map((rule) => rule.id)).toEqual(["rule-a", "rule-b", "rule-c"]);
  });

  it("lists and removes exclusions", async () => {
    prismaMock.autoRoleUserExclusion.findMany.mockResolvedValue([
      {
        id: "user-b",
        guildId: "111111111111111111",
        discordUserId: "444444444444444444",
        reason: null,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
        updatedAt: new Date("2026-04-02T00:00:00.000Z"),
      },
      {
        id: "user-a",
        guildId: "111111111111111111",
        discordUserId: "333333333333333333",
        reason: "manual",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.autoRoleRoleExclusion.findMany.mockResolvedValue([
      {
        id: "role-a",
        guildId: "111111111111111111",
        discordRoleId: "555555555555555555",
        reason: "manual",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const exclusions = await service.listExclusions("111111111111111111");
    expect(exclusions.users.map((row) => row.discordUserId)).toEqual([
      "333333333333333333",
      "444444444444444444",
    ]);
    expect(exclusions.roles.map((row) => row.discordRoleId)).toEqual([
      "555555555555555555",
    ]);

    prismaMock.autoRoleUserExclusion.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.autoRoleRoleExclusion.deleteMany.mockResolvedValue({ count: 1 });
    await expect(
      service.removeUserExclusion("111111111111111111", "333333333333333333"),
    ).resolves.toBe(true);
    await expect(
      service.removeRoleExclusion("111111111111111111", "555555555555555555"),
    ).resolves.toBe(true);
  });
});
