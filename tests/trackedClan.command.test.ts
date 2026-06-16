import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityService } from "../src/services/ActivityService";
import { emojiResolverService } from "../src/services/emoji/EmojiResolverService";
import * as trackedClanListService from "../src/services/TrackedClanListService";

const prismaMock = vi.hoisted(() => {
  const trackedClan = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  };
  const trackedClanRep = {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  };
  return {
    trackedClan,
    trackedClanRep,
    cwlTrackedClan: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    cwlRotationPlan: {
      updateMany: vi.fn(),
    },
    raidTrackedClan: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
    },
    cwlPlayerClanSeason: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      deleteMany: vi.fn(),
    },
    roster: {
      findMany: vi.fn(),
    },
    currentWar: {
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
    currentCwlRound: {
      findMany: vi.fn(),
    },
    currentCwlPrepSnapshot: {
      findMany: vi.fn(),
    },
    cwlRoundHistory: {
      findMany: vi.fn(),
    },
    fwaClanMemberCurrent: {
      groupBy: vi.fn(),
    },
    $transaction: vi.fn(async (arg: any) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === "function") {
        return arg({
          trackedClan,
          trackedClanRep,
          cwlTrackedClan: prismaMock.cwlTrackedClan,
          cwlPlayerClanSeason: prismaMock.cwlPlayerClanSeason,
          cwlRotationPlan: prismaMock.cwlRotationPlan,
        });
      }
      return arg;
    }),
  };
});

const cocQueueMock = vi.hoisted(() => ({
  runWithCoCQueueContext: vi.fn(async (_context: unknown, run: () => Promise<unknown>) => run()),
}));

const fwaClanMembersSyncMock = vi.hoisted(() => ({
  refreshCurrentClanMembersForClanTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: cocQueueMock.runWithCoCQueueContext,
}));

vi.mock("../src/services/fwa-feeds/FwaClanMembersSyncService", () => ({
  FwaClanMembersSyncService: vi.fn().mockImplementation(() => ({
    refreshCurrentClanMembersForClanTags: fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags,
  })),
}));

import {
  TrackedClan,
  refreshRaidTrackedClanListWithQueueContext,
} from "../src/commands/TrackedClan";

type InteractionInput = {
  subcommand: string;
  strings?: Record<string, string | null | undefined>;
  integers?: Record<string, number | null | undefined>;
  channels?: Record<string, { id: string; isTextBased?: () => boolean } | null | undefined>;
  roles?: Record<string, { id: string } | null | undefined>;
  guildId?: string | null;
};

