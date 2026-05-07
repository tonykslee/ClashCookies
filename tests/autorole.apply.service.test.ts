import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoRoleApplyService } from "../src/services/AutoRoleApplyService";
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
    ...overrides,
  };
}

function makeMember(displayName = "Old Nick", roleIds: string[] = []): TestMember {
  const roleState = [...roleIds];
  return {
    id: "111111111111111111",
    displayName,
    nickname: displayName,
    user: {
      username: "DiscordUser",
      globalName: "Discord Global",
    },
    roles: {
      cache: {
        keys: () => roleState.values(),
        has: (roleId: string) => roleState.includes(roleId),
      },
      add: vi.fn(async (roleId: string) => {
        if (!roleState.includes(roleId)) {
          roleState.push(roleId);
        }
      }),
      remove: vi.fn(async (roleId: string) => {
        const index = roleState.indexOf(roleId);
        if (index >= 0) {
          roleState.splice(index, 1);
        }
      }),
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

describe("AutoRoleApplyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes stale managed roles and adds new managed roles when desired state changes", async () => {
    const cases = [
      {
        name: "Town Hall 16 to Town Hall 17",
        currentRoleIds: ["111111111111111111"],
        desiredRoleIds: ["222222222222222222"],
        managedRoleIds: new Set(["111111111111111111", "222222222222222222"]),
        expectedAdded: ["222222222222222222"],
        expectedRemoved: ["111111111111111111"],
      },
      {
        name: "Clan A to Clan B",
        currentRoleIds: ["333333333333333333"],
        desiredRoleIds: ["444444444444444444"],
        managedRoleIds: new Set(["333333333333333333", "444444444444444444"]),
        expectedAdded: ["444444444444444444"],
        expectedRemoved: ["333333333333333333"],
      },
      {
        name: "coLeader to member",
        currentRoleIds: ["555555555555555555"],
        desiredRoleIds: ["666666666666666666"],
        managedRoleIds: new Set(["555555555555555555", "666666666666666666"]),
        expectedAdded: ["666666666666666666"],
        expectedRemoved: ["555555555555555555"],
      },
      {
        name: "member to coLeader",
        currentRoleIds: ["666666666666666666"],
        desiredRoleIds: ["555555555555555555"],
        managedRoleIds: new Set(["555555555555555555", "666666666666666666"]),
        expectedAdded: ["555555555555555555"],
        expectedRemoved: ["666666666666666666"],
      },
      {
        name: "Crystal League to Legend League",
        currentRoleIds: ["777777777777777777"],
        desiredRoleIds: ["888888888888888888"],
        managedRoleIds: new Set(["777777777777777777", "888888888888888888"]),
        expectedAdded: ["888888888888888888"],
        expectedRemoved: ["777777777777777777"],
      },
      {
        name: "family role removed when no longer in tracked clan",
        currentRoleIds: ["999999999999999999"],
        desiredRoleIds: [],
        managedRoleIds: new Set(["999999999999999999"]),
        expectedAdded: [],
        expectedRemoved: ["999999999999999999"],
      },
      {
        name: "generic CWL clan role removed when no longer in tracked clan",
        currentRoleIds: ["101010101010101010"],
        desiredRoleIds: [],
        managedRoleIds: new Set(["101010101010101010"]),
        expectedAdded: [],
        expectedRemoved: ["101010101010101010"],
      },
      {
        name: "manual unmanaged roles are preserved",
        currentRoleIds: ["121212121212121212", "131313131313131313"],
        desiredRoleIds: ["131313131313131313"],
        managedRoleIds: new Set(["131313131313131313"]),
        expectedAdded: [],
        expectedRemoved: [],
      },
    ] as const;

    for (const entry of cases) {
      const member = makeMember("Old Nick", [...entry.currentRoleIds]);
      const result = await autoRoleApplyService.applyMember({
        config: makeConfig(),
        managedRoleIds: entry.managedRoleIds,
        member: member as any,
        evaluation: makeEvaluation({ desiredManagedRoleIds: [...entry.desiredRoleIds] }),
        linkedAccounts: [makeLinkedAccount()],
        playerCurrentByTag: new Map([["#2CGG9GGRV", makePlayerCurrent({ playerTag: "#2CGG9GGRV" })]]),
        trackedClans: [{ tag: "#2CGG9GGRV", name: "Tracked Clan", shortName: "TC" }],
      });

      expect(member.roles.add.mock.calls.map((call) => call[0])).toEqual(entry.expectedAdded);
      expect(member.roles.remove.mock.calls.map((call) => call[0])).toEqual(entry.expectedRemoved);
      expect(result.rolesAdded).toEqual(entry.expectedAdded);
      expect(result.rolesRemoved).toEqual(entry.expectedRemoved);
    }
  });

  it("skips nickname sync when disabled", async () => {
    const member = makeMember();
    const result = await autoRoleApplyService.applyMember({
      config: makeConfig({ applyNicknames: false }),
      managedRoleIds: new Set(),
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
      config: makeConfig({ nicknameTemplate: "   " }),
      managedRoleIds: new Set(),
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
      config: makeConfig({ nicknameTemplate: '"{player} | {trackedClans}"' }),
      managedRoleIds: new Set(),
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
      config: makeConfig({ nicknameTemplate: "{player}" }),
      managedRoleIds: new Set(),
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
      config: makeConfig({ nicknameTemplate: "{player}" }),
      managedRoleIds: new Set(),
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
      config: makeConfig({ nicknameTemplate: "{player}" }),
      managedRoleIds: new Set(),
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
});
