import { beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutRecord } from "@prisma/client";
import {
  buildLayoutInfoPayload,
  buildLayoutPostCustomId,
  buildLayoutPostPayload,
  isLayoutPostButtonCustomId,
  isLayoutPostCustomId,
  LayoutPostService,
  parseLayoutPostCustomId,
} from "../src/services/LayoutPostService";

const LAYOUT_LINK =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD";

function buildRecord(overrides: Partial<LayoutRecord> = {}): LayoutRecord {
  const createdAt = new Date("2026-08-24T00:00:00.000Z");
  return {
    id: "layout-1",
    layoutLink: LAYOUT_LINK,
    title: "War base",
    description: "CC: 2 Ice Golems + Archers",
    imageUrl: "https://example.com/layout.png",
    postedByDiscordUserId: "poster-1",
    discordGuildId: "guild-1",
    discordChannelId: "channel-1",
    discordMessageId: "message-1",
    submittedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
    lastConfirmedByDiscordUserId: "confirmer-1",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeInteraction(input: {
  customId: string;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string;
}) {
  const message = {
    id: input.messageId ?? "message-1",
    attachments: {
      first: vi.fn().mockReturnValue(null),
    },
    edit: vi.fn().mockResolvedValue(undefined),
  };
  const interaction: any = {
    customId: input.customId,
    guildId: input.guildId === undefined ? "guild-1" : input.guildId,
    channelId: input.channelId === undefined ? "channel-1" : input.channelId,
    user: { id: "clicker-1" },
    message,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
  return { interaction, message };
}

describe("layout post rendering", () => {
  const record = buildRecord();

  it("renders title and image in the collapsed view only", () => {
    const payload = buildLayoutPostPayload(record);
    const embed = payload.embeds?.[0]?.toJSON();

    expect(embed?.title).toBe("War base");
    expect(embed?.image?.url).toBe(record.imageUrl);
    expect(embed?.description).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(record.layoutLink);
    expect(JSON.stringify(payload)).not.toContain(record.description);
    expect(payload.components[0]?.toJSON().components.map((button) => button.label)).toEqual([
      "Layout Link",
      "Info",
    ]);
  });

  it("omits a synthetic title and empty embed when title and image are absent", () => {
    const payload = buildLayoutPostPayload(
      buildRecord({ title: null, imageUrl: null }),
    );

    expect(payload.embeds).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain(LAYOUT_LINK);
    expect(payload.components[0]?.toJSON().components.map((button) => button.label)).toEqual([
      "Layout Link",
      "Info",
    ]);
  });

  it("uses a same-message attachment reference without re-uploading it", () => {
    const payload = buildLayoutPostPayload(
      buildRecord({ imageUrl: null }),
      "collapsed",
      { attachmentName: "base.png" },
    );

    expect(payload.embeds?.[0]?.toJSON().image?.url).toBe("attachment://base.png");
  });

  it("renders the expanded URL and confirmation question with expanded controls", () => {
    const payload = buildLayoutPostPayload(record, "expanded");
    const embed = payload.embeds?.[0]?.toJSON();
    const buttons = payload.components[0]?.toJSON().components;

    expect(payload.embeds).toHaveLength(1);
    expect(embed?.title).toBe(record.title);
    expect(embed?.image?.url).toBe(record.imageUrl);
    expect(embed?.description).toContain(`[Open Layout](<${record.layoutLink}>)`);
    expect(embed?.description).toContain("Did the layout open successfully in Clash of Clans?");
    expect(buttons.map((button) => button.label)).toEqual([
      "Yes, It Opened",
      "Close",
      "Info",
    ]);
  });

  it("renders Info metadata without repeating the title or exposing the URL", () => {
    const payload = buildLayoutInfoPayload(record);
    const serialized = JSON.stringify(payload);
    const description = payload.embeds?.[0]?.toJSON().description ?? "";

    expect(description).toContain("TH18 • WB");
    expect(description).toContain(record.description as string);
    expect(description).toContain("<@poster-1>");
    expect(description).toContain("Submitted:");
    expect(description).toContain("Last confirmed active:");
    expect(description).toContain("<@confirmer-1>");
    expect(description).not.toContain(record.title as string);
    expect(serialized).not.toContain(record.layoutLink);
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it("shows unknown freshness for a legacy record without confirmation or submission", () => {
    const payload = buildLayoutInfoPayload(
      buildRecord({ submittedAt: null, lastConfirmedAt: null }),
    );

    expect(payload.embeds?.[0]?.toJSON().description).toContain(
      "Freshness: unknown/not yet established",
    );
  });
});

describe("layout post custom IDs", () => {
  it("builds, parses, and recognizes persistent IDs", () => {
    const customId = buildLayoutPostCustomId("confirm", "layout-1");

    expect(customId).toBe("layout:confirm:layout-1");
    expect(parseLayoutPostCustomId(customId)).toEqual({
      action: "confirm",
      layoutId: "layout-1",
    });
    expect(isLayoutPostCustomId(customId)).toBe(true);
    expect(isLayoutPostButtonCustomId(customId)).toBe(true);
    expect(isLayoutPostCustomId("layout:interaction-1:prev")).toBe(false);
  });

  it.each(["layout:bad-action:layout-1", "layout:info", "other:info:layout-1", "layout:info:"])(
    "rejects malformed ID %s",
    (customId) => {
      expect(parseLayoutPostCustomId(customId)).toBeNull();
      expect(isLayoutPostButtonCustomId(customId)).toBe(false);
      expect(isLayoutPostCustomId(customId)).toBe(customId.startsWith("layout:"));
    },
  );
});

describe("layout post persistent interactions", () => {
  const layoutRecordService = {
    findById: vi.fn(),
    confirmSuccessfulOpening: vi.fn(),
  };
  let postService: LayoutPostService;

  beforeEach(() => {
    vi.clearAllMocks();
    postService = new LayoutPostService({ layoutService: layoutRecordService });
  });

  it("reveals the link without writing lifecycle state", async () => {
    const record = buildRecord({ lastConfirmedAt: null });
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("link", record.id),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(interaction.update.mock.calls[0]?.[0])).toContain(record.layoutLink);
  });

  it("shows Info ephemerally without mutating the public post or freshness", async () => {
    const record = buildRecord();
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("info", record.id),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(JSON.stringify(interaction.reply.mock.calls[0]?.[0])).not.toContain(record.layoutLink);
  });

  it("closes the expanded view without writing lifecycle state", async () => {
    const record = buildRecord({ title: null, imageUrl: null });
    layoutRecordService.findById.mockResolvedValue(record);
    const expanded = makeInteraction({
      customId: buildLayoutPostCustomId("link", record.id),
    });
    const collapsed = makeInteraction({
      customId: buildLayoutPostCustomId("close", record.id),
    });
    collapsed.interaction.message = expanded.interaction.message;

    await postService.handleButtonInteraction(expanded.interaction);
    await postService.handleButtonInteraction(collapsed.interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(collapsed.interaction.update).toHaveBeenCalledTimes(1);
    expect(collapsed.interaction.update.mock.calls[0]?.[0].embeds).toEqual([]);
    expect(JSON.stringify(collapsed.interaction.update.mock.calls[0]?.[0])).not.toContain(
      record.layoutLink,
    );
  });

  it("confirms for the clicking user and collapses the public post", async () => {
    const record = buildRecord({ lastConfirmedAt: null, title: null, imageUrl: null });
    const confirmed = buildRecord({
      title: null,
      imageUrl: null,
      lastConfirmedAt: new Date("2026-08-25T00:00:00.000Z"),
      lastConfirmedByDiscordUserId: "clicker-1",
    });
    layoutRecordService.findById.mockResolvedValue(record);
    layoutRecordService.confirmSuccessfulOpening.mockResolvedValue(confirmed);
    const expanded = makeInteraction({
      customId: buildLayoutPostCustomId("link", record.id),
    });
    const interaction = makeInteraction({
      customId: buildLayoutPostCustomId("confirm", record.id),
    });
    interaction.interaction.message = expanded.interaction.message;

    await postService.handleButtonInteraction(expanded.interaction);
    await postService.handleButtonInteraction(interaction.interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).toHaveBeenCalledTimes(1);
    expect(layoutRecordService.confirmSuccessfulOpening).toHaveBeenCalledWith({
      id: record.id,
      discordUserId: "clicker-1",
    });
    expect(interaction.interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.interaction.update.mock.calls[0]?.[0].embeds).toEqual([]);
    expect(JSON.stringify(interaction.interaction.update.mock.calls[0]?.[0])).not.toContain(
      record.layoutLink,
    );
  });

  it.each([
    { guildId: "other-guild", channelId: "channel-1", messageId: "message-1" },
    { guildId: "guild-1", channelId: "other-channel", messageId: "message-1" },
    { guildId: "guild-1", channelId: "channel-1", messageId: "other-message" },
  ])("rejects scope mismatch %# before mutation", async (scope) => {
    const record = buildRecord();
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("link", record.id),
      ...scope,
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("rejects a forged or nonexistent layout ID safely", async () => {
    layoutRecordService.findById.mockResolvedValue(null);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("link", "missing-layout"),
    });

    await postService.handleButtonInteraction(interaction);

    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("auto-collapses an expanded post after the presentation timeout", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord({ title: null, imageUrl: null });
      layoutRecordService.findById.mockResolvedValue(record);
      const { interaction, message } = makeInteraction({
        customId: buildLayoutPostCustomId("link", record.id),
      });
      postService = new LayoutPostService({
        layoutService: layoutRecordService,
        autoCollapseDelayMs: 100,
      });

      await postService.handleButtonInteraction(interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(message.edit).toHaveBeenCalledTimes(1);
      expect(message.edit.mock.calls[0]?.[0].embeds).toEqual([]);
      expect(JSON.stringify(message.edit.mock.calls[0]?.[0])).not.toContain(record.layoutLink);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the delayed edit when Close is clicked", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord();
      layoutRecordService.findById.mockResolvedValue(record);
      const first = makeInteraction({
        customId: buildLayoutPostCustomId("link", record.id),
      });
      const second = makeInteraction({
        customId: buildLayoutPostCustomId("close", record.id),
      });
      second.interaction.message = first.interaction.message;
      postService = new LayoutPostService({
        layoutService: layoutRecordService,
        autoCollapseDelayMs: 100,
      });

      await postService.handleButtonInteraction(first.interaction);
      await postService.handleButtonInteraction(second.interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(first.message.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the delayed edit when the layout is confirmed", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord({ lastConfirmedAt: null });
      const confirmed = buildRecord({
        lastConfirmedAt: new Date("2026-08-25T00:00:00.000Z"),
        lastConfirmedByDiscordUserId: "clicker-1",
      });
      layoutRecordService.findById.mockResolvedValue(record);
      layoutRecordService.confirmSuccessfulOpening.mockResolvedValue(confirmed);
      const first = makeInteraction({
        customId: buildLayoutPostCustomId("link", record.id),
      });
      const second = makeInteraction({
        customId: buildLayoutPostCustomId("confirm", record.id),
      });
      second.interaction.message = first.interaction.message;
      postService = new LayoutPostService({
        layoutService: layoutRecordService,
        autoCollapseDelayMs: 100,
      });

      await postService.handleButtonInteraction(first.interaction);
      await postService.handleButtonInteraction(second.interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(first.message.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
