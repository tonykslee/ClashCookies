import { describe, expect, it, vi } from "vitest";
import {
  FWA_LAYOUT_SUBCOMMAND,
  runFwaLayoutCommand,
} from "../src/commands/fwa/layoutCommand";
import { FwaLayoutTownhallMismatchError } from "../src/services/FwaLayoutService";

const LINK =
  "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3APAYLOAD18";

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "layout-1",
    layoutLink: LINK,
    title: null,
    description: null,
    imageUrl: null,
    postedByDiscordUserId: "admin-1",
    discordGuildId: null,
    discordChannelId: null,
    discordMessageId: null,
    submittedAt: null,
    lastConfirmedAt: null,
    lastConfirmedByDiscordUserId: null,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    updatedAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  };
}

function buildCanonical(overrides: Record<string, unknown> = {}) {
  return {
    Townhall: 18,
    Type: "RISINGDAWN",
    LayoutLink: LINK,
    ImageUrl: null,
    LastUpdated: new Date("2026-08-25T00:00:00.000Z"),
    layoutId: "layout-1",
    layoutRecord: buildRecord(),
    ...overrides,
  };
}

function makeInteraction(input: {
  th?: number | null;
  type?: string | null;
  link?: string | null;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  admin?: boolean;
  channel?: unknown;
  alertType?: string | null;
  alertChannel?: Record<string, unknown> | null;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction: any = {
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "admin-1" },
    memberPermissions: { has: vi.fn(() => input.admin ?? true) },
    channel: input.channel ?? { id: "channel-1", send: vi.fn() },
    reply,
    options: {
      getInteger: vi.fn(() => input.th ?? null),
      getString: vi.fn((name: string) => {
        if (name === "type") return input.type ?? null;
        if (name === "link") return input.link ?? null;
        if (name === "title") return input.title ?? null;
        if (name === "description") return input.description ?? null;
        if (name === "img-url") return input.imageUrl ?? null;
        if (name === "alert-type") return input.alertType ?? null;
        return null;
      }),
      getChannel: vi.fn(() => input.alertChannel ?? null),
    },
  };
  return { interaction, reply };
}

describe("/fwa layout", () => {
  it("registers the canonical options without requiring TH for link updates", () => {
    expect(FWA_LAYOUT_SUBCOMMAND.name).toBe("layout");
    expect(FWA_LAYOUT_SUBCOMMAND.options.map((option) => option.name)).toEqual([
      "th",
      "type",
      "link",
      "title",
      "description",
      "img-url",
      "alert-type",
      "alert-channel",
    ]);
  });

  it("derives TH on update, publishes the canonical post, and does not echo the Clash link", async () => {
    const setCanonicalLayout = vi.fn().mockResolvedValue(buildCanonical());
    const publish = vi.fn().mockResolvedValue({
      layout: buildRecord(),
      messageId: "message-1",
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    });
    const { interaction, reply } = makeInteraction({ link: LINK, type: "BASIC" });

    await runFwaLayoutCommand(interaction, {
      layoutService: { setCanonicalLayout } as any,
      publicationService: { publish } as any,
      alertConfigService: { setPolicy: vi.fn(), disablePolicy: vi.fn() } as any,
      botLogChannelService: { getChannelIdForType: vi.fn() } as any,
    });

    expect(setCanonicalLayout).toHaveBeenCalledWith(
      expect.objectContaining({ townhall: null, type: "BASIC", layoutLink: LINK }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(String(reply.mock.calls[0]?.[0].content)).not.toContain(LINK);
    expect(String(reply.mock.calls[0]?.[0].content)).toContain("View post");
  });

  it("requires Administrator only for update mode", async () => {
    const setCanonicalLayout = vi.fn();
    const { interaction, reply } = makeInteraction({ link: LINK, admin: false });

    await runFwaLayoutCommand(interaction, {
      layoutService: { setCanonicalLayout } as any,
      publicationService: { publish: vi.fn() } as any,
    });

    expect(setCanonicalLayout).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Only administrators can update FWA layouts." }),
    );
  });

  it("persists explicit alert policy only after the canonical post is published", async () => {
    const setCanonicalLayout = vi.fn().mockResolvedValue(buildCanonical());
    const publish = vi.fn().mockResolvedValue({
      layout: buildRecord({ discordMessageId: "message-1" }),
      messageId: "message-1",
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    });
    const setPolicy = vi.fn().mockResolvedValue(undefined);
    const { interaction } = makeInteraction({ link: LINK, alertType: "dm" });

    await runFwaLayoutCommand(interaction, {
      layoutService: { setCanonicalLayout } as any,
      publicationService: { publish } as any,
      alertConfigService: { setPolicy, disablePolicy: vi.fn() } as any,
      botLogChannelService: { getChannelIdForType: vi.fn() } as any,
    });

    expect(setCanonicalLayout).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(setPolicy).toHaveBeenCalledWith({
      layoutId: "layout-1",
      mode: "DM",
      customChannelId: null,
    });
  });

  it("does not mutate list mode when alert options are supplied without a link", async () => {
    const listCanonical = vi.fn().mockResolvedValue([]);
    const { interaction, reply } = makeInteraction({ alertType: "dm" });

    await runFwaLayoutCommand(interaction, {
      layoutService: { listCanonical } as any,
      publicationService: { publish: vi.fn() } as any,
    });

    expect(listCanonical).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("alert-type"),
    }));
  });

  it("returns a jump link for a legacy lookup and does not echo the Clash link", async () => {
    const publish = vi.fn().mockResolvedValue({
      layout: buildRecord(),
      messageId: "message-1",
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    });
    const { interaction, reply } = makeInteraction({ th: 18 });

    await runFwaLayoutCommand(interaction, {
      layoutService: {
        findCanonical: vi.fn().mockResolvedValue(buildCanonical()),
      } as any,
      publicationService: { publish } as any,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(String(reply.mock.calls[0]?.[0].content)).not.toContain(LINK);
    expect(String(reply.mock.calls[0]?.[0].content)).toContain("View post");
  });

  it("lists status without raw Clash links", async () => {
    const { interaction, reply } = makeInteraction({});
    await runFwaLayoutCommand(interaction, {
      layoutService: {
        listCanonical: vi.fn().mockResolvedValue([
          buildCanonical({
            layoutRecord: buildRecord({ submittedAt: new Date("2026-08-20T00:00:00.000Z") }),
          }),
        ]),
      } as any,
    });

    const payload = reply.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).not.toContain(LINK);
    expect(payload.embeds[0].description).toContain("submitted");
    expect(payload.embeds[0].description).toContain("BASIC");
  });

  it("surfaces an explicit TH mismatch without persisting", async () => {
    const setCanonicalLayout = vi
      .fn()
      .mockRejectedValue(new FwaLayoutTownhallMismatchError(17, 18));
    const { interaction, reply } = makeInteraction({ th: 17, link: LINK });

    await runFwaLayoutCommand(interaction, {
      layoutService: { setCanonicalLayout } as any,
    });

    expect(String(reply.mock.calls[0]?.[0].content)).toContain("TH17 does not match");
  });
});
