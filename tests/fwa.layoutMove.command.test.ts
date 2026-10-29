import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  FWA_LAYOUT_MOVE_SUBCOMMAND,
  runFwaLayoutMoveCommand,
} from "../src/commands/fwa/layoutMoveCommand";

const LINK = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD18";

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "layout-1",
    layoutLink: LINK,
    title: "TH18 base",
    description: "description",
    imageUrl: null,
    postedByDiscordUserId: "poster-1",
    discordGuildId: "guild-1",
    discordChannelId: "old-channel",
    discordMessageId: "old-message",
    submittedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
    lastConfirmedByDiscordUserId: "confirmer-1",
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  };
}

function buildCanonical(record: any, overrides: Record<string, unknown> = {}) {
  return {
    Townhall: 18,
    Type: "RISINGDAWN",
    LayoutLink: record?.layoutLink ?? LINK,
    ImageUrl: record?.imageUrl ?? null,
    LastUpdated: new Date("2026-08-23T00:00:00.000Z"),
    layoutId: record?.id ?? null,
    layoutRecord: record,
    ...overrides,
  };
}

function makeInteraction(input: {
  admin?: boolean;
  type?: string;
  target?: any;
  invocationChannel?: any;
  channelFetch?: (id: string) => any;
  minTh?: number | null;
  maxTh?: number | null;
  order?: string | null;
  permissions?: Set<bigint>;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const target = input.target === undefined ? {
    id: "new-channel",
    guildId: "guild-1",
    type: ChannelType.GuildText,
    send: vi.fn(),
  } : input.target;
  for (const channel of [target, input.invocationChannel]) {
    if (channel) {
      channel.permissionsFor = vi.fn(() => ({
        has: (permission: bigint) => input.permissions?.has(permission) ?? true,
      }));
    }
  }
  const guildFetch = vi.fn().mockImplementation(async (id: string) => {
    if (target?.id === id) return target;
    return null;
  });
  const clientFetch = vi.fn().mockImplementation(async (id: string) => input.channelFetch?.(id) ?? null);
  const interaction: any = {
    guildId: "guild-1",
    channel: input.invocationChannel ?? null,
    channelId: input.invocationChannel?.id ?? null,
    guild: {
      channels: { fetch: guildFetch },
      members: { me: { id: "bot-1" } },
    },
    client: { user: { id: "bot-1" }, channels: { fetch: clientFetch } },
    user: { id: "admin-1" },
    memberPermissions: { has: vi.fn(() => input.admin ?? true) },
    deferReply,
    editReply,
    reply,
    options: {
      getString: vi.fn((name: string) => name === "type" ? (input.type ?? "RISINGDAWN") : (input.order ?? null)),
      getChannel: vi.fn(() => target),
      getInteger: vi.fn((name: string) => name === "min-th" ? (input.minTh ?? null) : (input.maxTh ?? null)),
    },
  };
  return { interaction, reply, deferReply, editReply, target, clientFetch, guildFetch };
}

function buildForumParent(overrides: Record<string, unknown> = {}) {
  return {
    id: "forum-parent",
    guildId: "guild-1",
    type: ChannelType.GuildForum,
    ...overrides,
  };
}

function buildForumThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "forum-thread",
    guildId: "guild-1",
    type: ChannelType.PublicThread,
    parentId: "forum-parent",
    send: vi.fn(),
    ...overrides,
  };
}

