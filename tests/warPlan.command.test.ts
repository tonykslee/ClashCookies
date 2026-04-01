import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";

const prismaMock = vi.hoisted(() => ({
  clanWarPlan: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  currentWar: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  WarPlan,
  buildWarPlanOverviewClanFieldValueForTest,
  paginateWarPlanOverviewFieldsForTest,
  resolveWarPlanOverviewOverrideTypeForTest,
} from "../src/commands/WarPlan";

function createInteraction(input?: {
  guildId?: string | null;
  subcommand?: string;
  strings?: Record<string, string | null | undefined>;
}) {
  const strings = input?.strings ?? {};
  return {
    id: "itx-warplan-1",
    guildId: input?.guildId ?? "guild-1",
    user: { id: "user-1" },
    options: {
      getSubcommand: vi.fn().mockReturnValue(input?.subcommand ?? "show"),
      getString: vi.fn((name: string) => strings[name] ?? null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn(),
  } as any;
}

describe("/warplan show overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.clanWarPlan.findMany.mockResolvedValue([]);
    prismaMock.currentWar.findMany.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
  });

  it("registers clan-tag as optional for /warplan show", () => {
    const show = WarPlan.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "show",
    );
    expect(show).toBeTruthy();
    const clanTagOption = show?.options?.find((option) => option.name === "clan-tag");
    expect(clanTagOption?.required).toBe(false);
    expect(clanTagOption?.autocomplete).toBe(true);
  });

  it("renders guild-scoped tracked-clan overview with exact custom override labels", async () => {
    prismaMock.currentWar.findMany.mockResolvedValue([
      { clanTag: "#AAA111" },
      { clanTag: "BBB222" },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { tag: "#AAA111", name: "Alpha" },
      { tag: "#BBB222", name: "Beta" },
    ]);
    prismaMock.clanWarPlan.findMany.mockResolvedValue([
      {
        clanTag: "#AAA111",
        matchType: "FWA",
        outcome: "WIN",
        loseStyle: "ANY",
      },
      {
        clanTag: "#AAA111",
        matchType: "BL",
        outcome: "ANY",
        loseStyle: "ANY",
      },
      {
        clanTag: "#AAA111",
        matchType: "FWA",
        outcome: "ANY",
        loseStyle: "ANY",
      },
    ]);
    const interaction = createInteraction({
      strings: { "clan-tag": null, "match-type": null },
    });

    await WarPlan.run({} as any, interaction, {} as any);

    expect(prismaMock.currentWar.findMany).toHaveBeenCalledWith({
      where: { guildId: "guild-1" },
      select: { clanTag: true },
    });
    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledWith({
      where: { tag: { in: ["AAA111", "BBB222"] } },
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true },
    });
    expect(prismaMock.clanWarPlan.findMany).toHaveBeenCalledWith({
      where: {
        guildId: "guild-1",
        scope: "CUSTOM",
        clanTag: { in: ["AAA111", "BBB222"] },
      },
      select: {
        clanTag: true,
        matchType: true,
        outcome: true,
        loseStyle: true,
      },
    });

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload?.embeds?.[0]?.toJSON?.();
    expect(embed?.fields?.[0]?.name).toBe("Alpha (#AAA111)");
    expect(embed?.fields?.[0]?.value).toContain("- `FWA-WIN`");
    expect(embed?.fields?.[0]?.value).toContain("- `BL`");
    expect(embed?.fields?.[1]?.name).toBe("Beta (#BBB222)");
    expect(embed?.fields?.[1]?.value).toBe("Uses defaults for all match types");
    expect(interaction.fetchReply).not.toHaveBeenCalled();
  });

  it("keeps clan-specific /warplan show behavior when clan-tag is supplied", async () => {
    prismaMock.clanWarPlan.findMany
      .mockResolvedValueOnce([
        {
          matchType: "BL",
          outcome: "ANY",
          loseStyle: "ANY",
          planText: "BL plan",
          nonMirrorTripleMinClanStars: 101,
          allBasesOpenHoursLeft: 0,
        },
        {
          matchType: "MM",
          outcome: "ANY",
          loseStyle: "ANY",
          planText: "MM plan",
          nonMirrorTripleMinClanStars: 101,
          allBasesOpenHoursLeft: 0,
        },
        {
          matchType: "FWA",
          outcome: "WIN",
          loseStyle: "ANY",
          planText: "FWA win plan",
          nonMirrorTripleMinClanStars: 101,
          allBasesOpenHoursLeft: 0,
        },
        {
          matchType: "FWA",
          outcome: "LOSE",
          loseStyle: "TRIPLE_TOP_30",
          planText: "FWA lose t30 plan",
          nonMirrorTripleMinClanStars: 0,
          allBasesOpenHoursLeft: 0,
        },
        {
          matchType: "FWA",
          outcome: "LOSE",
          loseStyle: "TRADITIONAL",
          planText: "FWA lose trad plan",
          nonMirrorTripleMinClanStars: 0,
          allBasesOpenHoursLeft: 12,
        },
      ])
      .mockResolvedValueOnce([]);
    const interaction = createInteraction({
      strings: { "clan-tag": "AAA111", "match-type": null },
    });

    await WarPlan.run({} as any, interaction, {} as any);

    expect(prismaMock.currentWar.findMany).not.toHaveBeenCalled();
    expect(prismaMock.trackedClan.findMany).not.toHaveBeenCalled();
    expect(prismaMock.clanWarPlan.findMany).toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const embed = payload?.embeds?.[0]?.toJSON?.();
    expect(embed?.title).toBe("War Plans");
  });

  it("maps only supported exact custom override types", () => {
    expect(
      resolveWarPlanOverviewOverrideTypeForTest({
        matchType: "FWA",
        outcome: "WIN",
        loseStyle: "ANY",
      }),
    ).toBe("FWA-WIN");
    expect(
      resolveWarPlanOverviewOverrideTypeForTest({
        matchType: "FWA",
        outcome: "LOSE",
        loseStyle: "TRIPLE_TOP_30",
      }),
    ).toBe("FWA-LOSS-TRIPLE_TOP_30");
    expect(
      resolveWarPlanOverviewOverrideTypeForTest({
        matchType: "FWA",
        outcome: "ANY",
        loseStyle: "ANY",
      }),
    ).toBeNull();
  });

  it("formats defaults-only and paginates overview fields deterministically", () => {
    expect(buildWarPlanOverviewClanFieldValueForTest(new Set())).toBe(
      "Uses defaults for all match types",
    );
    const fields = Array.from({ length: 11 }, (_, index) => ({
      name: `Clan ${index + 1}`,
      value: "value",
      inline: false,
    }));
    const pages = paginateWarPlanOverviewFieldsForTest(fields, 10);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(10);
    expect(pages[1]).toHaveLength(1);
  });
});
