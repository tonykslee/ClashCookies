export const PLAYER_CURRENT_SIGNUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type PlayerCurrentSignupLike = {
  lastFetchedAt: Date | null | undefined;
} | null | undefined;

/** Purpose: keep signup/current-player freshness checks shared without creating service cycles. */
export function isPlayerCurrentStaleForSignup(
  record: PlayerCurrentSignupLike,
  now: Date,
  maxAcceptedAgeMs = PLAYER_CURRENT_SIGNUP_MAX_AGE_MS,
): boolean {
  if (!record?.lastFetchedAt) {
    return true;
  }
  return now.getTime() - record.lastFetchedAt.getTime() >= maxAcceptedAgeMs;
}
