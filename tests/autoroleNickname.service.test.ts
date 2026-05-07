import { describe, expect, it } from "vitest";
import { AutoRoleNicknameService, type AutoRoleNicknameRenderInput } from "../src/services/AutoRoleNicknameService";
import type { AutoRoleGuildConfigSnapshot } from "../src/services/AutoRoleEvaluationService";
import type { PlayerCurrentLike } from "../src/services/PlayerCurrentService";
import type { PlayerLinkWithTrust } from "../src/services/PlayerLinkService";

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

function makeMember(overrides: Partial<AutoRoleNicknameRenderInput["member"]> = {}): AutoRoleNicknameRenderInput["member"] {
  return {
    id: "111111111111111111",
    displayName: "D",
    user: {
      username: "U",
      globalName: "DG",
    },
    ...overrides,
  };
}

function makeLink(overrides: Partial<PlayerLinkWithTrust> & Pick<PlayerLinkWithTrust, "playerTag">): PlayerLinkWithTrust {
  return {
    playerTag: overrides.playerTag,
    discordUserId: overrides.discordUserId ?? "111111111111111111",
    discordUsername: overrides.discordUsername ?? "Discord User",
    playerName: overrides.playerName ?? null,
    linkSource: overrides.linkSource ?? "LEGACY",
    verificationStatus: overrides.verificationStatus ?? "UNVERIFIED",
    verificationMethod: overrides.verificationMethod ?? null,
    verifiedAt: overrides.verifiedAt ?? null,
    verifiedByDiscordUserId: overrides.verifiedByDiscordUserId ?? null,
    lastVerifiedAt: overrides.lastVerifiedAt ?? null,
    verificationFailureReason: overrides.verificationFailureReason ?? null,
    importBatchKey: overrides.importBatchKey ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-01T00:00:00.000Z"),
  };
}

function makePlayerCurrent(overrides: Partial<PlayerCurrentLike> & Pick<PlayerCurrentLike, "playerTag">): PlayerCurrentLike {
  return {
    playerTag: overrides.playerTag,
    playerName: overrides.playerName ?? null,
    townHall: overrides.townHall ?? null,
    currentClanTag: overrides.currentClanTag ?? null,
    currentClanName: overrides.currentClanName ?? null,
    trophies: overrides.trophies ?? null,
    builderTrophies: overrides.builderTrophies ?? null,
    warStars: overrides.warStars ?? null,
    expLevel: overrides.expLevel ?? null,
    role: overrides.role ?? null,
    leagueName: overrides.leagueName ?? null,
    currentWeight: overrides.currentWeight ?? null,
    currentWeightSource: overrides.currentWeightSource ?? null,
    currentWeightMeasuredAt: overrides.currentWeightMeasuredAt ?? null,
    achievementsJson: overrides.achievementsJson ?? null,
    lastSeenAt: overrides.lastSeenAt ?? null,
    lastFetchedAt: overrides.lastFetchedAt ?? null,
    lastSource: overrides.lastSource ?? null,
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null,
    source: overrides.source ?? "player_current",
    liveRefreshInvoked: overrides.liveRefreshInvoked ?? false,
  };
}

