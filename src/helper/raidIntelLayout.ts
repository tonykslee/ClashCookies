import { createHash } from "node:crypto";
import { normalizeRaidTrackedClanTag } from "../services/RaidTrackedClanService";

export type RaidIntelLayoutGrade = "DEFAULT" | "CUSTOM_HARD" | "CUSTOM_MEDIUM" | "CUSTOM_EASY";

export type RaidIntelLayoutGradeLabel =
  | "Unmarked"
  | "Default"
  | "Custom - Hard"
  | "Custom - Medium"
  | "Custom - Easy";

const RAID_INTEL_LAYOUT_GRADE_SCORES: Record<RaidIntelLayoutGrade, number> = {
  DEFAULT: 0,
  CUSTOM_HARD: 3,
  CUSTOM_MEDIUM: 2,
  CUSTOM_EASY: 1,
};

function normalizeRaidIntelDistrictName(name: unknown): string | null {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseRaidSeasonTimeMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const compactMatch = raw.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z$/,
  );
  if (compactMatch) {
    const [, year, month, day, hour, minute, second, fraction = "0"] = compactMatch;
    const millis = fraction.padEnd(3, "0").slice(0, 3);
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRaidIntelLayoutGrade(
  value: unknown,
): RaidIntelLayoutGrade | null {
  const raw = String(value ?? "").trim();
  if (
    raw === "DEFAULT" ||
    raw === "CUSTOM_HARD" ||
    raw === "CUSTOM_MEDIUM" ||
    raw === "CUSTOM_EASY"
  ) {
    return raw;
  }
  return null;
}

export function buildRaidIntelLayoutGradeLabel(
  grade: RaidIntelLayoutGrade | null,
): RaidIntelLayoutGradeLabel {
  if (grade === "DEFAULT") return "Default";
  if (grade === "CUSTOM_HARD") return "Custom - Hard";
  if (grade === "CUSTOM_MEDIUM") return "Custom - Medium";
  if (grade === "CUSTOM_EASY") return "Custom - Easy";
  return "Unmarked";
}

export function buildRaidIntelDistrictKey(input: {
  defenderTag: string | null;
  districtName: string | null;
}): string {
  const defenderTag = normalizeRaidTrackedClanTag(input.defenderTag ?? "");
  const districtName = normalizeRaidIntelDistrictName(input.districtName);
  const raw = `${defenderTag ?? ""}|${districtName ?? ""}`;
  const digest = createHash("sha1").update(raw).digest("base64url").slice(0, 10);
  return `d_${digest}`;
}

export function buildRaidIntelLayoutScoreKey(input: {
  sourceClanTag: string;
  raidSeasonStartTime: Date;
}): string {
  const sourceClanTag = normalizeRaidTrackedClanTag(input.sourceClanTag);
  return `${sourceClanTag ?? ""}|${input.raidSeasonStartTime.getTime()}`;
}

export function calculateRaidIntelLayoutGradeScore(value: unknown): number {
  const grade = normalizeRaidIntelLayoutGrade(value);
  return grade ? RAID_INTEL_LAYOUT_GRADE_SCORES[grade] : 0;
}
