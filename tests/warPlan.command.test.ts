import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApplicationCommandOptionType, ComponentType } from "discord.js";

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
  buildWarPlanEditModalForTest,
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
    showModal: vi.fn().mockResolvedValue(undefined),
    awaitModalSubmit: vi.fn(),
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

  it.each([true, false])(
    "shows the effective Traditional open-window mirror state: %s",
    async (required) => {
      prismaMock.clanWarPlan.findMany
        .mockResolvedValueOnce([
          {
            matchType: "FWA",
            outcome: "LOSE",
            loseStyle: "TRADITIONAL",
            planText: "Traditional plan",
            nonMirrorTripleMinClanStars: 150,
            allBasesOpenHoursLeft: 12,
            traditionalRequireMirrorAfterOpen: required,
          },
        ])
        .mockResolvedValueOnce([]);
      const interaction = createInteraction({
        strings: {
          "clan-tag": "AAA111",
          "match-type": "FWA_LOSE_TRADITIONAL",
        },
      });

      await WarPlan.run({} as any, interaction, {} as any);

      const payload = interaction.editReply.mock.calls[0]?.[0] as any;
      const embed = payload?.embeds?.[0]?.toJSON?.();
      expect(embed?.fields?.[0]?.value).toContain(
        `Compliance gate: open at 150 clan stars or 12h left | open attacks: 0-2★ any | uncleared mirror after open: ${required ? "required" : "not required"} | clan cap: 100★`,
      );
    },
  );

  it.each([true, false])(
    "shows the effective FWA-WIN open-window mirror state: %s",
    async (required) => {
      prismaMock.clanWarPlan.findMany
        .mockResolvedValueOnce([
          {
            matchType: "FWA",
            outcome: "WIN",
            loseStyle: "ANY",
            planText: "WIN plan",
            nonMirrorTripleMinClanStars: 101,
            allBasesOpenHoursLeft: 12,
            winRequireMirrorAfterOpen: required,
          },
        ])
        .mockResolvedValueOnce([]);
      const interaction = createInteraction({
        strings: {
          "clan-tag": "AAA111",
          "match-type": "FWA_WIN",
        },
      });

      await WarPlan.run({} as any, interaction, {} as any);

      const payload = interaction.editReply.mock.calls[0]?.[0] as any;
      const embed = payload?.embeds?.[0]?.toJSON?.();
      expect(embed?.fields?.[0]?.value).toContain(
        `Compliance gate: non-mirror 3${String.fromCodePoint(0x2605)} opens at 101 clan stars or 12h left | uncleared mirror after open: ${required ? "required" : "not required"}`,
      );
    },
  );

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

describe("/warplan edit modal Traditional mirror checkbox", () => {
  const traditionalTarget = {
    matchType: "FWA" as const,
    outcome: "LOSE" as const,
    loseStyle: "TRADITIONAL" as const,
  };
  const traditionalConfig = {
    minStarsLabel: "Clan stars before non-mirror 2★ opens",
    minStarsDefault: 150,
    openHoursDefault: 12,
    openHoursDefaultText: "12h",
  };
  const prefill = {
    planText: "Traditional plan",
    nonMirrorTripleMinClanStars: 150,
    allBasesOpenHoursLeft: 12,
    traditionalRequireMirrorAfterOpen: true,
    winRequireMirrorAfterOpen: false,
  };

  it("renders exactly one checkbox after the existing Traditional fields", () => {
    const modal = buildWarPlanEditModalForTest({
      modalId: "modal-1",
      target: traditionalTarget,
      prefill,
      modalConfig: traditionalConfig,
    });
    const payload = modal as any;
    const labels = payload.components.filter(
      (component: any) => component.type === ComponentType.Label,
    );
    const checkboxes = payload.components.flatMap((component: any) =>
      component.type === ComponentType.Label && component.component?.type === ComponentType.Checkbox
        ? [component.component]
        : [],
    );

    expect(payload.components).toHaveLength(4);
    expect(labels).toHaveLength(1);
    expect(checkboxes).toHaveLength(1);
    expect(payload.components.at(-1).label).toBe(
      "Require uncleared 2★ mirror after open",
    );
    expect(payload.components.at(-1).description).toBe(
      "If enabled, an uncleared mirror must still be 2★ after bases open.",
    );
    expect(checkboxes[0]).toMatchObject({
      custom_id: "traditional-require-mirror-after-open",
      default: true,
    });
    expect(checkboxes[0].custom_id).not.toBe("win-require-mirror-after-open");
  });

  it("uses an unchecked default when the effective Traditional value is false", () => {
    const modal = buildWarPlanEditModalForTest({
      modalId: "modal-2",
      target: traditionalTarget,
      prefill: { ...prefill, traditionalRequireMirrorAfterOpen: false },
      modalConfig: traditionalConfig,
    });
    const payload = modal as any;
    expect(payload.components.at(-1).component.default).toBe(false);
  });

  it.each([
    ["TRIPLE_TOP_30", { matchType: "FWA", outcome: "LOSE", loseStyle: "TRIPLE_TOP_30" }],
    ["BL", { matchType: "BL", outcome: "ANY", loseStyle: "ANY" }],
    ["MM", { matchType: "MM", outcome: "ANY", loseStyle: "ANY" }],
  ])("does not render a checkbox for %s", (_label, target) => {
    const modal = buildWarPlanEditModalForTest({
      modalId: "modal-nontraditional",
      target: target as any,
      prefill,
      modalConfig: null,
    });
    const payload = modal as any;
    expect(
      payload.components.some(
        (component: any) => component.type === ComponentType.Label,
      ),
    ).toBe(false);
  });
});

