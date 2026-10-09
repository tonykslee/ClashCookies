import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { ChannelType } from "discord.js";
import {
  Layout,
  LAYOUT_COMMAND_OPTIONS,
  LAYOUT_UPDATE_OPTIONS,
  runLayoutCommand,
} from "../src/commands/Layout";
import { injectVisibilityOptionsForTest } from "../src/listeners/ready";
import { MAX_LAYOUT_ATTACHMENT_BYTES } from "../src/services/LayoutPostPublicationService";

const LINK =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD18";

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "layout-1",
    layoutLink: LINK,
    title: null,
    description: null,
    imageUrl: null,
    postedByDiscordUserId: "user-1",
    discordGuildId: null,
    discordChannelId: null,
    discordMessageId: null,
    submittedAt: new Date("2026-08-25T00:00:00.000Z"),
    lastConfirmedAt: null,
    lastConfirmedByDiscordUserId: null,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  };
}

function makeInteraction(input: {
  subcommand?: string;
  guildId?: string;
  channelId?: string;
  link?: string | null;
  messageId?: string | null;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  attachment?: Record<string, unknown> | null;
  alertType?: string | null;
  alertChannel?: Record<string, unknown> | null;
  isAdmin?: boolean;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction: any = {
    user: { id: "user-1" },
    client: { user: { id: "bot-1" }, channels: { fetch: vi.fn() } },
    guildId: input.guildId ?? "guild-1",
    channelId: input.channelId ?? "channel-1",
    channel: { id: input.channelId ?? "channel-1", send: vi.fn() },
    memberPermissions: { has: vi.fn(() => input.isAdmin ?? true) },
    reply,
    deferred: false,
    deferReply: vi.fn().mockImplementation(async () => { interaction.deferred = true; }),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => input.subcommand ?? "post"),
      getString: vi.fn((name: string) => {
        if (name === "link") return input.link ?? null;
        if (name === "message-id") return input.messageId ?? null;
        if (name === "title") return input.title ?? null;
        if (name === "description") return input.description ?? null;
        if (name === "img-url") return input.imageUrl ?? null;
        if (name === "alert-type") return input.alertType ?? null;
        return null;
      }),
      getAttachment: vi.fn(() => input.attachment ?? null),
      getChannel: vi.fn(() => input.alertChannel ?? null),
    },
  };
  return { interaction, reply };
}

function makeDeps() {
  return {
    getOrCreate: vi.fn().mockResolvedValue(buildRecord()),
    findByLayoutLink: vi.fn().mockResolvedValue(null),
    findByDiscordMessage: vi.fn().mockResolvedValue(null),
    replaceLink: vi.fn().mockResolvedValue(buildRecord()),
    publish: vi.fn().mockResolvedValue({
      layout: buildRecord({
        discordGuildId: "guild-1",
        discordChannelId: "channel-1",
        discordMessageId: "message-1",
      }),
      messageId: "message-1",
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    }),
    setPolicy: vi.fn().mockResolvedValue(undefined),
    disablePolicy: vi.fn().mockResolvedValue(undefined),
    getChannelIdForType: vi.fn().mockResolvedValue("alerts-1"),
    collapseBeforeLinkReplacement: vi.fn().mockResolvedValue(undefined),
  };
}

describe("/layout command shape", () => {
  it("registers post and update subcommands while preserving post options", () => {
    const registered = injectVisibilityOptionsForTest(Layout) as any;
    expect(registered.options.map((option: any) => option.name)).toEqual([
      "post",
      "update",
    ]);
    expect(LAYOUT_COMMAND_OPTIONS[0]).toEqual(expect.objectContaining({
      name: "link",
      type: ApplicationCommandOptionType.String,
      required: true,
    }));
    expect(LAYOUT_COMMAND_OPTIONS[3]).toEqual(expect.objectContaining({
      name: "image",
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    }));
    expect(Layout.options?.some((option) => option.name === "visibility")).toBe(false);
    expect(Layout.suppressVisibilityOption).toBe(true);
    expect(LAYOUT_UPDATE_OPTIONS.map((option) => option.name)).toEqual(["message-id", "link"]);
  });
});

