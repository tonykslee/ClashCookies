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
    ...overrides,
  };
}

function makeMember(displayName = "Old Nick"): TestMember {
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
        keys: () => [].values(),
        has: () => false,
      },
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    setNickname: vi.fn(async () => undefined),
  };
}

function makeLinkedAccount(tag = "#2CGG9GGRV", playerName = "Alpha"): PlayerLinkWithTrust {
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
