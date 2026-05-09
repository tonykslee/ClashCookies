import { createHash } from "node:crypto";
import { buildClanProfileMarkdownLink } from "../helper/clanProfileLink";
import { runWithCoCQueueContext } from "./CoCQueueContext";
import { CoCService, type ClanCapitalRaidSeason } from "./CoCService";
import {
  getRaidTrackedClanJoinTypeEmoji,
  listRaidTrackedClansForDisplay,
  normalizeRaidTrackedClanTag,
  type RaidTrackedClanDisplayRow,
  type RaidTrackedClanJoinType,
} from "./RaidTrackedClanService";

const DISCORD_DESCRIPTION_LIMIT = 4096;
const RAID_DETAIL_TRUNCATION_RESERVE = 96;

export type RaidDashboardCountRow = {
  attacksCompleted: number | null;
  attacksMax: number | null;
  raidsCompleted: number | null;
};

export type RaidDashboardClanRow = RaidTrackedClanDisplayRow & RaidDashboardCountRow;

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
  districts: RaidIntelDistrict[];
};

export type RaidIntelLayoutGrade = "DEFAULT" | "CUSTOM_HARD" | "CUSTOM_MEDIUM" | "CUSTOM_EASY";

export type RaidIntelLayoutGradeLabel = "Unmarked" | "Default" | "Custom - Hard" | "Custom - Medium" | "Custom - Easy";

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

