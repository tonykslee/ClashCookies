import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const autoRoleServiceMock = vi.hoisted(() => ({
  getOrCreateGuildConfig: vi.fn(),
  updateGuildConfig: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  listExclusions: vi.fn(),
  addUserExclusion: vi.fn(),
  removeUserExclusion: vi.fn(),
  addRoleExclusion: vi.fn(),
  removeRoleExclusion: vi.fn(),
}));

vi.mock("../src/services/AutoRoleService", () => ({
  autoRoleService: autoRoleServiceMock,
  formatAutoRoleRuleTarget: (rule: any) => String(rule.targetValue ?? ""),
  formatAutoRoleRuleType: (type: string) => type,
}));

import { Autorole } from "../src/commands/Autorole";

type InteractionInput = {
  group: string;
  subcommand: string;
  strings?: Record<string, string | null | undefined>;
  booleans?: Record<string, boolean | null | undefined>;
  integers?: Record<string, number | null | undefined>;
  roles?: Record<string, { id: string } | null | undefined>;
  users?: Record<string, { id: string } | null | undefined>;
};

function createInteraction(input: InteractionInput) {
  const strings = input.strings ?? {};
  const booleans = input.booleans ?? {};
  const integers = input.integers ?? {};
  const roles = input.roles ?? {};
  const users = input.users ?? {};

  return {
    inGuild: vi.fn(() => true),
    guildId: "111111111111111111",
    memberPermissions: {
      has: vi.fn(() => true),
    },
    options: {
      getSubcommandGroup: vi.fn(() => input.group),
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn((name: string) => strings[name] ?? null),
      getBoolean: vi.fn((name: string) => booleans[name] ?? null),
      getInteger: vi.fn((name: string) => integers[name] ?? null),
      getRole: vi.fn((name: string) => roles[name] ?? null),
      getUser: vi.fn((name: string) => users[name] ?? null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue({
      createMessageComponentCollector: vi.fn(() => ({
        on: vi.fn(),
      })),
    }),
  };
}

function getEditReplyPayload(interaction: any): any {
  return interaction.editReply.mock.calls[0]?.[0] ?? {};
}

function getDescription(interaction: any): string {
  const payload = getEditReplyPayload(interaction);
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

describe("/autorole command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autoRoleServiceMock.getOrCreateGuildConfig.mockResolvedValue({
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
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    autoRoleServiceMock.updateGuildConfig.mockResolvedValue({
      id: "config-1",
      guildId: "111111111111111111",
      enabled: true,
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
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    autoRoleServiceMock.listRules.mockResolvedValue([]);
    autoRoleServiceMock.createRule.mockResolvedValue({
      id: "rule-1",
      guildId: "111111111111111111",
      type: "CLAN",
      targetValue: "#2QG2C08UP",
      discordRoleId: "222222222222222222",
      priority: 200,
      enabled: true,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    autoRoleServiceMock.updateRule.mockResolvedValue({
      id: "rule-1",
      guildId: "111111111111111111",
      type: "CLAN",
      targetValue: "#2QG2C08UP",
      discordRoleId: "222222222222222222",
      priority: 200,
      enabled: true,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    autoRoleServiceMock.deleteRule.mockResolvedValue(true);
    autoRoleServiceMock.listExclusions.mockResolvedValue({
      users: [],
      roles: [],
    });
    autoRoleServiceMock.addUserExclusion.mockResolvedValue({
      id: "user-exclusion-1",
      guildId: "111111111111111111",
      discordUserId: "333333333333333333",
      reason: "manual",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    autoRoleServiceMock.removeUserExclusion.mockResolvedValue(true);
    autoRoleServiceMock.addRoleExclusion.mockResolvedValue({
      id: "role-exclusion-1",
      guildId: "111111111111111111",
      discordRoleId: "444444444444444444",
      reason: "manual",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    autoRoleServiceMock.removeRoleExclusion.mockResolvedValue(true);
  });

  it("registers config, rules, and exclusions subcommand groups", () => {
    const groups = Autorole.options?.map((option: any) => option.name);
    expect(groups).toEqual(["config", "rules", "exclusions"]);

    const configGroup = Autorole.options?.find((option: any) => option.name === "config");
    const rulesGroup = Autorole.options?.find((option: any) => option.name === "rules");
    const exclusionsGroup = Autorole.options?.find((option: any) => option.name === "exclusions");
    expect(configGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(rulesGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(exclusionsGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(configGroup?.options?.map((option: any) => option.name)).toEqual(["show", "set"]);
    expect(rulesGroup?.options?.map((option: any) => option.name)).toEqual([
      "list",
      "add",
      "edit",
      "remove",
    ]);
    expect(exclusionsGroup?.options?.map((option: any) => option.name)).toEqual([
      "list",
      "add-user",
      "remove-user",
      "add-role",
      "remove-role",
    ]);
  });

  it("shows guild config state without touching evaluator or sync code", async () => {
    const interaction = createInteraction({ group: "config", subcommand: "show" });
    const cocService = {
      getClan: vi.fn(),
      getPlayerRaw: vi.fn(),
    };

    await Autorole.run({} as any, interaction as any, cocService as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(autoRoleServiceMock.getOrCreateGuildConfig).toHaveBeenCalledWith(
      "111111111111111111",
    );
    expect(cocService.getClan).not.toHaveBeenCalled();
    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(getDescription(interaction)).toContain("Enabled: disabled");
    expect(getDescription(interaction)).toContain("Trusted links allowed: enabled");
  });

  it("updates config fields from /autorole config set", async () => {
    const interaction = createInteraction({
      group: "config",
      subcommand: "set",
      booleans: {
        enabled: true,
        trusted_links_allowed: false,
        apply_nicknames: true,
      },
      strings: {
        nickname_template: "TH{th} {name}",
      },
    });

    await Autorole.run({} as any, interaction as any, {} as any);

    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      enabled: true,
      trustedLinksAllowed: false,
      applyNicknames: true,
      nicknameTemplate: "TH{th} {name}",
    });
    expect(getEditReplyPayload(interaction).content).toContain("Autorole config updated.");
  });

  it("creates, lists, edits, and removes rules", async () => {
    autoRoleServiceMock.listRules.mockResolvedValue([
      {
        id: "rule-1",
        guildId: "111111111111111111",
        type: "CLAN",
        targetValue: "#2QG2C08UP",
        discordRoleId: "222222222222222222",
        priority: 100,
        enabled: true,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const addInteraction = createInteraction({
      group: "rules",
      subcommand: "add",
      strings: {
        type: "CLAN",
        target_value: "#2QG2C08UP",
      },
      roles: {
        role: { id: "222222222222222222" },
      },
      integers: {
        priority: 100,
      },
      booleans: {
        enabled: true,
      },
    });

    await Autorole.run({} as any, addInteraction as any, {} as any);
    expect(autoRoleServiceMock.createRule).toHaveBeenCalledWith("111111111111111111", {
      type: "CLAN",
      discordRoleId: "222222222222222222",
      targetValue: "#2QG2C08UP",
      priority: 100,
      enabled: true,
    });
    expect(getEditReplyPayload(addInteraction).content).toContain("Autorole rule added");
    expect(getDescription(addInteraction)).toContain("rule-1");

    const editInteraction = createInteraction({
      group: "rules",
      subcommand: "edit",
      strings: {
        rule_id: "rule-1",
        target_value: "#2QG2C08UP",
      },
      roles: {
        role: { id: "222222222222222222" },
      },
      booleans: {
        enabled: true,
      },
    });

    await Autorole.run({} as any, editInteraction as any, {} as any);
    expect(autoRoleServiceMock.updateRule).toHaveBeenCalledWith("111111111111111111", "rule-1", {
      targetValue: "#2QG2C08UP",
      discordRoleId: "222222222222222222",
      enabled: true,
    });
    expect(getEditReplyPayload(editInteraction).content).toContain("Autorole rule updated");

    const removeInteraction = createInteraction({
      group: "rules",
      subcommand: "remove",
      strings: {
        rule_id: "rule-1",
      },
    });

    await Autorole.run({} as any, removeInteraction as any, {} as any);
    expect(autoRoleServiceMock.deleteRule).toHaveBeenCalledWith("111111111111111111", "rule-1");
    expect(getEditReplyPayload(removeInteraction).content).toContain("Autorole rule removed");
  });

  it("lists and updates exclusions without mutating Discord state", async () => {
    autoRoleServiceMock.listExclusions.mockResolvedValue({
      users: [
        {
          id: "user-exclusion-1",
          guildId: "111111111111111111",
          discordUserId: "333333333333333333",
          reason: "manual",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ],
      roles: [
        {
          id: "role-exclusion-1",
          guildId: "111111111111111111",
          discordRoleId: "444444444444444444",
          reason: null,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ],
    });

    const listInteraction = createInteraction({ group: "exclusions", subcommand: "list" });
    await Autorole.run({} as any, listInteraction as any, {} as any);
    expect(getDescription(listInteraction)).toContain("Users (1)");
    expect(getDescription(listInteraction)).toContain("<@333333333333333333>");
    expect(getDescription(listInteraction)).toContain("Roles (1)");

    const addUserInteraction = createInteraction({
      group: "exclusions",
      subcommand: "add-user",
      users: {
        user: { id: "333333333333333333" },
      },
      strings: {
        reason: "manual",
      },
    });
    await Autorole.run({} as any, addUserInteraction as any, {} as any);
    expect(autoRoleServiceMock.addUserExclusion).toHaveBeenCalledWith(
      "111111111111111111",
      "333333333333333333",
      "manual",
    );

    const removeRoleInteraction = createInteraction({
      group: "exclusions",
      subcommand: "remove-role",
      roles: {
        role: { id: "444444444444444444" },
      },
    });
    await Autorole.run({} as any, removeRoleInteraction as any, {} as any);
    expect(autoRoleServiceMock.removeRoleExclusion).toHaveBeenCalledWith(
      "111111111111111111",
      "444444444444444444",
    );
  });
});

