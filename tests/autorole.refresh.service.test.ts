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
  cwlRoundMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  cwlPlayerClanSeason: {
    findMany: vi.fn(),
  },
  autoRolePendingRemoval: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
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
    clanRoleRemovalDelayMinutes: null,
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
  role?: "member" | "elder" | "coLeader" | "leader" | null;
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
    role: input.role ?? "member",
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

function makeClanMember(input: {
  tag: string;
  name: string;
  role?: "member" | "elder" | "coLeader" | "leader" | null;
  townHallLevel?: number;
  leagueName?: string | null;
}) {
  return {
    tag: input.tag,
    name: input.name,
    townHallLevel: input.townHallLevel ?? 16,
    role: input.role ?? "member",
    league: input.leagueName ? { name: input.leagueName } : null,
  };
}

function filterPlayerLinkRows(rows: any[], where: any): any[] {
  const playerTagFilter = where?.playerTag?.in ? new Set(where.playerTag.in) : null;
  const discordUserIdFilter = where?.discordUserId?.in ? new Set(where.discordUserId.in) : null;
  return rows.filter((row) => {
    if (playerTagFilter && !playerTagFilter.has(row.playerTag)) {
      return false;
    }
    if (discordUserIdFilter && !discordUserIdFilter.has(row.discordUserId)) {
      return false;
    }
    return true;
  });
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
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.autoRolePendingRemoval.findMany.mockResolvedValue([]);
    prismaMock.autoRolePendingRemoval.upsert.mockResolvedValue({});
    prismaMock.autoRolePendingRemoval.deleteMany.mockResolvedValue({});
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
      return filterPlayerLinkRows([
        makeLinkedAccount({
          playerTag: "#2QG2C08UP",
          discordUserId: userId,
          playerName: "Alpha",
          verified: true,
        }),
      ], where);
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

  it("removes a stale CLAN role during user refresh when live current-clan data has moved", async () => {
    const userId = "111111111111111111";
    const oldClanTag = "#2QG2C08UP";
    const newClanTag = "#QGRJ2222";
    const roleId = "222222222222222222";
    const member = makeMember(userId, [roleId]);
    const guild = makeGuild(new Map([[userId, member]]));
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: oldClanTag,
            discordUserId: userId,
            playerName: "Moved Player",
          }),
      ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: oldClanTag }]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: oldClanTag,
        playerTag: oldClanTag,
      },
    ]);
    vi.spyOn(playerCurrentService, "refreshCurrentPlayersFromLiveTags").mockResolvedValue({
      playerCount: 1,
      successCount: 1,
      failedPlayerTags: [],
    });
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockResolvedValue(
      new Map([
        [
          oldClanTag,
          makePlayerCurrent({
            playerTag: oldClanTag,
            playerName: "Moved Player",
            currentClanTag: newClanTag,
            currentClanName: "New Clan",
          }),
        ],
      ]),
    );
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        removeStaleManagedRoles: true,
        clanRoleRemovalDelayMinutes: null,
      }),
      rules: [
        makeRule({
          type: AutoRoleRuleType.CLAN,
          targetValue: oldClanTag,
          discordRoleId: roleId,
        }),
      ],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
      cocService: cocService as any,
    });

    expect(playerCurrentService.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({
        playerTags: [oldClanTag],
        source: "live_refresh",
      }),
    );
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(member.roles.remove).toHaveBeenCalledWith(roleId);
    expect(result).toMatchObject({
      scope: { kind: "user", discordUserId: userId },
      removedCount: 1,
      addedCount: 0,
      failedCount: 0,
    });
  });

  it("preserves a stale CLAN role during user refresh when stale removal is disabled", async () => {
    const userId = "111111111111111111";
    const oldClanTag = "#2QG2C08UP";
    const newClanTag = "#QGRJ2222";
    const roleId = "222222222222222222";
    const member = makeMember(userId, [roleId]);
    const guild = makeGuild(new Map([[userId, member]]));
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: oldClanTag,
            discordUserId: userId,
            playerName: "Moved Player",
          }),
      ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: oldClanTag }]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: oldClanTag,
        playerTag: oldClanTag,
      },
    ]);
    vi.spyOn(playerCurrentService, "refreshCurrentPlayersFromLiveTags").mockResolvedValue({
      playerCount: 1,
      successCount: 1,
      failedPlayerTags: [],
    });
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockResolvedValue(
      new Map([
        [
          oldClanTag,
          makePlayerCurrent({
            playerTag: oldClanTag,
            playerName: "Moved Player",
            currentClanTag: newClanTag,
            currentClanName: "New Clan",
          }),
        ],
      ]),
    );
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        removeStaleManagedRoles: false,
        clanRoleRemovalDelayMinutes: null,
      }),
      rules: [
        makeRule({
          type: AutoRoleRuleType.CLAN,
          targetValue: oldClanTag,
          discordRoleId: roleId,
        }),
      ],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
      cocService: cocService as any,
    });

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scope: { kind: "user", discordUserId: userId },
      removedCount: 0,
      addedCount: 0,
      failedCount: 0,
    });
  });

  it("grants a tracked-clan lead role during user refresh when the live current player is a leader", async () => {
    const userId = "111111111111111111";
    const clanTag = "#2QG2C08UP";
    const leadRoleId = "222222222222222222";
    const member = makeMember(userId);
    const guild = makeGuild(new Map([[userId, member]]));
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: clanTag,
            discordUserId: userId,
            playerName: "Lead Player",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: clanTag, leadRoleId }]);
    vi.spyOn(playerCurrentService, "refreshCurrentPlayersFromLiveTags").mockResolvedValue({
      playerCount: 1,
      successCount: 1,
      failedPlayerTags: [],
    });
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockResolvedValue(
      new Map([
        [
          clanTag,
          makePlayerCurrent({
            playerTag: clanTag,
            playerName: "Lead Player",
            currentClanTag: clanTag,
            currentClanName: "Tracked Clan",
            role: "leader",
          }),
        ],
      ]),
    );
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
      cocService: cocService as any,
    });

    expect(playerCurrentService.refreshCurrentPlayersFromLiveTags).toHaveBeenCalledWith(
      expect.objectContaining({
        playerTags: [clanTag],
        source: "live_refresh",
      }),
    );
    expect(member.roles.add).toHaveBeenCalledWith(leadRoleId);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scope: { kind: "user", discordUserId: userId },
      addedCount: 1,
      removedCount: 0,
      failedCount: 0,
    });
  });

  it("removes a stale tracked-clan lead role during user refresh when the player loses leader rank", async () => {
    const userId = "111111111111111111";
    const clanTag = "#2QG2C08UP";
    const leadRoleId = "222222222222222222";
    const member = makeMember(userId, [leadRoleId]);
    const guild = makeGuild(new Map([[userId, member]]));
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: clanTag,
            discordUserId: userId,
            playerName: "Former Lead",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: clanTag, leadRoleId }]);
    vi.spyOn(playerCurrentService, "refreshCurrentPlayersFromLiveTags").mockResolvedValue({
      playerCount: 1,
      successCount: 1,
      failedPlayerTags: [],
    });
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockResolvedValue(
      new Map([
        [
          clanTag,
          makePlayerCurrent({
            playerTag: clanTag,
            playerName: "Former Lead",
            currentClanTag: clanTag,
            currentClanName: "Tracked Clan",
            role: "member",
          }),
        ],
      ]),
    );
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
      cocService: cocService as any,
    });

    expect(member.roles.remove).toHaveBeenCalledWith(leadRoleId);
    expect(result).toMatchObject({
      removedCount: 1,
      addedCount: 0,
      failedCount: 0,
    });
  });

  it("preserves a stale tracked-clan lead role during user refresh when stale removal is disabled", async () => {
    const userId = "111111111111111111";
    const clanTag = "#2QG2C08UP";
    const leadRoleId = "222222222222222222";
    const member = makeMember(userId, [leadRoleId]);
    const guild = makeGuild(new Map([[userId, member]]));
    const cocService = {
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: clanTag,
            discordUserId: userId,
            playerName: "Former Lead",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: clanTag, leadRoleId }]);
    vi.spyOn(playerCurrentService, "refreshCurrentPlayersFromLiveTags").mockResolvedValue({
      playerCount: 1,
      successCount: 1,
      failedPlayerTags: [],
    });
    vi.spyOn(playerCurrentService, "listPlayerCurrentByTags").mockResolvedValue(
      new Map([
        [
          clanTag,
          makePlayerCurrent({
            playerTag: clanTag,
            playerName: "Former Lead",
            currentClanTag: clanTag,
            currentClanName: "Tracked Clan",
            role: "member",
          }),
        ],
      ]),
    );
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: false,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
      cocService: cocService as any,
    });

    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      removedCount: 0,
      addedCount: 0,
      failedCount: 0,
    });
  });

  it("keeps nickname refresh idempotent when discord display names already carry tracked clan labels", async () => {
    const userId = "111111111111111111";
    const member = makeMember(userId);
    member.displayName = "Tilonius | EB | AK";
    const guild = makeGuild(new Map([[userId, member]]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows([
        {
          ...makeLinkedAccount({
            playerTag: "#PQLQ",
            discordUserId: userId,
            playerName: "EB Player",
            verified: true,
          }),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
        },
        {
          ...makeLinkedAccount({
            playerTag: "#GRJV",
            discordUserId: userId,
            playerName: "AK Player",
            verified: true,
          }),
          createdAt: new Date("2026-04-02T00:00:00.000Z"),
          updatedAt: new Date("2026-04-02T00:00:00.000Z"),
        },
      ], where);
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#PQLQ", name: "EB", shortName: "EB" },
      { tag: "#GRJV", name: "AK", shortName: "AK" },
    ]);
    vi.spyOn(playerCurrentService, "resolveCurrentPlayersForTags").mockResolvedValue(
      new Map<string, any>([
        [
          "#PQLQ",
          makePlayerCurrent({
            playerTag: "#PQLQ",
            playerName: "EB Player",
            currentClanTag: "#PQLQ",
            currentClanName: "EB",
          }),
        ],
        [
          "#GRJV",
          makePlayerCurrent({
            playerTag: "#GRJV",
            playerName: "AK Player",
            currentClanTag: "#GRJV",
            currentClanName: "AK",
          }),
        ],
      ]),
    );

    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: true,
        nicknameTemplate: "{discord} | {trackedClans}",
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const first = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
    });
    const second = await autoRoleRefreshService.refreshUser({
      guild,
      guildId: "111111111111111111",
      discordUserId: userId,
    });

    expect(first.memberResults[0]).toMatchObject({
      nicknameStatus: "unchanged",
      nicknameReason: null,
    });
    expect(second.memberResults[0]).toMatchObject({
      nicknameStatus: "unchanged",
      nicknameReason: null,
    });
    expect(member.setNickname).not.toHaveBeenCalled();
  });

  it("refreshes tracked FWA clans from clan member lists without player lookups", async () => {
    const clanRoleId = "222222222222222222";
    const townHallRoleId = "333333333333333333";
    const leagueRoleId = "444444444444444444";
    const clanRankRoleId = "555555555555555555";
    const staleHolderId = "111111111111111111";
    const qualifyingUserId = "666666666666666666";
    const outsiderId = "777777777777777777";
    const staleHolder = makeMember(staleHolderId, [
      clanRoleId,
      townHallRoleId,
      leagueRoleId,
      clanRankRoleId,
    ]);
    const qualifyingMember = makeMember(qualifyingUserId);
    const outsider = makeMember(outsiderId);
    const guild = makeGuild(new Map([
      [staleHolderId, staleHolder],
      [qualifyingUserId, qualifyingMember],
      [outsiderId, outsider],
    ]));
    const cocService = {
      getClan: vi.fn(async (tag: string) => {
        if (tag === "#2QG2C08UP") {
          return {
            tag: "#2QG2C08UP",
            name: "Tracked FWA",
            members: [
              {
                tag: "#PYLQ0289",
                name: "Pending Clan",
                townHallLevel: 16,
                role: "member",
                league: { name: "Legend League" },
              },
            ],
          };
        }
        throw new Error(`unexpected clan lookup ${tag}`);
      }),
      getPlayer: vi.fn(async () => {
        throw new Error("getPlayer should not be called during no-arg refresh");
      }),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows([
        makeLinkedAccount({
          playerTag: "#QGRJ2222",
          discordUserId: staleHolderId,
          playerName: "Stale Holder",
        }),
        makeLinkedAccount({
          playerTag: "#PYLQ0289",
          discordUserId: qualifyingUserId,
          playerName: "Pending Clan",
        }),
        makeLinkedAccount({
          playerTag: "#QGRJ2222",
          discordUserId: outsiderId,
          playerName: "Outsider",
        }),
      ], where);
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Tracked FWA", shortName: "TF" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [
        makeRule({
          type: AutoRoleRuleType.CLAN,
          targetValue: "#2QG2C08UP",
          discordRoleId: clanRoleId,
        }),
        makeRule({
          id: "rule-th",
          type: AutoRoleRuleType.TOWN_HALL,
          targetValue: "16",
          discordRoleId: townHallRoleId,
        }),
        makeRule({
          id: "rule-league",
          type: AutoRoleRuleType.LEAGUE,
          targetValue: "Legend League",
          discordRoleId: leagueRoleId,
        }),
        makeRule({
          id: "rule-rank",
          type: AutoRoleRuleType.CLAN_ROLE,
          targetValue: "member",
          discordRoleId: clanRankRoleId,
        }),
      ],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshGuild({
      guild,
      guildId: "111111111111111111",
      cocService: cocService as any,
    });

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(cocService.getClan).toHaveBeenCalledWith("#2QG2C08UP");
    expect(cocService.getPlayer).not.toHaveBeenCalled();
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(staleHolder.roles.remove).toHaveBeenCalledWith(clanRoleId);
    expect(staleHolder.roles.remove).toHaveBeenCalledWith(townHallRoleId);
    expect(staleHolder.roles.remove).toHaveBeenCalledWith(leagueRoleId);
    expect(staleHolder.roles.remove).toHaveBeenCalledWith(clanRankRoleId);
    expect(qualifyingMember.roles.add).toHaveBeenCalledWith(clanRoleId);
    expect(qualifyingMember.roles.add).toHaveBeenCalledWith(townHallRoleId);
    expect(qualifyingMember.roles.add).toHaveBeenCalledWith(leagueRoleId);
    expect(qualifyingMember.roles.add).toHaveBeenCalledWith(clanRankRoleId);
    expect(outsider.roles.add).not.toHaveBeenCalled();
    expect(outsider.roles.remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 4,
      removedCount: 4,
      skippedCount: 0,
      failedCount: 0,
    });
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
      return filterPlayerLinkRows([
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
      ], where);
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

  it("refreshes a tracked-clan lead role from the owning clan profile without player fanout", async () => {
    const leadRoleId = "222222222222222222";
    const clanTag = "#2QG2C08UP";
    const currentHolderId = "111111111111111111";
    const leaderUserId = "333333333333333333";
    const coLeaderUserId = "444444444444444444";
    const memberUserId = "555555555555555555";
    const elderUserId = "666666666666666666";
    const currentHolder = makeMember(currentHolderId, [leadRoleId]);
    const leaderUser = makeMember(leaderUserId);
    const coLeaderUser = makeMember(coLeaderUserId);
    const memberUser = makeMember(memberUserId, [leadRoleId]);
    const elderUser = makeMember(elderUserId, [leadRoleId]);
    const guild = makeGuild(new Map([
      [currentHolderId, currentHolder],
      [leaderUserId, leaderUser],
      [coLeaderUserId, coLeaderUser],
      [memberUserId, memberUser],
      [elderUserId, elderUser],
    ]));
    const cocService = {
      getClan: vi.fn(async (tag: string) => {
        if (tag === clanTag) {
          return {
            tag: clanTag,
            name: "Lead Clan",
            members: [
              makeClanMember({
                tag: "#QGRJ2222",
                name: "Leader Player",
                role: "leader",
                townHallLevel: 16,
                leagueName: "Legend League",
              }),
              makeClanMember({
                tag: "#GRJQ2222",
                name: "CoLeader Player",
                role: "coLeader",
                townHallLevel: 15,
                leagueName: "Master League I",
              }),
              makeClanMember({
                tag: "#QPYL0289",
                name: "Member Player",
                role: "member",
                townHallLevel: 14,
                leagueName: "Crystal League I",
              }),
              makeClanMember({
                tag: "#CJVU8899",
                name: "Elder Player",
                role: "elder",
                townHallLevel: 13,
                leagueName: "Gold League I",
              }),
            ],
          };
        }
        throw new Error(`unexpected clan lookup ${tag}`);
      }),
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: "#PYLQ0289",
            discordUserId: currentHolderId,
            playerName: "Stale Holder",
          }),
          makeLinkedAccount({
            playerTag: "#QGRJ2222",
            discordUserId: leaderUserId,
            playerName: "Leader Player",
          }),
          makeLinkedAccount({
            playerTag: "#GRJQ2222",
            discordUserId: coLeaderUserId,
            playerName: "CoLeader Player",
          }),
          makeLinkedAccount({
            playerTag: "#QPYL0289",
            discordUserId: memberUserId,
            playerName: "Member Player",
          }),
          makeLinkedAccount({
            playerTag: "#CJVU8899",
            discordUserId: elderUserId,
            playerName: "Elder Player",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: clanTag, name: "Lead Clan", shortName: "LC", leadRoleId }]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshRole({
      guild,
      guildId: "111111111111111111",
      discordRoleId: leadRoleId,
      cocService: cocService as any,
    });

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(cocService.getClan).toHaveBeenCalledWith(clanTag);
    expect(cocService.getPlayerRaw).not.toHaveBeenCalled();
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(playerCurrentService.refreshCurrentPlayersFromLiveTags).not.toHaveBeenCalled();
    expect(currentHolder.roles.remove).toHaveBeenCalledWith(leadRoleId);
    expect(memberUser.roles.remove).toHaveBeenCalledWith(leadRoleId);
    expect(elderUser.roles.remove).toHaveBeenCalledWith(leadRoleId);
    expect(leaderUser.roles.add).toHaveBeenCalledWith(leadRoleId);
    expect(coLeaderUser.roles.add).toHaveBeenCalledWith(leadRoleId);
    expect(memberUser.roles.add).not.toHaveBeenCalled();
    expect(elderUser.roles.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      evaluatedCount: 5,
      addedCount: 2,
      removedCount: 3,
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it("preserves a stale tracked-clan lead role during role refresh when stale removal is disabled", async () => {
    const leadRoleId = "222222222222222222";
    const clanTag = "#2QG2C08UP";
    const currentHolderId = "111111111111111111";
    const leaderUserId = "333333333333333333";
    const currentHolder = makeMember(currentHolderId, [leadRoleId]);
    const leaderUser = makeMember(leaderUserId);
    const guild = makeGuild(new Map([
      [currentHolderId, currentHolder],
      [leaderUserId, leaderUser],
    ]));
    const cocService = {
      getClan: vi.fn(async (tag: string) => {
        if (tag === clanTag) {
          return {
            tag: clanTag,
            name: "Lead Clan",
            members: [
              makeClanMember({
                tag: "#QGRJ2222",
                name: "Leader Player",
                role: "leader",
                townHallLevel: 16,
                leagueName: "Legend League",
              }),
            ],
          };
        }
        throw new Error(`unexpected clan lookup ${tag}`);
      }),
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: "#PYLQ0289",
            discordUserId: currentHolderId,
            playerName: "Stale Holder",
          }),
          makeLinkedAccount({
            playerTag: "#QGRJ2222",
            discordUserId: leaderUserId,
            playerName: "Leader Player",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: clanTag, name: "Lead Clan", shortName: "LC", leadRoleId }]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: false,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshRole({
      guild,
      guildId: "111111111111111111",
      discordRoleId: leadRoleId,
      cocService: cocService as any,
    });

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(playerCurrentService.refreshCurrentPlayersFromLiveTags).not.toHaveBeenCalled();
    expect(currentHolder.roles.remove).not.toHaveBeenCalled();
    expect(currentHolder.__roleIds).toContain(leadRoleId);
    expect(leaderUser.roles.add).toHaveBeenCalledWith(leadRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 1,
      removedCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });
  });

  it("refreshes all tracked clans that share a lead role and evaluates both member lists", async () => {
    const leadRoleId = "222222222222222222";
    const clanTagA = "#2QG2C08UP";
    const clanTagB = "#GRJQ8899";
    const staleHolderId = "111111111111111111";
    const leaderUserId = "333333333333333333";
    const coLeaderUserId = "444444444444444444";
    const staleHolder = makeMember(staleHolderId, [leadRoleId]);
    const leaderUser = makeMember(leaderUserId);
    const coLeaderUser = makeMember(coLeaderUserId);
    const guild = makeGuild(new Map([
      [staleHolderId, staleHolder],
      [leaderUserId, leaderUser],
      [coLeaderUserId, coLeaderUser],
    ]));
    const cocService = {
      getClan: vi.fn(async (tag: string) => {
        if (tag === clanTagA) {
          return {
            tag: clanTagA,
            name: "Lead Clan A",
            members: [
              makeClanMember({
                tag: "#QGRJ2222",
                name: "Leader Player",
                role: "leader",
                townHallLevel: 16,
                leagueName: "Legend League",
              }),
            ],
          };
        }
        if (tag === clanTagB) {
          return {
            tag: clanTagB,
            name: "Lead Clan B",
            members: [
              makeClanMember({
                tag: "#GRJQ2222",
                name: "CoLeader Player",
                role: "coLeader",
                townHallLevel: 15,
                leagueName: "Master League I",
              }),
            ],
          };
        }
        throw new Error(`unexpected clan lookup ${tag}`);
      }),
      getPlayerRaw: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: "#PYLQ0289",
            discordUserId: staleHolderId,
            playerName: "Stale Holder",
          }),
          makeLinkedAccount({
            playerTag: "#QGRJ2222",
            discordUserId: leaderUserId,
            playerName: "Leader Player",
          }),
          makeLinkedAccount({
            playerTag: "#GRJQ2222",
            discordUserId: coLeaderUserId,
            playerName: "CoLeader Player",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: clanTagA, name: "Lead Clan A", shortName: "A", leadRoleId },
      { tag: clanTagB, name: "Lead Clan B", shortName: "B", leadRoleId },
    ]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshRole({
      guild,
      guildId: "111111111111111111",
      discordRoleId: leadRoleId,
      cocService: cocService as any,
    });

    expect(cocService.getClan).toHaveBeenCalledTimes(2);
    expect(cocService.getClan).toHaveBeenCalledWith(clanTagA);
    expect(cocService.getClan).toHaveBeenCalledWith(clanTagB);
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(playerCurrentService.refreshCurrentPlayersFromLiveTags).not.toHaveBeenCalled();
    expect(staleHolder.roles.remove).toHaveBeenCalledWith(leadRoleId);
    expect(leaderUser.roles.add).toHaveBeenCalledWith(leadRoleId);
    expect(coLeaderUser.roles.add).toHaveBeenCalledWith(leadRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 3,
      addedCount: 2,
      removedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it("does not remove stale tracked-clan lead roles during a guild refresh", async () => {
    const leadRoleId = "222222222222222222";
    const clanTag = "#2QG2C08UP";
    const currentHolderId = "111111111111111111";
    const leaderUserId = "333333333333333333";
    const currentHolder = makeMember(currentHolderId, [leadRoleId]);
    const leaderUser = makeMember(leaderUserId);
    const guild = makeGuild(new Map([
      [currentHolderId, currentHolder],
      [leaderUserId, leaderUser],
    ]));
    const cocService = {
      getClan: vi.fn(async (tag: string) => {
        if (tag === clanTag) {
          return {
            tag: clanTag,
            name: "Lead Clan",
            members: [
              makeClanMember({
                tag: "#QGRJ2222",
                name: "Leader Player",
                role: "leader",
                townHallLevel: 16,
                leagueName: "Legend League",
              }),
            ],
          };
        }
        throw new Error(`unexpected clan lookup ${tag}`);
      }),
      getPlayer: vi.fn(),
    };

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: "#PYLQ0289",
            discordUserId: currentHolderId,
            playerName: "Stale Holder",
          }),
          makeLinkedAccount({
            playerTag: "#QGRJ2222",
            discordUserId: leaderUserId,
            playerName: "Leader Player",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: clanTag, name: "Lead Clan", shortName: "LC", leadRoleId }]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshGuild({
      guild,
      guildId: "111111111111111111",
      cocService: cocService as any,
    });

    expect(cocService.getClan).toHaveBeenCalledTimes(1);
    expect(currentHolder.roles.remove).not.toHaveBeenCalledWith(leadRoleId);
    expect(currentHolder.__roleIds).toContain(leadRoleId);
    expect(leaderUser.roles.add).toHaveBeenCalledWith(leadRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 1,
      removedCount: 0,
      skippedCount: 1,
      failedCount: 0,
    });
  });

  it("does not remove tracked-clan lead roles during a non-lead role refresh", async () => {
    const managedRoleId = "222222222222222222";
    const leadRoleId = "444444444444444444";
    const currentHolderId = "111111111111111111";
    const qualifyingUserId = "333333333333333333";
    const currentHolder = makeMember(currentHolderId, [managedRoleId, leadRoleId]);
    const qualifyingMember = makeMember(qualifyingUserId);
    const guild = makeGuild(new Map([
      [currentHolderId, currentHolder],
      [qualifyingUserId, qualifyingMember],
    ]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows(
        [
          makeLinkedAccount({
            playerTag: "#PYLQ0289",
            discordUserId: currentHolderId,
            playerName: "Holder",
          }),
          makeLinkedAccount({
            playerTag: "#QGRJ2222",
            discordUserId: qualifyingUserId,
            playerName: "Qualifier",
          }),
        ],
        where,
      );
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP", name: "Lead Clan", shortName: "LC", leadRoleId }]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlPlayerClanSeason.findMany.mockImplementation(async ({ where }: any) => {
      if (!where.cwlClanTag.in.includes("#2QG2C08UP")) return [];
      return [
        {
          id: 1,
          season: "2026-04",
          playerTag: "#QGRJ2222",
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
      config: makeConfig({
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
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

    expect(currentHolder.roles.remove).toHaveBeenCalledWith(managedRoleId);
    expect(currentHolder.roles.remove).not.toHaveBeenCalledWith(leadRoleId);
    expect(currentHolder.__roleIds).toContain(leadRoleId);
    expect(qualifyingMember.roles.add).toHaveBeenCalledWith(managedRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 1,
      removedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
  });

  it("uses current-season tracked CWL member tags for family and CWL clan roles", async () => {
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
      return filterPlayerLinkRows([
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
      ], where);
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289" }]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#2QG2C08UP",
      },
    ]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        playerTag: "#PYLQ0289",
      },
    ]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        familyRoleId,
        cwlClanRoleId,
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

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
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clanTag: { in: ["#2QG2C08UP"] } },
        select: { clanTag: true, playerTag: true },
      }),
    );
    expect(prismaMock.cwlRoundMemberCurrent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { season: "2026-04", clanTag: { in: ["#PYLQ0289"] } },
        select: { clanTag: true, playerTag: true },
      }),
    );
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(fwaMember.roles.add).toHaveBeenCalledWith(familyRoleId);
    expect(cwlMember.roles.add).toHaveBeenCalledWith(familyRoleId);
    expect(cwlMember.roles.add).toHaveBeenCalledWith(cwlClanRoleId);
    expect(outsider.roles.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 3,
      removedCount: 0,
    });
  });

  it("builds family role-scoped candidates from tracked member tags and current holders without resolving PlayerCurrent", async () => {
    const familyRoleId = "222222222222222222";
    const staleHolderId = "111111111111111111";
    const fwaCandidateId = "333333333333333333";
    const cwlCandidateId = "444444444444444444";
    const staleHolder = makeMember(staleHolderId, [familyRoleId]);
    const fwaCandidate = makeMember(fwaCandidateId);
    const cwlCandidate = makeMember(cwlCandidateId);
    const guild = makeGuild(new Map([
      [staleHolderId, staleHolder],
      [fwaCandidateId, fwaCandidate],
      [cwlCandidateId, cwlCandidate],
    ]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows([
        makeLinkedAccount({
          playerTag: "#QGRJ2222",
          discordUserId: staleHolderId,
          playerName: "Stale Holder",
        }),
        makeLinkedAccount({
          playerTag: "#2QG2C08UP",
          discordUserId: fwaCandidateId,
          playerName: "FWA Candidate",
        }),
        makeLinkedAccount({
          playerTag: "#PYLQ0289",
          discordUserId: cwlCandidateId,
          playerName: "CWL Candidate",
        }),
      ], where);
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289" }]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#2QG2C08UP",
      },
    ]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        playerTag: "#PYLQ0289",
      },
    ]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        familyRoleId,
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshRole({
      guild,
      guildId: "111111111111111111",
      discordRoleId: familyRoleId,
    });

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          playerTag: { in: expect.arrayContaining(["#2QG2C08UP", "#PYLQ0289"]) },
        }),
      }),
    );
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(staleHolder.roles.remove).toHaveBeenCalledWith(familyRoleId);
    expect(fwaCandidate.roles.add).toHaveBeenCalledWith(familyRoleId);
    expect(cwlCandidate.roles.add).toHaveBeenCalledWith(familyRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 3,
      addedCount: 2,
      removedCount: 1,
    });
  });

  it("builds cwl role-scoped candidates from tracked member tags and current holders without resolving PlayerCurrent", async () => {
    const cwlClanRoleId = "333333333333333333";
    const staleHolderId = "111111111111111111";
    const cwlCandidateId = "444444444444444444";
    const staleHolder = makeMember(staleHolderId, [cwlClanRoleId]);
    const cwlCandidate = makeMember(cwlCandidateId);
    const guild = makeGuild(new Map([
      [staleHolderId, staleHolder],
      [cwlCandidateId, cwlCandidate],
    ]));

    prismaMock.playerLink.findMany.mockImplementation(async ({ where }: any) => {
      return filterPlayerLinkRows([
        makeLinkedAccount({
          playerTag: "#QGRJ2222",
          discordUserId: staleHolderId,
          playerName: "Stale Holder",
        }),
        makeLinkedAccount({
          playerTag: "#PYLQ0289",
          discordUserId: cwlCandidateId,
          playerName: "CWL Candidate",
        }),
      ], where);
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([{ tag: "#PYLQ0289" }]);
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#PYLQ0289",
        playerTag: "#PYLQ0289",
      },
    ]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        cwlClanRoleId,
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshRole({
      guild,
      guildId: "111111111111111111",
      discordRoleId: cwlClanRoleId,
    });

    expect(prismaMock.playerLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          playerTag: { in: ["#PYLQ0289"] },
        }),
      }),
    );
    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
    expect(staleHolder.roles.remove).toHaveBeenCalledWith(cwlClanRoleId);
    expect(cwlCandidate.roles.add).toHaveBeenCalledWith(cwlClanRoleId);
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 1,
      removedCount: 1,
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
    prismaMock.cwlRoundMemberCurrent.findMany.mockResolvedValue([]);
    vi.spyOn(autoRoleService, "getGuildStateSnapshot").mockResolvedValue({
      config: makeConfig({
        cwlClanRoleId,
        applyNicknames: false,
        removeStaleManagedRoles: true,
      }),
      rules: [],
      exclusions: { users: [], roles: [] },
    } as any);

    const result = await autoRoleRefreshService.refreshGuild({
      guild,
      guildId: "111111111111111111",
    });

    expect(playerCurrentService.resolveCurrentPlayersForTags).not.toHaveBeenCalled();
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
      return filterPlayerLinkRows([
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
      ], where);
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
      return filterPlayerLinkRows([
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
      ], where);
    });
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#2QG2C08UP" }]);
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#2QG2C08UP",
      },
      {
        clanTag: "#2QG2C08UP",
        playerTag: "#PYLQ0289",
      },
    ]);
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
    expect(normalUser.roles.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      evaluatedCount: 2,
      addedCount: 0,
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
