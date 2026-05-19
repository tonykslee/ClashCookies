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
    cwlClanRoleId: null,
    clanRoleRemovalDelayMinutes: null,
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
  verified?: boolean;
  verificationStatus?: "VERIFIED" | "UNVERIFIED" | "REVOKED";
  verificationMethod?: "PLAYER_API_TOKEN" | "DISCORD_OAUTH" | null;
}): PlayerLinkWithTrust {
  return {
    playerTag: input.playerTag,
    discordUserId: "111111111111111111",
    discordUsername: "DiscordUser",
    playerName: "Alpha",
    linkSource: "SELF_SERVICE",
    verificationStatus: input.verificationStatus ?? (input.verified === false ? "UNVERIFIED" : "VERIFIED"),
    verificationMethod:
      input.verificationMethod ?? (input.verified === false ? null : "PLAYER_API_TOKEN"),
    verifiedAt:
      input.verificationStatus === "REVOKED" || input.verified === false
        ? null
        : new Date("2026-04-01T00:00:00.000Z"),
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
  currentClanTag?: string | null;
  role?: "member" | "elder" | "coLeader" | "leader" | null;
}): PlayerCurrentLike {
  return {
    playerTag: input.playerTag,
    playerName: "Alpha",
    townHall: 16,
    currentClanTag: input.currentClanTag ?? "#2QG2C08UP",
    currentClanName: "Clan Name",
    trophies: null,
    builderTrophies: null,
    warStars: null,
    expLevel: null,
    role: input.role ?? null,
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

function makeRule(
  targetValue: string,
  type: AutoRoleRuleType = AutoRoleRuleType.LEAGUE,
) {
  return {
    id: "rule-1",
    guildId: "111111111111111111",
    type,
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
  const trackedClanScope = {
    fwaClanTags: new Set(["#2QG2C08UP"]),
    cwlClanTags: new Set(["#PYLQ0289"]),
    fwaMemberTags: new Set(["#2QG2C08UP"]),
    cwlMemberTags: new Set(["#PYLQ0289"]),
  };

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
      trackedClanScope,
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
      trackedClanScope,
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
      trackedClanScope,
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
      trackedClanScope,
    });

    expect(differentLeagueResult.desiredManagedRoleIds).not.toContain("222222222222222222");
    expect(differentLeagueResult.matchedRuleIds).not.toContain("rule-1");
    expect(missingLeagueResult.desiredManagedRoleIds).not.toContain("222222222222222222");
    expect(missingLeagueResult.matchedRuleIds).not.toContain("rule-1");
  });

  it("grants the CWL clan role and family role for eligible linked accounts in tracked CWL clans", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#PYLQ0289" })];
    const playerCurrentByTag = new Map([
      ["#PYLQ0289", makePlayerCurrent({ playerTag: "#PYLQ0289", currentClanTag: "#QGRJ2222" })],
    ]);

    const result = service.evaluateMember({
      config: makeConfig({
        familyRoleId: "333333333333333333",
        cwlClanRoleId: "444444444444444444",
      }),
      rules: [],
      managedRoleIds: new Set(["333333333333333333", "444444444444444444"]),
      member,
      linkedAccounts,
      playerCurrentByTag,
      clanMembershipByTag,
      trackedClanScope,
    });

    expect(result.desiredManagedRoleIds).toEqual([
      "333333333333333333",
      "444444444444444444",
    ]);
  });

  it("grants the family role for eligible linked accounts in tracked FWA clans", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#PYLQ0289" })];
    const playerCurrentByTag = new Map([
      ["#PYLQ0289", makePlayerCurrent({ playerTag: "#PYLQ0289", currentClanTag: "#QGRJ2222" })],
    ]);
    const fwaTrackedScope = {
      ...trackedClanScope,
      fwaMemberTags: new Set(["#PYLQ0289"]),
      cwlMemberTags: new Set<string>(),
    };

    const result = service.evaluateMember({
      config: makeConfig({
        familyRoleId: "333333333333333333",
        cwlClanRoleId: "444444444444444444",
      }),
      rules: [],
      managedRoleIds: new Set(["333333333333333333", "444444444444444444"]),
      member,
      linkedAccounts,
      playerCurrentByTag,
      clanMembershipByTag,
      trackedClanScope: fwaTrackedScope,
    });

    expect(result.desiredManagedRoleIds).toEqual(["333333333333333333"]);
  });

  it("matches clan roles from current clan tags as before", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#2QG2C08UP" })];
    const playerCurrentByTag = new Map([
      ["#2QG2C08UP", makePlayerCurrent({ playerTag: "#2QG2C08UP", currentClanTag: "#2QG2C08UP" })],
    ]);

    const result = service.evaluateMember({
      config: makeConfig({
        familyRoleId: "333333333333333333",
        cwlClanRoleId: "444444444444444444",
      }),
      rules: [
        {
          id: "rule-1",
          guildId: "111111111111111111",
          type: AutoRoleRuleType.CLAN,
          targetValue: "#2QG2C08UP",
          discordRoleId: "555555555555555555",
          priority: 100,
          enabled: true,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ],
      managedRoleIds: new Set(["333333333333333333", "444444444444444444", "555555555555555555"]),
      member,
      linkedAccounts,
      playerCurrentByTag,
      clanMembershipByTag,
      trackedClanScope,
    });

    expect(result.desiredManagedRoleIds).toContain("555555555555555555");
    expect(result.matchedRuleIds).toContain("rule-1");
  });

  it("prefers fresh current-clan tags over stale clan membership when requested", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#2QG2C08UP" })];
    const playerCurrentByTag = new Map([
      ["#2QG2C08UP", makePlayerCurrent({ playerTag: "#2QG2C08UP", currentClanTag: "#QGRJ2222" })],
    ]);
    const staleClanMembershipByTag: AutoRoleClanMembershipIndex = new Map([
      ["#2QG2C08UP", { source: "FWA", playerTags: new Set(["#2QG2C08UP"]) }],
    ]);

    const result = service.evaluateMember({
      config: makeConfig(),
      rules: [
        {
          id: "rule-1",
          guildId: "111111111111111111",
          type: AutoRoleRuleType.CLAN,
          targetValue: "#2QG2C08UP",
          discordRoleId: "555555555555555555",
          priority: 100,
          enabled: true,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ],
      managedRoleIds: new Set(["555555555555555555"]),
      member,
      linkedAccounts,
      playerCurrentByTag,
      clanMembershipByTag: staleClanMembershipByTag,
      trackedClanScope,
      preferCurrentClanTagForClanRules: true,
    });

    expect(result.desiredManagedRoleIds).not.toContain("555555555555555555");
    expect(result.matchedRuleIds).not.toContain("rule-1");
  });

  it("does not grant tracked-clan roles to untrusted or revoked links when trusted links are disabled", () => {
    const member = makeMember();
    const untrustedLink = makeLinkedAccount({ playerTag: "#PYLQ0289", verified: false });
    const revokedLink = {
      ...makeLinkedAccount({ playerTag: "#QGRJ2222" }),
      verificationStatus: "REVOKED" as const,
      verificationMethod: null,
      verifiedAt: null,
    };
    const playerCurrentByTag = new Map([
      ["#PYLQ0289", makePlayerCurrent({ playerTag: "#PYLQ0289", currentClanTag: "#PYLQ0289" })],
      ["#QGRJ2222", makePlayerCurrent({ playerTag: "#QGRJ2222", currentClanTag: "#PYLQ0289" })],
    ]);

    const result = service.evaluateMember({
      config: makeConfig({
        trustedLinksAllowed: false,
        verifiedOnlyMode: true,
        familyRoleId: "333333333333333333",
        cwlClanRoleId: "444444444444444444",
      }),
      rules: [],
      managedRoleIds: new Set(["333333333333333333", "444444444444444444"]),
      member,
      linkedAccounts: [untrustedLink, revokedLink as PlayerLinkWithTrust],
      playerCurrentByTag,
      clanMembershipByTag,
      trackedClanScope,
    });

    expect(result.desiredManagedRoleIds).toEqual([]);
  });

  it("does not grant family or CWL clan roles when the linked account is in neither tracked scope", () => {
    const member = makeMember();
    const linkedAccounts = [makeLinkedAccount({ playerTag: "#QGRJ2222" })];
    const playerCurrentByTag = new Map([
      ["#QGRJ2222", makePlayerCurrent({ playerTag: "#QGRJ2222", currentClanTag: "#QGRJ2222" })],
    ]);

    const result = service.evaluateMember({
      config: makeConfig({
        familyRoleId: "333333333333333333",
        cwlClanRoleId: "444444444444444444",
      }),
      rules: [],
      managedRoleIds: new Set(["333333333333333333", "444444444444444444"]),
      member,
      linkedAccounts,
      playerCurrentByTag,
      clanMembershipByTag,
      trackedClanScope,
    });

    expect(result.desiredManagedRoleIds).toEqual([]);
  });

  it("grants the leader clan role only when the linked account is in a tracked FWA clan", () => {
    const member = makeMember();
    const rule = makeRule("leader", AutoRoleRuleType.CLAN_ROLE);
    const trackedClanResult = service.evaluateMember({
      config: makeConfig(),
      rules: [rule],
      managedRoleIds: new Set([rule.discordRoleId]),
      member,
      linkedAccounts: [makeLinkedAccount({ playerTag: "#2QG2C08UP" })],
      playerCurrentByTag: new Map([
        [
          "#2QG2C08UP",
          makePlayerCurrent({
            playerTag: "#2QG2C08UP",
            currentClanTag: "#2QG2C08UP",
            role: "leader",
          }),
        ],
      ]),
      clanMembershipByTag,
      trackedClanScope,
    });

    expect(trackedClanResult.desiredManagedRoleIds).toContain(rule.discordRoleId);
    expect(trackedClanResult.matchedRuleIds).toContain(rule.id);
  });

  it("does not grant the leader clan role for a linked account in a tracked clan that is not FWA", () => {
    const member = makeMember();
    const rule = makeRule("leader", AutoRoleRuleType.CLAN_ROLE);
    const cwlTrackedButNotFwaResult = service.evaluateMember({
      config: makeConfig(),
      rules: [rule],
      managedRoleIds: new Set([rule.discordRoleId]),
      member,
      linkedAccounts: [makeLinkedAccount({ playerTag: "#PYLQ0289" })],
      playerCurrentByTag: new Map([
        [
          "#PYLQ0289",
          makePlayerCurrent({
            playerTag: "#PYLQ0289",
            currentClanTag: "#PYLQ0289",
            role: "leader",
          }),
        ],
      ]),
      clanMembershipByTag,
      trackedClanScope,
    });

    expect(cwlTrackedButNotFwaResult.desiredManagedRoleIds).not.toContain(rule.discordRoleId);
    expect(cwlTrackedButNotFwaResult.matchedRuleIds).not.toContain(rule.id);
  });

  it("does not grant the leader clan role for a linked account in an untracked clan", () => {
    const member = makeMember();
    const rule = makeRule("leader", AutoRoleRuleType.CLAN_ROLE);
    const untrackedClanResult = service.evaluateMember({
      config: makeConfig(),
      rules: [rule],
      managedRoleIds: new Set([rule.discordRoleId]),
      member,
      linkedAccounts: [makeLinkedAccount({ playerTag: "#QGRJ2222" })],
      playerCurrentByTag: new Map([
        [
          "#QGRJ2222",
          makePlayerCurrent({
            playerTag: "#QGRJ2222",
            currentClanTag: "#QGRJ2222",
            role: "leader",
          }),
        ],
      ]),
      clanMembershipByTag,
      trackedClanScope,
    });

    expect(untrackedClanResult.desiredManagedRoleIds).not.toContain(rule.discordRoleId);
    expect(untrackedClanResult.matchedRuleIds).not.toContain(rule.id);
  });
});