function formatAttacksLabel(input: { attacksCompleted: number | null; attacksMax: number | null }): string {
  if (input.attacksCompleted === null || input.attacksMax === null) {
    return "—";
  }
  return `${input.attacksCompleted}/${input.attacksMax}`;
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

function normalizeDistrictName(name: unknown): string | null {
  const trimmed = String(name ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildRaidIntelDistrictKey(input: {
  defenderTag: string | null;
  districtName: string;
}): string {
  const defenderTag = normalizeRaidTrackedClanTag(input.defenderTag ?? "") ?? "";
  const districtName = normalizeDistrictName(input.districtName) ?? "";
  const raw = `${defenderTag}|${districtName}`;
  const digest = createHash("sha1").update(raw).digest("base64url").slice(0, 10);
  return `d_${digest}`;
}

export function buildRaidIntelLayoutGradeLabel(
  grade: RaidIntelLayoutGrade | null | undefined,
): RaidIntelLayoutGradeLabel {
  if (grade === "DEFAULT") return "Default";
  if (grade === "CUSTOM_HARD") return "Custom - Hard";
  if (grade === "CUSTOM_MEDIUM") return "Custom - Medium";
  if (grade === "CUSTOM_EASY") return "Custom - Easy";
  return "Unmarked";
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
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const districtCount = normalizePositiveInt(value.districtCount);
    const districtsDestroyed = normalizeNonNegativeInt(value.districtsDestroyed);
    if (districtCount !== null && districtsDestroyed !== null) {
      sawUsableLog = true;
      if (districtCount > 0 && districtsDestroyed >= districtCount) {
        completed += 1;
      }
      continue;
    }

    const districts = Array.isArray(value.districts)
      ? value.districts
          .map((district) => normalizeRaidDistrictRow(district))
          .filter((district): district is RaidDashboardDistrictRow => district !== null)
      : [];
    if (districts.length > 0) {
      sawUsableLog = true;
      if (districts.every((district) => isDistrictFullyDestroyed(district) === true)) {
        completed += 1;
      }
    }
  }

  return sawUsableLog ? completed : null;
}

function buildRaidDistrictLabel(row: RaidDashboardDistrictRow): string {
  const hallLevel = row.districtHallLevel === null ? "" : ` DH${row.districtHallLevel}`;
  const attackCount = row.attackCount === null ? "— attacks" : `${row.attackCount} attacks`;
  return `${row.name}${hallLevel} — ${attackCount}`;
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
  const header = defenderTag ? `### ${title} \`${defenderTag}\`` : `### ${title}`;

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

function buildRaidDefenseSectionLines(section: RaidDashboardDefenseSection): RaidDetailLine[] {
  const attackerTag = section.attackerTag ? formatRaidTrackedClanTag(section.attackerTag) : null;
  const title = buildClanProfileMarkdownLink(section.attackerName, section.attackerTag);
  const joinEmoji = getRaidTrackedClanJoinTypeEmoji(section.joinType);
  const header = `${joinEmoji} ${title}${attackerTag ? ` \`${attackerTag}\`` : ""} — ${
    section.districtsRemaining === null
      ? "— districts remaining"
      : `${section.districtsRemaining} districts remaining`
  }`;

  return [
    { text: header, item: true },
  ];
}

function buildRaidDetailLines(detail: RaidDashboardSeasonDetail): RaidDetailLine[] {
  if (!detail.activeSeason) {
    return [{ text: "No active raid weekend data available.", item: false }];
  }

  const lines: RaidDetailLine[] = [];
  if (detail.attackSections.length > 0) {
    lines.push({ text: "## Attacking", item: false });
    lines.push({ text: "", item: false });
    for (const section of detail.attackSections) {
      lines.push(...buildRaidAttackSectionLines(section));
      lines.push({ text: "", item: false });
    }
    if (lines.length > 0 && lines[lines.length - 1]?.text === "") {
      lines.pop();
    }
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
      lines.push(...buildRaidDefenseSectionLines(section));
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

function buildRaidDetailSections(detail: RaidDashboardSeasonDetail): string {
  return buildRaidDetailDescription({
    lines: buildRaidDetailLines(detail),
  });
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
  joinTypeByTag: Map<string, RaidTrackedClanJoinType | null>,
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
    const districtCount = normalizePositiveInt(value.districtCount);
    const districtsDestroyed = normalizeNonNegativeInt(value.districtsDestroyed);
    const districtsRemaining =
      districtCount !== null && districtsDestroyed !== null
        ? Math.max(0, districtCount - districtsDestroyed)
        : calculateDistrictsRemaining(districts);
    sections.push({
      attackerName,
      attackerTag,
      joinType: joinTypeByTag.get(attackerTag) ?? null,
      districtsRemaining,
    });
  }
  return sections;
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

async function loadAttackClanJoinTypes(input: {
  cocService: CoCService | null;
  defenseSections: RaidDashboardDefenseSection[];
  source: string;
}): Promise<Map<string, RaidTrackedClanJoinType | null>> {
  const result = new Map<string, RaidTrackedClanJoinType | null>();
  if (!input.cocService || typeof input.cocService.getClan !== "function") {
    return result;
  }

  const uniqueTags = [...new Set(input.defenseSections.map((section) => section.attackerTag).filter(Boolean))];
  for (const tag of uniqueTags) {
    if (!tag) continue;
    try {
      const clan = await input.cocService.getClan(formatRaidTrackedClanTag(tag));
      result.set(tag, normalizeRaidJoinType((clan as { type?: unknown } | null)?.type));
    } catch (err) {
      console.error(
        `[raids] stage=detail_join_type_fetch_failed source=${input.source} tag=${formatRaidTrackedClanTag(tag)} error=${String(err instanceof Error ? err.message : err)}`,
      );
      result.set(tag, null);
    }
  }

  return result;
}

function createSelectedClanDetailFromSeason(
  season: ClanCapitalRaidSeason,
  joinTypeByTag: Map<string, RaidTrackedClanJoinType | null>,
): RaidDashboardSeasonDetail {
  const attackSections = normalizeAttackSections(season);
  const defenseSections = normalizeDefenseSections(season, joinTypeByTag);
  return {
    activeSeason: season,
    attackSections,
    defenseSections,
    raidsCompleted: calculateCompletedRaidsFromSeason(season, attackSections),
  };
}

function calculateCompletedRaidsFromSeason(
  season: ClanCapitalRaidSeason,
  attackSections: RaidDashboardAttackSection[],
): number | null {
  const explicit = normalizeNonNegativeInt(season.raidsCompleted);
  if (explicit !== null) {
    return explicit;
  }
  if (attackSections.length <= 0) {
    return calculateCompletedRaidsFromAttackLog(season.attackLog);
  }

  let completed = 0;
  let sawUsableSection = false;
  for (const entry of season.attackLog ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const districtCount = normalizePositiveInt(value.districtCount);
    const districtsDestroyed = normalizeNonNegativeInt(value.districtsDestroyed);
    if (districtCount !== null && districtsDestroyed !== null) {
      sawUsableSection = true;
      if (districtCount > 0 && districtsDestroyed >= districtCount) {
        completed += 1;
      }
      continue;
    }

    const districts = Array.isArray(value.districts)
      ? value.districts
          .map((district) => normalizeRaidDistrictRow(district))
          .filter((district): district is RaidDashboardDistrictRow => district !== null)
      : [];
    if (districts.length > 0) {
      sawUsableSection = true;
      if (districts.every((district) => isDistrictFullyDestroyed(district) === true)) {
        completed += 1;
      }
    }
  }

  return sawUsableSection ? completed : null;
}

async function loadSelectedClanDetail(input: {
  cocService: CoCService | null;
  clanTag: string;
  source: string;
}): Promise<RaidDashboardSeasonDetail | null> {
  if (!input.cocService || typeof input.cocService.getClanCapitalRaidSeasons !== "function") {
    return null;
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
      attackSections: [],
      defenseSections: [],
      raidsCompleted: null,
    };
  }

  const defenseSectionsBase = normalizeDefenseSections(activeSeason, new Map());
  const joinTypeByTag = await loadAttackClanJoinTypes({
    cocService: input.cocService,
    defenseSections: defenseSectionsBase,
    source: input.source,
  });
  return createSelectedClanDetailFromSeason(activeSeason, joinTypeByTag);
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

async function resolveClanRaidCounts(input: {
  cocService: CoCService | null;
  clanTag: string;
  nowMs: number;
}): Promise<RaidDashboardCountRow> {
  if (!input.cocService || typeof input.cocService.getClanCapitalRaidSeasons !== "function") {
    return {
      attacksCompleted: null,
      attacksMax: null,
      raidsCompleted: null,
    };
  }

  const seasons = await input.cocService
    .getClanCapitalRaidSeasons(formatRaidTrackedClanTag(input.clanTag), 2)
    .catch(() => []);
  const activeSeason = selectCurrentRaidSeason({
    seasons,
    nowMs: input.nowMs,
  });
  if (!activeSeason || !Array.isArray(activeSeason.members) || activeSeason.members.length <= 0) {
    return {
      attacksCompleted: null,
      attacksMax: null,
      raidsCompleted: activeSeason ? calculateCompletedRaidsFromSeason(activeSeason, normalizeAttackSections(activeSeason)) : null,
    };
  }

  const attacksCompleted = activeSeason.members.reduce(
    (sum, member) => sum + clampInt(member?.attacks, 0, 6),
    0,
  );
  const attacksMax = activeSeason.members.length * 6;
  const raidsCompleted = calculateCompletedRaidsFromSeason(activeSeason, normalizeAttackSections(activeSeason));
  return {
    attacksCompleted,
    attacksMax,
    raidsCompleted,
  };
}

export function buildRaidIntelDescription(input: {
  trackedClan: RaidTrackedClanDisplayRow;
  upgrades: number | null;
  detail: RaidIntelSeasonDetail;
  selectedDistrictLabel?: string | null;
  controlsHint?: string | null;
  districtControlsNote?: string | null;
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
    {
      text: `Upgrades: ${input.upgrades === null ? "—" : input.upgrades}`,
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
  if (input.districtControlsNote) {
    lines.push({ text: input.districtControlsNote, item: false });
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

export async function listRaidDashboardRows(input: {
  cocService: CoCService | null;
}): Promise<RaidDashboardClanRow[]> {
  const tracked = await listRaidTrackedClansForDisplay();
  if (tracked.length <= 0) {
    return [];
  }

  const nowMs = Date.now();
  const countRows = await Promise.all(
    tracked.map(async (row) => {
      const counts = await resolveClanRaidCounts({
        cocService: input.cocService,
        clanTag: row.clanTag,
        nowMs,
      });
      return [normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag, counts] as const;
    }),
  );
  const countByTag = new Map(countRows);

  return tracked.map((row) => {
    const tag = normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag;
    const counts = countByTag.get(tag) ?? {
      attacksCompleted: null,
      attacksMax: null,
      raidsCompleted: null,
    };
    return {
      ...row,
      attacksCompleted: counts.attacksCompleted,
      attacksMax: counts.attacksMax,
      raidsCompleted: counts.raidsCompleted,
    };
  });
}

export async function listRaidDashboardRowsWithQueueContext(input: {
  cocService: CoCService | null;
  source: string;
}): Promise<RaidDashboardClanRow[]> {
  return runWithCoCQueueContext(
    {
      priority: "interactive",
      source: input.source,
    },
    () => listRaidDashboardRows({ cocService: input.cocService }),
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

export function buildRaidDashboardOverviewDescription(rows: RaidDashboardClanRow[]): string {
  if (rows.length <= 0) {
    return "No RAIDS tracked clans configured.";
  }

  const lines: string[] = ["## Raid Clans", ""];
  for (const row of rows) {
    lines.push(buildRaidDashboardClanTitle(row));
    lines.push(`Upgrades: ${row.upgrades === null ? "—" : row.upgrades}`);
    lines.push(
      `Attacks: ${formatAttacksLabel({
        attacksCompleted: row.attacksCompleted,
        attacksMax: row.attacksMax,
      })}`,
    );
    lines.push(`Raids completed: ${row.raidsCompleted === null ? "—" : row.raidsCompleted}`);
    lines.push(`Updated: ${formatRelativeTimestamp(row.updatedAt)}`);
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
      text: `Attacks: ${formatAttacksLabel({
        attacksCompleted: row.attacksCompleted,
        attacksMax: row.attacksMax,
      })}`,
      item: false,
    },
    {
      text: `Raids completed: ${raidsCompleted === null ? "—" : raidsCompleted}`,
      item: false,
    },
    {
      text: `Updated: ${formatRelativeTimestamp(row.updatedAt)}`,
      item: false,
    },
  ];

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
}> {
  const normalizedSelected = normalizeRaidTrackedClanTag(selectedClanTag ?? "");
  const orderedRows = normalizedSelected
    ? [
        ...rows.filter((row) => (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) === normalizedSelected),
        ...rows.filter((row) => (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) !== normalizedSelected),
      ]
    : rows;

  return orderedRows.slice(0, 25).map((row) => {
    const clanTag = formatRaidTrackedClanTag(row.clanTag);
    const label = row.clanName?.trim() || clanTag;
    const descriptionParts = [`${clanTag}`];
    if (row.upgrades !== null) {
      descriptionParts.push(`Upgrades ${row.upgrades}`);
    }
    const description = descriptionParts.join(" • ").slice(0, 100);
    return {
      label: label.slice(0, 100),
      value: normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag,
      description,
      emoji: getRaidTrackedClanJoinTypeEmoji(row.joinType),
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
