import type { LayoutRecord } from "@prisma/client";
import {
  buildLayoutPostPayload,
  LayoutPostImageSource,
} from "./LayoutPostService";
import {
  LayoutDiscordPostAlreadyBoundError,
  LayoutService,
  layoutService,
} from "./LayoutService";

type PublishedLayoutMessage = {
  id: string;
  delete: () => Promise<unknown>;
};

export type ResolvedLayoutPostMessage = PublishedLayoutMessage & {
  edit: (payload: ReturnType<typeof buildLayoutPostPayload>) => Promise<unknown>;
  attachments?: {
    first?: () => { name?: string | null; url?: string | null } | undefined;
  };
};

export type LayoutPostChannel = {
  id: string;
  send: (payload: ReturnType<typeof buildLayoutPostPayload>) => Promise<PublishedLayoutMessage>;
};

export type LayoutPostMessageResolver = {
  resolve: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
  }) => Promise<ResolvedLayoutPostMessage | null>;
};

export type LayoutPostPublicationResult = {
  layout: LayoutRecord;
  messageId: string;
  jumpUrl: string;
};

export type LayoutPostPublicationServiceOptions = {
  layoutService?: Pick<
    LayoutService,
    "attachDiscordPost" | "findById"
  >;
  messageResolver?: LayoutPostMessageResolver;
};

/** Purpose: publish one canonical layout post and resolve concurrent publication races without duplicate public posts. */
export class LayoutPostPublicationService {
  private readonly layoutService: Pick<LayoutService, "attachDiscordPost" | "findById">;
  private readonly messageResolver?: LayoutPostMessageResolver;

  constructor(options: LayoutPostPublicationServiceOptions = {}) {
    this.layoutService = options.layoutService ?? layoutService;
    this.messageResolver = options.messageResolver;
  }

  async publish(input: {
    layout: LayoutRecord;
    guildId: string;
    channel: LayoutPostChannel;
    messageResolver?: LayoutPostMessageResolver;
  }): Promise<LayoutPostPublicationResult> {
    const existing = getCompleteProvenance(input.layout);
    if (existing) {
      const resolver = input.messageResolver ?? this.messageResolver;
      if (!resolver) {
        throw new Error("A canonical Discord post resolver is required to refresh the existing post.");
      }
      const existingMessage = await resolver.resolve({
        guildId: existing.guildId,
        channelId: existing.channelId,
        messageId: existing.messageId,
      });
      if (!existingMessage) {
        throw new Error("The canonical Discord layout post could not be resolved; no replacement was created.");
      }
      await existingMessage.edit(
        buildLayoutPostPayload(
          input.layout,
          "collapsed",
          getMessageImageSource(existingMessage),
        ),
      );
      return {
        layout: input.layout,
        messageId: existing.messageId,
        jumpUrl: buildDiscordJumpUrl(
          existing.guildId,
          existing.channelId,
          existing.messageId,
        ),
      };
    }

    const message = await input.channel.send(buildLayoutPostPayload(input.layout));
    try {
      const attached = await this.layoutService.attachDiscordPost({
        id: input.layout.id,
        guildId: input.guildId,
        channelId: input.channel.id,
        messageId: message.id,
        imageUrl: input.layout.imageUrl,
      });
      return {
        layout: attached,
        messageId: message.id,
        jumpUrl: buildDiscordJumpUrl(input.guildId, input.channel.id, message.id),
      };
    } catch (error) {
      if (error instanceof LayoutDiscordPostAlreadyBoundError) {
        await deleteBestEffort(message);
        const winner = await this.layoutService.findById(input.layout.id);
        const winnerProvenance = winner ? getCompleteProvenance(winner) : null;
        if (winner && winnerProvenance) {
          return {
            layout: winner,
            messageId: winnerProvenance.messageId,
            jumpUrl: buildDiscordJumpUrl(
              winnerProvenance.guildId,
              winnerProvenance.channelId,
              winnerProvenance.messageId,
            ),
          };
        }
        throw error;
      }
      await deleteBestEffort(message);
      throw error;
    }
  }
}

/** Purpose: keep Discord fetch/edit mechanics inside the focused layout publication integration. */
export function createDiscordLayoutPostResolver(client: {
  channels: {
    fetch: (channelId: string) => Promise<unknown>;
  };
}): LayoutPostMessageResolver {
  return {
    resolve: async ({ channelId, messageId }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || typeof channel !== "object" || !("messages" in channel)) {
        return null;
      }
      const messages = (channel as { messages?: unknown }).messages;
      if (
        !messages ||
        typeof messages !== "object" ||
        !("fetch" in messages) ||
        typeof (messages as { fetch?: unknown }).fetch !== "function"
      ) {
        return null;
      }
      const message = await (
        messages as { fetch: (id: string) => Promise<unknown> }
      ).fetch(messageId).catch(() => null);
      if (
        !message ||
        typeof message !== "object" ||
        typeof (message as { edit?: unknown }).edit !== "function"
      ) {
        return null;
      }
      return message as ResolvedLayoutPostMessage;
    },
  };
}

function getCompleteProvenance(layout: LayoutRecord): {
  guildId: string;
  channelId: string;
  messageId: string;
} | null {
  if (!layout.discordGuildId || !layout.discordChannelId || !layout.discordMessageId) {
    return null;
  }
  return {
    guildId: layout.discordGuildId,
    channelId: layout.discordChannelId,
    messageId: layout.discordMessageId,
  };
}

async function deleteBestEffort(message: PublishedLayoutMessage): Promise<void> {
  try {
    await message.delete();
  } catch {
    // A failed cleanup must not hide the canonical binding result.
  }
}

function getMessageImageSource(message: ResolvedLayoutPostMessage): LayoutPostImageSource {
  const attachment = message.attachments?.first?.();
  return {
    attachmentName: attachment?.name ?? null,
    attachmentUrl: attachment?.url ?? null,
  };
}

/** Purpose: build a stable Discord jump link without exposing the Clash layout URL. */
export function buildDiscordJumpUrl(
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export const layoutPostPublicationService = new LayoutPostPublicationService();