describe("/fwa layout-move", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers the required type, optional destination/order, and bounded optional TH range", () => {
    expect(FWA_LAYOUT_MOVE_SUBCOMMAND.options.map((option) => option.name)).toEqual([
      "type",
      "target-channel",
      "min-th",
      "max-th",
      "order",
    ]);
    expect(FWA_LAYOUT_MOVE_SUBCOMMAND.options[1].required).toBe(false);
    expect(FWA_LAYOUT_MOVE_SUBCOMMAND.options[1].channel_types).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildForum,
      ChannelType.PublicThread,
    ]);
    expect(FWA_LAYOUT_MOVE_SUBCOMMAND.options[4].choices).toEqual([
      { name: "Ascending", value: "ascending" },
      { name: "Descending", value: "descending" },
    ]);
  });

  it("publishes in descending order by default and ascending order when requested", async () => {
    const records = [
      buildRecord({ id: "layout-16" }),
      buildRecord({ id: "layout-18" }),
      buildRecord({ id: "layout-17" }),
    ];
    const run = async (order: string | null, expectedIds: string[]) => {
      const listCanonical = vi.fn().mockResolvedValue([
        buildCanonical(records[0], { Townhall: 16 }),
        buildCanonical(records[1], { Townhall: 18 }),
        buildCanonical(records[2], { Townhall: 17 }),
      ]);
      const relocate = vi.fn().mockImplementation(async ({ layout }: { layout: any }) => ({
        layout,
        messageId: `new-${layout.id}`,
        jumpUrl: `https://discord.com/channels/guild-1/new-channel/new-${layout.id}`,
        oldPostCleanupFailed: false,
      }));
      const { interaction } = makeInteraction({ order });

      await runFwaLayoutMoveCommand(interaction, {
        layoutService: { listCanonical } as any,
        publicationService: { relocate } as any,
        messageResolver: { resolve: vi.fn() },
      });

      expect(relocate.mock.calls.map((call) => call[0].layout.id)).toEqual(expectedIds);
    };

    await run(null, ["layout-18", "layout-17", "layout-16"]);
    await run("ascending", ["layout-16", "layout-17", "layout-18"]);
  });

  it("infers the invoking public forum post when target-channel is omitted", async () => {
    const parent = buildForumParent();
    const thread = buildForumThread();
    const { interaction, editReply } = makeInteraction({
      target: null,
      invocationChannel: thread,
      channelFetch: (id) => id === parent.id ? parent : id === thread.id ? thread : null,
    });
    const listCanonical = vi.fn().mockResolvedValue([]);

    await runFwaLayoutMoveCommand(interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate: vi.fn() } as any,
      messageResolver: { resolve: vi.fn() },
    });

    expect(listCanonical).toHaveBeenCalledWith({ type: "RISINGDAWN" });
    expect(editReply.mock.calls[0]?.[0].content).toContain("Destination: <#forum-thread>");
  });

  it("accepts an explicit public forum post destination", async () => {
    const parent = buildForumParent();
    const thread = buildForumThread();
    const { interaction } = makeInteraction({
      target: thread,
      channelFetch: (id) => id === parent.id ? parent : null,
    });
    const listCanonical = vi.fn().mockResolvedValue([]);

    await runFwaLayoutMoveCommand(interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate: vi.fn() } as any,
      messageResolver: { resolve: vi.fn() },
    });

    expect(listCanonical).toHaveBeenCalledTimes(1);
  });

  it("requires a forum post when target-channel is omitted outside one", async () => {
    const { interaction, editReply } = makeInteraction({
      target: null,
      invocationChannel: { id: "text-channel", guildId: "guild-1", type: ChannelType.GuildText, send: vi.fn() },
    });
    const listCanonical = vi.fn();

    await runFwaLayoutMoveCommand(interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate: vi.fn() } as any,
    });

    expect(listCanonical).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0]?.[0].content).toContain("inside a public forum post");
  });

  it.each([
    ["GuildForum parents", buildForumParent(), "GuildForum parent"],
    [
      "non-forum public threads",
      buildForumThread({ parentId: "text-parent" }),
      "belonging to a GuildForum parent",
    ],
    ["unsupported private threads", buildForumThread({ type: ChannelType.PrivateThread }), "guild text channel or a public forum post"],
    ["archived forum posts", buildForumThread({ archived: true }), "archived"],
    ["locked forum posts", buildForumThread({ locked: true }), "locked"],
    ["non-writable forum posts", buildForumThread({ send: undefined }), "not writable"],
  ])("rejects %s before relocation begins", async (_label, target, reason) => {
    const listCanonical = vi.fn();
    const parent = target.parentId === "text-parent"
      ? { id: "text-parent", guildId: "guild-1", type: ChannelType.GuildText }
      : buildForumParent();
    const { interaction, editReply } = makeInteraction({
      target,
      channelFetch: (id) => id === parent.id ? parent : null,
    });

    await runFwaLayoutMoveCommand(interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate: vi.fn() } as any,
    });

    expect(listCanonical).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0]?.[0].content).toContain(reason);
  });

  it("uses thread permissions and rejects a missing Send Messages in Threads grant", async () => {
    const parent = buildForumParent();
    const thread = buildForumThread();
    const permissions = new Set([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ]);
    const { interaction, editReply } = makeInteraction({
      target: thread,
      permissions,
      channelFetch: (id) => id === parent.id ? parent : null,
    });
    const listCanonical = vi.fn();

    await runFwaLayoutMoveCommand(interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate: vi.fn() } as any,
    });

    expect(listCanonical).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0]?.[0].content).toContain("Send Messages in Threads");
  });

  it("moves canonical records sequentially, skips destination/unpublished rows, and deduplicates shared records", async () => {
    const record = buildRecord();
    const duplicate = buildCanonical(record, { Townhall: 17 });
    const alreadyMoved = buildCanonical(buildRecord({
      id: "layout-2",
      discordChannelId: "new-channel",
      discordMessageId: "already-new",
    }));
    const unpublished = buildCanonical(null, { Townhall: 16, layoutId: null, layoutRecord: null });
    const listCanonical = vi.fn().mockResolvedValue([
      buildCanonical(record),
      duplicate,
      alreadyMoved,
      unpublished,
    ]);
    const relocate = vi.fn().mockResolvedValue({
      layout: buildRecord({ discordChannelId: "new-channel", discordMessageId: "new-message" }),
      messageId: "new-message",
      jumpUrl: "https://discord.com/channels/guild-1/new-channel/new-message",
      oldPostCleanupFailed: false,
    });
    const { interaction, deferReply, editReply } = makeInteraction({ minTh: 16, maxTh: 18 });

    await runFwaLayoutMoveCommand(interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate } as any,
      messageResolver: { resolve: vi.fn() },
    });

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(listCanonical).toHaveBeenCalledWith({ type: "RISINGDAWN" });
    expect(relocate).toHaveBeenCalledTimes(1);
    expect(editReply.mock.calls[0]?.[0].content).toContain("Moved: 1 · Skipped: 2 · Failed: 0");
    expect(editReply.mock.calls[0]?.[0].content).toContain("Skipped THs: TH18 (already_in_destination), TH16 (unpublished)");
    expect(editReply.mock.calls[0]?.[0].content).toContain("new-message");
  });

  it("reports partial failures without aborting later layouts", async () => {
    const first = buildRecord({ id: "layout-1", discordMessageId: "old-1" });
    const second = buildRecord({ id: "layout-2", discordMessageId: "old-2" });
    const relocate = vi.fn()
      .mockRejectedValueOnce(new Error("stale relocation"))
      .mockResolvedValueOnce({
        layout: second,
        messageId: "new-2",
        jumpUrl: "https://discord.com/channels/guild-1/new-channel/new-2",
        oldPostCleanupFailed: true,
      });
    const { interaction, editReply } = makeInteraction({});

    await runFwaLayoutMoveCommand(interaction, {
      layoutService: {
        listCanonical: vi.fn().mockResolvedValue([
          buildCanonical(first, { Townhall: 17 }),
          buildCanonical(second, { Townhall: 18 }),
        ]),
      } as any,
      publicationService: { relocate } as any,
      messageResolver: { resolve: vi.fn() },
    });

    expect(relocate).toHaveBeenCalledTimes(2);
    expect(editReply.mock.calls[0]?.[0].content).toContain("Moved: 1 · Skipped: 0 · Failed: 1");
    expect(editReply.mock.calls[0]?.[0].content).toContain("Failed THs: TH18 (cas_conflict)");
    expect(editReply.mock.calls[0]?.[0].content).toContain("cleanup warnings: 1");
  });

  it("denies non-administrators and missing destination permissions", async () => {
    const denied = makeInteraction({ admin: false });
    await runFwaLayoutMoveCommand(denied.interaction, {
      layoutService: { listCanonical: vi.fn() } as any,
      publicationService: { relocate: vi.fn() } as any,
    });
    expect(denied.reply.mock.calls[0]?.[0].content).toContain("Only administrators");
    expect(denied.deferReply).not.toHaveBeenCalled();

    const permissions = new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    const missing = makeInteraction({ permissions });
    const listCanonical = vi.fn();
    await runFwaLayoutMoveCommand(missing.interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate: vi.fn() } as any,
    });
    expect(listCanonical).not.toHaveBeenCalled();
    expect(missing.editReply.mock.calls[0]?.[0].content).toContain("Embed Links");
  });

  it("rejects a cross-guild destination before reading canonical layouts", async () => {
    const target = { id: "other-channel", guildId: "guild-2", type: ChannelType.GuildText, send: vi.fn() };
    const interaction = makeInteraction({ target });
    const listCanonical = vi.fn();
    await runFwaLayoutMoveCommand(interaction.interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { relocate: vi.fn() } as any,
    });
    expect(listCanonical).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls[0]?.[0].content).toContain("same server");
  });
});
