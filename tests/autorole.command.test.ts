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

const autoRoleRefreshServiceMock = vi.hoisted(() => ({
  refreshGuild: vi.fn(),
  refreshUser: vi.fn(),
  refreshRole: vi.fn(),
}));

const commandPermissionServiceMock = vi.hoisted(() => ({
  canUseCommand: vi.fn(),
}));

function makeGuildConfig(overrides: Record<string, unknown> = {}) {
  return {
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
    nonMemberRoleId: null,
    delayedSignupRoleIds: [],
    nonMemberEnabled: false,
    clanRoleRemovalDelayMinutes: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

vi.mock("../src/services/AutoRoleService", () => ({
  autoRoleService: autoRoleServiceMock,
  formatAutoRoleRuleTarget: (rule: any) => String(rule.targetValue ?? ""),
  formatAutoRoleRuleType: (type: string) => type,
}));

vi.mock("../src/services/AutoRoleRefreshService", () => ({
  autoRoleRefreshService: autoRoleRefreshServiceMock,
}));

vi.mock("../src/services/CommandPermissionService", () => ({
  CommandPermissionService: vi.fn().mockImplementation(() => commandPermissionServiceMock),
}));

import { Autorole } from "../src/commands/Autorole";

type InteractionInput = {
  group: string | null;
  subcommand: string;
  isAdmin?: boolean;
  strings?: Record<string, string | null | undefined>;
  booleans?: Record<string, boolean | null | undefined>;
  integers?: Record<string, number | null | undefined>;
  roles?: Record<string, { id: string } | null | undefined>;
  users?: Record<string, { id: string } | null | undefined>;
  guild?: { members: { fetch: ReturnType<typeof vi.fn> } } | null;
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
    guild:
      input.guild ??
      ({
        members: {
          fetch: vi.fn(),
        },
        roles: {
          cache: new Map<string, { id: string }>(),
          fetch: vi.fn(),
        },
      } as any),
    memberPermissions: {
      has: vi.fn(() => input.isAdmin ?? true),
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
    reply: vi.fn().mockResolvedValue(undefined),
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
    commandPermissionServiceMock.canUseCommand.mockResolvedValue(true);
    autoRoleServiceMock.getOrCreateGuildConfig.mockResolvedValue(makeGuildConfig());
    autoRoleServiceMock.updateGuildConfig.mockResolvedValue(
      makeGuildConfig({
        enabled: true,
      }),
    );
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
    autoRoleRefreshServiceMock.refreshGuild.mockResolvedValue({
      guildId: "111111111111111111",
      scope: { kind: "guild" },
      runId: "run-1",
      evaluatedCount: 0,
      addedCount: 0,
      removedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      memberResults: [],
    });
    autoRoleRefreshServiceMock.refreshUser.mockResolvedValue({
      guildId: "111111111111111111",
      scope: { kind: "user", discordUserId: "333333333333333333" },
      runId: "run-2",
      evaluatedCount: 1,
      addedCount: 1,
      removedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      memberResults: [
        {
          discordUserId: "333333333333333333",
          status: "applied",
          skipReason: null,
          rolesAdded: ["222222222222222222"],
          rolesRemoved: [],
          nicknameStatus: "skipped",
          nicknameReason: "nickname renderer not implemented",
          failureReasons: [],
          resultHash: "hash-1",
        },
      ],
    });
    autoRoleRefreshServiceMock.refreshRole.mockResolvedValue({
      guildId: "111111111111111111",
      scope: { kind: "role", discordRoleId: "444444444444444444" },
      runId: "run-3",
      evaluatedCount: 2,
      addedCount: 1,
      removedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      memberResults: [],
    });
  });

  it("registers config, rules, and exclusions subcommand groups", () => {
    const groups = Autorole.options?.map((option: any) => option.name);
    expect(groups).toEqual(["refresh", "config", "rules", "exclusions"]);

    const refresh = Autorole.options?.find((option: any) => option.name === "refresh");
    expect(refresh?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(refresh?.options?.map((option: any) => option.name)).toEqual(["user", "role"]);

    const configGroup = Autorole.options?.find((option: any) => option.name === "config");
    const rulesGroup = Autorole.options?.find((option: any) => option.name === "rules");
    const exclusionsGroup = Autorole.options?.find((option: any) => option.name === "exclusions");
    expect(configGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(rulesGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(exclusionsGroup?.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(configGroup?.options?.map((option: any) => option.name)).toEqual(["show", "set"]);
    const configSetOptions = configGroup?.options
      ?.find((option: any) => option.name === "set")
      ?.options?.map((option: any) => option.name);
    expect(configSetOptions).toEqual(expect.arrayContaining([
      "clan_role_removal_delay_minutes",
      "clear_clan_role_removal_delay",
      "cwl_clan_role",
      "clear_cwl_clan_role",
      "non-member-role",
      "non-member-enabled",
    ]));
    expect(rulesGroup?.options?.map((option: any) => option.name)).toEqual([
      "list",
      "add",
      "edit",
      "remove",
    ]);
    const ruleTypeChoices = rulesGroup?.options
      ?.find((option: any) => option.name === "add")
      ?.options?.find((option: any) => option.name === "type")
      ?.choices?.map((choice: any) => ({ name: choice.name, value: choice.value }));
    expect(ruleTypeChoices).toContainEqual({ name: "League", value: "LEAGUE" });
    expect(exclusionsGroup?.options?.map((option: any) => option.name)).toEqual([
      "list",
      "add-user",
      "remove-user",
      "add-role",
      "remove-role",
    ]);
  });

  it("allows no-arg /autorole refresh when command permissions allow it", async () => {
    const guild = {
      members: {
        fetch: vi.fn(),
      },
    } as any;
    const interaction = createInteraction({
      group: null,
      subcommand: "refresh",
      isAdmin: false,
      guild,
    });

    await Autorole.run({} as any, interaction as any, {} as any);

    expect(commandPermissionServiceMock.canUseCommand).toHaveBeenCalledWith(
      "autorole:refresh",
      interaction,
    );
    expect(autoRoleRefreshServiceMock.refreshGuild).toHaveBeenCalledWith({
      guild,
      guildId: "111111111111111111",
      cocService: {},
    });
    expect(getEditReplyPayload(interaction).content).toContain("Autorole refresh completed for guild.");
  });

  it("allows scoped /autorole refresh variants when command permissions allow it", async () => {
    const guild = {
      members: {
        fetch: vi.fn(),
      },
    } as any;

    const userInteraction = createInteraction({
      group: null,
      subcommand: "refresh",
      isAdmin: false,
      guild,
      users: {
        user: { id: "333333333333333333" },
      },
    });
    await Autorole.run({} as any, userInteraction as any, {} as any);
    expect(commandPermissionServiceMock.canUseCommand).toHaveBeenCalledWith(
      "autorole:refresh",
      userInteraction,
    );
    expect(autoRoleRefreshServiceMock.refreshUser).toHaveBeenCalledWith({
      guild,
      guildId: "111111111111111111",
      discordUserId: "333333333333333333",
      cocService: {},
    });

    const roleInteraction = createInteraction({
      group: null,
      subcommand: "refresh",
      isAdmin: false,
      guild,
      roles: {
        role: { id: "444444444444444444" },
      },
    });
    await Autorole.run({} as any, roleInteraction as any, {} as any);
    expect(commandPermissionServiceMock.canUseCommand).toHaveBeenCalledWith(
      "autorole:refresh",
      roleInteraction,
    );
    expect(autoRoleRefreshServiceMock.refreshRole).toHaveBeenCalledWith({
      guild,
      guildId: "111111111111111111",
      discordRoleId: "444444444444444444",
      cocService: {},
    });
  });

  it("surfaces Discord member-fetch rate limits from /autorole refresh role", async () => {
    autoRoleRefreshServiceMock.refreshRole.mockRejectedValueOnce(
      new Error("Discord rate-limited member fetching. Try again in about 12 seconds."),
    );
    const guild = {
      members: {
        fetch: vi.fn(),
      },
    } as any;

    const interaction = createInteraction({
      group: null,
      subcommand: "refresh",
      isAdmin: false,
      guild,
      roles: {
        role: { id: "333333333333333333" },
      },
    });

    await Autorole.run({} as any, interaction as any, {} as any);

    expect(interaction.editReply).toHaveBeenCalled();
    expect(getEditReplyPayload(interaction).content).toContain(
      "Discord rate-limited member fetching. Try again in about 12 seconds.",
    );
  });

  it("denies every /autorole refresh variant when command permissions deny it", async () => {
    commandPermissionServiceMock.canUseCommand.mockResolvedValue(false);
    const guild = {
      members: {
        fetch: vi.fn(),
      },
    } as any;

    const noArgInteraction = createInteraction({
      group: null,
      subcommand: "refresh",
      isAdmin: false,
      guild,
    });
    await Autorole.run({} as any, noArgInteraction as any, {} as any);

    const userInteraction = createInteraction({
      group: null,
      subcommand: "refresh",
      isAdmin: false,
      guild,
      users: {
        user: { id: "333333333333333333" },
      },
    });
    await Autorole.run({} as any, userInteraction as any, {} as any);

    const roleInteraction = createInteraction({
      group: null,
      subcommand: "refresh",
      isAdmin: false,
      guild,
      roles: {
        role: { id: "444444444444444444" },
      },
    });
    await Autorole.run({} as any, roleInteraction as any, {} as any);

    for (const interaction of [noArgInteraction, userInteraction, roleInteraction]) {
      expect(interaction.reply).toHaveBeenCalledWith({
        ephemeral: true,
        content: "You do not have permission to use /autorole.",
      });
    }
    expect(autoRoleRefreshServiceMock.refreshGuild).not.toHaveBeenCalled();
    expect(autoRoleRefreshServiceMock.refreshUser).not.toHaveBeenCalled();
    expect(autoRoleRefreshServiceMock.refreshRole).not.toHaveBeenCalled();
  });

  it("keeps non-refresh /autorole subcommands admin-only", async () => {
    const interaction = createInteraction({
      group: "config",
      subcommand: "show",
      isAdmin: false,
    });

    await Autorole.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "You do not have permission to use /autorole.",
    });
    expect(autoRoleServiceMock.getOrCreateGuildConfig).not.toHaveBeenCalled();
  });

  it("rejects /autorole refresh when both user and role are provided", async () => {
    const interaction = createInteraction({
      group: null,
      subcommand: "refresh",
      users: {
        user: { id: "333333333333333333" },
      },
      roles: {
        role: { id: "444444444444444444" },
      },
    });

    await Autorole.run({} as any, interaction as any, {} as any);

    expect(autoRoleRefreshServiceMock.refreshGuild).not.toHaveBeenCalled();
    expect(autoRoleRefreshServiceMock.refreshUser).not.toHaveBeenCalled();
    expect(autoRoleRefreshServiceMock.refreshRole).not.toHaveBeenCalled();
    expect(getEditReplyPayload(interaction).content).toBe(
      "Please choose either user or role for /autorole refresh, not both.",
    );
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
    expect(getDescription(interaction)).toContain("CWL clan role: none");
    expect(getDescription(interaction)).toContain("Visitor role: none");
    expect(getDescription(interaction)).toContain("Visitor role enabled: disabled");
    expect(getDescription(interaction)).toContain("Clan role removal delay: none");
  });

  it("shows a stale visitor role warning when the configured role is missing", async () => {
    autoRoleServiceMock.getOrCreateGuildConfig.mockResolvedValueOnce(
      makeGuildConfig({
        nonMemberRoleId: "777777777777777777",
        nonMemberEnabled: true,
      }),
    );
    const interaction = createInteraction({ group: "config", subcommand: "show" });
    (interaction.guild?.roles?.fetch as any).mockResolvedValueOnce(null);

    await Autorole.run({} as any, interaction as any, {} as any);

    expect(interaction.guild?.roles?.fetch).toHaveBeenCalledWith("777777777777777777");
    expect(getDescription(interaction)).toContain("Visitor role: <@&777777777777777777>");
    expect(getDescription(interaction)).toContain("Visitor role enabled: enabled");
    expect(getDescription(interaction)).toContain("Visitor role warning: missing/deleted");
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

  it("sets and clears the CWL clan role from /autorole config set", async () => {
    const setInteraction = createInteraction({
      group: "config",
      subcommand: "set",
      roles: {
        cwl_clan_role: { id: "555555555555555555" },
      },
    });

    await Autorole.run({} as any, setInteraction as any, {} as any);

    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      cwlClanRoleId: "555555555555555555",
    });

    const clearInteraction = createInteraction({
      group: "config",
      subcommand: "set",
      booleans: {
        clear_cwl_clan_role: true,
      },
    });

    await Autorole.run({} as any, clearInteraction as any, {} as any);

    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      cwlClanRoleId: null,
    });
  });

  it("sets, disables, and re-enables the visitor role from /autorole config set", async () => {
    autoRoleServiceMock.updateGuildConfig.mockResolvedValueOnce({
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
      nonMemberRoleId: "666666666666666666",
      nonMemberEnabled: true,
      clanRoleRemovalDelayMinutes: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const setInteraction = createInteraction({
      group: "config",
      subcommand: "set",
      roles: {
        "non-member-role": { id: "666666666666666666" },
      },
    });
    await Autorole.run({} as any, setInteraction as any, {} as any);
    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      nonMemberRoleId: "666666666666666666",
    });

    autoRoleServiceMock.updateGuildConfig.mockResolvedValueOnce(
      makeGuildConfig({
        nonMemberRoleId: "666666666666666666",
      }),
    );
    const disableInteraction = createInteraction({
      group: "config",
      subcommand: "set",
      booleans: {
        "non-member-enabled": false,
      },
    });
    await Autorole.run({} as any, disableInteraction as any, {} as any);
    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      nonMemberEnabled: false,
    });

    autoRoleServiceMock.updateGuildConfig.mockResolvedValueOnce(
      makeGuildConfig({
        nonMemberRoleId: "666666666666666666",
        nonMemberEnabled: true,
      }),
    );
    const enableInteraction = createInteraction({
      group: "config",
      subcommand: "set",
      booleans: {
        "non-member-enabled": true,
      },
    });
    await Autorole.run({} as any, enableInteraction as any, {} as any);
    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      nonMemberEnabled: true,
    });
  });

  it("fails clearly when enabling the visitor role without a saved role", async () => {
    autoRoleServiceMock.updateGuildConfig.mockRejectedValueOnce(
      new Error("non-member-enabled:true requires a saved role. Set non-member-role first."),
    );

    const interaction = createInteraction({
      group: "config",
      subcommand: "set",
      booleans: {
        "non-member-enabled": true,
      },
    });

    await Autorole.run({} as any, interaction as any, {} as any);

    expect(getEditReplyPayload(interaction).content).toContain(
      "non-member-enabled:true requires a saved role",
    );
  });

  it("sets and clears the clan role removal delay from /autorole config set", async () => {
    const setInteraction = createInteraction({
      group: "config",
      subcommand: "set",
      integers: {
        clan_role_removal_delay_minutes: 60,
      },
    });

    await Autorole.run({} as any, setInteraction as any, {} as any);

    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      clanRoleRemovalDelayMinutes: 60,
    });

    const clearInteraction = createInteraction({
      group: "config",
      subcommand: "set",
      booleans: {
        clear_clan_role_removal_delay: true,
      },
    });

    await Autorole.run({} as any, clearInteraction as any, {} as any);

    expect(autoRoleServiceMock.updateGuildConfig).toHaveBeenCalledWith("111111111111111111", {
      clanRoleRemovalDelayMinutes: null,
    });
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

    const leagueAddInteraction = createInteraction({
      group: "rules",
      subcommand: "add",
      strings: {
        type: "LEAGUE",
        target_value: "Legend League",
      },
      roles: {
        role: { id: "333333333333333333" },
      },
      booleans: {
        enabled: true,
      },
    });

    await Autorole.run({} as any, leagueAddInteraction as any, {} as any);
    expect(autoRoleServiceMock.createRule).toHaveBeenCalledWith("111111111111111111", {
      type: "LEAGUE",
      discordRoleId: "333333333333333333",
      targetValue: "Legend League",
      priority: null,
      enabled: true,
    });
    expect(getEditReplyPayload(leagueAddInteraction).content).toContain("Autorole rule added");

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

