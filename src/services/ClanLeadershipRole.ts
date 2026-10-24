export type ClanLeadershipRole = "leader" | "coLeader";

/** Purpose: normalize persisted Clash clan leadership roles using the existing role semantics. */
export function normalizeClanLeadershipRole(input: unknown): ClanLeadershipRole | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "leader") return "leader";
  if (normalized === "coleader") return "coLeader";
  return null;
}
