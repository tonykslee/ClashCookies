import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type {
  SyncRetrospectiveClanRow,
  SyncRetrospectiveResult,
} from "./SyncRetrospectiveService";
import { buildSyncRetrospectiveClanSelectCustomId } from "./SyncRetrospectiveInteractionIds";

const EMBED_COLOR = 0x5865f2;
const FIELD_VALUE_LIMIT = 1024;
const FIRST_EMBED_CLAN_FIELD_LIMIT = 3;
const FOLLOWING_EMBED_CLAN_FIELD_LIMIT = 4;
const MAX_SELECT_OPTIONS = 25;
const MAX_SELECT_ROWS = 5;
const MAX_SELECTABLE_CLANS = MAX_SELECT_OPTIONS * MAX_SELECT_ROWS;
const MAX_DETAIL_FIELDS = 25;
const MAX_DETAIL_EMBEDS = 10;
const DETAIL_CHAR_LIMIT = 6000;
const UNKNOWN = "\u2014";

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

/** Purpose: keep alliance rows and drilldown menus on one canonical order. */
export function sortSyncRetrospectiveClans(
  clans: readonly SyncRetrospectiveClanRow[],
): SyncRetrospectiveClanRow[] {
  return [...clans].sort((left, right) => {
    const leftWarRank = left.identity.warId === null ? 1 : 0;
    const rightWarRank = right.identity.warId === null ? 1 : 0;
    if (leftWarRank !== rightWarRank) return leftWarRank - rightWarRank;

    const leftName = left.identity.clanName ?? left.identity.clanTag;
    const rightName = right.identity.clanName ?? right.identity.clanTag;
    return leftName.localeCompare(rightName, undefined, { sensitivity: "base" }) ||
      left.identity.clanTag.localeCompare(right.identity.clanTag);
  });
}

/** Purpose: identify whether a retrospective has any persisted evidence to show. */
export function hasSyncRetrospectiveData(result: SyncRetrospectiveResult): boolean {
  return result.warSummary.clanWarCount > 0 ||
    result.readiness.deviationCoverage.totalSnapshots > 0;
}

/** Purpose: render the DB-first alliance retrospective without owning any state. */
export function buildSyncRetrospectiveEmbeds(result: SyncRetrospectiveResult): EmbedBuilder[] {
  const clans = sortSyncRetrospectiveClans(result.clans);
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

/** Purpose: build bounded, single-selection clan drilldown menus. */
export function buildSyncRetrospectiveComponents(
  result: SyncRetrospectiveResult,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  // Discord permits at most five action rows; keep malformed oversized input deterministic.
  const clans = sortSyncRetrospectiveClans(result.clans).slice(0, MAX_SELECTABLE_CLANS);
  if (clans.length === 0) return [];

  const menuCount = Math.ceil(clans.length / MAX_SELECT_OPTIONS);
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  for (let offset = 0; offset < clans.length; offset += MAX_SELECT_OPTIONS) {
    const menuIndex = offset / MAX_SELECT_OPTIONS;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(buildSyncRetrospectiveClanSelectCustomId(result.identity.syncNumber, menuIndex))
      .setPlaceholder(menuCount === 1
        ? "Select a clan for details"
        : `Select a clan (${menuIndex + 1}/${menuCount})`)
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(clans.slice(offset, offset + MAX_SELECT_OPTIONS).map((clan) => {
        const label = clan.identity.clanName ?? clan.identity.clanTag;
        const option = {
          label: label.slice(0, 100),
          value: clan.identity.clanTag,
        };
        return clan.identity.clanName
          ? { ...option, description: clan.identity.clanTag.slice(0, 100) }
          : option;
      }));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  }
  return rows;
}

function detailText(value: string | null | undefined, maxLength = 220): string {
  const text = String(value ?? "").trim();
  if (!text) return UNKNOWN;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}\u2026`;
}

function detailNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN;
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function detailName(name: string | null | undefined, tag: string | null | undefined): string {
  const display = detailText(name || tag, 180).replace(/[\\`*_~|>]/g, "\\$&");
  const tagText = detailText(tag, 100);
  return name ? `**${display}** \`${tagText}\`` : `\`${tagText}\``;
}

