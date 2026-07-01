import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
} from "discord.js";
import { normalizeTownHallLevel, type TownHallEmojiMap } from "../../helper/townHallEmoji";
import {
  type WarPlanViolationHistoryAllianceOverview,
  type WarPlanViolationHistoryAttackEvidenceAttack,
  type WarPlanViolationHistoryAttackEvidenceBreachContext,
  type WarPlanViolationHistoryClanLeaderboardResult,
  type WarPlanViolationHistoryDiscordUserAggregateResult,
  type WarPlanViolationHistoryPeriod,
  type WarPlanViolationHistoryPlayerHistoryEntry,
  type WarPlanViolationHistoryPlayerHistoryResult,
} from "../../services/WarPlanViolationHistoryService";

export type WarPlanViolationsTownHallIconSource =
  | TownHallEmojiMap
  | ReadonlyMap<number, string>
  | Record<number, string | undefined>
  | ((townHallLevel: number) => string | null | undefined)
  | null
  | undefined;

type EmbedField = {
  name: string;
  value: string;
  inline: false;
};

type EmbedBudget = {
  usedChars: number;
  fieldCount: number;
};

type PlannedFieldChunk = {
  value: string;
  rowCount: number;
};

const DISCORD_EMBED_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  total: 6000,
  fields: 25,
};

const HISTORY_PAGE_FOOTER_PREFIX = "Page";
const TOP_VIOLATOR_SECTION_LIMIT = 10;

