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

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { TrackedClan } from "../src/commands/TrackedClan";

type InteractionInput = {
  subcommand: string;
  strings?: Record<string, string | null | undefined>;
  guildId?: string | null;
};

/** Purpose: build a focused tracked-clan chat interaction mock for subcommand tests. */
function createInteraction(input: InteractionInput) {
  const strings = input.strings ?? {};
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
