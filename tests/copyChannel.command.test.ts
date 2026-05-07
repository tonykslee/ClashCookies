import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CopyChannel } from "../src/commands/CopyChannel";

function makeMessage(input: {
  id: string;
  createdTimestamp: number;
  content?: string;
  displayName?: string;
  username?: string;
  attachments?: number;
  embeds?: number;
  stickers?: number;
}) {
  return {
    id: input.id,
    createdTimestamp: input.createdTimestamp,
    content: input.content ?? "",
    member: input.displayName ? { displayName: input.displayName } : null,
    author: {
      username: input.username ?? `user-${input.id}`,
      globalName: null,
      displayName: null,
    },
    attachments: { size: input.attachments ?? 0 },
    embeds: Array.from({ length: input.embeds ?? 0 }, () => ({})),
    stickers: { size: input.stickers ?? 0 },
  } as any;
}

function makePage(messages: ReturnType<typeof makeMessage>[]) {
  return new Map(messages.map((message) => [message.id, message] as const));
}

function makeInteraction(input?: {
  messageCount?: number;
  after?: string | null;
  before?: string | null;
  channelType?: ChannelType;
  permissions?: boolean;
  fetchRejects?: boolean;
  fetchPages?: Map<string, ReturnType<typeof makeMessage>>[];
}) {
  const fetch = vi.fn();
  if (input?.fetchRejects) {
    fetch.mockRejectedValue(new Error("missing access"));
  } else {
    const pages = [...(input?.fetchPages ?? [])];
    fetch.mockImplementation(async () => pages.shift() ?? new Map());
  }

  const channel = {
    type: input?.channelType ?? ChannelType.GuildText,
    messages: {
      fetch,
    },
    permissionsFor: vi.fn().mockReturnValue({
      has: vi.fn().mockReturnValue(input?.permissions ?? true),
    }),
  } as any;

  return {
    inGuild: vi.fn().mockReturnValue(true),
    guildId: "guild-1",
    guild: {
      members: {
        me: { id: "bot-1" },
        fetchMe: vi.fn().mockResolvedValue({ id: "bot-1" }),
      },
    },
    channel,
    options: {
      getInteger: vi.fn((name: string) =>
        name === "messages" ? input?.messageCount ?? 10 : null,
      ),
      getString: vi.fn((name: string) => {
        if (name === "after") return input?.after ?? null;
        if (name === "before") return input?.before ?? null;
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    user: { id: "user-1" },
    deferred: false,
    replied: false,
  };
}

function lastEditReplyPayload(interaction: ReturnType<typeof makeInteraction>) {
  return interaction.editReply.mock.calls.at(-1)?.[0] as any;
}

describe("/copy-channel command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports the latest messages in chronological order when no anchor is provided", async () => {
    const interaction = makeInteraction({
      messageCount: 2,
      fetchPages: [
        makePage([
          makeMessage({
            id: "2",
            createdTimestamp: Date.parse("2026-04-20T00:05:00.000Z"),
            displayName: "Second User",
            content: "",
            attachments: 1,
          }),
          makeMessage({
            id: "1",
            createdTimestamp: Date.parse("2026-04-20T00:00:00.000Z"),
            username: "first-user",
            content: "Hello there",
          }),
        ]),
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.channel.messages.fetch).toHaveBeenCalledTimes(1);
    expect(interaction.channel.messages.fetch).toHaveBeenCalledWith({ limit: 2 });
    expect(lastEditReplyPayload(interaction).content).toContain(
      "[2026-04-20 00:00] first-user: Hello there",
    );
    expect(lastEditReplyPayload(interaction).content).toContain(
      "[2026-04-20 00:05] Second User: [attachments: 1]",
    );
    expect(
      lastEditReplyPayload(interaction).content.indexOf(
        "[2026-04-20 00:00] first-user: Hello there",
      ),
    ).toBeLessThan(
      lastEditReplyPayload(interaction).content.indexOf(
        "[2026-04-20 00:05] Second User: [attachments: 1]",
      ),
    );
  });

  it("pages latest exports with at most two Discord fetches for 200 messages", async () => {
    const baseTime = Date.parse("2026-04-20T00:00:00.000Z");
    const interaction = makeInteraction({
      messageCount: 200,
      fetchPages: [
        makePage(
          Array.from({ length: 100 }, (_, index) =>
            makeMessage({
              id: `${101 + index}`,
              createdTimestamp: baseTime + index * 60_000,
              content: `page-one-${index}`,
            }),
          ),
        ),
        makePage(
          Array.from({ length: 100 }, (_, index) =>
            makeMessage({
              id: `${100 - index}`,
              createdTimestamp: baseTime + (100 + index) * 60_000,
              content: `page-two-${index}`,
            }),
          ),
        ),
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.messages.fetch).toHaveBeenCalledTimes(2);
    expect(interaction.channel.messages.fetch.mock.calls[0]?.[0]).toEqual({ limit: 100 });
    expect(interaction.channel.messages.fetch.mock.calls[1]?.[0]).toMatchObject({
      limit: 100,
      before: "101",
    });
  });

  it("uses before pagination and excludes the anchor message", async () => {
    const interaction = makeInteraction({
      messageCount: 2,
      before: "123456789012345678",
      fetchPages: [
        makePage([
          makeMessage({
            id: "2",
            createdTimestamp: Date.parse("2026-04-20T00:05:00.000Z"),
            displayName: "Before User Two",
            content: "before-two",
          }),
          makeMessage({
            id: "1",
            createdTimestamp: Date.parse("2026-04-20T00:00:00.000Z"),
            displayName: "Before User One",
            content: "before-one",
          }),
        ]),
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.messages.fetch).toHaveBeenCalledWith({
      limit: 2,
      before: "123456789012345678",
    });
    expect(lastEditReplyPayload(interaction).content).toContain("before-one");
    expect(lastEditReplyPayload(interaction).content).toContain("before-two");
  });

  it("uses after pagination and excludes the anchor message", async () => {
    const interaction = makeInteraction({
      messageCount: 2,
      after: "123456789012345678",
      fetchPages: [
        makePage([
          makeMessage({
            id: "3",
            createdTimestamp: Date.parse("2026-04-20T00:10:00.000Z"),
            displayName: "After User Three",
            content: "after-three",
          }),
          makeMessage({
            id: "4",
            createdTimestamp: Date.parse("2026-04-20T00:15:00.000Z"),
            displayName: "After User Four",
            content: "after-four",
          }),
        ]),
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.channel.messages.fetch).toHaveBeenCalledWith({
      limit: 2,
      after: "123456789012345678",
    });
    expect(lastEditReplyPayload(interaction).content).toContain("after-three");
    expect(lastEditReplyPayload(interaction).content).toContain("after-four");
  });

  it("rejects both anchors together with a clear error", async () => {
    const interaction = makeInteraction({
      after: "123456789012345678",
      before: "223456789012345678",
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Use either after or before, not both.",
    });
  });

  it("rejects invalid message ids with a clear error", async () => {
    const interaction = makeInteraction({
      after: "not-a-message-id",
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Message id must be a valid Discord message id.",
    });
  });

  it("returns scoped empty-state text for before and after anchors", async () => {
    const beforeInteraction = makeInteraction({
      messageCount: 1,
      before: "123456789012345678",
      fetchPages: [makePage([])],
    });

    await CopyChannel.run({} as any, beforeInteraction as any, {} as any);

    expect(lastEditReplyPayload(beforeInteraction).content).toBe(
      "No messages found before that message id.",
    );

    const afterInteraction = makeInteraction({
      messageCount: 1,
      after: "123456789012345678",
      fetchPages: [makePage([])],
    });

    await CopyChannel.run({} as any, afterInteraction as any, {} as any);

    expect(lastEditReplyPayload(afterInteraction).content).toBe(
      "No messages found after that message id.",
    );
  });

  it("dedupes overlapping paginated results before exporting", async () => {
    const interaction = makeInteraction({
      messageCount: 101,
      fetchPages: [
        makePage(
          Array.from({ length: 100 }, (_, index) =>
            makeMessage({
              id: `${index + 1}`,
              createdTimestamp: Date.parse("2026-04-20T00:00:00.000Z") + index * 60_000,
              displayName: `First Page User ${index + 1}`,
              content: `page-one-${index + 1}`,
            }),
          ),
        ),
        makePage([
          makeMessage({
            id: "100",
            createdTimestamp: Date.parse("2026-04-20T01:40:00.000Z"),
            displayName: "Duplicate User",
            content: "page-one-100",
          }),
          makeMessage({
            id: "101",
            createdTimestamp: Date.parse("2026-04-20T01:41:00.000Z"),
            displayName: "New User",
            content: "page-two-unique",
          }),
        ]),
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    const payload = lastEditReplyPayload(interaction);
    const content = payload.files[0].attachment.toString("utf8") as string;
    expect(content).toContain("page-one-100");
    expect(content).toContain("page-two-unique");
    expect(content.match(/page-one-100/g)?.length ?? 0).toBe(1);
  });

  it("returns a txt attachment for long exports", async () => {
    const interaction = makeInteraction({
      messageCount: 1,
      fetchPages: [
        makePage([
          makeMessage({
            id: "1",
            createdTimestamp: Date.parse("2026-04-20T00:00:00.000Z"),
            displayName: "Long User",
            content: "x".repeat(2100),
          }),
        ]),
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    const payload = lastEditReplyPayload(interaction);
    expect(payload.content).toContain(".txt attachment");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name.endsWith(".txt")).toBe(true);
  });

  it("fails clearly outside supported text or announcement channels", async () => {
    const interaction = makeInteraction({
      channelType: ChannelType.GuildVoice,
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "This command can only be used in a server text or announcement channel.",
    });
  });

  it("fails clearly when the bot lacks read history access", async () => {
    const interaction = makeInteraction({
      permissions: false,
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "I need `View Channel` and `Read Message History` in this channel to export messages.",
    });
  });
});