/** Purpose: normalize display text without leaking surrounding whitespace into embeds. */
function normalizeDisplayText(input: string | null | undefined): string | null {
  const normalized = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/** Purpose: turn empty normalized text into a safe fallback value. */
function displayOrFallback(input: string | null | undefined, fallback: string): string {
  return normalizeDisplayText(input) ?? fallback;
}

/** Purpose: truncate one string deterministically while preserving a visible suffix. */
function truncateText(input: string, maxLength: number): string {
  const text = String(input ?? "");
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

/** Purpose: join cleaned lines without introducing blank rows. */
function joinLines(lines: Array<string | null | undefined>): string {
  return lines.map((line) => normalizeDisplayText(line)).filter(Boolean).join("\n");
}

/** Purpose: preserve embedded newlines while trimming only the outer edge. */
function normalizeFieldValueText(input: string | null | undefined): string {
  return String(input ?? "").replace(/\r\n/g, "\n").trim();
}

/** Purpose: render one Discord timestamp for a persisted date. */
function formatDiscordTimestamp(value: Date | null | undefined, style: "f" | "R" = "f"): string | null {
  if (!(value instanceof Date)) return null;
  return `<t:${Math.floor(value.getTime() / 1000)}:${style}>`;
}

/** Purpose: return a deterministic Discord mention or an unlinked marker. */
function formatDiscordUserDisplay(discordUserId: string | null | undefined): string {
  const normalized = normalizeDisplayText(discordUserId);
  return normalized ? `<@${normalized}>` : "—";
}

/** Purpose: keep displayed counts non-negative and integer-shaped. */
function normalizeDisplayCount(input: number | null | undefined): number {
  const value = Number(input ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** Purpose: render one Town Hall icon with a readable fallback when no application emoji exists. */
function resolveTownHallIcon(
  townHallLevel: number | null | undefined,
  source?: WarPlanViolationsTownHallIconSource,
): string {
  const normalized = normalizeTownHallLevel(townHallLevel);
  if (normalized === null) return "❔";

  if (typeof source === "function") {
    const resolved = normalizeDisplayText(source(normalized));
    return resolved ?? `TH${normalized}`;
  }

  if (source instanceof Map) {
    return normalizeDisplayText(source.get(normalized)) ?? `TH${normalized}`;
  }

  if (source && typeof source === "object") {
    const record = source as Record<number | string, string | undefined>;
    return normalizeDisplayText(record[normalized] ?? record[String(normalized)]) ?? `TH${normalized}`;
  }

  return `TH${normalized}`;
}

/** Purpose: keep a player summary label grammatically correct. */
function formatViolationCountLabel(count: number): string {
  const normalized = normalizeDisplayCount(count);
  return `${normalized} ${normalized === 1 ? "violation" : "violations"}`;
}

/** Purpose: keep the affected/evaluated-war label compact and deterministic. */
function formatAffectedEvaluatedLabel(affectedWarCount: number, evaluatedWarCount: number): string {
  const affected = normalizeDisplayCount(affectedWarCount);
  const evaluated = normalizeDisplayCount(evaluatedWarCount);
  return `${affected} affected / ${evaluated} evaluated wars`;
}

/** Purpose: build the canonical period label shared by all views. */
export function formatWarPlanViolationsPeriodLabel(period: WarPlanViolationHistoryPeriod): string {
  return period === "30d" ? "Last 30 Days" : "Lifetime";
}

/** Purpose: render the shared lifetime-history note in consistent wording. */
function buildLifetimeHistoryNote(period: WarPlanViolationHistoryPeriod): string | null {
  if (period !== "lifetime") return null;
  return "History begins when violation tracking was enabled; no historical backfill.";
}

/** Purpose: build the shared period lines used by every violations embed. */
function buildPeriodLines(input: {
  period: WarPlanViolationHistoryPeriod;
  trackingSince: Date | null;
}): string[] {
  const lines = [`Period: ${formatWarPlanViolationsPeriodLabel(input.period)}`];
  const trackingSince = formatDiscordTimestamp(input.trackingSince, "f");
  if (trackingSince) {
    lines.push(`Tracking since ${trackingSince}`);
  }
  const note = buildLifetimeHistoryNote(input.period);
  if (note) {
    lines.push(note);
  }
  return lines;
}

/** Purpose: map a violation enum into readable user-facing text. */
export function formatWarPlanViolationsViolationTypeLabel(violationType: string): string {
  switch (violationType) {
    case "EARLY_NON_MIRROR_TRIPLE":
      return "Early non-mirror triple";
    case "STRICT_WINDOW_MIRROR_MISS_WIN":
      return "Missed mirror during WIN strict window";
    case "STRICT_WINDOW_MIRROR_MISS_LOSS":
      return "Missed mirror during LOSS strict window";
    case "EARLY_NON_MIRROR_2STAR":
      return "Early non-mirror 2-star";
    case "ANY_3STAR":
      return "3-star plan violation";
    case "LOWER20_ANY_STARS":
      return "Lower-20 attack violation";
    case "OTHER_PLAN_VIOLATION":
      return "Other plan violation";
    default: {
      const readable = normalizeDisplayText(violationType)?.replace(/[_]+/g, " ");
      return readable ? `Unknown plan violation: ${readable}` : "Unknown plan violation";
    }
  }
}

/** Purpose: build one canonical player summary line for every view in this module. */
export function formatWarPlanViolationsPlayerSummaryLine(input: {
  playerTag: string;
  playerName: string | null;
  townHallLevel: number | null;
  discordUserId: string | null;
  violationCount: number;
  townHallIconSource?: WarPlanViolationsTownHallIconSource;
  maxLength?: number;
}): string {
  const maxLength = Math.max(64, Math.trunc(Number(input.maxLength ?? 256)) || 256);
  const icon = resolveTownHallIcon(input.townHallLevel, input.townHallIconSource);
  const playerName = displayOrFallback(input.playerName, displayOrFallback(input.playerTag, "Unknown player"));
  const playerTag = displayOrFallback(input.playerTag, "#?");
  const discordUser = formatDiscordUserDisplay(input.discordUserId);
  const suffix = `\`${playerTag}\` ${discordUser} - ${formatViolationCountLabel(input.violationCount)}`;
  const availableForName = maxLength - icon.length - 1 - suffix.length;
  const renderedName = availableForName > 0 ? truncateText(playerName, availableForName) : "";
  if (!renderedName) {
    return `${icon} ${suffix}`;
  }
  return `${icon} ${renderedName} ${suffix}`;
}

/** Purpose: keep the exported player-summary builder name aligned with the rest of the module. */
export const buildWarPlanViolationsPlayerSummaryLine = formatWarPlanViolationsPlayerSummaryLine;

/** Purpose: build one clan summary line for the alliance overview and tests. */
export function buildWarPlanViolationsClanSummaryLine(input: {
  clanTag: string;
  clanName: string;
  violationCount: number;
  distinctPlayerCount: number;
  affectedWarCount: number;
  evaluatedWarCount: number;
}): string {
  const clanName = displayOrFallback(input.clanName, displayOrFallback(input.clanTag, "Unknown Clan"));
  const clanTag = displayOrFallback(input.clanTag, "#?");
  return (
    `${clanName} \`${clanTag}\` - ${formatViolationCountLabel(input.violationCount)} | ` +
    `${normalizeDisplayCount(input.distinctPlayerCount)} players | ` +
    `${formatAffectedEvaluatedLabel(input.affectedWarCount, input.evaluatedWarCount)}`
  );
}

/** Purpose: render one Town Hall icon/name header for player-history pages. */
function formatPlayerHistoryHeaderLine(input: {
  playerTag: string;
  playerName: string | null;
  townHallLevel: number | null;
  discordUserId: string | null;
  townHallIconSource?: WarPlanViolationsTownHallIconSource;
}): string {
  const icon = resolveTownHallIcon(input.townHallLevel, input.townHallIconSource);
  const playerName = displayOrFallback(input.playerName, displayOrFallback(input.playerTag, "Unknown player"));
  const playerTag = displayOrFallback(input.playerTag, "#?");
  const discordUser = formatDiscordUserDisplay(input.discordUserId);
  const availableForName = 256 - icon.length - 1 - `\`${playerTag}\` ${discordUser}`.length;
  const renderedName = availableForName > 0 ? truncateText(playerName, availableForName) : "";
  return renderedName ? `${icon} ${renderedName} \`${playerTag}\` ${discordUser}` : `${icon} \`${playerTag}\` ${discordUser}`;
}

/** Purpose: build one clean page footer for player-history views. */
function formatHistoryFooter(page: number, totalPages: number): string {
  return `${HISTORY_PAGE_FOOTER_PREFIX} ${page + 1}/${Math.max(1, totalPages)}`;
}

/** Purpose: keep player-history page indexes within bounds. */
function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 0;
  if (pageCount <= 1) return 0;
  return Math.max(0, Math.min(Math.trunc(page), pageCount - 1));
}

/** Purpose: keep embed-sized chunks bounded without splitting a visible line across fields. */
function planFieldChunks(lines: Array<string | null | undefined>): PlannedFieldChunk[] {
  const chunks: PlannedFieldChunk[] = [];
  let current = "";
  let rowCount = 0;

  for (const rawLine of lines) {
    const line = normalizeDisplayText(rawLine);
    if (!line) continue;
    const safeLine = truncateText(line, DISCORD_EMBED_LIMITS.fieldValue);
    const next = current ? `${current}\n${safeLine}` : safeLine;
    if (next.length <= DISCORD_EMBED_LIMITS.fieldValue) {
      current = next;
      rowCount += 1;
      continue;
    }
    if (current) {
      chunks.push({ value: current, rowCount });
    }
    current = safeLine;
    rowCount = 1;
  }

  if (current) {
    chunks.push({ value: current, rowCount });
  }

  return chunks;
}

/** Purpose: append a field while respecting the overall Discord embed budget. */
function appendField(
  fields: EmbedField[],
  budget: EmbedBudget,
  name: string,
  value: string,
): boolean {
  const safeName = truncateText(normalizeDisplayText(name) ?? "Summary", DISCORD_EMBED_LIMITS.fieldName);
  const safeValue = truncateText(normalizeFieldValueText(value), DISCORD_EMBED_LIMITS.fieldValue);
  if (!safeValue) return false;
  const nextChars = safeName.length + safeValue.length;
  if (budget.fieldCount >= DISCORD_EMBED_LIMITS.fields) return false;
  if (budget.usedChars + nextChars > DISCORD_EMBED_LIMITS.total) return false;
  fields.push({
    name: safeName,
    value: safeValue,
    inline: false,
  });
  budget.usedChars += nextChars;
  budget.fieldCount += 1;
  return true;
}

/** Purpose: append a summary field from a list of lines. */
function appendSummaryField(
  fields: EmbedField[],
  budget: EmbedBudget,
  name: string,
  lines: Array<string | null | undefined>,
): boolean {
  return appendField(fields, budget, name, joinLines(lines));
}

/** Purpose: append chunked lines while preserving visible ordering and a hidden-item marker. */
function appendChunkedSection(
  fields: EmbedField[],
  budget: EmbedBudget,
  name: string,
  lines: Array<string | null | undefined>,
): void {
  const visibleLines = lines.map((line) => normalizeDisplayText(line)).filter(Boolean) as string[];
  if (visibleLines.length === 0) return;

  const chunks = planFieldChunks(visibleLines);
  let shownRows = 0;
  let shownChunks = 0;

  for (const chunk of chunks) {
    const fieldName =
      chunks.length > 1 ? `${name} (${shownChunks + 1}/${chunks.length})` : name;
    const added = appendField(fields, budget, fieldName, chunk.value);
    if (!added) break;
    shownRows += chunk.rowCount;
    shownChunks += 1;
  }

  const hiddenRows = Math.max(0, visibleLines.length - shownRows);
  if (hiddenRows <= 0) return;

  const marker = `+${hiddenRows} more`;
  if (fields.length > 0) {
    const last = fields[fields.length - 1];
    const extra = `\n${marker}`;
    if (
      last.value.length + extra.length <= DISCORD_EMBED_LIMITS.fieldValue &&
      budget.usedChars + extra.length <= DISCORD_EMBED_LIMITS.total
    ) {
      last.value = `${last.value}${extra}`;
      budget.usedChars += extra.length;
      return;
    }
  }

  appendField(fields, budget, "More", marker);
}

/** Purpose: build a deterministic embed shell and budget tracker for this module. */
function createEmbedShell(input: {
  title: string;
  descriptionLines?: Array<string | null | undefined>;
  footer?: string | null;
}): { embed: EmbedBuilder; fields: EmbedField[]; budget: EmbedBudget } {
  const embed = new EmbedBuilder();
  const title = truncateText(normalizeDisplayText(input.title) ?? "War Plan Violations", DISCORD_EMBED_LIMITS.title);
  embed.setTitle(title);

  const description = truncateText(joinLines(input.descriptionLines ?? []), DISCORD_EMBED_LIMITS.description);
  if (description) {
    embed.setDescription(description);
  }

  const footer = normalizeDisplayText(input.footer);
  if (footer) {
    embed.setFooter({ text: truncateText(footer, DISCORD_EMBED_LIMITS.footer) });
  }

  const usedChars = title.length + description.length + (footer?.length ?? 0);
  return {
    embed,
    fields: [],
    budget: {
      usedChars,
      fieldCount: 0,
    },
  };
}

/** Purpose: expose embed JSON for tests without coupling to builder internals. */
export function toEmbedJson(embed: EmbedBuilder): APIEmbed {
  return embed.toJSON();
}

/** Purpose: build the alliance overview view as one deterministic embed. */
export function buildWarPlanViolationsAllianceOverviewEmbed(input: {
  result: WarPlanViolationHistoryAllianceOverview;
  townHallIconSource?: WarPlanViolationsTownHallIconSource;
}): EmbedBuilder {
  const { embed, fields, budget } = createEmbedShell({
    title: `War Plan Violations — ${formatWarPlanViolationsPeriodLabel(input.result.period)}`,
    descriptionLines: buildPeriodLines({
      period: input.result.period,
      trackingSince: input.result.trackingSince,
    }),
  });

  appendSummaryField(fields, budget, "Summary", [
    `Violations: ${normalizeDisplayCount(input.result.violationCount)}`,
    `Player accounts: ${normalizeDisplayCount(input.result.distinctPlayerCount)}`,
    `Linked Discord users: ${normalizeDisplayCount(input.result.distinctCurrentDiscordUserCount)}`,
    `Affected wars: ${formatAffectedEvaluatedLabel(input.result.affectedWarCount, input.result.evaluatedWarCount)}`,
    `Affected clans: ${normalizeDisplayCount(input.result.distinctClanCount)}`,
  ]);

  if (!input.result.hasCompletedEvaluations) {
    appendSummaryField(fields, budget, "By Clan", ["No completed evaluations in this period."]);
    appendSummaryField(fields, budget, "Top Violators", ["No completed evaluations in this period."]);
  } else {
    const clanLines = input.result.clanSummaries.map((row) =>
      buildWarPlanViolationsClanSummaryLine({
        clanTag: row.clanTag,
        clanName: row.clanName,
        violationCount: row.violationCount,
        distinctPlayerCount: row.distinctPlayerCount,
        affectedWarCount: row.affectedWarCount,
        evaluatedWarCount: row.evaluatedWarCount,
      }),
    );
    if (clanLines.length > 0) {
      appendChunkedSection(fields, budget, "By Clan", clanLines);
    } else {
      appendSummaryField(fields, budget, "By Clan", ["No clans had violations in this period."]);
    }

    const visibleTopPlayers = input.result.topPlayers.slice(0, TOP_VIOLATOR_SECTION_LIMIT);
    const topPlayerLines = visibleTopPlayers.map((row) =>
      formatWarPlanViolationsPlayerSummaryLine({
        playerTag: row.playerTag,
        playerName: row.playerName,
        townHallLevel: row.townHallLevel,
        discordUserId: row.discordUserId,
        violationCount: row.violationCount,
        townHallIconSource: input.townHallIconSource,
        maxLength: 220,
      }),
    );
    if (topPlayerLines.length > 0) {
      appendChunkedSection(fields, budget, "Top Violators", topPlayerLines);
      if (input.result.topPlayers.length > visibleTopPlayers.length) {
        appendField(
          fields,
          budget,
          "More",
          `+${input.result.topPlayers.length - visibleTopPlayers.length} more`,
        );
      }
    } else {
      appendSummaryField(fields, budget, "Top Violators", ["No violating players in this period."]);
    }
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }
  return embed;
}

/** Purpose: build the clan leaderboard view while keeping not-found and zero-state renders stable. */
export function buildWarPlanViolationsClanLeaderboardEmbed(input: {
  result: WarPlanViolationHistoryClanLeaderboardResult;
  townHallIconSource?: WarPlanViolationsTownHallIconSource;
}): EmbedBuilder {
  const clanLabel =
    normalizeDisplayText(input.result.clanName) ?? displayOrFallback(input.result.clanTag, "Unknown Clan");
  const { embed, fields, budget } = createEmbedShell({
    title: `War Plan Violations — ${clanLabel}`,
    descriptionLines: buildPeriodLines({
      period: input.result.period,
      trackingSince: input.result.trackingSince,
    }),
  });

  if (input.result.outcome === "not_found") {
    appendSummaryField(fields, budget, "Summary", [
      `Clan tag: ${input.result.clanTag}`,
      "No completed evaluation history exists for this clan in this guild.",
    ]);
    if (fields.length > 0) {
      embed.addFields(fields);
    }
    return embed;
  }

  appendSummaryField(fields, budget, "Summary", [
    `Clan tag: ${input.result.clanTag}`,
    `Period: ${formatWarPlanViolationsPeriodLabel(input.result.period)}`,
    `Violations: ${normalizeDisplayCount(input.result.violationCount)}`,
    `Player accounts: ${normalizeDisplayCount(input.result.distinctPlayerCount)}`,
    `Affected wars: ${formatAffectedEvaluatedLabel(input.result.affectedWarCount, input.result.evaluatedWarCount)}`,
    input.result.hasCompletedEvaluations
      ? null
      : "Completed tracking exists, but no violations were recorded in the selected period.",
  ]);

  if (input.result.players.length === 0) {
    appendSummaryField(fields, budget, "Players", [
      input.result.hasCompletedEvaluations
        ? "No violations were recorded in the selected period."
        : "No completed evaluations were found for this clan in the selected period.",
    ]);
  } else {
    const playerLines = input.result.players.map((row) =>
      formatWarPlanViolationsPlayerSummaryLine({
        playerTag: row.playerTag,
        playerName: row.playerName,
        townHallLevel: row.townHallLevel,
        discordUserId: row.discordUserId,
        violationCount: row.violationCount,
        townHallIconSource: input.townHallIconSource,
        maxLength: 220,
      }),
    );
    appendChunkedSection(fields, budget, "Players", playerLines);
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }
  return embed;
}

/** Purpose: build the Discord-user aggregate view without live identity lookups. */
export function buildWarPlanViolationsDiscordUserAggregateEmbed(input: {
  result: WarPlanViolationHistoryDiscordUserAggregateResult;
  townHallIconSource?: WarPlanViolationsTownHallIconSource;
}): EmbedBuilder {
  const { embed, fields, budget } = createEmbedShell({
    title: "War Plan Violations — Discord User",
    descriptionLines:
      input.result.outcome === "success"
        ? [
            `User: ${formatDiscordUserDisplay(input.result.discordUserId)}`,
            ...buildPeriodLines({
              period: input.result.period,
              trackingSince: input.result.trackingSince,
            }),
            input.result.clanTag
              ? `Historical clan filter: ${input.result.clanTag}`
              : "Historical clan filter: All clans",
          ]
        : [
            `Discord user: ${formatDiscordUserDisplay(input.result.discordUserId)}`,
            `Period: ${formatWarPlanViolationsPeriodLabel(input.result.period)}`,
          ],
  });

  if (input.result.outcome !== "success") {
    const reason =
      input.result.outcome === "invalid_user"
        ? "Invalid Discord user ID."
        : input.result.outcome === "invalid_clan"
          ? "Invalid clan tag."
          : "No current linked accounts were found for this Discord user.";
    appendSummaryField(fields, budget, "Summary", [reason]);
    if (fields.length > 0) {
      embed.addFields(fields);
    }
    return embed;
  }

  appendSummaryField(fields, budget, "Summary", [
    `Current linked accounts: ${normalizeDisplayCount(input.result.currentLinkedAccountCount)}`,
    `Violating accounts: ${normalizeDisplayCount(input.result.violatingAccountCount)}`,
    `Violations: ${normalizeDisplayCount(input.result.violationCount)}`,
    `Affected wars: ${formatAffectedEvaluatedLabel(input.result.affectedWarCount, input.result.affectedWarCount)}`,
    input.result.clanTag
      ? `Historical clan filter: ${input.result.clanTag}`
      : "Historical clan filter: All clans",
    input.result.hasViolationsInPeriod
      ? "Violations exist for at least one current linked account."
      : "Current linked accounts exist, but none have violations in this period.",
  ]);

  if (input.result.accounts.length === 0) {
    appendSummaryField(fields, budget, "Accounts", ["No current linked accounts to show."]);
  } else {
    const accountLines = input.result.accounts.map((row) =>
      formatWarPlanViolationsPlayerSummaryLine({
        playerTag: row.playerTag,
        playerName: row.playerName,
        townHallLevel: row.townHallLevel,
        discordUserId: row.discordUserId,
        violationCount: row.violationCount,
        townHallIconSource: input.townHallIconSource,
        maxLength: 220,
      }),
    );
    appendChunkedSection(fields, budget, "Accounts", accountLines);
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }
  return embed;
}

/** Purpose: render one attack line for player-history evidence blocks. */
function formatAttackEvidenceAttackLine(
  attack: WarPlanViolationHistoryAttackEvidenceAttack,
  index: number,
): string {
  const orderRaw = Number(attack.attackOrder);
  const order = Number.isFinite(orderRaw) && orderRaw > 0 ? Math.trunc(orderRaw) : index + 1;
  const defenderPositionRaw = Number(attack.defenderPosition);
  const defenderPosition =
    Number.isFinite(defenderPositionRaw) && defenderPositionRaw > 0
      ? `#${Math.trunc(defenderPositionRaw)}`
      : "#?";
  const starsRaw = Number(attack.stars);
  const starsLabel = Number.isFinite(starsRaw) ? `${Math.max(0, Math.trunc(starsRaw))} stars` : "? stars";
  return `Attack ${order}: ${defenderPosition} - ${starsLabel}${attack.isBreach ? " (breach)" : ""}`;
}

/** Purpose: render the structured breach context line for player-history evidence. */
function formatBreachContextLine(
  breachContext: WarPlanViolationHistoryAttackEvidenceBreachContext | null,
): string | null {
  if (!breachContext) return null;
  const starsRaw = Number(breachContext.starsAtBreach);
  const stars =
    Number.isFinite(starsRaw) ? `${Math.max(0, Math.trunc(starsRaw))} stars at breach` : null;
  const timeRemaining = normalizeDisplayText(breachContext.timeRemaining);
  if (stars && timeRemaining) {
    return `${stars} | ${timeRemaining}`;
  }
  if (stars) {
    return stars;
  }
  if (timeRemaining) {
    return timeRemaining;
  }
  return "—";
}

/** Purpose: render the attack-evidence block for one player-history entry. */
function formatAttackEvidence(entry: WarPlanViolationHistoryPlayerHistoryEntry): string[] {
  const lines = entry.attackEvidence.attacks.map((attack, index) =>
    formatAttackEvidenceAttackLine(attack, index),
  );
  const breachContext = formatBreachContextLine(entry.attackEvidence.breachContext);
  if (breachContext) {
    lines.push(`Breach context: ${breachContext}`);
  }
  if (lines.length === 0) {
    lines.push("No attack evidence recorded.");
  }
  return lines;
}

/** Purpose: render the core detail block for one player-history entry. */
function formatPlayerHistoryViolationSummaryLines(entry: WarPlanViolationHistoryPlayerHistoryEntry): string[] {
  return [
    `Clan: ${displayOrFallback(entry.clanName, displayOrFallback(entry.clanTag, "Unknown Clan"))} \`${displayOrFallback(entry.clanTag, "#?")}\``,
    `Opponent: ${displayOrFallback(entry.opponentName, displayOrFallback(entry.opponentTag, "Unknown"))} \`${displayOrFallback(entry.opponentTag, "#?")}\``,
    `War ID: ${entry.warId}`,
    `War date: ${formatDiscordTimestamp(entry.warEndTime ?? entry.warStartTime, "f") ?? "unknown"}`,
    `Expected outcome: ${displayOrFallback(entry.expectedOutcome, "UNKNOWN")}`,
    `Lose style: ${displayOrFallback(entry.loseStyle, "UNKNOWN")}`,
    `Violation type: ${formatWarPlanViolationsViolationTypeLabel(entry.violationType)}`,
    entry.reasonLabel ? `Reason: ${entry.reasonLabel}` : null,
    entry.playerPosition !== null ? `Player position: #${Math.trunc(entry.playerPosition)}` : null,
  ].filter((line): line is string => Boolean(line));
}

/** Purpose: render the behavior block for one player-history entry. */
function formatPlayerHistoryBehaviorLines(entry: WarPlanViolationHistoryPlayerHistoryEntry): string[] {
  return [
    `Expected: ${entry.expectedBehavior || "—"}`,
    `Actual: ${entry.actualBehavior || "—"}`,
    entry.breachStarsAt !== null ? `Breach stars at: ${Math.trunc(entry.breachStarsAt)}` : null,
    entry.breachTimeRemaining ? `Breach time remaining: ${entry.breachTimeRemaining}` : null,
  ].filter((line): line is string => Boolean(line));
}

/** Purpose: build the player-history embed while preserving service ordering and page bounds. */
export function buildWarPlanViolationsPlayerHistoryEmbed(input: {
  result: WarPlanViolationHistoryPlayerHistoryResult;
  page?: number;
  townHallIconSource?: WarPlanViolationsTownHallIconSource;
}): EmbedBuilder {
  const title = "War Plan Violations — Player History";

  if (input.result.outcome !== "success") {
    const { embed, fields, budget } = createEmbedShell({
      title,
      descriptionLines:
        input.result.outcome === "invalid_tag"
          ? ["Invalid player tag.", "No valid Clash tag was provided."]
          : [
              `Player tag: ${input.result.playerTag}`,
              "No recorded player-history violations were found for this guild.",
            ],
    });
    appendSummaryField(fields, budget, "Summary", ["This player history could not be displayed."]);
    if (fields.length > 0) {
      embed.addFields(fields);
    }
    return embed;
  }

  const totalPages = Math.max(1, input.result.entries.length);
  const page = clampPage(input.page ?? 0, totalPages);
  const currentEntry = input.result.entries[page] ?? null;
  const { embed, fields, budget } = createEmbedShell({
    title,
    descriptionLines: [
      formatPlayerHistoryHeaderLine({
        playerTag: input.result.playerTag,
        playerName: input.result.playerName,
        townHallLevel: input.result.townHallLevel,
        discordUserId: input.result.discordUserId,
        townHallIconSource: input.townHallIconSource,
      }),
      ...buildPeriodLines({
        period: input.result.period,
        trackingSince: input.result.trackingSince,
      }),
      `Total violations: ${normalizeDisplayCount(input.result.violationCount)}`,
      `Affected wars: ${normalizeDisplayCount(input.result.affectedWarCount)}`,
    ],
    footer: formatHistoryFooter(page, totalPages),
  });

  if (currentEntry) {
    appendSummaryField(fields, budget, `Violation ${page + 1}/${totalPages}`, formatPlayerHistoryViolationSummaryLines(currentEntry));
    appendSummaryField(fields, budget, "Behavior", formatPlayerHistoryBehaviorLines(currentEntry));
    appendChunkedSection(fields, budget, "Attack Evidence", formatAttackEvidence(currentEntry));
  } else {
    appendSummaryField(fields, budget, "Summary", [
      "No violations were recorded in the selected period.",
    ]);
  }

  if (fields.length > 0) {
    embed.addFields(fields);
  }
  return embed;
}

/** Purpose: build the player-history navigation row while keeping disabled-state behavior deterministic. */
export function buildWarPlanViolationsPlayerHistoryPaginationRow(input: {
  previousCustomId: string;
  nextCustomId: string;
  currentPage: number;
  totalPages: number;
  disabled?: boolean;
}): ActionRowBuilder<ButtonBuilder> | null {
  const totalPages = Math.max(0, Math.trunc(Number(input.totalPages)));
  if (totalPages <= 1) return null;
  const page = clampPage(input.currentPage, totalPages);
  const disabled = Boolean(input.disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(input.previousCustomId)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page <= 0),
    new ButtonBuilder()
      .setCustomId(input.nextCustomId)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page >= totalPages - 1),
  );
}
