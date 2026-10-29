import { beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutAlertMode, LayoutRecord } from "@prisma/client";
import {
  buildLayoutInfoDescription,
  buildLayoutPostCustomId,
  buildLayoutPostPanelCustomId,
  buildLayoutPostPayload,
  buildLayoutPostVersionToken,
  isLayoutPostButtonCustomId,
  isLayoutPostCustomId,
  LayoutPostService,
  parseLayoutPostCustomId,
  parseLayoutPostPanelCustomId,
  resolveLayoutPostImageSource,
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
  userId?: string;
  attachments?: { first: ReturnType<typeof vi.fn> };
  embeds?: Array<{ image?: { url?: string | null } | null } | null>;
  components?: Array<{ components: Array<{ customId?: string; data?: { custom_id?: string } }> }>;
}) {
  const message = {
    id: input.messageId ?? "message-1",
    attachments: input.attachments ?? { first: vi.fn().mockReturnValue(null) },
    embeds: input.embeds ?? [],
    components: input.components ?? [],
    edit: vi.fn().mockResolvedValue(undefined),
  };
  const interaction: any = {
    customId: input.customId,
    guildId: input.guildId === undefined ? "guild-1" : input.guildId,
    channelId: input.channelId === undefined ? "channel-1" : input.channelId,
    user: { id: input.userId ?? "clicker-1" },
    message,
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
  return { interaction, message };
}

function legacyExpandedComponents(
  record: LayoutRecord,
  mode: "link" | "info" = "link",
): Array<{ components: Array<{ customId: string }> }> {
  const ids = mode === "link"
    ? [
        buildLayoutPostCustomId(
          "confirm",
          record.id,
          buildLayoutPostVersionToken(record.layoutLink, record.submittedAt),
        ),
        buildLayoutPostCustomId("close", record.id),
        buildLayoutPostCustomId("info", record.id),
      ]
    : [
        buildLayoutPostCustomId("link", record.id),
        buildLayoutPostCustomId("close", record.id),
      ];
  return [{ components: ids.map((customId) => ({ customId })) }];
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

  it("keeps a same-message attachment in the public Info view", () => {
    const payload = buildLayoutPostPayload(
      buildRecord({ imageUrl: null }),
      "info",
      { attachmentName: "base.png" },
    );

    expect(payload.embeds?.[0]?.toJSON().image?.url).toBe("attachment://base.png");
  });

  it("recovers an embedded native image when the attachment collection is empty", () => {
    const resolution = resolveLayoutPostImageSource({
      attachments: { first: vi.fn(() => undefined) },
      embeds: [{ image: { url: "attachment://embedded.png" } }],
    });

    expect(resolution).toEqual({
      source: { attachmentName: "embedded.png", attachmentUrl: null },
      kind: "embedded_attachment",
    });
    expect(buildLayoutPostPayload(buildRecord({ imageUrl: null }), "collapsed", resolution.source)
      .embeds?.[0]?.toJSON().image?.url).toBe("attachment://embedded.png");
  });

  it("prefers a standalone native attachment over embedded image metadata", () => {
    const resolution = resolveLayoutPostImageSource({
      attachments: { first: vi.fn(() => ({ name: "standalone.png", url: "https://cdn.example/standalone.png" })) },
      embeds: [{ image: { url: "attachment://embedded.png" } }],
    });

    expect(resolution.kind).toBe("attachment_collection");
    expect(resolution.source.attachmentName).toBe("standalone.png");
  });

  it("renders the link URL and confirmation question with link controls", () => {
    const payload = buildLayoutPostPayload(record, "link");
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

  it("renders Info metadata in the public post without exposing the URL", () => {
    const payload = buildLayoutPostPayload(record, "info");
    const embed = payload.embeds?.[0]?.toJSON();
    const serialized = JSON.stringify(payload);
    const description = embed?.description ?? "";

    expect(embed?.title).toBe(record.title);
    expect(embed?.image?.url).toBe(record.imageUrl);
    expect(description).toContain("TH18 • WB");
    expect(description).toContain(record.description as string);
    expect(description).toContain("<@poster-1>");
    expect(description).toContain("Submitted:");
    expect(description).toContain("Last confirmed active:");
    expect(description).toContain("<@confirmer-1>");
    expect(serialized).not.toContain(record.layoutLink);
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload.components[0]?.toJSON().components.map((button) => button.label)).toEqual([
      "Layout Link",
      "Close",
    ]);
  });

  it("shows unknown freshness for a legacy record without confirmation or submission", () => {
    const description = buildLayoutInfoDescription(
      buildRecord({ submittedAt: null, lastConfirmedAt: null }),
    );

    expect(description).toContain("Freshness: unknown/not yet established");
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

  it("binds private panel actions to the canonical post and user", () => {
    const customId = buildLayoutPostPanelCustomId(
      "confirm",
      "layout-1",
      "message-1",
      "clicker-1",
      buildLayoutPostVersionToken(LAYOUT_LINK, new Date("2026-08-20T00:00:00.000Z")),
    );

    expect(parseLayoutPostPanelCustomId(customId)).toEqual({
      action: "confirm",
      layoutId: "layout-1",
      canonicalMessageId: "message-1",
      ownerDiscordUserId: "clicker-1",
      versionToken: expect.any(String),
    });
    expect(isLayoutPostCustomId(customId)).toBe(true);
    expect(isLayoutPostButtonCustomId(customId)).toBe(true);
  });

  it("keeps UUID and Discord snowflake panel IDs within the component limit", () => {
    const customId = buildLayoutPostPanelCustomId(
      "confirm",
      "12345678-1234-1234-1234-123456789012",
      "123456789012345678",
      "987654321098765432",
      "0123456789abcdef",
    );

    expect(customId.length).toBeLessThanOrEqual(100);
    expect(parseLayoutPostPanelCustomId(customId)?.action).toBe("confirm");
  });
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

  it("reveals the link in an ephemeral panel without editing the public post", async () => {
    const record = buildRecord({ lastConfirmedAt: null });
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("link", record.id),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ ephemeral: true }));
    expect(JSON.stringify(interaction.reply.mock.calls[0]?.[0])).toContain(record.layoutLink);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("shows Info in an ephemeral panel without mutating the public post", async () => {
    const record = buildRecord();
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("info", record.id),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ ephemeral: true }));
    expect(JSON.stringify(interaction.reply.mock.calls[0]?.[0])).not.toContain(record.layoutLink);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it.each(["link", "info", "close", "confirm"] as const)(
    "does not edit or re-upload the public native image through the %s action",
    async (action) => {
      const record = buildRecord({ imageUrl: null });
      layoutRecordService.findById.mockResolvedValue(record);
      layoutRecordService.confirmSuccessfulOpening.mockResolvedValue(record);
      postService = new LayoutPostService({ layoutService: layoutRecordService });
      const customId = action === "confirm"
        ? buildLayoutPostCustomId(
            action,
            record.id,
            buildLayoutPostVersionToken(record.layoutLink, record.submittedAt),
          )
        : buildLayoutPostCustomId(action, record.id);
      const { interaction, message } = makeInteraction({
        customId,
        attachments: { first: vi.fn(() => undefined) },
        embeds: [{ image: { url: "attachment://embedded.png" } }],
      });

      await postService.handleButtonInteraction(interaction);

      expect(interaction.update).not.toHaveBeenCalled();
      expect(interaction.message.edit).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalled();
      expect(message.attachments.first).not.toHaveBeenCalled();
    },
  );

  it("shows the current durable alert policy and resolves the default channel dynamically", async () => {
    const record = buildRecord();
    layoutRecordService.findById.mockResolvedValue(record);
    const getPolicy = vi.fn().mockResolvedValue({
      layoutId: record.id,
      mode: LayoutAlertMode.DEFAULT_CHANNEL,
      customChannelId: null,
    });
    const getChannelIdForType = vi.fn().mockResolvedValue("alerts-1");
    postService = new LayoutPostService({
      layoutService: layoutRecordService,
      alertConfigService: { getPolicy },
      botLogChannelService: { getChannelIdForType },
    });
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("info", record.id),
    });

    await postService.handleButtonInteraction(interaction);

    const description = interaction.reply.mock.calls[0]?.[0]?.embeds?.[0]
      ?.toJSON().description;
    expect(description).toContain("Expiration alert: <#alerts-1>");
    expect(getPolicy).toHaveBeenCalledWith(record.id);
    expect(getChannelIdForType).toHaveBeenCalledWith("guild-1", "layout-alerts");
  });

  it("collapses a restart-surviving legacy expanded link post on Close", async () => {
    const record = buildRecord({ imageUrl: "https://example.com/layout.png" });
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("close", record.id),
      embeds: [{ description: `[Open Layout](<${record.layoutLink}>)` }],
      components: legacyExpandedComponents(record),
    });

    await postService.handleButtonInteraction(interaction);

    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.update.mock.calls[0]?.[0]?.components?.[0]?.toJSON().components.map(
      (button: { label: string }) => button.label,
    )).toEqual(["Layout Link", "Info"]);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
  });

  it("records a valid legacy confirmation and collapses the expanded public post", async () => {
    const record = buildRecord({ lastConfirmedAt: null });
    const confirmed = buildRecord({
      lastConfirmedAt: new Date("2026-08-25T00:00:00.000Z"),
      lastConfirmedByDiscordUserId: "clicker-1",
    });
    layoutRecordService.findById.mockResolvedValue(record);
    layoutRecordService.confirmSuccessfulOpening.mockResolvedValue(confirmed);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId(
        "confirm",
        record.id,
        buildLayoutPostVersionToken(record.layoutLink, record.submittedAt),
      ),
      embeds: [{ description: `[Open Layout](<${record.layoutLink}>)` }],
      components: legacyExpandedComponents(record),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).toHaveBeenCalledWith({
      id: record.id,
      discordUserId: "clicker-1",
      expectedLayoutLink: record.layoutLink,
      expectedSubmittedAt: record.submittedAt,
    });
    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("does not record freshness or collapse a legacy post for a stale token", async () => {
    const record = buildRecord({ lastConfirmedAt: null });
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId(
        "confirm",
        record.id,
        buildLayoutPostVersionToken("https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3AOLD", record.submittedAt),
      ),
      embeds: [{ description: `[Open Layout](<${record.layoutLink}>)` }],
      components: legacyExpandedComponents(record),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("older layout link"),
    }));
  });

  it("preserves a native attachment while collapsing a legacy post", async () => {
    const record = buildRecord({ imageUrl: null });
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("close", record.id),
      attachments: { first: vi.fn(() => ({ name: "legacy-base.png", url: "https://cdn.example/legacy-base.png" })) },
      embeds: [{ description: `[Open Layout](<${record.layoutLink}>)` }],
      components: legacyExpandedComponents(record),
    });

    await postService.handleButtonInteraction(interaction);

    const payload = interaction.update.mock.calls[0]?.[0];
    expect(payload.embeds?.[0]?.toJSON().image?.url).toBe("attachment://legacy-base.png");
    expect(payload.attachments).toBeUndefined();
  });

  it("reports a legacy cleanup failure without claiming relocation or confirmation success", async () => {
    const record = buildRecord();
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("close", record.id),
      embeds: [{ description: `[Open Layout](<${record.layoutLink}>)` }],
      components: legacyExpandedComponents(record),
    });
    interaction.update.mockRejectedValue(new Error("Discord unavailable"));

    await postService.handleButtonInteraction(interaction);

    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Failed to update"),
    }));
  });

  it("closes a private link panel without writing lifecycle state or editing the public post", async () => {
    const record = buildRecord();
    layoutRecordService.findById.mockResolvedValue(record);
    const close = makeInteraction({
      customId: buildLayoutPostPanelCustomId("close", record.id, record.discordMessageId!, "clicker-1"),
      messageId: "ephemeral-panel-1",
    });

    await postService.handleButtonInteraction(close.interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(close.interaction.update).toHaveBeenCalledWith(expect.objectContaining({
      components: [],
    }));
    expect(close.message.edit).not.toHaveBeenCalled();
  });

  it("confirms for the panel owner and leaves the public post unchanged", async () => {
    const record = buildRecord({ lastConfirmedAt: null, title: null, imageUrl: null });
    const confirmed = buildRecord({
      title: null,
      imageUrl: null,
      lastConfirmedAt: new Date("2026-08-25T00:00:00.000Z"),
      lastConfirmedByDiscordUserId: "clicker-1",
    });
    layoutRecordService.findById.mockResolvedValue(record);
    layoutRecordService.confirmSuccessfulOpening.mockResolvedValue(confirmed);
    const interaction = makeInteraction({
      customId: buildLayoutPostPanelCustomId(
        "confirm",
        record.id,
        record.discordMessageId!,
        "clicker-1",
        buildLayoutPostVersionToken(record.layoutLink, record.submittedAt),
      ),
      messageId: "ephemeral-panel-1",
    });

    await postService.handleButtonInteraction(interaction.interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).toHaveBeenCalledTimes(1);
    expect(layoutRecordService.confirmSuccessfulOpening).toHaveBeenCalledWith({
      id: record.id,
      discordUserId: "clicker-1",
      expectedLayoutLink: record.layoutLink,
      expectedSubmittedAt: record.submittedAt,
    });
    expect(interaction.interaction.update).toHaveBeenCalledWith(expect.objectContaining({
      components: [],
    }));
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });

  it("rejects a panel click from another Discord user", async () => {
    const record = buildRecord();
    layoutRecordService.findById.mockResolvedValue(record);
    const interaction = makeInteraction({
      customId: buildLayoutPostPanelCustomId("confirm", record.id, record.discordMessageId!, "clicker-1", buildLayoutPostVersionToken(record.layoutLink, record.submittedAt)),
      messageId: "ephemeral-panel-1",
      userId: "other-user",
    });

    await postService.handleButtonInteraction(interaction.interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.interaction.update).not.toHaveBeenCalled();
    expect(interaction.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("no longer valid"),
    }));
  });

  it("rejects a stale private panel after the layout episode changes", async () => {
    const record = buildRecord({
      layoutLink: "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3ANEW_EPISODE",
    });
    layoutRecordService.findById.mockResolvedValue(record);
    const interaction = makeInteraction({
      customId: buildLayoutPostPanelCustomId(
        "confirm",
        record.id,
        record.discordMessageId!,
        "clicker-1",
        buildLayoutPostVersionToken(LAYOUT_LINK, record.submittedAt),
      ),
      messageId: "ephemeral-panel-1",
    });

    await postService.handleButtonInteraction(interaction.interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.interaction.update).not.toHaveBeenCalled();
    expect(interaction.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("older layout link"),
    }));
  });

  it("rejects a legacy confirmation control without mutating freshness", async () => {
    const record = buildRecord({ lastConfirmedAt: null });
    layoutRecordService.findById.mockResolvedValue(record);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId("confirm", record.id),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("older layout link"),
    }));
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("rejects a confirmation token from a previous link episode", async () => {
    const oldLink = LAYOUT_LINK;
    const currentLink = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3ACURRENT_EPISODE";
    const current = buildRecord({ layoutLink: currentLink, lastConfirmedAt: null });
    layoutRecordService.findById.mockResolvedValue(current);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId(
        "confirm",
        current.id,
        buildLayoutPostVersionToken(oldLink, current.submittedAt),
      ),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("older layout link"),
    }));
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("rejects the first A episode after an A to B to A replacement sequence", async () => {
    const firstA = buildRecord({
      layoutLink: LAYOUT_LINK,
      submittedAt: new Date("2026-08-20T00:00:00.000Z"),
      lastConfirmedAt: null,
    });
    const secondA = buildRecord({
      layoutLink: LAYOUT_LINK,
      submittedAt: new Date("2026-08-22T00:00:00.000Z"),
      lastConfirmedAt: null,
    });
    layoutRecordService.findById.mockResolvedValue(secondA);
    const { interaction } = makeInteraction({
      customId: buildLayoutPostCustomId(
        "confirm",
        secondA.id,
        buildLayoutPostVersionToken(firstA.layoutLink, firstA.submittedAt),
      ),
    });

    await postService.handleButtonInteraction(interaction);

    expect(layoutRecordService.confirmSuccessfulOpening).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("older layout link"),
    }));
    expect(interaction.update).not.toHaveBeenCalled();
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

  it("does not auto-collapse or edit the public post after an ephemeral link panel", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord({ title: null, imageUrl: null });
      layoutRecordService.findById.mockResolvedValue(record);
      const { interaction, message } = makeInteraction({
        customId: buildLayoutPostCustomId("link", record.id),
      });
      postService = new LayoutPostService({ layoutService: layoutRecordService });

      await postService.handleButtonInteraction(interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(message.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an embedded native image untouched after the link panel opens", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord({ imageUrl: null });
      layoutRecordService.findById.mockResolvedValue(record);
      const { interaction, message } = makeInteraction({
        customId: buildLayoutPostCustomId("link", record.id),
        attachments: { first: vi.fn(() => undefined) },
        embeds: [{ image: { url: "attachment://embedded.png" } }],
      });
      postService = new LayoutPostService({ layoutService: layoutRecordService });

      await postService.handleButtonInteraction(interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(message.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-collapse or edit the public post after an ephemeral Info panel", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord({ title: null, imageUrl: null });
      layoutRecordService.findById.mockResolvedValue(record);
      const { interaction, message } = makeInteraction({
        customId: buildLayoutPostCustomId("info", record.id),
      });
      postService = new LayoutPostService({ layoutService: layoutRecordService });

      await postService.handleButtonInteraction(interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(message.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a panel without scheduling a public edit", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord();
      layoutRecordService.findById.mockResolvedValue(record);
      const second = makeInteraction({
        customId: buildLayoutPostPanelCustomId("close", record.id, record.discordMessageId!, "clicker-1"),
        messageId: "ephemeral-panel-1",
      });
      postService = new LayoutPostService({ layoutService: layoutRecordService });

      await postService.handleButtonInteraction(second.interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(second.message.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms through a panel without scheduling a public edit", async () => {
    vi.useFakeTimers();
    try {
      const record = buildRecord({ lastConfirmedAt: null });
      const confirmed = buildRecord({
        lastConfirmedAt: new Date("2026-08-25T00:00:00.000Z"),
        lastConfirmedByDiscordUserId: "clicker-1",
      });
      layoutRecordService.findById.mockResolvedValue(record);
      layoutRecordService.confirmSuccessfulOpening.mockResolvedValue(confirmed);
      const second = makeInteraction({
        customId: buildLayoutPostPanelCustomId(
          "confirm",
          record.id,
          record.discordMessageId!,
          "clicker-1",
          buildLayoutPostVersionToken(record.layoutLink, record.submittedAt),
        ),
        messageId: "ephemeral-panel-1",
      });
      postService = new LayoutPostService({ layoutService: layoutRecordService });

      await postService.handleButtonInteraction(second.interaction);
      await vi.advanceTimersByTimeAsync(100);

      expect(second.message.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
