import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityService } from "../src/services/ActivityService";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  cwlTrackedClan: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
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
    deleteMany: vi.fn(),
  },
  currentWar: {
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
  fwaClanMemberCurrent: {
    groupBy: vi.fn(),
  },
  $transaction: vi.fn(async (arg: any) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    if (typeof arg === "function") return arg({});
    return arg;
  }),
}));

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

    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findUnique.mockResolvedValue(null);
    prismaMock.trackedClan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue(null);
    prismaMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.cwlTrackedClan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.createMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.raidTrackedClan.findFirst.mockResolvedValue(null);
    prismaMock.fwaClanMemberCurrent.groupBy.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.currentWar.deleteMany.mockResolvedValue({ count: 0 });
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
    expect(description).toContain("Vanilla | 3331");
    const buttonIds = payload?.components?.[0]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(buttonIds).toContain("tracked-clan-list:raids:tracked-clan-itx-1:refresh");
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("renders linked FWA clan titles when type:FWA is provided", async () => {
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
    expect(description).toContain(
      "**[Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>)** `#2QG2C08UP`",
    );
    expect(description).toContain("shortName: AC");
    expect(description).toContain("leaderChannel: <#leader-channel-1>");
    expect(description).toContain("leadRole: <@&lead-role-1>");
    expect(interaction.editReply.mock.calls[0]?.[0]?.components).toEqual([]);
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("renders linked clan titles when type:CWL is provided", async () => {
    prismaMock.cwlTrackedClan.findMany
      .mockResolvedValueOnce([
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: "CWL Alpha",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          season: "2026-03",
          tag: "#PYLQ0289",
          name: "CWL Alpha",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const description = getFirstEmbedDescription(interaction);
    expect(description).toContain(
      "**[CWL Alpha](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=PYLQ0289>)** `#PYLQ0289`",
    );
    expect(description).toContain("registry: CWL seasonal");
    expect(interaction.editReply.mock.calls[0]?.[0]?.components).toEqual([]);
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
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
      strings: { type: "FWA" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect((description.match(/shortName:/g) ?? []).length).toBe(5);
    expect(description.length).toBeLessThanOrEqual(3900);
    expect(payload?.components).toEqual([]);
  });

  it("packs many short CWL clan blocks onto one page when they fit", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, index) => ({
        season: "2026-03",
        tag: `#PYLQ028${index}`,
        name: `CWL Clan ${index + 1}`,
        createdAt: new Date(`2026-03-0${index + 1}T00:00:00.000Z`),
      })),
    );

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect((description.match(/registry: CWL seasonal/g) ?? []).length).toBe(6);
    expect(description.length).toBeLessThanOrEqual(3900);
    expect(payload?.components).toEqual([]);
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
      strings: { type: "FWA" },
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
      "- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 49 members",
    );
    expect(description).not.toContain("leadRole:");
    expect(description).toContain(
      "- [CWL Alpha](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=PYLQ0289>) `#PYLQ0289` | 12 members",
    );
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
      "- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 50 members",
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
    expect(refreshedDescription).toContain("50 members");
    expect(refreshedDescription).toContain("12 members");
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
    expect(refreshedDescription).toContain("49 members");
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
      "- [Alpha Clan](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>) `#2QG2C08UP` | 49 members",
    );
    expect(description).not.toContain("leadRole:");
    expect(payload?.components).toHaveLength(1);
    expect(payload?.components?.[0]?.toJSON?.().components?.[0]?.custom_id).toBe(
      "tracked-clan-list:fwa-summary:tracked-clan-itx-1:refresh",
    );
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.raidTrackedClan.findMany).not.toHaveBeenCalled();
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
    expect(typedDescription).toContain("| 12 members");
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

  it("renders a typed RAIDS minimal overview section with join emoji, upgrades, and persisted member counts", async () => {
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
      strings: { type: "RAIDS", display: "minimal" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = getFirstEmbedDescription(interaction);
    expect(payload?.embeds?.[0]?.toJSON?.().title).toBe("Tracked Clans (RAIDS) (1)");
    expect(description).toContain("**RAIDS**");
    expect(description).toContain("Vanilla | 3331");
    expect(description).toContain("| 3 members");
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
      strings: { type: "FWA" },
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
    prismaMock.cwlTrackedClan.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 2 });
    const interaction = createInteraction({
      subcommand: "remove",
      strings: { tag: "#PYLQ0289", type: "CWL" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.cwlTrackedClan.deleteMany).toHaveBeenCalledWith({
      where: { season: "2026-03", tag: "#PYLQ0289" },
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