function detailOutcome(value: string | null): string {
  const text = detailText(value);
  if (text === UNKNOWN) return text;
  return text.toLowerCase().replace(/(^|[\\s_-])([a-z])/g, (_match, prefix: string, letter: string) =>
    `${prefix}${letter.toUpperCase()}`,
  );
}

type DetailField = { name: string; value: string; inline: false };

function buildDetailFields(name: string, rows: string[]): DetailField[] {
  const safeRows = rows.length > 0 ? rows : [UNKNOWN];
  if (safeRows.some((row) => row.length > FIELD_VALUE_LIMIT)) {
    throw new Error(`Sync retrospective detail row exceeded ${FIELD_VALUE_LIMIT} characters: ${name}`);
  }
  const chunks = chunkLines(safeRows, FIELD_VALUE_LIMIT);
  return chunks.map((chunk, index) => ({
    name: index === 0 ? name : `${name} (continued)`,
    value: chunk.join("\n"),
    inline: false,
  }));
}

function packDetailFields(
  fields: DetailField[],
  title: string,
  description: string,
): DetailField[][] {
  const pages: DetailField[][] = [];
  let current: DetailField[] = [];
  let currentChars = title.length + description.length;
  for (const field of fields) {
    const fieldChars = field.name.length + field.value.length;
    if (current.length > 0 &&
      (current.length >= MAX_DETAIL_FIELDS || currentChars + fieldChars > DETAIL_CHAR_LIMIT)) {
      pages.push(current);
      current = [];
      currentChars = title.length;
    }
    current.push(field);
    currentChars += fieldChars;
  }
  if (current.length > 0) pages.push(current);
  return pages.slice(0, MAX_DETAIL_EMBEDS);
}

function buildWarDetailRows(clan: SyncRetrospectiveClanRow): string[] {
  if (clan.identity.warId === null) return ["No canonical ended-war record for this clan."];
  const stars = clan.war.stars === null ? UNKNOWN : `${detailNumber(clan.war.stars)}\u2605`;
  return [
    `Stars: ${stars}`,
    `Match: ${detailText(clan.identity.matchType)}`,
    `Expected: ${detailOutcome(clan.identity.expectedOutcome)}`,
    `Actual: ${detailOutcome(clan.identity.actualOutcome)}`,
  ];
}

function buildMissedAttackRows(clan: SyncRetrospectiveClanRow): string[] {
  if (clan.identity.warId === null) return [`Missed attacks: ${UNKNOWN}`];
  if (!clan.missedAttacks.coverageComplete) {
    return ["Historical participation coverage is incomplete.", `Missed attacks: ${UNKNOWN}`];
  }
  if (clan.missedAttacks.total === null) return [`Missed attacks: ${UNKNOWN}`];
  if (clan.missedAttacks.total === 0) return ["Missed attacks: 0", "None."];

  const players = clan.missedAttacks.players
    .filter((player) => player.attacksMissed > 0)
    .sort((left, right) => right.attacksMissed - left.attacksMissed ||
      (left.playerName ?? "").localeCompare(right.playerName ?? "", undefined, { sensitivity: "base" }) ||
      left.playerTag.localeCompare(right.playerTag));
  return [
    `Missed attacks: ${detailNumber(clan.missedAttacks.total)}`,
    ...players.map((player) => {
      const expected = player.attacksUsed + player.attacksMissed;
      return `${detailName(player.playerName, player.playerTag)} — ${detailNumber(player.attacksMissed)} missed · ${detailNumber(player.attacksUsed)}/${detailNumber(expected)} used · ${detailNumber(player.starsEarned)}\u2605`;
    }),
  ];
}

