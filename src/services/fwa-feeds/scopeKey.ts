import type { FwaFeedScopeType } from "@prisma/client";
import { normalizeFwaTag } from "./normalize";

export const FWA_FEED_SCOPE_KEY_GLOBAL = "__global__";
export const FWA_FEED_SCOPE_KEY_TRACKED_CLANS = "__tracked_clans__";

type ScopeKeyInput = {
  scopeType: FwaFeedScopeType;
  scopeKey: string | null;
};

/** Purpose: resolve a deterministic non-null scope identity key for feed-sync state rows. */
export function resolveFwaFeedScopeKey(input: ScopeKeyInput): string {
  if (input.scopeType === "GLOBAL") {
    return FWA_FEED_SCOPE_KEY_GLOBAL;
  }
  if (input.scopeType === "TRACKED_CLANS") {
    return FWA_FEED_SCOPE_KEY_TRACKED_CLANS;
  }

  const normalized = normalizeFwaTag(input.scopeKey);
  if (!normalized) {
    throw new Error("scopeKey is required when scopeType is CLAN_TAG");
  }
  return normalized;
}

