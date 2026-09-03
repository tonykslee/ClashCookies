import { truncateDiscordContent } from "../../helper/discordContent";
export { compareTagsForTiebreak, getSyncMode } from "../../helper/fwaProjection";

const DISCORD_CONTENT_MAX = 2000;
type ExpectedOutcome = "WIN" | "LOSE" | "UNKNOWN" | null | undefined;

/** Purpose: format numeric points using Discord-friendly U.S. grouping. */
export function formatPoints(value: number): string {
  return Intl.NumberFormat("en-US").format(value);
}

/** Purpose: mark the expected winner line in points blocks for quick visual scanning. */
export function getWinnerMarkerForSide(
  expectedOutcome: ExpectedOutcome,
  side: "clan" | "opponent"
): string {
  if (expectedOutcome === "WIN" && side === "clan") return " :trophy:";
  if (expectedOutcome === "LOSE" && side === "opponent") return " :trophy:";
  return "";
}

/** Purpose: enforce Discord message limit with shared truncation behavior. */
export function limitDiscordContent(content: string): string {
  return truncateDiscordContent(content, DISCORD_CONTENT_MAX);
}

/** Purpose: build a bounded message with graceful truncation and omitted-count summary. */
export function buildLimitedMessage(header: string, lines: string[], summary: string): string {
  let message = `${header}\n\n`;
  let included = 0;

  for (const line of lines) {
    const candidate = `${message}${line}\n`;
    if ((candidate + summary).length > DISCORD_CONTENT_MAX) break;
    message = candidate;
    included += 1;
  }

  if (included < lines.length) {
    const omittedNote = `\n...and ${lines.length - included} more clan(s).`;
    if ((message + omittedNote + summary).length <= DISCORD_CONTENT_MAX) {
      message += omittedNote;
    }
  }

  // If the first line alone is too long, still show a shortened version.
  if (included === 0 && lines.length > 0) {
    const firstLineBudget = Math.max(0, DISCORD_CONTENT_MAX - message.length - summary.length - 40);
    const shortened = firstLineBudget > 0 ? `${lines[0].slice(0, firstLineBudget)}...` : "";
    if (shortened) {
      message += `${shortened}\n`;
      if (lines.length > 1) {
        const omittedNote = `...and ${lines.length - 1} more clan(s).`;
        if ((message + omittedNote + summary).length <= DISCORD_CONTENT_MAX) {
          message += omittedNote;
        }
      }
    }
  }

  if ((message + summary).length > DISCORD_CONTENT_MAX) {
    const allowed = Math.max(0, DISCORD_CONTENT_MAX - message.length);
    return `${message}${summary.slice(0, allowed)}`;
  }

  return `${message}${summary}`;
}
