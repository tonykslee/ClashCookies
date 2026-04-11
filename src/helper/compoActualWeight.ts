/** Purpose: normalize a possibly-null weight to one positive integer or reject it as unusable. */
export function toPositiveCompoWeight(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

/** Purpose: resolve one ACTUAL compo weight from persisted ACTUAL, deferred, then WAR fallback precedence. */
export function resolveActualCompoWeight(input: {
  memberWeight: number | null | undefined;
  deferredWeight: number | null | undefined;
  sameClanWarWeight: number | null | undefined;
  anyWarWeight: number | null | undefined;
}): number | null {
  return (
    toPositiveCompoWeight(input.memberWeight) ??
    toPositiveCompoWeight(input.deferredWeight) ??
    toPositiveCompoWeight(input.sameClanWarWeight) ??
    toPositiveCompoWeight(input.anyWarWeight) ??
    null
  );
}
