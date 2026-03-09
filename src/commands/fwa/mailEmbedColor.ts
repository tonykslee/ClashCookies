export type WarMailMatchType = "FWA" | "BL" | "MM" | "SKIP" | "UNKNOWN" | null | undefined;
export type WarMailExpectedOutcome = "WIN" | "LOSE" | "UNKNOWN" | null | undefined;

export const WAR_MAIL_COLOR_BL = 0x000000;
export const WAR_MAIL_COLOR_MM = 0xffffff;
export const WAR_MAIL_COLOR_FWA_WIN = 0x2ecc71;
export const WAR_MAIL_COLOR_FWA_LOSE = 0xe74c3c;
export const WAR_MAIL_COLOR_FALLBACK = 0x95a5a6;

/** Purpose: resolve deterministic sidebar color for war-mail embeds by effective match state. */
export function resolveWarMailEmbedColor(input: {
  matchType: WarMailMatchType;
  expectedOutcome: WarMailExpectedOutcome;
}): number {
  if (input.matchType === "BL") return WAR_MAIL_COLOR_BL;
  if (input.matchType === "MM") return WAR_MAIL_COLOR_MM;
  if (input.matchType === "FWA" && input.expectedOutcome === "WIN") return WAR_MAIL_COLOR_FWA_WIN;
  if (input.matchType === "FWA" && input.expectedOutcome === "LOSE") return WAR_MAIL_COLOR_FWA_LOSE;
  return WAR_MAIL_COLOR_FALLBACK;
}
