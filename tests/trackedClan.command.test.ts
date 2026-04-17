import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  $transaction: vi.fn(async (arg: any) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    if (typeof arg === "function") return arg({});
    return arg;
  }),
}));

const cocQueueMock = vi.hoisted(() => ({
  runWithCoCQueueContext: vi.fn(async (_context: unknown, run: () => Promise<unknown>) => run()),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/CoCQueueContext", () => ({
  runWithCoCQueueContext: cocQueueMock.runWithCoCQueueContext,
}));

import {
  TrackedClan,
  refreshRaidTrackedClanListWithQueueContext,
} from "../src/commands/TrackedClan";

type InteractionInput = {
  subcommand: string;
  strings?: Record<string, string | null | undefined>;
  integers?: Record<string, number | null | undefined>;
  guildId?: string | null;
};

/** Purpose: build a focused tracked-clan chat interaction mock for subcommand tests. */
function createInteraction(input: InteractionInput) {
  const strings = input.strings ?? {};
  const integers = input.integers ?? {};
  return {
    id: "tracked-clan-itx-1",
    commandName: "tracked-clan",
    deferred: true,
    replied: false,
    guildId: input.guildId ?? "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    options: {
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => strings[name] ?? null),
      getInteger: vi.fn((name: string) => integers[name] ?? null),
      getChannel: vi.fn().mockReturnValue(null),
      getRole: vi.fn().mockReturnValue(null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

/** Purpose: extract command reply content from one tracked-clan interaction mock. */
function getReplyContent(interaction: any): string {
  const payload = interaction.editReply.mock.calls[0]?.[0] as any;
  return String(payload?.content ?? "");
}

describe("/tracked-clan command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T00:00:00.000Z"));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

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
    prismaMock.cwlPlayerClanSeason.findMany.mockResolvedValue([]);
    prismaMock.cwlPlayerClanSeason.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.currentWar.deleteMany.mockResolvedValue({ count: 0 });
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

    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "RAIDS" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
    expect(description).toContain("### 🔓 [Vanilla | 3331]");
    expect(description).toContain("2RVGJYLC0");
    const buttonIds = payload?.components?.[0]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(buttonIds).toContain("tracked-clan-list:raids:tracked-clan-itx-1:refresh");
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
  });

  it("keeps default /tracked-clan list behavior on FWA registry when type is omitted", async () => {
    const interaction = createInteraction({
      subcommand: "list",
      strings: {},
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.cwlTrackedClan.findMany).not.toHaveBeenCalled();
    expect(getReplyContent(interaction)).toContain("No tracked clans in the database.");
  });

  it("returns clear empty state for /tracked-clan list type:CWL", async () => {
    const interaction = createInteraction({
      subcommand: "list",
      strings: { type: "CWL" },
    });

    await TrackedClan.run({} as any, interaction as any, {} as any);

    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledWith({
      where: { season: "2026-03" },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: {
        season: true,
        tag: true,
        name: true,
        createdAt: true,
      },
    });
    expect(getReplyContent(interaction)).toContain("No CWL tracked clans for season 2026-03.");
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
