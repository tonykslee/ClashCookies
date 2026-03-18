import { Client, Guild } from 'discord.js';

export function formatEmojiByName(
  client: Client,
  emojiName: string,
  options?: {
    guild?: Guild | null;
    fallback?: string;
  },
): string {
  const fallback = options?.fallback ?? '⚠️';

  const guildEmoji = options?.guild?.emojis.cache.find((e) => e.name === emojiName);
  if (guildEmoji) {
    return `<${guildEmoji.animated ? 'a' : ''}:${guildEmoji.name}:${guildEmoji.id}>`;
  }

  const clientEmoji = client.emojis.cache.find((e) => e.name === emojiName);
  if (clientEmoji) {
    return `<${clientEmoji.animated ? 'a' : ''}:${clientEmoji.name}:${clientEmoji.id}>`;
  }

  return fallback;
}