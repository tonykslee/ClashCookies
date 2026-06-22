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

const defermentServiceMock = vi.hoisted(() => ({
  listOpenDeferredWeightRowsByClanAndPlayerTags: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/WeightInputDefermentService", async () => {
  const actual = await vi.importActual<typeof import("../src/services/WeightInputDefermentService")>(
    "../src/services/WeightInputDefermentService",
  );
  return {
    ...actual,
    listOpenDeferredWeightRowsByClanAndPlayerTags:
      defermentServiceMock.listOpenDeferredWeightRowsByClanAndPlayerTags,
  };
});

import {
  Roster,
  handleRosterPostClearButtonInteraction,
  handleRosterPostCustomizeMenuInteraction,
  handleRosterPostChangeGroupActionButtonInteraction,
  handleRosterPostChangeGroupGroupSelectInteraction,
  handleRosterPostChangeGroupPlayerSelectInteraction,
  handleRosterPostChangeGroupRosterSelectInteraction,
  handleRosterPostChangeRosterActionButtonInteraction,
  handleRosterPostChangeRosterCurrentRosterSelectInteraction,
  handleRosterPostChangeRosterPlayerSelectInteraction,
  handleRosterPostChangeRosterTargetGroupSelectInteraction,
  handleRosterPostChangeRosterTargetRosterSelectInteraction,
  handleRosterManageActionButtonInteraction,
  handleRosterManageWeightModalSubmit,
  handleRosterReportPingButtonInteraction,
  handleRosterPingActionButtonInteraction,
  handleRosterPostRefreshButtonInteraction,
  handleRosterPostSettingsButtonInteraction,
  handleRosterPostSettingsActionButtonInteraction,
  handleRosterPostSettingsMenuInteraction,
  paginateRosterSignupUserBlocks,
} from "../src/commands/Roster";
import { rosterService } from "../src/services/RosterService";
import * as rosterServiceModule from "../src/services/RosterService";
import {
  buildRosterPostChangeGroupActionButtonCustomId,
  buildRosterPostChangeGroupPlayerSelectMenuCustomId,
  buildRosterPostChangeGroupRosterSelectMenuCustomId,
  buildRosterPostChangeGroupCurrentGroupSelectMenuCustomId,
  buildRosterPostChangeGroupTargetGroupSelectMenuCustomId,
  buildRosterPostChangeRosterActionButtonCustomId,
  buildRosterPostChangeRosterCurrentRosterSelectMenuCustomId,
  buildRosterPostChangeRosterPlayerSelectMenuCustomId,
  buildRosterPostChangeRosterTargetGroupSelectMenuCustomId,
  buildRosterPostChangeRosterTargetRosterSelectMenuCustomId,
} from "../src/services/RosterService";
import * as rosterRoleSyncService from "../src/services/RosterRoleSyncService";
import { rosterExportService } from "../src/services/RosterExportService";
import { rosterWeightService } from "../src/services/RosterWeightService";
import * as playerLinkService from "../src/services/PlayerLinkService";
import * as cwlRegistryService from "../src/services/CwlRegistryService";
import { resolveCurrentCwlSeasonKey } from "../src/services/CwlRegistryService";

type RosterSubcommand =
  | "create"
  | "list"
  | "show"
  | "set"
  | "reset"
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
  columns?: string | null;
  players?: string | null;
  pingOption?: string | null;
  userId?: string | null;
  timezone?: string | null;
  displayTimezone?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  visitorSignupOpenTime?: string | null;
  maxMembers?: number | null;
  maxAccountsPerUser?: number | null;
  minTownhall?: number | null;
  maxTownhall?: number | null;
  minimumWeight?: number | null;
  requiredRole?: string | null;
  noRoleSignupLimit?: number | null;
  clearRequiredRole?: boolean | null;
  clearVisitorSignupOpenTime?: boolean | null;
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
        if (name === "columns") return input.columns ?? null;
        if (name === "group") return input.group ?? null;
        if (name === "players") return input.players ?? null;
        if (name === "ping_option") return input.pingOption ?? null;
        if (name === "timezone") return input.timezone ?? null;
        if (name === "display-timezone") return input.displayTimezone ?? null;
        if (name === "start_time") return input.startTime ?? null;
        if (name === "end_time") return input.endTime ?? null;
        if (name === "visitor_signup_open_time") return input.visitorSignupOpenTime ?? null;
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
        if (name === "minimum_weight") return input.minimumWeight ?? null;
        if (name === "no-role-signup-limit") return input.noRoleSignupLimit ?? null;
        return null;
      }),
      getRole: vi.fn((name: string) => {
        if (name === "required-role" && input.requiredRole) {
          return {
            id: input.requiredRole,
          };
        }
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "allow_multi_signup") return input.allowMultiSignup ?? null;
        if (name === "import_members") return input.importMembers ?? null;
        if (name === "delete_role") return input.deleteRole ?? null;
        if (name === "clear-required-role") return input.clearRequiredRole ?? null;
        if (name === "clear_visitor_signup_open_time") return input.clearVisitorSignupOpenTime ?? null;
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

function makeRosterRefreshPayload(refreshDisabled: boolean, title: string, description?: string) {
  const embed = new EmbedBuilder().setTitle(title);
  if (description) {
    embed.setDescription(description);
  }
  return {
    embed,
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

function makeRosterMutationPanelComponents(confirmCustomId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(confirmCustomId)
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${confirmCustomId}:cancel`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeValidRosterPlayerTag(index: number): string {
  const alphabet = ["0", "2", "8", "9"];
  const normalizedIndex = Math.max(0, Math.trunc(index));
  let remaining = normalizedIndex;
  const digits = [0, 0, 0, 0];
  for (let position = digits.length - 1; position >= 0; position -= 1) {
    digits[position] = remaining % alphabet.length;
    remaining = Math.trunc(remaining / alphabet.length);
  }
  return `#PQL${digits.map((digit) => alphabet[digit] ?? "0").join("")}`;
}

function makeRosterEmojiClient(options?: { missing?: string[] }) {
  const makeEmoji = (name: string, rendered: string) => ({
    id: `${name}-id`,
    name,
    animated: false,
    toString: () => rendered,
  });

  const missing = new Set((options?.missing ?? []).map((entry) => String(entry).trim()).filter(Boolean));
  const emojis = new Map(
    [
      ["yes", makeEmoji("yes", "<:yes:901>")],
      ["no", makeEmoji("no", "<:no:902>")],
      ...Array.from({ length: 18 }, (_, index) => {
        const name = `th${index + 1}`;
        return missing.has(name) ? null : ([name, makeEmoji(name, `<:${name}:${index + 1001}>`)] as const);
      }).filter((entry): entry is readonly [string, ReturnType<typeof makeEmoji>] => Boolean(entry)),
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
    defermentServiceMock.listOpenDeferredWeightRowsByClanAndPlayerTags.mockResolvedValue(new Map());
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
    vi.spyOn(rosterService, "createRosterPostChangeRosterPanel");
    vi.spyOn(rosterService, "getRosterGuildDisplayColumns");
    vi.spyOn(rosterService, "setRosterGuildDisplayColumns");
    vi.spyOn(rosterService, "resetRosterGuildDisplayColumns");
    vi.spyOn(rosterService, "updateRosterSelectionPanel");
    vi.spyOn(rosterService, "confirmRosterSelectionPanel");
    vi.spyOn(rosterService, "confirmRosterPingSelectionPanel");
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel");
    vi.spyOn(rosterService, "confirmRosterPostChangeRosterPanel");
    vi.spyOn(rosterService, "cancelRosterPostChangeRosterPanel");
    vi.spyOn(rosterService, "clearRosterSignups");
    vi.spyOn(rosterService, "getRosterView");
    vi.spyOn(rosterService, "getRosterRoleSyncTargets").mockResolvedValue(null as any);
    vi.spyOn(rosterService, "createRosterManageActionPanel");
    vi.spyOn(rosterService, "addRosterSignupsForManager");
    vi.spyOn(rosterService, "moveRosterSignups");
    vi.spyOn(rosterService, "removeRosterSignupsAsManager");
    vi.spyOn(rosterService, "changeRosterSignups");
    vi.spyOn(rosterService, "confirmRosterManageSession");
    vi.spyOn(rosterWeightService, "setManualWeightForRoster");
    vi.spyOn(rosterExportService, "createRosterExport");
    vi.spyOn(cwlRegistryService, "refreshCwlTrackedClanMetadataForSeason").mockResolvedValue({
      season: resolveCurrentCwlSeasonKey(),
      requestedCount: 0,
      ensuredCount: 0,
      hydratedCount: 0,
      skippedCount: 0,
    });
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
        visitorSignupOpensAt: null,
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
      minimumWeight: 145000,
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.createRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "CWL Alpha Signup",
        minimumWeight: 145000,
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Use /roster post roster:roster-2 to publish it.",
    );
  });

  it("parses visitor signup opening time in the selected roster timezone when creating a roster", async () => {
    (rosterService.createRoster as any).mockResolvedValue({ id: "roster-4" });

    const interaction = makeInteraction({
      subcommand: "create",
      clan: "#2QG2C08UP",
      timezone: "America/Los_Angeles",
      visitorSignupOpenTime: "2026-07-01 12:00",
    }) as any;

    await Roster.run({} as any, interaction as any);

    const createPayload = rosterService.createRoster.mock.calls.at(-1)?.[0] as any;
    expect(createPayload.visitorSignupOpensAt).toEqual(new Date("2026-07-01T19:00:00.000Z"));
    expect(createPayload.timezone).toBe("America/Los_Angeles");
  });

  it("rejects an invalid visitor signup opening time during roster create", async () => {
    const interaction = makeInteraction({
      subcommand: "create",
      clan: "#2QG2C08UP",
      timezone: "America/Los_Angeles",
      visitorSignupOpenTime: "not-a-date",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Invalid visitor_signup_open_time. Use YYYY-MM-DD HH:mm with a valid timezone.",
    );
    expect(rosterService.createRoster).not.toHaveBeenCalled();
  });

  it("hydrates CWL tracked metadata before deriving the default CWL roster name", async () => {
    (rosterService.createRoster as any).mockResolvedValue({ id: "roster-2" });
    prismaMock.cwlTrackedClan.findFirst
      .mockResolvedValueOnce({ tag: "#2QG2C08UP", name: "Old Name", leagueLabel: "Champion League II" })
      .mockResolvedValueOnce({ tag: "#2QG2C08UP", name: "RISING DAWN", leagueLabel: "Masters I [D] | TH18 175k+ WW" });

    const interaction = makeInteraction({
      subcommand: "create",
      clan: "#2QG2C08UP",
      timezone: "America/Los_Angeles",
    }) as any;

    const cwlCreateCocService = {
      getClan: vi.fn().mockResolvedValue({ name: "RISING DAWN", warLeague: { name: "Masters I [D] | TH18 175k+ WW" } }),
    } as any;

    await Roster.run({} as any, interaction as any, cwlCreateCocService);

    expect(cwlRegistryService.refreshCwlTrackedClanMetadataForSeason).toHaveBeenCalledWith(
      expect.objectContaining({
        clanTags: ["#2QG2C08UP"],
        season: resolveCurrentCwlSeasonKey(),
        cocService: expect.anything(),
        ensureRows: false,
      }),
    );
    expect(rosterService.createRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `RISING DAWN CWL Signup (${resolveCurrentCwlSeasonKey()})`,
      }),
    );
  });

  it("defaults signup role limits to zero when creating a role-gated roster", async () => {
    (rosterService.createRoster as any).mockResolvedValue({ id: "roster-3" });

    const interaction = makeInteraction({
      subcommand: "create",
      clan: "#2QG2C08UP",
      title: "Role-gated roster",
      timezone: "America/Los_Angeles",
      requiredRole: "123456789012345678",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.createRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredSignupRoleId: "123456789012345678",
        noRoleSignupLimit: 0,
      }),
    );
  });

  it("shows the guild default roster columns through /roster show", async () => {
    (rosterService.getRosterGuildDisplayColumns as any).mockResolvedValue({
      columns: ["townhall_icons", "discord_username", "player_name", "player_tag"],
      source: "server_override",
    });

    const interaction = makeInteraction({
      subcommand: "show",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.getRosterGuildDisplayColumns).toHaveBeenCalledWith({
      guildId: "guild-1",
    });
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain("Source: Server override");
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
      "Current layout: `townhall_icons | discord_username | player_name | player_tag`",
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain("`townhall_icons`");
  });

  it("shows the built-in roster columns through /roster show when the guild has no override", async () => {
    (rosterService.getRosterGuildDisplayColumns as any).mockResolvedValue({
      columns: ["townhall_icons", "discord_username", "player_name", "player_tag"],
      source: "built_in",
    });

    const interaction = makeInteraction({
      subcommand: "show",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.getRosterGuildDisplayColumns).toHaveBeenCalledWith({
      guildId: "guild-1",
    });
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain("Source: Built-in");
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
      "Current layout: `townhall_icons | discord_username | player_name | player_tag`",
    );
  });

  it("saves guild default roster columns through /roster set", async () => {
    (rosterService.setRosterGuildDisplayColumns as any).mockResolvedValue({
      columns: ["townhall_icons", "discord_username", "player_name", "player_tag"],
      source: "server_override",
    });

    const interaction = makeInteraction({
      subcommand: "set",
      columns: "townhall_icons, discord_username, player_name, player_tag",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.setRosterGuildDisplayColumns).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        displayColumns: ["townhall_icons", "discord_username", "player_name", "player_tag"],
        updatedByDiscordUserId: "111111111111111111",
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
      "Saved layout: `townhall_icons | discord_username | player_name | player_tag`",
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain("Source: Server override");
  });

  it("rejects empty roster display columns before saving a guild override", async () => {
    const interaction = makeInteraction({
      subcommand: "set",
      columns: "   ",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.setRosterGuildDisplayColumns).not.toHaveBeenCalled();
  });

  it("resets guild default roster columns through /roster reset", async () => {
    (rosterService.resetRosterGuildDisplayColumns as any).mockResolvedValue({
      columns: ["townhall_icons", "discord_username", "player_name", "player_tag"],
      source: "built_in",
    });

    const interaction = makeInteraction({
      subcommand: "reset",
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.resetRosterGuildDisplayColumns).toHaveBeenCalledWith({
      guildId: "guild-1",
    });
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
      "Reset to built-in layout: `townhall_icons | discord_username | player_name | player_tag`",
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain("Source: Built-in");
  });

  it("can clear the signup role requirement while preserving the no-role allowance", async () => {
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
    (rosterService.updateRoster as any).mockResolvedValue({
      id: "roster-1",
    });

    const interaction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      clearRequiredRole: true,
      noRoleSignupLimit: 2,
    }) as any;

    await Roster.run({} as any, interaction as any);

    expect(rosterService.updateRoster).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        requiredSignupRoleId: null,
        noRoleSignupLimit: 2,
      }),
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
      groups: [
        { id: "group-confirmed", key: "confirmed", name: "Confirmed", description: null, sortOrder: 0 },
        { id: "group-substitute", key: "substitute", name: "Substitute", description: null, sortOrder: 1 },
      ],
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

  it("renders linked roster signups for the selected Discord user", async () => {
    vi.spyOn(rosterService, "listRosterSignupsForDiscordUser").mockResolvedValue({
      discordUserId: "222222222222222222",
      linkedAccountCount: 3,
      signupCount: 3,
      sections: [
        {
          roster: {
            id: "roster-1",
            guildId: "guild-1",
            rosterType: "CWL",
            rosterCategory: "signup",
            title: "Masters 2 [C] | TH17",
            clanTag: "#2P0J0YL8",
            startsAt: new Date("2026-04-20T00:00:00.000Z"),
            endsAt: null,
            timezone: "America/Los_Angeles",
            displayTimezone: "America/Los_Angeles",
            maxMembers: 40,
            maxAccountsPerUser: 2,
            minTownhall: 17,
            maxTownhall: 17,
            requiredSignupRoleId: null,
            noRoleSignupLimit: 0,
            rosterRoleId: null,
            allowMultiSignup: true,
            sortBy: null,
            displayColumns: null,
            importMembers: false,
            postButtonMode: "standard",
            lifecycleState: "OPEN",
            postedChannelId: null,
            postedMessageId: null,
            postedMessageUrl: null,
            postedAt: null,
            createdByDiscordUserId: null,
            updatedByDiscordUserId: null,
            createdAt: new Date("2026-04-20T00:00:00.000Z"),
            updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          },
          clanName: "Serenity",
          groups: [
            {
              id: "confirmed",
              key: "confirmed",
              name: "Confirmed",
              description: null,
              sortOrder: 0,
              signups: [
                {
                  playerTag: "#GGYLPVCUQ",
                  playerName: "Charmander",
                  townHall: 18,
                  signedUpAt: new Date("2026-04-20T10:00:00.000Z"),
                },
              ],
            },
            {
              id: "substitute",
              key: "substitute",
              name: "Substitute",
              description: null,
              sortOrder: 1,
              signups: [
                {
                  playerTag: "#YJCLLYU8C",
                  playerName: "Bulbasaur",
                  townHall: 17,
                  signedUpAt: new Date("2026-04-20T11:00:00.000Z"),
                },
              ],
            },
          ],
        },
        {
          roster: {
            id: "roster-2",
            guildId: "guild-1",
            rosterType: "FWA",
            rosterCategory: "signup",
            title: "FWA Beta Signup",
            clanTag: null,
            startsAt: new Date("2026-04-22T00:00:00.000Z"),
            endsAt: null,
            timezone: "America/Los_Angeles",
            displayTimezone: "America/Los_Angeles",
            maxMembers: 30,
            maxAccountsPerUser: 1,
            minTownhall: null,
            maxTownhall: null,
            requiredSignupRoleId: null,
            noRoleSignupLimit: 0,
            rosterRoleId: null,
            allowMultiSignup: true,
            sortBy: null,
            displayColumns: null,
            importMembers: false,
            postButtonMode: "standard",
            lifecycleState: "CLOSED",
            postedChannelId: null,
            postedMessageId: null,
            postedMessageUrl: null,
            postedAt: null,
            createdByDiscordUserId: null,
            updatedByDiscordUserId: null,
            createdAt: new Date("2026-04-22T00:00:00.000Z"),
            updatedAt: new Date("2026-04-22T00:00:00.000Z"),
          },
          clanName: "Beta Force",
          groups: [
            {
              id: "__ungrouped__",
              key: "__ungrouped__",
              name: "Ungrouped",
              description: null,
              sortOrder: Number.MAX_SAFE_INTEGER,
              signups: [
                {
                  playerTag: makeValidRosterPlayerTag(1),
                  playerName: "Pikachu",
                  townHall: null,
                  signedUpAt: new Date("2026-04-22T10:00:00.000Z"),
                },
              ],
            },
          ],
        },
      ],
    });

    const interaction = makeInteraction({
      subcommand: "list",
      userId: "222222222222222222",
    }) as any;
    interaction.client = makeRosterEmojiClient();

    await Roster.run({} as any, interaction as any);

    expect(rosterService.listRosterSignupsForDiscordUser).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        discordUserId: "222222222222222222",
      }),
    );
    const payload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
    expect(Array.isArray(payload?.embeds)).toBe(true);
    expect(payload.embeds).toHaveLength(1);
    const firstEmbed = payload.embeds[0]?.toJSON?.() ?? payload.embeds[0];
    expect(String(firstEmbed?.title ?? "")).toBe("Roster Signups");
    expect(String(firstEmbed?.description ?? "")).toContain("User: <@222222222222222222>");
    expect(String(firstEmbed?.description ?? "")).toContain(
      "Masters 2 [C] | TH17 ([Serenity](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2P0J0YL8>))",
    );
    expect(String(firstEmbed?.description ?? "")).toContain("Confirmed");
    expect(String(firstEmbed?.description ?? "")).toContain("<:th18:1018> Charmander `#GGYLPVCUQ`");
    expect(String(firstEmbed?.description ?? "")).toContain("Substitute");
    expect(String(firstEmbed?.description ?? "")).toContain("<:th17:1017> Bulbasaur `#YJCLLYU8C`");
    expect(String(firstEmbed?.description ?? "")).toContain("FWA Beta Signup (Beta Force)");
    expect(String(firstEmbed?.description ?? "")).toContain("Ungrouped");
    expect(String(firstEmbed?.description ?? "")).toContain(`TH? Pikachu \`${makeValidRosterPlayerTag(1)}\``);
    expect(String(firstEmbed?.description ?? "")).not.toMatch(/(?:^|\n):th18:/i);
    expect(String(firstEmbed?.description ?? "")).not.toMatch(/(?:^|\n):th17:/i);
  });

  it("falls back to readable TH text when a custom town hall emoji is missing", async () => {
    vi.spyOn(rosterService, "listRosterSignupsForDiscordUser").mockResolvedValue({
      discordUserId: "222222222222222222",
      linkedAccountCount: 1,
      signupCount: 1,
      sections: [
        {
          roster: {
            id: "roster-1",
            guildId: "guild-1",
            rosterType: "CWL",
            rosterCategory: "signup",
            title: "Masters 2 [C] | TH17",
            clanTag: "#2P0J0YL8",
            startsAt: new Date("2026-04-20T00:00:00.000Z"),
            endsAt: null,
            timezone: "America/Los_Angeles",
            displayTimezone: "America/Los_Angeles",
            maxMembers: 40,
            maxAccountsPerUser: 2,
            minTownhall: 17,
            maxTownhall: 17,
            requiredSignupRoleId: null,
            noRoleSignupLimit: 0,
            rosterRoleId: null,
            allowMultiSignup: true,
            sortBy: null,
            displayColumns: null,
            importMembers: false,
            postButtonMode: "standard",
            lifecycleState: "OPEN",
            postedChannelId: null,
            postedMessageId: null,
            postedMessageUrl: null,
            postedAt: null,
            createdByDiscordUserId: null,
            updatedByDiscordUserId: null,
            createdAt: new Date("2026-04-20T00:00:00.000Z"),
            updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          },
          clanName: "Serenity",
          groups: [
            {
              id: "confirmed",
              key: "confirmed",
              name: "Confirmed",
              description: null,
              sortOrder: 0,
              signups: [
                {
                  playerTag: "#GGYLPVCUQ",
                  playerName: "Charmander",
                  townHall: 18,
                  signedUpAt: new Date("2026-04-20T10:00:00.000Z"),
                },
              ],
            },
          ],
        },
      ],
    });

    const interaction = makeInteraction({
      subcommand: "list",
      userId: "222222222222222222",
    }) as any;
    interaction.client = makeRosterEmojiClient({ missing: ["th18"] });

    await Roster.run({} as any, interaction as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
    const firstEmbed = payload.embeds[0]?.toJSON?.() ?? payload.embeds[0];
    expect(String(firstEmbed?.description ?? "")).toContain("TH18 Charmander `#GGYLPVCUQ`");
    expect(String(firstEmbed?.description ?? "")).not.toMatch(/(?:^|\n)<:th18:/i);
  });

  it("shows an empty state when the selected user has no linked roster signups", async () => {
    vi.spyOn(rosterService, "listRosterSignupsForDiscordUser").mockResolvedValue({
      discordUserId: "222222222222222222",
      linkedAccountCount: 2,
      signupCount: 0,
      sections: [],
    });

    const interaction = makeInteraction({
      subcommand: "list",
      userId: "222222222222222222",
    }) as any;
    interaction.client = makeRosterEmojiClient({ missing: ["th18"] });

    await Roster.run({} as any, interaction as any);

    expect(String(interaction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "No linked accounts for <@222222222222222222> are signed up for current rosters.",
    );
  });

  it("keeps roster sections atomic across list pagination when a section is large", async () => {
    const largeRosterBlock = [
      "Masters 2 [C] | TH17 ([Serenity](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2P0J0YL8>))",
      "Confirmed",
      ...Array.from({ length: 157 }, (_, index) => `TH18 Player ${index + 1} \`${makeValidRosterPlayerTag(index)}\``),
    ].join("\n");
    const secondRosterBlock = [
      "FWA Beta Signup (Beta Force)",
      "Ungrouped",
      `TH? Pikachu \`${makeValidRosterPlayerTag(1)}\``,
    ].join("\n");

    const pages = paginateRosterSignupUserBlocks([largeRosterBlock, secondRosterBlock]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("Masters 2 [C] | TH17");
    expect(pages[0]).not.toContain("FWA Beta Signup");
    expect(pages[1]).toContain("FWA Beta Signup");
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
      groups: [
        { key: "confirmed", name: "Confirmed" },
        { key: "substitute", name: "Substitute" },
      ],
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
      warnings: ["Override: Alpha (#PQL0289) was already signed up on Champions CWL."],
    });
    (rosterService.moveRosterSignups as any)
      .mockResolvedValueOnce({
        outcome: "moved",
        rosterId: "roster-1",
        groupKey: "confirmed",
        groupName: "Confirmed",
        requestedTags: ["#PQL0289"],
        movedTags: ["#PQL0289"],
        duplicateTags: [],
        missingTags: [],
      })
      .mockResolvedValueOnce({
        outcome: "moved",
        rosterId: "roster-1",
        groupKey: "substitute",
        groupName: "Substitute",
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
      warnings: ["Override: Alpha (#PQL0289) was already signed up on Champions CWL."],
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
    expect(String(addInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Override: Alpha (#PQL0289) was already signed up on Champions CWL.",
    );
    const getRosterViewCallsBeforeMove = rosterService.getRosterView.mock.calls.length;

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
        groupKey: "confirmed",
        playerTags: ["#PQL0289"],
      }),
    );
    expect(String(moveInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Changed group for #PQL0289 to Confirmed",
    );
    expect(rosterService.getRosterView.mock.calls.length).toBe(getRosterViewCallsBeforeMove + 1);

    const moveTargetInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
      group: "confirmed",
      targetGroup: "substitute",
      players: "#PQL0289",
    }) as any;
    await Roster.run({} as any, moveTargetInteraction as any);
    expect(rosterService.moveRosterSignups).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        groupKey: "substitute",
        playerTags: ["#PQL0289"],
      }),
    );
    expect(String(moveTargetInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Changed group for #PQL0289 to Substitute",
    );

    const moveWithTargetRosterInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
      targetRoster: "roster-2",
      targetGroup: "substitute",
      players: "#PQL0289",
    }) as any;
    const moveCallsBeforeTargetRoster = rosterService.moveRosterSignups.mock.calls.length;
    await Roster.run({} as any, moveWithTargetRosterInteraction as any);
    expect(rosterService.moveRosterSignups.mock.calls.length).toBe(moveCallsBeforeTargetRoster);
    expect(String(moveWithTargetRosterInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toBe(
      "Use action:change_roster to move players to another roster. Use Change Group only for changing groups inside the same roster.",
    );

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
      "Moved Alpha (#PQL0289) to Target Roster - Confirmed.",
    );
    expect(String(changeInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Override: Alpha (#PQL0289) was already signed up on Champions CWL.",
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

    (rosterService.createRosterManageActionPanel as any).mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-1",
        action: "add",
        embed: new EmbedBuilder().setTitle("Manage Roster — Add Player"),
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("roster-manage:action:confirm:session-1")
              .setLabel("Confirm")
              .setStyle(ButtonStyle.Success),
          ),
        ],
      },
    });

    const managedInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "add",
      userId: "222222222222222222",
    }) as any;
    await Roster.run({} as any, managedInteraction as any);

    expect(rosterService.createRosterManageActionPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        rosterId: "roster-1",
        action: "add",
        discordUserId: "111111111111111111",
        selectedDiscordUserId: "222222222222222222",
      }),
    );
    expect(managedInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: expect.arrayContaining([expect.any(ActionRowBuilder)]),
      }),
    );

    (rosterService.createRosterManageActionPanel as any).mockReset();

    const missingUserInteraction = makeInteraction({
      subcommand: "manage",
      roster: "roster-1",
      action: "remove",
    }) as any;
    await Roster.run({} as any, missingUserInteraction as any);

    expect(String(missingUserInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toBe(
      "Select a user to manage accounts for this action.",
    );
    expect(rosterService.createRosterManageActionPanel).not.toHaveBeenCalled();

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
      minimumWeight: 145000,
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
        minimumWeight: 145000,
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

  it("renders the roster weight instructions panel with the legacy open button", async () => {
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
        minimumWeight: 145000,
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
    vi.spyOn(rosterServiceModule, "getRosterManageSession").mockReturnValue({
      sessionId: "session-1",
      action: "set_weight",
      guildId: "guild-1",
      rosterId: "roster-1",
      rosterTitle: "CWL Alpha Signup",
      rosterLifecycleState: "OPEN",
      rosterClanTag: "#2QG2C08UP",
      rosterClanName: "CWL Alpha",
      ownerDiscordUserId: "111111111111111111",
      selectedDiscordUserId: "111111111111111111",
      selectedDiscordUserLabel: "Roster User (@rosteruser)",
      rosterSignups: [],
      selectedPlayerTags: ["#PQL0289"],
      selectedGroupKey: null,
      selectedTargetRosterId: null,
      selectedTargetGroupKey: null,
      playerOptions: [],
      blockedPlayerOptions: [],
      groupOptions: [],
      targetRosterOptions: [],
      targetGroupOptions: [],
      playerPageWindowStart: 0,
      createdAtMs: Date.now(),
    } as any);
    const interaction = {
      customId: "roster-manage:action:open_weight:session-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      showModal: vi.fn().mockResolvedValue(undefined),
      deferUpdate: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterManageActionButtonInteraction(interaction);

    expect(interaction.showModal).toHaveBeenCalledWith(expect.anything());
    const modal = interaction.showModal.mock.calls[0]?.[0] as any;
    expect(modal.toJSON?.().custom_id).toBe("roster-manage-weight:submit:roster-1:#PQL0289");
    expect(modal.toJSON?.().title).toBe("Set Weight");
  });

  it("rejects interactive set_weight when zero or multiple players are selected", async () => {
    const sessionSpy = vi.spyOn(rosterServiceModule, "getRosterManageSession");
    sessionSpy.mockReturnValueOnce({
      sessionId: "session-1",
      action: "set_weight",
      guildId: "guild-1",
      rosterId: "roster-1",
      rosterTitle: "CWL Alpha Signup",
      rosterLifecycleState: "OPEN",
      rosterClanTag: "#2QG2C08UP",
      rosterClanName: "CWL Alpha",
      ownerDiscordUserId: "111111111111111111",
      selectedDiscordUserId: "111111111111111111",
      selectedDiscordUserLabel: "Roster User (@rosteruser)",
      rosterSignups: [],
      selectedPlayerTags: [],
      selectedGroupKey: null,
      selectedTargetRosterId: null,
      selectedTargetGroupKey: null,
      playerOptions: [],
      blockedPlayerOptions: [],
      groupOptions: [],
      targetRosterOptions: [],
      targetGroupOptions: [],
      playerPageWindowStart: 0,
      createdAtMs: Date.now(),
    } as any);
    const zeroInteraction = {
      customId: "roster-manage:action:open_weight:session-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      showModal: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterManageActionButtonInteraction(zeroInteraction);
    expect(String(zeroInteraction.reply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
      "Select exactly one linked player",
    );

    sessionSpy.mockReturnValueOnce({
      sessionId: "session-2",
      action: "set_weight",
      guildId: "guild-1",
      rosterId: "roster-1",
      rosterTitle: "CWL Alpha Signup",
      rosterLifecycleState: "OPEN",
      rosterClanTag: "#2QG2C08UP",
      rosterClanName: "CWL Alpha",
      ownerDiscordUserId: "111111111111111111",
      selectedDiscordUserId: "111111111111111111",
      selectedDiscordUserLabel: "Roster User (@rosteruser)",
      rosterSignups: [],
      selectedPlayerTags: [makeValidRosterPlayerTag(1), makeValidRosterPlayerTag(2)],
      selectedGroupKey: null,
      selectedTargetRosterId: null,
      selectedTargetGroupKey: null,
      playerOptions: [],
      blockedPlayerOptions: [],
      groupOptions: [],
      targetRosterOptions: [],
      targetGroupOptions: [],
      playerPageWindowStart: 0,
      createdAtMs: Date.now(),
    } as any);
    const multiInteraction = {
      customId: "roster-manage:action:open_weight:session-2",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      showModal: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterManageActionButtonInteraction(multiInteraction);
    expect(String(multiInteraction.reply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
      "Select exactly one linked player",
    );
  });

  it("disables the manage panel while the interactive manage flow confirms", async () => {
    const syncSpy = vi.spyOn(rosterRoleSyncService, "syncRosterRoleAssignments");
    (rosterService.confirmRosterManageSession as any).mockResolvedValue({
      outcome: "completed",
      action: "add",
      rosterId: "roster-1",
      targetRosterId: null,
      summary: "Signed up #PQL0289 to Confirmed.",
    });
    const interaction = {
      customId: "roster-manage:action:confirm:session-1",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      message: {
        components: makeRosterMutationPanelComponents("roster-manage:action:confirm:session-1"),
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    } as any;

    await handleRosterManageActionButtonInteraction(interaction, {} as any);

    expect(rosterService.confirmRosterManageSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        discordUserId: "111111111111111111",
      }),
    );
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.arrayContaining([
          expect.objectContaining({
            components: expect.arrayContaining([
              expect.objectContaining({
                disabled: true,
                label: "Applying changes...",
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(syncSpy).not.toHaveBeenCalled();
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
        minimumWeight: 145000,
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
        minimumWeight: 145000,
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
    expect(String(payload.embeds[0]?.toJSON?.().description ?? "")).toContain("Min. Weight: 145k");
    const menu = payload.components[0]?.toJSON?.().components?.[0];
    const optionValues = menu?.options?.map((option: any) => option.value) ?? [];
    expect(optionValues).toEqual([
      "export",
      "customize",
      "change_group",
      "change_roster",
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

  it("opens the roster change group panel from Settings -> Change Group", async () => {
    vi.spyOn(rosterService, "createRosterPostChangeGroupPanel").mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-1",
        embed: new EmbedBuilder().setTitle("Change Group"),
        components: [],
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
      values: ["change_group"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostSettingsMenuInteraction(interaction, {} as any);

    expect(rosterService.createRosterPostChangeGroupPanel).toHaveBeenCalledWith({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("opens the roster change roster panel from Settings -> Change Roster", async () => {
    vi.spyOn(rosterService, "createRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
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
      values: ["change_roster"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostSettingsMenuInteraction(interaction, {} as any);

    expect(rosterService.createRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("opens the roster change roster panel from Settings -> Change Roster", async () => {
    vi.spyOn(rosterService, "createRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "ready",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
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
      values: ["change_roster"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostSettingsMenuInteraction(interaction, {} as any);

    expect(rosterService.createRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      rosterId: "roster-1",
      discordUserId: "111111111111111111",
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Group panel when the current roster select changes", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeGroupPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-1",
        embed: new EmbedBuilder().setTitle("Change Group"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeGroupRosterSelectMenuCustomId("session-1"),
      values: ["roster-2"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeGroupRosterSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeGroupPanel).toHaveBeenCalledWith({
      sessionId: "session-1",
      discordUserId: "111111111111111111",
      selectedCurrentRosterId: "roster-2",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when the current roster select changes", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterCurrentRosterSelectMenuCustomId("session-2"),
      values: ["roster-2"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterCurrentRosterSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedCurrentRosterId: "roster-2",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when the current roster select changes", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterCurrentRosterSelectMenuCustomId("session-2"),
      values: ["roster-2"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterCurrentRosterSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedCurrentRosterId: "roster-2",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it.each([
    ["current", buildRosterPostChangeGroupCurrentGroupSelectMenuCustomId("session-1"), "confirmed", "selectedCurrentGroupKey"],
    ["target", buildRosterPostChangeGroupTargetGroupSelectMenuCustomId("session-1"), "substitute", "selectedTargetGroupKey"],
  ] as const)("updates the Change Group panel when the %s group select changes", async (_kind, customId, value, fieldName) => {
    vi.spyOn(rosterService, "updateRosterPostChangeGroupPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-1",
        embed: new EmbedBuilder().setTitle("Change Group"),
        components: [],
      },
    });
    const interaction = {
      customId,
      values: [value],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeGroupGroupSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeGroupPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        discordUserId: "111111111111111111",
        [fieldName]: value,
      }),
    );
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Group panel when player selections change", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeGroupPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-1",
        embed: new EmbedBuilder().setTitle("Change Group"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeGroupPlayerSelectMenuCustomId("session-1", 0),
      values: ["#PQL0289", "#QGRJ2222"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeGroupPlayerSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeGroupPanel).toHaveBeenCalledWith({
      sessionId: "session-1",
      discordUserId: "111111111111111111",
      selectedPlayerTags: ["#PQL0289", "#QGRJ2222"],
      selectedPlayerPageIndex: 0,
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when the target roster select changes", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterTargetRosterSelectMenuCustomId("session-2"),
      values: ["roster-3"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterTargetRosterSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedTargetRosterId: "roster-3",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when the target group select changes", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterTargetGroupSelectMenuCustomId("session-2"),
      values: ["confirmed"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterTargetGroupSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedTargetGroupKey: "confirmed",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when player selections change", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterPlayerSelectMenuCustomId("session-2", 0),
      values: ["#PQL0289", "#QGRJ2222"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterPlayerSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedPlayerTags: ["#PQL0289", "#QGRJ2222"],
      selectedPlayerPageIndex: 0,
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when the target roster select changes", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterTargetRosterSelectMenuCustomId("session-2"),
      values: ["roster-3"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterTargetRosterSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedTargetRosterId: "roster-3",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when the target group select changes", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterTargetGroupSelectMenuCustomId("session-2"),
      values: ["confirmed"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterTargetGroupSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedTargetGroupKey: "confirmed",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("updates the Change Roster panel when player selections change", async () => {
    vi.spyOn(rosterService, "updateRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "updated",
      panel: {
        sessionId: "session-2",
        embed: new EmbedBuilder().setTitle("Change Roster"),
        components: [],
      },
    });
    const interaction = {
      customId: buildRosterPostChangeRosterPlayerSelectMenuCustomId("session-2", 0),
      values: ["#PQL0289", "#QGRJ2222"],
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterPlayerSelectInteraction(interaction);

    expect(rosterService.updateRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      selectedPlayerTags: ["#PQL0289", "#QGRJ2222"],
      selectedPlayerPageIndex: 0,
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
        components: [],
      }),
    );
  });

  it("confirms Change Group, syncs roster roles, and refreshes the roster post", async () => {
    vi.spyOn(rosterService, "confirmRosterPostChangeGroupPanel").mockResolvedValue({
      outcome: "completed",
      rosterId: "roster-1",
      currentGroupKey: "confirmed",
      targetGroupKey: "substitute",
      selectedCount: 1,
      moveResult: {
        outcome: "moved",
        rosterId: "roster-1",
        groupKey: "substitute",
        groupName: "Substitute",
        requestedTags: ["#PQL0289"],
        movedTags: ["#PQL0289"],
        duplicateTags: [],
        missingTags: [],
      },
      summary: "Changed group for #PQL0289 to Substitute.",
    });
    (rosterService.getRosterView as any).mockResolvedValue({
      roster: {
        id: "roster-1",
        title: "CWL Alpha Signup",
        clanTag: "#2QG2C08UP",
        postedChannelId: "channel-1",
        postedMessageId: "message-1",
        postButtonMode: "standard",
        rosterRoleId: null,
      },
      clanDisplayName: "CWL Alpha",
      clanLeagueLabel: "Champion League II",
      groups: [],
      signups: [],
      totalSignupCount: 0,
    });
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    const events: string[] = [];
    const roleSyncStarted = createDeferred<void>();
    const roleSyncDeferred = createDeferred<void>();
    const refreshStarted = createDeferred<void>();
    const refreshDeferred = createDeferred<boolean>();
    (rosterService.refreshRosterSignupPayload as any).mockImplementation(async () => {
      events.push("refresh_start");
      refreshStarted.resolve();
      await refreshDeferred.promise;
      events.push("refresh_end");
      return {
        embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
        components: [],
      };
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
    const syncSpy = vi.spyOn(rosterRoleSyncService, "syncRosterRoleAssignments").mockImplementation(async () => {
      events.push("role_sync_start");
      roleSyncStarted.resolve();
      await roleSyncDeferred.promise;
      events.push("role_sync_end");
    });
    const interaction = {
      customId: buildRosterPostChangeGroupActionButtonCustomId("confirm", "session-1"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      message: {
        components: makeRosterMutationPanelComponents(buildRosterPostChangeGroupActionButtonCustomId("confirm", "session-1")),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockImplementation(async () => {
        events.push("final_edit");
        return undefined;
      }),
      followUp: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostChangeGroupActionButtonInteraction(interaction, {} as any);
    await Promise.all([roleSyncStarted.promise, refreshStarted.promise]);

    expect(rosterService.confirmRosterPostChangeGroupPanel).toHaveBeenCalledWith({
      sessionId: "session-1",
      discordUserId: "111111111111111111",
    });
    expect(syncSpy).toHaveBeenCalledWith(interaction.client, "roster-1");
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-1",
      expect.any(Object),
      expect.objectContaining({
        refreshButtonDisabled: false,
      }),
    );
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.arrayContaining([
          expect.objectContaining({
            components: expect.arrayContaining([
              expect.objectContaining({
                disabled: true,
                label: "Applying changes...",
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(events.indexOf("final_edit")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("role_sync_start"));
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("refresh_start"));
    roleSyncDeferred.resolve();
    refreshDeferred.resolve(true);
    await Promise.all([roleSyncDeferred.promise, refreshDeferred.promise]);
    expect(syncSpy).toHaveBeenCalledWith(interaction.client, "roster-1");
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toBe(
      "Changed group for #PQL0289 to Substitute.",
    );
  });

  it("confirms Change Roster, syncs both roster roles, and refreshes both roster posts", async () => {
    vi.spyOn(rosterService, "confirmRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "completed",
      sourceRosterId: "roster-source",
      targetRosterId: "roster-target",
      targetGroupKey: "confirmed",
      selectedCount: 1,
      changeResult: {
        outcome: "changed",
        sourceRosterId: "roster-source",
        sourceRosterTitle: "Source CWL Signup",
        targetRosterId: "roster-target",
        targetRosterTitle: "Target CWL Signup",
        targetRosterClanTag: "#BBBB",
        targetRosterClanName: "Target Clan",
        targetGroupKey: "confirmed",
        targetGroupName: "Confirmed",
        requestedTags: ["#PQL0289"],
        movedTags: ["#PQL0289"],
        movedAccounts: [
          {
            playerTag: "#PQL0289",
            playerName: "Alpha",
            targetGroupKey: "confirmed",
            targetGroupName: "Confirmed",
          },
        ],
        duplicateTags: [],
        missingTags: [],
        blockedTags: [],
        blockedAccounts: [],
      } as any,
      summary: "Moved Alpha (#PQL0289) to Target CWL Signup - Confirmed.",
    });
    (rosterService.getRosterView as any).mockImplementation(async (rosterId: string) => {
      if (rosterId === "roster-source") {
        return {
          roster: {
            id: "roster-source",
            title: "Source CWL Signup",
            clanTag: "#AAAA",
            postedChannelId: "channel-1",
            postedMessageId: "message-1",
            postButtonMode: "standard",
            rosterRoleId: null,
          },
          clanDisplayName: "Source Clan",
          clanLeagueLabel: "Champion League II",
          groups: [],
          signups: [],
          totalSignupCount: 0,
        };
      }
      if (rosterId === "roster-target") {
        return {
          roster: {
            id: "roster-target",
            title: "Target CWL Signup",
            clanTag: "#BBBB",
            postedChannelId: "channel-2",
            postedMessageId: "message-2",
            postButtonMode: "standard",
            rosterRoleId: null,
          },
          clanDisplayName: "Target Clan",
          clanLeagueLabel: "Champion League II",
          groups: [],
          signups: [],
          totalSignupCount: 0,
        };
      }
      return null;
    });
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("Roster"),
      components: [],
    });
    const events: string[] = [];
    const sourceRoleSyncStarted = createDeferred<void>();
    const sourceRoleSyncDeferred = createDeferred<void>();
    const targetRoleSyncStarted = createDeferred<void>();
    const targetRoleSyncDeferred = createDeferred<void>();
    const sourceRefreshStarted = createDeferred<void>();
    const sourceRefreshDeferred = createDeferred<boolean>();
    const targetRefreshStarted = createDeferred<void>();
    const targetRefreshDeferred = createDeferred<boolean>();
    (rosterService.refreshRosterSignupPayload as any).mockImplementation(async (_rosterId: string) => {
      const rosterId = String(_rosterId ?? "");
      events.push(`refresh_start:${rosterId}`);
      if (rosterId === "roster-source") {
        sourceRefreshStarted.resolve();
        await sourceRefreshDeferred.promise;
      } else if (rosterId === "roster-target") {
        targetRefreshStarted.resolve();
        await targetRefreshDeferred.promise;
      }
      events.push(`refresh_end:${rosterId}`);
      return {
        embed: new EmbedBuilder().setTitle(rosterId === "roster-source" ? "Source CWL Signup" : "Target CWL Signup"),
        components: [],
      };
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
    const syncSpy = vi.spyOn(rosterRoleSyncService, "syncRosterRoleAssignments").mockImplementation(async (_client, rosterId: string) => {
      events.push(`role_sync_start:${rosterId}`);
      if (rosterId === "roster-source") {
        sourceRoleSyncStarted.resolve();
        await sourceRoleSyncDeferred.promise;
      } else if (rosterId === "roster-target") {
        targetRoleSyncStarted.resolve();
        await targetRoleSyncDeferred.promise;
      }
      events.push(`role_sync_end:${rosterId}`);
    });
    const interaction = {
      customId: buildRosterPostChangeRosterActionButtonCustomId("confirm", "session-2"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      message: {
        components: makeRosterMutationPanelComponents(buildRosterPostChangeRosterActionButtonCustomId("confirm", "session-2")),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockImplementation(async () => {
        events.push("final_edit");
        return undefined;
      }),
      followUp: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostChangeRosterActionButtonInteraction(interaction, {} as any);
    await Promise.all([
      sourceRoleSyncStarted.promise,
      targetRoleSyncStarted.promise,
      sourceRefreshStarted.promise,
      targetRefreshStarted.promise,
    ]);

    expect(rosterService.confirmRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
      cocService: expect.any(Object),
    });
    expect(syncSpy).toHaveBeenCalledWith(interaction.client, "roster-source");
    expect(syncSpy).toHaveBeenCalledWith(interaction.client, "roster-target");
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-source",
      expect.any(Object),
      expect.objectContaining({
        refreshButtonDisabled: false,
      }),
    );
    expect(rosterService.refreshRosterSignupPayload).toHaveBeenCalledWith(
      "roster-target",
      expect.any(Object),
      expect.objectContaining({
        refreshButtonDisabled: false,
      }),
    );
    expect(events.indexOf("final_edit")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("role_sync_start:roster-source"));
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("role_sync_start:roster-target"));
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("refresh_start:roster-source"));
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("refresh_start:roster-target"));
    sourceRoleSyncDeferred.resolve();
    targetRoleSyncDeferred.resolve();
    sourceRefreshDeferred.resolve(true);
    targetRefreshDeferred.resolve(true);
    await Promise.all([
      sourceRoleSyncDeferred.promise,
      targetRoleSyncDeferred.promise,
      sourceRefreshDeferred.promise,
      targetRefreshDeferred.promise,
    ]);
    expect(syncSpy).toHaveBeenCalledWith(interaction.client, "roster-source");
    expect(syncSpy).toHaveBeenCalledWith(interaction.client, "roster-target");
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.arrayContaining([
          expect.objectContaining({
            components: expect.arrayContaining([
              expect.objectContaining({
                disabled: true,
                label: "Applying changes...",
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toBe(
      "Moved Alpha (#PQL0289) to Target CWL Signup - Confirmed.",
    );
  });

  it("cancels Change Roster without moving signups", async () => {
    vi.spyOn(rosterService, "cancelRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "cancelled",
    });
    const changeSpy = vi.spyOn(rosterService, "changeRosterSignups");
    const interaction = {
      customId: buildRosterPostChangeRosterActionButtonCustomId("cancel", "session-2"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterActionButtonInteraction(interaction, {} as any);

    expect(rosterService.cancelRosterPostChangeRosterPanel).toHaveBeenCalledWith({
      sessionId: "session-2",
      discordUserId: "111111111111111111",
    });
    expect(changeSpy).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Change Roster cancelled.",
        embeds: [],
        components: [],
      }),
    );
  });

  it("shows the expired Change Roster message when the session is missing", async () => {
    vi.spyOn(rosterService, "confirmRosterPostChangeRosterPanel").mockResolvedValue({
      outcome: "session_not_found",
    });
    const interaction = {
      customId: buildRosterPostChangeRosterActionButtonCustomId("confirm", "session-2"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeRosterActionButtonInteraction(interaction, {} as any);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This Change Roster panel expired. Open Settings again.",
        ephemeral: true,
      }),
    );
  });

  it("cancels Change Group without moving signups", async () => {
    vi.spyOn(rosterService, "cancelRosterPostChangeGroupPanel").mockResolvedValue({
      outcome: "cancelled",
    });
    const moveSpy = vi.spyOn(rosterService, "moveRosterSignups");
    const interaction = {
      customId: buildRosterPostChangeGroupActionButtonCustomId("cancel", "session-1"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeGroupActionButtonInteraction(interaction, {} as any);

    expect(rosterService.cancelRosterPostChangeGroupPanel).toHaveBeenCalledWith({
      sessionId: "session-1",
      discordUserId: "111111111111111111",
    });
    expect(moveSpy).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith({
      content: "Change Group cancelled.",
      embeds: [],
      components: [],
    });
  });

  it("shows the expired Change Group message when the session is missing", async () => {
    vi.spyOn(rosterService, "confirmRosterPostChangeGroupPanel").mockResolvedValue({
      outcome: "session_not_found",
    });
    const interaction = {
      customId: buildRosterPostChangeGroupActionButtonCustomId("confirm", "session-1"),
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleRosterPostChangeGroupActionButtonInteraction(interaction, {} as any);

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "This Change Group panel expired. Open Settings again.",
        ephemeral: true,
      }),
    );
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
    const events: string[] = [];
    const roleSyncStarted = createDeferred<void>();
    const roleSyncDeferred = createDeferred<void>();
    const refreshStarted = createDeferred<void>();
    const refreshDeferred = createDeferred<boolean>();
    const rosterChannel = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn().mockResolvedValue(editedMessage),
      },
    };
    const syncSpy = vi.spyOn(rosterRoleSyncService, "syncRosterRoleAssignments").mockImplementation(async () => {
      events.push("role_sync_start");
      roleSyncStarted.resolve();
      await roleSyncDeferred.promise;
      events.push("role_sync_end");
    });
    (rosterService.refreshRosterSignupPayload as any).mockImplementation(async () => {
      events.push("refresh_start");
      refreshStarted.resolve();
      await refreshDeferred.promise;
      events.push("refresh_end");
      return {
        embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
        components: [],
      };
    });

    const interaction = {
      customId,
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      message: {
        components: makeRosterMutationPanelComponents(customId),
      },
      update: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockImplementation(async () => {
        events.push("final_edit");
        return undefined;
      }),
      followUp: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostSettingsActionButtonInteraction(interaction);
    await Promise.all([roleSyncStarted.promise, refreshStarted.promise]);

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
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.arrayContaining([
          expect.objectContaining({
            components: expect.arrayContaining([
              expect.objectContaining({
                disabled: true,
                label: "Applying changes...",
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toBe(expectedContent);
    expect(events.indexOf("final_edit")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("role_sync_start"));
    expect(events.indexOf("final_edit")).toBeLessThan(events.indexOf("refresh_start"));
    roleSyncDeferred.resolve();
    refreshDeferred.resolve(true);
    await Promise.all([roleSyncDeferred.promise, refreshDeferred.promise]);
    expect(syncSpy).toHaveBeenCalledWith(interaction.client, "roster-1");
  });

  it("does not schedule side effects when the Settings roster selection returns a validation error", async () => {
    (rosterService.confirmRosterSelectionPanel as any).mockResolvedValue({
      outcome: "missing_group",
    });
    const syncSpy = vi.spyOn(rosterRoleSyncService, "syncRosterRoleAssignments");
    const refreshSpy = vi.spyOn(rosterService, "refreshRosterSignupPayload");
    const interaction = {
      customId: "roster-post-users:action:confirm:session-9",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      message: {
        components: makeRosterMutationPanelComponents("roster-post-users:action:confirm:session-9"),
      },
      update: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    } as any;

    await handleRosterPostSettingsActionButtonInteraction(interaction);
    await Promise.resolve();
    await Promise.resolve();

    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Select a roster group first.",
        ephemeral: true,
      }),
    );
    expect(syncSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("logs side-effect failures without changing the final Settings confirmation", async () => {
    (rosterService.confirmRosterSelectionPanel as any).mockResolvedValue({
      outcome: "add_user",
      result: {
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
      },
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
    (rosterService.buildRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
    });
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValue({
      embed: new EmbedBuilder().setTitle("CWL Alpha Signup"),
      components: [],
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
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const roleSyncStarted = createDeferred<void>();
    vi.spyOn(rosterRoleSyncService, "syncRosterRoleAssignments").mockImplementation(async () => {
      roleSyncStarted.resolve();
      throw new Error("sync boom");
    });
    const interaction = {
      customId: "roster-post-users:action:confirm:session-11",
      user: { id: "111111111111111111" },
      guildId: "guild-1",
      inGuild: () => true,
      memberPermissions: {
        has: vi.fn().mockReturnValue(true),
      },
      message: {
        components: makeRosterMutationPanelComponents("roster-post-users:action:confirm:session-11"),
      },
      update: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      client: {
        channels: {
          fetch: vi.fn().mockResolvedValue(rosterChannel),
        },
      },
    } as any;

    await handleRosterPostSettingsActionButtonInteraction(interaction);
    await roleSyncStarted.promise;
    await Promise.resolve();

    expect(String(interaction.editReply.mock.calls.at(-1)?.[0]?.content ?? "")).toContain(
      "Added Alpha (#PQL0289) to CWL Alpha Signup - CWL Alpha",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("mutation_side_effect_failed flow=add_user sessionId=session-11"),
    );
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

  it("shows the guild default columns as the selected roster customize values when no explicit override exists", async () => {
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
      sortBy: null,
      displayColumns: null,
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
      guildDisplayColumns: ["townhall_icons", "player_name"],
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

    const payload = interaction.reply.mock.calls[0]?.[0] as any;
    const columnMenu = payload.components[0]?.toJSON?.().components?.[0];
    const selectedValues = (columnMenu?.options ?? [])
      .filter((option: any) => option.default)
      .map((option: any) => option.value);

    expect(selectedValues).toEqual(["townhall_icons", "player_name"]);
    expect(columnMenu?.options?.find((option: any) => option.value === "discord_username")?.default).toBe(false);
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
      makeRosterRefreshPayload(true, "CWL Alpha Signup (Loading)", "Loading roster weights..."),
    );
    (rosterService.refreshRosterSignupPayload as any).mockResolvedValueOnce(
      makeRosterRefreshPayload(
        false,
        "CWL Alpha Signup (Refreshed)",
        "Jess | 178000 WeightInputDeferment | refreshed roster weights.",
      ),
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
    expect(String(finalPayload.embeds[0]?.toJSON?.().description ?? "")).toContain("178000");
    expect(String(finalPayload.embeds[0]?.toJSON?.().description ?? "")).toContain("WeightInputDeferment");
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
    }) as any;
    editInteraction.client.channels.fetch = interactionClientFetchMock;

    await Roster.run({} as any, editInteraction as any);

    const editUpdatePayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(editUpdatePayload).toMatchObject({
      rosterId: "roster-1",
      name: "CWL Alpha Signup (Updated)",
      updatedByDiscordUserId: "111111111111111111",
    });
    expect(editUpdatePayload.timezone).toBeUndefined();
    expect(editUpdatePayload.displayTimezone).toBeUndefined();
    expect(editUpdatePayload.startsAt).toBeUndefined();
    expect(editUpdatePayload.endsAt).toBeUndefined();
    expect(editUpdatePayload.visitorSignupOpensAt).toBeUndefined();
    expect(editUpdatePayload.maxMembers).toBeUndefined();
    expect(editUpdatePayload.maxAccountsPerUser).toBeUndefined();
    expect(editUpdatePayload.minTownhall).toBeUndefined();
    expect(editUpdatePayload.maxTownhall).toBeUndefined();
    expect(editUpdatePayload.requiredSignupRoleId).toBeUndefined();
    expect(editUpdatePayload.noRoleSignupLimit).toBeUndefined();
    expect(editUpdatePayload.rosterRoleId).toBeUndefined();
    expect(editUpdatePayload.allowMultiSignup).toBeUndefined();
    expect(editUpdatePayload.sortBy).toBeUndefined();
    expect(editUpdatePayload.importMembers).toBeUndefined();
    expect(editedMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [expect.any(EmbedBuilder)],
      }),
    );
    expect(String(editInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain("Updated roster CWL Alpha Signup (Updated).");

    const editMaxMembersInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      maxMembers: 30,
    }) as any;
    editMaxMembersInteraction.client.channels.fetch = interactionClientFetchMock;
    await Roster.run({} as any, editMaxMembersInteraction as any);
    const maxMembersPayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(maxMembersPayload).toMatchObject({
      rosterId: "roster-1",
      maxMembers: 30,
      updatedByDiscordUserId: "111111111111111111",
    });
    expect(maxMembersPayload.minTownhall).toBeUndefined();
    expect(maxMembersPayload.maxTownhall).toBeUndefined();
    expect(maxMembersPayload.startsAt).toBeUndefined();
    expect(maxMembersPayload.endsAt).toBeUndefined();
    expect(maxMembersPayload.sortBy).toBeUndefined();

    const editMinTownhallInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      minTownhall: 14,
      minimumWeight: 150000,
    }) as any;
    editMinTownhallInteraction.client.channels.fetch = interactionClientFetchMock;
    await Roster.run({} as any, editMinTownhallInteraction as any);
    const minTownhallPayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(minTownhallPayload).toMatchObject({
      rosterId: "roster-1",
      minTownhall: 14,
      minimumWeight: 150000,
      updatedByDiscordUserId: "111111111111111111",
    });
    expect(minTownhallPayload.maxTownhall).toBeUndefined();
    expect(minTownhallPayload.startsAt).toBeUndefined();
    expect(minTownhallPayload.endsAt).toBeUndefined();

    const editSortByInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      sortBy: "townhall",
    }) as any;
    editSortByInteraction.client.channels.fetch = interactionClientFetchMock;
    await Roster.run({} as any, editSortByInteraction as any);
    const sortByPayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(sortByPayload).toMatchObject({
      rosterId: "roster-1",
      sortBy: "townhall",
      updatedByDiscordUserId: "111111111111111111",
    });
    expect(sortByPayload.maxMembers).toBeUndefined();
    expect(sortByPayload.minTownhall).toBeUndefined();
    expect(sortByPayload.maxTownhall).toBeUndefined();
    expect(sortByPayload.startsAt).toBeUndefined();
    expect(sortByPayload.endsAt).toBeUndefined();

    const clearRequiredRoleInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      clearRequiredRole: true,
    }) as any;
    clearRequiredRoleInteraction.client.channels.fetch = interactionClientFetchMock;
    await Roster.run({} as any, clearRequiredRoleInteraction as any);
    const clearRequiredRolePayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(clearRequiredRolePayload.requiredSignupRoleId).toBeNull();

    const deleteRoleInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      deleteRole: true,
    }) as any;
    deleteRoleInteraction.client.channels.fetch = interactionClientFetchMock;
    await Roster.run({} as any, deleteRoleInteraction as any);
    const deleteRolePayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(deleteRolePayload.rosterRoleId).toBeNull();

    const updateCallsBeforeTitle = rosterService.updateRoster.mock.calls.length;
    const titleOnlyInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      title: "CWL Alpha Signup (Alias)",
      clearVisitorSignupOpenTime: false,
    }) as any;
    titleOnlyInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);

    await Roster.run({} as any, titleOnlyInteraction as any);

    expect(String(titleOnlyInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Provide at least one roster field to edit.",
    );
    expect(rosterService.updateRoster.mock.calls.length).toBe(updateCallsBeforeTitle);

    const editsBeforeVisitorTests = editedMessage.edit.mock.calls.length;
    const visitorTimezoneInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      visitorSignupOpenTime: "2026-07-01 12:00",
      displayTimezone: "America/New_York",
    }) as any;
    visitorTimezoneInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);
    await Roster.run({} as any, visitorTimezoneInteraction as any);
    const visitorTimezonePayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(visitorTimezonePayload.visitorSignupOpensAt).toEqual(new Date("2026-07-01T19:00:00.000Z"));
    expect(visitorTimezonePayload.timezone).toBeUndefined();
    expect(visitorTimezonePayload.displayTimezone).toBe("America/New_York");
    expect(editedMessage.edit.mock.calls.length).toBeGreaterThan(editsBeforeVisitorTests);

    const editsBeforeVisitorTimezoneChange = editedMessage.edit.mock.calls.length;
    const visitorTimezoneChangeInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      timezone: "America/New_York",
      visitorSignupOpenTime: "2026-07-01 12:00",
    }) as any;
    visitorTimezoneChangeInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);
    await Roster.run({} as any, visitorTimezoneChangeInteraction as any);
    const visitorTimezoneChangePayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(visitorTimezoneChangePayload.timezone).toBe("America/New_York");
    expect(visitorTimezoneChangePayload.visitorSignupOpensAt).toEqual(new Date("2026-07-01T16:00:00.000Z"));
    expect(editedMessage.edit.mock.calls.length).toBeGreaterThan(editsBeforeVisitorTimezoneChange);

    const editsBeforeClearVisitor = editedMessage.edit.mock.calls.length;
    const clearVisitorInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      clearVisitorSignupOpenTime: true,
    }) as any;
    clearVisitorInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);
    await Roster.run({} as any, clearVisitorInteraction as any);
    const clearVisitorPayload = rosterService.updateRoster.mock.calls.at(-1)?.[0] as any;
    expect(clearVisitorPayload.visitorSignupOpensAt).toBeNull();
    expect(editedMessage.edit.mock.calls.length).toBeGreaterThan(editsBeforeClearVisitor);

    const updateCallsBeforeInvalidVisitor = rosterService.updateRoster.mock.calls.length;
    const invalidVisitorInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      visitorSignupOpenTime: "invalid",
    }) as any;
    invalidVisitorInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);
    await Roster.run({} as any, invalidVisitorInteraction as any);
    expect(String(invalidVisitorInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Invalid visitor_signup_open_time. Use YYYY-MM-DD HH:mm with a valid timezone.",
    );
    expect(rosterService.updateRoster.mock.calls.length).toBe(updateCallsBeforeInvalidVisitor);

    const updateCallsBeforeConflictVisitor = rosterService.updateRoster.mock.calls.length;
    const conflictingVisitorInteraction = makeInteraction({
      subcommand: "edit",
      roster: "roster-1",
      visitorSignupOpenTime: "2026-07-01 12:00",
      clearVisitorSignupOpenTime: true,
    }) as any;
    conflictingVisitorInteraction.client.channels.fetch = vi.fn().mockResolvedValue(rosterChannel);
    await Roster.run({} as any, conflictingVisitorInteraction as any);
    expect(String(conflictingVisitorInteraction.editReply.mock.calls.at(-1)?.[0] ?? "")).toContain(
      "Choose either visitor_signup_open_time or clear_visitor_signup_open_time, not both.",
    );
    expect(rosterService.updateRoster.mock.calls.length).toBe(updateCallsBeforeConflictVisitor);

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
      "State: Open\nClan: CWL Alpha `#2QG2C08UP` ([Open in-game](<https://link.clashofclans.com/en/?action=OpenClanProfile&tag=2QG2C08UP>))\n**Groups**\n**Confirmed** (1)\n- <:th15:1001> Alpha <:yes:901>",
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
    expect(moveMissingGroupInteraction.respond).toHaveBeenCalledWith([
      { name: "Charlie (#CUV02898)", value: "#CUV02898" },
    ]);

    const moveInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
      targetGroup: "substitute",
    }) as any;
    await Roster.autocomplete(moveInteraction);
    expect(moveInteraction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#PYLQ0289)", value: "#PYLQ0289" },
      { name: "Bravo (#QGRJ2222)", value: "#QGRJ2222" },
    ]);

    const invalidMoveInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "",
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
      targetGroup: "not-real",
    }) as any;
    await Roster.autocomplete(invalidMoveInteraction);
    expect(invalidMoveInteraction.respond).toHaveBeenCalledWith([]);

    const moveTargetGroupInteraction = makeAutocompleteInteraction({
      focusedName: "target_group",
      focusedValue: "con",
      subcommand: "manage",
      roster: "roster-1",
      action: "move",
    }) as any;
    await Roster.autocomplete(moveTargetGroupInteraction);
    expect(rosterService.getRosterView).toHaveBeenCalledWith("roster-1");
    expect(moveTargetGroupInteraction.respond).toHaveBeenCalledWith([
      { name: "Confirmed (confirmed)", value: "confirmed" },
    ]);

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

    const selectedUserAddInteraction = makeAutocompleteInteraction({
      focusedName: "players",
      focusedValue: "del",
      subcommand: "manage",
      roster: "roster-1",
      action: "add",
      userId: "222222222222222222",
    }) as any;
    vi.spyOn(playerLinkService, "listPlayerLinksForDiscordUser").mockResolvedValueOnce([
      { playerTag: "#VJQ28888", linkedAt: new Date("2026-04-03T00:00:00.000Z"), linkedName: "Delta" },
      { playerTag: "#PYLQ0289", linkedAt: new Date("2026-04-01T00:00:00.000Z"), linkedName: "Alpha Prime" },
    ] as any);
    await Roster.autocomplete(selectedUserAddInteraction);
    expect(playerLinkService.listPlayerLinksForDiscordUser).toHaveBeenCalledWith({
      discordUserId: "222222222222222222",
    });
    expect(selectedUserAddInteraction.respond).toHaveBeenCalledWith([
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
