import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Roster } from "../src/commands/Roster";
import { rosterService } from "../src/services/RosterService";

function makeInteraction(input: {
  subcommand: "create" | "report" | "readiness" | "refresh" | "open" | "close" | "archive" | "add" | "move" | "remove";
  clan?: string | null;
  groupKey?: string | null;
  players?: string | null;
  timezone?: string | null;
}) {
  return {
    user: { id: "111111111111111111" },
    guildId: "guild-1",
    inGuild: () => true,
    options: {
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clan ?? null;
        if (name === "group") return input.groupKey ?? null;
        if (name === "players") return input.players ?? null;
        if (name === "timezone") return input.timezone ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    channel: null,
    client: {
      channels: {
        fetch: vi.fn().mockResolvedValue(null),
      },
    },
  };
}

function getEditedDescription(interaction: any): string {
  const payload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

describe("/roster command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    vi.spyOn(rosterService, "createRoster");
    vi.spyOn(rosterService, "buildRosterSignupPayload");
    vi.spyOn(rosterService, "recordRosterPostedMessage");
    vi.spyOn(rosterService, "findCwlRosterForClan");
    vi.spyOn(rosterService, "buildRosterManagerReadinessText");
    vi.spyOn(rosterService, "updateRosterLifecycleState");
    vi.spyOn(rosterService, "getRosterView");
    vi.spyOn(rosterService, "addRosterSignupsForManager");
    vi.spyOn(rosterService, "moveRosterSignups");
    vi.spyOn(rosterService, "removeRosterSignupsAsManager");
  });

  it("posts a CWL signup roster through /roster create", async () => {
    (rosterService.createRoster as any).mockResolvedValue({ id: "roster-1" });
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha CWL Signup (2026-04)"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("roster-signup:roster-1:confirmed")
            .setLabel("Confirmed (0)")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    (rosterService.recordRosterPostedMessage as any).mockResolvedValue(undefined);

    const interaction = makeInteraction({
      subcommand: "create",
      clan: "#2QG2C08UP",
      timezone: "America/Los_Angeles",
    }) as any;
    interaction.channel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({
        id: "message-1",
        channelId: "channel-1",
        url: "https://discord.com/channels/guild-1/channel-1/message-1",
      }),
    };

    await Roster.run({} as any, interaction as any);

    expect(rosterService.createRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        clanTag: "#2QG2C08UP",
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
      }),
    );
    expect(rosterService.recordRosterPostedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        channelId: "channel-1",
        messageId: "message-1",
        messageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Posted CWL signup roster for CWL Alpha in <#channel-1>.",
    );
  });

  it.each(["report", "readiness"] as const)(
    "renders the manager readiness view for /roster %s",
    async (subcommand) => {
      (rosterService.findCwlRosterForClan as any).mockResolvedValue({
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        lifecycleState: "OPEN",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      });
      (rosterService.buildRosterManagerReadinessText as any).mockResolvedValue(
        "CWL Alpha Signup\nUnsigned tracked clan members:\n- Bravo `#QGRJ2222` <@222222222222222222>",
      );

      const interaction = makeInteraction({
        subcommand,
        clan: "#2QG2C08UP",
      }) as any;

      await Roster.run({} as any, interaction as any);

      expect(rosterService.buildRosterManagerReadinessText).toHaveBeenCalledWith({
        rosterId: "roster-1",
      });
      expect(getEditedDescription(interaction)).toContain("Unsigned tracked clan members:");
    },
  );

  it.each([
    ["open", "OPEN", "was opened"],
    ["close", "CLOSED", "was closed"],
    ["archive", "ARCHIVED", "was archived"],
  ] as const)("updates roster lifecycle through /roster %s", async (subcommand, lifecycleState, message) => {
    (rosterService.findCwlRosterForClan as any).mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "OPEN",
      postedChannelId: "channel-1",
      postedMessageId: "message-1",
      postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    (rosterService.updateRosterLifecycleState as any).mockResolvedValue({
      outcome: "updated",
      rosterId: "roster-1",
      lifecycleState,
    });
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        postedChannelId: null,
        postedMessageId: null,
      },
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });

    const interaction = makeInteraction({
      subcommand,
      clan: "#2QG2C08UP",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState,
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(message);
  });

  it("supports manager add, move, remove, and refresh through /roster", async () => {
    (rosterService.findCwlRosterForClan as any).mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      displayTimezone: "America/Los_Angeles",
      lifecycleState: "OPEN",
      postedChannelId: "channel-1",
      postedMessageId: "message-1",
      postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        postedChannelId: null,
        postedMessageId: null,
      },
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterService.addRosterSignupsForManager as any).mockResolvedValue({
      outcome: "created",
      rosterId: "roster-1",
      groupKey: "confirmed",
      groupName: "Confirmed",
      requestedTags: ["#PQL0289", "#QGRJ2222"],
      linkedTags: ["#PQL0289", "#QGRJ2222"],
      createdTags: ["#PQL0289", "#QGRJ2222"],
      duplicateTags: [],
      missingLinkedTags: [],
    });
    (rosterService.moveRosterSignups as any).mockResolvedValue({
      outcome: "moved",
      rosterId: "roster-1",
      groupKey: "substitute",
      requestedTags: ["#PQL0289"],
      movedTags: ["#PQL0289"],
      duplicateTags: [],
      missingTags: [],
    });
    (rosterService.removeRosterSignupsAsManager as any).mockResolvedValue({
      outcome: "removed",
      rosterId: "roster-1",
      removedTags: ["#PQL0289"],
      ignoredTags: [],
      notOwnedTags: [],
    });

    const addInteraction = makeInteraction({
      subcommand: "add",
      clan: "#2QG2C08UP",
      groupKey: "confirmed",
      players: "#PQL0289 #QGRJ2222",
    }) as any;
    await Roster.run({} as any, addInteraction as any);
    expect(rosterService.addRosterSignupsForManager).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        groupKey: "confirmed",
        playerTags: ["#PQL0289", "#QGRJ2222"],
      }),
    );
    expect(String(addInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("Signed up #PQL0289, #QGRJ2222");

    const moveInteraction = makeInteraction({
      subcommand: "move",
      clan: "#2QG2C08UP",
      groupKey: "substitute",
      players: "#PQL0289",
    }) as any;
    await Roster.run({} as any, moveInteraction as any);
    expect(rosterService.moveRosterSignups).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        groupKey: "substitute",
        playerTags: ["#PQL0289"],
      }),
    );
    expect(String(moveInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("Moved #PQL0289 to substitute");

    const removeInteraction = makeInteraction({
      subcommand: "remove",
      clan: "#2QG2C08UP",
      players: "#PQL0289",
    }) as any;
    await Roster.run({} as any, removeInteraction as any);
    expect(rosterService.removeRosterSignupsAsManager).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        playerTags: ["#PQL0289"],
      }),
    );
    expect(String(removeInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("Removed #PQL0289");

    const refreshInteraction = makeInteraction({
      subcommand: "refresh",
      clan: "#2QG2C08UP",
    }) as any;
    await Roster.run({} as any, refreshInteraction as any);
    expect(rosterService.buildRosterSignupPayload).toHaveBeenCalledWith("roster-1");
    expect(rosterService.getRosterView).toHaveBeenCalledWith("roster-1");
    expect(String(refreshInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Refreshed the posted CWL roster for CWL Alpha.",
    );
  });
});
