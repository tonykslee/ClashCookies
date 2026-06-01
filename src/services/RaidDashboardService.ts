import { buildClanProfileMarkdownLink } from "../helper/clanProfileLink";
import {
  buildRaidIntelDistrictKey,
  buildRaidIntelLayoutGradeLabel,
  buildRaidIntelLayoutScoreKey,
  calculateRaidIntelLayoutGradeScore,
  parseRaidSeasonTimeMs,
  type RaidIntelLayoutGrade,
  type RaidIntelLayoutGradeLabel,
} from "../helper/raidIntelLayout";
import { runWithCoCQueueContext } from "./CoCQueueContext";
import { CoCService, type ClanCapitalRaidSeason } from "./CoCService";
import {
  loadRaidIntelLayoutMarksForSeasons,
  type RaidIntelDistrictLayoutMarkRecord,
} from "./RaidIntelLayoutMarkService";
import {
  loadRaidIntelDefenderProfileUpgradesForTags,
} from "./RaidIntelDefenderProfileService";
import {
  estimateRaidMedals,
  type RaidMedalEstimate,
} from "./RaidMedalEstimator";
import {
  getRaidTrackedClanJoinTypeEmoji,
  listRaidTrackedClansForDisplay,
  normalizeRaidTrackedClanTag,
  type RaidTrackedClanDisplayRow,
  type RaidTrackedClanJoinType,
} from "./RaidTrackedClanService";
import {
  listFwaTrackedClansForDisplay,
  type FwaTrackedClanDisplayRow,
} from "./TrackedClanListService";

const DISCORD_DESCRIPTION_LIMIT = 4096;
const RAID_DETAIL_TRUNCATION_RESERVE = 96;
const RAID_INTEL_SUMMARY_GRADE_EMOJI: Record<RaidIntelLayoutGradeLabel, string> = {
  Unmarked: "⚪",
  Default: "⚪",
  "Custom - Hard": "🔴",
  "Custom - Medium": "🟡",
  "Custom - Easy": "🟢",
};
const RAID_INTEL_SUMMARY_GRADE_ORDER: RaidIntelLayoutGradeLabel[] = [
  "Default",
  "Custom - Easy",
  "Custom - Medium",
  "Custom - Hard",
];
const RAID_INTEL_SUMMARY_DISTRICT_ORDER = [
  "GM",
  "SP",
  "GQ",
  "DC",
  "BL",
  "WV",
  "BC",
  "BW",
];
const RAID_INTEL_SUMMARY_DISTRICT_ABBREVIATIONS = new Map<string, string>([
  ["goblin mines", "GM"],
  ["skeleton park", "SP"],
  ["golem quarry", "GQ"],
  ["dragon cliffs", "DC"],
  ["balloon lagoon", "BL"],
  ["wizard valley", "WV"],
  ["barbarian camp", "BC"],
  ["builders workshop", "BW"],
  ["builder's workshop", "BW"],
]);

export {
  buildRaidIntelDistrictKey,
  buildRaidIntelLayoutGradeLabel,
  parseRaidSeasonTimeMs,
  type RaidIntelLayoutGrade,
  type RaidIntelLayoutGradeLabel,
};

export type RaidDashboardCountRow = {
  attacksCompleted: number | null;
  attacksMax: number | null;
  hasOngoingRaid: boolean;
  raidsCompleted: number | null;
};

export type RaidDashboardClanRow = RaidTrackedClanDisplayRow & RaidDashboardCountRow & {
  defaultLayoutCount: number | null;
  raidIntelDefenderUpgrades: number | null;
  maxDefenseAttacksUsed: number | null;
  offensiveDistrictsDestroyed: number | null;
  offensiveAverageAttacksPerCompletedRaid: number | null;
  raidMedalEstimate?: RaidMedalEstimate | null;
  intelGradeScore: number;
  raidIntelMarks?: RaidIntelDistrictLayoutMarkRecord[];
  openDefenseSections?: RaidDashboardDefenseSection[];
};

export type RaidDashboardOverviewSourceMode = "raids" | "fwa" | "custom";

type RaidDashboardSourceClanRow = {
  clanTag: string;
  clanName: string | null;
  upgrades: number | null;
  joinType: RaidTrackedClanJoinType | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RaidClanJoinRequirements = {
  requiredTownHall: number | null;
  requiredTrophies: number | null;
  requiredBuilderBaseTrophies: number | null;
};

export type RaidAttackerClanMetadata = {
  joinType: RaidTrackedClanJoinType | null;
  joinRequirements: RaidClanJoinRequirements | null;
};

export type RaidDashboardDistrictRow = {
  name: string;
  districtHallLevel: number | null;
  attackCount: number | null;
  destructionPercent: number | null;
  stars: number | null;
};

export type RaidDashboardAttackSection = {
  defenderName: string | null;
  defenderTag: string | null;
  districts: RaidDashboardDistrictRow[];
};

export type RaidDashboardDefenseSection = {
  attackerName: string | null;
  attackerTag: string | null;
  joinType: RaidTrackedClanJoinType | null;
  joinRequirements: RaidClanJoinRequirements | null;
  attacksUsed: number | null;
  districtsRemaining: number | null;
};

export type RaidDashboardSeasonDetail = {
  activeSeason: ClanCapitalRaidSeason | null;
  attackSections: RaidDashboardAttackSection[];
  defenseSections: RaidDashboardDefenseSection[];
  raidsCompleted: number | null;
};

export type RaidIntelDistrict = {
  key: string;
  defenderName: string | null;
  defenderTag: string | null;
  name: string;
  districtHallLevel: number | null;
  grade: RaidIntelLayoutGradeLabel;
};

export type RaidIntelDefender = {
  defenderName: string | null;
  defenderTag: string | null;
  upgrades?: number | null;
  districts: RaidIntelDistrict[];
};

export type RaidIntelSeasonDetail = {
  activeSeason: ClanCapitalRaidSeason | null;
  defenders: RaidIntelDefender[];
};

export type RaidIntelDistrictOption = {
  key: string;
  label: string;
  description: string | null;
  value: string;
};

type RaidDetailLine = {
  text: string;
  item: boolean;
};

function clampInt(value: unknown, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return min;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function normalizeNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const next = Math.trunc(raw);
  return next >= 0 ? next : null;
}

function normalizePositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const next = Math.trunc(raw);
  return next > 0 ? next : null;
}

function formatRelativeTimestamp(value: Date | null): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return "unknown";
  }
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

