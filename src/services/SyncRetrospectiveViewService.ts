import { EmbedBuilder } from "discord.js";
import type {
  SyncRetrospectiveClanRow,
  SyncRetrospectiveResult,
} from "./SyncRetrospectiveService";

const EMBED_COLOR = 0x5865f2;
const FIELD_VALUE_LIMIT = 1024;
const FIRST_EMBED_CLAN_FIELD_LIMIT = 3;
const FOLLOWING_EMBED_CLAN_FIELD_LIMIT = 4;

function formatMetricNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, "");
}
function escapeClanName(value: string): string {
  return value.replace(/[\\`*_~|>]/g, "\\$&");
}

function formatCoverageMetric(
  value: number | null,
  coverage: string,
  suffix = "",
): string {
  if (value === null) return `—${suffix} · ${coverage}`;
  return `${formatMetricNumber(value)}${suffix} · ${coverage}`;
}

function formatClanLine(clan: SyncRetrospectiveClanRow): string {
  const displayName = escapeClanName(clan.identity.clanName ?? clan.identity.clanTag);
  const stars = clan.war.stars === null ? "—★" : `${formatMetricNumber(clan.war.stars)}★`;
  const missed = clan.missedAttacks.coverageComplete && clan.missedAttacks.total !== null
    ? `${formatMetricNumber(clan.missedAttacks.total)} missed`
    : "— missed";
  const violations = clan.identity.warId === null
    ? "— viol"
    : !clan.violations.applicable
      ? "N/A viol"
      : clan.violations.evaluationComplete && clan.violations.total !== null
        ? `${formatMetricNumber(clan.violations.total)} viol`
        : "— viol";
  const deviation = clan.readiness.deviationScore === null
    ? "Dev —"
    : `Dev ${formatMetricNumber(clan.readiness.deviationScore)}`;
  const fillers = clan.fillers.fillerCaptureComplete && clan.fillers.fillerCount !== null
    ? `${formatMetricNumber(clan.fillers.fillerCount)} filler${clan.fillers.fillerCount === 1 ? "" : "s"}`
    : "— fillers";

  return `**${displayName}** — \`${stars} | ${missed} | ${violations} | ${deviation} | ${fillers}\``;
}

function chunkLines(lines: string[], limit: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const line of lines) {
    const nextLength = current.length === 0 ? line.length : currentLength + 1 + line.length;
    if (current.length > 0 && nextLength > limit) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength = current.length === 1 ? line.length : currentLength + 1 + line.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildMetricFields(result: SyncRetrospectiveResult) {
  const stars = result.warSummary.totalStarsKnown === null
    ? `— · ${result.warSummary.starsCoverage.known}/${result.warSummary.starsCoverage.total} clans`
    : `${formatMetricNumber(result.warSummary.totalStarsKnown)} ★ · ${result.warSummary.starsCoverage.known}/${result.warSummary.starsCoverage.total} clans`;
  const missed = formatCoverageMetric(
    result.missedAttacks.missedAttacksKnownTotal,
    `${result.missedAttacks.coverage.completeClans}/${result.missedAttacks.coverage.warClans} complete`,
  );
  const fwa = result.fwaViolations.coverage.fwaWars === 0
    ? "N/A · no FWA wars"
    : formatCoverageMetric(
        result.fwaViolations.violationKnownTotal,
        `${result.fwaViolations.coverage.completedFwaEvaluations}/${result.fwaViolations.coverage.fwaWars} finalized`,
      );
  const deviation = formatCoverageMetric(
    result.readiness.averageDeviation,
    `${result.readiness.deviationCoverage.valid}/${result.readiness.deviationCoverage.totalSnapshots} captured`,
  );
  const fillers = formatCoverageMetric(
    result.fillers.fillerKnownTotal,
    `${result.fillers.fillerCoverage.complete}/${result.fillers.fillerCoverage.totalSnapshots} captured`,
  );

  return [
    { name: "Stars", value: stars, inline: true },
    { name: "Missed attacks", value: missed, inline: true },
    { name: "FWA violations", value: fwa, inline: true },
    { name: "Average deviation", value: deviation, inline: true },
    { name: "Fillers", value: fillers, inline: true },
  ];
}

function buildSyncDescription(result: SyncRetrospectiveResult): string {
  if (result.identity.syncTime === null) {
    return "Sync boundary: Historical mapping unavailable";
  }
  const epochSeconds = Math.floor(result.identity.syncTime.getTime() / 1000);
  return `Sync: <t:${epochSeconds}:F> • <t:${epochSeconds}:R>`;
}

function buildClanFields(chunks: string[][], startIndex: number) {
  return chunks.map((chunk, index) => ({
    name: `Clans ${startIndex + index + 1}`,
    value: chunk.join("\n").slice(0, FIELD_VALUE_LIMIT),
    inline: false,
  }));
}

/** Purpose: render the DB-first alliance retrospective without owning any state. */
export function buildSyncRetrospectiveEmbeds(result: SyncRetrospectiveResult): EmbedBuilder[] {
  const clans = [...result.clans].sort((left, right) => {
    const leftWarRank = left.identity.warId === null ? 1 : 0;
    const rightWarRank = right.identity.warId === null ? 1 : 0;
    if (leftWarRank !== rightWarRank) return leftWarRank - rightWarRank;
    const leftName = left.identity.clanName ?? left.identity.clanTag;
    const rightName = right.identity.clanName ?? right.identity.clanTag;
    return leftName.localeCompare(rightName, undefined, { sensitivity: "base" }) ||
      left.identity.clanTag.localeCompare(right.identity.clanTag);
  });
  const clanChunks = chunkLines(clans.map(formatClanLine), FIELD_VALUE_LIMIT);
  const embeds: EmbedBuilder[] = [];
  const metricFields = buildMetricFields(result);
  const title = `Sync #${result.identity.syncNumber} Retrospective`;
  const firstChunkCount = Math.min(FIRST_EMBED_CLAN_FIELD_LIMIT, clanChunks.length);
  const firstEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(title)
    .setDescription(buildSyncDescription(result))
    .addFields(metricFields);
  if (firstChunkCount > 0) {
    firstEmbed.addFields(buildClanFields(clanChunks.slice(0, firstChunkCount), 0));
  } else {
    firstEmbed.addFields({ name: "Clans", value: "No clan rows available.", inline: false });
  }
  embeds.push(firstEmbed);

  for (let offset = firstChunkCount; offset < clanChunks.length; offset += FOLLOWING_EMBED_CLAN_FIELD_LIMIT) {
    const pageChunks = clanChunks.slice(offset, offset + FOLLOWING_EMBED_CLAN_FIELD_LIMIT);
    embeds.push(
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${title} — continued`)
        .addFields(buildClanFields(pageChunks, offset)),
    );
  }

  return embeds;
}