describe("/layout command behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires Administrator before any persistence", async () => {
    const { interaction, reply } = makeInteraction({ isAdmin: false, link: LINK });
    const deps = makeDeps();

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
    });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining("Only administrators"),
    }));
  });

  it.each([
    ["malformed link", "https://example.com/not-a-layout"],
    ["empty link", ""],
    ["whitespace link", "   "],
  ])("rejects %s before persistence", async (_label, link) => {
    const { interaction, reply } = makeInteraction({ link });
    const deps = makeDeps();

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
    });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: "Invalid Clash layout link.",
    }));
  });

  it("creates a generic record, publishes publicly, and acknowledges privately", async () => {
    const { interaction, reply } = makeInteraction({
      link: `  ${LINK}  `,
      title: "TH18 War Base",
      description: "CC troops",
      imageUrl: "https://example.com/base.png",
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
    });

    expect(deps.getOrCreate).toHaveBeenCalledWith({
      layoutLink: LINK,
      title: "TH18 War Base",
      description: "CC troops",
      imageUrl: "https://example.com/base.png",
      postedByDiscordUserId: "user-1",
    });
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({
      layout: expect.anything(),
      guildId: "guild-1",
      channel: interaction.channel,
    }));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: "Layout posted: [View post](https://discord.com/channels/guild-1/channel-1/message-1)",
    }));
    expect(reply.mock.calls[0][0].content).not.toContain(LINK);
  });

  it("rejects invalid external image URLs before persistence", async () => {
    const { interaction, reply } = makeInteraction({ link: LINK, imageUrl: "notaurl" });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "Invalid image URL. Expected a valid http(s) URL.",
    }));
  });

  it("rejects image and img-url together before persistence", async () => {
    const { interaction, reply } = makeInteraction({
      link: LINK,
      imageUrl: "https://example.com/base.png",
      attachment: { url: "https://cdn.discord.test/base.png", name: "base.png", contentType: "image/png" },
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "Choose either `image` or `img-url`, not both.",
    }));
  });

  it("rejects a clearly non-image attachment before persistence", async () => {
    const { interaction, reply } = makeInteraction({
      link: LINK,
      attachment: { url: "https://cdn.discord.test/base.pdf", name: "base.pdf", contentType: "application/pdf" },
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "The `image` attachment must be an image file.",
    }));
  });

  it("reuses exact-link lifecycle without resetting omitted presentation", async () => {
    const { interaction } = makeInteraction({ link: LINK });
    const deps = makeDeps();
    deps.getOrCreate.mockResolvedValue(buildRecord({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "existing-message",
      submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    }));

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.getOrCreate).toHaveBeenCalledWith({
      layoutLink: LINK,
      postedByDiscordUserId: "user-1",
    });
    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.setPolicy).not.toHaveBeenCalled();
    expect(deps.disablePolicy).not.toHaveBeenCalled();
  });

  it("persists an explicit alert policy only after publication", async () => {
    const { interaction } = makeInteraction({ link: LINK, alertType: "dm" });
    const deps = makeDeps();

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
      alertConfigService: deps as any,
      botLogChannelService: deps as any,
    });

    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(deps.setPolicy).toHaveBeenCalledWith({
      layoutId: "layout-1",
      mode: "DM",
      customChannelId: null,
    });
  });

  it("disables an explicit none policy after publication", async () => {
    const { interaction } = makeInteraction({ link: LINK, alertType: "none" });
    const deps = makeDeps();

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
      alertConfigService: deps as any,
      botLogChannelService: deps as any,
    });

    expect(deps.disablePolicy).toHaveBeenCalledWith("layout-1");
    expect(deps.setPolicy).not.toHaveBeenCalled();
  });

  it("requires the configured default channel before persistence", async () => {
    const { interaction, reply } = makeInteraction({
      link: LINK,
      alertType: "default-channel",
    });
    const deps = makeDeps();
    deps.getChannelIdForType.mockResolvedValue(null);

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
      alertConfigService: deps as any,
      botLogChannelService: deps as any,
    });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("No layout-alerts channel is configured"),
    }));
  });

  it("reports policy failure after publication without claiming alerts are enabled", async () => {
    const { interaction, reply } = makeInteraction({ link: LINK, alertType: "dm" });
    const deps = makeDeps();
    deps.setPolicy.mockRejectedValue(new Error("config unavailable"));

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
      alertConfigService: deps as any,
      botLogChannelService: deps as any,
    });

    expect(deps.publish).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("Alert configuration failed; the layout was saved, but the alert policy could not be updated."),
    }));
    expect(reply.mock.calls[0][0].content).not.toContain("expiration alerts are not enabled");
  });

  it("resolves default routing from an exact-link record's canonical guild", async () => {
    const { interaction, reply } = makeInteraction({ link: LINK, alertType: "default-channel" });
    const deps = makeDeps();
    deps.findByLayoutLink.mockResolvedValue(buildRecord({
      discordGuildId: "guild-B",
      discordChannelId: "channel-B",
      discordMessageId: "message-B",
    }));
    deps.publish.mockResolvedValue({
      layout: buildRecord({
        discordGuildId: "guild-B",
        discordChannelId: "channel-B",
        discordMessageId: "message-B",
      }),
      messageId: "message-B",
      jumpUrl: "https://discord.com/channels/guild-B/channel-B/message-B",
    });
    deps.getChannelIdForType.mockImplementation(async (guildId: string) =>
      guildId === "guild-1" ? "alerts-A" : null,
    );

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
      alertConfigService: deps as any,
      botLogChannelService: deps as any,
    });

    expect(deps.getChannelIdForType).toHaveBeenCalledWith("guild-B", "layout-alerts");
    expect(deps.getChannelIdForType).not.toHaveBeenCalledWith("guild-1", "layout-alerts");
    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("No layout-alerts channel is configured"),
    }));
  });

  it("rejects a custom channel from the invoking guild when the canonical post is elsewhere", async () => {
    const { interaction, reply } = makeInteraction({
      link: LINK,
      alertType: "custom-channel",
      alertChannel: { id: "channel-A", guildId: "guild-1", type: ChannelType.GuildText },
    });
    const deps = makeDeps();
    deps.findByLayoutLink.mockResolvedValue(buildRecord({
      discordGuildId: "guild-B",
      discordChannelId: "channel-B",
      discordMessageId: "message-B",
    }));

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
      alertConfigService: deps as any,
      botLogChannelService: deps as any,
    });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("same server"),
    }));
  });

  it("uses the invoking guild for a new unposted layout", async () => {
    const { interaction } = makeInteraction({ link: LINK, alertType: "default-channel" });
    const deps = makeDeps();
    deps.getChannelIdForType.mockResolvedValue("alerts-A");
    deps.publish.mockResolvedValue({
      layout: buildRecord({
        discordGuildId: "guild-1",
        discordChannelId: "channel-1",
        discordMessageId: "message-1",
      }),
      messageId: "message-1",
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    });

    await runLayoutCommand(interaction, {
      layoutService: deps,
      publicationService: deps as any,
      alertConfigService: deps as any,
      botLogChannelService: deps as any,
    });

    expect(deps.findByLayoutLink).toHaveBeenCalledWith(LINK);
    expect(deps.getChannelIdForType).toHaveBeenCalledWith("guild-1", "layout-alerts");
    expect(deps.setPolicy).toHaveBeenCalled();
  });

  it("passes native image uploads to the publication layer without persisting the source URL", async () => {
    const { interaction } = makeInteraction({
      link: LINK,
      attachment: {
        url: "https://cdn.discord.test/base.png",
        name: "folder/base image.png",
        contentType: "image/png",
        size: 4,
      },
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.getOrCreate.mock.calls[0][0]).not.toHaveProperty("imageUrl");
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({
      attachment: {
        url: "https://cdn.discord.test/base.png",
        filename: "folder/base image.png",
        contentType: "image/png",
        size: 4,
      },
    }));
  });

  it("rejects an oversized image attachment before persistence or publication", async () => {
    const { interaction, reply } = makeInteraction({
      link: LINK,
      attachment: {
        url: "https://cdn.discord.test/large.png",
        name: "large.png",
        contentType: "image/png",
        size: MAX_LAYOUT_ATTACHMENT_BYTES + 1,
      },
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.getOrCreate).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: "The `image` attachment is too large.",
    }));
  });

  it("updates the existing bot-authored post without publishing another message", async () => {
    const replacement = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3ANEW_PAYLOAD";
    const { interaction } = makeInteraction({
      subcommand: "update",
      messageId: "123456789012345678",
      link: replacement,
    });
    const deps = makeDeps();
    const existing = buildRecord({
      discordGuildId: "guild-1",
      discordChannelId: "channel-1",
      discordMessageId: "123456789012345678",
      title: "Keep title",
      description: "Keep description",
      imageUrl: "https://example.com/old.png",
      lastConfirmedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const message = {
      id: existing.discordMessageId,
      author: { id: "bot-1" },
      editable: true,
      edit: vi.fn().mockResolvedValue(undefined),
      attachments: { first: vi.fn(() => ({ name: "native.png", url: "https://cdn.test/native.png" })) },
    };
    interaction.client.channels.fetch.mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(message) } });
    deps.findByDiscordMessage.mockResolvedValue(existing);
    deps.replaceLink.mockResolvedValue(buildRecord({ ...existing, layoutLink: replacement, submittedAt: new Date() }));

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(deps.collapseBeforeLinkReplacement).toHaveBeenCalledWith({ layout: existing, message });
    expect(deps.replaceLink).toHaveBeenCalledWith({
      id: existing.id,
      expectedOldLayoutLink: existing.layoutLink,
      replacementLink: replacement,
    });
    expect(deps.publish).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("View original post"),
    }));
  });

  it("accepts an exact full Discord message URL", async () => {
    const replacement = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3ANEW_FULL_URL";
    const guildId = "123456789012345670";
    const channelId = "123456789012345671";
    const messageId = "123456789012345678";
    const { interaction } = makeInteraction({
      subcommand: "update",
      guildId,
      channelId,
      messageId: `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
      link: replacement,
    });
    const deps = makeDeps();
    const existing = buildRecord({
      discordGuildId: guildId,
      discordChannelId: channelId,
      discordMessageId: messageId,
    });
    const message = {
      id: messageId,
      author: { id: "bot-1" },
      editable: true,
      edit: vi.fn().mockResolvedValue(undefined),
      attachments: { first: vi.fn(() => undefined) },
    };
    interaction.client.channels.fetch.mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue(message) } });
    deps.findByDiscordMessage.mockResolvedValue(existing);
    deps.replaceLink.mockResolvedValue(buildRecord({ ...existing, layoutLink: replacement }));

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.findByDiscordMessage).toHaveBeenCalledWith({
      guildId,
      channelId,
      messageId,
    });
    expect(deps.replaceLink).toHaveBeenCalledTimes(1);
  });

  it("rejects a full Discord message URL from another guild before lookup", async () => {
    const guildId = "123456789012345670";
    const { interaction } = makeInteraction({
      subcommand: "update",
      guildId,
      messageId: "https://discord.com/channels/123456789012345679/123456789012345671/123456789012345678",
      link: LINK,
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.findByDiscordMessage).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: "The Discord message URL must point to this server.",
    }));
  });

  it("rejects a raw message ID outside the persisted invoking guild scope", async () => {
    const { interaction, reply } = makeInteraction({
      subcommand: "update",
      messageId: "123456789012345678",
      link: LINK,
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.findByDiscordMessage).toHaveBeenCalledWith({
      guildId: "guild-1",
      messageId: "123456789012345678",
    });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("could not be found"),
    }));
    expect(reply).not.toHaveBeenCalled();
  });
});
