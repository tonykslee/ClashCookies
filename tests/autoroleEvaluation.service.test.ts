import { AutoRoleRuleType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { AutoRoleEvaluationService } from "../src/services/AutoRoleEvaluationService";
import type {
  AutoRoleClanMembershipIndex,
  AutoRoleGuildConfigSnapshot,
  AutoRoleEvaluationMemberLike,
} from "../src/services/AutoRoleEvaluationService";
import type { PlayerCurrentLike } from "../src/services/PlayerCurrentService";
import type { PlayerLinkWithTrust } from "../src/services/PlayerLinkService";

function makeConfig(overrides: Partial<AutoRoleGuildConfigSnapshot> = {}): AutoRoleGuildConfigSnapshot {
  return {
    enabled: true,
    killSwitchEnabled: false,
    removeStaleManagedRoles: true,
    applyNicknames: false,
    nicknameTemplate: null,
    trustedLinksAllowed: true,
    verifiedOnlyMode: false,
    verifiedRoleId: null,
    familyRoleId: null,
    ...overrides,
  };
}

function makeMember(id = "111111111111111111"): AutoRoleEvaluationMemberLike {
  return {
    id,
    displayName: "Member",
    nickname: null,
    user: {
      username: "DiscordUser",
      globalName: null,
    },
    roles: {
      cache: {
        keys: () => [].values(),
        has: () => false,
      },
      add: async () => undefined,
      remove: async () => undefined,
    },
  };
}

function makeLinkedAccount(input: {
  playerTag: string;
}): PlayerLinkWithTrust {
  return {
    playerTag: input.playerTag,
    discordUserId: "111111111111111111",
    discordUsername: "DiscordUser",
    playerName: "Alpha",
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

function makePlayerCurrent(input: {
  playerTag: string;
  leagueName?: string | null;
}): PlayerCurrentLike {
  return {
    playerTag: input.playerTag,
    playerName: "Alpha",
    townHall: 16,
    currentClanTag: "#2QG2C08UP",
    currentClanName: "Clan Name",
    trophies: null,
    builderTrophies: null,
    warStars: null,
    expLevel: null,
    role: null,
    leagueName: input.leagueName ?? null,
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

function makeRule(targetValue: string) {
  return {
    id: "rule-1",
    guildId: "111111111111111111",
    type: AutoRoleRuleType.LEAGUE,
    targetValue,
    discordRoleId: "222222222222222222",
    priority: 100,
    enabled: true,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

describe("AutoRoleEvaluationService league rules", () => {
  const service = new AutoRoleEvaluationService();
  const clanMembershipByTag: AutoRoleClanMembershipIndex = new Map();

  it("matches a linked account with leagueName set to Legend League", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#2QG2C08UP" })];
    const playerCurrentByTag = new Map([
      ["#2QG2C08UP", makePlayerCurrent({ playerTag: "#2QG2C08UP", leagueName: "Legend League" })],
    ]);

    const result = service.evaluateMember({
      config: makeConfig(),
      rules: [makeRule("Legend League")],
      managedRoleIds: new Set(["222222222222222222"]),
      member,
      linkedAccounts,
      playerCurrentByTag,
      clanMembershipByTag,
    });

    expect(result.desiredManagedRoleIds).toContain("222222222222222222");
    expect(result.matchedRuleIds).toContain("rule-1");
  });

  it("matches case-insensitively and with normalized whitespace", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#2QG2C08UP" })];
    const playerCurrentByTag = new Map([
      ["#2QG2C08UP", makePlayerCurrent({ playerTag: "#2QG2C08UP", leagueName: "  LEGEND   league  " })],
    ]);

    const result = service.evaluateMember({
      config: makeConfig(),
      rules: [makeRule("legend league")],
      managedRoleIds: new Set(["222222222222222222"]),
      member,
      linkedAccounts,
      playerCurrentByTag,
      clanMembershipByTag,
    });

    expect(result.desiredManagedRoleIds).toContain("222222222222222222");
    expect(result.matchedRuleIds).toContain("rule-1");
  });

  it("does not match when the league differs or is missing", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#2QG2C08UP" })];
    const differentLeagueResult = service.evaluateMember({
      config: makeConfig(),
      rules: [makeRule("Titan League")],
      managedRoleIds: new Set(["222222222222222222"]),
      member,
      linkedAccounts,
      playerCurrentByTag: new Map([
        ["#2QG2C08UP", makePlayerCurrent({ playerTag: "#2QG2C08UP", leagueName: "Legend League" })],
      ]),
      clanMembershipByTag,
    });

    const missingLeagueResult = service.evaluateMember({
      config: makeConfig(),
      rules: [makeRule("Legend League")],
      managedRoleIds: new Set(["222222222222222222"]),
      member,
      linkedAccounts,
      playerCurrentByTag: new Map([
        ["#2QG2C08UP", makePlayerCurrent({ playerTag: "#2QG2C08UP", leagueName: null })],
      ]),
      clanMembershipByTag,
    });

    expect(differentLeagueResult.desiredManagedRoleIds).not.toContain("222222222222222222");
    expect(differentLeagueResult.matchedRuleIds).not.toContain("rule-1");
    expect(missingLeagueResult.desiredManagedRoleIds).not.toContain("222222222222222222");
    expect(missingLeagueResult.matchedRuleIds).not.toContain("rule-1");
  });
});
