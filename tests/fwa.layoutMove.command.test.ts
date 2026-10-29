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
  minTh?: number | null;
  maxTh?: number | null;
  permissions?: Set<bigint>;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const target = input.target ?? {
    id: "new-channel",
    guildId: "guild-1",
    type: ChannelType.GuildText,
    send: vi.fn(),
  };
  target.permissionsFor = vi.fn(() => ({
    has: (permission: bigint) => input.permissions?.has(permission) ?? true,
  }));
  const interaction: any = {
    guildId: "guild-1",
    guild: {
      channels: { fetch: vi.fn().mockResolvedValue(target) },
      members: { me: { id: "bot-1" } },
    },
    client: { user: { id: "bot-1" } },
    user: { id: "admin-1" },
    memberPermissions: { has: vi.fn(() => input.admin ?? true) },
    deferReply,
    editReply,
    reply,
    options: {
      getString: vi.fn(() => input.type ?? "RISINGDAWN"),
      getChannel: vi.fn(() => target),
      getInteger: vi.fn((name: string) => name === "min-th" ? (input.minTh ?? null) : (input.maxTh ?? null)),
    },
  };
  return { interaction, reply, deferReply, editReply, target };
}

describe("/fwa layout-move", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers the required type/channel and bounded optional TH range", () => {
    expect(FWA_LAYOUT_MOVE_SUBCOMMAND.options.map((option) => option.name)).toEqual([
      "type",
      "target-channel",
      "min-th",
      "max-th",
    ]);
    expect(FWA_LAYOUT_MOVE_SUBCOMMAND.options[1].channel_types).toEqual([ChannelType.GuildText]);
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
