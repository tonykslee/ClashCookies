import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn().mockResolvedValue([]),
  $executeRaw: vi.fn().mockResolvedValue(0),
  trackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  currentWar: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  currentCwlRound: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Remaining } from "../src/commands/Remaining";
import { SettingsService } from "../src/services/SettingsService";

/** Purpose: create a minimal chat-command interaction mock for /remaining war tests. */
function makeInteraction(params: {
  subcommand?: "war" | "cwl";
  tag: string | null;
  all?: boolean | null;
  guildId?: string | null;
  userId?: string | null;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guildId: params.guildId ?? "guild-1",
    user: { id: params.userId ?? "user-1" },
    deferReply,
    editReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue(params.subcommand ?? "war"),
      getString: vi.fn((name: string) => {
        if (name === "tag") return params.tag;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "all") return params.all ?? null;
        return null;
      }),
    },
  };
  return { interaction, deferReply, editReply };
}

describe("/remaining war command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps single-tag behavior using persisted CurrentWar state only", async () => {
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
    });
    prismaMock.currentWar.findUnique.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      state: "preparation",
      startTime: new Date("2026-03-08T10:00:00.000Z"),
      endTime: new Date("2026-03-09T10:00:00.000Z"),
    });

    const cocService = { getCurrentWar: vi.fn() };
    const { interaction, editReply } = makeInteraction({ tag: "2QG2C08UP" });

    await Remaining.run({} as any, interaction as any, cocService as any);

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.findUnique).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("Current phase: **Preparation Day**")
    );
  });

  it("returns aggregate dominant-cluster summary when tag is omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T00:00:00.000Z"));

    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#A", name: "Alpha" },
      { tag: "#B", name: "Bravo" },
      { tag: "#C", name: "Charlie" },
      { tag: "#D", name: "Delta" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#A",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T01:00:00.000Z"),
      },
      {
        clanTag: "#B",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T01:05:00.000Z"),
      },
      {
        clanTag: "#C",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T01:10:00.000Z"),
      },
      {
        clanTag: "#D",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T02:30:00.000Z"),
      },
    ]);

    const cocService = { getCurrentWar: vi.fn() };
    const { interaction, editReply } = makeInteraction({ tag: null });

    await Remaining.run({} as any, interaction as any, cocService as any);

    const output = String(editReply.mock.calls[0]?.[0] ?? "");
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(output).toContain("Dominant cluster mean remaining");
    expect(output).toContain("Cluster spread");
    expect(output).toContain("Outliers (1)");
    expect(output).toContain("Delta (#D)");
  });

  it("returns no-active-war message in aggregate mode when no rows are active", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ tag: "#A", name: "Alpha" }]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);

    const cocService = { getCurrentWar: vi.fn() };
    const { interaction, editReply } = makeInteraction({ tag: null });

    await Remaining.run({} as any, interaction as any, cocService as any);

    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith("No tracked clans are currently in active war.");
  });
});


