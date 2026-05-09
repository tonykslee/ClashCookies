import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  raidTrackedClan: {
    findMany: vi.fn(),
  },
}));

const refreshHelperMock = vi.hoisted(() => ({
  refreshRaidTrackedClanListWithQueueContext: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/commands/TrackedClan", () => ({
  refreshRaidTrackedClanListWithQueueContext: refreshHelperMock.refreshRaidTrackedClanListWithQueueContext,
}));

import {
  handleRaidsButtonInteraction,
  handleRaidsSelectMenuInteraction,
  Raids,
} from "../src/commands/Raids";

function makeTrackedClanRows() {
  return [
    {
      clanTag: "2QG2C08UP",
      name: "Alpha Raid",
      upgrades: 2210,
      joinType: "open",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:00:00.000Z"),
    },
    {
      clanTag: "2RVGJYLC0",
      name: "Bravo Raid",
      upgrades: null,
      joinType: "closed",
      createdAt: new Date("2026-05-02T00:00:00.000Z"),
      updatedAt: new Date("2026-05-08T11:30:00.000Z"),
    },
  ];
}

function makeChatInteraction(options?: { clan?: string | null; focused?: string }) {
  const clan = options?.clan ?? null;
  const focused = options?.focused ?? "";
  return {
    id: "raids-itx-1",
    commandName: "raids",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getString: vi.fn((name: string) => (name === "clan" ? clan : null)),
      getFocused: vi.fn().mockReturnValue({ name: "clan", value: focused }),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function makeButtonInteraction(customId: string) {
  return {
    customId,
    user: { id: "user-1" },
    replied: false,
    deferred: false,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: {
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeSelectInteraction(customId: string, value: string) {
  return {
    customId,
    values: [value],
    user: { id: "user-1" },
    replied: false,
    deferred: false,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: {
      edit: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("/raids command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    prismaMock.raidTrackedClan.findMany.mockResolvedValue(makeTrackedClanRows());
    refreshHelperMock.refreshRaidTrackedClanListWithQueueContext.mockResolvedValue({
      refreshed: ["#AAA111"],
      joinTypeRefreshFailures: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the overview shell with dropdown and refresh button", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        if (tag === "#2QG2C08UP") {
          return [
            {
              startTime: "2026-05-08T00:00:00.000Z",
              endTime: "2026-05-11T00:00:00.000Z",
              members: [{ attacks: 6 }, { attacks: 5 }],
            },
          ];
        }
        return [];
      }),
    };
    const interaction = makeChatInteraction();

    await Raids.run({} as any, interaction as any, cocService as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("## Raid Clans");
    expect(description).toContain("🔓 [Alpha Raid]");
    expect(description).toContain("Attacks: 11/12");
    expect(description).toContain("Raids completed: —");

    const selectRow = payload.components[0]?.toJSON?.().components[0];
    expect(selectRow?.custom_id).toBe("raids:raids-itx-1:select");
    expect(selectRow?.options?.[0]?.label).toContain("Alpha Raid");
    expect(selectRow?.options?.[0]?.value).toBe("2QG2C08UP");

    const buttonIds = payload.components[1]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(buttonIds).toEqual(["raids:raids-itx-1:refresh"]);
  });

  it("renders a single clan view with back and refresh buttons", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        if (tag === "#BBB222") {
          return [];
        }
        return [
          {
            startTime: "2026-05-08T00:00:00.000Z",
            endTime: "2026-05-11T00:00:00.000Z",
            members: [{ attacks: 6 }, { attacks: 5 }],
          },
        ];
      }),
    };
    const interaction = makeChatInteraction({ clan: "2RVGJYLC0" });

    await Raids.run({} as any, interaction as any, cocService as any);

    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("## Raid Clan");
    expect(description).toContain("Join type: Closed");
    expect(description).toContain("Bravo Raid");
    const buttonIds = payload.components[1]?.toJSON?.().components.map((component: any) =>
      String(component.custom_id ?? ""),
    );
    expect(buttonIds).toEqual([
      "raids:raids-itx-1:back",
      "raids:raids-itx-1:refresh",
    ]);
  });

  it("supports raid clan autocomplete", async () => {
    const interaction = makeChatInteraction({ focused: "alp" });

    await Raids.autocomplete?.(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha Raid (#2QG2C08UP)", value: "2QG2C08UP" },
    ]);
  });

  it("switches to a single-clan view from the dropdown and can return to overview", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        if (tag === "#2QG2C08UP") {
          return [
            {
              startTime: "2026-05-08T00:00:00.000Z",
              endTime: "2026-05-11T00:00:00.000Z",
              members: [{ attacks: 6 }, { attacks: 5 }],
            },
          ];
        }
        return [];
      }),
    };
    const interaction = makeChatInteraction();
    await Raids.run({} as any, interaction as any, cocService as any);

    const selectInteraction = makeSelectInteraction("raids:raids-itx-1:select", "2RVGJYLC0");
    await handleRaidsSelectMenuInteraction(selectInteraction as any, cocService as any);

    expect(selectInteraction.deferUpdate).toHaveBeenCalled();
    expect(selectInteraction.message.edit).toHaveBeenCalled();
    const selectedPayload = selectInteraction.message.edit.mock.calls.at(-1)?.[0] as any;
    const selectedDescription = selectedPayload.embeds[0].toJSON().description as string;
    expect(selectedDescription).toContain("## Raid Clan");
    expect(selectedDescription).toContain("Join type: Closed");
    expect(selectedDescription).toContain("Bravo Raid");

    const backButton = makeButtonInteraction("raids:raids-itx-1:back");
    await handleRaidsButtonInteraction(backButton as any, cocService as any);

    expect(backButton.deferUpdate).toHaveBeenCalled();
    expect(backButton.message.edit).toHaveBeenCalled();
    const backPayload = backButton.message.edit.mock.calls.at(-1)?.[0] as any;
    const backDescription = backPayload.embeds[0].toJSON().description as string;
    expect(backDescription).toContain("## Raid Clans");
  });

  it("refreshes the current raids view in place", async () => {
    const cocService = {
      getClanCapitalRaidSeasons: vi.fn(async (tag: string) => {
        if (tag === "#2QG2C08UP") {
          return [
            {
              startTime: "2026-05-08T00:00:00.000Z",
              endTime: "2026-05-11T00:00:00.000Z",
              members: [{ attacks: 6 }, { attacks: 5 }],
            },
          ];
        }
        return [];
      }),
    };
    const interaction = makeChatInteraction();
    await Raids.run({} as any, interaction as any, cocService as any);

    const refreshInteraction = makeButtonInteraction("raids:raids-itx-1:refresh");
    await handleRaidsButtonInteraction(refreshInteraction as any, cocService as any);

    expect(refreshHelperMock.refreshRaidTrackedClanListWithQueueContext).toHaveBeenCalled();
    expect(refreshInteraction.message.edit).toHaveBeenCalled();
    const refreshedPayload = refreshInteraction.message.edit.mock.calls.at(-1)?.[0] as any;
    const refreshedDescription = refreshedPayload.embeds[0].toJSON().description as string;
    expect(refreshedDescription).toContain("## Raid Clans");
    expect(refreshedDescription).toContain("Attacks: 11/12");
  });
});
