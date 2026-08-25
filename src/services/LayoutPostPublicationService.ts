import type { LayoutRecord } from "@prisma/client";
import { buildLayoutPostPayload } from "./LayoutPostService";
import {
  LayoutDiscordPostAlreadyBoundError,
  LayoutService,
  layoutService,
} from "./LayoutService";

type PublishedLayoutMessage = {
  id: string;
  delete: () => Promise<unknown>;
};

export type LayoutPostChannel = {
  id: string;
  send: (payload: ReturnType<typeof buildLayoutPostPayload>) => Promise<PublishedLayoutMessage>;
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
};

/** Purpose: publish one canonical layout post and resolve concurrent publication races without duplicate public posts. */
export class LayoutPostPublicationService {
  private readonly layoutService: Pick<LayoutService, "attachDiscordPost" | "findById">;

  constructor(options: LayoutPostPublicationServiceOptions = {}) {
    this.layoutService = options.layoutService ?? layoutService;
  }

  async publish(input: {
    layout: LayoutRecord;
    guildId: string;
    channel: LayoutPostChannel;
  }): Promise<LayoutPostPublicationResult> {
    const existing = getCompleteProvenance(input.layout);
    if (existing) {
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

/** Purpose: build a stable Discord jump link without exposing the Clash layout URL. */
export function buildDiscordJumpUrl(
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export const layoutPostPublicationService = new LayoutPostPublicationService();