describe("/remaining war command default selection behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("uses the stored last-viewed clan when tag is omitted and all is not requested", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue("#2QG2C08UP");
    const setSpy = vi.spyOn(SettingsService.prototype, "set").mockResolvedValue(undefined);

    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha",
    });
    prismaMock.currentWar.findUnique.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      state: "preparation",
      startTime: new Date("2026-03-08T10:00:00.000Z"),
      endTime: new Date("2026-03-09T10:00:00.000Z"),
    });

    const { interaction, editReply } = makeInteraction({ tag: null, all: null });

    await Remaining.run({} as any, interaction as any, {} as any);

    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.findMany).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining("**Alpha (#2QG2C08UP)**"));
    expect(setSpy).toHaveBeenCalledWith(
      "remaining:war:last-clan:guild-1:user-1",
      "#2QG2C08UP"
    );
  });

  it("returns aggregate view only when all:true is provided", async () => {
    const getSpy = vi.spyOn(SettingsService.prototype, "get").mockResolvedValue("#2QG2C08UP");

    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#A", name: "Alpha" },
    ]);
    prismaMock.currentWar.findMany.mockResolvedValue([
      {
        clanTag: "#A",
        state: "inWar",
        startTime: new Date("2026-03-07T00:00:00.000Z"),
        endTime: new Date("2026-03-08T01:00:00.000Z"),
      },
    ]);

    const { interaction, editReply } = makeInteraction({ tag: null, all: true });

    await Remaining.run({} as any, interaction as any, {} as any);

    const output = String(editReply.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("Alliance Remaining War Summary");
    expect(getSpy).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.currentWar.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to aggregate mode when no tag is provided and no last-viewed clan exists", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue(null);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);

    const { interaction, editReply } = makeInteraction({ tag: null, all: null });

    await Remaining.run({} as any, interaction as any, {} as any);

    expect(editReply).toHaveBeenCalledWith(
      "No tracked clans are currently in active war."
    );
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.currentWar.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("/remaining cwl command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("uses the remembered CWL clan and responds publicly", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue("#2QG2C08UP");
    const setSpy = vi.spyOn(SettingsService.prototype, "set").mockResolvedValue(undefined);

    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha CWL",
    });
    prismaMock.currentCwlRound.findUnique.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha CWL",
      roundDay: 2,
      roundState: "preparation",
      startTime: new Date("2026-03-08T10:00:00.000Z"),
      endTime: new Date("2026-03-09T10:00:00.000Z"),
    });

    const cocService = { getCurrentWar: vi.fn() };
    const { interaction, deferReply, editReply } = makeInteraction({
      subcommand: "cwl",
      tag: null,
      all: null,
    });

    await Remaining.run({} as any, interaction as any, cocService as any);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: false });
    expect(cocService.getCurrentWar).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("Current state: **preparation**"),
    );
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("Battle day starts: <t:"),
    );
    expect(setSpy).toHaveBeenCalledWith(
      "remaining:cwl:last-clan:guild-1:user-1",
      "#2QG2C08UP",
    );
  });

  it("updates remembered CWL tag when an explicit tag is provided", async () => {
    const setSpy = vi.spyOn(SettingsService.prototype, "set").mockResolvedValue(undefined);
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue(null);

    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({
      tag: "#2QG2C08UP",
      name: "Alpha CWL",
    });
    prismaMock.currentCwlRound.findUnique.mockResolvedValue(null);

    const { interaction, editReply } = makeInteraction({
      subcommand: "cwl",
      tag: "2QG2C08UP",
      all: null,
    });

    await Remaining.run({} as any, interaction as any, {} as any);

    expect(setSpy).toHaveBeenCalledWith(
      "remaining:cwl:last-clan:guild-1:user-1",
      "#2QG2C08UP",
    );
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("Current state: **unknown**"),
    );
  });

  it("returns a clear prompt when no remembered CWL clan exists", async () => {
    vi.spyOn(SettingsService.prototype, "get").mockResolvedValue(null);

    const { interaction, editReply } = makeInteraction({
      subcommand: "cwl",
      tag: null,
      all: null,
    });

    await Remaining.run({} as any, interaction as any, {} as any);

    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("/remaining cwl tag:<tag>"),
    );
    expect(editReply).toHaveBeenCalledWith(
      expect.stringContaining("/remaining cwl all:true"),
    );
  });

  it("lists all tracked CWL clans publicly with persisted timing state", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Alpha" },
      { tag: "#9GLGQCCU", name: "Bravo" },
    ]);
    prismaMock.currentCwlRound.findMany.mockResolvedValue([
      {
        clanTag: "#2QG2C08UP",
        clanName: "Alpha",
        roundDay: 1,
        roundState: "inWar",
        startTime: new Date("2026-03-08T10:00:00.000Z"),
        endTime: new Date("2026-03-08T11:00:00.000Z"),
      },
    ]);

    const { interaction, deferReply, editReply } = makeInteraction({
      subcommand: "cwl",
      tag: null,
      all: true,
    });

    await Remaining.run({} as any, interaction as any, {} as any);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: false });
    const output = String(editReply.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("**CWL Remaining**");
    expect(output).toContain("Alpha (#2QG2C08UP)");
    expect(output).toContain("Current state: **inWar**");
    expect(output).toContain("Bravo (#9GLGQCCU)");
    expect(output).toContain("Current state: **unknown**");
  });

  it("uses CWL autocomplete from tracked CWL clans instead of regular tracked clans", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "Alpha CWL" },
      { tag: "#9GLGQCCU", name: "Bravo CWL" },
    ]);

    const interaction = {
      options: {
        getFocused: vi.fn().mockReturnValue({ name: "tag", value: "alpha" }),
        getSubcommand: vi.fn().mockReturnValue("cwl"),
      },
      respond: vi.fn().mockResolvedValue(undefined),
    } as any;

    await Remaining.autocomplete(interaction);

    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha CWL (#2QG2C08UP)", value: "2QG2C08UP" },
    ]);
  });
});
