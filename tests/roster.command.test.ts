import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  trackedClan: {
    findMany: vi.fn(),
  },
  raidTrackedClan: {
    findMany: vi.fn(),
  },
  cwlTrackedClan: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
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
  handleRosterReportPingButtonInteraction,
  handleRosterPingActionButtonInteraction,
  handleRosterPostRefreshButtonInteraction,
  handleRosterPostSettingsButtonInteraction,
  handleRosterPostSettingsActionButtonInteraction,
  handleRosterPostSettingsMenuInteraction,
} from "../src/commands/Roster";
import { rosterService } from "../src/services/RosterService";
import { rosterExportService } from "../src/services/RosterExportService";
import { rosterWeightService } from "../src/services/RosterWeightService";
import * as playerLinkService from "../src/services/PlayerLinkService";

type RosterSubcommand =
  | "create"
  | "list"
  | "post"
  | "ping"
  | "manage"
  | "edit"
  | "delete"
  | "report"
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
  message?: string | null;
  group?: string | null;
  targetRoster?: string | null;
  targetGroup?: string | null;
  players?: string | null;
  pingOption?: string | null;
  userId?: string | null;
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
    memberPermissions: {
      has: vi.fn().mockReturnValue(true),
    },
    options: {
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clan ?? null;
        if (name === "category") return input.category ?? null;
        if (name === "name") return input.name ?? null;
        if (name === "title") return input.title ?? null;
        if (name === "roster") return input.roster ?? null;
        if (name === "action") return input.action ?? null;
        if (name === "message") return input.message ?? null;
        if (name === "target_roster") return input.targetRoster ?? null;
        if (name === "target_group") return input.targetGroup ?? null;
        if (name === "group") return input.group ?? null;
        if (name === "players") return input.players ?? null;
        if (name === "ping_option") return input.pingOption ?? null;
        if (name === "timezone") return input.timezone ?? null;
        if (name === "display-timezone") return input.displayTimezone ?? null;
        if (name === "start_time") return input.startTime ?? null;
        if (name === "end_time") return input.endTime ?? null;
        if (name === "roster_role") return input.rosterRole ?? null;
        if (name === "sort_by") return input.sortBy ?? null;
        if (name === "player") return input.player ?? null;
        return null;
      }),
      getUser: vi.fn((name: string) => {
        if (name !== "user" || !input.userId) return null;
        return {
          id: input.userId,
          bot: false,
          username: "selected-user",
        };
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

function makeAutocompleteInteraction(input: {
  focusedName: string;
  focusedValue?: string;
  subcommand: RosterSubcommand;
  roster?: string | null;
  action?: string | null;
  group?: string | null;
  targetRoster?: string | null;
  targetGroup?: string | null;
  userId?: string | null;
  guildMembers?: Array<{
    id: string;
    displayName: string;
    username: string;
    bot?: boolean;
  }>;
}) {
  const members = new Map(
    (input.guildMembers ?? []).map((member) => [
      member.id,
      {
        id: member.id,
        displayName: member.displayName,
        user: {
          id: member.id,
          username: member.username,
          bot: member.bot ?? false,
        },
      },
    ]),
  );

  return {
    user: { id: "111111111111111111" },
    guildId: "guild-1",
    guild: { members: { cache: members } },
    inGuild: () => true,
    respond: vi.fn().mockResolvedValue(undefined),
    options: {
      getFocused: vi.fn(() => ({ name: input.focusedName, value: input.focusedValue ?? "" })),
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "roster") return input.roster ?? null;
        if (name === "action") return input.action ?? null;
        if (name === "group") return input.group ?? null;
        if (name === "target_roster") return input.targetRoster ?? null;
        if (name === "target_group") return input.targetGroup ?? null;
        return null;
      }),
      getUser: vi.fn((name: string) => {
        if (name !== "user" || !input.userId) return null;
        return {
          id: input.userId,
          bot: false,
          username: "selected-user",
        };
      }),
    },
  };
}

function getEditedEmbed(interaction: any): any {
  const payload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
  return payload?.embeds?.[0]?.toJSON?.() ?? null;
}

function getEditedButtonPayload(interaction: any): any[] {
  const payload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
  return Array.isArray(payload?.components) ? payload.components : [];
}

function makeRosterRefreshPayload(refreshDisabled: boolean, title: string) {
  return {
    embed: new EmbedBuilder().setTitle(title),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("roster-post-action:refresh:roster-1")
          .setLabel("Refresh")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(refreshDisabled),
      ),
    ],
  };
}

