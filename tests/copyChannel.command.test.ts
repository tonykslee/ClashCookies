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

function makeInteraction(input?: {
  messageCount?: number;
  channelType?: ChannelType;
  permissions?: boolean;
  fetchRejects?: boolean;
  messages?: ReturnType<typeof makeMessage>[];
}) {
  const fetch = vi.fn();
  if (input?.fetchRejects) {
    fetch.mockRejectedValue(new Error("missing access"));
  } else {
    const messages = new Map(
      (input?.messages ?? []).map((message) => [message.id, message] as const),
    );
    fetch.mockResolvedValue(messages);
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
      getInteger: vi.fn().mockReturnValue(input?.messageCount ?? 10),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    user: { id: "user-1" },
    deferred: false,
    replied: false,
  };
}

describe("/copy-channel command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports the latest messages in chronological order as an inline code block", async () => {
    const interaction = makeInteraction({
      messageCount: 2,
      messages: [
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
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("[2026-04-20 00:00] first-user: Hello there"),
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("[2026-04-20 00:05] Second User: [attachments: 1]"),
      }),
    );
  });

  it("returns a txt attachment for long exports", async () => {
    const interaction = makeInteraction({
      messageCount: 1,
      messages: [
        makeMessage({
          id: "1",
          createdTimestamp: Date.parse("2026-04-20T00:00:00.000Z"),
          displayName: "Long User",
          content: "x".repeat(2100),
        }),
      ],
    });

    await CopyChannel.run({} as any, interaction as any, {} as any);

    const payload = interaction.editReply.mock.calls.at(-1)?.[0] as any;
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
