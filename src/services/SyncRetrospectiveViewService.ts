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
const MAX_EMBEDS = 10;
export const MAX_MESSAGE_EMBED_CHARS = 6000;
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
  const displayName = escapeClanName(detailText(clan.identity.clanName ?? clan.identity.clanTag, 180));
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

type EmbedJson = ReturnType<EmbedBuilder["toJSON"]>;

function toEmbedJson(embed: EmbedBuilder | EmbedJson): EmbedJson {
  return embed instanceof EmbedBuilder ? embed.toJSON() : embed;
}

/** Purpose: count the exact textual characters Discord charges across one message's embeds. */
export function aggregateEmbedChars(embeds: readonly (EmbedBuilder | EmbedJson)[]): number {
  return embeds.reduce((total, embed) => {
    const data = toEmbedJson(embed);
    return total +
      (data.title?.length ?? 0) +
      (data.description?.length ?? 0) +
      (data.footer?.text.length ?? 0) +
      (data.author?.name.length ?? 0) +
      (data.fields ?? []).reduce((fieldTotal, field) => fieldTotal + field.name.length + field.value.length, 0);
  }, 0);
}

function embedsRespectDiscordLimits(embeds: readonly EmbedBuilder[]): boolean {
  return embeds.length <= MAX_EMBEDS &&
    aggregateEmbedChars(embeds) <= MAX_MESSAGE_EMBED_CHARS &&
    embeds.every((embed) => {
      const data = embed.toJSON();
      return (data.title?.length ?? 0) <= 256 &&
        (data.description?.length ?? 0) <= 4096 &&
        (data.fields ?? []).length <= MAX_DETAIL_FIELDS &&
        (data.fields ?? []).every((field) => field.name.length <= 256 && field.value.length <= FIELD_VALUE_LIMIT);
    });
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
    value: chunk.join("\n"),
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
function buildLegacySyncRetrospectiveEmbeds(result: SyncRetrospectiveResult): EmbedBuilder[] {
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

/** Purpose: render the alliance retrospective within Discord's shared message budget. */
export function buildSyncRetrospectiveEmbeds(result: SyncRetrospectiveResult): EmbedBuilder[] {
  const clans = sortSyncRetrospectiveClans(result.clans);
  if (clans.length === 0) return buildLegacySyncRetrospectiveEmbeds(result);

  const clanLines = clans.map(formatClanLine);
  const metricFields = buildMetricFields(result);
  const title = `Sync #${result.identity.syncNumber} Retrospective`;
  const description = buildSyncDescription(result);

  for (let visibleCount = clanLines.length; visibleCount >= 0; visibleCount -= 1) {
    const visibleChunks = chunkLines(clanLines.slice(0, visibleCount), FIELD_VALUE_LIMIT);
    const fields = [
      ...metricFields,
      ...(visibleChunks.length > 0
        ? buildClanFields(visibleChunks, 0)
        : [{ name: "Clans", value: "No clan rows available.", inline: false }]),
    ];
    const omittedCount = clanLines.length - visibleCount;
    if (omittedCount > 0) {
      fields.push({
        name: "Clans (continued)",
        value: `\u2026 ${omittedCount} additional clans are available from the dropdowns below.`,
        inline: false,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(title)
      .setDescription(description)
      .addFields(fields);
    if (embedsRespectDiscordLimits([embed])) return [embed];
  }

  return [new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).setDescription(description).addFields(metricFields)];
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

function buildDetailEmbedsForFields(
  fields: DetailField[],
  title: string,
  description: string,
): EmbedBuilder[] {
  const pages: DetailField[][] = [];
  for (let offset = 0; offset < fields.length; offset += MAX_DETAIL_FIELDS) {
    pages.push(fields.slice(offset, offset + MAX_DETAIL_FIELDS));
  }
  if (pages.length === 0) pages.push([]);

  return pages.map((page, index) => {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(index === 0 ? title : `${title} \u2014 continued`)
      .addFields(page);
    if (index === 0) embed.setDescription(description);
    return embed;
  });
}

function buildBoundedDetailEmbeds(
  fields: DetailField[],
  title: string,
  description: string,
  omittedNotice: string,
): EmbedBuilder[] {
  const complete = buildDetailEmbedsForFields(fields, title, description);
  if (embedsRespectDiscordLimits(complete)) return complete;

  for (let retainedCount = fields.length - 1; retainedCount >= 0; retainedCount -= 1) {
    const candidateFields = [
      ...fields.slice(0, retainedCount),
      { name: "Additional detail", value: omittedNotice, inline: false as const },
    ];
    const candidate = buildDetailEmbedsForFields(candidateFields, title, description);
    if (embedsRespectDiscordLimits(candidate)) return candidate;
  }

  return buildDetailEmbedsForFields([
    { name: "Additional detail", value: omittedNotice, inline: false },
  ], title, description);
}

function buildDetailSectionFieldGroups(
  name: string,
  rows: string[],
  detailStartIndex: number,
): { core: DetailField[]; detail: DetailField[] } {
  const coreRows = rows.slice(0, detailStartIndex);
  const detailRows = rows.slice(detailStartIndex);
  const coreFields = buildDetailFields(name, coreRows);
  const detailFields = detailRows.map((row) => ({
    name: `${name} (detail)`,
    value: row,
    inline: false as const,
  }));
  return { core: coreFields, detail: detailFields };
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
  const warRows = buildWarDetailRows(clan);
  const missedAttackRows = buildMissedAttackRows(clan);
  const violationRows = buildBoundedViolationRows(clan);
  const readinessRows = buildReadinessRows(clan);
  const fillerRows = buildFillerRows(clan);
  const missedAttackDetailsStart = clan.identity.warId !== null &&
    clan.missedAttacks.coverageComplete &&
    clan.missedAttacks.total !== null &&
    clan.missedAttacks.total > 0 ? 1 : missedAttackRows.length;
  const violationDetailsStart = clan.identity.warId !== null &&
    (clan.identity.matchType ?? "").toUpperCase() === "FWA" &&
    clan.violations.applicable &&
    clan.violations.evaluationComplete &&
    clan.violations.total !== null &&
    clan.violations.total > 0 ? 1 : violationRows.length;
  const fillerDetailsStart = clan.fillers.fillerCaptureComplete &&
    clan.fillers.fillerCount !== 0 &&
    clan.fillers.fillerPlayerTags.length > 0 ? 1 : fillerRows.length;
  const warFields = buildDetailSectionFieldGroups("War", warRows, warRows.length);
  const missedAttackFields = buildDetailSectionFieldGroups("Missed attacks", missedAttackRows, missedAttackDetailsStart);
  const violationFields = buildDetailSectionFieldGroups("FWA violations", violationRows, violationDetailsStart);
  const readinessFields = buildDetailSectionFieldGroups("Readiness", readinessRows, readinessRows.length);
  const fillerFields = buildDetailSectionFieldGroups("Fillers", fillerRows, fillerDetailsStart);
  const fields = [
    ...warFields.core,
    ...missedAttackFields.core,
    ...violationFields.core,
    ...readinessFields.core,
    ...fillerFields.core,
    ...warFields.detail,
    ...missedAttackFields.detail,
    ...violationFields.detail,
    ...readinessFields.detail,
    ...fillerFields.detail,
  ];
  return buildBoundedDetailEmbeds(
    fields,
    title,
    description,
    "Additional historical detail omitted due to Discord message limits.",
  );
}
