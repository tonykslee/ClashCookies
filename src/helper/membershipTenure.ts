export type MembershipTenureDisplayInput = {
  /** Optional source context retained for compatibility with /link list callers. */
  homeMembershipPeriodId?: string | null;
  clanTenureSyncs: number | null;
  clanTenureIsLowerBound: boolean;
  clanStreakSyncs: number | null;
  clanStreakIsLowerBound: boolean;
  allianceStreakSyncs: number | null;
  allianceStreakIsLowerBound: boolean;
};

/** Purpose: keep the compact C/S/A legend identical across account and link-list views. */
export const MEMBERSHIP_TENURE_LEGEND = "C = Clan Tenure • S = Clan Streak • A = Alliance Streak";

/** Purpose: format authoritative C/S/A values with existing lower-bound and unavailable semantics. */
export function formatMembershipTenureLabel(
  input: MembershipTenureDisplayInput | null | undefined,
): string {
  if (!input) return "—";
  const formatMetric = (value: number | null, lowerBound: boolean): string => {
    if (value === null || !Number.isFinite(value)) return "—";
    return `${Math.max(0, Math.trunc(value))}${lowerBound ? "+" : ""}`;
  };
  const values = [
    formatMetric(input.clanTenureSyncs, input.clanTenureIsLowerBound),
    formatMetric(input.clanStreakSyncs, input.clanStreakIsLowerBound),
    formatMetric(input.allianceStreakSyncs, input.allianceStreakIsLowerBound),
  ];
  return `C${values[0]}/S${values[1]}/A${values[2]}`;
}
