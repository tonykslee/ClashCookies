import { AutoRoleRuleType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoRoleRefreshService } from "../src/services/AutoRoleRefreshService";
import { autoRoleService } from "../src/services/AutoRoleService";
import { playerCurrentService } from "../src/services/PlayerCurrentService";

const prismaMock = vi.hoisted(() => ({
  autoRoleSyncRun: {
    create: vi.fn(),
    update: vi.fn(),
  },
  autoRoleMemberState: {
    upsert: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
  },
}));

const cwlRegistryMock = vi.hoisted(() => ({
  resolveCurrentCwlSeasonKey: vi.fn(),
}));

const pollingModeMock = vi.hoisted(() => ({
  isMirrorPollingMode: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CwlRegistryService", () => cwlRegistryMock);

vi.mock("../src/services/PollingModeService", () => pollingModeMock);

type GuildMemberLike = {
  id: string;
  user: { id: string };
  displayName: string;
  nickname: string | null;
  roles: {
    cache: {
      keys(): IterableIterator<string>;
      has(roleId: string): boolean;
    };
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  setNickname: ReturnType<typeof vi.fn>;
  __roleIds: string[];
};

function makeMember(id: string, roleIds: string[] = []): GuildMemberLike {
  const roleState = [...roleIds];
  const add = vi.fn(async (roleId: string) => {
    if (!roleState.includes(roleId)) {
      roleState.push(roleId);
    }
  });
  const remove = vi.fn(async (roleId: string) => {
    const index = roleState.indexOf(roleId);
    if (index >= 0) {
      roleState.splice(index, 1);
    }
  });
  const setNickname = vi.fn(async () => undefined);
  return {
    id,
    user: { id },
    displayName: `Member ${id}`,
    nickname: null,
    roles: {
      cache: {
        keys: () => roleState.values(),
        has: (roleId: string) => roleState.includes(roleId),
      },
      add,
      remove,
    },
    setNickname,
    __roleIds: roleState,
  };
}

function makeGuild(members: Map<string, GuildMemberLike>) {
  return {
    members: {
      fetch: vi.fn(async (discordUserId?: string) => {
        if (typeof discordUserId === "string") {
          return members.get(discordUserId);
        }
        return members;
      }),
    },
  } as any;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "config-1",
    guildId: "111111111111111111",
    enabled: true,
    killSwitchEnabled: false,
    removeStaleManagedRoles: false,
    applyNicknames: true,
    nicknameTemplate: "TH{th} {player}",
    trustedLinksAllowed: true,
    verifiedOnlyMode: false,
    syncEnabled: true,
    syncIntervalMinutes: 30,
    verifiedRoleId: null,
    familyRoleId: null,
    cwlClanRoleId: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-1",
    guildId: "111111111111111111",
    type: AutoRoleRuleType.VERIFIED,
    targetValue: "__verified__",
    discordRoleId: "222222222222222222",
    priority: 100,
    enabled: true,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeLinkedAccount(input: {
  playerTag: string;
  discordUserId: string;
  playerName: string;
  verified?: boolean;
  source?: string;
}) {
  return {
    playerTag: input.playerTag,
    discordUserId: input.discordUserId,
    discordUsername: `user-${input.discordUserId}`,
    playerName: input.playerName,
    linkSource: input.source ?? "SELF_SERVICE",
    verificationStatus: input.verified === false ? "UNVERIFIED" : "VERIFIED",
    verificationMethod: input.verified === false ? null : "PLAYER_API_TOKEN",
    verifiedAt: input.verified === false ? null : new Date("2026-04-01T00:00:00.000Z"),
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
  playerName: string;
  currentClanTag?: string | null;
}) {
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    townHall: 16,
    currentClanTag: input.currentClanTag ?? "#2QG2C08UP",
    currentClanName: "Clan Name",
    trophies: 5000,
    builderTrophies: 2000,
    warStars: 300,
    expLevel: 250,
    role: "member",
    leagueName: "Legend League",
    currentWeight: 150000,
    currentWeightSource: "player_current",
    currentWeightMeasuredAt: new Date("2026-04-01T00:00:00.000Z"),
    achievementsJson: null,
    lastSeenAt: null,
    lastFetchedAt: null,
    lastSource: "player_current",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    source: "player_current",
    liveRefreshInvoked: false,
  };
}

describe("AutoRoleRefreshService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cwlRegistryMock.resolveCurrentCwlSeasonKey.mockReturnValue("2026-04");
    pollingModeMock.isMirrorPollingMode.mockReturnValue(false);
    prismaMock.autoRoleSyncRun.create.mockResolvedValue({ id: "run-1" });
    prismaMock.autoRoleSyncRun.update.mockResolvedValue({});
    prismaMock.autoRoleMemberState.upsert.mockResolvedValue({});
    prismaMock.playerLink.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig(),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);
    vi.spyOn(playerCurrentService, "resolveCurrentPlayersForTags").mockImplementation(async ({ playerTags }) => {
      const map = new Map<string, any>();
      for (const playerTag of playerTags) {
        map.set(playerTag, makePlayerCurrent({ playerTag, playerName: `Player ${playerTag}` }));
      }
      return map;
    });
  });

  it("refreshes one user, applies matching roles, and persists the run state", async () => {
    const userId = "111111111111111111";
    const roleId = "222222222222222222";
    const member = makeMember(userId);
    const guild = makeGuild(new Map([[userId, member]]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      const wanted = new Set(where.discordUserId.in);
      return [
        makeLinkedAccount({
          playerTag: "#2QG2C08UP",
          discordUserId: userId,
          playerName: "Alpha",
          verified: true,
        }),
      ].filter((row) => wanted.has(row.discordUserId));
    });
    vi.spyOn(playerCurrentService, "resolveCurrentPlayersForTags").mockImplementationOnce(async ({ playerTags }) => {
      const map = new Map<string, any>();
      for (const playerTag of playerTags) {
        map.set(
          playerTag,
          makePlayerCurrent({
            playerTag,
            playerName: playerTag === "#2QG2C08UP" ? "Alpha" : `Player ${playerTag}`,
          }),
        );
      }
      return map;
    });

    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({ applyNicknames: true, removeStaleManagedRoles: false }),
      rules: [
        makeRule({
          type: AutoRoleRuleType.VERIFIED,
          targetValue: "__verified__",
          discordRoleId: roleId,
        }),
      ],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
    });

    expect(playerCurrentService.resolveCurrentPlayersForTags).toHaveBeenCalledWith(
      expect.objectContaining({
        requireFields: ["currentClanTag", "townHall", "role", "leagueName"],
      }),
    );
    expect(member.roles.add).toHaveBeenCalledWith(roleId);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scope: { kind: "user", discordUserId: userId },
      evaluatedCount: 1,
      addedCount: 1,
      removedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(result.memberResults[0]).toMatchObject({
      discordUserId: userId,
      status: "applied",
      nicknameStatus: "changed",
      nicknameReason: null,
    });
    expect(member.setNickname).toHaveBeenCalledWith("TH16 Alpha");
    expect(prismaMock.autoRoleSyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          guildId: "111111111111111111",
          status: "RUNNING",
        }),
      }),
    );
    expect(prismaMock.autoRoleSyncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "COMPLETED",
          evaluatedCount: 1,
          appliedCount: 1,
          removedCount: 0,
          skippedCount: 0,
          error: null,
        }),
      }),
    );
    expect(prismaMock.autoRoleMemberState.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects an unmanaged role scope and records a failed run", async () => {
    const guild = makeGuild(new Map());

    await expect(
      autoRoleRefreshService.refreshRole({
        guild,
        guildId: "111111111111111111",
        discordRoleId: "999999999999999999",
      }),
    ).rejects.toThrow("That Discord role is not managed by autorole.");

    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(prismaMock.autoRoleSyncRun.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.autoRoleSyncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "FAILED",
          error: expect.stringContaining("That Discord role is not managed by autorole."),
        }),
      }),
    );
  });

  it("loads one clan member list for a clan-managed role and removes stale holders when enabled", async () => {
    const managedRoleId = "222222222222222222";
    const currentHolderId = "111111111111111111";
    const qualifyingUserId = "333333333333333333";
    const currentHolder = makeMember(currentHolderId, [managedRoleId]);
    const qualifyingMember = makeMember(qualifyingUserId);
    const guild = makeGuild(new Map([
      [currentHolderId, currentHolder],
      [qualifyingUserId, qualifyingMember],
    ]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      const wanted = new Set(where.discordUserId.in);
      return [
        makeLinkedAccount({
          playerTag: "#2QG2C08UP",
          discordUserId: currentHolderId,
          playerName: "Holder",
        }),
        makeLinkedAccount({
          playerTag: "#PYLQ0289",
          discordUserId: qualifyingUserId,
          playerName: "Qualifier",
        }),
      ].filter((row) => wanted.has(row.discordUserId));
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlPlayerClanSeason.findMany.mockImplementation(async ({ where }: any) => {
      if (!where.cwlClanTag.in.includes("#2QG2C08UP")) return [];
      return [
        {
          id: 1,
          season: "2026-04",
          playerTag: "#PYLQ0289",
          cwlClanTag: "#2QG2C08UP",
          playerName: "Qualifier",
          townHall: 16,
          daysParticipated: 2,
          lastRoundDay: 1,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
      ];
    });
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({ removeStaleManagedRoles: true }),
      rules: [
        makeRule({
          type: AutoRoleRuleType.CLAN,
          targetValue: "#2QG2C08UP",
          discordRoleId: managedRoleId,
        }),
      ],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshRole({
      guild,
      guildId: "111111111111111111",
      discordRoleId: managedRoleId,
    });

    expect(prismaMock.cwlPlayerClanSeason.findMany).toHaveBeenCalledTimes(1);
    expect(currentHolder.roles.remove).toHaveBeenCalledWith(managedRoleId);
    expect(qualifyingMember.roles.add).toHaveBeenCalledWith(managedRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 1,
      removedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it("uses current-season tracked CWL clans for family and CWL clan roles", async () => {
    const familyRoleId = "222222222222222222";
    const cwlClanRoleId = "333333333333333333";
    const fwaMemberId = "111111111111111111";
    const cwlMemberId = "444444444444444444";
    const outsiderId = "555555555555555555";
    const fwaMember = makeMember(fwaMemberId);
    const cwlMember = makeMember(cwlMemberId);
    const outsider = makeMember(outsiderId);
    const guild = makeGuild(new Map([
      [fwaMemberId, fwaMember],
      [cwlMemberId, cwlMember],
      [outsiderId, outsider],
    ]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      const wanted = new Set(where.discordUserId.in);
      return [
        makeLinkedAccount({
          playerTag: "#2QG2C08UP",
          discordUserId: fwaMemberId,
          playerName: "FWA Member",
        }),
        makeLinkedAccount({
          playerTag: "#PYLQ0289",
          discordUserId: cwlMemberId,
          playerName: "CWL Member",
        }),
        makeLinkedAccount({
          playerTag: "#QGRJ2222",
          discordUserId: outsiderId,
          playerName: "Outsider",
        }),
      ].filter((row) => wanted.has(row.discordUserId));
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289" }]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        familyRoleId,
        cwlClanRoleId,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);
    vi.spyOn(playerCurrentService, "resolveCurrentPlayersForTags").mockImplementation(async ({ playerTags }) => {
      const map = new Map<string, any>();
      for (const playerTag of playerTags) {
        map.set(
          playerTag,
          makePlayerCurrent({
            playerTag,
            playerName:
              playerTag === "#2QG2C08UP"
                ? "FWA Member"
                : playerTag === "#PYLQ0289"
                  ? "CWL Member"
                  : "Outsider",
            currentClanTag:
              playerTag === "#2QG2C08UP"
                ? "#2QG2C08UP"
                : playerTag === "#PYLQ0289"
                  ? "#PYLQ0289"
                  : "#QGRJ2222",
          }),
        );
      }
      return map;
    });

    const result = await autoRoleRefreshService.refreshGuild({
      guild,
      guildId: "111111111111111111",
    });

    expect(cwlRegistryMock.resolveCurrentCwlSeasonKey).toHaveBeenCalled();
    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { season: "2026-04" },
        select: { tag: true },
      }),
    );
    expect(fwaMember.roles.add).toHaveBeenCalledWith(familyRoleId);
    expect(cwlMember.roles.add).toHaveBeenCalledWith(familyRoleId);
    expect(cwlMember.roles.add).toHaveBeenCalledWith(cwlClanRoleId);
    expect(outsider.roles.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      evaluatedCount: 3,
      addedCount: 3,
      removedCount: 0,
    });
  });

  it("removes the generic CWL clan role when the member is no longer in a tracked CWL clan", async () => {
    const cwlClanRoleId = "333333333333333333";
    const userId = "111111111111111111";
    const member = makeMember(userId, [cwlClanRoleId]);
    const guild = makeGuild(new Map([[userId, member]]));

    prismaMock.playerLink.findMany.mockResolvedValue([
      makeLinkedAccount({
        playerTag: "#PYLQ0289",
        discordUserId: userId,
        playerName: "CWL Member",
      }),
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289" }]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        cwlClanRoleId,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);
    vi.spyOn(playerCurrentService, "resolveCurrentPlayersForTags").mockResolvedValue(
      new Map([
        [
          "#PYLQ0289",
          makePlayerCurrent({
            playerTag: "#PYLQ0289",
            playerName: "CWL Member",
            currentClanTag: "#QGRJ2222",
          }),
        ],
      ]),
    );

    const result = await autoRoleRefreshService.refreshGuild({
      guild,
      guildId: "111111111111111111",
    });

    expect(member.roles.remove).toHaveBeenCalledWith(cwlClanRoleId);
    expect(result.removedCount).toBe(1);
    expect(result.addedCount).toBe(0);
  });

  it("preserves stale managed roles when stale removal is disabled", async () => {
    const managedRoleId = "222222222222222222";
    const currentHolderId = "111111111111111111";
    const qualifyingUserId = "333333333333333333";
    const currentHolder = makeMember(currentHolderId, [managedRoleId]);
    const qualifyingMember = makeMember(qualifyingUserId);
    const guild = makeGuild(new Map([
      [currentHolderId, currentHolder],
      [qualifyingUserId, qualifyingMember],
    ]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      const wanted = new Set(where.discordUserId.in);
      return [
        makeLinkedAccount({
          playerTag: "#2QG2C08UP",
          discordUserId: currentHolderId,
          playerName: "Holder",
        }),
        makeLinkedAccount({
          playerTag: "#PYLQ0289",
          discordUserId: qualifyingUserId,
          playerName: "Qualifier",
        }),
      ].filter((row) => wanted.has(row.discordUserId));
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([
      {
        id: 1,
        season: "2026-04",
        playerTag: "#PYLQ0289",
        cwlClanTag: "#2QG2C08UP",
        playerName: "Qualifier",
        townHall: 16,
        daysParticipated: 2,
        lastRoundDay: 1,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ] as any);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({ removeStaleManagedRoles: false }),
      rules: [
        makeRule({
          type: AutoRoleRuleType.CLAN,
          targetValue: "#2QG2C08UP",
          discordRoleId: managedRoleId,
        }),
      ],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshRole({
      guild,
      guildId: "111111111111111111",
      discordRoleId: managedRoleId,
    });

    expect(prismaMock.cwlPlayerClanSeason.findMany).toHaveBeenCalledTimes(1);
    expect(currentHolder.roles.remove).not.toHaveBeenCalled();
    expect(currentHolder.__roleIds).toContain(managedRoleId);
    expect(qualifyingMember.roles.add).toHaveBeenCalledWith(managedRoleId);
    expect(result.removedCount).toBe(0);
    expect(result.addedCount).toBe(1);
  });

  it("skips excluded users and excluded roles during a guild refresh", async () => {
    const verifiedRoleId = "222222222222222222";
    const excludedRoleId = "444444444444444444";
    const excludedUserId = "111111111111111111";
    const excludedRoleUserId = "333333333333333333";
    const normalUserId = "555555555555555555";

    const excludedUser = makeMember(excludedUserId);
    const excludedRoleUser = makeMember(excludedRoleUserId, [excludedRoleId]);
    const normalUser = makeMember(normalUserId);
    const guild = makeGuild(new Map([
      [excludedUserId, excludedUser],
      [excludedRoleUserId, excludedRoleUser],
      [normalUserId, normalUser],
    ]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      const wanted = new Set(where.discordUserId.in);
      return [
        makeLinkedAccount({
          playerTag: "#2QG2C08UP",
          discordUserId: excludedUserId,
          playerName: "Excluded User",
        }),
        makeLinkedAccount({
          playerTag: "#PYLQ0289",
          discordUserId: excludedRoleUserId,
          playerName: "Excluded Role User",
        }),
        makeLinkedAccount({
          playerTag: "#QGRJ2222",
          discordUserId: normalUserId,
          playerName: "Normal User",
        }),
      ].filter((row) => wanted.has(row.discordUserId));
    });
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({ removeStaleManagedRoles: true }),
      rules: [
        makeRule({
          type: AutoRoleRuleType.VERIFIED,
          targetValue: "__verified__",
          discordRoleId: verifiedRoleId,
        }),
      ],
      exclusions: {
        users: [{ discordUserId: excludedUserId, reason: "manual" }],
        roles: [{ discordRoleId: excludedRoleId, reason: "manual" }],
      },
    } as any);

    const result = await autoRoleRefreshService.refreshGuild({
      guild,
      guildId: "111111111111111111",
    });

    expect(excludedUser.roles.add).not.toHaveBeenCalled();
    expect(excludedRoleUser.roles.add).not.toHaveBeenCalled();
    expect(normalUser.roles.add).toHaveBeenCalledWith(verifiedRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 3,
      addedCount: 1,
      skippedCount: 2,
      failedCount: 0,
    });
  });

  it("records a failed run when autorole is disabled", async () => {
    const guild = makeGuild(new Map());
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({ enabled: false }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    await expect(
      autoRoleRefreshService.refreshGuild({
        guild,
        guildId: "111111111111111111",
      }),
    ).rejects.toThrow("Autorole is disabled for this guild.");

    expect(prismaMock.autoRoleSyncRun.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.autoRoleSyncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "FAILED",
          error: expect.stringContaining("Autorole is disabled for this guild."),
        }),
      }),
    );
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });

  it("records a failed run and blocks writes when the kill switch is enabled", async () => {
    const guild = makeGuild(new Map());
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({ killSwitchEnabled: true }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    await expect(
      autoRoleRefreshService.refreshGuild({
        guild,
        guildId: "111111111111111111",
      }),
    ).rejects.toThrow("Autorole kill switch is enabled for this guild.");

    expect(prismaMock.autoRoleSyncRun.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.autoRoleSyncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "FAILED",
          error: expect.stringContaining("Autorole kill switch is enabled for this guild."),
        }),
      }),
    );
    expect(guild.members.fetch).not.toHaveBeenCalled();
  });
});
