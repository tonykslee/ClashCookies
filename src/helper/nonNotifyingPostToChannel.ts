import type { APIEmbed, EmbedBuilder } from "discord.js";

type PostToChannelEmbed = APIEmbed | EmbedBuilder;

type NonNotifyingPostToChannelPayload = {
  content?: string;
  embeds?: PostToChannelEmbed[];
  allowedMentions: { parse: []; repliedUser: false };
};

/** Build a post-to-channel payload that preserves visible mentions without notifying anyone. */
export function buildNonNotifyingPostToChannelPayload(input: {
  content?: string;
  embeds?: PostToChannelEmbed[];
}): NonNotifyingPostToChannelPayload {
  const payload: NonNotifyingPostToChannelPayload = {
    allowedMentions: { parse: [], repliedUser: false },
  };

  if (input.content !== undefined) {
    payload.content = input.content;
  }

  if (input.embeds !== undefined) {
    payload.embeds = input.embeds;
  }

  return payload;
}
