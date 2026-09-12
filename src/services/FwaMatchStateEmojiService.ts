export type FwaMatchStateEmoji = "⚫" | "⚪" | "🟢" | "🔴" | "🔘";

type FwaMatchStateEmojiInput = {
  matchType: "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null | undefined;
  outcome: "WIN" | "LOSE" | "UNKNOWN" | null | undefined;
};

/** Purpose: map the displayed FWA match type/outcome state to one stable compact emoji. */
export function resolveFwaMatchStateEmoji(
  input: FwaMatchStateEmojiInput,
): FwaMatchStateEmoji {
  if (input.matchType === "BL") return "⚫";
  if (input.matchType === "MM") return "⚪";
  if (input.matchType === "FWA") {
    if (input.outcome === "WIN") return "🟢";
    if (input.outcome === "LOSE") return "🔴";
  }
  return "🔘";
}
