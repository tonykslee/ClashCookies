/** Purpose: map sync lifecycle metadata into actionable end-user state messaging. */
export function buildActionableSyncStateLine(input: {
  syncRow: { needsValidation: boolean } | null;
  siteCurrent: boolean;
  differenceCount: number;
}): string {
  const requiresValidation =
    input.syncRow === null ||
    input.syncRow.needsValidation ||
    (input.siteCurrent && input.differenceCount > 0);
  return requiresValidation ? "State: Needs validation" : "";
}
