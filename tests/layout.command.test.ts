import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Layout, LAYOUT_COMMAND_OPTIONS, runLayoutCommand } from "../src/commands/Layout";
import { injectVisibilityOptionsForTest } from "../src/listeners/ready";

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
  link?: string | null;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  attachment?: Record<string, unknown> | null;
  isAdmin?: boolean;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction: any = {
    user: { id: "user-1" },
    client: { channels: { fetch: vi.fn() } },
    guildId: "guild-1",
    channelId: "channel-1",
    channel: { id: "channel-1", send: vi.fn() },
    memberPermissions: { has: vi.fn(() => input.isAdmin ?? true) },
    reply,
    options: {
      getString: vi.fn((name: string) => {
        if (name === "link") return input.link ?? null;
        if (name === "title") return input.title ?? null;
        if (name === "description") return input.description ?? null;
        if (name === "img-url") return input.imageUrl ?? null;
        return null;
      }),
      getAttachment: vi.fn(() => input.attachment ?? null),
    },
  };
  return { interaction, reply };
}

function makeDeps() {
  return {
    getOrCreate: vi.fn().mockResolvedValue(buildRecord()),
    publish: vi.fn().mockResolvedValue({
      layout: buildRecord({ discordMessageId: "message-1" }),
      messageId: "message-1",
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    }),
  };
}

describe("/layout command shape", () => {
  it("exposes only the generic tracked-layout options", () => {
    const registered = injectVisibilityOptionsForTest(Layout) as any;
    expect(registered.options.map((option: any) => option.name)).toEqual([
      "link",
      "title",
      "description",
      "image",
      "img-url",
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
  });

  it("passes native image uploads to the publication layer without persisting the source URL", async () => {
    const { interaction } = makeInteraction({
      link: LINK,
      attachment: { url: "https://cdn.discord.test/base.png", name: "folder/base image.png", contentType: "image/png" },
    });
    const deps = makeDeps();

    await runLayoutCommand(interaction, { layoutService: deps, publicationService: deps as any });

    expect(deps.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: null }));
    expect(deps.getOrCreate.mock.calls[0][0]).not.toHaveProperty("imageUrl", "https://cdn.discord.test/base.png");
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({
      attachment: {
        url: "https://cdn.discord.test/base.png",
        filename: "folder/base image.png",
        contentType: "image/png",
      },
    }));
  });
});