function formatRaidTrackedClanTag(tag: string): string {
  const normalized = normalizeRaidTrackedClanTag(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function formatJoinTypeLabel(joinType: RaidTrackedClanJoinType | null): string {
  if (joinType === "open") return "Open";
  if (joinType === "inviteOnly") return "Invite only";
  if (joinType === "closed") return "Closed";
  return "Unknown";
}

function formatCompletedAttacksLabel(attacksCompleted: number | null): string {
  return attacksCompleted === null ? "—" : String(attacksCompleted);
}

function normalizeRaidIntelSummaryDistrictName(name: unknown): string | null {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/['’]/g, "");
}

function buildRaidIntelDistrictAbbreviation(name: string | null | undefined): string | null {
  const normalized = normalizeRaidIntelSummaryDistrictName(name);
  if (!normalized) return null;
  return RAID_INTEL_SUMMARY_DISTRICT_ABBREVIATIONS.get(normalized) ?? null;
}

function sortRaidIntelDistrictAbbreviations(abbreviations: string[]): string[] {
  const order = new Map(RAID_INTEL_SUMMARY_DISTRICT_ORDER.map((value, index) => [value, index] as const));
  return [...new Set(abbreviations)].sort((left, right) => {
    const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.localeCompare(right);
  });
}

function buildRaidIntelSummaryGroups(
  marks: RaidIntelDistrictLayoutMarkRecord[],
): Map<RaidIntelLayoutGradeLabel, string[]> {
  const groups = new Map<RaidIntelLayoutGradeLabel, string[]>();
  for (const mark of marks) {
    const abbreviation = buildRaidIntelDistrictAbbreviation(mark.districtName);
    if (!abbreviation) continue;
    const grade = buildRaidIntelLayoutGradeLabel(mark.layoutGrade);
    const bucket = groups.get(grade) ?? [];
    bucket.push(abbreviation);
    groups.set(grade, bucket);
  }
  for (const [grade, abbreviations] of groups) {
    groups.set(grade, sortRaidIntelDistrictAbbreviations(abbreviations));
  }
  return groups;
}

function normalizeDistrictName(name: unknown): string | null {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

type RaidAttackLogEntryState = {
  started: boolean;
  complete: boolean | null;
  usable: boolean;
};

function normalizeRaidAttackLogEntryState(entry: unknown): RaidAttackLogEntryState {
  if (!entry || typeof entry !== "object") {
    return {
      started: false,
      complete: null,
      usable: false,
    };
  }

  const value = entry as Record<string, unknown>;
  const explicitStarted = readBoolean(value.started);
  const explicitComplete = readBoolean(value.complete);
  const aggregateAttackCount = normalizeNonNegativeInt(value.attackCount ?? value.attacks);
  const districtCount = normalizePositiveInt(value.districtCount);
  const districtsDestroyed = normalizeNonNegativeInt(value.districtsDestroyed);
  const districts = Array.isArray(value.districts)
    ? value.districts
        .map((district) => normalizeRaidDistrictRow(district))
        .filter((district): district is RaidDashboardDistrictRow => district !== null)
    : [];

  const started =
    explicitStarted ??
    (aggregateAttackCount !== null
      ? aggregateAttackCount > 0
      : districts.some((district) => (district.attackCount ?? 0) > 0));

  let complete = explicitComplete;
  if (complete === null) {
    if (districtCount !== null && districtsDestroyed !== null) {
      complete = districtCount > 0 && districtsDestroyed >= districtCount;
    } else if (districts.length > 0) {
      complete = districts.every((district) => isDistrictFullyDestroyed(district) === true);
    }
  }

  return {
    started,
    complete,
    usable:
      explicitComplete !== null ||
      districtCount !== null ||
      districtsDestroyed !== null ||
      districts.length > 0,
  };
}

function isRaidAttackLogEntryStarted(entry: unknown): boolean {
  return normalizeRaidAttackLogEntryState(entry).started;
}

function isRaidAttackLogEntryComplete(entry: unknown): boolean | null {
  return normalizeRaidAttackLogEntryState(entry).complete;
}

function calculateHasOngoingRaidFromAttackLog(
  attackLog: ClanCapitalRaidSeason["attackLog"],
): boolean {
  if (!Array.isArray(attackLog) || attackLog.length <= 0) {
    return false;
  }

  for (const entry of attackLog) {
    if (!isRaidAttackLogEntryStarted(entry)) {
      continue;
    }
    if (isRaidAttackLogEntryComplete(entry) === false) {
      return true;
    }
  }

  return false;
}

const RAID_DISTRICT_MAX_HALL_LEVELS = new Map<string, number>([
  ["capital hall", 10],
  ["capital peak", 10],
  ["barbarian camp", 5],
  ["wizard valley", 5],
  ["balloon lagoon", 5],
  ["builder's workshop", 5],
  ["builders workshop", 5],
  ["dragon cliffs", 5],
  ["golem quarry", 5],
  ["skeleton park", 4],
  ["goblin mines", 4],
]);

function normalizeRaidDistrictName(name: string): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function formatRaidDistrictHallLabel(
  districtName: string,
  hallLevel: number | null,
): string | null {
  if (hallLevel === null) return null;
  const maxHallLevel = RAID_DISTRICT_MAX_HALL_LEVELS.get(normalizeRaidDistrictName(districtName));
  if (maxHallLevel !== undefined && hallLevel >= maxHallLevel) {
    return "MAX";
  }
  return `DH${hallLevel}`;
}

function selectCurrentRaidSeason(input: {
  seasons: ClanCapitalRaidSeason[];
  nowMs: number;
}): ClanCapitalRaidSeason | null {
  if (!Array.isArray(input.seasons) || input.seasons.length <= 0) {
    return null;
  }

  const candidates = input.seasons.map((season) => {
    const startMs = parseRaidSeasonTimeMs(season.startTime);
    const endMs = parseRaidSeasonTimeMs(season.endTime);
    return {
      season,
      startMs,
      endMs,
    };
  });

  const active = candidates.find((candidate) => {
    if (candidate.startMs === null || candidate.endMs === null) return false;
    return input.nowMs >= candidate.startMs && input.nowMs < candidate.endMs;
  });
  return active?.season ?? null;
}

function normalizeRaidJoinType(
  joinType: unknown,
): RaidTrackedClanJoinType | null {
  const raw = String(joinType ?? "").trim();
  if (raw === "open" || raw === "anyoneCanJoin") {
    return "open";
  }
  if (raw === "inviteOnly" || raw === "closed") {
    return raw;
  }
  return null;
}

export function normalizeRaidClanJoinRequirements(input: Record<string, unknown>): RaidClanJoinRequirements {
  const requiredTownHall = normalizePositiveInt(
    input.requiredTownhallLevel ?? input.requiredTownHallLevel ?? input.requiredTownHall,
  );
  const requiredBuilderBaseTrophies = normalizePositiveInt(
    input.requiredBuilderBaseTrophies ??
      input.requiredBuilderBaseTrophy ??
      input.requiredBuilderBase ??
      input.requiredVersusTrophies,
  );
  const requiredTrophies = normalizePositiveInt(
    input.requiredTrophies ?? input.requiredHomeTrophies,
  );
  return {
    requiredTownHall,
    requiredTrophies,
    requiredBuilderBaseTrophies,
  };
}

function normalizeRaidAttackerClanMetadata(input: unknown): RaidAttackerClanMetadata | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const joinType = normalizeRaidJoinType(value.type);
  if (joinType === null) return null;
  const joinRequirements = normalizeRaidClanJoinRequirements(value);
  return {
    joinType,
    joinRequirements,
  };
}

function normalizeRaidDistrictRow(raw: unknown): RaidDashboardDistrictRow | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const name = normalizeDistrictName(value.name) ?? "Unknown District";
  return {
    name,
    districtHallLevel:
      normalizePositiveInt(value.districtHallLevel ?? value.districtHall ?? value.hallLevel),
    attackCount: normalizeNonNegativeInt(value.attackCount ?? value.attacks),
    destructionPercent: normalizeNonNegativeInt(
      value.destructionPercentage ?? value.destructionPercent,
    ),
    stars: normalizeNonNegativeInt(value.stars),
  };
}

function isDistrictFullyDestroyed(row: RaidDashboardDistrictRow): boolean | null {
  if (row.stars !== null) {
    return row.stars >= 3;
  }
  if (row.destructionPercent !== null) {
    return row.destructionPercent >= 100;
  }
  return null;
}

function calculateCompletedRaidsFromAttackLog(
  attackLog: ClanCapitalRaidSeason["attackLog"],
): number | null {
  if (!Array.isArray(attackLog) || attackLog.length <= 0) {
    return null;
  }

  let completed = 0;
  let sawUsableLog = false;
  for (const entry of attackLog) {
    const state = normalizeRaidAttackLogEntryState(entry);
    if (!state.usable) continue;
    sawUsableLog = true;
    if (state.complete === true) {
      completed += 1;
    }
  }

  return sawUsableLog ? completed : null;
}

function calculateAttackCountFromRaidLogEntry(
  entry: Record<string, unknown>,
  districts: RaidDashboardDistrictRow[],
): number | null {
  const aggregateAttackCount = normalizeNonNegativeInt(
    entry.attackCount ?? entry.attacks ?? entry.attacksUsed,
  );
  if (aggregateAttackCount !== null) {
    return aggregateAttackCount;
  }

  const districtAttackCounts = districts
    .map((district) => district.attackCount)
    .filter((attackCount): attackCount is number => attackCount !== null);
  if (districtAttackCounts.length > 0) {
    return districtAttackCounts.reduce((sum, attackCount) => sum + attackCount, 0);
  }

  return null;
}

function calculateCurrentOffensiveDistrictsDestroyed(
  attackLog: ClanCapitalRaidSeason["attackLog"],
): number | null {
  if (!Array.isArray(attackLog) || attackLog.length <= 0) {
    return null;
  }

  let sawCompletedRaid = false;
  for (const entry of attackLog) {
    const state = normalizeRaidAttackLogEntryState(entry);
    if (!state.started) continue;
    if (state.complete === false) {
      const value = entry as Record<string, unknown>;
      const districts = Array.isArray(value.districts)
        ? value.districts
            .map((district: unknown) => normalizeRaidDistrictRow(district))
            .filter((district: RaidDashboardDistrictRow | null): district is RaidDashboardDistrictRow => district !== null)
        : [];
      return districts.reduce(
        (sum: number, district: RaidDashboardDistrictRow) =>
          sum + (isDistrictFullyDestroyed(district) === true ? 1 : 0),
        0,
      );
    }
    if (state.complete === true) {
      sawCompletedRaid = true;
    }
  }

  return sawCompletedRaid ? 9 : null;
}

function calculateAverageAttacksPerCompletedRaid(
  attackLog: ClanCapitalRaidSeason["attackLog"],
): number | null {
  if (!Array.isArray(attackLog) || attackLog.length <= 0) {
    return null;
  }

  let completedCount = 0;
  let totalAttacks = 0;
  let sawUsableRaid = false;
  for (const entry of attackLog) {
    const state = normalizeRaidAttackLogEntryState(entry);
    if (!state.usable || state.complete !== true) continue;
    sawUsableRaid = true;
    const value = entry as Record<string, unknown>;
    const districts = Array.isArray(value.districts)
      ? value.districts
          .map((district: unknown) => normalizeRaidDistrictRow(district))
          .filter((district: RaidDashboardDistrictRow | null): district is RaidDashboardDistrictRow => district !== null)
      : [];
    const attackCount = calculateAttackCountFromRaidLogEntry(value, districts);
    if (attackCount === null) continue;
    completedCount += 1;
    totalAttacks += attackCount;
  }

  return sawUsableRaid && completedCount > 0 ? totalAttacks / completedCount : null;
}

function isRaidCapitalPeakDistrict(name: string): boolean {
  const normalized = normalizeRaidDistrictName(name).replace(/['’]/g, "");
  return normalized === "capital peak" || normalized === "capital hall";
}

function buildRaidDashboardMedalEstimate(input: {
  attackSections: RaidDashboardAttackSection[];
  attacksCompleted: number | null;
  defensiveMedals: number | null;
}): RaidMedalEstimate | null {
  if ((input.attacksCompleted ?? 0) <= 0) {
    return null;
  }

  const destroyedDistrictHallLevels: number[] = [];
  const destroyedCapitalHallLevels: number[] = [];
  for (const section of input.attackSections) {
    for (const district of section.districts) {
      if (district.districtHallLevel === null || isDistrictFullyDestroyed(district) !== true) {
        continue;
      }
      if (isRaidCapitalPeakDistrict(district.name)) {
        destroyedCapitalHallLevels.push(district.districtHallLevel);
      } else {
        destroyedDistrictHallLevels.push(district.districtHallLevel);
      }
    }
  }

  return estimateRaidMedals({
    destroyedDistrictHallLevels,
    destroyedCapitalHallLevels,
    totalClanOffensiveAttacksUsed: input.attacksCompleted ?? 0,
    defensiveMedals: input.defensiveMedals,
  });
}

function formatRaidDashboardAverageAttacksPerCompletedRaid(value: number | null): string {
  if (value === null) {
    return "—";
  }

  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function buildRaidDashboardOverviewOffenseLine(row: RaidDashboardClanRow): string {
  const hasOffensiveProgress =
    (row.attacksCompleted ?? 0) > 0 ||
    row.offensiveDistrictsDestroyed !== null ||
    row.offensiveAverageAttacksPerCompletedRaid !== null;
  if (!hasOffensiveProgress) return "";
  const totalAttacks = row.attacksCompleted === null ? "—" : String(row.attacksCompleted);
  const destroyedDistricts =
    row.offensiveDistrictsDestroyed === null ? "—" : String(row.offensiveDistrictsDestroyed);
  const averageAttacks = formatRaidDashboardAverageAttacksPerCompletedRaid(
    row.offensiveAverageAttacksPerCompletedRaid,
  );
  return `- 🗡 ${totalAttacks} 🏠 ${destroyedDistricts}/9 📈 ${averageAttacks} att/raid`;
}

function buildRaidDashboardOverviewMedalLine(row: RaidDashboardClanRow): string {
  if ((row.attacksCompleted ?? 0) <= 0) {
    return "";
  }

  const estimate = row.raidMedalEstimate ?? null;
  if (
    estimate?.offensiveMedalsForSixAttacks === null ||
    estimate?.offensiveMedalsForSixAttacks === undefined
  ) {
    return "";
  }

  const defensiveText = estimate.defensiveMedals === null ? "—" : String(estimate.defensiveMedals);
  const totalText =
    estimate.totalEstimatedMedals === null
      ? ""
      : ` | Total ~${estimate.totalEstimatedMedals}`;
  return `- 🏅 Offense ~${estimate.offensiveMedalsForSixAttacks} | Defense ${defensiveText}${totalText}`;
}

function buildRaidDistrictLabel(row: RaidDashboardDistrictRow): string {
  const hallLabel = formatRaidDistrictHallLabel(row.name, row.districtHallLevel);
  const hallSuffix = hallLabel === null ? "" : ` ${hallLabel}`;
  const attackCount = row.attackCount === null ? "— attacks" : `${row.attackCount} attacks`;
  return `${row.name}${hallSuffix} — ${attackCount}`;
}

function buildRaidDetailDescription(input: {
  lines: RaidDetailLine[];
}): string {
  const reserve = RAID_DETAIL_TRUNCATION_RESERVE + "…and more districts/clans not shown.".length;
  const rendered: string[] = [];
  let renderedLength = 0;
  let remainingItems = input.lines.reduce((sum, line) => sum + (line.item ? 1 : 0), 0);

  for (const line of input.lines) {
    const lineLength = line.text.length + (rendered.length > 0 ? 1 : 0);
    if (renderedLength + lineLength + reserve > DISCORD_DESCRIPTION_LIMIT) {
      break;
    }
    rendered.push(line.text);
    renderedLength += lineLength;
    if (line.item) {
      remainingItems -= 1;
    }
  }

  if (remainingItems > 0) {
    const trailer = `…and ${remainingItems} more districts/clans not shown.`;
    if (rendered.length === 0) return trailer.slice(0, DISCORD_DESCRIPTION_LIMIT);
    if (renderedLength + 1 + trailer.length <= DISCORD_DESCRIPTION_LIMIT) {
      return `${rendered.join("\n")}\n${trailer}`;
    }
    const allowedBodyLength = Math.max(0, DISCORD_DESCRIPTION_LIMIT - trailer.length - 1);
    const body = rendered.join("\n").slice(0, allowedBodyLength).trimEnd();
    return body ? `${body}\n${trailer}` : trailer.slice(0, DISCORD_DESCRIPTION_LIMIT);
  }

  return rendered.join("\n");
}

function buildRaidIntelDistrictLabel(row: RaidIntelDistrict): string {
  const hallLevel = row.districtHallLevel === null ? "" : ` DH${row.districtHallLevel}`;
  return `${row.name}${hallLevel} — Grade: ${row.grade}`;
}

function buildRaidIntelSectionLines(section: RaidIntelDefender): RaidDetailLine[] {
  const defenderTag = section.defenderTag ? formatRaidTrackedClanTag(section.defenderTag) : null;
  const title = buildClanProfileMarkdownLink(section.defenderName, section.defenderTag);
  const upgradesText = section.upgrades === null || section.upgrades === undefined ? "—" : String(section.upgrades);
  const header = defenderTag ? `### ${title} \`${defenderTag}\` | 🏘️ ${upgradesText}` : `### ${title} | 🏘️ ${upgradesText}`;

  if (section.districts.length <= 0) {
    return [
      { text: header, item: false },
      { text: "No defender intel available yet.", item: false },
    ];
  }

  return [
    { text: header, item: false },
    ...section.districts.map((district) => ({
      text: `- ${buildRaidIntelDistrictLabel(district)}`,
      item: true,
    })),
  ];
}

function buildRaidAttackSectionLines(section: RaidDashboardAttackSection): RaidDetailLine[] {
  const defenderTag = section.defenderTag ? formatRaidTrackedClanTag(section.defenderTag) : null;
  const title = buildClanProfileMarkdownLink(section.defenderName, section.defenderTag);
  const header = defenderTag ? `### ${title} \`${defenderTag}\`` : `### ${title}`;

  if (section.districts.length <= 0) {
    return [
      { text: header, item: false },
      { text: "No attack log available yet.", item: false },
    ];
  }

  return [
    { text: header, item: false },
    ...section.districts.map((district) => ({
      text: `- ${buildRaidDistrictLabel(district)}`,
      item: true,
    })),
  ];
}

function buildRaidDefenseSectionSummaryText(section: RaidDashboardDefenseSection): string {
  const attackerTag = section.attackerTag ? formatRaidTrackedClanTag(section.attackerTag) : null;
  const title = buildClanProfileMarkdownLink(section.attackerName, section.attackerTag);
  const joinEmoji = formatRaidDefenseJoinEmoji(section.joinType);
  return `${joinEmoji} ${title}${attackerTag ? ` \`${attackerTag}\`` : ""} — ${formatRaidDefenseAttacksUsed(
    section.attacksUsed,
  )} — ${formatRaidDefenseDistrictsRemaining(section.districtsRemaining)}`;
}

function formatRaidDefenseJoinEmoji(joinType: RaidTrackedClanJoinType | null): string {
  return joinType === "open" ? "🔓" : "🔒";
}

function formatRaidDefenseAttacksUsed(attacksUsed: number | null): string {
  if (attacksUsed === null) {
    return "attacks used: —";
  }
  return attacksUsed === 1 ? "1 attack used" : `${attacksUsed} attacks used`;
}

function formatRaidDefenseDistrictsRemaining(districtsRemaining: number | null): string {
  if (districtsRemaining === null) {
    return "districts remaining: —";
  }
  return districtsRemaining === 1
    ? "1 district remaining"
    : `${districtsRemaining} districts remaining`;
}

function buildRaidDefenseRequirementsText(requirements: RaidClanJoinRequirements | null): string {
  const pieces: string[] = [];
  if (requirements?.requiredTownHall !== null && requirements?.requiredTownHall !== undefined) {
    pieces.push(`TH${requirements.requiredTownHall}`);
  }
  if (
    requirements?.requiredBuilderBaseTrophies !== null &&
    requirements?.requiredBuilderBaseTrophies !== undefined
  ) {
    pieces.push(`Builder Base: ${requirements.requiredBuilderBaseTrophies}+ trophies`);
  }
  if (requirements?.requiredTrophies !== null && requirements?.requiredTrophies !== undefined) {
    pieces.push(`Ranked: ${requirements.requiredTrophies}+ trophies`);
  }
  return pieces.length > 0 ? `Requirements: ${pieces.join(", ")}` : "Requirements: —";
}

function buildRaidDefenseSectionLines(
  section: RaidDashboardDefenseSection,
  options?: { includeRequirements?: boolean },
): RaidDetailLine[] {
  const lines: RaidDetailLine[] = [{ text: buildRaidDefenseSectionSummaryText(section), item: true }];
  if (options?.includeRequirements && section.joinType === "open") {
    lines.push({ text: `  - ${buildRaidDefenseRequirementsText(section.joinRequirements)}`, item: false });
  }
  return [
    ...lines,
  ];
}

type RaidDashboardSeasonSnapshot = {
  activeSeason: ClanCapitalRaidSeason | null;
  attackSections: RaidDashboardAttackSection[];
  defenseSections: RaidDashboardDefenseSection[];
  counts: RaidDashboardCountRow;
};

async function loadRaidDashboardSeasonSnapshot(input: {
  cocService: CoCService | null;
  clanTag: string;
  nowMs: number;
}): Promise<RaidDashboardSeasonSnapshot> {
  if (!input.cocService || typeof input.cocService.getClanCapitalRaidSeasons !== "function") {
    return {
      activeSeason: null,
      attackSections: [],
      defenseSections: [],
      counts: {
        attacksCompleted: null,
        attacksMax: null,
        hasOngoingRaid: false,
        raidsCompleted: null,
      },
    };
  }

  const seasons = await input.cocService
    .getClanCapitalRaidSeasons(formatRaidTrackedClanTag(input.clanTag), 2)
    .catch(() => []);
  const activeSeason = selectCurrentRaidSeason({
    seasons,
    nowMs: input.nowMs,
  });
  if (!activeSeason) {
    return {
      activeSeason: null,
      attackSections: [],
      defenseSections: [],
      counts: {
        attacksCompleted: null,
        attacksMax: null,
        hasOngoingRaid: false,
        raidsCompleted: null,
      },
    };
  }

  const attackSections = normalizeAttackSections(activeSeason);
  const defenseSections = normalizeDefenseSections(activeSeason, new Map());
  const counts: RaidDashboardCountRow = {
    attacksCompleted:
      Array.isArray(activeSeason.members) && activeSeason.members.length > 0
        ? activeSeason.members.reduce((sum, member) => sum + clampInt(member?.attacks, 0, 6), 0)
        : null,
    attacksMax: Array.isArray(activeSeason.members) && activeSeason.members.length > 0
      ? activeSeason.members.length * 6
      : null,
    hasOngoingRaid: calculateHasOngoingRaidFromAttackLog(activeSeason.attackLog),
    raidsCompleted: calculateCompletedRaidsFromSeason(activeSeason, attackSections),
  };

  return {
    activeSeason,
    attackSections,
    defenseSections,
    counts,
  };
}

function buildRaidDetailLines(detail: RaidDashboardSeasonDetail): RaidDetailLine[] {
  const lines: RaidDetailLine[] = [];

  if (detail.attackSections.length > 0) {
    lines.push({ text: "## Attacking", item: false });
    lines.push({ text: "", item: false });
    detail.attackSections.forEach((section, index) => {
      lines.push(...buildRaidAttackSectionLines(section));
      if (index < detail.attackSections.length - 1) {
        lines.push({ text: "", item: false });
      }
    });
  } else {
    lines.push({ text: "## Attacking", item: false });
    lines.push({ text: "", item: false });
    lines.push({ text: "No attack log available yet.", item: false });
  }

  if (detail.defenseSections.length > 0) {
    if (lines.length > 0) {
      lines.push({ text: "", item: false });
    }
    lines.push({ text: "## Defending", item: false });
    lines.push({ text: "", item: false });
    for (const section of detail.defenseSections) {
      lines.push(...buildRaidDefenseSectionLines(section, { includeRequirements: true }));
      lines.push({ text: "", item: false });
    }
    if (lines.length > 0 && lines[lines.length - 1]?.text === "") {
      lines.pop();
    }
  } else {
    if (lines.length > 0) {
      lines.push({ text: "", item: false });
    }
    lines.push({ text: "## Defending", item: false });
    lines.push({ text: "", item: false });
    lines.push({ text: "No defense log available yet.", item: false });
  }

  return lines;
}

function normalizeAttackSections(season: ClanCapitalRaidSeason): RaidDashboardAttackSection[] {
  if (!Array.isArray(season.attackLog) || season.attackLog.length <= 0) return [];
  return season.attackLog
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const value = entry as Record<string, unknown>;
      const districts = Array.isArray(value.districts)
        ? value.districts
            .map((district) => normalizeRaidDistrictRow(district))
            .filter((district): district is RaidDashboardDistrictRow => district !== null)
        : [];
      return {
        defenderName: normalizeDistrictName((value.defender as { name?: unknown } | null | undefined)?.name ?? value.defenderName),
        defenderTag: normalizeRaidTrackedClanTag(
          String((value.defender as { tag?: unknown } | null | undefined)?.tag ?? value.defenderTag ?? ""),
        ),
        districts,
      };
    })
    .filter((section): section is RaidDashboardAttackSection => Boolean(section));
}

function normalizeRaidIntelDefenders(season: ClanCapitalRaidSeason): RaidIntelDefender[] {
  return normalizeAttackSections(season).map((section) => ({
    defenderName: section.defenderName,
    defenderTag: section.defenderTag,
    upgrades: null,
    districts: section.districts.map((district) => ({
      key: buildRaidIntelDistrictKey({
        defenderTag: section.defenderTag,
        districtName: district.name,
      }),
      defenderName: section.defenderName,
      defenderTag: section.defenderTag,
      name: district.name,
      districtHallLevel: district.districtHallLevel,
      grade: "Unmarked",
    })),
  }));
}

function normalizeDefenseSections(
  season: ClanCapitalRaidSeason,
  metadataByTag: Map<string, RaidAttackerClanMetadata | null>,
): RaidDashboardDefenseSection[] {
  if (!Array.isArray(season.defenseLog) || season.defenseLog.length <= 0) return [];
  const sections: RaidDashboardDefenseSection[] = [];
  for (const entry of season.defenseLog) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const attackerName = normalizeDistrictName(
      (value.attacker as { name?: unknown } | null | undefined)?.name ?? value.attackerName,
    );
    const attackerTag = normalizeRaidTrackedClanTag(
      String((value.attacker as { tag?: unknown } | null | undefined)?.tag ?? value.attackerTag ?? ""),
    );
    if (!attackerTag) continue;
    const districts = Array.isArray(value.districts)
      ? value.districts
          .map((district) => normalizeRaidDistrictRow(district))
          .filter((district): district is RaidDashboardDistrictRow => district !== null)
      : [];
    const attacksUsed = calculateDefenseAttacksUsed(value, districts);
    const districtCount = normalizePositiveInt(value.districtCount);
    const districtsDestroyed = normalizeNonNegativeInt(value.districtsDestroyed);
    const districtsRemaining =
      districtCount !== null && districtsDestroyed !== null
        ? Math.max(0, districtCount - districtsDestroyed)
        : calculateDistrictsRemaining(districts);
    const metadata = metadataByTag.get(attackerTag) ?? null;
    sections.push({
      attackerName,
      attackerTag,
      joinType: metadata?.joinType ?? null,
      joinRequirements: metadata?.joinRequirements ?? null,
      attacksUsed,
      districtsRemaining,
    });
  }
  return sections;
}

function calculateDefenseAttacksUsed(
  entry: Record<string, unknown>,
  districts: RaidDashboardDistrictRow[],
): number | null {
  const aggregateAttackCount = normalizeNonNegativeInt(
    entry.attackCount ?? entry.attacks ?? entry.attacksUsed,
  );
  if (aggregateAttackCount !== null) {
    return aggregateAttackCount;
  }

  const districtAttackCounts = districts
    .map((district) => district.attackCount)
    .filter((attackCount): attackCount is number => attackCount !== null);
  if (districtAttackCounts.length > 0) {
    return districtAttackCounts.reduce((sum, attackCount) => sum + attackCount, 0);
  }

  return null;
}

function calculateDistrictsRemaining(districts: RaidDashboardDistrictRow[]): number | null {
  if (districts.length <= 0) return null;
  let sawKnownState = false;
  let remaining = 0;
  for (const district of districts) {
    const fullyDestroyed = isDistrictFullyDestroyed(district);
    if (fullyDestroyed === null) {
      return null;
    }
    sawKnownState = true;
    if (!fullyDestroyed) {
      remaining += 1;
    }
  }
  return sawKnownState ? remaining : null;
}

async function loadRaidAttackerClanMetadata(input: {
  cocService: CoCService | null;
  defenseSections: Array<{ attackerTag: string | null }>;
  source: string;
}): Promise<Map<string, RaidAttackerClanMetadata | null>> {
  const result = new Map<string, RaidAttackerClanMetadata | null>();
  if (!input.cocService || typeof input.cocService.getClan !== "function") {
    return result;
  }

  const uniqueTags = [...new Set(input.defenseSections.map((section) => section.attackerTag).filter(Boolean))];
  for (const tag of uniqueTags) {
    if (!tag) continue;
    try {
      const clan = await input.cocService.getClan(formatRaidTrackedClanTag(tag));
      result.set(tag, normalizeRaidAttackerClanMetadata(clan));
    } catch (err) {
      console.error(
        `[raids] stage=detail_attacker_metadata_fetch_failed source=${input.source} tag=${formatRaidTrackedClanTag(tag)} error=${String(err instanceof Error ? err.message : err)}`,
      );
      result.set(tag, null);
    }
  }

  return result;
}

function calculateCompletedRaidsFromSeason(
  season: ClanCapitalRaidSeason,
  attackSections: RaidDashboardAttackSection[],
): number | null {
  if (attackSections.length <= 0) {
    return calculateCompletedRaidsFromAttackLog(season.attackLog);
  }

  let completed = 0;
  let sawUsableSection = false;
  for (const entry of season.attackLog ?? []) {
    const state = normalizeRaidAttackLogEntryState(entry);
    if (!state.usable) continue;
    sawUsableSection = true;
    if (state.complete === true) {
      completed += 1;
    }
  }

  return sawUsableSection ? completed : null;
}

async function loadSelectedClanDetail(input: {
  cocService: CoCService | null;
  clanTag: string;
  source: string;
}): Promise<RaidDashboardSeasonDetail | null> {
  const snapshot = await loadRaidDashboardSeasonSnapshot({
    cocService: input.cocService,
    clanTag: input.clanTag,
    nowMs: Date.now(),
  });
  const activeSeason = snapshot.activeSeason;
  if (!activeSeason) {
    return {
      activeSeason: null,
      attackSections: [],
      defenseSections: [],
      raidsCompleted: null,
    };
  }

  const metadataByTag = await loadRaidAttackerClanMetadata({
    cocService: input.cocService,
    defenseSections: snapshot.defenseSections,
    source: input.source,
  });
  return {
    activeSeason,
    attackSections: snapshot.attackSections,
    defenseSections: normalizeDefenseSections(activeSeason, metadataByTag),
    raidsCompleted: snapshot.counts.raidsCompleted,
  };
}

export async function loadRaidDashboardSeasonDetailWithQueueContext(input: {
  cocService: CoCService | null;
  clanTag: string;
  source: string;
}): Promise<RaidDashboardSeasonDetail | null> {
  return runWithCoCQueueContext(
    {
      priority: "interactive",
      source: input.source,
    },
    () => loadSelectedClanDetail(input),
  );
}

async function loadRaidIntelSeasonDetail(input: {
  cocService: CoCService | null;
  clanTag: string;
}): Promise<RaidIntelSeasonDetail> {
  if (!input.cocService || typeof input.cocService.getClanCapitalRaidSeasons !== "function") {
    return {
      activeSeason: null,
      defenders: [],
    };
  }

  const seasons = await input.cocService
    .getClanCapitalRaidSeasons(formatRaidTrackedClanTag(input.clanTag), 2)
    .catch(() => []);
  const activeSeason = selectCurrentRaidSeason({
    seasons,
    nowMs: Date.now(),
  });
  if (!activeSeason) {
    return {
      activeSeason: null,
      defenders: [],
    };
  }

  return {
    activeSeason,
    defenders: normalizeRaidIntelDefenders(activeSeason),
  };
}

export async function loadRaidIntelSeasonDetailWithQueueContext(input: {
  cocService: CoCService | null;
  clanTag: string;
  source: string;
}): Promise<RaidIntelSeasonDetail> {
  return runWithCoCQueueContext(
    {
      priority: "interactive",
      source: input.source,
    },
    () => loadRaidIntelSeasonDetail(input),
  );
}

export function resolveRaidIntelDefenderUpgrade(input: {
  defenderTag: string | null;
  trackedClanByTag: ReadonlyMap<string, RaidTrackedClanDisplayRow>;
  defenderProfileUpgradesByTag: ReadonlyMap<string, number>;
}): number | null {
  const defenderTag = normalizeRaidTrackedClanTag(input.defenderTag ?? "");
  if (!defenderTag) return null;
  const trackedClan = input.trackedClanByTag.get(defenderTag) ?? null;
  if (trackedClan?.upgrades !== null && trackedClan?.upgrades !== undefined && Number.isFinite(trackedClan.upgrades)) {
    return Math.trunc(trackedClan.upgrades);
  }
  const defenderProfileUpgrades = input.defenderProfileUpgradesByTag.get(defenderTag);
  return defenderProfileUpgrades !== null && defenderProfileUpgrades !== undefined && Number.isFinite(defenderProfileUpgrades)
    ? Math.trunc(defenderProfileUpgrades)
    : null;
}

export function applyRaidIntelDefenderUpgrades(
  detail: RaidIntelSeasonDetail,
  upgradesByDefenderTag: ReadonlyMap<string, number | null>,
): RaidIntelSeasonDetail {
  if (upgradesByDefenderTag.size <= 0) {
    return detail;
  }

  return {
    ...detail,
    defenders: detail.defenders.map((defender) => {
      const defenderTag = normalizeRaidTrackedClanTag(defender.defenderTag ?? "");
      return {
        ...defender,
        upgrades: defenderTag ? (upgradesByDefenderTag.get(defenderTag) ?? null) : null,
      };
    }),
  };
}

export function buildRaidIntelDescription(input: {
  trackedClan: RaidTrackedClanDisplayRow;
  detail: RaidIntelSeasonDetail;
  selectedDistrictLabel?: string | null;
  controlsHint?: string | null;
  districtArgsNote?: string | null;
  districtControlsNote?: string | null;
  upgradesNote?: string | null;
}): string {
  if (!input.detail.activeSeason) {
    return "No active raid weekend data available.";
  }

  const clanTag = formatRaidTrackedClanTag(input.trackedClan.clanTag);
  const lines: RaidDetailLine[] = [
    { text: "## Raid Intel", item: false },
    { text: "", item: false },
    {
      text: `Tracked clan: ${buildClanProfileMarkdownLink(input.trackedClan.clanName, input.trackedClan.clanTag)} \`${clanTag}\``,
      item: false,
    },
    { text: "Raid weekend: Active", item: false },
    { text: `Updated: ${formatRelativeTimestamp(input.trackedClan.updatedAt)}`, item: false },
  ];

  if (input.selectedDistrictLabel) {
    lines.push({ text: `Selected: ${input.selectedDistrictLabel}`, item: false });
  }
  if (input.controlsHint) {
    lines.push({ text: input.controlsHint, item: false });
  }
  if (input.districtArgsNote) {
    lines.push({ text: input.districtArgsNote, item: false });
  }
  if (input.districtControlsNote) {
    lines.push({ text: input.districtControlsNote, item: false });
  }
  if (input.upgradesNote) {
    lines.push({ text: input.upgradesNote, item: false });
  }

  if (input.detail.defenders.length <= 0) {
    lines.push({ text: "", item: false });
    lines.push({ text: "No defender intel available yet.", item: false });
    return buildRaidDetailDescription({ lines });
  }

  lines.push({ text: "", item: false });
  for (const defender of input.detail.defenders) {
    lines.push(...buildRaidIntelSectionLines(defender));
    lines.push({ text: "", item: false });
  }
  if (lines.length > 0 && lines[lines.length - 1]?.text === "") {
    lines.pop();
  }
  return buildRaidDetailDescription({ lines });
}

export function applyRaidIntelLayoutGrades(
  detail: RaidIntelSeasonDetail,
  gradeByDistrictKey: Map<string, RaidIntelLayoutGradeLabel>,
): RaidIntelSeasonDetail {
  if (gradeByDistrictKey.size <= 0) {
    return detail;
  }

  return {
    ...detail,
    defenders: detail.defenders.map((defender) => ({
      ...defender,
      districts: defender.districts.map((district) => ({
        ...district,
        grade: gradeByDistrictKey.get(district.key) ?? district.grade,
      })),
    })),
  };
}

export function findRaidIntelDistrictByKey(
  detail: RaidIntelSeasonDetail,
  key: string,
): RaidIntelDistrict | null {
  const normalized = String(key ?? "").trim();
  if (!normalized) return null;
  for (const defender of detail.defenders) {
    const district = defender.districts.find((entry) => entry.key === normalized);
    if (district) return district;
  }
  return null;
}

export function buildRaidIntelDistrictOptions(input: {
  detail: RaidIntelSeasonDetail;
}): {
  options: RaidIntelDistrictOption[];
  totalDistrictCount: number;
  truncated: boolean;
} {
  const totalDistrictCount = input.detail.defenders.reduce(
    (sum, defender) => sum + defender.districts.length,
    0,
  );
  const options: RaidIntelDistrictOption[] = [];
  for (const defender of input.detail.defenders) {
    for (const district of defender.districts) {
      if (options.length >= 25) break;
      const defenderLabel =
        defender.defenderName?.trim() ||
        (defender.defenderTag ? formatRaidTrackedClanTag(defender.defenderTag) : "Unknown Clan");
      const label = `${defenderLabel} / ${district.name}`;
      const descriptionParts = [
        defender.defenderTag ? formatRaidTrackedClanTag(defender.defenderTag) : "Unknown clan",
      ];
      if (district.districtHallLevel !== null) {
        descriptionParts.push(`DH${district.districtHallLevel}`);
      }
      descriptionParts.push(`Current: ${district.grade}`);
      options.push({
        key: district.key,
        label: label.slice(0, 100),
        description: descriptionParts.join(" • ").slice(0, 100),
        value: district.key,
      });
    }
    if (options.length >= 25) break;
  }

  return {
    options,
    totalDistrictCount,
    truncated: totalDistrictCount > options.length,
  };
}

export function buildRaidIntelSelectedDistrictLabel(district: RaidIntelDistrict): string {
  const defenderLabel = buildClanProfileMarkdownLink(district.defenderName, district.defenderTag);
  const districtLabel =
    district.districtHallLevel === null
      ? district.name
      : `${district.name} DH${district.districtHallLevel}`;
  return `${defenderLabel} / ${districtLabel}`;
}

function toRaidDashboardSourceRowFromRaidTrackedClan(row: RaidTrackedClanDisplayRow): RaidDashboardSourceClanRow {
  return {
    clanTag: row.clanTag,
    clanName: row.clanName,
    upgrades: row.upgrades,
    joinType: row.joinType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRaidDashboardSourceRowFromFwaTrackedClan(row: FwaTrackedClanDisplayRow): RaidDashboardSourceClanRow {
  return {
    clanTag: row.tag,
    clanName: row.name,
    upgrades: null,
    joinType: null,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  };
}

function toSyntheticRaidDashboardSourceRow(clanTag: string): RaidDashboardSourceClanRow {
  const normalizedClanTag = normalizeRaidTrackedClanTag(clanTag) ?? clanTag;
  const now = new Date(0);
  return {
    clanTag: normalizedClanTag,
    clanName: null,
    upgrades: null,
    joinType: null,
    createdAt: now,
    updatedAt: now,
  };
}

function getRaidDashboardRowsFromSourceRows(input: {
  sourceRows: RaidDashboardSourceClanRow[];
  cocService: CoCService | null;
  guildId?: string | null;
  source: string;
}): Promise<RaidDashboardClanRow[]> {
  return loadRaidDashboardRowsFromSourceRows(input);
}

async function loadRaidDashboardRowsFromSourceRows(input: {
  sourceRows: RaidDashboardSourceClanRow[];
  cocService: CoCService | null;
  guildId?: string | null;
  source: string;
}): Promise<RaidDashboardClanRow[]> {
  const tracked = input.sourceRows;
  if (tracked.length <= 0) {
    return [];
  }
  const trackedByTag = new Map(
    tracked.map((row) => [normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag, row] as const),
  );

  const nowMs = Date.now();
  const snapshots = await Promise.all(
    tracked.map(async (row) => {
      const snapshot = await loadRaidDashboardSeasonSnapshot({
        cocService: input.cocService,
        clanTag: row.clanTag,
        nowMs,
      });
      return [normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag, snapshot] as const;
    }),
  );
  const allDefenseSections = snapshots.flatMap(([, snapshot]) => snapshot.defenseSections);
  const raidIntelSeasonInputs = tracked.flatMap((row, index) => {
    const activeSeason = snapshots[index]?.[1]?.activeSeason ?? null;
    const startMs = activeSeason?.startTime ? parseRaidSeasonTimeMs(activeSeason.startTime) : null;
    return startMs === null
      ? []
      : [
          {
            sourceClanTag: row.clanTag,
            raidSeasonStartTime: new Date(startMs),
          },
        ];
  });

  const [metadataByTag, raidIntelMarksBySeason] = await Promise.all([
    loadRaidAttackerClanMetadata({
      cocService: input.cocService,
      defenseSections: allDefenseSections,
      source: input.source,
    }),
    loadRaidIntelLayoutMarksForSeasons({
      guildId: input.guildId ?? null,
      seasons: raidIntelSeasonInputs,
    }),
  ]);
  const raidIntelDefenderTags = [
    ...new Set(
      [...raidIntelMarksBySeason.values()]
        .flat()
        .map((mark) => normalizeRaidTrackedClanTag(mark.defenderTag))
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ];
  const raidIntelDefenderProfileUpgradesByTag = await loadRaidIntelDefenderProfileUpgradesForTags({
    guildId: input.guildId ?? null,
    defenderTags: raidIntelDefenderTags,
  });

  const rows = tracked.map((row, index) => {
    const snapshot = snapshots[index]?.[1] ?? {
      activeSeason: null,
      attackSections: [],
      defenseSections: [],
      counts: {
        attacksCompleted: null,
        attacksMax: null,
        hasOngoingRaid: false,
        raidsCompleted: null,
      },
    };
    const activeSeasonStartMs = snapshot.activeSeason?.startTime
      ? parseRaidSeasonTimeMs(snapshot.activeSeason.startTime)
      : null;
    const raidIntelMarks =
      activeSeasonStartMs === null
        ? []
        : raidIntelMarksBySeason.get(
            buildRaidIntelLayoutScoreKey({
              sourceClanTag: row.clanTag,
              raidSeasonStartTime: new Date(activeSeasonStartMs),
            }),
          ) ?? [];
    const defaultLayoutCount =
      raidIntelMarks.length > 0
        ? raidIntelMarks.filter((mark) => mark.layoutGrade === "DEFAULT").length
        : null;
    const raidIntelDefenderUpgrades = (() => {
      const defenderTags = [
        ...new Set(
          raidIntelMarks
            .map((mark) => normalizeRaidTrackedClanTag(mark.defenderTag))
            .filter((tag): tag is string => Boolean(tag)),
        ),
      ];
      if (defenderTags.length !== 1) {
        return null;
      }
      return resolveRaidIntelDefenderUpgrade({
        defenderTag: defenderTags[0]!,
        trackedClanByTag: trackedByTag,
        defenderProfileUpgradesByTag: raidIntelDefenderProfileUpgradesByTag,
      });
    })();
    const intelGradeScore = raidIntelMarks.reduce(
      (sum, mark) => sum + calculateRaidIntelLayoutGradeScore(mark.layoutGrade),
      0,
    );
    const maxDefenseAttacksUsed = (() => {
      const values = [
        ...snapshot.defenseSections.map((section) => section.attacksUsed),
        ...(snapshot.activeSeason?.defenseLog ?? []).map((entry) =>
          normalizeNonNegativeInt((entry as Record<string, unknown>).attackCount ??
            (entry as Record<string, unknown>).attacks ??
            (entry as Record<string, unknown>).attacksUsed),
        ),
      ]
        .filter((value): value is number => Number.isFinite(value));
      if (values.length <= 0) {
        return null;
      }
      return Math.max(...values);
    })();
    const offensiveDistrictsDestroyed = calculateCurrentOffensiveDistrictsDestroyed(
      snapshot.activeSeason?.attackLog,
    );
    const offensiveAverageAttacksPerCompletedRaid = calculateAverageAttacksPerCompletedRaid(
      snapshot.activeSeason?.attackLog,
    );
    const raidMedalEstimate = buildRaidDashboardMedalEstimate({
      attackSections: snapshot.attackSections,
      attacksCompleted: snapshot.counts.attacksCompleted,
      defensiveMedals: normalizeNonNegativeInt(snapshot.activeSeason?.defensiveReward),
    });
    const openDefenseSections = snapshot.activeSeason
      ? normalizeDefenseSections(snapshot.activeSeason, metadataByTag).filter(
          (section) => section.joinType === "open",
        )
      : [];
    return {
      ...row,
      attacksCompleted: snapshot.counts.attacksCompleted,
      attacksMax: snapshot.counts.attacksMax,
      defaultLayoutCount,
      raidIntelDefenderUpgrades,
      maxDefenseAttacksUsed,
      offensiveDistrictsDestroyed,
      offensiveAverageAttacksPerCompletedRaid,
      raidMedalEstimate,
      intelGradeScore,
      raidIntelMarks,
      hasOngoingRaid: snapshot.counts.hasOngoingRaid,
      raidsCompleted: snapshot.counts.raidsCompleted,
      openDefenseSections,
    };
  });

  return sortRaidDashboardRows(rows);
}

export async function listRaidDashboardRows(input: {
  cocService: CoCService | null;
  guildId?: string | null;
}): Promise<RaidDashboardClanRow[]> {
  const rows = await listRaidTrackedClansForDisplay();
  return getRaidDashboardRowsFromSourceRows({
    sourceRows: rows.map(toRaidDashboardSourceRowFromRaidTrackedClan),
    cocService: input.cocService,
    guildId: input.guildId ?? null,
    source: "raids:overview",
  });
}

export async function listRaidDashboardRowsWithQueueContext(input: {
  cocService: CoCService | null;
  source: string;
  guildId?: string | null;
}): Promise<RaidDashboardClanRow[]> {
  return runWithCoCQueueContext(
    {
      priority: "interactive",
      source: input.source,
    },
    () => listRaidDashboardRows({ cocService: input.cocService, guildId: input.guildId ?? null }),
  );
}

export async function listRaidDashboardRowsForSource(input: {
  cocService: CoCService | null;
  guildId?: string | null;
  sourceMode: RaidDashboardOverviewSourceMode;
  customClanTag?: string | null;
}): Promise<RaidDashboardClanRow[]> {
  if (input.sourceMode === "custom") {
    const customClanTag = normalizeRaidTrackedClanTag(input.customClanTag ?? "");
    if (!customClanTag) {
      return [];
    }
    return getRaidDashboardRowsFromSourceRows({
      sourceRows: [toSyntheticRaidDashboardSourceRow(customClanTag)],
      cocService: input.cocService,
      guildId: input.guildId ?? null,
      source: "raids:overview:custom",
    });
  }

  if (input.sourceMode === "fwa") {
    const fwaRows = await listFwaTrackedClansForDisplay();
    return getRaidDashboardRowsFromSourceRows({
      sourceRows: fwaRows.map(toRaidDashboardSourceRowFromFwaTrackedClan),
      cocService: input.cocService,
      guildId: input.guildId ?? null,
      source: "raids:overview:fwa",
    });
  }

  const trackedRows = await listRaidTrackedClansForDisplay();
  return getRaidDashboardRowsFromSourceRows({
    sourceRows: trackedRows.map(toRaidDashboardSourceRowFromRaidTrackedClan),
    cocService: input.cocService,
    guildId: input.guildId ?? null,
    source: "raids:overview",
  });
}

export async function listRaidDashboardRowsForSourceWithQueueContext(input: {
  cocService: CoCService | null;
  sourceMode: RaidDashboardOverviewSourceMode;
  guildId?: string | null;
  customClanTag?: string | null;
}): Promise<RaidDashboardClanRow[]> {
  return runWithCoCQueueContext(
    {
      priority: "interactive",
      source:
        input.sourceMode === "fwa"
          ? "raids:overview:fwa"
          : input.sourceMode === "custom"
            ? "raids:overview:custom"
            : "raids:overview",
    },
    () =>
      listRaidDashboardRowsForSource({
        cocService: input.cocService,
        guildId: input.guildId ?? null,
        sourceMode: input.sourceMode,
        customClanTag: input.customClanTag ?? null,
      }),
  );
}

export function buildRaidDashboardClanTitle(input: {
  clanTag: string;
  clanName: string | null;
  joinType: RaidTrackedClanJoinType | null;
}): string {
  const emoji = getRaidTrackedClanJoinTypeEmoji(input.joinType);
  const clanTag = formatRaidTrackedClanTag(input.clanTag);
  const clanName = input.clanName?.trim() || clanTag;
  const link = buildClanProfileMarkdownLink(clanName, clanTag);
  return `${emoji} ${link} \`${clanTag}\``;
}

function buildRaidDashboardOverviewClanTitle(input: {
  clanTag: string;
  clanName: string | null;
  hasOngoingRaid: boolean;
  raidsCompleted: number | null;
  maxDefenseAttacksUsed: number | null;
}): string {
  const clanTag = formatRaidTrackedClanTag(input.clanTag);
  const clanName = input.clanName?.trim() || clanTag;
  const link = buildClanProfileMarkdownLink(clanName, clanTag);
  const prefix = input.hasOngoingRaid ? "⚔️ " : (input.raidsCompleted ?? 0) > 0 ? "🌄 " : "";
  const shieldText = input.maxDefenseAttacksUsed === null ? "" : ` 🛡️${input.maxDefenseAttacksUsed}`;
  return `${prefix}${link} \`${clanTag}\`${shieldText}`;
}

function buildRaidDashboardOverviewIntelLine(row: RaidDashboardClanRow): string | null {
  if ((row.raidsCompleted ?? 0) >= 1) {
    return null;
  }

  const marks = row.raidIntelMarks ?? [];
  if (marks.length <= 0) {
    return null;
  }

  const groups = buildRaidIntelSummaryGroups(marks);
  const defaultAbbreviations = groups.get("Default") ?? [];
  const defaultText = defaultAbbreviations.length > 0 ? defaultAbbreviations.join(", ") : "—";
  const upgradesText =
    row.raidIntelDefenderUpgrades === null || row.raidIntelDefenderUpgrades === undefined
      ? "—"
      : String(row.raidIntelDefenderUpgrades);
  const defaultLayoutCount =
    row.defaultLayoutCount ?? marks.filter((mark) => mark.layoutGrade === "DEFAULT").length;
  return `- 🏘️ ${upgradesText} | defaults: ${defaultLayoutCount} | ${defaultText}`;
}

function buildRaidDashboardIntelSummaryLine(
  marks: RaidIntelDistrictLayoutMarkRecord[] | null | undefined,
): string | null {
  const normalizedMarks = Array.isArray(marks) ? marks : [];
  if (normalizedMarks.length <= 0) {
    return null;
  }

  const groups = buildRaidIntelSummaryGroups(normalizedMarks);
  const chunks = RAID_INTEL_SUMMARY_GRADE_ORDER.flatMap((grade) => {
    const abbreviations = groups.get(grade) ?? [];
    if (abbreviations.length <= 0) return [];
    return [`${RAID_INTEL_SUMMARY_GRADE_EMOJI[grade]} ${abbreviations.join(", ")}`];
  });

  return chunks.length > 0 ? `- ⚔️ ${chunks.join(" ")}` : null;
}

function buildRaidDashboardOverviewOpenDefenseSectionText(
  section: RaidDashboardDefenseSection,
): string | null {
  if (section.districtsRemaining === 0) {
    return null;
  }

  const attackerTag = section.attackerTag ? formatRaidTrackedClanTag(section.attackerTag) : null;
  const title = buildClanProfileMarkdownLink(section.attackerName, section.attackerTag);
  const suffix =
    section.districtsRemaining === null
      ? ""
      : ` — ${section.districtsRemaining} districts remaining`;

  return `- 🛡️ ${title}${attackerTag ? ` \`${attackerTag}\`` : ""}${suffix}`;
}

export function buildRaidDashboardOverviewDescription(rows: RaidDashboardClanRow[]): string {
  if (rows.length <= 0) {
    return "No RAIDS tracked clans configured.";
  }

  const lines: string[] = ["## Raid Clans", ""];
  for (const row of sortRaidDashboardRows(rows)) {
    lines.push(buildRaidDashboardOverviewClanTitle(row));
    const intelLine = buildRaidDashboardOverviewIntelLine(row);
    if (intelLine) {
      lines.push(intelLine);
    }
    const offenseLine = buildRaidDashboardOverviewOffenseLine(row);
    if (offenseLine) {
      lines.push(offenseLine);
    }
    const medalLine = buildRaidDashboardOverviewMedalLine(row);
    if (medalLine) {
      lines.push(medalLine);
    }
    for (const section of row.openDefenseSections ?? []) {
      const text = buildRaidDashboardOverviewOpenDefenseSectionText(section);
      if (text) {
        lines.push(text);
      }
    }
    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

export function buildRaidDashboardSingleClanDescription(
  row: RaidDashboardClanRow,
  detail?: RaidDashboardSeasonDetail | null,
): string {
  if (detail && detail.activeSeason === null) {
    return "No active raid weekend data available.";
  }

  const raidsCompleted = row.raidsCompleted ?? detail?.raidsCompleted ?? null;

  const lines: RaidDetailLine[] = [
    { text: "## Raid Clan", item: false },
    { text: "", item: false },
    { text: buildRaidDashboardClanTitle(row), item: false },
    { text: `Join type: ${formatJoinTypeLabel(row.joinType)}`, item: false },
    {
      text: `Upgrades: ${row.upgrades === null ? "—" : row.upgrades}`,
      item: false,
    },
    {
      text: `Attacks: ${formatCompletedAttacksLabel(row.attacksCompleted)}`,
      item: false,
    },
    {
      text: `Raids completed: ${raidsCompleted === null ? "—" : raidsCompleted}`,
      item: false,
    },
  ];

  const intelSummaryLine = buildRaidDashboardIntelSummaryLine(row.raidIntelMarks);
  if (intelSummaryLine) {
    lines.push({ text: intelSummaryLine, item: false });
  }

  if (detail) {
    lines.push({ text: "", item: false });
    lines.push(...buildRaidDetailLines(detail));
  }

  return detail ? buildRaidDetailDescription({ lines }) : lines.map((line) => line.text).join("\n");
}

export function buildRaidDashboardSelectChoices(
  rows: RaidDashboardClanRow[],
  selectedClanTag?: string | null,
): Array<{
  label: string;
  value: string;
  description: string | null;
  emoji: string | null;
  selected: boolean;
}> {
  const normalizedSelected = normalizeRaidTrackedClanTag(selectedClanTag ?? "");
  const sortedRows = sortRaidDashboardRows(rows);
  const selectedRow =
    normalizedSelected !== null
      ? sortedRows.find(
          (row) => (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) === normalizedSelected,
        ) ?? null
      : null;
  const rowsForDropdown =
    selectedRow && sortedRows.indexOf(selectedRow) >= 25
      ? [selectedRow, ...sortedRows.filter((row) => row !== selectedRow).slice(0, 24)]
      : sortedRows.slice(0, 25);

  return rowsForDropdown.map((row) => {
    const clanTag = formatRaidTrackedClanTag(row.clanTag);
    const label = row.clanName?.trim() || clanTag;
    return {
      label: label.slice(0, 100),
      value: normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag,
      description: clanTag.slice(0, 100),
      emoji: getRaidTrackedClanJoinTypeEmoji(row.joinType),
      selected:
        normalizedSelected !== null &&
        (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) === normalizedSelected,
    };
  });
}

export function findRaidDashboardClanRow(
  rows: RaidDashboardClanRow[],
  clanTag: string,
): RaidDashboardClanRow | null {
  const normalized = normalizeRaidTrackedClanTag(clanTag);
  if (!normalized) return null;
  return (
    rows.find((row) => (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) === normalized) ??
    null
  );
}

function sortRaidDashboardRows(rows: RaidDashboardClanRow[]): RaidDashboardClanRow[] {
  return rows
    .map((row, index) => ({
      ...row,
      overviewSortIndex: index,
    }))
    .sort((left, right) => {
      const leftOngoing = left.hasOngoingRaid ? 1 : 0;
      const rightOngoing = right.hasOngoingRaid ? 1 : 0;
      if (leftOngoing !== rightOngoing) {
        return rightOngoing - leftOngoing;
      }

      const leftCompleted = left.raidsCompleted ?? 0;
      const rightCompleted = right.raidsCompleted ?? 0;
      if (leftCompleted !== rightCompleted) {
        return rightCompleted - leftCompleted;
      }

      const leftDefaultLayoutCount = left.defaultLayoutCount ?? -1;
      const rightDefaultLayoutCount = right.defaultLayoutCount ?? -1;
      if (leftDefaultLayoutCount !== rightDefaultLayoutCount) {
        return rightDefaultLayoutCount - leftDefaultLayoutCount;
      }

      return (left as { overviewSortIndex: number }).overviewSortIndex -
        (right as { overviewSortIndex: number }).overviewSortIndex;
    })
    .map(({ overviewSortIndex: _overviewSortIndex, ...row }) => row);
}