/** Purpose: build a focused tracked-clan chat interaction mock for subcommand tests. */
function createInteraction(input: InteractionInput) {
  const strings = input.strings ?? {};
  const integers = input.integers ?? {};
  const channels = input.channels ?? {};
  const roles = input.roles ?? {};
  const collectorHandlers: Record<string, (button: any) => Promise<void>> = {};
  const collector = {
    on: vi.fn((event: string, handler: (button: any) => Promise<void>) => {
      collectorHandlers[event] = handler;
      return collector;
    }),
  };
  return {
    id: "tracked-clan-itx-1",
    commandName: "clan",
    deferred: true,
    replied: false,
    guildId: input.guildId ?? "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => strings[name] ?? null),
      getInteger: vi.fn((name: string) => integers[name] ?? null),
      getChannel: vi.fn((name: string) => channels[name] ?? null),
      getRole: vi.fn((name: string) => roles[name] ?? null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue({
      createMessageComponentCollector: vi.fn(() => collector),
    }),
    __collectorHandlers: collectorHandlers,
  };
}

/** Purpose: extract command reply content from one tracked-clan interaction mock. */
function getReplyContent(interaction: any): string {
  const payload = interaction.editReply.mock.calls[0]?.[0] as any;
  return String(payload?.content ?? "");
}

/** Purpose: extract the first tracked-clan embed description from one interaction mock. */
function getFirstEmbedDescription(interaction: any): string {
  const payload = interaction.editReply.mock.calls[0]?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getEmbedDescriptions(interaction: any): string[] {
  const payload =
    (interaction.editReply.mock.calls.find((call) => Array.isArray((call[0] as any)?.embeds))?.[0] as any) ??
    (interaction.editReply.mock.calls[0]?.[0] as any);
  return (payload?.embeds ?? []).map((embed: any) => String(embed?.toJSON?.().description ?? ""));
}

function makeButtonInteraction(customId: string) {
  return {
    customId,
    user: { id: "user-1" },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("/clan command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ActivityService.prototype, "observeClan").mockResolvedValue(undefined as any);
    vi.spyOn(emojiResolverService, "resolveByName").mockResolvedValue(null as any);

    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.trackedClan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.trackedClanRep.findMany.mockResolvedValue([]);
    prismaMock.trackedClanRep.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.trackedClanRep.createMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue(null);
    prismaMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.roster.findMany.mockResolvedValue([]);
    prismaMock.currentWar.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.currentCwlRound.findMany.mockResolvedValue([]);
    prismaMock.currentCwlPrepSnapshot.findMany.mockResolvedValue([]);
    prismaMock.cwlRoundHistory.findMany.mockResolvedValue([]);
    fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags.mockResolvedValue({
      clanCount: 0,
      rowCount: 0,
      changedRowCount: 0,
      failedClans: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("adds CWL tags with partial success and reports added/existing/invalid/duplicates", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#QGRJ2222" }])
      .mockResolvedValueOnce([{ tag: "#PYLQ0289" }, { tag: "#QGRJ2222" }]);
    const interaction = createInteraction({
      subcommand: "cwl-tags",
      strings: {
        "cwl-tags": "[#PYLQ0289,QGRJ2222,BADTAG,#PYLQ0289]",
      },
    });
    const cocService = {
      getClan: vi.fn().mockRejectedValue(new Error("boom")),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.cwlTrackedClan.createMany).toHaveBeenCalledWith({
      data: [
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: null,
          leagueLabel: null,
        },
      ],
      skipDuplicates: true,
    });
    const content = getReplyContent(interaction);
    expect(content).toContain("Updated CWL tracked clans for season 2026-03.");
    expect(content).toContain("added: #PYLQ0289");
    expect(content).toContain("already existed: #QGRJ2222");
    expect(content).toContain("invalid: BADTAG");
    expect(content).toContain("duplicates in request: #PYLQ0289");

    const infoLogs = (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => String(call[0] ?? ""),
    );
    expect(infoLogs.some((line: string) => line.includes("stage=command_entered"))).toBe(true);
    expect(infoLogs.some((line: string) => line.includes("stage=interaction_deferred"))).toBe(true);
    expect(infoLogs.some((line: string) => line.includes("stage=cwl_tags_parsed"))).toBe(true);
    expect(
      infoLogs.some((line: string) => line.includes("stage=cwl_tags_existing_rows_loaded")),
    ).toBe(true);
    expect(infoLogs.some((line: string) => line.includes("stage=cwl_tags_create_many"))).toBe(true);
    expect(infoLogs.some((line: string) => line.includes("stage=cwl_tags_final_reply_sent"))).toBe(true);
  });

  it("hydrates CWL metadata immediately after adding tracked clans when clan lookups succeed", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([{ tag: "#QGRJ2222" }])
      .mockResolvedValueOnce([{ tag: "#PYLQ0289" }, { tag: "#QGRJ2222" }])
      .mockResolvedValueOnce([{ tag: "#PYLQ0289" }, { tag: "#QGRJ2222" }]);
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 1 });
    const interaction = createInteraction({
      subcommand: "cwl-tags",
      strings: {
        "cwl-tags": "[#PYLQ0289,QGRJ2222]",
      },
    });
    const cocService = {
      getClan: vi.fn(async (tag: string) => ({
        name: tag === "#PYLQ0289" ? "CWL Alpha" : "CWL Beta",
        warLeague: { name: tag === "#PYLQ0289" ? "Champion League II" : "Champion League I" },
      })),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(cocService.getClan).toHaveBeenCalledWith("#PYLQ0289");
    expect(cocService.getClan).toHaveBeenCalledWith("#QGRJ2222");
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#PYLQ0289",
        OR: [{ name: null }, { name: "" }, { leagueLabel: null }, { leagueLabel: "" }],
      },
      data: {
        name: "CWL Alpha",
        leagueLabel: "Champion League II",
      },
    });
    expect(prismaMock.cwlTrackedClan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        tag: "#QGRJ2222",
        OR: [{ name: null }, { name: "" }, { leagueLabel: null }, { leagueLabel: "" }],
      },
      data: {
        name: "CWL Beta",
        leagueLabel: "Champion League I",
      },
    });
    expect(getReplyContent(interaction)).toContain("Updated CWL tracked clans for season 2026-03.");
  });

  it("adds raid tags with optional upgrades and refreshes joinType best-effort", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([]);
    const interaction = createInteraction({
      subcommand: "raid-tags",
      strings: {
        "raid-tags": "[#2RVGJYLC0]",
      },
      integers: {
        upgrades: 3331,
      },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Vanilla", type: "open" }),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.raidTrackedClan.createMany).toHaveBeenCalledWith({
      data: [
        {
          clanTag: "2RVGJYLC0",
          name: "Vanilla",
          upgrades: 3331,
          joinType: "open",
        },
      ],
      skipDuplicates: true,
    });
    expect(getReplyContent(interaction)).toContain("Updated RAIDS tracked clans.");
    expect(getReplyContent(interaction)).toContain("added: #2RVGJYLC0");
    expect(getReplyContent(interaction)).toContain("updated upgrades: none");
    expect(getReplyContent(interaction)).toContain("already-existing: none");
    expect(getReplyContent(interaction)).toContain("duplicates-ignored: none");
    expect(prismaMock.raidTrackedClan.updateMany).not.toHaveBeenCalled();
  });

  it("wraps RAID refresh metadata fetches in a CoC queue context", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        name: null,
        joinType: null,
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Vanilla", type: "open" }),
    };

    const result = await refreshRaidTrackedClanListWithQueueContext({
      cocService: cocService as any,
    });

    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "tracked-clan:list:raids:refresh",
      }),
      expect.any(Function),
    );
    expect(prismaMock.raidTrackedClan.updateMany).toHaveBeenCalledWith({
      where: { clanTag: "2RVGJYLC0" },
      data: {
        name: "Vanilla",
        joinType: "open",
      },
    });
    expect(result.joinTypeRefreshFailures).toEqual([]);
  });

  it("rejects upgrades when multiple raid tags are provided", async () => {
    const interaction = createInteraction({
      subcommand: "raid-tags",
      strings: {
        "raid-tags": "#2RVGJYLC0,#2QG2C08UP",
      },
      integers: {
        upgrades: 3000,
      },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(getReplyContent(interaction)).toContain(
      "upgrades can only be set when exactly one raid tag is provided.",
    );
  });

  it("rejects upgrades outside the allowed range", async () => {
    const interaction = createInteraction({
      subcommand: "raid-tags",
      strings: {
        "raid-tags": "#2RVGJYLC0",
      },
      integers: {
        upgrades: 1999,
      },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.raidTrackedClan.createMany).not.toHaveBeenCalled();
    expect(getReplyContent(interaction)).toContain(
      "upgrades must be a whole number between 2000 and 3331.",
    );
  });

  it("renders the RAIDS list with stored clan name, lock/unlock emoji, and a refresh button", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        name: "Vanilla",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "RAIDS" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect(description).toContain("**RAIDS**");
    expect(description).toContain("Vanilla | 3331");
    const buttonIds = payload?.components?.[0]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(buttonIds).toContain("tracked-clan-list:raids-summary:tracked-clan-itx-1:refresh");
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("renders the default typed FWA minimal overview when type:FWA is provided", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: "leader-channel-1",
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const description = getFirstEmbedDescription(interaction);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(payload?.embeds?.[0]?.toJSON?.().title).toBe("Tracked Clans (FWA) (1)");
    expect(description).toContain("**FWA**");
    expect(description).toContain("Alpha Clan");
    expect(description).not.toContain("leadRole:");
    expect(payload?.components).toHaveLength(1);
    expect(payload?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:fwa-summary:tracked-clan-itx-1:refresh",
    );
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("renders linked FWA clan titles when type:FWA display:detailed is provided", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: "leader-channel-1",
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", playerTag: "#2RVGJYLC0" },
      { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const description = getFirstEmbedDescription(interaction);
    expect(description).toContain(
      "**[Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>)** `#2QG2C08UP`",
    );
    expect(description).toContain("shortName: AC");
    expect(description).toContain("leaderChannel: <#leader-channel-1>");
    expect(description).toContain("leadRole: <@&lead-role-1>");
    expect(description).toContain("reps: #2RVGJYLC0, #PYLQ0289");
    expect(interaction.editReply.mock.calls[0]?.[0]?.components).toEqual([]);
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("renders the default typed CWL minimal overview when type:CWL is provided", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: "CWL Alpha",
          leagueLabel: "Champion League I",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
        {
          season: "2026-03",
          tag: "#QGRJ2222",
          name: "CWL Beta",
          leagueLabel: "Master League I",
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
        },
        {
          season: "2026-03",
          tag: "#G2R9RQLJQ",
          name: "CWL Charlie",
          leagueLabel: "Master League I",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: "CWL Alpha",
          leagueLabel: "Champion League I",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
        {
          season: "2026-03",
          tag: "#QGRJ2222",
          name: "CWL Beta",
          leagueLabel: "Master League I",
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
        },
        {
          season: "2026-03",
          tag: "#G2R9RQLJQ",
          name: "CWL Charlie",
          leagueLabel: "Master League I",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Champion League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        season: "2026-03",
        tag: "#QGRJ2222",
        name: "CWL Beta",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        season: "2026-03",
        tag: "#G2R9RQLJQ",
        name: "CWL Charlie",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([
      { cwlClanTag: "#PYLQ0289", _count: { cwlClanTag: 37 } },
      { cwlClanTag: "#QGRJ2222", _count: { cwlClanTag: 31 } },
      { cwlClanTag: "#G2R9RQLJQ", _count: { cwlClanTag: 27 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#PYLQ0289", _count: { clanTag: 49 } },
      { clanTag: "#QGRJ2222", _count: { clanTag: 50 } },
      { clanTag: "#G2R9RQLJQ", _count: { clanTag: 51 } },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([
      { cwlClanTag: "#PYLQ0289", _count: { cwlClanTag: 37 } },
      { cwlClanTag: "#QGRJ2222", _count: { cwlClanTag: 31 } },
      { cwlClanTag: "#G2R9RQLJQ", _count: { cwlClanTag: 27 } },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const description = getFirstEmbedDescription(interaction);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(description).toContain("**CWL**");
    expect(description).toContain(
      "<:CWL_Champion_1:1511515166313939116> CH1 | [CWL Alpha](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=PYLQ0289>) `#PYLQ0289` | ⚔️ | 49 👥",
    );
    expect(description).toContain(
      "<:CWL_Master_1:1511515179236593674> M1 | [CWL Charlie](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=G2R9RQLJQ>) `#G2R9RQLJQ` | ⚔️ | 51 👥",
    );
    expect(description).toContain(
      "<:CWL_Master_1:1511515179236593674> M1 | [CWL Beta](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=QGRJ2222>) `#QGRJ2222` | ⚔️ | 50 👥",
    );
    expect(description.indexOf("CWL Alpha")).toBeLessThan(description.indexOf("CWL Charlie"));
    expect(description.indexOf("CWL Charlie")).toBeLessThan(description.indexOf("CWL Beta"));
    expect(description).not.toContain("registry: CWL seasonal");
    expect(payload?.components).toHaveLength(1);
    expect(payload?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:cwl-summary:tracked-clan-itx-1:refresh",
    );
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("renders CWL minimal rows with a safe abbreviation fallback for unknown leagues", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: null,
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValue([
      { cwlClanTag: "#PYLQ0289", _count: { cwlClanTag: 37 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValue([
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "minimal" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const description = getFirstEmbedDescription(interaction);
    expect(description).toContain(
      "- UNK | [CWL Alpha](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=PYLQ0289>) `#PYLQ0289` |",
    );
    expect(description).toContain("| 12 👥");
    expect(description).not.toContain("leadRole:");
  });

  it("renders detailed CWL rows with league labels, spin status, counts, roster links, and sorted order", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "Alpha Clan",
        leagueLabel: "Champion League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        season: "2026-03",
        tag: "#QGRJ2222",
        name: "Beta Clan",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        season: "2026-03",
        tag: "#G2R9RQLJQ",
        name: "Charlie Clan",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "Alpha Clan",
        leagueLabel: "Champion League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        season: "2026-03",
        tag: "#QGRJ2222",
        name: "Beta Clan",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        season: "2026-03",
        tag: "#G2R9RQLJQ",
        name: "Charlie Clan",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([
      { cwlClanTag: "#PYLQ0289", _count: { cwlClanTag: 37 } },
      { cwlClanTag: "#QGRJ2222", _count: { cwlClanTag: 31 } },
      { cwlClanTag: "#G2R9RQLJQ", _count: { cwlClanTag: 27 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#PYLQ0289", _count: { clanTag: 49 } },
      { clanTag: "#QGRJ2222", _count: { clanTag: 50 } },
      { clanTag: "#G2R9RQLJQ", _count: { clanTag: 51 } },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValueOnce([
      { clanTag: "#PYLQ0289" },
      { clanTag: "#G2R9RQLJQ" },
    ]);
    prismaMock.roster.findMany.mockResolvedValueOnce([
      {
        id: "roster-a",
        title: "Alpha Roster",
        clanTag: "#PYLQ0289",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/1/2/3",
        postedAt: new Date("2026-03-04T00:00:00.000Z"),
        createdAt: new Date("2026-03-04T00:00:00.000Z"),
      },
      {
        id: "roster-b",
        title: "Zulu Roster",
        clanTag: "#QGRJ2222",
        lifecycleState: "ACTIVE",
        postedMessageUrl: null,
        postedAt: null,
        createdAt: new Date("2026-03-05T00:00:00.000Z"),
      },
      {
        id: "roster-c",
        title: "Alpha Roster",
        clanTag: "#G2R9RQLJQ",
        lifecycleState: "CLOSED",
        postedMessageUrl: "https://discord.com/channels/1/2/4",
        postedAt: new Date("2026-03-06T00:00:00.000Z"),
        createdAt: new Date("2026-03-06T00:00:00.000Z"),
      },
    ]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn(),
      getClan: vi.fn(),
    };

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    const description = getFirstEmbedDescription(interaction);
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(description).toContain(
      "**[Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=PYLQ0289>)** `#PYLQ0289` <:CWL_Champion_1:1511515166313939116>",
    );
    expect(description).toContain("Spin status: ⚔️");
    expect(description).toContain("Members: 37 CWL / 49 clan");
    expect(description).toContain("Roster: [Alpha Roster](<https://discord.com/channels/1/2/3>)");
    expect(description).toContain("Roster: Zulu Roster");
    expect(description).not.toContain("registry: CWL seasonal");
    expect(description).not.toContain("Champion League I");
    expect(description).not.toContain("Master League I");
    expect(description.indexOf("Alpha Clan")).toBeLessThan(description.indexOf("Beta Clan"));
    expect(description.indexOf("Charlie Clan")).toBeLessThan(description.indexOf("Beta Clan"));
    expect(description.indexOf("Alpha Roster")).toBeLessThan(description.indexOf("Zulu Roster"));
    expect(payload?.components?.length).toBeGreaterThanOrEqual(1);
    expect(payload?.components?.[payload.components.length - 1]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:cwl:tracked-clan-itx-1:refresh",
    );
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
    expect(cocService.getClanWarLeagueGroup).not.toHaveBeenCalled();
  });

  it("resolves CWL league and spin emojis through the application emoji resolver by name", async () => {
    const resolveByNameMock = vi.mocked(emojiResolverService.resolveByName);
    resolveByNameMock.mockImplementation(async (_client, name) => {
      const lookup = String(name ?? "");
      if (lookup === "CWL_Champion_1") {
        return { rendered: "<resolved:cwl_champion_1>" } as any;
      }
      if (lookup === "a_search_2") {
        return { rendered: "<resolved:a_search_2>" } as any;
      }
      return null;
    });

    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "Alpha Clan",
        leagueLabel: "Champion League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    vi.spyOn(trackedClanListService, "listCwlTrackedClansForDetailedDisplay").mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "Alpha Clan",
        leagueLabel: "Champion League I",
        spinStatus: "searching",
        observedCwlRosterCount: 37,
        currentClanMemberCount: 49,
        rosterTitle: "Alpha Roster",
        rosterPostedMessageUrl: "https://discord.com/channels/1/2/3",
      },
    ]);

    const client = { application: { fetch: vi.fn().mockResolvedValue(undefined) } } as any;
    const cocService = {
      getClanWarLeagueGroup: vi.fn(),
      getClan: vi.fn(),
    };
    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run(client, interaction as any, cocService as any);

    const description = getFirstEmbedDescription(interaction);
    expect(description).toContain("<resolved:cwl_champion_1>");
    expect(description).toContain("Spin status: <resolved:a_search_2>");
    expect(resolveByNameMock).toHaveBeenCalledWith(client, "CWL_Champion_1");
    expect(resolveByNameMock).toHaveBeenCalledWith(client, "a_search_2");
  });

  it("falls back to the literal CWL emoji token when resolver lookup fails", async () => {
    const resolveByNameMock = vi.mocked(emojiResolverService.resolveByName);
    resolveByNameMock.mockResolvedValue(null as any);

    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "Alpha Clan",
        leagueLabel: "Champion League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    vi.spyOn(trackedClanListService, "listCwlTrackedClansForDetailedDisplay").mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "Alpha Clan",
        leagueLabel: "Champion League I",
        spinStatus: "searching",
        observedCwlRosterCount: 37,
        currentClanMemberCount: 49,
        rosterTitle: "Alpha Roster",
        rosterPostedMessageUrl: "https://discord.com/channels/1/2/3",
      },
    ]);

    const client = { application: { fetch: vi.fn().mockResolvedValue(undefined) } } as any;
    const cocService = {
      getClanWarLeagueGroup: vi.fn(),
      getClan: vi.fn(),
    };
    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run(client, interaction as any, cocService as any);

    const description = getFirstEmbedDescription(interaction);
    expect(description).toContain("<:CWL_Champion_1:1511515166313939116>");
    expect(description).toContain("Spin status: <a:a_search_2:1511522352356397179>");
  });

  it("packs many short FWA clan blocks onto one page when they fit", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, index) => ({
        tag: `#2QG2C08U${index}`,
        name: `FWA Clan ${index + 1}`,
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        clanRoleId: null,
        clanBadge: null,
        shortName: `S${index + 1}`,
        createdAt: new Date(`2026-04-0${index + 1}T00:00:00.000Z`),
        updatedAt: new Date(`2026-04-0${index + 1}T00:00:00.000Z`),
      })),
    );

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect((description.match(/shortName:/g) ?? []).length).toBe(5);
    expect(description.length).toBeLessThanOrEqual(3900);
    expect(payload?.components).toEqual([]);
  });

  it("shows a detailed CWL refresh button and updates rows after refresh", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: "CWL Alpha",
          leagueLabel: "Master League I",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: "CWL Alpha",
          leagueLabel: "Master League I",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValueOnce([]);
    prismaMock.roster.findMany.mockResolvedValueOnce([
      {
        id: "roster-before",
        title: "Old Roster",
        clanTag: "#PYLQ0289",
        lifecycleState: "OPEN",
        postedMessageUrl: null,
        postedAt: null,
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([{ clanTag: "#PYLQ0289", _count: { clanTag: 49 } }]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({ season: "2026-03", state: "searching" }),
      getClan: vi.fn().mockResolvedValue({ name: "CWL Alpha", warLeague: { name: "Champion League I" } }),
    };
    vi.spyOn(trackedClanListService, "listCwlTrackedClansForDetailedDisplay").mockResolvedValue([
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: "CWL Alpha",
          leagueLabel: "Master League I",
          spinStatus: "searching",
          observedCwlRosterCount: 31,
          currentClanMemberCount: 49,
          rosterTitle: "Old Roster",
          rosterPostedMessageUrl: null,
        },
    ]);
    const refreshHelperMock = vi
      .spyOn(trackedClanListService, "refreshCwlTrackedClanDetailedDisplayWithQueueContext")
      .mockResolvedValue({
        season: "2026-03",
        displayedClanCount: 1,
        failedClanCount: 0,
        failedClanTags: [],
        metadataHydratedCount: 1,
        metadataSkippedCount: 0,
        matchedCount: 1,
        searchingCount: 0,
        idleCount: 0,
        rows: [
          {
            season: "2026-03",
            tag: "#PYLQ0289",
            name: "CWL Alpha",
            leagueLabel: "Champion League I",
            spinStatus: "matched",
            observedCwlRosterCount: 31,
            currentClanMemberCount: 50,
            rosterTitle: "Refreshed Roster",
            rosterPostedMessageUrl: "https://discord.com/channels/1/2/99",
          },
        ],
      });

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);
    expect(vi.getTimerCount()).toBe(1);

    const collectHandler = interaction.__collectorHandlers.collect as
      | ((button: any) => Promise<void>)
      | undefined;
    const refreshButton = makeButtonInteraction("tracked-clan-list:cwl:tracked-clan-itx-1:refresh");
    const collectPromise = collectHandler?.(refreshButton);
    await collectPromise;

    expect(refreshButton.update).toHaveBeenCalled();
    const refreshingPayload = refreshButton.update.mock.calls[0]?.[0] as any;
    const refreshingComponents = refreshingPayload?.components?.map((row: any) => row.toJSON?.());
    expect(String(refreshingPayload?.embeds?.[0]?.toJSON?.().description ?? "")).toContain(
      "Spin status: <a:a_search_2:1511522352356397179>",
    );
    expect(JSON.stringify(refreshingComponents)).toContain('"tracked-clan-list:cwl:tracked-clan-itx-1:refresh"');
    expect(JSON.stringify(refreshingComponents)).toContain('"disabled":true');
    expect(refreshHelperMock).toHaveBeenCalledWith(
      expect.objectContaining({
        season: "2026-03",
        guildId: "guild-1",
        cocService,
      }),
    );
    const refreshedCall = interaction.editReply.mock.calls.find((call) =>
      String(call[0]?.embeds?.[0]?.toJSON?.().description ?? "").includes(
        "<:CWL_Champion_1:1511515166313939116>",
      ),
    );
    expect(String(refreshedCall?.[0]?.embeds?.[0]?.toJSON?.().description ?? "")).toContain(
      "Members: 31 CWL / 50 clan",
    );
    expect(String(refreshedCall?.[0]?.embeds?.[0]?.toJSON?.().description ?? "")).toContain(
      "Roster: [Refreshed Roster](<https://discord.com/channels/1/2/99>)",
    );
    const latestPayload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
    expect(JSON.stringify(latestPayload?.components?.map((row: any) => row.toJSON?.()) ?? [])).toContain(
      '"disabled":false',
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(refreshHelperMock).toHaveBeenCalledTimes(1);
  });

  it("renders detailed CWL overflow as seamless multi-embed output without page footers", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => {
      const tag = "#PYLQ0289";
      return {
        season: "2026-03",
        tag,
        name: `CWL Overflow Clan ${String(index + 1).padStart(2, "0")} `.repeat(24).trim(),
        leagueLabel: "Champion League I",
        createdAt: new Date(`2026-03-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`),
      };
    });
    const cwlSeasonCounts = [{ cwlClanTag: "#PYLQ0289", _count: { cwlClanTag: 40 } }];
    const fwaCounts = [{ clanTag: "#PYLQ0289", _count: { clanTag: 50 } }];
    const rosterRows = [
      {
        id: "roster-overflow",
        title: "CWL Overflow Roster ".repeat(24).trim(),
        clanTag: "#PYLQ0289",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/1/2/overflow",
        postedAt: new Date("2026-03-01T00:00:00.000Z"),
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ];
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows).mockResolvedValue(rows);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce(cwlSeasonCounts).mockResolvedValue(cwlSeasonCounts);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce(fwaCounts).mockResolvedValue(fwaCounts);
    prismaMock.roster.findMany.mockResolvedValueOnce(rosterRows).mockResolvedValue(rosterRows);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload =
      (interaction.editReply.mock.calls.find((call) => Array.isArray((call[0] as any)?.embeds))?.[0] as any) ??
      (interaction.editReply.mock.calls[0]?.[0] as any);
    const descriptions = getEmbedDescriptions(interaction);
    expect((payload?.embeds ?? []).length).toBeGreaterThan(1);
    expect(descriptions.every((description) => description.length <= 4096)).toBe(true);
    expect(descriptions.every((description) => !description.includes("Page 1/1"))).toBe(true);
    expect(JSON.stringify(payload?.embeds ?? [])).not.toContain("Page 1/1");
    expect(descriptions.join("\n")).toContain("Roster:");
    expect(payload?.components?.[payload.components.length - 1]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:cwl:tracked-clan-itx-1:refresh",
    );
  });

  it("does not start the detailed CWL auto-refresh interval when all rows are matched", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValueOnce([]);
    prismaMock.roster.findMany.mockResolvedValueOnce([
      {
        id: "roster-before",
        title: "Old Roster",
        clanTag: "#PYLQ0289",
        lifecycleState: "OPEN",
        postedMessageUrl: null,
        postedAt: null,
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([{ clanTag: "#PYLQ0289", _count: { clanTag: 49 } }]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({ season: "2026-03", state: "matched" }),
      getClan: vi.fn().mockResolvedValue({ name: "CWL Alpha", warLeague: { name: "Champion League I" } }),
    };
    vi.spyOn(trackedClanListService, "listCwlTrackedClansForDetailedDisplay").mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        spinStatus: "matched",
        observedCwlRosterCount: 31,
        currentClanMemberCount: 49,
        rosterTitle: "Old Roster",
        rosterPostedMessageUrl: null,
      },
    ]);
    const refreshHelperMock = vi
      .spyOn(trackedClanListService, "refreshCwlTrackedClanDetailedDisplayWithQueueContext")
      .mockResolvedValue({
        season: "2026-03",
        displayedClanCount: 1,
        failedClanCount: 0,
        failedClanTags: [],
        metadataHydratedCount: 0,
        metadataSkippedCount: 0,
        matchedCount: 1,
        searchingCount: 0,
        idleCount: 0,
        rows: [
          {
            season: "2026-03",
            tag: "#PYLQ0289",
            name: "CWL Alpha",
            leagueLabel: "Champion League I",
            spinStatus: "matched",
            observedCwlRosterCount: 31,
            currentClanMemberCount: 49,
            rosterTitle: "Old Roster",
            rosterPostedMessageUrl: null,
          },
        ],
      });

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(refreshHelperMock).not.toHaveBeenCalled();
  });

  it("does not start the detailed CWL auto-refresh interval when all rows are idle", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValueOnce([]);
    prismaMock.roster.findMany.mockResolvedValueOnce([
      {
        id: "roster-before",
        title: "Old Roster",
        clanTag: "#PYLQ0289",
        lifecycleState: "OPEN",
        postedMessageUrl: null,
        postedAt: null,
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([{ clanTag: "#PYLQ0289", _count: { clanTag: 49 } }]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({ season: "2026-03", state: "idle" }),
      getClan: vi.fn().mockResolvedValue({ name: "CWL Alpha", warLeague: { name: "Champion League I" } }),
    };
    vi.spyOn(trackedClanListService, "listCwlTrackedClansForDetailedDisplay").mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        spinStatus: "idle",
        observedCwlRosterCount: 31,
        currentClanMemberCount: 49,
        rosterTitle: "Old Roster",
        rosterPostedMessageUrl: null,
      },
    ]);
    const refreshHelperMock = vi
      .spyOn(trackedClanListService, "refreshCwlTrackedClanDetailedDisplayWithQueueContext")
      .mockResolvedValue({
        season: "2026-03",
        displayedClanCount: 1,
        failedClanCount: 0,
        failedClanTags: [],
        metadataSkippedCount: 0,
        matchedCount: 0,
        searchingCount: 0,
        idleCount: 1,
        rows: [
          {
            season: "2026-03",
            tag: "#PYLQ0289",
            name: "CWL Alpha",
            leagueLabel: "Master League I",
            spinStatus: "idle",
            observedCwlRosterCount: 31,
            currentClanMemberCount: 49,
            rosterTitle: "Old Roster",
            rosterPostedMessageUrl: null,
          },
        ],
      });

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(refreshHelperMock).not.toHaveBeenCalled();
  });

  it("runs the detailed CWL auto-refresh interval and stops it once all rows are matched", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValueOnce([]);
    prismaMock.roster.findMany.mockResolvedValueOnce([
      {
        id: "roster-before",
        title: "Old Roster",
        clanTag: "#PYLQ0289",
        lifecycleState: "OPEN",
        postedMessageUrl: null,
        postedAt: null,
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([{ clanTag: "#PYLQ0289", _count: { clanTag: 49 } }]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({ season: "2026-03", state: "searching" }),
      getClan: vi.fn().mockResolvedValue({ name: "CWL Alpha", warLeague: { name: "Champion League I" } }),
    };
    vi.spyOn(trackedClanListService, "listCwlTrackedClansForDetailedDisplay").mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        spinStatus: "searching",
        observedCwlRosterCount: 31,
        currentClanMemberCount: 49,
        rosterTitle: "Old Roster",
        rosterPostedMessageUrl: null,
      },
    ]);
    const refreshHelperMock = vi
      .spyOn(trackedClanListService, "refreshCwlTrackedClanDetailedDisplayWithQueueContext")
      .mockResolvedValue({
        season: "2026-03",
        displayedClanCount: 1,
        failedClanCount: 0,
        failedClanTags: [],
        metadataHydratedCount: 1,
        metadataSkippedCount: 0,
        matchedCount: 1,
        searchingCount: 0,
        idleCount: 0,
        rows: [
          {
            season: "2026-03",
            tag: "#PYLQ0289",
            name: "CWL Alpha",
            leagueLabel: "Champion League I",
            spinStatus: "matched",
            observedCwlRosterCount: 31,
            currentClanMemberCount: 50,
            rosterTitle: "Refreshed Roster",
            rosterPostedMessageUrl: "https://discord.com/channels/1/2/99",
          },
        ],
      });

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(120000);

    expect(refreshHelperMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const refreshedCall = interaction.editReply.mock.calls.find((call) =>
      String(call[0]?.embeds?.[0]?.toJSON?.().description ?? "").includes("Spin status: ⚔️"),
    );
    expect(String(refreshedCall?.[0]?.embeds?.[0]?.toJSON?.().description ?? "")).toContain(
      "Spin status: ⚔️",
    );
  });

  it("clears the detailed CWL auto-refresh interval when the collector ends", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlPlayerClanSeason.groupBy.mockResolvedValueOnce([]);
    prismaMock.currentCwlRound.findMany.mockResolvedValueOnce([]);
    prismaMock.roster.findMany.mockResolvedValueOnce([
      {
        id: "roster-before",
        title: "Old Roster",
        clanTag: "#PYLQ0289",
        lifecycleState: "OPEN",
        postedMessageUrl: null,
        postedAt: null,
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([{ clanTag: "#PYLQ0289", _count: { clanTag: 49 } }]);
    const cocService = {
      getClanWarLeagueGroup: vi.fn().mockResolvedValue({ season: "2026-03", state: "searching" }),
      getClan: vi.fn().mockResolvedValue({ name: "CWL Alpha", warLeague: { name: "Champion League I" } }),
    };
    vi.spyOn(trackedClanListService, "listCwlTrackedClansForDetailedDisplay").mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        leagueLabel: "Master League I",
        spinStatus: "searching",
        observedCwlRosterCount: 31,
        currentClanMemberCount: 49,
        rosterTitle: "Old Roster",
        rosterPostedMessageUrl: null,
      },
    ]);
    const refreshHelperMock = vi
      .spyOn(trackedClanListService, "refreshCwlTrackedClanDetailedDisplayWithQueueContext")
      .mockResolvedValue({
        season: "2026-03",
        displayedClanCount: 1,
        failedClanCount: 0,
        failedClanTags: [],
        metadataHydratedCount: 1,
        metadataSkippedCount: 0,
        matchedCount: 1,
        searchingCount: 0,
        idleCount: 0,
        rows: [
          {
            season: "2026-03",
            tag: "#PYLQ0289",
            name: "CWL Alpha",
            leagueLabel: "Champion League I",
            spinStatus: "matched",
            observedCwlRosterCount: 31,
            currentClanMemberCount: 50,
            rosterTitle: "Refreshed Roster",
            rosterPostedMessageUrl: "https://discord.com/channels/1/2/99",
          },
        ],
      });

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);
    expect(vi.getTimerCount()).toBe(1);

    await interaction.__collectorHandlers.end?.();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(refreshHelperMock).not.toHaveBeenCalled();
  });

  it("moves long FWA blocks to the next page without splitting and keeps the paginator active", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Long FWA Clan ".repeat(220),
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        clanRoleId: null,
        clanBadge: null,
        shortName: "LONG",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        tag: "#2QG2C08U9",
        name: "Medium FWA Clan ".repeat(70),
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        clanRoleId: null,
        clanBadge: null,
        shortName: "MED",
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
        updatedAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const initialPayload = interaction.editReply.mock.calls[0]?.[0] as any;
    const initialDescription = getFirstEmbedDescription(interaction);
    expect(initialDescription).toContain("shortName: LONG");
    expect(initialDescription).not.toContain("shortName: MED");
    expect(initialDescription.length).toBeLessThanOrEqual(3900);
    expect(initialPayload?.components).toHaveLength(1);
    expect(initialPayload?.embeds?.[0]?.toJSON?.().footer?.text).toBe("Page 1/2");

    const collectHandler = interaction.__collectorHandlers.collect as ((button: any) => Promise<void>) | undefined;
    expect(collectHandler).toBeDefined();

    const nextButton = makeButtonInteraction("tracked-clan-list:tracked-clan-itx-1:next");
    await collectHandler?.(nextButton);

    expect(nextButton.update).toHaveBeenCalledTimes(1);
    const nextPayload = nextButton.update.mock.calls[0]?.[0] as any;
    const nextDescription = String(nextPayload?.embeds?.[0]?.toJSON?.().description ?? "");
    expect(nextDescription).toContain("shortName: MED");
    expect(nextDescription).not.toContain("shortName: LONG");
    expect(nextDescription.length).toBeLessThanOrEqual(3900);
    expect(nextPayload?.components?.[0]?.toJSON?.().components?.[0]?.disabled).toBe(false);
    expect(nextPayload?.components?.[0]?.toJSON?.().components?.[1]?.disabled).toBe(true);
    expect(nextPayload?.embeds?.[0]?.toJSON?.().footer?.text).toBe("Page 2/2");
  });

  it("renders a combined grouped embed when type is omitted", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: null,
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        name: "Vanilla",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: {},
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect(payload?.embeds).toHaveLength(1);
    expect(description).toContain("**FWA**");
    expect(description).toContain("**CWL**");
    expect(description).toContain("**RAIDS**");
    expect(description).toContain(
      "**FWA**\n- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 49 👥",
    );
    expect(description).not.toContain("leadRole:");
    expect(description).toContain(
      "**CWL**\n- [CWL Alpha](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=PYLQ0289>) `#PYLQ0289` | 12 👥",
    );
    expect(description).toContain("**RAIDS**");
    expect(description).toContain("Vanilla | 3331");
    expect(payload?.components).toHaveLength(1);
    expect(payload?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:summary:tracked-clan-itx-1:refresh",
    );
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.raidTrackedClan.findMany).toHaveBeenCalledTimes(1);
  });

  it("refreshes the overview member counts in place and disables the button while syncing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: null,
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        name: "Vanilla",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
      { clanTag: "2RVGJYLC0", _count: { clanTag: 3 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 50 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
      { clanTag: "2RVGJYLC0", _count: { clanTag: 3 } },
    ]);

    fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags.mockResolvedValueOnce({
      clanCount: 3,
      rowCount: 3,
      changedRowCount: 1,
      failedClans: [],
    });
    const cocService = {
      getClan: vi.fn(),
    };

    const interaction = createInteraction({
      subcommand: "list",
      strings: {},
    });

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    const collectHandler = interaction.__collectorHandlers.collect as
      | ((button: any) => Promise<void>)
      | undefined;
    expect(collectHandler).toBeDefined();

    const refreshButton = makeButtonInteraction("tracked-clan-list:summary:tracked-clan-itx-1:refresh");
    const collectPromise = collectHandler?.(refreshButton);

    expect(refreshButton.update).toHaveBeenCalledTimes(1);
    const updatingPayload = refreshButton.update.mock.calls[0]?.[0] as any;
    expect(updatingPayload?.components?.[0]?.toJSON?.().components?.[0]?.label).toBe("Refreshing...");
    expect(updatingPayload?.components?.[0]?.toJSON?.().components?.[0]?.disabled).toBe(true);
    expect(interaction.editReply.mock.calls).toHaveLength(1);
    await collectPromise;

    expect(fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags).toHaveBeenCalledWith(
      ["#2QG2C08UP", "#PYLQ0289", "2RVGJYLC0"],
      { cocService },
    );
    expect(cocQueueMock.runWithCoCQueueContext).toHaveBeenCalledWith(
      expect.objectContaining({
        priority: "interactive",
        source: "tracked-clan:list:member-counts-refresh:overview",
      }),
      expect.any(Function),
    );
    expect(interaction.editReply.mock.calls).toHaveLength(2);
    const refreshedDescription = String(
      interaction.editReply.mock.calls[1]?.[0]?.embeds?.[0]?.toJSON?.().description ?? "",
    );
    expect(refreshedDescription).toContain(
      "- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 50 👥",
    );
    expect(refreshButton.followUp).not.toHaveBeenCalled();
  });

  it("reports partial overview refresh failures without blocking refreshed member counts", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: null,
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        name: "Vanilla",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
      { clanTag: "2RVGJYLC0", _count: { clanTag: 3 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 50 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
      { clanTag: "2RVGJYLC0", _count: { clanTag: 3 } },
    ]);
    fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags.mockResolvedValueOnce({
      clanCount: 3,
      rowCount: 2,
      changedRowCount: 1,
      failedClans: ["#PYLQ0289"],
    });

    const interaction = createInteraction({
      subcommand: "list",
      strings: {},
    });

    await TrackedClan.run({} as any, interaction as any, { getClan: vi.fn() } as any);

    const collectHandler = interaction.__collectorHandlers.collect as
      | ((button: any) => Promise<void>)
      | undefined;
    const refreshButton = makeButtonInteraction("tracked-clan-list:summary:tracked-clan-itx-1:refresh");
    const collectPromise = collectHandler?.(refreshButton);
    await collectPromise;

    expect(refreshButton.followUp).toHaveBeenCalledTimes(1);
    expect(String(refreshButton.followUp.mock.calls[0]?.[0]?.content ?? "")).toContain("#PYLQ0289");
    const refreshedDescription = String(
      interaction.editReply.mock.calls[1]?.[0]?.embeds?.[0]?.toJSON?.().description ?? "",
    );
    expect(refreshedDescription).toContain("50 👥");
    expect(refreshedDescription).toContain("12 👥");
  });

  it("keeps the existing overview view and reports a clear failure when all refreshes fail", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: null,
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
    ]);
    fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags.mockResolvedValueOnce({
      clanCount: 1,
      rowCount: 0,
      changedRowCount: 0,
      failedClans: ["#2QG2C08UP"],
    });

    const interaction = createInteraction({
      subcommand: "list",
      strings: {},
    });

    await TrackedClan.run({} as any, interaction as any, { getClan: vi.fn() } as any);

    const collectHandler = interaction.__collectorHandlers.collect as
      | ((button: any) => Promise<void>)
      | undefined;
    const refreshButton = makeButtonInteraction("tracked-clan-list:summary:tracked-clan-itx-1:refresh");
    const collectPromise = collectHandler?.(refreshButton);
    await collectPromise;

    expect(refreshButton.followUp).toHaveBeenCalledTimes(1);
    expect(String(refreshButton.followUp.mock.calls[0]?.[0]?.content ?? "")).toContain(
      "Failed to refresh member counts for the displayed clans.",
    );
    const refreshedDescription = String(
      interaction.editReply.mock.calls[1]?.[0]?.embeds?.[0]?.toJSON?.().description ?? "",
    );
    expect(refreshedDescription).toContain("49 👥");
    expect(interaction.editReply.mock.calls[1]?.[0]?.components).toHaveLength(1);
  });

  it("renders a typed FWA minimal overview section without leadRole and with persisted member counts", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: "leader-channel-1",
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA", display: "minimal" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect(payload?.embeds?.[0]?.toJSON?.().title).toBe("Tracked Clans (FWA) (1)");
    expect(description).toContain("**FWA**");
    expect(description).toContain(
      "**FWA**\n- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 49 👥",
    );
    expect(description).not.toContain("leadRole:");
    expect(payload?.components).toHaveLength(1);
    expect(payload?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:fwa-summary:tracked-clan-itx-1:refresh",
    );
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("uses the shared FWA minimal list helper for the typed minimal view", async () => {
    const loadSpy = vi
      .spyOn(trackedClanListService, "loadFwaTrackedClanMinimalListState")
      .mockResolvedValueOnce({
        trackedClans: [
          {
            tag: "#2QG2C08UP",
            name: "Alpha Clan",
            loseStyle: "TRADITIONAL",
            mailChannelId: null,
            logChannelId: null,
            leaderChannelId: "leader-channel-1",
            clanRoleId: null,
            leadRoleId: "lead-role-1",
            clanBadge: null,
            shortName: "AC",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          },
        ],
        refreshTags: ["#2QG2C08UP"],
        memberCountByTag: new Map([["#2QG2C08UP", 49]]),
      });
    const renderSpy = vi.spyOn(
      trackedClanListService,
      "buildFwaTrackedClanMinimalListRender",
    );

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA", display: "minimal" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshPrefix: "tracked-clan-list:fwa-summary:tracked-clan-itx-1",
        refreshing: false,
        trackedClans: expect.arrayContaining([
          expect.objectContaining({
            tag: "#2QG2C08UP",
            name: "Alpha Clan",
          }),
        ]),
      }),
    );
    expect(getFirstEmbedDescription(interaction)).toContain("Alpha Clan");
    expect(getFirstEmbedDescription(interaction)).toContain("49");
  });

  it("refreshes the typed FWA minimal overview section in place", async () => {
    const loadSpy = vi
      .spyOn(trackedClanListService, "loadFwaTrackedClanMinimalListState")
      .mockResolvedValueOnce({
        trackedClans: [
          {
            tag: "#2QG2C08UP",
            name: "Alpha Clan",
            loseStyle: "TRADITIONAL",
            mailChannelId: null,
            logChannelId: null,
            leaderChannelId: "leader-channel-1",
            clanRoleId: null,
            leadRoleId: "lead-role-1",
            clanBadge: null,
            shortName: "AC",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          },
        ],
        refreshTags: ["#2QG2C08UP"],
        memberCountByTag: new Map([["#2QG2C08UP", 49]]),
      });
    vi.spyOn(trackedClanListService, "buildFwaTrackedClanMinimalListRender");
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 50 } },
    ]);
    fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags.mockResolvedValueOnce({
      clanCount: 1,
      rowCount: 1,
      changedRowCount: 1,
      failedClans: [],
    });

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA", display: "minimal" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const collectHandler = interaction.__collectorHandlers.collect as
      | ((button: any) => Promise<void>)
      | undefined;
    expect(loadSpy).toHaveBeenCalledTimes(1);
    const refreshButton = makeButtonInteraction("tracked-clan-list:fwa-summary:tracked-clan-itx-1:refresh");
    await collectHandler?.(refreshButton);

    expect(fwaClanMembersSyncMock.refreshCurrentClanMembersForClanTags).toHaveBeenCalledWith(
      ["#2QG2C08UP"],
      { cocService: expect.any(Object) },
    );
    expect(refreshButton.update).toHaveBeenCalledTimes(1);
    expect(String(interaction.editReply.mock.calls[1]?.[0]?.embeds?.[0]?.toJSON?.().description ?? "")).toContain(
      "50",
    );
  });

  it("renders a typed CWL minimal overview section and ignores display when type is omitted", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: "Alpha Clan",
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        leaderChannelId: null,
        clanRoleId: null,
        leadRoleId: "lead-role-1",
        clanBadge: null,
        shortName: "AC",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        name: "Vanilla",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      {
        season: "2026-03",
        tag: "#PYLQ0289",
        name: "CWL Alpha",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", _count: { clanTag: 49 } },
      { clanTag: "#PYLQ0289", _count: { clanTag: 12 } },
      { clanTag: "2RVGJYLC0", _count: { clanTag: 3 } },
    ]);

    const typedInteraction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL", display: "minimal" },
    });
    await TrackedClan.run({} as any, typedInteraction as any, {} as any);
    const typedDescription = getFirstEmbedDescription(typedInteraction);
    expect(typedDescription).toContain("**CWL**");
    expect(typedDescription).toContain("| 12 👥");
    expect(typedDescription).not.toContain("leadRole:");
    expect(typedInteraction.editReply.mock.calls[0]?.[0]?.components).toHaveLength(1);
    expect(typedInteraction.editReply.mock.calls[0]?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:cwl-summary:tracked-clan-itx-1:refresh",
    );

    const overviewInteraction = createInteraction({
      subcommand: "list",
      strings: { display: "minimal" },
    });
    await TrackedClan.run({} as any, overviewInteraction as any, {} as any);
    const overviewDescription = getFirstEmbedDescription(overviewInteraction);
    expect(overviewDescription).toContain("**FWA**");
    expect(overviewDescription).toContain("**CWL**");
    expect(overviewDescription).toContain("**RAIDS**");
    expect(overviewInteraction.editReply.mock.calls[0]?.[0]?.components).toHaveLength(1);
    expect(overviewInteraction.editReply.mock.calls[0]?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:summary:tracked-clan-itx-1:refresh",
    );
  });

  it("renders the default typed RAIDS minimal overview section with join emoji, upgrades, and persisted member counts", async () => {
    prismaMock.raidTrackedClan.findMany.mockResolvedValueOnce([
      {
        clanTag: "2RVGJYLC0",
        name: "Vanilla",
        upgrades: 3331,
        joinType: "open",
        createdAt: new Date("2026-04-15T00:00:00.000Z"),
        updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValueOnce([
      { clanTag: "#2RVGJYLC0", _count: { clanTag: 3 } },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "RAIDS" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect(payload?.embeds?.[0]?.toJSON?.().title).toBe("Tracked Clans (RAIDS) (1)");
    expect(description).toContain("**RAIDS**");
    expect(description).toContain("**RAIDS**\n- 🔓 [Vanilla | 3331](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2RVGJYLC0>) `2RVGJYLC0` | 3 👥");
    expect(description).toContain("| 3 👥");
    expect(payload?.components).toHaveLength(1);
    expect(payload?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:raids-summary:tracked-clan-itx-1:refresh",
    );
  });

  it("persists leaderChannelId when /clan configure receives leader-channel", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce(null);
    prismaMock.trackedClan.upsert.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      loseStyle: "TRIPLE_TOP_30",
      mailChannelId: null,
      logChannelId: null,
      leaderChannelId: "leader-channel-1",
      clanRoleId: null,
      leadRoleId: null,
      clanBadge: null,
      shortName: null,
    });
    prismaMock.currentWar.upsert.mockResolvedValue({});
    const interaction = createInteraction({
      subcommand: "configure",
      strings: { tag: "#2QG2C08UP" },
      channels: {
        "leader-channel": {
          id: "leader-channel-1",
          isTextBased: () => true,
        },
      },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Alpha Clan" }),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.trackedClan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          leaderChannelId: "leader-channel-1",
          leadRoleId: null,
        }),
        update: expect.objectContaining({
          leaderChannelId: "leader-channel-1",
        }),
      }),
    );
    expect(getReplyContent(interaction)).toContain("leaderChannel: <#leader-channel-1>");
    expect(getReplyContent(interaction)).toContain("leadRole: not set");
  });

  it("persists rep player tags when /clan configure receives reps", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce(null);
    prismaMock.trackedClan.upsert.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      loseStyle: "TRIPLE_TOP_30",
      mailChannelId: null,
      logChannelId: null,
      leaderChannelId: null,
      clanRoleId: null,
      leadRoleId: null,
      clanBadge: null,
      shortName: null,
    });
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([]);
    prismaMock.currentWar.upsert.mockResolvedValue({});
    const interaction = createInteraction({
      subcommand: "configure",
      strings: { tag: "#2QG2C08UP", reps: "[#2RVGJYLC0,#PYLQ0289]" },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Alpha Clan" }),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.trackedClanRep.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "#2QG2C08UP" },
    });
    expect(prismaMock.trackedClanRep.createMany).toHaveBeenCalledWith({
      data: [
        { clanTag: "#2QG2C08UP", playerTag: "#2RVGJYLC0" },
        { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
      ],
    });
    expect(getReplyContent(interaction)).toContain("reps: #2RVGJYLC0, #PYLQ0289");
  });

  it("preserves existing rep player tags when /clan configure omits reps", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
    });
    prismaMock.trackedClan.upsert.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      loseStyle: "TRIPLE_TOP_30",
      mailChannelId: null,
      logChannelId: null,
      leaderChannelId: null,
      clanRoleId: null,
      leadRoleId: null,
      clanBadge: null,
      shortName: null,
    });
    prismaMock.trackedClanRep.findMany.mockResolvedValueOnce([
      { clanTag: "#2QG2C08UP", playerTag: "#2RVGJYLC0" },
      { clanTag: "#2QG2C08UP", playerTag: "#PYLQ0289" },
    ]);
    prismaMock.currentWar.upsert.mockResolvedValue({});
    const interaction = createInteraction({
      subcommand: "configure",
      strings: { tag: "#2QG2C08UP" },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Alpha Clan" }),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.trackedClanRep.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
    expect(getReplyContent(interaction)).toContain("reps: #2RVGJYLC0, #PYLQ0289");
  });

  it("clears rep player tags when /clan configure receives reps:[]", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
    });
    prismaMock.trackedClan.upsert.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      loseStyle: "TRIPLE_TOP_30",
      mailChannelId: null,
      logChannelId: null,
      leaderChannelId: null,
      clanRoleId: null,
      leadRoleId: null,
      clanBadge: null,
      shortName: null,
    });
    prismaMock.currentWar.upsert.mockResolvedValue({});
    const interaction = createInteraction({
      subcommand: "configure",
      strings: { tag: "#2QG2C08UP", reps: "[]" },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Alpha Clan" }),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.trackedClanRep.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "#2QG2C08UP" },
    });
    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
    expect(getReplyContent(interaction)).toContain("reps: not set");
  });

  it("rejects invalid rep tags before changing clan config", async () => {
    const interaction = createInteraction({
      subcommand: "configure",
      strings: { tag: "#2QG2C08UP", reps: "BADTAG" },
    });

    await TrackedClan.run({} as any, interaction as any, { getClan: vi.fn() } as any);

    expect(getReplyContent(interaction)).toContain("Invalid rep player tags");
    expect(prismaMock.trackedClan.upsert).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.trackedClanRep.createMany).not.toHaveBeenCalled();
  });

  it("persists leadRoleId when /clan configure receives lead-role", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce(null);
    prismaMock.trackedClan.upsert.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      loseStyle: "TRIPLE_TOP_30",
      mailChannelId: null,
      logChannelId: null,
      leaderChannelId: null,
      clanRoleId: null,
      leadRoleId: "lead-role-1",
      clanBadge: null,
      shortName: null,
    });
    prismaMock.currentWar.upsert.mockResolvedValue({});
    const interaction = createInteraction({
      subcommand: "configure",
      strings: { tag: "#2QG2C08UP" },
      roles: {
        "lead-role": {
          id: "lead-role-1",
        },
      },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Alpha Clan" }),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    expect(prismaMock.trackedClan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          leadRoleId: "lead-role-1",
        }),
        update: expect.objectContaining({
          leadRoleId: "lead-role-1",
        }),
      }),
    );
    expect(getReplyContent(interaction)).toContain("leadRole: <@&lead-role-1>");
  });

  it("keeps an existing leaderChannelId when /clan configure omits leader-channel", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      leaderChannelId: "leader-channel-1",
    });
    prismaMock.trackedClan.upsert.mockResolvedValueOnce({
      tag: "#2QG2C08UP",
      name: "Alpha Clan",
      loseStyle: "TRIPLE_TOP_30",
      mailChannelId: null,
      logChannelId: null,
      leaderChannelId: "leader-channel-1",
      clanRoleId: null,
      leadRoleId: "lead-role-1",
      clanBadge: null,
      shortName: null,
    });
    prismaMock.currentWar.upsert.mockResolvedValue({});
    const interaction = createInteraction({
      subcommand: "configure",
      strings: { tag: "#2QG2C08UP" },
    });
    const cocService = {
      getClan: vi.fn().mockResolvedValue({ name: "Alpha Clan" }),
      getCurrentWar: vi.fn().mockResolvedValue(null),
    };

    await TrackedClan.run({} as any, interaction as any, cocService as any);

    const update = (prismaMock.trackedClan.upsert.mock.calls[0]?.[0] as any)?.update ?? {};
    expect(Object.prototype.hasOwnProperty.call(update, "leaderChannelId")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update, "leadRoleId")).toBe(false);
    expect(getReplyContent(interaction)).toContain("leaderChannel: <#leader-channel-1>");
    expect(getReplyContent(interaction)).toContain("leadRole: <@&lead-role-1>");
  });

  it("falls back to the clan tag when a tracked FWA name is missing", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValueOnce([
      {
        tag: "#2QG2C08UP",
        name: null,
        loseStyle: "TRADITIONAL",
        mailChannelId: null,
        logChannelId: null,
        clanRoleId: null,
        clanBadge: null,
        shortName: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "FWA", display: "detailed" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const description = getFirstEmbedDescription(interaction);
    expect(description).toContain(
      "**[#2QG2C08UP](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>)**",
    );
    expect(description).not.toContain("undefined");
    expect(description).not.toContain("null");
  });

  it("removes a RAIDS clan when explicit type:RAIDS is provided", async () => {
    prismaMock.raidTrackedClan.deleteMany.mockResolvedValue({ count: 1 });
    const interaction = createInteraction({
      subcommand: "remove",
      strings: { tag: "#2RVGJYLC0", type: "RAIDS" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.raidTrackedClan.deleteMany).toHaveBeenCalledWith({
      where: { clanTag: "2RVGJYLC0" },
    });
    expect(getReplyContent(interaction)).toContain(
      "Removed tracked clan #2RVGJYLC0 from RAIDS registry.",
    );
  });

  it("blocks ambiguous remove when tag exists in both FWA and CWL registries", async () => {
    prismaMock.trackedClan.findUnique.mockResolvedValue({ tag: "#PYLQ0289" });
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ id: 99 });
    const interaction = createInteraction({
      subcommand: "remove",
      strings: { tag: "PYLQ0289" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(getReplyContent(interaction)).toContain("Ambiguous remove for #PYLQ0289");
    expect(prismaMock.trackedClan.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.cwlTrackedClan.deleteMany).not.toHaveBeenCalled();
  });

  it("removes from CWL registry when explicit type:CWL is provided", async () => {
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ id: 99 } as any);
    prismaMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 2 });
    prismaMock.cwlRotationPlan.updateMany.mockResolvedValue({ count: 1 });
    const interaction = createInteraction({
      subcommand: "remove",
      strings: { tag: "#PYLQ0289", type: "CWL" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.cwlTrackedClan.findFirst).toHaveBeenCalledWith({
      where: { season: "2026-03", tag: "#PYLQ0289" },
      select: { id: true },
    });
    expect(prismaMock.cwlTrackedClan.deleteMany).toHaveBeenCalledWith({
      where: { season: "2026-03", tag: "#PYLQ0289" },
    });
    expect(prismaMock.cwlPlayerClanSeason.deleteMany).toHaveBeenCalledWith({
      where: { season: "2026-03", cwlClanTag: "#PYLQ0289" },
    });
    expect(prismaMock.cwlRotationPlan.updateMany).toHaveBeenCalledWith({
      where: {
        season: "2026-03",
        clanTag: "#PYLQ0289",
        isActive: true,
      },
      data: {
        isActive: false,
      },
    });
    expect(prismaMock.currentWar.deleteMany).not.toHaveBeenCalled();
    expect(getReplyContent(interaction)).toContain(
      "Removed tracked clan #PYLQ0289 from CWL registry for season 2026-03.",
    );
  });

  it("removes from FWA registry and clears current-war rows when type:FWA is provided", async () => {
    prismaMock.trackedClan.deleteMany.mockResolvedValue({ count: 1 });
    const interaction = createInteraction({
      subcommand: "remove",
      strings: { tag: "PYLQ0289", type: "FWA" },
      guildId: "guild-99",
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.trackedClan.deleteMany).toHaveBeenCalledWith({
      where: { tag: "#PYLQ0289" },
    });
    expect(prismaMock.currentWar.deleteMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-99",
        clanTag: "#PYLQ0289",
      },
    });
    expect(getReplyContent(interaction)).toContain(
      "Removed tracked clan #PYLQ0289 from FWA registry.",
    );
  });
});
