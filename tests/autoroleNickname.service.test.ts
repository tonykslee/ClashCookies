import { describe, expect, it } from "vitest";
import {
  AutoRoleNicknameService,
  cleanupTrackedClanNickname,
  type AutoRoleNicknameRenderInput,
} from "../src/services/AutoRoleNicknameService";
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
    nicknameExcludeRoleIds: [],
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

function makeMember(overrides: Partial<AutoRoleNicknameRenderInput["member"]> = {}): AutoRoleNicknameRenderInput["member"] {
  return {
    id: "111111111111111111",
    displayName: "D",
    nickname: null,
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

  const baseTrackedClans = [
    {
      tag: "#2CGG9GGRV",
      name: "Tracked Clan",
      shortName: "TC",
    },
  ];

  function makeAllowedRenderInput(overrides: {
    template?: string;
    config?: Partial<AutoRoleGuildConfigSnapshot>;
    linkOverrides?: Partial<PlayerLinkWithTrust> & Pick<PlayerLinkWithTrust, "playerTag">;
    playerCurrent?: Partial<PlayerCurrentLike> & Pick<PlayerCurrentLike, "playerTag">;
    trackedClans?: AutoRoleNicknameRenderInput["trackedClans"];
  } = {}): AutoRoleNicknameRenderInput {
    const playerTag = overrides.linkOverrides?.playerTag ?? "#2CGG9GGRV";
    const trackedClans = overrides.trackedClans ?? baseTrackedClans;
    const link = makeLink({
      playerTag,
      playerName: overrides.linkOverrides?.playerName ?? "Alpha",
      linkSource: overrides.linkOverrides?.linkSource ?? "SELF_SERVICE",
      verificationStatus: overrides.linkOverrides?.verificationStatus ?? "VERIFIED",
      verificationMethod: overrides.linkOverrides?.verificationMethod ?? "PLAYER_API_TOKEN",
      verifiedAt: overrides.linkOverrides?.verifiedAt ?? new Date("2026-04-01T00:00:00.000Z"),
      ...overrides.linkOverrides,
    });

    return {
      config: makeConfig(overrides.config),
      template: overrides.template ?? "{player}",
      member: makeMember(),
      linkedAccounts: [link],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          playerTag,
          makePlayerCurrent({
            playerTag,
            playerName: overrides.playerCurrent?.playerName ?? "Alpha",
            currentClanTag: overrides.playerCurrent?.currentClanTag ?? "#2CGG9GGRV",
            currentClanName: overrides.playerCurrent?.currentClanName ?? "Tracked Clan",
            townHall: overrides.playerCurrent?.townHall ?? 16,
            role: overrides.playerCurrent?.role ?? "member",
            ...overrides.playerCurrent,
          }),
        ],
      ]),
      trackedClans,
    };
  }

  function makeDiscordTrackedClanRenderInput(displayName: string): AutoRoleNicknameRenderInput {
    return {
      config: makeConfig(),
      template: "{discord} | {trackedClans}",
      member: makeMember({ displayName }),
      linkedAccounts: [
        makeLink({
          playerTag: "#PQLQ",
          playerName: "EB Player",
          discordUserId: "111111111111111111",
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
          verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
        }),
        makeLink({
          playerTag: "#GRJV",
          playerName: "AK Player",
          discordUserId: "111111111111111111",
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
          verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#PQLQ",
          makePlayerCurrent({
            playerTag: "#PQLQ",
            playerName: "EB Player",
            currentClanTag: "#PQLQ",
            currentClanName: "EB",
            townHall: 16,
            role: "member",
          }),
        ],
        [
          "#GRJV",
          makePlayerCurrent({
            playerTag: "#GRJV",
            playerName: "AK Player",
            currentClanTag: "#GRJV",
            currentClanName: "AK",
            townHall: 15,
            role: "member",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#PQLQ",
          name: "EB",
          shortName: "EB",
        },
        {
          tag: "#GRJV",
          name: "AK",
          shortName: "AK",
        },
      ],
    };
  }

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
            currentClanTag: "#PYLQ0289",
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
            currentClanTag: "#PYLQ0289",
            currentClanName: "Alpha Clan",
          }),
        ],
        [
          "#PQLQGRJV",
          makePlayerCurrent({
            playerTag: "#PQLQGRJV",
            playerName: "Third",
            townHall: 14,
            currentClanTag: "#PYLQ0289",
            currentClanName: "Alpha Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#PYLQ0289",
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

  it("strips a full tracked-clan suffix before appending tracked clans", () => {
    const result = service.renderNickname(makeDiscordTrackedClanRenderInput("Tilonius | EB | AK"));

    expect(result.trackedClans).toEqual(["EB", "AK"]);
    expect(result.renderedNickname).toBe("Tilonius | EB | AK");
  });

  it("preserves the retained nickname prefix when stripping a tracked-clan suffix", () => {
    const cleanup = cleanupTrackedClanNickname("Tilonius / Staff | RR | ZG", [
      {
        tag: "#2QG2C08UP",
        name: "Zero Gravity",
        shortName: "ZG",
      },
      {
        tag: "#8PJLYRC8P",
        name: "Red Dawn",
        shortName: "RR",
      },
    ]);

    expect(cleanup).toEqual({
      cleanedNickname: "Tilonius / Staff",
      removedSuffix: true,
    });
  });

  it("preserves hyphenated manual nickname content before a tracked-clan suffix", () => {
    const cleanup = cleanupTrackedClanNickname("Tilonius - Admin | RR", [
      {
        tag: "#8PJLYRC8P",
        name: "Red Dawn",
        shortName: "RR",
      },
    ]);

    expect(cleanup).toEqual({
      cleanedNickname: "Tilonius - Admin",
      removedSuffix: true,
    });
  });

  it("preserves internal whitespace in the retained nickname prefix", () => {
    const cleanup = cleanupTrackedClanNickname("Tony  Lee | RR", [
      {
        tag: "#8PJLYRC8P",
        name: "Red Dawn",
        shortName: "RR",
      },
    ]);

    expect(cleanup).toEqual({
      cleanedNickname: "Tony  Lee",
      removedSuffix: true,
    });
  });

  it("returns null when the nickname consists only of tracked-clan labels", () => {
    const cleanup = cleanupTrackedClanNickname("RR | ZG", [
      {
        tag: "#2QG2C08UP",
        name: "Zero Gravity",
        shortName: "ZG",
      },
      {
        tag: "#8PJLYRC8P",
        name: "Red Dawn",
        shortName: "RR",
      },
    ]);

    expect(cleanup).toEqual({
      cleanedNickname: null,
      removedSuffix: true,
    });
  });

  it("leaves unrelated manual nickname text untouched", () => {
    const cleanup = cleanupTrackedClanNickname("Tilonius | Dad", [
      {
        tag: "#2QG2C08UP",
        name: "Zero Gravity",
        shortName: "ZG",
      },
    ]);

    expect(cleanup).toEqual({
      cleanedNickname: "Tilonius | Dad",
      removedSuffix: false,
    });
  });

  it("does not strip tracked-clan labels from {discord} when {trackedClans} is not used", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{discord}",
      member: makeMember({ displayName: "Player | ZG" }),
      linkedAccounts: [
        makeLink({
          playerTag: "#PLAYER123",
          playerName: "Player",
          discordUserId: "111111111111111111",
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
          verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#PLAYER123",
          makePlayerCurrent({
            playerTag: "#PLAYER123",
            playerName: "Player",
            currentClanTag: "#2CGG9GGRV",
            currentClanName: "Tracked Clan",
            townHall: 16,
            role: "member",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2CGG9GGRV",
          name: "Tracked Clan",
          shortName: "TC",
        },
      ],
    });

    expect(result.renderedNickname).toBe("Player | ZG");
  });

  it("strips stale configured tracked-clan labels when {discord} and {trackedClans} are both used", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{discord} | {trackedClans}",
      member: makeMember({ displayName: "Player | ZG" }),
      linkedAccounts: [
        makeLink({
          playerTag: "#PLAYER123",
          playerName: "Player",
          discordUserId: "111111111111111111",
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
          verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#PLAYER123",
          makePlayerCurrent({
            playerTag: "#PLAYER123",
            playerName: "Player",
            currentClanTag: null,
            currentClanName: null,
            townHall: 16,
            role: "member",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2CGG9GGRV",
          name: "Zero Gravity",
          shortName: "ZG",
        },
        {
          tag: "#8PJLYRC8P",
          name: "Red Dawn",
          shortName: "RD",
        },
      ],
    });

    expect(result.renderedNickname).toBe("Player");
  });

  it("rebuilds the current tracked-clan suffix after stripping a stale one", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{discord} | {trackedClans}",
      member: makeMember({ displayName: "Player | ZG" }),
      linkedAccounts: [
        makeLink({
          playerTag: "#PLAYER123",
          playerName: "Player",
          discordUserId: "111111111111111111",
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
          verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#PLAYER123",
          makePlayerCurrent({
            playerTag: "#PLAYER123",
            playerName: "Player",
            currentClanTag: "#8PJLYRC8P",
            currentClanName: "Red Dawn",
            townHall: 16,
            role: "member",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2CGG9GGRV",
          name: "Zero Gravity",
          shortName: "ZG",
        },
        {
          tag: "#8PJLYRC8P",
          name: "Red Dawn",
          shortName: "RD",
        },
      ],
    });

    expect(result.trackedClans).toEqual(["RD"]);
    expect(result.renderedNickname).toBe("Player | RD");
  });

  it("strips multiple stale tracked-clan suffixes before appending the current one", () => {
    const result = service.renderNickname({
      config: makeConfig(),
      template: "{discord} | {trackedClans}",
      member: makeMember({ displayName: "Player | ZG | RD" }),
      linkedAccounts: [
        makeLink({
          playerTag: "#PLAYER123",
          playerName: "Player",
          discordUserId: "111111111111111111",
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
          verifiedAt: new Date("2026-04-01T00:00:00.000Z"),
        }),
      ],
      playerCurrentByTag: new Map<string, PlayerCurrentLike>([
        [
          "#PLAYER123",
          makePlayerCurrent({
            playerTag: "#PLAYER123",
            playerName: "Player",
            currentClanTag: "#8PJLYRC8P",
            currentClanName: "Red Dawn",
            townHall: 16,
            role: "member",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#2CGG9GGRV",
          name: "Zero Gravity",
          shortName: "ZG",
        },
        {
          tag: "#8PJLYRC8P",
          name: "Red Dawn",
          shortName: "RD",
        },
      ],
    });

    expect(result.renderedNickname).toBe("Player | RD");
  });

  it("keeps unrelated trailing text while stripping only overlapping tracked-clan labels", () => {
    const result = service.renderNickname(makeDiscordTrackedClanRenderInput("Tilonius | Dad | EB"));

    expect(result.renderedNickname).toBe("Tilonius | Dad | EB | AK");
  });

  it("strips reordered tracked-clan suffixes without changing the tracked-clan order", () => {
    const result = service.renderNickname(makeDiscordTrackedClanRenderInput("Tilonius | AK | EB"));

    expect(result.renderedNickname).toBe("Tilonius | EB | AK");
  });

  it("preserves unrelated text when there is no tracked-clan overlap", () => {
    const result = service.renderNickname(makeDiscordTrackedClanRenderInput("Tilonius | Dad"));

    expect(result.renderedNickname).toBe("Tilonius | Dad | EB | AK");
  });

  it.each([
    {
      name: "EMBED_SELF_SERVICE",
      linkSource: "EMBED_SELF_SERVICE",
    },
    {
      name: "SELF_SERVICE",
      linkSource: "SELF_SERVICE",
    },
  ])("allows unverified $name links when trusted links are allowed", ({ linkSource }) => {
    const result = service.renderNickname(
      makeAllowedRenderInput({
        template: "{tag}",
        linkOverrides: {
          playerTag: "#2CGG9GGRV",
          playerName: "Alpha",
          linkSource: linkSource as PlayerLinkWithTrust["linkSource"],
          verificationStatus: "UNVERIFIED",
          verificationMethod: null,
          verifiedAt: null,
        },
      }),
    );

    expect(result.primaryPlayerTag).toBe("#2CGG9GGRV");
    expect(result.renderedNickname).toBe("#2CGG9GGRV");
  });

  it.each([
    {
      name: "verified-only mode enabled",
      config: { verifiedOnlyMode: true },
    },
    {
      name: "trusted links disabled",
      config: { trustedLinksAllowed: false },
    },
  ])("blocks unverified links when $name", ({ config }) => {
    const result = service.renderNickname(
      makeAllowedRenderInput({
        template: "{tag}",
        config,
        linkOverrides: {
          playerTag: "#2CGG9GGRV",
          playerName: "Alpha",
          linkSource: "EMBED_SELF_SERVICE",
          verificationStatus: "UNVERIFIED",
          verificationMethod: null,
          verifiedAt: null,
        },
      }),
    );

    expect(result.primaryPlayerTag).toBeNull();
    expect(result.renderedNickname).toBeNull();
  });

  it("blocks revoked links even when trusted links are allowed", () => {
    const result = service.renderNickname(
      makeAllowedRenderInput({
        template: "{tag}",
        linkOverrides: {
          playerTag: "#2CGG9GGRV",
          playerName: "Alpha",
          linkSource: "SELF_SERVICE",
          verificationStatus: "REVOKED",
          verificationMethod: null,
          verifiedAt: null,
        },
      }),
    );

    expect(result.primaryPlayerTag).toBeNull();
    expect(result.renderedNickname).toBeNull();
  });

  it("strips matching outer double quotes before rendering", () => {
    const result = service.renderNickname(
      makeAllowedRenderInput({
        template: '"{player} | {trackedClans}"',
        linkOverrides: {
          playerTag: "#8PJLYRC8P",
          playerName: "Elrond♣️",
          linkSource: "EMBED_SELF_SERVICE",
          verificationStatus: "UNVERIFIED",
          verificationMethod: null,
          verifiedAt: null,
        },
        playerCurrent: {
          playerTag: "#8PJLYRC8P",
          playerName: "Elrond♣️",
          currentClanTag: "#2CGG9GGRV",
          currentClanName: "Tracked Clan",
          townHall: 15,
          role: "member",
        },
        trackedClans: [
          {
            tag: "#2CGG9GGRV",
            name: "Tracked Clan",
            shortName: "RR",
          },
        ],
      }),
    );

    expect(result.renderedNickname).toBe("Elrond♣️ | RR");
  });

  it("strips matching outer single quotes before rendering", () => {
    const result = service.renderNickname(
      makeAllowedRenderInput({
        template: "'{player} | {trackedClans}'",
        linkOverrides: {
          playerTag: "#8PJLYRC8P",
          playerName: "Elrond♣️",
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
        },
        playerCurrent: {
          playerTag: "#8PJLYRC8P",
          playerName: "Elrond♣️",
          currentClanTag: "#2CGG9GGRV",
          currentClanName: "Tracked Clan",
          townHall: 15,
          role: "member",
        },
        trackedClans: [
          {
            tag: "#2CGG9GGRV",
            name: "Tracked Clan",
            shortName: "RR",
          },
        ],
      }),
    );

    expect(result.renderedNickname).toBe("Elrond♣️ | RR");
  });

  it("preserves interior quotes while stripping only the outer pair", () => {
    const result = service.renderNickname(
      makeAllowedRenderInput({
        template: '"{player} - "VIP""',
        linkOverrides: {
          playerTag: "#2CGG9GGRV",
          playerName: "Alpha",
        },
      }),
    );

    expect(result.renderedNickname).toBe('Alpha - "VIP"');
  });

  it("returns null for separator-only output", () => {
    const result = service.renderNickname(
      makeAllowedRenderInput({
        template: '"{player} | {trackedClans}"',
        linkOverrides: {
          playerTag: "#2CGG9GGRV",
          playerName: null,
          linkSource: "SELF_SERVICE",
          verificationStatus: "VERIFIED",
          verificationMethod: "PLAYER_API_TOKEN",
        },
        playerCurrent: {
          playerTag: "#2CGG9GGRV",
          playerName: null,
          currentClanTag: null,
          currentClanName: null,
          townHall: 16,
          role: null,
        },
        trackedClans: [],
      }),
    );

    expect(result.renderedNickname).toBeNull();
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
            currentClanTag: "#PYLQ0289",
            currentClanName: "Fallback Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#PYLQ0289",
          name: "Fallback Clan",
          shortName: null,
        },
      ],
    });

    expect(result.primaryClanShort).toBeNull();
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
            currentClanTag: "#PYLQ0289",
            currentClanName: "Active Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#PYLQ0289",
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
            currentClanTag: "#PYLQ0289",
            currentClanName: "Active Clan",
          }),
        ],
      ]),
      trackedClans: [
        {
          tag: "#PYLQ0289",
          name: "Active Clan",
          shortName: "AC",
        },
      ],
    });

    expect(result.renderedNickname).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(result.renderedNickname?.length).toBe(32);
  });
});
