import { DISCORD_CONTENT_LIMIT, truncateDiscordContent } from "./discordContent";

type SplitDiscordLineMessagesInput = {
  lines: string[];
  limit?: number;
  maxMessages?: number;
};

/** Purpose: split line-oriented content into Discord-safe messages without breaking rendered lines across messages. */
export function splitDiscordLineMessages(
  input: SplitDiscordLineMessagesInput,
): string[] {
  const limit = Math.max(1, Math.trunc(Number(input.limit) || DISCORD_CONTENT_LIMIT));
  const maxMessages = Math.max(1, Math.trunc(Number(input.maxMessages) || 3));
  const messages: string[] = [];
  let currentLines: string[] = [];

  const flushCurrent = () => {
    if (currentLines.length <= 0 || messages.length >= maxMessages) return;
    messages.push(currentLines.join("\n"));
    currentLines = [];
  };

  for (const rawLine of input.lines) {
    if (messages.length >= maxMessages) break;

    const line =
      rawLine.length <= limit ? rawLine : truncateDiscordContent(rawLine, limit);
    const candidate =
      currentLines.length > 0 ? [...currentLines, line].join("\n") : line;

    if (candidate.length <= limit) {
      currentLines.push(line);
      continue;
    }

    flushCurrent();
    if (messages.length >= maxMessages) break;
    currentLines = [line];
  }

  flushCurrent();
  return messages;
}
