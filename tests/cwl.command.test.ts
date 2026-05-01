import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  cwlTrackedClan: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Cwl } from "../src/commands/Cwl";
import { handleCwlRotationImportButtonInteraction } from "../src/commands/Cwl";
import { handleCwlRotationImportSelectMenuInteraction } from "../src/commands/Cwl";
import { handleCwlRotationShowButtonInteraction } from "../src/commands/Cwl";
import { handleCwlRotationShowSelectMenuInteraction } from "../src/commands/Cwl";
import { handleRosterRemoveButtonInteraction } from "../src/commands/Cwl";
import { handleRosterSelectionActionButtonInteraction } from "../src/commands/Cwl";
import { handleRosterSelectionMenuInteraction } from "../src/commands/Cwl";
import { handleRosterSignupButtonInteraction } from "../src/commands/Cwl";
import {
  cwlRotationSheetService,
  type CwlRotationSheetImportPreview,
} from "../src/services/CwlRotationSheetService";
import { cwlRotationService } from "../src/services/CwlRotationService";
import { cwlStateService } from "../src/services/CwlStateService";
import { rosterService } from "../src/services/RosterService";
import { emojiResolverService } from "../src/services/emoji/EmojiResolverService";

function makeInteraction(input: {
  group?: "roster" | "rotations" | null;
  subcommand:
    | "members"
    | "signup"
    | "report"
    | "readiness"
    | "refresh"
    | "open"
    | "close"
    | "archive"
    | "add"
    | "move"
    | "remove"
    | "show"
    | "create"
    | "import"
    | "export";
  clan?: string | null;
  roster?: string | null;
  groupKey?: string | null;
  players?: string | null;
  timezone?: string | null;
  inwar?: boolean | null;
  day?: number | null;
  exclude?: string | null;
  overwrite?: boolean | null;
  size?: number | null;
}) {
  return {
    user: { id: "111111111111111111" },
    guildId: "guild-1",
    inGuild: () => true,
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(input.group ?? null),
      getSubcommand: vi.fn().mockReturnValue(input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clan ?? null;
        if (name === "roster") return input.roster ?? null;
        if (name === "group") return input.groupKey ?? null;
        if (name === "players") return input.players ?? null;
        if (name === "timezone") return input.timezone ?? null;
        if (name === "exclude") return input.exclude ?? null;
        if (name === "visibility") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "inwar") return input.inwar ?? null;
        if (name === "overwrite") return input.overwrite ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) => {
        if (name === "day") return input.day ?? null;
        if (name === "size") return input.size ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAutocompleteInteraction(
  value: string,
  name: "clan" | "day" | "roster" = "clan",
  clan: string | null = "#2QG2C08UP",
  group: "roster" | "rotations" | null = null,
  subcommand: string | null = null,
) {
  return {
    guildId: "guild-1",
    inGuild: () => true,
    options: {
      getSubcommandGroup: vi.fn(() => group),
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((optionName: string) => {
        if (optionName === "clan") return clan;
        return null;
      }),
      getFocused: vi.fn(() => ({ name, value })),
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
}

function getDescription(interaction: any): string {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getUpdatedDescription(interaction: any): string {
  const payload = interaction.update.mock.calls[0]?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getEditedDescription(interaction: any): string {
  const payload = interaction.editReply?.mock.calls.at(-1)?.[0] as any;
  return String(payload?.embeds?.[0]?.toJSON?.().description ?? "");
}

function getComponentButtonCustomIds(interaction: any): string[] {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  const ids: string[] = [];
  for (const row of rows) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    for (const button of Array.isArray(rowJson?.components) ? rowJson.components : []) {
      const buttonJson = typeof button?.toJSON === "function" ? button.toJSON() : button;
      const id =
        buttonJson?.custom_id ??
        buttonJson?.customId ??
        buttonJson?.data?.custom_id ??
        buttonJson?.data?.customId ??
        null;
      if (typeof id === "string" && id.length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function getComponentSelectMenuCustomIds(interaction: any): string[] {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  const ids: string[] = [];
  for (const row of rows) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    for (const menu of Array.isArray(rowJson?.components) ? rowJson.components : []) {
      const menuJson = typeof menu?.toJSON === "function" ? menu.toJSON() : menu;
      const options = menuJson?.options ?? menuJson?.data?.options ?? [];
      if (!Array.isArray(options) || options.length <= 0) {
        continue;
      }
      const id =
        menuJson?.custom_id ??
        menuJson?.customId ??
        menuJson?.data?.custom_id ??
        menuJson?.data?.customId ??
        null;
      if (typeof id === "string" && id.length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function getComponentCustomIds(interaction: any): string[] {
  return [...new Set([...getComponentButtonCustomIds(interaction), ...getComponentSelectMenuCustomIds(interaction)])];
}

function getComponentSelectMenuOptions(interaction: any): Array<{ label: string; value: string; description?: string }> {
  const payload = (interaction.editReply?.mock.calls[0]?.[0] ?? interaction.update?.mock.calls[0]?.[0]) as any;
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  for (const row of rows) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    for (const menu of Array.isArray(rowJson?.components) ? rowJson.components : []) {
      const menuJson = typeof menu?.toJSON === "function" ? menu.toJSON() : menu;
      const options = menuJson?.options ?? menuJson?.data?.options ?? [];
      if (Array.isArray(options) && options.length > 0) {
        return options.map((option: any) => ({
          label: String(option?.label ?? ""),
          value: String(option?.value ?? ""),
          description: option?.description ? String(option.description) : undefined,
        }));
      }
    }
  }
  return [];
}

function getPayloadComponentCustomIds(payload: any): string[] {
  const rows = Array.isArray(payload?.components) ? payload.components : [];
  const ids: string[] = [];
  for (const row of rows) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    for (const component of Array.isArray(rowJson?.components) ? rowJson.components : []) {
      const componentJson = typeof component?.toJSON === "function" ? component.toJSON() : component;
      const id =
        componentJson?.custom_id ??
        componentJson?.customId ??
        componentJson?.data?.custom_id ??
        componentJson?.data?.customId ??
        null;
      if (typeof id === "string" && id.length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function makeParticipationCounts(entries: Array<[string, number]>): Map<string, number> {
  return new Map(entries);
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

describe("/cwl command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));

    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([]);
    prismaMock.cwlTrackedClan.findFirst.mockResolvedValue({ tag: "#2QG2C08UP", name: "CWL Alpha" });
    vi.spyOn(rosterService, "createRoster");
    vi.spyOn(rosterService, "createRosterSignupSelectionPanel");
    vi.spyOn(rosterService, "createRosterRemoveSelectionPanel");
    vi.spyOn(rosterService, "buildRosterSignupPayload");
    vi.spyOn(rosterService, "refreshRosterSignupPayload");
    vi.spyOn(rosterService, "findCwlRosterForClan");
    vi.spyOn(rosterService, "updateRosterLifecycleState");
    vi.spyOn(rosterService, "recordRosterPostedMessage");
    vi.spyOn(rosterService, "getRosterView");
    vi.spyOn(rosterService, "listCwlRostersForClan");
    vi.spyOn(rosterService, "getRosterRoleSyncTargets").mockResolvedValue(null as any);
    vi.spyOn(rosterService, "updateRosterSelectionPanel");
    vi.spyOn(rosterService, "confirmRosterSelectionPanel");
    vi.spyOn(rosterService, "cancelRosterSelectionPanel");
    vi.spyOn(rosterService, "removeRosterSignups");
    vi.spyOn(rosterService, "addRosterSignupsForManager");
    vi.spyOn(rosterService, "moveRosterSignups");
    vi.spyOn(rosterService, "removeRosterSignupsAsManager");
    vi.spyOn(rosterService, "buildRosterManagerReadinessText");
    vi.spyOn(cwlRotationService, "createPlanFromRoster");
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("Roster Signup"),
      components: [],
    });
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("Roster Signup"),
      components: [],
    });
    vi.spyOn(cwlRotationSheetService, "buildImportPreview");
    vi.spyOn(cwlRotationSheetService, "confirmImport");
    vi.spyOn(cwlRotationSheetService, "exportActivePlans");
    vi.spyOn(cwlRotationService, "listActivePlanExports");
    vi.spyOn(cwlRotationService, "listOverview");
    vi.spyOn(cwlRotationService, "getPreferredDisplayDay").mockResolvedValue(null);
    vi.spyOn(cwlRotationService, "validatePlanDay");
    vi.spyOn(cwlStateService, "getBattleDayStartForClanDay").mockResolvedValue(null);
    vi.spyOn(cwlStateService, "getParticipationCountsForClanDay").mockResolvedValue(new Map());
    vi.spyOn(emojiResolverService, "fetchApplicationEmojiInventory").mockResolvedValue({
      ok: true,
      snapshot: {
        fetchedAtMs: Date.now(),
        entries: [],
        exactByName: new Map([
          ["yes", { rendered: "<:yes:111>", name: "yes", shortcode: ":yes:", id: "111", animated: false }],
          ["no", { rendered: "<:no:222>", name: "no", shortcode: ":no:", id: "222", animated: false }],
        ]),
        lowercaseByName: new Map([
          ["yes", { rendered: "<:yes:111>", name: "yes", shortcode: ":yes:", id: "111", animated: false }],
          ["no", { rendered: "<:no:222>", name: "no", shortcode: ":no:", id: "222", animated: false }],
        ]),
      },
      diagnostics: {
        applicationExistedBeforeFetch: true,
        applicationFetchAttempted: false,
        applicationEmojiFetchAvailable: true,
        emojiFetchSucceeded: true,
        fetchedEmojiCount: 2,
      },
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the persisted season roster with current round summary for /cwl members", async () => {
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        playerTag: "#P1",
        playerName: "Alpha",
        townHall: 16,
        linkedDiscordUserId: "111111111111111111",
        linkedDiscordUsername: "alpha-user",
        daysParticipated: 2,
        currentRound: {
          roundDay: 1,
          roundState: "preparation",
          inCurrentLineup: true,
          attacksUsed: 0,
          attacksAvailable: 0,
          opponentTag: "#OPP1",
          opponentName: "Opponent One",
          phaseEndsAt: new Date("2026-04-03T12:00:00.000Z"),
        },
      },
    ]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue({
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      roundDay: 1,
      roundState: "preparation",
      opponentTag: "#OPP1",
      opponentName: "Opponent One",
      teamSize: 15,
      attacksPerMember: 1,
      preparationStartTime: null,
      startTime: new Date("2026-04-03T12:00:00.000Z"),
      endTime: new Date("2026-04-04T12:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-04-02T00:00:00.000Z"),
      members: [],
    });
    const interaction = makeInteraction({
      subcommand: "members",
      clan: "#2QG2C08UP",
    });

    await Cwl.run({} as any, interaction as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(getDescription(interaction)).toContain("Season: 2026-04");
    expect(getDescription(interaction)).toContain("CWL Alpha (#2QG2C08UP) - Day 1 Preparation vs Opponent One (#OPP1)");
    expect(getDescription(interaction)).toContain("Alpha `#P1` - days 2 - <@111111111111111111> - preparation 0/0");
  });

  it("posts a CWL signup roster with buttons and persistence", async () => {
    (rosterService.createRoster as any).mockResolvedValue({ id: "roster-1" });
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha CWL Signup (2026-04)"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("roster-post-action:signup:roster-1")
            .setLabel("Confirmed (0)")
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
    (rosterService.recordRosterPostedMessage as any).mockResolvedValue(undefined);
    const cocService = {
      getClan: vi.fn().mockResolvedValue({
        name: "CWL Alpha",
        warLeague: { name: "Champion League II" },
      }),
    };

    const interaction = makeInteraction({
      subcommand: "signup",
      clan: "#2QG2C08UP",
      timezone: "America/Los_Angeles",
    }) as any;
    interaction.inGuild = () => true;
    interaction.guildId = "guild-1";
    interaction.channel = {
      isTextBased: () => true,
      send: vi.fn().mockResolvedValue({
        id: "message-1",
        channelId: "channel-1",
        url: "https://discord.com/channels/guild-1/channel-1/message-1",
      }),
    };

    await Cwl.run({} as any, interaction as any, cocService as any);

    expect(rosterService.createRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        rosterType: "CWL",
        rosterCategory: "signup",
        clanTag: "#2QG2C08UP",
        timezone: "America/Los_Angeles",
        displayTimezone: "America/Los_Angeles",
        cocService,
      }),
    );
    expect(interaction.channel.send).toHaveBeenCalledTimes(1);
    expect(interaction.channel.send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
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
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Posted CWL signup roster for CWL Alpha in <#channel-1>.",
    );
  });

  it("opens an account selection panel when a roster group button is clicked", async () => {
    (rosterService.createRosterSignupSelectionPanel as any).mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-1",
        mode: "signup",
        selectedTags: [],
        embed: new EmbedBuilder().setTitle("Choose accounts for Confirmed"),
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("roster-selection:group:session-1")
              .setMinValues(0)
              .setMaxValues(2)
              .addOptions([
                { label: "Alpha", value: "#P1", description: "#P1 | available" },
                { label: "Bravo", value: "#P2", description: "#P2 | already signed up" },
              ]),
          ),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("roster-selection:account:session-1")
              .setMinValues(0)
              .setMaxValues(2)
              .addOptions([
                { label: "Alpha", value: "#P1", description: "#P1 | available" },
                { label: "Bravo", value: "#P2", description: "#P2 | already signed up" },
              ]),
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("roster-selection:action:confirm:session-1")
              .setLabel("Confirm Signup")
              .setStyle(ButtonStyle.Success)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId("roster-selection:action:cancel:session-1")
              .setLabel("Cancel")
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      },
    } as any);

    const interaction = {
      customId: "roster-post-action:signup:roster-1",
      user: { id: "111111111111111111" },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleRosterSignupButtonInteraction(interaction as any);

    expect(rosterService.createRosterSignupSelectionPanel).toHaveBeenCalledWith({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
      discordClient: interaction.client,
      cocService: null,
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
      }),
    );
    const payload = interaction.editReply.mock.calls[0]?.[0] as any;
    expect(getPayloadComponentCustomIds(payload)).toEqual(
      expect.arrayContaining([
        "roster-selection:group:session-1",
        "roster-selection:account:session-1",
        "roster-selection:action:confirm:session-1",
        "roster-selection:action:cancel:session-1",
      ]),
    );
  });

  it("supports multi-account roster selection and self-service removal panels", async () => {
    (rosterService.updateRosterSelectionPanel as any).mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        mode: "signup",
        selectedTags: ["#P1", "#P2"],
        embed: new EmbedBuilder().setTitle("Choose accounts for Confirmed"),
        components: [],
      },
    });
    (rosterService.confirmRosterSelectionPanel as any).mockResolvedValue({
      outcome: "signup",
      result: {
        outcome: "created",
        rosterId: "roster-1",
        groupKey: "confirmed",
        groupName: "Confirmed",
        requestedTags: ["#P1", "#P2"],
        linkedTags: ["#P1", "#P2"],
        createdTags: ["#P1", "#P2"],
        duplicateTags: [],
        missingLinkedTags: [],
      },
    });
    (rosterService.createRosterRemoveSelectionPanel as any).mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-3",
        mode: "remove",
        selectedTags: [],
        embed: new EmbedBuilder().setTitle("Remove signup entries from CWL Alpha"),
        components: [],
      },
    });
    (rosterService.cancelRosterSelectionPanel as any).mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-3",
        mode: "remove",
        selectedTags: [],
        embed: new EmbedBuilder().setTitle("Remove signup entries from CWL Alpha"),
        components: [],
      },
    });

    const updateInteraction = {
      customId: "roster-selection:account:session-2",
      user: { id: "111111111111111111" },
      values: ["#P1", "#P2"],
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleRosterSelectionMenuInteraction(updateInteraction as any);
    expect(rosterService.updateRosterSelectionPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedTags: ["#P1", "#P2"],
    });
    expect(updateInteraction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
      }),
    );

    const confirmInteraction = {
      customId: "roster-selection:action:confirm:session-2",
      user: { id: "111111111111111111" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    };
    await handleRosterSelectionActionButtonInteraction(confirmInteraction as any);
    expect(rosterService.confirmRosterSelectionPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      discordClient: confirmInteraction.client,
      cocService: null,
    });
    expect(confirmInteraction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(confirmInteraction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      (rosterService.confirmRosterSelectionPanel as any).mock.invocationCallOrder[0],
    );
    expect(confirmInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Signed up #P1, #P2"),
        embeds: [],
        components: [],
      }),
    );
    expect(confirmInteraction.update).not.toHaveBeenCalled();

    const removeInteraction = {
      customId: "roster-post-action:optout:roster-1",
      user: { id: "111111111111111111" },
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleRosterRemoveButtonInteraction(removeInteraction as any);
    expect(rosterService.createRosterRemoveSelectionPanel).toHaveBeenCalledWith({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
    });
    expect(removeInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
      }),
    );
  });

  it("shows exactly which selected accounts are missing town hall data when selection confirm is blocked", async () => {
    (rosterService.confirmRosterSelectionPanel as any).mockResolvedValue({
      outcome: "signup",
      result: {
        outcome: "townhall_unavailable",
        rosterId: "roster-1",
        groupKey: "confirmed",
        groupName: "Confirmed",
        requestedTags: ["#P1", "#P2"],
        linkedTags: ["#P1", "#P2"],
        createdTags: [],
        duplicateTags: [],
        missingLinkedTags: [],
        blockedTags: ["#P1", "#P2"],
        blockedAccounts: [
          { playerTag: "#P1", playerName: "Alpha" },
          { playerTag: "#P2", playerName: null },
        ],
      },
    });

    const confirmInteraction = {
      customId: "roster-selection:action:confirm:session-2",
      user: { id: "111111111111111111" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    };

    await handleRosterSelectionActionButtonInteraction(confirmInteraction as any);

    expect(confirmInteraction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(confirmInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Town hall data is unavailable for: Alpha `#P1`, `#P2`."),
        embeds: [],
        components: [],
      }),
    );
    expect(confirmInteraction.update).not.toHaveBeenCalled();
  });

  it("defers and edits the roster selection when confirming self-service removal", async () => {
    (rosterService.confirmRosterSelectionPanel as any).mockResolvedValue({
      outcome: "remove_user",
      result: {
        outcome: "removed" as const,
        rosterId: "roster-1",
        removedTags: ["#P1", "#P2"],
        removedAccounts: [
          { playerTag: "#P1", playerName: "Alpha" },
          { playerTag: "#P2", playerName: "Bravo" },
        ],
        ignoredTags: [],
        notOwnedTags: [],
      },
    });

    const confirmInteraction = {
      customId: "roster-selection:action:confirm:session-3",
      user: { id: "111111111111111111" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    };

    await handleRosterSelectionActionButtonInteraction(confirmInteraction as any);

    expect(confirmInteraction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(confirmInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Removed #P1, #P2"),
        embeds: [],
        components: [],
      }),
    );
    expect(confirmInteraction.update).not.toHaveBeenCalled();
  });

  it("renders a manager readiness report for /cwl roster report", async () => {
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
      "CWL Alpha Signup\nUnregistered members:\n- Bravo `#QGRJ2222` <@222222222222222222>",
    );
    const cocService = {} as any;

    const interaction = makeInteraction({
      group: "roster",
      subcommand: "report",
      clan: "#2QG2C08UP",
    }) as any;
    interaction.inGuild = () => true;
    interaction.guildId = "guild-1";

    await Cwl.run({} as any, interaction as any, cocService);

    expect(rosterService.findCwlRosterForClan).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "#2QG2C08UP",
      }),
    );
    expect(rosterService.buildRosterManagerReadinessText).toHaveBeenCalledWith({
      rosterId: "roster-1",
      cocService,
    });
    expect(getEditedDescription(interaction)).toContain("Unregistered members:");
  });

  it.each([
    ["open", "OPEN", "was opened"],
    ["close", "CLOSED", "was closed"],
    ["archive", "ARCHIVED", "was archived"],
  ] as const)("updates roster lifecycle through /cwl roster %s", async (subcommand, lifecycleState, message) => {
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

    const interaction = makeInteraction({
      group: "roster",
      subcommand,
      clan: "#2QG2C08UP",
    }) as any;
    interaction.inGuild = () => true;
    interaction.guildId = "guild-1";

    await Cwl.run({} as any, interaction as any, {} as any);

    expect(rosterService.updateRosterLifecycleState).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        lifecycleState,
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(message);
  });

  it("refreshes the posted roster from DB truth through /cwl roster refresh", async () => {
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
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue(
      makeRosterRefreshPayload(true, "CWL Alpha Signup (Loading)"),
    );
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("roster-post-action:refresh:roster-1")
            .setLabel("Refresh")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(false),
        ),
      ],
    });
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
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
      },
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });

    const messageEdit = vi.fn().mockResolvedValue(undefined);
    const messageFetch = vi.fn().mockResolvedValue({ edit: messageEdit });
    const channelFetch = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      messages: {
        fetch: messageFetch,
      },
    });

    const interaction = makeInteraction({
      group: "roster",
      subcommand: "refresh",
      clan: "#2QG2C08UP",
    }) as any;
    interaction.inGuild = () => true;
    interaction.guildId = "guild-1";
    interaction.client = {
      channels: {
        fetch: channelFetch,
      },
    };

    await Cwl.run({} as any, interaction as any, {} as any);

    expect(channelFetch).toHaveBeenCalledWith("channel-1");
    expect(messageFetch).toHaveBeenCalledWith("message-1");
    expect(rosterService.buildRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      null,
      expect.objectContaining({
        refreshButtonDisabled: true,
      }),
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      expect.anything(),
      expect.objectContaining({
        refreshButtonDisabled: false,
      }),
    );
    expect(messageEdit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
      }),
    );
    expect(messageEdit.mock.calls[0]?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.disabled).toBe(true);
    expect(messageEdit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [expect.any(ActionRowBuilder)],
      }),
    );
    expect(messageEdit.mock.calls.at(-1)?.[0]?.components?.[0]?.toJSON?.().components?.[0]?.disabled).toBe(false);
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Refreshed the posted CWL roster for CWL Alpha.",
    );
  });

  it("returns a clear message when /cwl members inwar:true has no active persisted round", async () => {
    vi.spyOn(cwlStateService, "listSeasonRosterForClan").mockResolvedValue([]);
    vi.spyOn(cwlStateService, "getCurrentRoundForClan").mockResolvedValue(null);
    const interaction = makeInteraction({
      subcommand: "members",
      clan: "#2QG2C08UP",
      inwar: true,
    });

    await Cwl.run({} as any, interaction as any);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "No active CWL round is persisted for #2QG2C08UP.",
    );
  });

  it("renders created-plan output with warnings for /cwl rotations create", async () => {
    vi.spyOn(cwlRotationService, "createPlan").mockResolvedValue({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      version: 2,
      lineupSize: 15,
      warnings: ["Could not reach 5 planned CWL days for: Alpha (#P1) -> 4/5"],
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "create",
      clan: "#2QG2C08UP",
      size: 15,
      exclude: "#P9",
      overwrite: true,
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.createPlan).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      excludeTagsRaw: "#P9",
      lineupSize: 15,
      overwrite: true,
    });
    expect(getDescription(interaction)).toContain("Created CWL rotation plan for #2QG2C08UP.");
    expect(getDescription(interaction)).toContain("Version: 2");
    expect(getDescription(interaction)).toContain("Lineup size: 15");
    expect(getDescription(interaction)).toContain("Could not reach 5 planned CWL days");
  });

  it("returns the blocked-existing message for /cwl rotations create without roster", async () => {
    vi.spyOn(cwlRotationService, "createPlan").mockResolvedValue({
      outcome: "blocked_existing",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      existingVersion: 4,
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "create",
      clan: "#2QG2C08UP",
      overwrite: false,
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.createPlan).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      excludeTagsRaw: null,
      lineupSize: null,
      overwrite: false,
    });
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toBe(
      "A CWL rotation plan already exists for #2QG2C08UP this season. Use overwrite:true to replace version 4.",
    );
  });

  it("rejects invalid CWL rotation lineup sizes", async () => {
    vi.spyOn(cwlRotationService, "createPlan").mockResolvedValue({
      outcome: "invalid_size",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      requestedLineupSize: 20,
    } as any);
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "create",
      clan: "#2QG2C08UP",
      size: 20,
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.createPlan).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      excludeTagsRaw: null,
      lineupSize: 20,
      overwrite: false,
    });
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toBe(
      "CWL rotation lineup size must be 15 or 30.",
    );
  });

  it("renders roster-backed created-plan output with source and warnings for /cwl rotations create", async () => {
    vi.spyOn(cwlRotationService, "createPlanFromRoster").mockResolvedValue({
      outcome: "created",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      rosterId: "roster-1",
      rosterTitle: "CWL Alpha roster",
      version: 3,
      lineupSize: 30,
      warnings: ["Missing Town Hall data for confirmed roster players: Charlie (#P3)."],
      sourceLabel: "CWL roster - CWL Alpha roster",
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "create",
      clan: "#2QG2C08UP",
      roster: "roster-1",
      size: 30,
      overwrite: true,
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.createPlanFromRoster).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-1",
      guildId: "guild-1",
      lineupSize: 30,
      overwrite: true,
    });
    expect(getDescription(interaction)).toContain("Created CWL rotation plan for #2QG2C08UP.");
    expect(getDescription(interaction)).toContain("Source: CWL roster - CWL Alpha roster");
    expect(getDescription(interaction)).toContain("Version: 3");
    expect(getDescription(interaction)).toContain("Lineup size: 30");
    expect(getDescription(interaction)).toContain("Missing Town Hall data for confirmed roster players");
  });

  it("returns the blocked-existing message for roster-backed /cwl rotations create", async () => {
    vi.spyOn(cwlRotationService, "createPlanFromRoster").mockResolvedValue({
      outcome: "blocked_existing",
      season: "2026-04",
      clanTag: "#2QG2C08UP",
      rosterId: "roster-1",
      rosterTitle: "CWL Alpha roster",
      existingVersion: 6,
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "create",
      clan: "#2QG2C08UP",
      roster: "roster-1",
      overwrite: false,
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.createPlanFromRoster).toHaveBeenCalledWith({
      clanTag: "#2QG2C08UP",
      rosterId: "roster-1",
      guildId: "guild-1",
      lineupSize: null,
      overwrite: false,
    });
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toBe(
      "A CWL rotation plan already exists for #2QG2C08UP this season. Use overwrite:true to replace version 6.",
    );
  });

  it.each([
    [
      "roster_not_found",
      { outcome: "roster_not_found", season: "2026-04", clanTag: "#2QG2C08UP", rosterId: "roster-1" },
      "That roster no longer exists.",
    ],
    [
      "roster_not_cwl",
      {
        outcome: "roster_not_cwl",
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        rosterId: "roster-1",
        rosterType: "FWA",
      },
      "That roster is not a CWL roster.",
    ],
    [
      "roster_archived",
      {
        outcome: "roster_archived",
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        rosterId: "roster-1",
        rosterTitle: "CWL Alpha roster",
      },
      "That roster is archived.",
    ],
    [
      "roster_not_open_or_closed",
      {
        outcome: "roster_not_open_or_closed",
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        rosterId: "roster-1",
        rosterTitle: "CWL Alpha roster",
        lifecycleState: "ACTIVE",
      },
      "That CWL roster must be open or closed before it can be used for rotation creation.",
    ],
    [
      "roster_clan_mismatch",
      {
        outcome: "roster_clan_mismatch",
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        rosterId: "roster-1",
        rosterTitle: "CWL Beta roster",
        rosterClanTag: "#9GLGQCCU",
      },
      "That roster belongs to #9GLGQCCU, not #2QG2C08UP.",
    ],
    [
      "no_confirmed_players",
      {
        outcome: "no_confirmed_players",
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        rosterId: "roster-1",
        rosterTitle: "CWL Alpha roster",
      },
      "That roster has no confirmed signed-up accounts.",
    ],
  ])("rejects roster-backed create when %s", async (_outcome, response, expectedMessage) => {
    vi.mocked(cwlRotationService.createPlanFromRoster).mockResolvedValueOnce(response as any);
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "create",
      clan: "#2QG2C08UP",
      roster: "roster-1",
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.createPlanFromRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        rosterId: "roster-1",
        guildId: "guild-1",
        lineupSize: null,
        overwrite: false,
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(expectedMessage);
  });

  it("renders overview status lines for /cwl rotations show with no clan filter", async () => {
    const alphaBattleDay = Math.floor(new Date("2026-04-03T12:00:00.000Z").getTime() / 1000);
    vi.spyOn(cwlRotationService, "listOverview").mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 1,
        roundDay: 3,
        battleDayStartAt: new Date("2026-04-03T12:00:00.000Z"),
        leaderNames: ["Alpha", "Bravo"],
        status: "mismatch",
        missingExpectedPlayerTags: ["#P2"],
        extraActualPlayerTags: ["#P3"],
      },
      {
        season: "2026-04",
        clanTag: "#9GLGQCCU",
        clanName: "CWL Beta",
        version: 1,
        roundDay: 3,
        battleDayStartAt: null,
        leaderNames: [],
        status: "complete",
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
      },
    ]);
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationService.listOverview).toHaveBeenCalledWith({
      season: "2026-04",
      refreshLeadershipMembers: true,
    });
    expect(getDescription(interaction)).toContain(
      `<:no:222> CWL Alpha (\`#2QG2C08UP\`) - day 3 - Next Battle Day <t:${alphaBattleDay}:R>`,
    );
    expect(getDescription(interaction)).toContain("- Leaders/Co-leaders: Alpha, Bravo");
    expect(getDescription(interaction)).toContain(
      "<:yes:111> CWL Beta (`#9GLGQCCU`) - day 3 - Next Battle Day unknown",
    );
    expect(getDescription(interaction)).toContain("- Leaders/Co-leaders: unknown");
    expect(getComponentSelectMenuCustomIds(interaction)).toHaveLength(1);
    expect(getComponentSelectMenuOptions(interaction).map((option) => option.label)).toEqual(
      expect.arrayContaining(["CWL Alpha", "CWL Beta"]),
    );
  });

  it("navigates from the overview dropdown into clan view and back to overview, enforcing requester-only access", async () => {
    const alphaBattleDay = Math.floor(new Date("2026-04-03T12:00:00.000Z").getTime() / 1000);
    vi.mocked(cwlRotationService.listOverview).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 1,
        roundDay: 2,
        battleDayStartAt: new Date("2026-04-03T12:00:00.000Z"),
        leaderNames: ["Alpha"],
        status: "complete",
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
      },
    ] as any);
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(2);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getBattleDayStartForClanDay).mockResolvedValue(
      new Date("2026-04-03T12:00:00.000Z"),
    );
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );

    const overviewInteraction = makeInteraction({
      group: "rotations",
      subcommand: "show",
    });
    await Cwl.run({} as any, overviewInteraction as any);

    const selectId = getComponentSelectMenuCustomIds(overviewInteraction)[0];
    expect(selectId).toBeTruthy();

    const wrongUserSelect = {
      customId: selectId,
      values: ["#2QG2C08UP"],
      user: { id: "222222222222222222" },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowSelectMenuInteraction(wrongUserSelect as any);
    expect(wrongUserSelect.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only the command requester can use these buttons.",
        ephemeral: true,
      }),
    );

    const selectInteraction = {
      customId: selectId,
      values: ["#2QG2C08UP"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowSelectMenuInteraction(selectInteraction as any);
    expect(getUpdatedDescription(selectInteraction)).toContain("Day 2");
    expect(getUpdatedDescription(selectInteraction)).toContain(":white_check_mark: Charlie (#VJQ28888) | War count: 1");
    expect(getUpdatedDescription(selectInteraction)).toContain("Battle day start: <t:");
    expect(getUpdatedDescription(selectInteraction)).toContain(":R>");
    expect(getComponentButtonCustomIds(selectInteraction)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":back:"),
        expect.stringContaining(":page:"),
        expect.stringContaining(":refresh:"),
      ]),
    );

    const wrongUserBack = {
      customId: getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":back:")),
      user: { id: "222222222222222222" },
      client: {} as any,
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(wrongUserBack as any);
    expect(wrongUserBack.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only the command requester can use these buttons.",
        ephemeral: true,
      }),
    );

    const backId = getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":back:"));
    expect(backId).toBeTruthy();
    const backInteraction = {
      customId: backId,
      user: { id: "111111111111111111" },
      client: {} as any,
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(backInteraction as any);
    expect(backInteraction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(backInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(cwlRotationService.listOverview).toHaveBeenNthCalledWith(2, {
      season: "2026-04",
    });
    expect(getEditedDescription(backInteraction)).toContain(
      `<:yes:111> CWL Alpha (\`#2QG2C08UP\`) - day 2 - Next Battle Day <t:${alphaBattleDay}:R>`,
    );
    expect(getComponentSelectMenuCustomIds(backInteraction)).toHaveLength(1);

    const refreshId = getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":refresh:"));
    expect(refreshId).toBeTruthy();
    const wrongUserRefresh = {
      customId: refreshId,
      user: { id: "222222222222222222" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(wrongUserRefresh as any, {} as any);
    expect(wrongUserRefresh.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only the command requester can use these buttons.",
        ephemeral: true,
      }),
    );
    const refreshSpy = vi
      .spyOn(cwlStateService, "refreshTrackedCwlStateForClan")
      .mockResolvedValue({
        season: "2026-04",
        trackedClanCount: 1,
        refreshedClanCount: 1,
        currentRoundCount: 1,
        currentMemberCount: 2,
        historyRoundCount: 0,
        historyMemberCount: 0,
      } as any);
    const refreshInteraction = {
      customId: "cwl-rot-show:refresh:111111111111111111:#2QG2C08UP:2026-04:0:1",
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(refreshInteraction as any, {} as any);
    expect(refreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        season: "2026-04",
      }),
    );
    expect(refreshInteraction.update).toHaveBeenCalled();
    expect(getEditedDescription(refreshInteraction)).toContain("Day 2");
    expect(getEditedDescription(refreshInteraction)).toContain("Battle day start: <t:");
    expect(getEditedDescription(refreshInteraction)).toContain(":R>");
  });

  it("restores the current clan page and reports a failure when refresh throws", async () => {
    vi.mocked(cwlRotationService.listOverview).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 1,
        roundDay: 2,
        battleDayStartAt: new Date("2026-04-03T12:00:00.000Z"),
        leaderNames: ["Alpha"],
        status: "complete",
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
      },
    ] as any);
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(2);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getBattleDayStartForClanDay).mockResolvedValue(
      new Date("2026-04-03T12:00:00.000Z"),
    );
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );

    const overviewInteraction = makeInteraction({
      group: "rotations",
      subcommand: "show",
    });
    await Cwl.run({} as any, overviewInteraction as any);

    const selectId = getComponentSelectMenuCustomIds(overviewInteraction)[0];
    expect(selectId).toBeTruthy();

    const selectInteraction = {
      customId: selectId,
      values: ["#2QG2C08UP"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowSelectMenuInteraction(selectInteraction as any);

    const refreshId = getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":refresh:"));
    expect(refreshId).toBeTruthy();
    const refreshSpy = vi.spyOn(cwlStateService, "refreshTrackedCwlStateForClan").mockRejectedValue(
      new Error("boom"),
    );
    const refreshInteraction = {
      customId: "cwl-rot-show:refresh:111111111111111111:#2QG2C08UP:2026-04:0:1",
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationShowButtonInteraction(refreshInteraction as any, {} as any);

    expect(refreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        season: "2026-04",
      }),
    );
    expect(refreshInteraction.update).toHaveBeenCalled();
    expect(getEditedDescription(refreshInteraction)).toContain("Day 2");
    expect(refreshInteraction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Failed to refresh the CWL rotation view.",
        ephemeral: true,
      }),
    );
  });

  it("renders one merged CWL day per page for /cwl rotations show", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: "1 warning",
        excludedPlayerTags: ["#P9"],
        days: [
          {
            roundDay: 1,
            lineupSize: 3,
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: false, assignmentOrder: 1 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 2 },
              { playerTag: "#JQJQ2222", playerName: "Hotel", subbedOut: true, assignmentOrder: 3 },
            ],
            actual: null,
          },
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(1);
    vi.mocked(cwlRotationService.validatePlanDay)
      .mockResolvedValueOnce({
        actualAvailable: true,
        complete: false,
        missingExpectedPlayerTags: ["#QGRJ2222", "#CUV02898"],
        extraActualPlayerTags: ["#VJQ28888"],
        actualPlayerTags: ["#PYLQ0289", "#VJQ28888"],
        actualPlayerNames: ["Alpha", "Charlie"],
      } as any)
      .mockResolvedValueOnce({
        actualAvailable: true,
        complete: false,
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: ["#QGRJ2222"],
        actualPlayerTags: ["#QGRJ2222", "#CUV02898"],
        actualPlayerNames: ["Bravo", "Delta"],
      } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockImplementation(async ({ throughRoundDay }) => {
      if (throughRoundDay === 1) {
        return makeParticipationCounts([
          ["#PYLQ0289", 1],
          ["#VJQ28888", 1],
          ["#QGRJ2222", 0],
          ["#CUV02898", 0],
        ]);
      }
      if (throughRoundDay === 2) {
        return makeParticipationCounts([
          ["#PYLQ0289", 1],
          ["#QGRJ2222", 1],
          ["#CUV02898", 1],
        ]);
      }
      return new Map();
    });
    vi.mocked(cwlStateService.getBattleDayStartForClanDay).mockImplementation(async ({ roundDay }) => {
      if (roundDay === 1) {
        return new Date("2026-04-03T12:00:00.000Z");
      }
      if (roundDay === 2) {
        return new Date("2026-04-04T12:00:00.000Z");
      }
      return null;
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
    });

    await Cwl.run({} as any, interaction as any);

    expect(vi.mocked(cwlRotationService.listActivePlanExports)).toHaveBeenCalledWith({
      season: "2026-04",
      clanTags: ["#2QG2C08UP"],
    });
    expect(getDescription(interaction)).toContain("Battle day start: <t:");
    expect(getDescription(interaction)).toContain(":R>");
    expect(getDescription(interaction)).toContain("Excluded: #P9");
    expect(getDescription(interaction)).toContain("Day 1");
    expect(getDescription(interaction)).not.toContain("Warnings:");
    expect(getDescription(interaction)).toContain(":white_check_mark: Alpha (#PYLQ0289) | War count: 1");
    expect(getDescription(interaction)).toContain(
      ":warning: Charlie (#VJQ28888) | War count: 1 - Expected Bravo (#QGRJ2222)",
    );
    expect(getDescription(interaction)).toContain(":x: Bravo (#QGRJ2222) | War count: 0");
    expect(getDescription(interaction)).toContain(":x: Delta (#CUV02898) | War count: 0");
    expect(getDescription(interaction)).not.toContain(":x: Hotel (#JQJQ2222)");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
    expect(getComponentButtonCustomIds(interaction)).toHaveLength(4);

    const nextButtonId = getComponentButtonCustomIds(interaction).find((id) => id.endsWith(":1"));
    expect(nextButtonId).toBeTruthy();
    const buttonInteraction = {
      customId: nextButtonId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationShowButtonInteraction(buttonInteraction as any);

    expect(getUpdatedDescription(buttonInteraction)).toContain("Day 2");
    expect(getUpdatedDescription(buttonInteraction)).toContain("Battle day start: <t:");
    expect(getUpdatedDescription(buttonInteraction)).toContain(":R>");
    expect(getUpdatedDescription(buttonInteraction)).toContain(
      ":warning: Bravo (#QGRJ2222) | War count: 1",
    );
    expect(getUpdatedDescription(buttonInteraction)).toContain(
      ":white_check_mark: Delta (#CUV02898) | War count: 1",
    );
    expect(getUpdatedDescription(buttonInteraction)).not.toContain(":x: Bravo (#QGRJ2222)");
    expect(getUpdatedDescription(buttonInteraction)).not.toContain("Actual:");
    expect(getUpdatedDescription(buttonInteraction)).not.toContain("Status:");
  });

  it("navigates from the overview dropdown into clan view and back to overview, enforcing requester-only access", async () => {
    const alphaBattleDay = Math.floor(new Date("2026-04-03T12:00:00.000Z").getTime() / 1000);
    vi.mocked(cwlRotationService.listOverview).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 1,
        roundDay: 2,
        battleDayStartAt: new Date("2026-04-03T12:00:00.000Z"),
        leaderNames: ["Alpha"],
        status: "complete",
        missingExpectedPlayerTags: [],
        extraActualPlayerTags: [],
      },
    ] as any);
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(2);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getBattleDayStartForClanDay).mockResolvedValue(
      new Date("2026-04-03T12:00:00.000Z"),
    );
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );

    const overviewInteraction = makeInteraction({
      group: "rotations",
      subcommand: "show",
    });
    await Cwl.run({} as any, overviewInteraction as any);

    const selectId = getComponentSelectMenuCustomIds(overviewInteraction)[0];
    expect(selectId).toBeTruthy();

    const wrongUserSelect = {
      customId: selectId,
      values: ["#2QG2C08UP"],
      user: { id: "222222222222222222" },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowSelectMenuInteraction(wrongUserSelect as any);
    expect(wrongUserSelect.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only the command requester can use these buttons.",
        ephemeral: true,
      }),
    );

    const selectInteraction = {
      customId: selectId,
      values: ["#2QG2C08UP"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowSelectMenuInteraction(selectInteraction as any);
    expect(getUpdatedDescription(selectInteraction)).toContain("Day 2");
    expect(getUpdatedDescription(selectInteraction)).toContain(":white_check_mark: Charlie (#VJQ28888) | War count: 1");
    expect(getUpdatedDescription(selectInteraction)).toContain("Battle day start: <t:");
    expect(getUpdatedDescription(selectInteraction)).toContain(":R>");
    expect(getComponentButtonCustomIds(selectInteraction)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":back:"),
        expect.stringContaining(":page:"),
        expect.stringContaining(":refresh:"),
      ]),
    );

    const wrongUserBack = {
      customId: getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":back:")),
      user: { id: "222222222222222222" },
      client: {} as any,
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(wrongUserBack as any);
    expect(wrongUserBack.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Only the command requester can use these buttons.",
        ephemeral: true,
      }),
    );

    const backId = getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":back:"));
    expect(backId).toBeTruthy();
    const backInteraction = {
      customId: backId,
      user: { id: "111111111111111111" },
      client: {} as any,
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(backInteraction as any);
    expect(backInteraction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(backInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(getEditedDescription(backInteraction)).toContain(
      `<:yes:111> CWL Alpha (\`#2QG2C08UP\`) - day 2 - Next Battle Day <t:${alphaBattleDay}:R>`,
    );
    expect(getComponentSelectMenuCustomIds(backInteraction)).toHaveLength(1);
  });

  it("returns to a refreshed overview and reflects updated status after detail refresh", async () => {
    const alphaBattleDay = Math.floor(new Date("2026-04-03T12:00:00.000Z").getTime() / 1000);
    vi.mocked(cwlRotationService.listOverview)
      .mockResolvedValueOnce([
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 1,
          roundDay: 2,
          battleDayStartAt: new Date("2026-04-03T12:00:00.000Z"),
          leaderNames: ["Alpha"],
          status: "mismatch",
          missingExpectedPlayerTags: ["#CUV02898"],
          extraActualPlayerTags: ["#VJQ28888"],
        },
      ] as any)
      .mockResolvedValueOnce([
        {
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 1,
          roundDay: 2,
          battleDayStartAt: new Date("2026-04-03T12:00:00.000Z"),
          leaderNames: ["Alpha"],
          status: "complete",
          missingExpectedPlayerTags: [],
          extraActualPlayerTags: [],
        },
      ] as any);
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(2);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getBattleDayStartForClanDay).mockResolvedValue(
      new Date("2026-04-03T12:00:00.000Z"),
    );
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );

    const overviewInteraction = makeInteraction({
      group: "rotations",
      subcommand: "show",
    });
    await Cwl.run({} as any, overviewInteraction as any);

    const selectId = getComponentSelectMenuCustomIds(overviewInteraction)[0];
    expect(selectId).toBeTruthy();

    const selectInteraction = {
      customId: selectId,
      values: ["#2QG2C08UP"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowSelectMenuInteraction(selectInteraction as any);

    const refreshSpy = vi
      .spyOn(cwlStateService, "refreshTrackedCwlStateForClan")
      .mockResolvedValue({
        season: "2026-04",
        trackedClanCount: 1,
        refreshedClanCount: 1,
        currentRoundCount: 1,
        currentMemberCount: 2,
        historyRoundCount: 0,
        historyMemberCount: 0,
      } as any);
    const refreshId = getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":refresh:"));
    expect(refreshId).toBeTruthy();
    const refreshInteraction = {
      customId: refreshId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(refreshInteraction as any, {} as any);

    expect(refreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTag: "#2QG2C08UP",
        season: "2026-04",
      }),
    );

    const refreshedBackId = getComponentButtonCustomIds(refreshInteraction).find((id) => id.includes(":back:"));
    expect(refreshedBackId).toBeTruthy();
    const backInteraction = {
      customId: refreshedBackId,
      user: { id: "111111111111111111" },
      client: {} as any,
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationShowButtonInteraction(backInteraction as any);

    expect(backInteraction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(backInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(cwlRotationService.listOverview).toHaveBeenNthCalledWith(2, {
      season: "2026-04",
    });
    const backDescription = getEditedDescription(backInteraction);
    expect(backDescription).toContain(
      `<:yes:111> CWL Alpha (\`#2QG2C08UP\`) - day 2 - Next Battle Day <t:${alphaBattleDay}:R>`,
    );
    expect(backDescription).not.toContain(`<:no:222> CWL Alpha (\`#2QG2C08UP\`)`);
  });

  it("does not render a duplicate bench line when a visible subbed-out member appears in the actual lineup", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 5,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 1,
            lineupSize: 3,
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: true, assignmentOrder: 1 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 2 },
            ],
            actual: null,
          },
          {
            roundDay: 2,
            lineupSize: 3,
            rows: [
              { playerTag: "#QGRJ2222", playerName: "Bench Later", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 1 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 2 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(1);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: false,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: ["#QGRJ2222"],
      actualPlayerTags: ["#PYLQ0289", "#QGRJ2222", "#CUV02898"],
      actualPlayerNames: ["Alpha", "Bench Later", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getBattleDayStartForClanDay).mockResolvedValue(
      new Date("2026-04-03T12:00:00.000Z"),
    );
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#PYLQ0289", 1],
        ["#QGRJ2222", 1],
        ["#CUV02898", 1],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 1");
    expect(getDescription(interaction)).toContain("Battle day start: <t:");
    expect(getDescription(interaction)).toContain(":white_check_mark: Alpha (#PYLQ0289) | War count: 1");
    expect(getDescription(interaction)).toContain(
      ":warning: Bench Later (#QGRJ2222) | War count: 1",
    );
    expect(getDescription(interaction)).toContain(":white_check_mark: Delta (#CUV02898) | War count: 1");
    expect(getDescription(interaction)).not.toContain(":x: Bench Later (#QGRJ2222)");
    expect(getDescription(interaction)).not.toContain("Warnings:");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
  });

  it("renders the prep-day page with merged check marks during overlap", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 3,
            lineupSize: 2,
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
          {
            roundDay: 4,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.getPreferredDisplayDay).mockResolvedValue(4);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 4");
    expect(getDescription(interaction)).toContain(":white_check_mark: Charlie (#VJQ28888) | War count: 1");
    expect(getDescription(interaction)).toContain(":white_check_mark: Delta (#CUV02898) | War count: 1");
    expect(getDescription(interaction)).not.toContain("Day 3");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
  });

  it("renders only the requested day when /cwl rotations show is day-filtered", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#VJQ28888", playerName: "Charlie", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#CUV02898", playerName: "Delta", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: true,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: ["#VJQ28888", "#CUV02898"],
      actualPlayerNames: ["Charlie", "Delta"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#VJQ28888", 1],
        ["#CUV02898", 1],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 2,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 2");
    expect(getDescription(interaction)).toContain(":white_check_mark: Charlie (#VJQ28888) | War count: 1");
    expect(getDescription(interaction)).toContain(":white_check_mark: Delta (#CUV02898) | War count: 1");
    expect(getDescription(interaction)).not.toContain("Day 1");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
    expect(getComponentButtonCustomIds(interaction)).toHaveLength(3);
    expect(getComponentButtonCustomIds(interaction)).toEqual(
      expect.arrayContaining([expect.stringContaining(":refresh:")]),
    );
  });

  it("keeps actual lineup unavailable for far-future /cwl rotations show days", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 7,
            lineupSize: 2,
            rows: [
              { playerTag: "#JQJQ2222", playerName: "Hotel", subbedOut: true, assignmentOrder: 0 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: false,
      complete: false,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: [],
      actualPlayerNames: [],
    } as any);
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 7,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 7");
    expect(getDescription(interaction)).toContain("Battle day start: unknown");
    expect(getDescription(interaction)).toContain("Actual lineup unavailable");
    expect(getDescription(interaction)).not.toContain(":x: Hotel (#JQJQ2222)");
    expect(getDescription(interaction)).not.toContain("Warnings:");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
  });

  it("shows zero war count for a day-2 benched member who has not actually participated yet", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2C0UURLQU",
        clanName: "Rising Crowns",
        version: 2,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 2,
            lineupSize: 2,
            rows: [
              { playerTag: "#2JVRPVGLQ", playerName: "ChipsAreTasty", subbedOut: true, assignmentOrder: 0 },
              { playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
          {
            roundDay: 3,
            lineupSize: 2,
            rows: [
              { playerTag: "#2JVRPVGLQ", playerName: "ChipsAreTasty", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: false, assignmentOrder: 1 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: false,
      complete: false,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: [],
      actualPlayerTags: [],
      actualPlayerNames: [],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#2JVRPVGLQ", 0],
        ["#PYLQ0289", 1],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2C0UURLQU",
      day: 2,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Day 2");
    expect(getDescription(interaction)).toContain("Actual lineup unavailable");
    expect(getDescription(interaction)).toContain(":x: ChipsAreTasty (#2JVRPVGLQ) | War count: 0");
    expect(getDescription(interaction)).not.toContain("War count: 1");
  });

  it("appends trailing missing expected rows when actual lineup runs short", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 3,
            lineupSize: 3,
            rows: [
              { playerTag: "#PYLQ0289", playerName: "Echo", subbedOut: false, assignmentOrder: 0 },
              { playerTag: "#QGRJ2222", playerName: "Foxtrot", subbedOut: false, assignmentOrder: 1 },
              { playerTag: "#CUV02898", playerName: "Golf", subbedOut: false, assignmentOrder: 2 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: false,
      missingExpectedPlayerTags: ["#QGRJ2222", "#CUV02898"],
      extraActualPlayerTags: ["#VJQ28888"],
      actualPlayerTags: ["#PYLQ0289", "#VJQ28888"],
      actualPlayerNames: ["Echo", "Zulu"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([
        ["#PYLQ0289", 1],
        ["#VJQ28888", 0],
        ["#QGRJ2222", 0],
        ["#CUV02898", 0],
      ]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 3,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain(":white_check_mark: Echo (#PYLQ0289)");
    expect(getDescription(interaction)).toContain(
      ":warning: Zulu (#VJQ28888) | War count: 0 - Expected Foxtrot (#QGRJ2222)",
    );
    expect(getDescription(interaction)).toContain(":x: Foxtrot (#QGRJ2222) | War count: 0");
    expect(getDescription(interaction)).toContain(":x: Golf (#CUV02898) | War count: 0");
    expect(getDescription(interaction)).not.toContain("Actual:");
    expect(getDescription(interaction)).not.toContain("Status:");
  });

  it("shows unexpected actual members with zero war count when they are absent from the plan", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 4,
        warningSummary: null,
        excludedPlayerTags: [],
        days: [
          {
            roundDay: 5,
            lineupSize: 1,
            rows: [
              { playerTag: "#JQJQ2222", playerName: "Hotel", subbedOut: true, assignmentOrder: 0 },
            ],
            actual: null,
          },
        ],
      } as any,
    ]);
    vi.mocked(cwlRotationService.validatePlanDay).mockResolvedValue({
      actualAvailable: true,
      complete: false,
      missingExpectedPlayerTags: [],
      extraActualPlayerTags: ["#VJQ28888"],
      actualPlayerTags: ["#VJQ28888"],
      actualPlayerNames: ["Visitor"],
    } as any);
    vi.mocked(cwlStateService.getParticipationCountsForClanDay).mockResolvedValue(
      makeParticipationCounts([["#VJQ28888", 0]]),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "show",
      clan: "#2QG2C08UP",
      day: 5,
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain(":warning: Visitor (#VJQ28888) | War count: 0");
    expect(getDescription(interaction)).not.toContain(":x: Hotel (#JQJQ2222)");
  });

  it("renders an import preview before save and confirms only after a button interaction", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          days: [
            {
              roundDay: 1,
              lineupSize: 1,
              rows: [
                {
                  playerTag: "#PYLQ0289",
                  playerName: "Alpha",
                  subbedOut: false,
                  assignmentOrder: 0,
                },
                {
                  playerTag: "#QGRJ2222",
                  playerName: "Bravo",
                  subbedOut: true,
                  assignmentOrder: 1,
                },
              ],
              members: [
                {
                  playerTag: "#PYLQ0289",
                  playerName: "Alpha",
                  subbedOut: false,
                  assignmentOrder: 0,
                },
                {
                  playerTag: "#QGRJ2222",
                  playerName: "Bravo",
                  subbedOut: true,
                  assignmentOrder: 1,
                },
              ],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:3",
              sheetRowNumber: 3,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha | #PYLQ0289 | 12 | IN",
              rawPlayerNameSnippet: "Alpha",
              parsedPlayerTag: "#PYLQ0289",
              parsedPlayerName: "Alpha",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: false, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: true, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#PYLQ0289",
              resolvedPlayerName: "Alpha",
              ignored: false,
            },
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Bravo | #QGRJ2222 | 8 | ",
              rawPlayerNameSnippet: "Bravo",
              parsedPlayerTag: "#QGRJ2222",
              parsedPlayerName: "Bravo",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: true, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: false, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#QGRJ2222",
              resolvedPlayerName: "Bravo",
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: [],
    };
    const confirmResult = {
      season: "2026-04",
      saved: [
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 1,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Alpha roster",
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as const;
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue(confirmResult as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationSheetService.buildImportPreview).toHaveBeenCalledWith({
      sheetLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      overwrite: false,
    });
    expect(cwlRotationSheetService.confirmImport).not.toHaveBeenCalled();
    expect(getDescription(interaction)).toContain("Importable clans: 1 / 1");
    expect(getDescription(interaction)).toContain("Clan: CWL Alpha (#2QG2C08UP)");
    expect(getDescription(interaction)).toContain("Day: Day 1");
    expect(getDescription(interaction)).toContain(":black_circle: Alpha #PYLQ0289 | Alpha");
    expect(getDescription(interaction)).toContain(":x: Bravo #QGRJ2222 | Bravo");
    expect(getDescription(interaction)).not.toContain("Alpha | #PYLQ0289 | 12 | IN");
    expect(getDescription(interaction)).not.toContain("Bravo | #QGRJ2222 | 8 |");

    expect(new Set(getComponentCustomIds(interaction)).size).toBe(getComponentCustomIds(interaction).length);
    expect(getComponentSelectMenuCustomIds(interaction)).toHaveLength(1);
    expect(getComponentSelectMenuOptions(interaction).map((option) => option.label)).toEqual(
      expect.arrayContaining([expect.stringContaining("CWL Alpha - 2/2")]),
    );

    const nextDayId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":preview-day:next:"));
    expect(nextDayId).toBeTruthy();
    const nextDayInteraction = {
      customId: nextDayId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(nextDayInteraction as any);
    expect(getUpdatedDescription(nextDayInteraction)).toContain("Day: Day 2");
    expect(getUpdatedDescription(nextDayInteraction)).toContain(":x: Alpha #PYLQ0289");
    expect(getUpdatedDescription(nextDayInteraction)).toContain(":black_circle: Bravo #QGRJ2222");

    const customIds = getComponentButtonCustomIds(nextDayInteraction);
    expect(customIds.some((id) => id.includes(":confirm:"))).toBe(true);

    const confirmId = customIds.find((id) => id.includes(":confirm:"));
    expect(confirmId).toBeTruthy();
    const confirmInteraction = {
      customId: confirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(confirmInteraction as any);

    expect(cwlRotationSheetService.confirmImport).toHaveBeenCalledTimes(1);
    expect(confirmInteraction.deferUpdate).toHaveBeenCalled();
    expect(confirmInteraction.editReply).toHaveBeenCalled();
  });

  it("switches preview clans directly, preserves the selected day, and surfaces unavailable clans for that day", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 1,
              rows: [{ playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 }],
              members: [{ playerTag: "#PYLQ0289", playerName: "Alpha", subbedOut: false, assignmentOrder: 0 }],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:3",
              sheetRowNumber: 3,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha | #PYLQ0289 | IN",
              parsedPlayerTag: "#PYLQ0289",
              parsedPlayerName: "Alpha",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: false, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: true, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#PYLQ0289",
              resolvedPlayerName: "Alpha",
              ignored: false,
            },
          ],
        },
        {
          clanTag: "#9GLGQCCU",
          clanName: "CWL Beta",
          tabTitle: "CWL Beta roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#QGRJ2222", playerName: "Bravo" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 1,
              rows: [{ playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 0 }],
              members: [{ playerTag: "#QGRJ2222", playerName: "Bravo", subbedOut: true, assignmentOrder: 0 }],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-beta-roster:3",
              sheetRowNumber: 3,
              tabTitle: "CWL Beta roster",
              clanTag: "#9GLGQCCU",
              clanName: "CWL Beta",
              rawText: "Bravo | #QGRJ2222 | OUT",
              rawPlayerNameSnippet: null,
              parsedPlayerTag: "#QGRJ2222",
              parsedPlayerName: "Bravo",
              classification: "exact_match",
              reason: null,
              suggestions: [],
              dayRows: [
                { roundDay: 1, subbedOut: true, assignmentOrder: 0 },
                { roundDay: 2, subbedOut: false, assignmentOrder: 1 },
                { roundDay: 3, subbedOut: true, assignmentOrder: 2 },
                { roundDay: 4, subbedOut: true, assignmentOrder: 3 },
                { roundDay: 5, subbedOut: true, assignmentOrder: 4 },
                { roundDay: 6, subbedOut: true, assignmentOrder: 5 },
                { roundDay: 7, subbedOut: true, assignmentOrder: 6 },
              ],
              resolvedPlayerTag: "#QGRJ2222",
              resolvedPlayerName: "Bravo",
              ignored: false,
            },
          ],
        },
        {
          clanTag: "#7X7X7X7X",
          clanName: "CWL Gamma",
          tabTitle: "CWL Gamma roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "No parsed rows",
          warnings: ["No parsed rows."],
          structuralRowCount: 2,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows: [],
          days: [],
          parsedRows: [],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["No parsed rows."],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(getDescription(interaction)).toContain("Clan: CWL Alpha (#2QG2C08UP)");
    expect(getDescription(interaction)).toContain("Day: Day 1");

    const clanOptions = getComponentSelectMenuOptions(interaction);
    expect(clanOptions.map((option) => option.label)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CWL Alpha - 1/1"),
        expect.stringContaining("CWL Beta - 1/1"),
        expect.stringContaining("CWL Gamma - 0/0"),
      ]),
    );
    expect(clanOptions.find((option) => option.label.includes("CWL Gamma"))?.description).toContain(
      "No usable rows for Day 1",
    );

    const clanSelectId = getComponentSelectMenuCustomIds(interaction).find((id) => id.includes(":preview-clan:"));
    expect(clanSelectId).toBeTruthy();
    const unavailableClanInteraction = {
      customId: clanSelectId,
      values: ["#7X7X7X7X"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportSelectMenuInteraction(unavailableClanInteraction as any);
    expect(unavailableClanInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("no usable rows for Day 1"),
        ephemeral: true,
      }),
    );

    const betaClanInteraction = {
      customId: clanSelectId,
      values: ["#9GLGQCCU"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportSelectMenuInteraction(betaClanInteraction as any);
    expect(getUpdatedDescription(betaClanInteraction)).toContain("Clan: CWL Beta (#9GLGQCCU)");
    expect(getUpdatedDescription(betaClanInteraction)).toContain("Day: Day 1");
    expect(getUpdatedDescription(betaClanInteraction)).toContain(":x: Bravo #QGRJ2222");
    expect(getUpdatedDescription(betaClanInteraction)).not.toContain("Bravo | #QGRJ2222 | OUT");

    const betaNextDayId = getComponentButtonCustomIds(betaClanInteraction).find((id) => id.includes(":preview-day:next:"));
    expect(betaNextDayId).toBeTruthy();
    const betaNextDayInteraction = {
      customId: betaNextDayId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportButtonInteraction(betaNextDayInteraction as any);
    expect(getUpdatedDescription(betaNextDayInteraction)).toContain("Clan: CWL Beta (#9GLGQCCU)");
    expect(getUpdatedDescription(betaNextDayInteraction)).toContain("Day: Day 2");
  });

  it("forces unresolved import rows through review before save and allows inline remap", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "1 row need review before save.",
          warnings: ["1 row need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 1,
          ignoredRowCount: 0,
          rosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Bravoo | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Bravoo",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [
                { playerTag: "#QGRJ2222", playerName: "Bravo", score: 0.87 },
              ],
              dayRows: [
                { roundDay: 1, subbedOut: false, assignmentOrder: 0 },
              ],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["1 row need review."],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    const confirmResult = {
      season: "2026-04",
      saved: [
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 1,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Alpha roster",
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as const;
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue(confirmResult as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(getComponentButtonCustomIds(interaction)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":review:"),
        expect.stringContaining(":confirm:"),
      ]),
    );
    expect(getDescription(interaction)).toContain(":warning: Bravoo");

    const reviewId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":review:"));
    expect(reviewId).toBeTruthy();
    const reviewInteraction = {
      customId: reviewId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(reviewInteraction as any);

    expect(getUpdatedDescription(reviewInteraction)).toContain("Review rows: 1");
    expect(getUpdatedDescription(reviewInteraction)).toContain("Sheet row: 4");
    expect(getUpdatedDescription(reviewInteraction)).toContain("Raw: Bravoo | 12 | IN");
    expect(new Set(getComponentButtonCustomIds(reviewInteraction)).size).toBe(getComponentButtonCustomIds(reviewInteraction).length);

    const reviewButtonIds = getComponentButtonCustomIds(reviewInteraction);
    const legacyReviewPageId = reviewButtonIds.find((id) => id.includes(":review-page:"));
    expect(legacyReviewPageId).toBeTruthy();
    const legacyReviewInteraction = {
      customId: String(legacyReviewPageId).replace(":review-page:prev:", ":review-page:").replace(":review-page:next:", ":review-page:"),
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(legacyReviewInteraction as any);
    expect(getUpdatedDescription(legacyReviewInteraction)).toContain("Sheet row: 4");

    const selectId = getComponentSelectMenuCustomIds(reviewInteraction).find((id) => id.includes(":resolve:"));
    expect(selectId).toBeTruthy();
    const selectInteraction = {
      customId: selectId,
      values: ["tag:#QGRJ2222"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(selectInteraction as any);

    expect(getUpdatedDescription(selectInteraction)).toContain("Review rows: 0");
    expect(getComponentButtonCustomIds(selectInteraction)).toEqual(
      expect.arrayContaining([expect.stringContaining(":confirm:")]),
    );
    expect(cwlRotationSheetService.confirmImport).not.toHaveBeenCalled();

    const confirmId = getComponentButtonCustomIds(selectInteraction).find((id) => id.includes(":confirm:"));
    expect(confirmId).toBeTruthy();
    const confirmClanInteraction = {
      customId: confirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(confirmClanInteraction as any);

    expect(getUpdatedDescription(confirmClanInteraction)).toContain("Importable clans: 1 / 1");
    expect(getUpdatedDescription(confirmClanInteraction)).toContain("CWL Alpha");
    expect(getUpdatedDescription(confirmClanInteraction)).not.toContain(":warning:");
    expect(getUpdatedDescription(confirmClanInteraction)).toContain(":black_circle: Bravo #QGRJ2222");
    expect(cwlRotationSheetService.confirmImport).not.toHaveBeenCalled();

    const saveId = getComponentButtonCustomIds(confirmClanInteraction).find((id) => id.includes(":confirm:"));
    expect(saveId).toBeTruthy();
    const saveInteraction = {
      customId: saveId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(saveInteraction as any);

    expect(cwlRotationSheetService.confirmImport).toHaveBeenCalledTimes(1);
    expect(saveInteraction.deferUpdate).toHaveBeenCalled();
    expect(saveInteraction.editReply).toHaveBeenCalled();
  });

  it("keeps review state isolated per clan and requires a clan confirmation boundary", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "1 row need review before save.",
          warnings: ["1 row need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 1,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
          trackedRosterRows: [{ playerTag: "#PYLQ0289", playerName: "Alpha" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Alpha-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [
                { playerTag: "#PYLQ0289", playerName: "Alpha", score: 0.9 },
              ],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
        {
          clanTag: "#9GLGQCCU",
          clanName: "CWL Beta",
          tabTitle: "CWL Beta roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "1 row need review before save.",
          warnings: ["1 row need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 1,
          ignoredRowCount: 0,
          rosterRows: [{ playerTag: "#QGRJ2222", playerName: "Bravo" }],
          trackedRosterRows: [{ playerTag: "#QGRJ2222", playerName: "Bravo" }],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-beta-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Beta roster",
              clanTag: "#9GLGQCCU",
              clanName: "CWL Beta",
              rawText: "Bravo-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Bravo-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [
                { playerTag: "#QGRJ2222", playerName: "Bravo", score: 0.9 },
              ],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["2 rows need review."],
    };
    const confirmResult = {
      season: "2026-04",
      saved: [
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          version: 2,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Alpha roster",
        },
        {
          outcome: "created",
          season: "2026-04",
          clanTag: "#9GLGQCCU",
          clanName: "CWL Beta",
          version: 1,
          dayCount: 1,
          warnings: [],
          sourceTabName: "CWL Beta roster",
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as const;
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue(confirmResult as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    const reviewId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":review:"));
    expect(reviewId).toBeTruthy();
    const reviewInteraction = {
      customId: reviewId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(reviewInteraction as any);
    expect(getUpdatedDescription(reviewInteraction)).toContain("Clan: CWL Alpha");
    expect(getUpdatedDescription(reviewInteraction)).toContain("Review rows: 1");

    const alphaOptions = getComponentSelectMenuOptions(reviewInteraction).map((option) => option.label);
    expect(alphaOptions).toEqual(expect.arrayContaining(["Alpha", "Ignore this row"]));
    expect(alphaOptions).not.toContain("Bravo");

    const alphaSelectId = getComponentSelectMenuCustomIds(reviewInteraction).find((id) => id.includes(":resolve:"));
    expect(alphaSelectId).toBeTruthy();
    const alphaSelectInteraction = {
      customId: alphaSelectId,
      values: ["tag:#PYLQ0289"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(alphaSelectInteraction as any);
    expect(getUpdatedDescription(alphaSelectInteraction)).toContain("Review rows: 0");
    expect(getComponentButtonCustomIds(alphaSelectInteraction)).toEqual(
      expect.arrayContaining([expect.stringContaining(":confirm:")]),
    );

    const alphaConfirmId = getComponentButtonCustomIds(alphaSelectInteraction).find((id) => id.includes(":confirm:"));
    expect(alphaConfirmId).toBeTruthy();
    const alphaConfirmInteraction = {
      customId: alphaConfirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(alphaConfirmInteraction as any);
    expect(getUpdatedDescription(alphaConfirmInteraction)).toContain("Clan: CWL Beta");

    const betaOptions = getComponentSelectMenuOptions(alphaConfirmInteraction).map((option) => option.label);
    expect(betaOptions).toEqual(expect.arrayContaining(["Bravo", "Ignore this row"]));
    expect(betaOptions).not.toContain("Alpha");

    const staleAlphaInteraction = {
      customId: alphaSelectId,
      values: ["tag:#PYLQ0289"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
    await handleCwlRotationImportSelectMenuInteraction(staleAlphaInteraction as any);
    expect(staleAlphaInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("expired"),
        ephemeral: true,
      }),
    );

    const betaSelectId = getComponentSelectMenuCustomIds(alphaConfirmInteraction).find((id) => id.includes(":resolve:"));
    expect(betaSelectId).toBeTruthy();
    const betaSelectInteraction = {
      customId: betaSelectId,
      values: ["tag:#QGRJ2222"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(betaSelectInteraction as any);
    expect(getUpdatedDescription(betaSelectInteraction)).toContain("Review rows: 0");
    expect(getComponentButtonCustomIds(betaSelectInteraction)).toEqual(
      expect.arrayContaining([expect.stringContaining(":confirm:")]),
    );

    const betaConfirmId = getComponentButtonCustomIds(betaSelectInteraction).find((id) => id.includes(":confirm:"));
    expect(betaConfirmId).toBeTruthy();
    const betaConfirmInteraction = {
      customId: betaConfirmId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(betaConfirmInteraction as any);
    expect(getUpdatedDescription(betaConfirmInteraction)).toContain("Importable clans: 2 / 2");

    const saveId = getComponentButtonCustomIds(betaConfirmInteraction).find((id) => id.includes(":confirm:"));
    expect(saveId).toBeTruthy();
    const saveInteraction = {
      customId: saveId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(saveInteraction as any);
    expect(cwlRotationSheetService.confirmImport).toHaveBeenCalledTimes(1);
    expect(saveInteraction.deferUpdate).toHaveBeenCalled();
    expect(saveInteraction.editReply).toHaveBeenCalled();
  });

  it("offers remaining tracked players as fallback mappings and prevents duplicate row mappings", async () => {
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: false,
          importBlockedReason: "2 rows need review before save.",
          warnings: ["2 rows need review."],
          structuralRowCount: 1,
          reviewRequiredRowCount: 2,
          ignoredRowCount: 0,
          rosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          trackedRosterRows: [
            { playerTag: "#PYLQ0289", playerName: "Alpha" },
            { playerTag: "#QGRJ2222", playerName: "Bravo" },
          ],
          days: [
            {
              roundDay: 1,
              lineupSize: 0,
              rows: [],
              members: [],
            },
          ],
          parsedRows: [
            {
              rowId: "cwl-alpha-roster:4",
              sheetRowNumber: 4,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Alpha-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Alpha-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
            {
              rowId: "cwl-alpha-roster:5",
              sheetRowNumber: 5,
              tabTitle: "CWL Alpha roster",
              clanTag: "#2QG2C08UP",
              clanName: "CWL Alpha",
              rawText: "Bravo-ish | 12 | IN",
              parsedPlayerTag: null,
              parsedPlayerName: "Bravo-ish",
              classification: "fuzzy_match_needs_review",
              reason: "Player row needs review before it can be saved.",
              suggestions: [],
              dayRows: [{ roundDay: 1, subbedOut: false, assignmentOrder: 0 }],
              resolvedPlayerTag: null,
              resolvedPlayerName: null,
              ignored: false,
            },
          ],
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: ["2 rows need review."],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);
    vi.mocked(cwlRotationSheetService.confirmImport).mockResolvedValue({
      season: "2026-04",
      saved: [],
      skippedTrackedClans: [],
      skippedTabs: [],
      ignoredRows: [],
    } as any);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    const reviewId = getComponentButtonCustomIds(interaction).find((id) => id.includes(":review:"));
    expect(reviewId).toBeTruthy();
    const reviewInteraction = {
      customId: reviewId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(reviewInteraction as any);

    const initialOptions = getComponentSelectMenuOptions(reviewInteraction);
    expect(initialOptions.map((option) => option.label)).toEqual(
      expect.arrayContaining(["Alpha", "Bravo", "Ignore this row"]),
    );
    expect(new Set(getComponentButtonCustomIds(reviewInteraction)).size).toBe(getComponentButtonCustomIds(reviewInteraction).length);

    const selectId = getComponentSelectMenuCustomIds(reviewInteraction).find((id) => id.includes(":resolve:"));
    expect(selectId).toBeTruthy();
    const firstSelectInteraction = {
      customId: selectId,
      values: ["tag:#PYLQ0289"],
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportSelectMenuInteraction(firstSelectInteraction as any);
    const secondOptions = getComponentSelectMenuOptions(firstSelectInteraction);
    expect(secondOptions.map((option) => option.label)).not.toContain("Alpha");
    expect(secondOptions.map((option) => option.label)).toEqual(
      expect.arrayContaining(["Bravo", "Ignore this row"]),
    );
    expect(new Set(getComponentButtonCustomIds(firstSelectInteraction)).size).toBe(getComponentButtonCustomIds(firstSelectInteraction).length);

    const nextReviewButtonId = getComponentButtonCustomIds(reviewInteraction).find((id) => id.includes(":review-page:next:"));
    expect(nextReviewButtonId).toBeTruthy();
    const nextReviewInteraction = {
      customId: nextReviewButtonId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(nextReviewInteraction as any);
    expect(getUpdatedDescription(nextReviewInteraction)).toContain("Sheet row: 5");
    expect(getUpdatedDescription(nextReviewInteraction)).toContain("Raw: Bravo-ish | 12 | IN");
    expect(new Set(getComponentButtonCustomIds(nextReviewInteraction)).size).toBe(getComponentButtonCustomIds(nextReviewInteraction).length);

    const legacyPrevButtonId = getComponentButtonCustomIds(nextReviewInteraction)
      .find((id) => id.includes(":review-page:prev:"))
      ?.replace(":review-page:prev:", ":review-page:");
    expect(legacyPrevButtonId).toBeTruthy();
    const legacyPrevInteraction = {
      customId: legacyPrevButtonId,
      user: { id: "111111111111111111" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleCwlRotationImportButtonInteraction(legacyPrevInteraction as any);
    expect(getUpdatedDescription(legacyPrevInteraction)).toContain("Sheet row: 5");
  });

  it("omits raw snippets when the preview would otherwise exceed Discord limits", async () => {
    const rosterRows = Array.from({ length: 110 }, (_, index) => {
      const playerTag = `#PX${String(index).padStart(4, "0")}`;
      const playerName = `Player ${index + 1}`;
      return { playerTag, playerName };
    });
    const parsedRows = rosterRows.map((row, index) => ({
      rowId: `cwl-alpha-roster:${index + 3}`,
      sheetRowNumber: index + 3,
      tabTitle: "CWL Alpha roster",
      clanTag: "#2QG2C08UP",
      clanName: "CWL Alpha",
      rawText: `${row.playerName} | ${row.playerTag} | IN | THIS RAW SNIPPET SHOULD BE OMITTED ${String(index).padStart(3, "0")}`,
      rawPlayerNameSnippet: row.playerName,
      parsedPlayerTag: row.playerTag,
      parsedPlayerName: row.playerName,
      classification: "exact_match" as const,
      reason: null,
      suggestions: [],
      dayRows: [
        { roundDay: 1, subbedOut: false, assignmentOrder: index },
        { roundDay: 2, subbedOut: true, assignmentOrder: index },
        { roundDay: 3, subbedOut: true, assignmentOrder: index },
        { roundDay: 4, subbedOut: true, assignmentOrder: index },
        { roundDay: 5, subbedOut: true, assignmentOrder: index },
        { roundDay: 6, subbedOut: true, assignmentOrder: index },
        { roundDay: 7, subbedOut: true, assignmentOrder: index },
      ],
      resolvedPlayerTag: row.playerTag,
      resolvedPlayerName: row.playerName,
      ignored: false,
    }));
    const preview: CwlRotationSheetImportPreview = {
      sourceSheetId: "sheet-1",
      sourceSheetTitle: "Imported CWL Planner",
      season: "2026-04",
      matchedClans: [
        {
          clanTag: "#2QG2C08UP",
          clanName: "CWL Alpha",
          tabTitle: "CWL Alpha roster",
          existingVersion: null,
          importable: true,
          importBlockedReason: null,
          warnings: [],
          structuralRowCount: 1,
          reviewRequiredRowCount: 0,
          ignoredRowCount: 0,
          rosterRows,
          days: [
            {
              roundDay: 1,
              lineupSize: rosterRows.length,
              rows: rosterRows.map((row, index) => ({
                playerTag: row.playerTag,
                playerName: row.playerName,
                subbedOut: false,
                assignmentOrder: index,
              })),
              members: rosterRows.map((row, index) => ({
                playerTag: row.playerTag,
                playerName: row.playerName,
                subbedOut: false,
                assignmentOrder: index,
              })),
            },
          ],
          parsedRows,
        },
      ],
      skippedTrackedClans: [],
      skippedTabs: [],
      warnings: [],
    };
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockResolvedValue(preview);

    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "https://docs.google.com/spreadsheets/d/sheet-1/edit";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    const description = getDescription(interaction);
    expect(description.length).toBeLessThanOrEqual(4096);
    expect(description).toContain("Day: Day 1");
    expect(description).toContain("Player 1 #PX0000");
    expect(description).toContain(`Player ${rosterRows.length} #PX${String(rosterRows.length - 1).padStart(4, "0")}`);
    expect(description).not.toContain("THIS RAW SNIPPET SHOULD BE OMITTED");
  });

  it("surfaces a clear message when the import sheet link format is unsupported", async () => {
    vi.mocked(cwlRotationSheetService.buildImportPreview).mockRejectedValueOnce(
      new Error(
        "Unsupported Google Sheets link format. Use a standard /spreadsheets/d/<id> link or a published /spreadsheets/d/e/<published-id>/pubhtml link.",
      ),
    );
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "import",
    });
    (interaction.options.getString as any).mockImplementation((name: string) => {
      if (name === "sheet") return "not-a-valid-link";
      if (name === "visibility") return null;
      return null;
    });
    (interaction.options.getBoolean as any).mockImplementation((name: string) => {
      if (name === "overwrite") return false;
      return null;
    });

    await Cwl.run({} as any, interaction as any);

    expect(String(interaction.editReply.mock.calls[0]?.[0] ?? "")).toContain(
      "Unsupported Google Sheets link format",
    );
  });

  it("exports active CWL planner data to a new public sheet", async () => {
    vi.mocked(cwlRotationSheetService.exportActivePlans).mockResolvedValue({
      spreadsheetId: "sheet-new",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing",
      tabCount: 1,
    });
    const interaction = makeInteraction({
      group: "rotations",
      subcommand: "export",
    });

    await Cwl.run({} as any, interaction as any);

    expect(cwlRotationSheetService.exportActivePlans).toHaveBeenCalled();
    expect(getDescription(interaction)).toContain("Created a new public Google Sheet");
    expect(getDescription(interaction)).toContain("https://docs.google.com/spreadsheets/d/sheet-new/edit?usp=sharing");
  });

  it("autocompletes /cwl rotations show day choices 1 through 7", async () => {
    const allDaysInteraction = makeAutocompleteInteraction("", "day");

    await Cwl.autocomplete(allDaysInteraction as any);

    expect(allDaysInteraction.respond).toHaveBeenCalledWith([
      { name: "Day 1", value: 1 },
      { name: "Day 2", value: 2 },
      { name: "Day 3", value: 3 },
      { name: "Day 4", value: 4 },
      { name: "Day 5", value: 5 },
      { name: "Day 6", value: 6 },
      { name: "Day 7", value: 7 },
    ]);

    const filteredInteraction = makeAutocompleteInteraction("2", "day");

    await Cwl.autocomplete(filteredInteraction as any);

    expect(filteredInteraction.respond).toHaveBeenCalledWith([{ name: "Day 2", value: 2 }]);
  });

  it("autocompletes tracked CWL clans from the persisted seasonal registry", async () => {
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "CWL Alpha", createdAt: new Date("2026-04-01T00:00:00.000Z") },
      { tag: "#9GLGQCCU", name: "CWL Beta", createdAt: new Date("2026-04-02T00:00:00.000Z") },
    ]);
    const interaction = makeAutocompleteInteraction("alpha");

    await Cwl.autocomplete(interaction as any);

    expect(prismaMock.cwlTrackedClan.findMany).toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "CWL Alpha (#2QG2C08UP)", value: "#2QG2C08UP" },
    ]);
  });

  it("autocompletes only current-season active CWL rotation clans for /cwl rotations show clan", async () => {
    vi.mocked(cwlRotationService.listActivePlanExports).mockResolvedValue([
      {
        season: "2026-04",
        clanTag: "#2QG2C08UP",
        clanName: "CWL Alpha",
        version: 1,
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
        rosterSize: 15,
        generatedFromRoundDay: null,
        excludedPlayerTags: [],
        warningSummary: null,
        metadata: null,
        days: [],
      } as any,
    ]);
    prismaMock.cwlTrackedClan.findMany.mockResolvedValue([
      { tag: "#2QG2C08UP", name: "CWL Alpha", createdAt: new Date("2026-04-01T00:00:00.000Z") },
      { tag: "#9GLGQCCU", name: "CWL Beta", createdAt: new Date("2026-04-02T00:00:00.000Z") },
    ]);
    const interaction = makeAutocompleteInteraction("alpha", "clan", null, "rotations", "show");

    await Cwl.autocomplete(interaction as any);

    expect(cwlRotationService.listActivePlanExports).toHaveBeenCalledWith({ season: "2026-04" });
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "CWL Alpha (#2QG2C08UP)", value: "#2QG2C08UP" },
    ]);
  });

  it("returns no roster autocomplete choices without a selected clan", async () => {
    const interaction = makeAutocompleteInteraction("ro", "roster", null);

    await Cwl.autocomplete(interaction as any);

    expect(rosterService.listCwlRostersForClan).not.toHaveBeenCalled();
    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  it("autocompletes roster-backed CWL rotations from the selected clan", async () => {
    (rosterService.listCwlRostersForClan as any).mockResolvedValue([
      { id: "roster-1", title: "CWL Alpha Roster", lifecycleState: "OPEN", clanTag: "#2QG2C08UP" },
      { id: "roster-2", title: "CWL Alpha Closed", lifecycleState: "CLOSED", clanTag: "#2QG2C08UP" },
    ]);
    const interaction = makeAutocompleteInteraction("alpha", "roster", "#2qg2c08up");

    await Cwl.autocomplete(interaction as any);

    expect(rosterService.listCwlRostersForClan).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#2QG2C08UP",
      query: "alpha",
      limit: 25,
    });
    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "CWL Alpha Roster", value: "roster-1" },
      { name: "CWL Alpha Closed", value: "roster-2" },
    ]);
  });
});
