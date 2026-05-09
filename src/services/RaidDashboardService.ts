import { buildClanProfileMarkdownLink } from "../helper/clanProfileLink";
import { CoCService, type ClanCapitalRaidSeason } from "./CoCService";
import {
  getRaidTrackedClanJoinTypeEmoji,
  listRaidTrackedClansForDisplay,
  normalizeRaidTrackedClanTag,
  type RaidTrackedClanDisplayRow,
  type RaidTrackedClanJoinType,
} from "./RaidTrackedClanService";

export type RaidDashboardCountRow = {
  attacksCompleted: number | null;
  attacksMax: number | null;
  raidsCompleted: number | null;
};

export type RaidDashboardClanRow = RaidTrackedClanDisplayRow & RaidDashboardCountRow;

function clampInt(value: unknown, min: number, max: number): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return min;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
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

function selectCurrentRaidSeason(input: {
  seasons: ClanCapitalRaidSeason[];
  nowMs: number;
}): ClanCapitalRaidSeason | null {
  if (!Array.isArray(input.seasons) || input.seasons.length <= 0) {
    return null;
  }

  const candidates = input.seasons.map((season) => {
    const startMs = Date.parse(String(season.startTime ?? ""));
    const endMs = Date.parse(String(season.endTime ?? ""));
    return {
      season,
      startMs: Number.isFinite(startMs) ? startMs : null,
      endMs: Number.isFinite(endMs) ? endMs : null,
    };
  });

  const active = candidates.find((candidate) => {
    if (candidate.startMs === null || candidate.endMs === null) return false;
    return input.nowMs >= candidate.startMs && input.nowMs < candidate.endMs;
  });
  return active?.season ?? null;
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
      raidsCompleted: null,
    };
  }

  const attacksCompleted = activeSeason.members.reduce(
    (sum, member) => sum + clampInt(member?.attacks, 0, 6),
    0,
  );
  const attacksMax = activeSeason.members.length * 6;
  return {
    attacksCompleted,
    attacksMax,
    raidsCompleted: null,
  };
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

export function buildRaidDashboardSingleClanDescription(row: RaidDashboardClanRow): string {
  return [
    "## Raid Clan",
    "",
    buildRaidDashboardClanTitle(row),
    `Join type: ${formatJoinTypeLabel(row.joinType)}`,
    `Upgrades: ${row.upgrades === null ? "—" : row.upgrades}`,
    `Attacks: ${formatAttacksLabel({
      attacksCompleted: row.attacksCompleted,
      attacksMax: row.attacksMax,
    })}`,
    `Raids completed: ${row.raidsCompleted === null ? "—" : row.raidsCompleted}`,
    `Updated: ${formatRelativeTimestamp(row.updatedAt)}`,
  ].join("\n");
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