describe("/warplan edit modal FWA WIN mirror checkbox", () => {
  const winTarget = {
    matchType: "FWA" as const,
    outcome: "WIN" as const,
    loseStyle: "ANY" as const,
  };
  const winConfig = {
    minStarsLabel: `Clan stars before non-mirror 3${String.fromCodePoint(0x2605)} opens`,
    minStarsDefault: 101,
    openHoursDefault: 12,
    openHoursDefaultText: "12h",
  };
  const winPrefill = {
    planText: "FWA WIN plan",
    nonMirrorTripleMinClanStars: 101,
    allBasesOpenHoursLeft: 12,
    traditionalRequireMirrorAfterOpen: false,
    winRequireMirrorAfterOpen: true,
  };

  it("renders exactly one WIN checkbox with the effective default", () => {
    const payload = buildWarPlanEditModalForTest({
      modalId: "modal-win",
      target: winTarget,
      prefill: winPrefill,
      modalConfig: winConfig,
    }) as any;
    const checkboxes = payload.components.flatMap((component: any) =>
      component.type === ComponentType.Label && component.component?.type === ComponentType.Checkbox
        ? [component.component]
        : [],
    );

    expect(checkboxes).toHaveLength(1);
    expect(payload.components.at(-1)).toMatchObject({
      label: `Require uncleared 3${String.fromCodePoint(0x2605)} mirror after open`,
      description: `If enabled, an uncleared mirror must still be 3${String.fromCodePoint(0x2605)} after bases open.`,
    });
    expect(checkboxes[0]).toMatchObject({
      custom_id: "win-require-mirror-after-open",
      default: true,
    });
    expect(checkboxes[0].custom_id).not.toBe("traditional-require-mirror-after-open");
  });

  it("renders the WIN checkbox unchecked when the effective value is false", () => {
    const payload = buildWarPlanEditModalForTest({
      modalId: "modal-win-false",
      target: winTarget,
      prefill: { ...winPrefill, winRequireMirrorAfterOpen: false },
      modalConfig: winConfig,
    }) as any;
    expect(payload.components.at(-1).component).toMatchObject({
      custom_id: "win-require-mirror-after-open",
      default: false,
    });
  });
});