function makeRosterEmojiClient() {
  const makeEmoji = (name: string, rendered: string) => ({
    id: `${name}-id`,
    name,
    animated: false,
    toString: () => rendered,
  });

  const emojis = new Map(
    [
      ["yes", makeEmoji("yes", "<:yes:901>")],
      ["no", makeEmoji("no", "<:no:902>")],
      ...Array.from({ length: 18 }, (_, index) => {
        const name = `th${index + 1}`;
        return [name, makeEmoji(name, `<:${name}:${index + 1001}>`)] as const;
      }),
    ],
  );

  return {
    application: {
      fetch: vi.fn().mockResolvedValue(undefined),
      emojis: {
        fetch: vi.fn().mockResolvedValue(emojis),
      },
    },
  } as any;
}

describe("/roster command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    interactionClientFetchMock.mockReset();
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.trackedClan.findMany.mockReset();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.raidTrackedClan.findMany.mockReset();
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);

    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    prismaMock.cwlTrackedClan.findMany.mockReset();
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
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
    vi.spyOn(rosterService, "createRosterManagerUserSelectionPanel");
    vi.spyOn(rosterService, "createRosterPingSelectionPanel");
    vi.spyOn(rosterService, "updateRosterSelectionPanel");
    vi.spyOn(rosterService, "confirmRosterSelectionPanel");
    vi.spyOn(rosterService, "confirmRosterPingSelectionPanel");
    vi.spyOn(rosterService, "clearRosterSignups");
    vi.spyOn(rosterService, "getRosterView");
    vi.spyOn(rosterService, "getRosterRoleSyncTargets").mockResolvedValue(null as any);
    vi.spyOn(rosterService, "addRosterSignupsForManager");
    vi.spyOn(rosterService, "moveRosterSignups");
    vi.spyOn(rosterService, "removeRosterSignupsAsManager");
    vi.spyOn(rosterService, "changeRosterSignups");
    vi.spyOn(rosterWeightService, "setManualWeightForRoster");
    vi.spyOn(rosterExportService, "createRosterExport");
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue(
      makeRosterRefreshPayload(false, "Roster Signup"),
    );
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue(
      makeRosterRefreshPayload(false, "Roster Signup"),
    );
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

  it("includes the original post link when refreshing an already-posted roster", async () => {
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
        postedMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
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
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
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
    const editedMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const interaction = makeInteraction({
      subcommand: "post",
      roster: "roster-1",
    }) as any;
    interaction.channel = {
      isTextBased: () => true,
      send: vi.fn(),
    };
    interaction.client = {
      channels: {
        fetch: vi.fn().mockResolvedValue(rosterChannel),
      },
    };

    await Roster.run({} as any, interaction as any);

    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      null,
      expect.objectContaining({
        discordDisplayNamesByUserId: expect.any(Map),
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Original post: [Open posted roster](https://discord.com/channels/guild-1/channel-1/message-1)",
    );
  });

  it("shows roster list metadata for managers", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([{ name: "CWL Alpha", tag: "#2QG2C08UP" }]);
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
      {
        id: "roster-2",
        guildId: "guild-1",
        rosterType: "FWA",
        rosterCategory: "signup",
        title: "FWA Beta Signup",
        clanTag: null,
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        lifecycleState: "CLOSED",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        groupCount: 1,
        signupCount: 2,
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
    expect(String(embed?.fields?.[0]?.value ?? "")).toContain(
      "Posted: Yes ([Open posted roster](https://discord.com/channels/guild-1/channel-1/message-1))",
    );
    expect(String(embed?.fields?.[0]?.value ?? "")).toContain("Clan: CWL Alpha (`#2QG2C08UP`)");
    expect(String(embed?.fields?.[0]?.value ?? "")).toContain("Groups: 2 | Signups: 5");
    expect(String(embed?.fields?.[1]?.value ?? "")).toContain("Posted: No");
    expect(String(embed?.fields?.[1]?.value ?? "")).toContain("Clan: none");
  });

  it("passes the selected Discord user picker id through roster list filters", async () => {
    (rosterService.listGuildRosters as any).mockResolvedValue([]);

    const interaction = makeInteraction({
      subcommand: "list",
      userId: "222222222222222222",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.listGuildRosters).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        name: null,
        user: "222222222222222222",
        player: null,
        clan: null,
      }),
    );
  });

  it("routes roster manage actions to the existing add, move, remove, change roster, and lifecycle helpers", async () => {
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
    (rosterService.changeRosterSignups as any).mockResolvedValue({
      outcome: "changed",
      sourceRosterId: "roster-1",
      sourceRosterTitle: "Source Roster",
      targetRosterId: "roster-2",
      targetRosterTitle: "Target Roster",
      targetRosterClanTag: "#2QG2C08UP",
      targetRosterClanName: null,
      targetGroupKey: null,
      targetGroupName: null,
      requestedTags: ["#PQL0289", "#QGRJ2222"],
      movedTags: ["#PQL0289", "#QGRJ2222"],
      movedAccounts: [
        {
          playerTag: "#PQL0289",
          playerName: "Alpha",
          targetGroupKey: "confirmed",
          targetGroupName: "Confirmed",
        },
        {
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          targetGroupKey: "substitute",
          targetGroupName: "Substitute",
        },
      ],
      duplicateTags: [],
      missingTags: [],
      blockedTags: [],
      blockedAccounts: [],
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
        bypassEligibility: true,
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

    const changeInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "change_roster",
      targetRoster: "roster-2",
      targetGroup: "substitute",
      players: "#PQL0289 #QGRJ2222",
    }) as any;
    (rosterService.findGuildRosterById as any).mockImplementation(({ rosterId }: { rosterId: string }) =>
      Promise.resolve(
        rosterId === "roster-1"
          ? {
              id: "roster-1",
              guildId: "guild-1",
              rosterType: "CWL",
              rosterCategory: "signup",
              title: "Source Roster",
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
            }
          : {
              id: "roster-2",
              guildId: "guild-1",
              rosterType: "CWL",
              rosterCategory: "signup",
              title: "Target Roster",
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
            },
      ),
    );
    await Roster.run({} as any, changeInteraction as any);
    expect(rosterService.changeRosterSignups).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRosterId: "roster-1",
        targetRosterId: "roster-2",
        targetGroupKey: "substitute",
        playerTags: ["#PQL0289", "#QGRJ2222"],
        bypassEligibility: true,
      }),
    );
    expect(String(changeInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Moved Alpha `#PQL0289` to Target Roster - Confirmed.",
    );

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

  it("refreshes the posted roster after manager add before returning the add summary", async () => {
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
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterService.addRosterSignupsForManager as any).mockResolvedValue({
      outcome: "created",
      rosterId: "roster-1",
      groupKey: "confirmed",
      groupName: "Confirmed",
      requestedTags: ["#PQL0289"],
      linkedTags: ["#PQL0289"],
      createdTags: ["#PQL0289"],
      createdAccounts: [{ playerTag: "#PQL0289", playerName: "Alpha" }],
      duplicateTags: [],
      missingLinkedTags: [],
    });
    const editedMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const interaction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "add",
      group: "confirmed",
      players: "#PQL0289",
    }) as any;
    interaction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);

    await Roster.run({} as any, interaction as any);

    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      null,
      expect.objectContaining({
        refreshButtonDisabled: false,
      }),
    );
    expect(editedMessage.edit).toHaveBeenCalled();
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Signed up #PQL0289",
    );
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
      "add_user",
      "remove_user",
      "close_roster",
      "clear_roster",
      "hide_buttons",
      "archive_mode",
      "unregistered_members",
      "missing_members",
    ]);
    expect(optionValues).not.toContain("open_roster");
  });

  it.each(["add_user", "remove_user"] as const)(
    "opens the roster user panel when Settings -> %s is selected",
    async (action) => {
      (rosterService.createRosterManagerUserSelectionPanel as any).mockResolvedValue({
        outcome: "ready",
        panel: {
          sessionId: "session-1",
          mode: action,
          embed: new EmbedBuilder().setTitle(action === "add_user" ? "Adding Roster Users" : "Removing Roster Users"),
          components: [],
          selectedTags: [],
        },
      });
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
      const interaction = {
        customId: "roster-post-settings:roster-1",
        values: [action],
        user: { id: "111111111111111111" },
        guildId: "guild-1",
        inGuild: () => true,
        memberPermissions: {
          has: vi.fn().mockReturnValue(true),
        },
        reply: vi.fn().mockResolvedValue(undefined),
      } as any;

      await handleRosterPostSettingsMenuInteraction(interaction, {} as any);

      expect(rosterService.createRosterManagerUserSelectionPanel).toHaveBeenCalledWith({
        rosterId: "roster-1",
        discordUserId: "111111111111111111",
        mode: action,
      });
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          ephemeral: true,
          embeds: [expect.any(EmbedBuilder)],
          components: [],
        }),
      );
    },
  );

  it.each([
    {
      action: "add_user" as const,
      customId: "roster-post-users:action:confirm:session-1",
      result: {
        outcome: "created" as const,
        rosterId: "roster-1",
        groupKey: "confirmed",
        groupName: "Confirmed",
        requestedTags: ["#PQL0289", "#QGRJ2222"],
        linkedTags: ["#PQL0289", "#QGRJ2222"],
        createdTags: ["#PQL0289", "#QGRJ2222"],
        createdAccounts: [
          { playerTag: "#PQL0289", playerName: "Alpha" },
          { playerTag: "#QGRJ2222", playerName: "Bravo" },
        ],
        duplicateTags: [],
        missingLinkedTags: [],
      },
      expectedContent:
        "Added Alpha (#PQL0289) to CWL Alpha Signup - CWL Alpha\nAdded Bravo (#QGRJ2222) to CWL Alpha Signup - CWL Alpha",
    },
    {
      action: "remove_user" as const,
      customId: "roster-post-users:action:confirm:session-2",
      result: {
        outcome: "removed" as const,
        rosterId: "roster-1",
        removedTags: ["#PQL0289", "#QGRJ2222"],
        removedAccounts: [
          { playerTag: "#PQL0289", playerName: "Alpha" },
          { playerTag: "#QGRJ2222", playerName: "Bravo" },
        ],
        ignoredTags: [],
        notOwnedTags: [],
      },
      expectedContent:
        "Removed Alpha (#PQL0289) from CWL Alpha Signup - CWL Alpha\nRemoved Bravo (#QGRJ2222) from CWL Alpha Signup - CWL Alpha",
    },
  ])("confirms Settings -> %s with ephemeral success feedback", async ({ action, customId, result, expectedContent }) => {
    (rosterService.confirmRosterSelectionPanel as any).mockResolvedValue({
      outcome: action,
      result,
    });
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
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

    const interaction = {
      customId,
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostSettingsActionButtonInteraction(interaction);

    expect(rosterService.confirmRosterSelectionPanel).toHaveBeenCalledWith({
      sessionId: customId.split(":").at(-1),
      discordUserId: "111111111111111111",
      cocService: null,
    });
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      null,
      expect.objectContaining({
        refreshButtonDisabled: false,
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toBe(expectedContent);
  });

  it("opens the roster ping preview with the requested target set", async () => {
    (rosterService.createRosterPingSelectionPanel as any).mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-1",
        embed: new EmbedBuilder().setTitle("Ping preview for CWL Alpha Signup"),
        components: [],
        targetCount: 2,
      },
    });
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

    const interaction = makeInteraction({
      subcommand: "ping",
      roster: "roster-1",
      message: "Good luck tonight!",
      pingOption: "everyone",
      group: "confirmed",
    }) as any;

    const cocService = {} as any;
    await Roster.run({} as any, interaction as any, cocService);

    expect(rosterService.createRosterPingSelectionPanel).toHaveBeenCalledWith({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
      pingOption: "everyone",
      groupKey: "confirmed",
      message: "Good luck tonight!",
      cocService,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("posts the roster ping message once the preview confirm button is pressed", async () => {
    (rosterService.confirmRosterPingSelectionPanel as any).mockResolvedValue({
      outcome: "posted",
      rosterId: "roster-1",
      targetCount: 2,
      messageContents: [
        "[CWL Alpha Signup - CWL Alpha](https://link.example)\nAlpha (#PQL0289) <@222222222222222222>",
        "[CWL Alpha Signup - CWL Alpha](https://link.example)\nBravo (#QGRJ2222) <@333333333333333333>",
      ],
    });

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "roster-ping:confirm:session-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      channel: {
        isTextBased: () => true,
        send: sendMock,
      },
    } as any;

    await handleRosterPingActionButtonInteraction(interaction);

    expect(rosterService.confirmRosterPingSelectionPanel).toHaveBeenCalledWith({
      sessionId: "session-1",
      discordUserId: "111111111111111111",
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]?.[0]?.content).toContain("Alpha (#PQL0289)");
    expect(sendMock.mock.calls[1]?.[0]?.content).toContain("Bravo (#QGRJ2222)");
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toBe(
      "Posted ping for 2 players.",
    );
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
    const payload = interaction.reply.mock.calls[0]?.[0] as any;
    const columnMenu = payload.components[0]?.toJSON?.().components?.[0];
    expect(columnMenu?.options?.map((option: any) => option.value)).toEqual(
      expect.arrayContaining(["townhall_icons", "index"]),
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
      followUp: vi.fn().mockResolvedValue(undefined),
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
    expect(interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      (rosterService.findGuildRosterById as any).mock.invocationCallOrder[0],
    );
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
      followUp: vi.fn().mockResolvedValue(undefined),
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
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      (rosterService.findGuildRosterById as any).mock.invocationCallOrder[0],
    );
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

  it("acks before rejecting invalid roster customize column selections", async () => {
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
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "roster-post-customize:columns:roster-1",
      values: [],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferUpdate,
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      followUp,
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    } as any;

    await handleRosterPostCustomizeMenuInteraction(interaction, {} as any);

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: "Choose at least one column to customize.",
      }),
    );
    expect(rosterService.updateRoster).not.toHaveBeenCalled();
  });

  it("refreshes the posted roster from the service-owned current-clan refresh path", async () => {
    (rosterService.buildRosterSignupPayload as any).mockResolvedValueOnce(
      makeRosterRefreshPayload(true, "CWL Alpha Signup (Loading)"),
    );
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValueOnce(
      makeRosterRefreshPayload(false, "CWL Alpha Signup (Refreshed)"),
    );
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
      (rosterService.buildRosterSignupPayload as any).mock.invocationCallOrder[0],
    );
    expect(rosterService.buildRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      null,
      expect.objectContaining({
        emojiClient: interaction.client,
        refreshButtonDisabled: true,
      }),
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      expect.anything(),
      expect.objectContaining({
        emojiClient: interaction.client,
        refreshButtonDisabled: false,
      }),
    );
    expect(editReply).toHaveBeenCalledTimes(2);
    const loadingPayload = editReply.mock.calls[0]?.[0] as any;
    const finalPayload = editReply.mock.calls.at(-1)?.[0] as any;
    expect(loadingPayload).toEqual(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
      }),
    );
    expect(loadingPayload.components[0]?.toJSON?.().components?.[0]?.disabled).toBe(true);
    expect(finalPayload).toEqual(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
      }),
    );
    expect(finalPayload.components[0]?.toJSON?.().components?.[0]?.disabled).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("acknowledges the refresh button before reporting a missing roster", async () => {
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue(null);
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
    expect(rosterService.buildRosterSignupPayload).toHaveBeenCalledWith("roster-1", null, expect.anything());
    expect(rosterService.refreshRosterSignupPayload).not.toHaveBeenCalled();
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
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue(
      makeRosterRefreshPayload(true, "CWL Alpha Signup (Loading)"),
    );
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

    const titleOnlyInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      title: "CWL Alpha Signup (Alias)",
    }) as any;
    titleOnlyInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);

    await Roster.run({} as any, titleOnlyInteraction as any);

    expect(String(titleOnlyInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Provide at least one roster field to edit.",
    );
    expect(rosterService.updateRoster).toHaveBeenCalledTimes(1);

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
    expect(rosterService.buildRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      null,
      expect.objectContaining({
        refreshButtonDisabled: true,
      }),
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      null,
      expect.objectContaining({
        refreshButtonDisabled: false,
      }),
    );
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

  it("renders the roster report view and includes a ping-roster button", async () => {
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
      "State: Open\nClan: CWL Alpha `#2QG2C08UP` ([Open in-game](<https://link.clashofclans.com/en?action=OpenClanProfile&tag=2QG2C08UP>))\n**Groups**\n**Confirmed** (1)\n- <:th15:1001> Alpha <:yes:901>",
    );
    const cocService = {} as any;

    const interaction = makeInteraction({
      subcommand: "report",
      roster: "roster-1",
    }) as any;
    interaction.client = makeRosterEmojiClient();

    await Roster.run({} as any, interaction as any, cocService);

    expect(rosterService.findGuildRosterById).toHaveBeenCalledWith({
      guildId: "guild-1",
      rosterId: "roster-1",
    });
    expect(rosterService.buildRosterManagerReadinessText).toHaveBeenCalledWith({
      rosterId: "roster-1",
      cocService,
      emojiClient: interaction.client,
    });
    const embed = getEditedEmbed(interaction);
    expect(String(embed?.title ?? "")).toBe("CWL Alpha Signup Report");
    expect(String(embed?.description ?? "")).toContain("**Groups**");
    expect(String(embed?.description ?? "")).toContain("**Confirmed**");
    expect(String(embed?.description ?? "")).not.toContain("CWL Alpha Signup Report");
    const buttons = getEditedButtonPayload(interaction);
    const button = buttons[0]?.toJSON?.()?.components?.[0];
    expect(String(button?.label ?? "")).toBe("Ping roster");
    expect(String(button?.custom_id ?? button?.customId ?? "")).toContain("roster-report:ping:roster-1");
  });

  it("opens the roster ping preview from the report button using the same ping flow", async () => {
    (rosterService.createRosterPingSelectionPanel as any).mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-1",
        embed: new EmbedBuilder().setTitle("Ping preview"),
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("roster-ping:confirm:session-1")
              .setLabel("Confirm and ping")
              .setStyle(ButtonStyle.Success),
          ),
        ],
        targetCount: 1,
      },
    });

    const interaction = {
      customId: "roster-report:ping:roster-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      member: {
        roles: {
          cache: new Map(),
        },
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      inGuild: () => true,
    } as any;

    await handleRosterReportPingButtonInteraction(interaction, {} as any);

    expect(rosterService.createRosterPingSelectionPanel).toHaveBeenCalledWith({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
      pingOption: "everyone",
      cocService: {},
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
      }),
    );
  });

  it("autocompletes roster groups from the selected roster only", async () => {
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
      },
      groups: [
        { id: "group-2", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
        { id: "group-1", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
      ],
      signups: [],
      clanDisplayName: null,
      clanLeagueLabel: null,
      totalSignupCount: 0,
    });

    const interaction = makeAutocompleteInteraction({
      focusedName: "group",
      focusedValue: "con",
      subcommand: "manage",
      roster: "roster-1",
    }) as any;

    await Roster.autocomplete(interaction);

    expect(rosterService.getRosterView).toHaveBeenCalledWith("roster-1");
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Confirmed (confirmed)", value: "confirmed" },
    ]);
  });

  it("scopes roster manage player autocomplete by roster, action, and group context", async () => {
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        lifecycleState: "OPEN",
      },
      groups: [
        { id: "group-confirmed", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
        { id: "group-substitute", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
      ],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
        {
          id: "signup-2",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
        {
          id: "signup-3",
          rosterId: "roster-1",
          groupId: "group-substitute",
          playerTag: "#CUV02898",
          playerName: "Charlie",
          discordUserId: "333333333333333333",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "substitute" },
        },
      ],
      clanDisplayName: null,
      clanLeagueLabel: null,
      totalSignupCount: 3,
    });
    vi.spyOn(playerLinkService, "listPlayerLinksForDiscordUser").mockResolvedValue([
      { playerTag: "#PYLQ0289", linkedAt: new Date("2026-04-01T00:00:00.000Z"), linkedName: "Alpha Prime" },
      { playerTag: "#QGRJ2222", linkedAt: new Date("2026-04-02T00:00:00.000Z"), linkedName: null },
      { playerTag: "#VJQ28888", linkedAt: new Date("2026-04-03T00:00:00.000Z"), linkedName: "Delta" },
    ] as any);
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
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        groupCount: 2,
        signupCount: 3,
      },
      {
        id: "roster-2",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "Target Roster",
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
        groupCount: 1,
        signupCount: 1,
      },
    ] as any);

    const noRosterInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      action: "remove",
    }) as any;
    await Roster.autocomplete(noRosterInteraction);
    expect(noRosterInteraction.respond).toHaveBeenCalledWith([]);

    const moveMissingGroupInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
    }) as any;
    await Roster.autocomplete(moveMissingGroupInteraction);
    expect(moveMissingGroupInteraction.respond).toHaveBeenCalledWith([]);

    const moveInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
      group: "confirmed",
    }) as any;
    await Roster.autocomplete(moveInteraction);
    expect(moveInteraction.respond).toHaveBeenCalledWith([
      { name: "Charlie (#CUV02898)", value: "#CUV02898" },
    ]);

    const invalidMoveInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
      group: "not-real",
    }) as any;
    await Roster.autocomplete(invalidMoveInteraction);
    expect(invalidMoveInteraction.respond).toHaveBeenCalledWith([]);

    const removeInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "remove",
    }) as any;
    await Roster.autocomplete(removeInteraction);
    expect(removeInteraction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#PYLQ0289)", value: "#PYLQ0289" },
      { name: "Bravo (#QGRJ2222)", value: "#QGRJ2222" },
      { name: "Charlie (#CUV02898)", value: "#CUV02898" },
    ]);

    const addInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "add",
    }) as any;
    await Roster.autocomplete(addInteraction);
    expect(playerLinkService.listPlayerLinksForDiscordUser).toHaveBeenCalledWith({
      discordUserId: "111111111111111111",
    });
    expect(addInteraction.respond).toHaveBeenCalledWith([
      { name: "Delta (#VJQ28888)", value: "#VJQ28888" },
    ]);

    const changeTargetInteraction = makeAutocompleteInteraction({
      focusedName: "target_roster",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
    }) as any;
    await Roster.autocomplete(changeTargetInteraction);
    expect(rosterService.listGuildRosters).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        name: "",
      }),
    );
    expect(changeTargetInteraction.respond).toHaveBeenCalledWith([
      expect.objectContaining({ value: expect.any(String) }),
    ]);

    const changeTargetGroupInteraction = makeAutocompleteInteraction({
      focusedName: "target_group",
      focusedValue: "con",
      subcommand: "manage",
      roster: "roster-1",
      targetRoster: "roster-2",
    }) as any;
    (rosterService.getRosterView as any).mockResolvedValueOnce({
      roster: {
        id: "roster-2",
        lifecycleState: "OPEN",
      },
      groups: [
        { id: "group-confirmed", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
        { id: "group-substitute", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
      ],
      signups: [],
      clanDisplayName: null,
      clanLeagueLabel: null,
      totalSignupCount: 0,
    });
    await Roster.autocomplete(changeTargetGroupInteraction);
    expect(changeTargetGroupInteraction.respond).toHaveBeenCalledWith([
      { name: "Confirmed (confirmed)", value: "confirmed" },
    ]);

    const changeInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "change_roster",
      targetRoster: "roster-2",
    }) as any;
    (rosterService.getRosterView as any).mockResolvedValueOnce({
      roster: {
        id: "roster-1",
        lifecycleState: "OPEN",
      },
      groups: [
        { id: "group-confirmed", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
        { id: "group-substitute", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
      ],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
        {
          id: "signup-2",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
        {
          id: "signup-3",
          rosterId: "roster-1",
          groupId: "group-substitute",
          playerTag: "#CUV02898",
          playerName: "Charlie",
          discordUserId: "333333333333333333",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "substitute" },
        },
      ],
      clanDisplayName: null,
      clanLeagueLabel: null,
      totalSignupCount: 3,
    });
    (rosterService.getRosterView as any).mockResolvedValueOnce({
      roster: {
        id: "roster-2",
        lifecycleState: "OPEN",
      },
      groups: [
        { id: "group-confirmed", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
        { id: "group-substitute", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
      ],
      signups: [
        {
          id: "signup-4",
          rosterId: "roster-2",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
      ],
      clanDisplayName: null,
      clanLeagueLabel: null,
      totalSignupCount: 1,
    });
    await Roster.autocomplete(changeInteraction);
    expect(changeInteraction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#PYLQ0289)", value: "#PYLQ0289" },
      { name: "Charlie (#CUV02898)", value: "#CUV02898" },
    ]);

    (rosterService.getRosterView as any).mockResolvedValueOnce({
      roster: {
        id: "roster-1",
        lifecycleState: "OPEN",
      },
      groups: [
        { id: "group-confirmed", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
        { id: "group-substitute", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
      ],
      signups: [
        {
          id: "signup-1",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#PYLQ0289",
          playerName: "Alpha",
          discordUserId: "111111111111111111",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
        {
          id: "signup-2",
          rosterId: "roster-1",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
        {
          id: "signup-3",
          rosterId: "roster-1",
          groupId: "group-substitute",
          playerTag: "#CUV02898",
          playerName: "Charlie",
          discordUserId: "333333333333333333",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "substitute" },
        },
      ],
      clanDisplayName: null,
      clanLeagueLabel: null,
      totalSignupCount: 3,
    });
    (rosterService.getRosterView as any).mockResolvedValueOnce({
      roster: {
        id: "roster-2",
        lifecycleState: "OPEN",
      },
      groups: [
        { id: "group-confirmed", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
        { id: "group-substitute", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
      ],
      signups: [
        {
          id: "signup-4",
          rosterId: "roster-2",
          groupId: "group-confirmed",
          playerTag: "#QGRJ2222",
          playerName: "Bravo",
          discordUserId: "222222222222222222",
          signedUpAt: new Date("2026-04-01T00:00:00.000Z"),
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          group: { key: "confirmed" },
        },
      ],
      clanDisplayName: null,
      clanLeagueLabel: null,
      totalSignupCount: 1,
    });
    const changeUserInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "change_roster",
      targetRoster: "roster-2",
      userId: "111111111111111111",
    }) as any;
    await Roster.autocomplete(changeUserInteraction);
    expect(changeUserInteraction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#PYLQ0289)", value: "#PYLQ0289" },
    ]);
  });

  it("autocompletes roster picker labels with clan name between roster name and clan tag", async () => {
    (rosterService.listGuildRosters as any).mockResolvedValue([
      {
        id: "roster-1",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "Roster One",
        clanTag: "#9GLGQCCU",
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
        groupCount: 0,
        signupCount: 0,
      },
      {
        id: "roster-2",
        guildId: "guild-1",
        rosterType: "FWA",
        rosterCategory: "signup",
        title: "Roster Two",
        clanTag: "#2RVGJYLC0",
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        lifecycleState: "ARCHIVED",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        groupCount: 0,
        signupCount: 0,
      },
      {
        id: "roster-3",
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        title: "Roster Three",
        clanTag: null,
        startsAt: new Date("2026-04-20T00:00:00.000Z"),
        endsAt: null,
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        lifecycleState: "CLOSED",
        postedChannelId: null,
        postedMessageId: null,
        postedMessageUrl: null,
        postedAt: null,
        createdByDiscordUserId: "111111111111111111",
        updatedByDiscordUserId: "111111111111111111",
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        groupCount: 0,
        signupCount: 0,
      },
    ]);
    prismaMock.trackedClan.findMany.mockResolvedValue([{ name: "Alpha Clan", tag: "#9GLGQCCU" }]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);

    const interaction = makeAutocompleteInteraction({
      focusedName: "roster",
      focusedValue: "",
      subcommand: "manage",
    }) as any;

    await Roster.autocomplete(interaction);

    expect(rosterService.listGuildRosters).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        name: "",
      }),
    );
    expect(interaction.respond).toHaveBeenCalledWith([
      {
        name: "Roster One • Alpha Clan • #9GLGQCCU • Open",
        value: "roster-1",
        description: expect.any(String),
      },
      {
        name: "Roster Two • #2RVGJYLC0 • Archived",
        value: "roster-2",
        description: expect.any(String),
      },
      {
        name: "Roster Three • Closed",
        value: "roster-3",
        description: expect.any(String),
      },
    ]);
  });

  it("autocompletes tracked clans across FWA, raid, and CWL sources without duplicates", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { name: "Alpha FWA", tag: "#9GLGQCCU" },
      { name: null, tag: "#2QG2C08UP" },
    ]);
    prismaMock.raidTrackedClan.findMany.mockResolvedValue([
      { name: "Alpha Raid", clanTag: "9GLGQCCU" },
      { name: "Raid Beta", clanTag: "2RVGJYLC0" },
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { name: "Alpha CWL", tag: "#9GLGQCCU" },
      { name: "CWL Gamma", tag: "#2QG2C08UP" },
      { name: "CWL Gamma Duplicate", tag: "#2QG2C08UP" },
    ]);

    const interaction = makeAutocompleteInteraction({
      focusedName: "clan",
      focusedValue: "",
      subcommand: "edit",
    }) as any;

    await Roster.autocomplete(interaction);

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    });
    expect(prismaMock.raidTrackedClan.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
      select: { name: true, clanTag: true },
    });
    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalledWith({
      where: { season: expect.any(String) },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { name: true, tag: true },
    });
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha FWA (#9GLGQCCU)", value: "#9GLGQCCU" },
      { name: "CWL Gamma (#2QG2C08UP)", value: "#2QG2C08UP" },
      { name: "Raid Beta (#2RVGJYLC0)", value: "#2RVGJYLC0" },
    ]);
  });

});
