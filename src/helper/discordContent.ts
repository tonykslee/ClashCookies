export const DISCORD_CONTENT_LIMIT = 2000;

export function truncateDiscordContent(
  content: string,
  limit = DISCORD_CONTENT_LIMIT
): string {
  if (content.length <= limit) return content;
  const suffix = "\n...truncated";
  if (suffix.length >= limit) return content.slice(0, limit);
  return `${content.slice(0, limit - suffix.length)}${suffix}`;
}
