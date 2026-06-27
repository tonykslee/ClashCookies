import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCommands = vi.hoisted(() => [
  {
    name: "alpha",
    description: "Alpha command",
    options: [],
    run: vi.fn(),
  },
  {
    name: "beta",
    description: "Beta command",
    options: [],
    run: vi.fn(),
  },
]);

vi.mock("../src/Commands", () => ({
  Commands: mockCommands,
}));

import { Help } from "../src/commands/Help";

describe("/help Post to Channel behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("posts the help response without notifying mentions", async () => {
    const collectorState: {
      collect?: (component: any) => Promise<void>;
      end?: () => Promise<void>;
    } = {};
    const collector = {
      on: vi.fn((event: string, handler: any) => {
        if (event === "collect") collectorState.collect = handler;
        if (event === "end") collectorState.end = handler;
        return collector;
      }),
      stop: vi.fn(),
    };
    const replyMessage = {
      createMessageComponentCollector: vi.fn(() => collector),
    };
    const sentPayloads: any[] = [];
    const interaction = {
      id: "interaction-1",
      user: { id: "user-1" },
      guildId: "guild-1",
      channel: {
        send: vi.fn(async (payload: any) => {
          sentPayloads.push(payload);
        }),
      },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "command") return null;
          if (name === "visibility") return "private";
          return null;
        }),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      fetchReply: vi.fn().mockResolvedValue(replyMessage),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await Help.run({} as any, interaction as any);

    expect(replyMessage.createMessageComponentCollector).toHaveBeenCalledTimes(1);
    const initialReply = interaction.reply.mock.calls[0]?.[0] as any;
    expect(initialReply.ephemeral).toBe(true);
    expect(initialReply.components).toBeDefined();

    const postButton = {
      customId: "help-post-channel:interaction-1",
      user: { id: "user-1" },
      isButton: () => true,
      isStringSelectMenu: () => false,
      replied: false,
      deferred: false,
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };

    await collectorState.collect?.(postButton as any);

    expect(sentPayloads).toHaveLength(1);
    const sentPayload = sentPayloads[0] as any;
    expect(sentPayload.allowedMentions).toEqual({ parse: [] });
    expect(sentPayload.embeds?.map((embed: any) => embed.toJSON?.() ?? embed)).toEqual(
      initialReply.embeds.map((embed: any) => embed.toJSON?.() ?? embed),
    );
    expect(postButton.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Posted to channel.",
    });
  }, 30000);
});