describe("AutoRoleNicknameService", () => {
  const service = new AutoRoleNicknameService();

  it("renders the basic template from the selected linked account", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{player} ({tag}) TH{th} {clanShort} {discord} {username} {role}",
      member: makeMember(),
      linkedAccounts: [
        makeLink({
          playerTag: "#2QG2C08UP",
          playerName: "Untracked",
        }),
        makeLink({
          playerTag: "#2CGG9GGRV",
          playerName: "A",
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#2QG2C08UP",
          makePlayerCurrent({
            playerTag: "#2QG2C08UP",
            playerName: "Untracked",
            townHall: 18,
            currentClanTag: "#PQLQG",
            currentClanName: "Untracked Clan",
            role: "member",
          }),
        ],
        [
          "#2CGG9GGRV",
          makePlayerCurrent({
            playerTag: "#2CGG9GGRV",
            playerName: "A",
            townHall: 1,
            currentClanTag: "#2CGG9GGRV",
            currentClanName: "Tracked",
            role: "R",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2CGG9GGRV",
          name: "Tracked",
          shortName: "T",
        },
      ],
    });

    expect(result.primaryPlayerTag).toBe("#2CGG9GGRV");
    expect(result.primaryPlayerName).toBe("A");
    expect(result.primaryClanTag).toBe("#2CGG9GGRV");
    expect(result.renderedNickname).toBe("A (#2CGG9GGRV) TH1 T D U R");
  });

  it("renders tracked clans with the primary clan first and de-dupes repeated memberships", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{trackedClans}",
      member: makeMember(),
      linkedAccounts: [
        makeLink({
          playerTag: "#2CGG9GGRV",
          playerName: "Primary",
        }),
        makeLink({
          playerTag: "#2QG2C08UP",
          playerName: "Second",
        }),
        makeLink({
          playerTag: "#PQLQGRJV",
          playerName: "Third",
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#2CGG9GGRV",
          makePlayerCurrent({
            playerTag: "#2CGG9GGRV",
            playerName: "Primary",
            townHall: 18,
            currentClanTag: "#2CGG9GGRV",
            currentClanName: "Charlie Clan",
          }),
        ],
        [
          "#2QG2C08UP",
          makePlayerCurrent({
            playerTag: "#2QG2C08UP",
            playerName: "Second",
            townHall: 16,
            currentClanTag: "#2QG2C08UP",
            currentClanName: "Alpha Clan",
          }),
        ],
        [
          "#PQLQGRJV",
          makePlayerCurrent({
            playerTag: "#PQLQGRJV",
            playerName: "Third",
            townHall: 14,
            currentClanTag: "#2QG2C08UP",
            currentClanName: "Alpha Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2QG2C08UP",
          name: "Alpha Clan",
          shortName: "Alpha",
        },
        {
          tag: "#2CGG9GGRV",
          name: "Charlie Clan",
          shortName: "Charlie",
        },
      ],
    });

    expect(result.trackedClans).toEqual(["Charlie", "Alpha"]);
    expect(result.renderedNickname).toBe("Charlie | Alpha");
  });

  it("falls back to the clan name when a tracked clan has no short name", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{trackedClans}",
      member: makeMember(),
      linkedAccounts: [
        makeLink({
          playerTag: "#2CGG9GGRV",
          playerName: "Primary",
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#2CGG9GGRV",
          makePlayerCurrent({
            playerTag: "#2CGG9GGRV",
            playerName: "Primary",
            townHall: 16,
            currentClanTag: "#2QG2C08UP",
            currentClanName: "Fallback Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2QG2C08UP",
          name: "Fallback Clan",
          shortName: null,
        },
      ],
    });

    expect(result.trackedClans).toEqual(["Fallback Clan"]);
    expect(result.renderedNickname).toBe("Fallback Clan");
  });

  it("cleans up empty separators when a token renders blank", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{player} - {clan}",
      member: makeMember(),
      linkedAccounts: [
        makeLink({
          playerTag: "#2CGG9GGRV",
          playerName: null,
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#2CGG9GGRV",
          makePlayerCurrent({
            playerTag: "#2CGG9GGRV",
            playerName: null,
            townHall: 16,
            currentClanTag: "#2QG2C08UP",
            currentClanName: "Active Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2QG2C08UP",
          name: "Active Clan",
          shortName: "AC",
        },
      ],
    });

    expect(result.renderedNickname).toBe("Active Clan");
  });

  it("caps the rendered nickname at 32 characters with safe truncation", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{player}",
      member: makeMember(),
      linkedAccounts: [
        makeLink({
          playerTag: "#2CGG9GGRV",
          playerName: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#2CGG9GGRV",
          makePlayerCurrent({
            playerTag: "#2CGG9GGRV",
            playerName: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            townHall: 16,
            currentClanTag: "#2QG2C08UP",
            currentClanName: "Active Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2QG2C08UP",
          name: "Active Clan",
          shortName: "AC",
        },
      ],
    });

    expect(result.renderedNickname).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(result.renderedNickname?.length).toBe(32);
  });
});
