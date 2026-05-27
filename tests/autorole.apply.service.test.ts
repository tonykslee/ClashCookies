import { AutoRoleRuleType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoRoleApplyService } from "../src/services/AutoRoleApplyService";
const prismaMock = vi.hoisted(() => ({
  autoRolePendingRemoval: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import type { AutoRoleGuildConfigSnapshot, AutoRoleMemberEvaluation } from "../src/services/AutoRoleEvaluationService";
import type { AutoRoleNicknameTrackedClanLike } from "../src/services/AutoRoleNicknameService";
import type { PlayerCurrentLike } from "../src/services/PlayerCurrentService";
import type { PlayerLinkWithTrust } from "../src/services/PlayerLinkService";

type TestMember = {
  id: string;
  displayName: string;
  nickname: string | null;
  user: {
    username: string | null;
    globalName: string | null;
  };
  roles: {
    cache: {
      keys(): IterableIterator<string>;
      has(roleId: string): boolean;
    };
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  setNickname: ReturnType<typeof vi.fn>;
};

function makeConfig(overrides: Partial<AutoRoleGuildConfigSnapshot> = {}): AutoRoleGuildConfigSnapshot {
  return {
    enabled: true,
    killSwitchEnabled: false,
    removeStaleManagedRoles: true,
    applyNicknames: true,
    nicknameTemplate: "{player}",
    trustedLinksAllowed: true,
    verifiedOnlyMode: false,
    verifiedRoleId: null,
    familyRoleId: null,
    cwlClanRoleId: null,
    nonMemberRoleId: null,
    nonMemberEnabled: false,
    clanRoleRemovalDelayMinutes: null,
    ...overrides,
  };
}

function makeMember(displayName = "Old Nick", roleIds: string[] = [], bot = false): TestMember {
  const roleState = [...roleIds];
  return {
    id: "111111111111111111",
    displayName,
    nickname: displayName,
    user: {
      username: "DiscordUser",
      globalName: "Discord Global",
      bot,
    },
    roles: {
      cache: {
        keys: () => roleState.values(),
        has: (roleId: string) => roleState.includes(roleId),
      },
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    setNickname: vi.fn(async () => undefined),
  };
}

function makeLinkedAccount(tag = "#2CGG9GGRV", playerName: string | null = "Alpha"): PlayerLinkWithTrust {
  return {
    playerTag: tag,
    discordUserId: "111111111111111111",
    discordUsername: "DiscordUser",
    playerName,
    linkSource: "SELF_SERVICE",
    verificationStatus: "VERIFIED",
    verificationMethod: "PLAYER_API_TOKEN",
    verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
    verifiedByDiscordUserId: null,
    lastVerifiedAt: null,
    verificationFailureReason: null,
    importBatchKey: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

function makePlayerCurrent(overrides: Partial<PlayerCurrentLike> & Pick<PlayerCurrentLike, "playerTag">): PlayerCurrentLike {
  return {
    playerTag: overrides.playerTag,
    playerName: overrides.playerName ?? null,
    townHall: overrides.townHall ?? 16,
    currentClanTag: overrides.currentClanTag ?? "#2CGG9GGRV",
    currentClanName: overrides.currentClanName ?? "Tracked Clan",
    trophies: null,
    builderTrophies: null,
    warStars: null,
    expLevel: null,
    role: null,
    leagueName: null,
    currentWeight: null,
    currentWeightSource: null,
    currentWeightMeasuredAt: null,
    achievementsJson: null,
    lastSeenAt: null,
    lastFetchedAt: null,
    lastSource: null,
    createdAt: null,
    updatedAt: null,
    source: "player_current",
    liveRefreshInvoked: false,
  };
}

function makeEvaluation(overrides: Partial<AutoRoleMemberEvaluation> = {}): AutoRoleMemberEvaluation {
  return {
    discordUserId: "111111111111111111",
    skipReason: null,
    desiredManagedRoleIds: [],
    matchedRuleIds: [],
    primaryPlayerTag: "#2CGG9GGRV",
    primaryPlayerName: "Alpha",
    resultHash: "hash-1",
    ...overrides,
  };
}

function makeRule(input: {
  id?: string;
  type: AutoRoleRuleType;
  discordRoleId: string;
  targetValue?: string;
}) {
  return {
    id: input.id ?? `rule-${input.discordRoleId}`,
    guildId: "111111111111111111",
    type: input.type,
    targetValue: input.targetValue ?? "__target__",
    discordRoleId: input.discordRoleId,
    priority: 100,
    enabled: true,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  } as any;
}

describe("AutoRoleApplyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.autoRolePendingRemoval.findMany.mockResolvedValue([]);
    prismaMock.autoRolePendingRemoval.upsert.mockResolvedValue({});
    prismaMock.autoRolePendingRemoval.deleteMany.mockResolvedValue({});
  });

  it("skips nickname sync when disabled", async () => {
    const member = makeMember();
    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ applyNicknames: false }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV" })]]),
      trackedClans: [{ tag: "#2CGG9GGRV", name: "Tracked Clan", shortName: "TC" }],
    });

    expect(member.setNickname).not.toHaveBeenCalled();
    expect(result.nicknameStatus).toBe("skipped");
    expect(result.nicknameReason).toBe("nickname sync disabled");
  });

  it("skips nickname sync when the template is not configured", async () => {
    const member = makeMember();
    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ nicknameTemplate: "   " }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV" })]]),
      trackedClans: [{ tag: "#2CGG9GGRV", name: "Tracked Clan", shortName: "TC" }],
    });

    expect(member.setNickname).not.toHaveBeenCalled();
    expect(result.nicknameStatus).toBe("skipped");
    expect(result.nicknameReason).toBe("nickname template not configured");
  });

  it("skips nickname sync when rendering produces only separators", async () => {
    const member = makeMember();
    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ nicknameTemplate: '"{player} | {trackedClans}"' }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [
        makeLinkedAccount("#2CGG9GGRV", null),
      ],
      playerCurrentByTag: new Map([
        [
          "#2CGG9GGRV",
          makePlayerCurrent({
            playerTag: "#2CGG9GGRV",
            playerName: null,
            currentClanTag: null,
            currentClanName: null,
          }),
        ],
      ]),
      trackedClans: [],
    });

    expect(member.setNickname).not.toHaveBeenCalled();
    expect(result.nicknameStatus).toBe("skipped");
    expect(result.nicknameReason).toBe("nickname template rendered empty");
  });

  it("returns unchanged when the rendered nickname already matches", async () => {
    const member = makeMember("Alpha");
    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ nicknameTemplate: "{player}" }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", playerName: "Alpha" })]]),
      trackedClans: [{ tag: "#2CGG9GGRV", name: "Tracked Clan", shortName: "TC" }],
    });

    expect(member.setNickname).not.toHaveBeenCalled();
    expect(result.nicknameStatus).toBe("unchanged");
    expect(result.status).toBe("skipped");
  });

  it("applies a rendered nickname when it differs from the current display nickname", async () => {
    const member = makeMember("Old Nick");
    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ nicknameTemplate: "{player}" }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", playerName: "Alpha" })]]),
      trackedClans: [{ tag: "#2CGG9GGRV", name: "Tracked Clan", shortName: "TC" }],
    });

    expect(member.setNickname).toHaveBeenCalledWith("Alpha");
    expect(result.nicknameStatus).toBe("changed");
    expect(result.status).toBe("applied");
  });

  it("captures nickname permission failures without crashing", async () => {
    const member = makeMember("Old Nick");
    member.setNickname.mockRejectedValueOnce(new Error("Missing Permissions"));

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ nicknameTemplate: "{player}" }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", playerName: "Alpha" })]]),
      trackedClans: [{ tag: "#2CGG9GGRV", name: "Tracked Clan", shortName: "TC" }],
    });

    expect(member.setNickname).toHaveBeenCalledWith("Alpha");
    expect(result.nicknameStatus).toBe("failed");
    expect(result.failureReasons[0]).toContain("nickname update failed");
    expect(result.status).toBe("failed");
  });

  it("adds the visitor role for non-family members when enabled", async () => {
    const visitorRoleId = "555555555555555555";
    const member = makeMember("Alpha");

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ applyNicknames: false, nonMemberEnabled: true, nonMemberRoleId: visitorRoleId }),
      managedRoleIds: new Set([visitorRoleId]),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount("#PYLQ0289", "Beta")],
      playerCurrentByTag: new Map(),
      trackedClans: [],
      trackedFwaMemberTags: new Set(["#2QG2C08UP"]),
    });

    expect(member.roles.add).toHaveBeenCalledWith(visitorRoleId);
    expect(member.roles.remove).not.toHaveBeenCalledWith(visitorRoleId);
    expect(result.rolesAdded).toEqual([visitorRoleId]);
    expect(result.rolesRemoved).toEqual([]);
  });

  it("leaves the visitor role alone when it is already correct", async () => {
    const visitorRoleId = "555555555555555555";
    const member = makeMember("Alpha", [visitorRoleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ applyNicknames: false, nonMemberEnabled: true, nonMemberRoleId: visitorRoleId }),
      managedRoleIds: new Set([visitorRoleId]),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount("#PYLQ0289", "Beta")],
      playerCurrentByTag: new Map(),
      trackedClans: [],
      trackedFwaMemberTags: new Set(["#2QG2C08UP"]),
    });

    expect(member.roles.add).not.toHaveBeenCalledWith(visitorRoleId);
    expect(member.roles.remove).not.toHaveBeenCalledWith(visitorRoleId);
    expect(result.rolesAdded).toEqual([]);
    expect(result.rolesRemoved).toEqual([]);
  });

  it("removes the visitor role from family members even when stale removal is disabled", async () => {
    const visitorRoleId = "555555555555555555";
    const member = makeMember("Alpha", [visitorRoleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: false,
        nonMemberEnabled: true,
        nonMemberRoleId: visitorRoleId,
      }),
      managedRoleIds: new Set([visitorRoleId]),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount("#2QG2C08UP", "Alpha")],
      playerCurrentByTag: new Map(),
      trackedClans: [],
      trackedFwaMemberTags: new Set(["#2QG2C08UP"]),
    });

    expect(member.roles.remove).toHaveBeenCalledWith(visitorRoleId);
    expect(result.rolesRemoved).toEqual([visitorRoleId]);
  });

  it("does not change the visitor role for bots", async () => {
    const visitorRoleId = "555555555555555555";
    const member = makeMember("Alpha", [visitorRoleId], true);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ applyNicknames: false, nonMemberEnabled: true, nonMemberRoleId: visitorRoleId }),
      managedRoleIds: new Set([visitorRoleId]),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount("#PYLQ0289", "Beta")],
      playerCurrentByTag: new Map(),
      trackedClans: [],
      trackedFwaMemberTags: new Set(["#2QG2C08UP"]),
    });

    expect(member.roles.add).not.toHaveBeenCalledWith(visitorRoleId);
    expect(member.roles.remove).not.toHaveBeenCalledWith(visitorRoleId);
    expect(result.rolesAdded).toEqual([]);
    expect(result.rolesRemoved).toEqual([]);
  });

  it("leaves the visitor role untouched when the config is disabled", async () => {
    const visitorRoleId = "555555555555555555";
    const member = makeMember("Alpha", [visitorRoleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ applyNicknames: false, nonMemberEnabled: false, nonMemberRoleId: visitorRoleId }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount("#PYLQ0289", "Beta")],
      playerCurrentByTag: new Map(),
      trackedClans: [],
      trackedFwaMemberTags: new Set(),
    });

    expect(member.roles.add).not.toHaveBeenCalledWith(visitorRoleId);
    expect(member.roles.remove).not.toHaveBeenCalledWith(visitorRoleId);
    expect(result.rolesAdded).toEqual([]);
    expect(result.rolesRemoved).toEqual([]);
  });

  it("removes stale CLAN roles immediately when no delay is configured", async () => {
    const roleId = "222222222222222222";
    const member = makeMember("Alpha", [roleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true, clanRoleRemovalDelayMinutes: null }),
      managedRoleIds: new Set([roleId]),
      rules: [makeRule({ type: AutoRoleRuleType.CLAN, discordRoleId: roleId, targetValue: "#2CGG9GGRV" })],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", currentClanTag: "#OTHER" })]]),
      trackedClans: [],
      now: new Date("2026-04-01T00:00:00.000Z"),
    });

    expect(member.roles.remove).toHaveBeenCalledWith(roleId);
    expect(result.rolesRemoved).toEqual([roleId]);
    expect(prismaMock.autoRolePendingRemoval.upsert).not.toHaveBeenCalled();
  });

  it("keeps a stale CLAN role on the first missing refresh when delay is configured", async () => {
    const roleId = "222222222222222222";
    const now = new Date("2026-04-01T01:00:00.000Z");
    const member = makeMember("Alpha", [roleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true, clanRoleRemovalDelayMinutes: 60 }),
      managedRoleIds: new Set([roleId]),
      rules: [makeRule({ type: AutoRoleRuleType.CLAN, discordRoleId: roleId, targetValue: "#2CGG9GGRV" })],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", currentClanTag: "#OTHER" })]]),
      trackedClans: [],
      now,
    });

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(result.rolesRemoved).toEqual([]);
    expect(prismaMock.autoRolePendingRemoval.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId_discordUserId_discordRoleId_ruleId: expect.objectContaining({
            guildId: "111111111111111111",
            discordUserId: "111111111111111111",
            discordRoleId: roleId,
          }),
        }),
      }),
    );
  });

  it("keeps a stale CLAN role at 59 minutes but removes it at 61 minutes", async () => {
    const roleId = "222222222222222222";
    const rule = makeRule({ type: AutoRoleRuleType.CLAN, discordRoleId: roleId, targetValue: "#2CGG9GGRV" });
    const member = makeMember("Alpha", [roleId]);
    const base = new Date("2026-04-01T01:00:00.000Z");

    prismaMock.autoRolePendingRemoval.findMany.mockResolvedValueOnce([
      {
        ruleId: rule.id,
        discordRoleId: roleId,
        firstMissingAt: new Date(base.getTime() - 59 * 60_000),
        lastCheckedAt: new Date(base.getTime() - 59 * 60_000),
      },
    ]).mockResolvedValueOnce([
      {
        ruleId: rule.id,
        discordRoleId: roleId,
        firstMissingAt: new Date(base.getTime() - 61 * 60_000),
        lastCheckedAt: new Date(base.getTime() - 61 * 60_000),
      },
    ]);

    const keepResult = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true, clanRoleRemovalDelayMinutes: 60 }),
      managedRoleIds: new Set([roleId]),
      rules: [rule],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", currentClanTag: "#OTHER" })]]),
      trackedClans: [],
      now: base,
    });

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(keepResult.rolesRemoved).toEqual([]);

    const removeMember = makeMember("Alpha", [roleId]);
    const removeResult = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true, clanRoleRemovalDelayMinutes: 60 }),
      managedRoleIds: new Set([roleId]),
      rules: [rule],
      member: removeMember as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", currentClanTag: "#OTHER" })]]),
      trackedClans: [],
      now: base,
    });

    expect(removeMember.roles.remove).toHaveBeenCalledWith(roleId);
    expect(removeResult.rolesRemoved).toEqual([roleId]);
    expect(prismaMock.autoRolePendingRemoval.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "111111111111111111",
          discordUserId: "111111111111111111",
          discordRoleId: { in: [roleId] },
        }),
      }),
    );
  });

  it("preserves a stale lead role when removal is suppressed for the current refresh scope", async () => {
    const roleId = "222222222222222222";
    const member = makeMember("Alpha", [roleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true }),
      managedRoleIds: new Set([roleId]),
      suppressRemovalRoleIds: new Set([roleId]),
      rules: [makeRule({ type: AutoRoleRuleType.CLAN, discordRoleId: roleId, targetValue: "#2CGG9GGRV" })],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", currentClanTag: "#OTHER" })]]),
      trackedClans: [],
      now: new Date("2026-04-01T01:00:00.000Z"),
    });

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(result.rolesRemoved).toEqual([]);
    expect(prismaMock.autoRolePendingRemoval.upsert).not.toHaveBeenCalled();
  });

  it("clears pending clan removals when the member is desired again", async () => {
    const roleId = "222222222222222222";
    const rule = makeRule({ type: AutoRoleRuleType.CLAN, discordRoleId: roleId, targetValue: "#2CGG9GGRV" });
    const member = makeMember("Alpha", [roleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true, clanRoleRemovalDelayMinutes: 60 }),
      managedRoleIds: new Set([roleId]),
      rules: [rule],
      member: member as any,
      evaluation: makeEvaluation({ desiredManagedRoleIds: [roleId], matchedRuleIds: [rule.id] }),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV" })]]),
      trackedClans: [],
      now: new Date("2026-04-01T01:00:00.000Z"),
    });

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(result.rolesRemoved).toEqual([]);
    expect(prismaMock.autoRolePendingRemoval.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guildId: "111111111111111111",
          discordUserId: "111111111111111111",
          discordRoleId: { in: [roleId] },
        }),
      }),
    );
  });

  it.each([
    { label: "Town Hall", type: AutoRoleRuleType.TOWN_HALL, targetValue: "17" },
    { label: "League", type: AutoRoleRuleType.LEAGUE, targetValue: "Legend League" },
    { label: "Clan Rank", type: AutoRoleRuleType.CLAN_ROLE, targetValue: "leader" },
  ])("removes stale $label roles immediately even with a delay configured", async ({ type, targetValue }) => {
    const roleId = "222222222222222222";
    const member = makeMember("Alpha", [roleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true, clanRoleRemovalDelayMinutes: 60 }),
      managedRoleIds: new Set([roleId]),
      rules: [makeRule({ type, discordRoleId: roleId, targetValue })],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", currentClanTag: "#OTHER" })]]),
      trackedClans: [],
      now: new Date("2026-04-01T01:00:00.000Z"),
    });

    expect(member.roles.remove).toHaveBeenCalledWith(roleId);
    expect(result.rolesRemoved).toEqual([roleId]);
    expect(prismaMock.autoRolePendingRemoval.upsert).not.toHaveBeenCalled();
  });

  it("keeps Family and generic CWL clan roles immediate when stale even with a delay configured", async () => {
    const familyRoleId = "333333333333333333";
    const cwlClanRoleId = "444444444444444444";
    const member = makeMember("Alpha", [familyRoleId, cwlClanRoleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({
        removeStaleManagedRoles: true,
        familyRoleId,
        cwlClanRoleId,
        clanRoleRemovalDelayMinutes: 60,
      }),
      managedRoleIds: new Set([familyRoleId, cwlClanRoleId]),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV", currentClanTag: "#OTHER" })]]),
      trackedClans: [],
      now: new Date("2026-04-01T01:00:00.000Z"),
    });

    expect(member.roles.remove).toHaveBeenCalledWith(familyRoleId);
    expect(member.roles.remove).toHaveBeenCalledWith(cwlClanRoleId);
    expect(result.rolesRemoved).toEqual(expect.arrayContaining([familyRoleId, cwlClanRoleId]));
  });

  it("leaves unmanaged manual roles untouched", async () => {
    const unmanagedRoleId = "999999999999999999";
    const member = makeMember("Alpha", [unmanagedRoleId]);

    const result = await autoRoleApplyService.applyMember({
      guildId: "111111111111111111",
      config: makeConfig({ removeStaleManagedRoles: true }),
      managedRoleIds: new Set(),
      rules: [],
      member: member as any,
      evaluation: makeEvaluation(),
      linkedAccounts: [makeLinkedAccount()],
      playerCurrentByTag: new Map(),
      trackedClans: [],
      now: new Date("2026-04-01T01:00:00.000Z"),
    });

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.cache.has(unmanagedRoleId)).toBe(true);
    expect(result.rolesRemoved).toEqual([]);
  });
});