function buildViolationRows(clan: SyncRetrospectiveClanRow): string[] {
  if (clan.identity.warId === null) return [`Violations: ${UNKNOWN}`];
  if ((clan.identity.matchType ?? "").toUpperCase() !== "FWA" || !clan.violations.applicable) {
    return ["Violations: N/A", "Not applicable to this non-FWA war."];
  }
  if (!clan.violations.evaluationComplete) {
    return ["Violations: —", "Historical compliance evaluation is incomplete."];
  }
  if (clan.violations.total === null) return [`Violations: ${UNKNOWN}`];
  if (clan.violations.total === 0) return ["Violations: 0", "None."];
  return [
    `Violations: ${detailNumber(clan.violations.total)}`,
    ...clan.violations.details.map((violation) => [
      detailName(violation.playerName, violation.playerTag),
      `${detailText(violation.violationType)} — ${detailText(violation.reasonLabel)}`,
      `Expected: ${detailText(violation.expectedBehavior)} · Actual: ${detailText(violation.actualBehavior)}`,
    ].join("\n")),
  ];
}

function buildBoundedViolationRows(clan: SyncRetrospectiveClanRow): string[] {
  const isDetailedFwaViolation =
    clan.identity.warId !== null &&
    (clan.identity.matchType ?? "").toUpperCase() === "FWA" &&
    clan.violations.applicable &&
    clan.violations.evaluationComplete &&
    clan.violations.total !== null &&
    clan.violations.total > 0;

  if (!isDetailedFwaViolation) {
    return buildViolationRows(clan);
  }

  const rows = [`Violations: ${detailNumber(clan.violations.total)}`];
  for (const violation of clan.violations.details) {
    rows.push(detailName(violation.playerName, violation.playerTag));
    rows.push(
      `${detailText(violation.violationType, 180)} \u2014 ${detailText(violation.reasonLabel, 240)}`,
    );

    if (violation.expectedBehavior) {
      rows.push(`Expected: ${detailText(violation.expectedBehavior, 240)}`);
    }
    if (violation.actualBehavior) {
      rows.push(`Actual: ${detailText(violation.actualBehavior, 240)}`);
    }
  }

  return rows;
}

function buildReadinessRows(clan: SyncRetrospectiveClanRow): string[] {
  if (!clan.readiness.dataAvailable) return ["Sync-boundary readiness snapshot unavailable."];
  return [
    `Members: ${detailNumber(clan.readiness.memberCount)}`,
    `Deviation: ${clan.readiness.projectionComplete ? detailNumber(clan.readiness.deviationScore) : UNKNOWN}`,
  ];
}

function buildFillerRows(clan: SyncRetrospectiveClanRow): string[] {
  if (!clan.fillers.fillerCaptureComplete) return [`Fillers: ${UNKNOWN}`, "Historical filler capture unavailable."];
  const tags = [...clan.fillers.fillerPlayerTags].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }));
  if (tags.length === 0 || clan.fillers.fillerCount === 0) return ["Fillers: 0", "None captured at this sync."];
  const namesByTag = new Map(clan.missedAttacks.players.map((player) => [player.playerTag.toUpperCase(), player.playerName]));
  return [
    `Fillers: ${detailNumber(clan.fillers.fillerCount ?? tags.length)}`,
    ...tags.map((tag) => detailName(namesByTag.get(tag.toUpperCase()) ?? null, tag)),
  ];
}

/** Purpose: render one persisted clan retrospective without live lookups or state changes. */
export function buildSyncRetrospectiveClanDetailEmbeds(
  result: SyncRetrospectiveResult,
  clan: SyncRetrospectiveClanRow,
): EmbedBuilder[] {
  const displayName = detailText(clan.identity.clanName || clan.identity.clanTag, 180);
  const title = `Sync #${result.identity.syncNumber} \u2022 ${displayName}`;
  const description = `\`${detailText(clan.identity.clanTag, 100)}\``;
  const fields = [
    ...buildDetailFields("War", buildWarDetailRows(clan)),
    ...buildDetailFields("Missed attacks", buildMissedAttackRows(clan)),
    ...buildDetailFields("FWA violations", buildBoundedViolationRows(clan)),
    ...buildDetailFields("Readiness", buildReadinessRows(clan)),
    ...buildDetailFields("Fillers", buildFillerRows(clan)),
  ];
  const pages = packDetailFields(fields, title, description);
  return pages.map((page, index) => {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(index === 0 ? title : `${title} \u2014 continued`)
      .addFields(page);
    if (index === 0) embed.setDescription(description);
    return embed;
  });
}
