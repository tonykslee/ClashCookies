const COMPLIANCE_WARPLAN_FALLBACK = "No warplan details";

/** Purpose: normalize markdown heading prefixes from war-plan text for embed rendering only. */
export function sanitizeWarPlanForEmbed(planText: string | null | undefined): string | null {
  if (!planText) return null;
  const normalized = planText.split(/\r?\n/).map((line) => {
    const headingMatch = line.match(/^(\s*)#{1,6}(?:\s+|$)(.*)$/);
    if (!headingMatch) return line;
    const leading = headingMatch[1] ?? "";
    const remainder = headingMatch[2] ?? "";
    return `${leading}${remainder}`;
  });
  if (!normalized.some((line) => line.trim().length > 0)) return null;
  return normalized.join("\n");
}

/** Purpose: format sanitized war-plan text for compliance by omitting the first line with stable fallback. */
export function buildComplianceWarPlanText(planText: string | null | undefined): string {
  const sanitized = sanitizeWarPlanForEmbed(planText);
  if (!sanitized) return COMPLIANCE_WARPLAN_FALLBACK;

  const remaining = sanitized
    .split(/\r?\n/)
    .slice(1)
    .join("\n")
    .trim();

  return remaining || COMPLIANCE_WARPLAN_FALLBACK;
}

export const COMPLIANCE_WARPLAN_FALLBACK_TEXT = COMPLIANCE_WARPLAN_FALLBACK;