describe("/warplan Traditional mirror checkbox persistence", () => {
  async function saveTraditional(input: {
    subcommand: "set" | "set-default";
    checked: boolean;
  }) {
    prismaMock.clanWarPlan.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        planText: "Existing Traditional plan",
        nonMirrorTripleMinClanStars: 150,
        allBasesOpenHoursLeft: 12,
        traditionalRequireMirrorAfterOpen: false,
      })
      .mockResolvedValueOnce(null);
    prismaMock.clanWarPlan.upsert.mockReset().mockResolvedValue({});

    const interaction = createInteraction({
      subcommand: input.subcommand,
      strings: {
        "clan-tag": "AAA111",
        "match-type": "FWA_LOSE_TRADITIONAL",
      },
    });
    interaction.awaitModalSubmit.mockResolvedValue({
      customId: "ignored-by-mock",
      user: { id: "user-1" },
      fields: {
        getTextInputValue: vi.fn((customId: string) =>
          customId === "plan-text"
            ? "Saved Traditional plan"
            : customId === "non-mirror-min-stars"
              ? "150"
              : "12",
        ),
        getField: vi.fn().mockReturnValue({
          type: ComponentType.Checkbox,
          value: input.checked,
        }),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    });

    await WarPlan.run({} as any, interaction, {} as any);
    return prismaMock.clanWarPlan.upsert.mock.calls[0]?.[0] as any;
  }

  it.each([true, false])("persists an explicit Traditional value: %s", async (checked) => {
    const args = await saveTraditional({ subcommand: "set", checked });
    expect(args.update.traditionalRequireMirrorAfterOpen).toBe(checked);
    expect(args.create.traditionalRequireMirrorAfterOpen).toBe(checked);
    expect(args.where.guildId_scope_clanTag_matchType_outcome_loseStyle.scope).toBe(
      "CUSTOM",
    );
  });

  it("persists the checkbox on the DEFAULT row for set-default", async () => {
    const args = await saveTraditional({ subcommand: "set-default", checked: true });
    expect(args.where.guildId_scope_clanTag_matchType_outcome_loseStyle).toMatchObject({
      scope: "DEFAULT",
      clanTag: "",
    });
    expect(args.create.traditionalRequireMirrorAfterOpen).toBe(true);
  });
});

describe("/warplan FWA WIN mirror checkbox persistence", () => {
  async function saveWin(input: {
    subcommand: "set" | "set-default";
    checked: boolean;
  }) {
    prismaMock.clanWarPlan.findUnique
      .mockReset()
      .mockResolvedValueOnce({
        planText: "Existing WIN plan",
        nonMirrorTripleMinClanStars: 101,
        allBasesOpenHoursLeft: 12,
        traditionalRequireMirrorAfterOpen: true,
        winRequireMirrorAfterOpen: false,
      })
      .mockResolvedValueOnce(null);
    prismaMock.clanWarPlan.upsert.mockReset().mockResolvedValue({});

    const getField = vi.fn().mockImplementation((customId: string) => ({
      type: ComponentType.Checkbox,
      value:
        customId === "win-require-mirror-after-open" ? input.checked : false,
    }));
    const interaction = createInteraction({
      subcommand: input.subcommand,
      strings: {
        "clan-tag": "AAA111",
        "match-type": "FWA_WIN",
      },
    });
    interaction.awaitModalSubmit.mockResolvedValue({
      customId: "ignored-by-mock",
      user: { id: "user-1" },
      fields: {
        getTextInputValue: vi.fn((customId: string) =>
          customId === "plan-text"
            ? "Saved WIN plan"
            : customId === "non-mirror-min-stars"
              ? "101"
              : "12",
        ),
        getField,
      },
      reply: vi.fn().mockResolvedValue(undefined),
    });

    await WarPlan.run({} as any, interaction, {} as any);
    return prismaMock.clanWarPlan.upsert.mock.calls[0]?.[0] as any;
  }

  it.each([true, false])("persists an explicit WIN value: %s", async (checked) => {
    const args = await saveWin({ subcommand: "set", checked });
    expect(args.update.winRequireMirrorAfterOpen).toBe(checked);
    expect(args.create.winRequireMirrorAfterOpen).toBe(checked);
    expect(args.update.traditionalRequireMirrorAfterOpen).toBeUndefined();
    expect(args.create.traditionalRequireMirrorAfterOpen).toBeUndefined();
    expect(args.where.guildId_scope_clanTag_matchType_outcome_loseStyle.scope).toBe(
      "CUSTOM",
    );
  });

  it("persists the WIN checkbox on the DEFAULT row only", async () => {
    const args = await saveWin({ subcommand: "set-default", checked: true });
    expect(args.where.guildId_scope_clanTag_matchType_outcome_loseStyle).toMatchObject({
      scope: "DEFAULT",
      clanTag: "",
    });
    expect(args.create.winRequireMirrorAfterOpen).toBe(true);
    expect(args.update.winRequireMirrorAfterOpen).toBe(true);
  });
});
