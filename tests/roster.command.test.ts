import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  cwlTrackedClan: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import {
  Roster,
  handleRosterPostClearButtonInteraction,
  handleRosterPostCustomizeMenuInteraction,
  handleRosterManageWeightOpenButtonInteraction,
  handleRosterManageWeightModalSubmit,
  handleRosterPostRefreshButtonInteraction,
  handleRosterPostSettingsButtonInteraction,
  handleRosterPostSettingsMenuInteraction,
} from "../src/commands/Roster";
import { rosterService } from "../src/services/RosterService";
import { rosterExportService } from "../src/services/RosterExportService";
import { rosterWeightService } from "../src/services/RosterWeightService";

type RosterSubcommand =
  | "create"
  | "list"
  | "post"
  | "manage"
  | "edit"
  | "delete"
  | "report"
  | "readiness"
  | "refresh";

const interactionClientFetchMock = vi.fn();

function makeInteraction(input: {
  subcommand: RosterSubcommand;
  clan?: string | null;
  category?: string | null;
  name?: string | null;
  title?: string | null;
  roster?: string | null;
  action?: string | null;
  group?: string | null;
  players?: string | null;
  timezone?: string | null;
  displayTimezone?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  maxMembers?: number | null;
  maxAccountsPerUser?: number | null;
  minTownhall?: number | null;
  maxTownhall?: number | null;
  rosterRole?: string | null;
  allowMultiSignup?: boolean | null;
  sortBy?: string | null;
  importMembers?: boolean | null;
  deleteRole?: boolean | null;
  user?: string | null;
  player?: string | null;
}) {
  return {
    user: { id: "111111111111111111" },
    guildId: "guild-1",
    inGuild: () => true,
    options: {
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clan ?? null;
        if (name === "category") return input.category ?? null;
        if (name === "name") return input.name ?? null;
        if (name === "title") return input.title ?? null;
        if (name === "roster") return input.roster ?? null;
        if (name === "action") return input.action ?? null;
        if (name === "group") return input.group ?? null;
        if (name === "players") return input.players ?? null;
        if (name === "timezone") return input.timezone ?? null;
        if (name === "display-timezone") return input.displayTimezone ?? null;
        if (name === "start_time") return input.startTime ?? null;
        if (name === "end_time") return input.endTime ?? null;
        if (name === "roster_role") return input.rosterRole ?? null;
        if (name === "sort_by") return input.sortBy ?? null;
        if (name === "user") return input.user ?? null;
        if (name === "player") return input.player ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) => {
        if (name === "max_members") return input.maxMembers ?? null;
        if (name === "max_accounts_per_user") return input.maxAccountsPerUser ?? null;
        if (name === "min_townhall") return input.minTownhall ?? null;
        if (name === "max_townhall") return input.maxTownhall ?? null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "allow_multi_signup") return input.allowMultiSignup ?? null;
        if (name === "import_members") return input.importMembers ?? null;
        if (name === "delete_role") return input.deleteRole ?? null;
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
  if (typeof payload === "string") {
    return payload;
  }
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getEditedEmbed(interaction: any): any {
  const payload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
  return payload?.embeds?.[0]?.toJSON?.() ?? null;
}

describe("/roster command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    interactionClientFetchMock.mockReset();
    prismaMock.$queryRaw.mockResolvedValue([]);

    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    vi.spyOn(rosterService, "createRoster");
    vi.spyOn(rosterService, "buildRosterSignupPayload");
    vi.spyOn(rosterService, "refreshRosterSignupPayload");
    vi.spyOn(rosterService, "recordRosterPostedMessage");
    vi.spyOn(rosterService, "findGuildRosterById");
    vi.spyOn(rosterService, "listGuildRosters");
    vi.spyOn(rosterService, "buildRosterManagerReadinessText");
    vi.spyOn(rosterService, "updateRosterLifecycleState");
    vi.spyOn(rosterService, "updateRosterPostButtonMode");
    vi.spyOn(rosterService, "updateRoster");
    vi.spyOn(rosterService, "deleteRoster");
    vi.spyOn(rosterService, "clearRosterSignups");
    vi.spyOn(rosterService, "getRosterView");
    vi.spyOn(rosterService, "getRosterRoleSyncTargets").mockResolvedValue(null as any);
    vi.spyOn(rosterService, "addRosterSignupsForManager");
    vi.spyOn(rosterService, "moveRosterSignups");
    vi.spyOn(rosterService, "removeRosterSignupsAsManager");
    vi.spyOn(rosterWeightService, "setManualWeightForRoster");
    vi.spyOn(rosterExportService, "createRosterExport");
  });

  it("creates a roster object without posting it immediately", async () => {
    (rosterService.createRoster as any).mockResolvedValue({ id: "roster-1" });

    const interaction = makeInteraction({
      subcommand: "create",
      clan: "#2QG2C08UP",
      timezone: "America/Los_Angeles",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.createRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        clanTag: "#2QG2C08UP",
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        name: expect.stringContaining("CWL Alpha"),
        startsAt: expect.any(Date),
      }),
    );
    expect(rosterService.recordRosterPostedMessage).not.toHaveBeenCalled();
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Use /roster post roster:roster-1 to publish it.",
    );
  });

  it("accepts title as a compatibility alias when creating a roster", async () => {
    (rosterService.createRoster as any).mockResolvedValue({ id: "roster-2" });

    const interaction = makeInteraction({
      subcommand: "create",
      clan: "#2QG2C08UP",
      title: "CWL Alpha Signup",
      timezone: "America/Los_Angeles",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.createRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "CWL Alpha Signup",
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Use /roster post roster:roster-2 to publish it.",
    );
  });

  it("posts an existing roster later through /roster post", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
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
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("roster-post-action:signup:roster-1")
            .setLabel("Signup")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    (rosterService.recordRosterPostedMessage as any).mockResolvedValue(undefined);

    const interaction = makeInteraction({
      subcommand: "post",
      roster: "roster-1",
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

    expect(rosterService.findGuildRosterById).toHaveBeenCalledWith({
      guildId: "guild-1",
      rosterId: "roster-1",
    });
    expect(rosterService.recordRosterPostedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        channelId: "channel-1",
        messageId: "message-1",
        messageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Posted roster CWL Alpha Signup in the current channel.",
    );
  });

  it("shows roster list metadata for managers", async () => {
    (rosterService.listGuildRosters as any).mockResolvedValue([
      {
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
        groupCount: 2,
        signupCount: 5,
      },
    ]);

    const interaction = makeInteraction({
      subcommand: "list",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.listGuildRosters).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        name: null,
        user: null,
        player: null,
        clan: null,
      }),
    );
    const embed = getEditedEmbed(interaction);
    expect(embed?.title).toBe("Guild Rosters");
    expect(String(embed?.fields?.[0]?.value ?? "")).toContain("Type: CWL / signup");
    expect(String(embed?.fields?.[0]?.value ?? "")).toContain("State: Open");
    expect(String(embed?.fields?.[0]?.value ?? "")).toContain("Posted: yes in <#channel-1>");
    expect(String(embed?.fields?.[0]?.value ?? "")).toContain("Groups: 2 | Signups: 5");
  });

  it("routes roster manage actions to the existing add, move, remove, and lifecycle helpers", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
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
    (rosterService.updateRosterLifecycleState as any).mockResolvedValue({
      outcome: "updated",
      rosterId: "roster-1",
      lifecycleState: "CLOSED",
    });

    const addInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "add",
      group: "confirmed",
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
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
      group: "substitute",
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
      subcommand: "manage",
      roster: "roster-1",
      action: "remove",
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

    const closeInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "close",
    }) as any;
    await Roster.run({} as any, closeInteraction as any);
    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState: "CLOSED",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(String(closeInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("was closed");

    const openInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "open",
    }) as any;
    await Roster.run({} as any, openInteraction as any);
    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState: "OPEN",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(String(openInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("was opened");

    const archiveInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "archive",
    }) as any;
    await Roster.run({} as any, archiveInteraction as any);
    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState: "ARCHIVED",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(String(archiveInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("was archived");

    (rosterService.getRosterView as any).mockResolvedValueOnce({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PQL0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          townHall: 15,
          trophies: 5200,
          weight: 145000,
          weightSource: "FWA",
          weightMeasuredAt: new Date("2026-04-20T00:00:00.000Z"),
          discordDisplayName: "Alpha",
          discordUsername: "alpha-user",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: "Primary roster members",
            sortOrder: 0,
          },
        },
      ],
      totalSignupCount: 1,
    });
    const setWeightInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "set_weight",
      players: "#PQL0289",
    }) as any;
    await Roster.run({} as any, setWeightInteraction as any);
    const setWeightPayload = setWeightInteraction.editReply.mock.calls.at(-1)?.[0] as any;
    expect(setWeightPayload.embeds[0]?.toJSON?.().title).toBe("Set weight");
    const setWeightButton = setWeightPayload.components[0]?.toJSON?.().components?.[0];
    expect(setWeightButton?.label).toBe("Set weight");
    expect(setWeightButton?.custom_id).toBe("roster-manage-weight:open:roster-1:#PQL0289");
  });

  it("rejects roster manage set_weight when the selected player is not on the roster", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
    });
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });

    const interaction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "set_weight",
      players: "#PQL0289",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "That player is not signed up on this roster.",
    );
  });

  it("opens the roster weight modal from the manage weight instructions panel", async () => {
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PQL0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          townHall: 15,
          trophies: 5200,
          weight: 145000,
          weightSource: "FWA",
          weightMeasuredAt: new Date("2026-04-20T00:00:00.000Z"),
          discordDisplayName: "Alpha",
          discordUsername: "alpha-user",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: "Primary roster members",
            sortOrder: 0,
          },
        },
      ],
      totalSignupCount: 1,
    });
    const interaction = {
      customId: "roster-manage-weight:open:roster-1:#PQL0289",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      showModal: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterManageWeightOpenButtonInteraction(interaction);

    expect(interaction.showModal).toHaveBeenCalledWith(expect.anything());
    const modal = interaction.showModal.mock.calls[0]?.[0] as any;
    expect(modal.toJSON?.().custom_id).toBe("roster-manage-weight:submit:roster-1:#PQL0289");
    expect(modal.toJSON?.().title).toBe("Set Weight");
  });

  it("persists a roster weight from the modal submit flow and refreshes the posted board", async () => {
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PQL0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-20T00:00:00.000Z"),
          createdAt: new Date("2026-04-20T00:00:00.000Z"),
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          townHall: 15,
          trophies: 5200,
          weight: 145000,
          weightSource: "FWA",
          weightMeasuredAt: new Date("2026-04-20T00:00:00.000Z"),
          discordDisplayName: "Alpha",
          discordUsername: "alpha-user",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          group: {
            id: "group-confirmed",
            key: "confirmed",
            name: "Confirmed",
            description: "Primary roster members",
            sortOrder: 0,
          },
        },
      ],
      totalSignupCount: 1,
    });
    (rosterWeightService.setManualWeightForRoster as any).mockResolvedValue({
      outcome: "saved",
      rosterId: "roster-1",
      playerTag: "#PQL0289",
      weight: 145000,
      measuredAt: new Date("2026-04-22T12:00:00.000Z"),
    });
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    const editedMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const interaction = {
      customId: "roster-manage-weight:submit:roster-1:#PQL0289",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      fields: {
        getTextInputValue: vi.fn(() => "145k"),
      },
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterManageWeightModalSubmit(interaction, {} as any);

    expect(rosterWeightService.setManualWeightForRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        playerTag: "#PQL0289",
        weight: 145000,
        updatedByUserId: "111111111111111111",
      }),
    );
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(editedMessage.edit).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.any(EmbedBuilder)] }));
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Saved manual weight 145k for Alpha.",
    );
  });

  it("opens the compact roster settings menu with only real actions", async () => {
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    const interaction = {
      customId: "roster-post-action:settings:roster-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostSettingsButtonInteraction(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
      }),
    );
    const payload = interaction.reply.mock.calls[0]?.[0] as any;
    const menu = payload.components[0]?.toJSON?.().components?.[0];
    const optionValues = menu?.options?.map((option: any) => option.value) ?? [];
    expect(optionValues).toEqual([
      "export",
      "customize",
      "close_roster",
      "clear_roster",
      "hide_buttons",
      "archive_mode",
      "unregistered_members",
      "missing_members",
    ]);
    expect(optionValues).not.toContain("open_roster");
  });

  it("opens the roster customization panel when Settings -> Customize is selected", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
        sortBy: "weight",
        displayColumns: ["player_name", "discord_username", "clan_name"],
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    const interaction = {
      customId: "roster-post-settings:roster-1",
      values: ["customize"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      showModal: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostSettingsMenuInteraction(interaction, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder), expect.any(ActionRowBuilder)],
      }),
    );
    expect(String(interaction.reply.mock.calls[0]?.[0]?.content ?? "")).not.toContain(
      "Choose at least one column to customize.",
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it("opens the roster export sheet from the settings panel when Export is selected", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
        sortBy: null,
        displayColumns: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterExportService.createRosterExport as any).mockResolvedValue({
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit?usp=sharing",
      tabName: "Roster Export",
      rowCount: 2,
    });
    const settingsInteraction = {
      customId: "roster-post-settings:roster-1",
      values: ["export"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostSettingsMenuInteraction(settingsInteraction, {} as any);

    expect(rosterExportService.createRosterExport).toHaveBeenCalledWith({
      rosterId: "roster-1",
    });
    expect(settingsInteraction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(settingsInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Roster export ready.",
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder), expect.any(ActionRowBuilder)],
      }),
    );
    const payload = settingsInteraction.editReply.mock.calls[0]?.[0] as any;
    const linkRow = payload.components[1]?.toJSON?.().components?.[0];
    expect(linkRow?.label ?? linkRow?.data?.label).toBe("Open Google Sheet");
    expect(linkRow?.url ?? linkRow?.data?.url).toBe("https://docs.google.com/spreadsheets/d/sheet-1/edit?usp=sharing");
  });

  it("persists visible columns immediately from the select menu and rerenders the posted roster board", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
      sortBy: null,
      displayColumns: null,
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
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
        sortBy: null,
        displayColumns: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterService.updateRoster as any).mockResolvedValue({
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
      sortBy: null,
      displayColumns: ["player_name", "discord_username", "clan_name"],
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
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    const editedMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const interaction = {
      customId: "roster-post-customize:columns:roster-1",
      values: ["clan_name", "discord_username", "player_name"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostCustomizeMenuInteraction(interaction, {} as any);

    expect(rosterService.updateRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        displayColumns: ["clan_name", "discord_username", "player_name"],
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith("roster-1", expect.anything(), expect.anything());
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder), expect.any(ActionRowBuilder)],
        content: "Roster columns updated.",
      }),
    );
    expect(editedMessage.edit).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.any(EmbedBuilder)] }));
  });

  it("persists the selected roster sort mode when customizing the posted roster board", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
      sortBy: null,
      displayColumns: null,
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
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "OPEN",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
        sortBy: null,
        displayColumns: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterService.updateRoster as any).mockResolvedValue({
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
      sortBy: "weight",
      displayColumns: null,
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
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    const editedMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const interaction = {
      customId: "roster-post-customize:sort:roster-1",
      values: ["weight"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostCustomizeMenuInteraction(interaction, {} as any);

    expect(rosterService.updateRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        sortBy: "weight",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith("roster-1", expect.anything(), expect.anything());
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder), expect.any(ActionRowBuilder)],
      }),
    );
  });

  it("shows open roster instead of close roster when the roster is already closed", async () => {
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        lifecycleState: "CLOSED",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        minTownhall: 13,
        maxTownhall: null,
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    const interaction = {
      customId: "roster-post-action:settings:roster-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostSettingsButtonInteraction(interaction);

    const payload = interaction.reply.mock.calls[0]?.[0] as any;
    const menu = payload.components[0]?.toJSON?.().components?.[0];
    const optionValues = menu?.options?.map((option: any) => option.value) ?? [];
    expect(optionValues).toContain("open_roster");
    expect(optionValues).not.toContain("close_roster");
  });

  it("refreshes the posted roster from the service-owned current-clan refresh path", async () => {
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup (Refreshed)"),
      components: [],
    });
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "roster-post-action:refresh:roster-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      deferUpdate,
      editReply,
      update,
    } as any;

    await handleRosterPostRefreshButtonInteraction(interaction, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      (rosterService.refreshRosterSignupPayload as any).mock.invocationCallOrder[0],
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      expect.anything(),
      expect.anything(),
    );
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("acknowledges the refresh button before reporting a missing roster", async () => {
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue(null);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "roster-post-action:refresh:roster-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      deferUpdate,
      editReply,
    } as any;

    await handleRosterPostRefreshButtonInteraction(interaction, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      expect.anything(),
      expect.anything(),
    );
    expect(editReply).toHaveBeenCalledWith("That roster is no longer available.");
  });

  it("blocks roster post refresh actions when the user lacks the roster permission target", async () => {
    const interaction = {
      customId: "roster-post-action:refresh:roster-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(false),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostRefreshButtonInteraction(interaction, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You don't have permission to refresh this roster.",
        ephemeral: true,
      }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("shows a clear confirmation panel before removing roster signups", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    (rosterService.clearRosterSignups as any).mockResolvedValue({
      outcome: "cleared",
      rosterId: "roster-1",
      removedCount: 2,
    });
    const editedMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const settingsInteraction = {
      customId: "roster-post-settings:roster-1",
      values: ["clear_roster"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: false,
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostSettingsMenuInteraction(settingsInteraction, {} as any);

    expect(settingsInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
      }),
    );
    const panel = settingsInteraction.reply.mock.calls[0]?.[0] as any;
    expect(String(panel.embeds[0]?.toJSON?.().description ?? "")).toContain(
      "This will remove every signup from the roster.",
    );
    const panelButtons = panel.components[0]?.toJSON?.().components ?? [];
    expect(panelButtons.map((button: any) => button.custom_id ?? button.customId)).toEqual(
      expect.arrayContaining([
        "roster-post-clear:confirm:roster-1",
        "roster-post-clear:cancel:roster-1",
      ]),
    );

    const clearInteraction = {
      customId: "roster-post-clear:confirm:roster-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostClearButtonInteraction(clearInteraction, {} as any);

    expect(rosterService.clearRosterSignups).toHaveBeenCalledWith({
      rosterId: "roster-1",
      updatedByDiscordUserId: "111111111111111111",
    });
    expect(editedMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
      }),
    );
    expect(clearInteraction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Cleared 2 roster signups.",
        components: [],
      }),
    );
  });

  it("applies close, hide, and archive settings to the posted roster board", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    (rosterService.updateRosterLifecycleState as any).mockResolvedValue({
      outcome: "updated",
      rosterId: "roster-1",
      lifecycleState: "CLOSED",
    });
    (rosterService.updateRosterPostButtonMode as any).mockResolvedValue({
      rosterId: "roster-1",
      postButtonMode: "hidden",
    });
    const editedMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const baseInteraction = {
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: false,
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostSettingsMenuInteraction(
      { ...baseInteraction, customId: "roster-post-settings:roster-1", values: ["open_roster"] } as any,
      {} as any,
    );
    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState: "OPEN",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      expect.anything(),
      expect.anything(),
    );
    expect(editedMessage.edit).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.any(EmbedBuilder)] }));
    expect(baseInteraction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Roster opened.",
        embeds: [],
        components: [],
      }),
    );

    await handleRosterPostSettingsMenuInteraction(
      { ...baseInteraction, customId: "roster-post-settings:roster-1", values: ["close_roster"] } as any,
      {} as any,
    );
    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState: "CLOSED",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(editedMessage.edit).toHaveBeenCalledWith(expect.objectContaining({ embeds: [expect.any(EmbedBuilder)] }));

    await handleRosterPostSettingsMenuInteraction(
      { ...baseInteraction, customId: "roster-post-settings:roster-1", values: ["hide_buttons"] } as any,
      {} as any,
    );
    expect(rosterService.updateRosterPostButtonMode).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        postButtonMode: "hidden",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );

    await handleRosterPostSettingsMenuInteraction(
      { ...baseInteraction, customId: "roster-post-settings:roster-1", values: ["archive_mode"] } as any,
      {} as any,
    );
    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState: "ARCHIVED",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(rosterService.updateRosterPostButtonMode).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        postButtonMode: "archived",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
  });

  it("shows exactly which selected accounts are missing town hall data when roster add is blocked", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
      postedChannelId: null,
      postedMessageId: null,
      postedMessageUrl: null,
      postedAt: null,
      createdByDiscordUserId: "111111111111111111",
      updatedByDiscordUserId: "111111111111111111",
      createdAt: new Date("2026-04-20T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T00:00:00.000Z"),
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
      outcome: "townhall_unavailable",
      rosterId: "roster-1",
      groupKey: "confirmed",
      groupName: "Confirmed",
      requestedTags: ["#PQL0289", "#QGRJ2222"],
      linkedTags: ["#PQL0289", "#QGRJ2222"],
      createdTags: [],
      duplicateTags: [],
      missingLinkedTags: [],
      blockedTags: ["#PQL0289", "#QGRJ2222"],
      blockedAccounts: [
        { playerTag: "#PQL0289", playerName: "Alpha" },
        { playerTag: "#QGRJ2222", playerName: null },
      ],
    });

    const interaction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "add",
      group: "confirmed",
      players: "#PQL0289 #QGRJ2222",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Town hall data is unavailable for: Alpha `#PQL0289`, `#QGRJ2222`.",
    );
  });

  it("edits roster metadata and can refresh the posted roster from DB truth", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
    (rosterService.updateRoster as any).mockResolvedValue({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup (Updated)",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/New_York",
      displayTimezone: "America/New_York",
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
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup (Updated)"),
      components: [],
    });
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
      },
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    const editedMessage = {
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const deleteMessage = {
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const deleteChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(deleteMessage),
      },
    };
    (interactionClientFetchMock as any).mockResolvedValueOnce(rosterChannel);

    const editInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      name: "CWL Alpha Signup (Updated)",
      timezone: "America/New_York",
      displayTimezone: "America/New_York",
    }) as any;
    editInteraction.client.channels.fetch = interactionClientFetchMock;

    await Roster.run({} as any, editInteraction as any);

    expect(rosterService.updateRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        name: "CWL Alpha Signup (Updated)",
        timezone: "America/New_York",
        displayTimezone: "America/New_York",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(editedMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
      }),
    );
    expect(String(editInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("Updated roster CWL Alpha Signup (Updated).");

    (rosterService.updateRoster as any).mockResolvedValueOnce({
      id: "roster-1",
      guildId: "guild-1",
      rosterType: "CWL",
      rosterCategory: "signup",
      title: "CWL Alpha Signup (Alias)",
      clanTag: "#2QG2C08UP",
      startsAt: new Date("2026-04-20T00:00:00.000Z"),
      endsAt: null,
      timezone: "America/New_York",
      displayTimezone: "America/New_York",
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
    const titleAliasInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      title: "CWL Alpha Signup (Alias)",
    }) as any;
    titleAliasInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);

    await Roster.run({} as any, titleAliasInteraction as any);

    expect(rosterService.updateRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        name: "CWL Alpha Signup (Alias)",
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(String(titleAliasInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Updated roster CWL Alpha Signup (Alias).",
    );

    const conflictInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      name: "CWL Alpha Signup (Name)",
      title: "CWL Alpha Signup (Title)",
    }) as any;
    conflictInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);

    await Roster.run({} as any, conflictInteraction as any);

    expect(String(conflictInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Choose either name or title, not both.",
    );
    expect(rosterService.updateRoster).toHaveBeenCalledTimes(2);

    const refreshInteraction = makeInteraction({
      subcommand: "refresh",
      roster: "roster-1",
    }) as any;
    refreshInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);
    await Roster.run({} as any, refreshInteraction as any);
    expect(rosterService.findGuildRosterById).toHaveBeenCalledWith({
      guildId: "guild-1",
      rosterId: "roster-1",
    });
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith("roster-1", null, expect.anything());
    expect(String(refreshInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("Refreshed the posted roster for CWL Alpha Signup.");

    (rosterService.deleteRoster as any).mockResolvedValue({
      outcome: "deleted",
      roster: {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "CWL Alpha Signup (Updated)",
        clanTag: "#2QG2C08UP",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/New_York",
        displayTimezone: "America/New_York",
        lifecycleState: "OPEN",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
      },
    });
    const deleteInteraction = makeInteraction({
      subcommand: "delete",
      roster: "roster-1",
    }) as any;
    deleteInteraction.client.channels.fetch = vi.fn().mockResolvedValue(deleteChannel);
    await Roster.run({} as any, deleteInteraction as any);
    expect(rosterService.findGuildRosterById).toHaveBeenCalledWith({
      guildId: "guild-1",
      rosterId: "roster-1",
    });
    expect(rosterService.deleteRoster).toHaveBeenCalledWith({
      rosterId: "roster-1",
    });
    expect(deleteMessage.delete).toHaveBeenCalled();
    expect(String(deleteInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Deleted roster CWL Alpha Signup (Updated) after removing its posted Discord message and persisted signup data.",
    );
  });

  it("keeps the roster intact if the posted message cannot be removed before delete", async () => {
    (rosterService.findGuildRosterById as any).mockResolvedValue({
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
    const failingMessage = {
      delete: vi.fn().mockRejectedValue(new Error("discord delete failed")),
    };
    const failingChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(failingMessage),
      },
    };
    const failedDeleteInteraction = makeInteraction({
      subcommand: "delete",
      roster: "roster-1",
    }) as any;
    failedDeleteInteraction.client.channels.fetch = vi.fn().mockResolvedValue(failingChannel);

    await Roster.run({} as any, failedDeleteInteraction as any);

    expect(rosterService.deleteRoster).not.toHaveBeenCalled();
    expect(String(failedDeleteInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "I couldn't remove the posted Discord message, so the roster was left intact.",
    );
  });

  it.each(["report", "readiness"] as const)(
    "renders the roster readiness view for /roster %s",
    async (subcommand) => {
      (rosterService.findGuildRosterById as any).mockResolvedValue({
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
        "CWL Alpha Signup\nUnregistered members:\n- Bravo `#QGRJ2222` <@222222222222222222>",
      );

      const interaction = makeInteraction({
        subcommand,
        roster: "roster-1",
      }) as any;

      await Roster.run({} as any, interaction as any);

      expect(rosterService.findGuildRosterById).toHaveBeenCalledWith({
        guildId: "guild-1",
        rosterId: "roster-1",
      });
      expect(rosterService.buildRosterManagerReadinessText).toHaveBeenCalledWith({
        rosterId: "roster-1",
      });
      expect(getEditedDescription(interaction)).toContain("Unregistered members:");
    },
  );
});
