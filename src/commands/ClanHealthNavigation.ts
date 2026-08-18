import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { normalizeClashTagBareInput } from "../helper/clashTag";
import { splitDiscordLineMessages } from "../helper/discordLineMessageSplit";
import {
  buildClanHealthHistoricalCutoff,
  CLAN_HEALTH_MAX_WINDOW_DAYS,
  CLAN_HEALTH_MIN_WINDOW_DAYS,
} from "../services/ClanHealthSnapshotService";
import {
  ClanHealthHistoricalWindowService,
  CLAN_HEALTH_DEFAULT_SYNC_COUNT,
  type ClanHealthHistoricalWindow,
} from "../services/ClanHealthHistoricalWindowService";
import { ClanWarHistoryService } from "../services/ClanWarHistoryService";
import { runInactiveClanHealthDetail } from "./Inactive";
import { buildUnlinkedListLines } from "./Unlinked";
import { buildCompoAdviceResponsePayload } from "./Compo";
import { buildFwaViolationsClanDetailPayload } from "./fwa/violationsCommand";
import { buildWarHistoryField } from "./War";
import { CompoAdviceService } from "../services/CompoAdviceService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import { unlinkedMemberAlertService } from "../services/UnlinkedMemberAlertService";
import {
  ClanHealthTrendService,
  type ClanHealthTrendReport,
} from "../services/ClanHealthTrendService";

const CLAN_HEALTH_NAVIGATION_PREFIX = "clan-health";
const CLAN_HEALTH_WAR_HISTORY_ACTION = "war-history" as const;
const CLAN_HEALTH_TRENDS_ACTION = "trends" as const;
const CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT = 10;

export const CLAN_HEALTH_NAVIGATION_ACTIONS = [
  "inactive",
  "unlinked",
  "compo",
  "violations",
] as const;

export type ClanHealthNavigationAction = (typeof CLAN_HEALTH_NAVIGATION_ACTIONS)[number];

const CLAN_HEALTH_NAVIGATION_LABELS: Record<ClanHealthNavigationAction, string> = {
  inactive: "View Inactive",
  unlinked: "View Unlinked",
  compo: "View Compo",
  violations: "View Violations",
};

const CLAN_HEALTH_NAVIGATION_PERMISSION_TARGETS: Record<
  ClanHealthNavigationAction,
  readonly string[]
> = {
  inactive: ["inactive"],
  unlinked: ["unlinked:list", "unlinked"],
  compo: ["compo:advice"],
  violations: ["fwa:violations"],
};

const SAFE_CLAN_TAG_BODY = /^[A-Z0-9]{1,15}$/;

export type ClanHealthNavigationWindow =
  | { kind: "days"; days: number }
  | { kind: "syncs"; syncCount: typeof CLAN_HEALTH_DEFAULT_SYNC_COUNT };

export type ClanHealthNavigationPayload =
  | { action: ClanHealthNavigationAction; clanTag: string }
  | {
      action: typeof CLAN_HEALTH_WAR_HISTORY_ACTION | typeof CLAN_HEALTH_TRENDS_ACTION;
      clanTag: string;
      window: ClanHealthNavigationWindow;
    };

/** Purpose: normalize a tag for a component ID while keeping the ID alphabet-safe and bounded. */
function normalizeNavigationClanTag(input: string): string {
  const normalized = normalizeClashTagBareInput(input);
  return SAFE_CLAN_TAG_BODY.test(normalized) ? normalized : "";
}

/** Purpose: build a deterministic, compact Clan Health navigation custom ID. */
export function buildClanHealthNavigationCustomId(
  action: ClanHealthNavigationAction,
  clanTag: string,
): string {
  if (!CLAN_HEALTH_NAVIGATION_ACTIONS.includes(action)) {
    throw new Error("Unsupported Clan Health navigation action.");
  }
  const normalizedClanTag = normalizeNavigationClanTag(clanTag);
  if (!normalizedClanTag) {
    throw new Error("Invalid Clan Health navigation clan tag.");
  }
  return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${action}:${normalizedClanTag}`;
}

/** Purpose: validate the bounded historical window embedded in a navigation ID. */
function validateClanHealthNavigationWindow(historicalWindowDays: number): void {
  if (
    !Number.isInteger(historicalWindowDays) ||
    historicalWindowDays < CLAN_HEALTH_MIN_WINDOW_DAYS ||
    historicalWindowDays > CLAN_HEALTH_MAX_WINDOW_DAYS
  ) {
    throw new Error("Invalid Clan Health historical window.");
  }
}

/** Purpose: build a restart-safe bounded historical window ID for a Clan Health action. */
function buildClanHealthWindowedNavigationCustomId(
  action: typeof CLAN_HEALTH_WAR_HISTORY_ACTION | typeof CLAN_HEALTH_TRENDS_ACTION,
  clanTag: string,
  window: ClanHealthNavigationWindow,
): string {
  const normalizedClanTag = normalizeNavigationClanTag(clanTag);
  if (!normalizedClanTag) {
    throw new Error("Invalid Clan Health navigation clan tag.");
  }
  if (window.kind === "syncs") {
    if (window.syncCount !== CLAN_HEALTH_DEFAULT_SYNC_COUNT) {
      throw new Error("Invalid Clan Health sync window.");
    }
    return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${action}:${normalizedClanTag}:s${window.syncCount}`;
  }
  validateClanHealthNavigationWindow(window.days);
  return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${action}:${normalizedClanTag}:${window.days}`;
}

/** Purpose: build the existing restart-safe War History custom ID without changing its public format. */
export function buildClanHealthWarHistoryNavigationCustomId(
  clanTag: string,
  historicalWindowDays: number,
): string {
  return buildClanHealthWindowedNavigationCustomId(
    CLAN_HEALTH_WAR_HISTORY_ACTION,
    clanTag,
    { kind: "days", days: historicalWindowDays },
  );
}

/** Purpose: build the restart-safe bounded Trends custom ID for tracked Clan Health. */
export function buildClanHealthTrendsNavigationCustomId(
  clanTag: string,
  historicalWindowDays: number,
): string {
  return buildClanHealthWindowedNavigationCustomId(
    CLAN_HEALTH_TRENDS_ACTION,
    clanTag,
    { kind: "days", days: historicalWindowDays },
  );
}

/** Purpose: build a navigation ID for either explicit days or the canonical default sync window. */
function buildClanHealthWindowedNavigationCustomIdForWindow(
  action: typeof CLAN_HEALTH_WAR_HISTORY_ACTION | typeof CLAN_HEALTH_TRENDS_ACTION,
  clanTag: string,
  window: ClanHealthNavigationWindow,
): string {
  return buildClanHealthWindowedNavigationCustomId(action, clanTag, window);
}

/** Purpose: parse and validate a Clan Health navigation custom ID without trusting user input. */
export function parseClanHealthNavigationCustomId(
  customId: string,
): ClanHealthNavigationPayload | null {
  const parts = String(customId ?? "").split(":");
  if (parts[0] !== CLAN_HEALTH_NAVIGATION_PREFIX) return null;
  if (
    parts.length === 4 &&
    (parts[1] === CLAN_HEALTH_WAR_HISTORY_ACTION || parts[1] === CLAN_HEALTH_TRENDS_ACTION)
  ) {
    const clanTag = normalizeNavigationClanTag(parts[2]);
    const rawWindow = parts[3];
    if (/^s\d+$/.test(rawWindow)) {
      if (!clanTag || parts[2] !== clanTag || rawWindow !== `s${CLAN_HEALTH_DEFAULT_SYNC_COUNT}`) {
        return null;
      }
      return {
        action: parts[1],
        clanTag,
        window: { kind: "syncs", syncCount: CLAN_HEALTH_DEFAULT_SYNC_COUNT },
      };
    }
    const historicalWindowDays = Number(rawWindow);
    if (
      !clanTag ||
      parts[2] !== clanTag ||
      !/^\d+$/.test(parts[3]) ||
      !Number.isInteger(historicalWindowDays) ||
      historicalWindowDays < CLAN_HEALTH_MIN_WINDOW_DAYS ||
      historicalWindowDays > CLAN_HEALTH_MAX_WINDOW_DAYS
    ) {
      return null;
    }
    return { action: parts[1], clanTag, window: { kind: "days", days: historicalWindowDays } };
  }
  if (parts.length !== 3) return null;
  const action = parts[1] as ClanHealthNavigationAction;
  if (!CLAN_HEALTH_NAVIGATION_ACTIONS.includes(action)) return null;
  const clanTag = normalizeNavigationClanTag(parts[2]);
  if (!clanTag || parts[2] !== clanTag) return null;
  return { action, clanTag };
}

/** Purpose: identify both valid and malformed Clan Health navigation IDs for safe centralized routing. */
export function isClanHealthNavigationButtonCustomId(customId: string): boolean {
  return String(customId ?? "").startsWith(`${CLAN_HEALTH_NAVIGATION_PREFIX}:`);
}

/** Purpose: render the single tracked-clan navigation row while respecting Discord component limits. */
export function buildClanHealthNavigationRow(
  clanTag: string,
  window: number | ClanHealthNavigationWindow = {
    kind: "syncs",
    syncCount: CLAN_HEALTH_DEFAULT_SYNC_COUNT,
  },
): ActionRowBuilder<ButtonBuilder> {
  const navigationWindow: ClanHealthNavigationWindow = typeof window === "number"
    ? { kind: "days", days: window }
    : window;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...CLAN_HEALTH_NAVIGATION_ACTIONS.map((action) =>
      new ButtonBuilder()
        .setCustomId(buildClanHealthNavigationCustomId(action, clanTag))
        .setLabel(CLAN_HEALTH_NAVIGATION_LABELS[action])
        .setStyle(ButtonStyle.Secondary),
    ),
    new ButtonBuilder()
      .setCustomId(
        buildClanHealthWindowedNavigationCustomIdForWindow(
          CLAN_HEALTH_WAR_HISTORY_ACTION,
          clanTag,
          navigationWindow,
        ),
      )
      .setLabel("War History")
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Purpose: render the second tracked-clan navigation row for the windowed Trends drilldown. */
export function buildClanHealthTrendsNavigationRow(
  clanTag: string,
  window: number | ClanHealthNavigationWindow = {
    kind: "syncs",
    syncCount: CLAN_HEALTH_DEFAULT_SYNC_COUNT,
  },
): ActionRowBuilder<ButtonBuilder> {
  const navigationWindow: ClanHealthNavigationWindow = typeof window === "number"
    ? { kind: "days", days: window }
    : window;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildClanHealthWindowedNavigationCustomIdForWindow(
          CLAN_HEALTH_TRENDS_ACTION,
          clanTag,
          navigationWindow,
        ),
      )
      .setLabel("View Trends")
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Purpose: render persisted sync-boundary trend facts as one compact ephemeral embed. */
export function buildClanHealthTrendsEmbed(
  report: ClanHealthTrendReport,
  historicalWindowLabel = report.window.kind === "syncs"
    ? `Last ${CLAN_HEALTH_DEFAULT_SYNC_COUNT} syncs`
    : `Last ${report.window.days} days`,
): EmbedBuilder {
  const tag = report.clanTag;
  const displayName = report.clanName &&
    report.clanName.replace(/^#/, "").toUpperCase() !== tag.replace(/^#/, "").toUpperCase()
    ? report.clanName
    : null;
  const title = displayName
    ? `Clan Health Trends - ${displayName} (${tag})`
    : `Clan Health Trends - ${tag}`;
  const formatNumber = (value: number | null, digits = 1): string => {
    if (value === null || !Number.isFinite(value)) return "—";
    return Number.isInteger(value) ? String(value) : value.toFixed(digits);
  };
  const formatSigned = (value: number | null): string => {
    if (value === null || !Number.isFinite(value)) return "—";
    if (value === 0) return "0";
    return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
  };
  const formatDate = (date: Date | null): string =>
    date ? `<t:${Math.floor(date.getTime() / 1000)}:d>` : "—";
  const deviation = report.deviation;
  const deviationTrend =
    deviation.change === null || deviation.oldest === null || deviation.latest === null
      ? "Trend: unavailable"
      : deviation.direction === "unchanged"
        ? `${formatNumber(deviation.oldest)} → ${formatNumber(deviation.latest)} • Unchanged`
        : `${formatNumber(deviation.oldest)} → ${formatNumber(deviation.latest)} • ${deviation.direction === "improved" ? "Improved" : "Worsened"} by ${formatNumber(Math.abs(deviation.change))}`;
  const fillerTrend =
    report.fillers.knownCount === 0
      ? "No complete filler captures in this window."
      : `${formatNumber(report.fillers.knownOldest, 0)} → ${formatNumber(report.fillers.knownLatest, 0)}\nAvg known filler count: **${formatNumber(report.fillers.averageKnown)}**`;
  const recentLines = report.displayedSnapshots.map((snapshot) => {
    const syncLabel = snapshot.syncNumber === null ? "Sync —" : `#${snapshot.syncNumber}`;
    const deviationLabel =
      snapshot.projectionComplete && snapshot.deviationScore !== null
        ? formatNumber(snapshot.deviationScore)
        : "—";
    const fillerLabel = snapshot.fillerCaptureComplete
      ? String(snapshot.fillerPlayerTags.length)
      : "—";
    return `${syncLabel} • ${formatDate(snapshot.syncTime)} • ${formatNumber(snapshot.memberCount, 0)}/50 • Dev ${deviationLabel} • Unresolved ${formatNumber(snapshot.unresolvedWeightCount, 0)} • Fillers ${fillerLabel}`;
  });
  const recentPrefix = report.coverage.total > 10
    ? `Showing latest 10 of ${report.coverage.total} captured sync boundaries.\n`
    : "";
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`Persisted sync-boundary readiness history • ${historicalWindowLabel}`)
    .setColor(0x3498db)
    .addFields(
      {
        name: "Coverage",
        value: report.coverage.total === 0
          ? `No sync-boundary readiness snapshots were captured for ${tag} in ${historicalWindowLabel.toLowerCase()}.`
          : `${report.coverage.total} captured sync boundar${report.coverage.total === 1 ? "y" : "ies"} in ${historicalWindowLabel.toLowerCase()}.\nCaptured: ${formatDate(report.coverage.oldestSyncTime)} → ${formatDate(report.coverage.newestSyncTime)}`,
        inline: false,
      },
      {
        name: "Deviation",
        value: `${deviationTrend}\nAvg ${formatNumber(deviation.average)} • Best ${formatNumber(deviation.best)} • Worst ${formatNumber(deviation.worst)}\nCoverage: ${deviation.validCount}/${report.coverage.total} complete snapshots${report.algorithmVersions.length > 1 ? `\n⚠️ Multiple algorithm versions: ${report.algorithmVersions.join(", ")}; scores may not be directly comparable.` : ""}`,
        inline: false,
      },
      {
        name: "Roster at Sync",
        value: `${formatNumber(report.roster.oldest, 0)}/50 → ${formatNumber(report.roster.latest, 0)}/50 • Delta ${formatSigned(report.roster.delta)}\nAvg members: **${formatNumber(report.roster.average)}** • Full 50/50: **${report.roster.fullCount}/${report.coverage.total}** sync snapshots`,
        inline: false,
      },
      {
        name: "Unresolved Weights",
        value: `${formatNumber(report.unresolved.oldest, 0)} → ${formatNumber(report.unresolved.latest, 0)} • Latest ${formatNumber(report.unresolved.latest, 0)}\nAvg: **${formatNumber(report.unresolved.average)}**`,
        inline: false,
      },
      {
        name: "Fillers at Sync",
        value: `${fillerTrend}\nCapture coverage: **${report.fillers.knownCount}/${report.coverage.total}** snapshots`,
        inline: false,
      },
      {
        name: "Recent Syncs",
        value: recentLines.length > 0 ? `${recentPrefix}${recentLines.join("\n")}` : "No captured sync boundaries to display.",
        inline: false,
      },
    )
    .setTimestamp(report.now);
  return embed;
}

/** Purpose: execute one authorized Clan Health drilldown without mutating the originating message. */
export async function handleClanHealthNavigationButtonInteraction(
  interaction: ButtonInteraction,
  permissionService = new CommandPermissionService(),
  historyService = new ClanWarHistoryService(),
  trendService = new ClanHealthTrendService(),
  historicalWindowService = new ClanHealthHistoricalWindowService(),
): Promise<void> {
  const startedAtMs = Date.now();
  const parsed = parseClanHealthNavigationCustomId(interaction.customId);
  const action = parsed?.action ?? "unknown";
  const clanTag = parsed?.clanTag ?? "unknown";
  const outcome = (value: string) => {
    console.info(
      `[clan-health-drilldown] action=${action} guild=${interaction.guildId ?? "DM"} clan=${clanTag} user=${interaction.user.id} outcome=${value} duration_ms=${Date.now() - startedAtMs}`,
    );
  };

  if (!parsed) {
    await interaction.reply({
      ephemeral: true,
      content: "This Clan Health navigation button is invalid or expired.",
    });
    outcome("invalid_id");
    return;
  }
  if (!interaction.guildId || !interaction.inGuild()) {
    await interaction.reply({
      ephemeral: true,
      content: "Clan Health details are only available in a server.",
    });
    outcome("not_in_guild");
    return;
  }

  const permissionTargets =
    parsed.action === CLAN_HEALTH_WAR_HISTORY_ACTION
      ? ["war"]
      : parsed.action === CLAN_HEALTH_TRENDS_ACTION
        ? ["clan-health"]
        : CLAN_HEALTH_NAVIGATION_PERMISSION_TARGETS[parsed.action];
  const allowed = await permissionService.canUseAnyTarget([...permissionTargets], interaction);
  if (!allowed) {
    await interaction.reply({
      ephemeral: true,
      content: "You do not have permission to open this Clan Health detail.",
    });
    outcome("permission_denied");
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    if (parsed.action === "inactive") {
      await runInactiveClanHealthDetail(interaction, { clanTag: `#${parsed.clanTag}` });
    } else if (parsed.action === "unlinked") {
      const entries = await unlinkedMemberAlertService.listPersistedUnlinkedMembers({
        guildId: interaction.guildId,
        clanTag: `#${parsed.clanTag}`,
      });
      const messages = splitDiscordLineMessages({
        lines: buildUnlinkedListLines({
          entries,
          clanTag: `#${parsed.clanTag}`,
        }),
        maxMessages: 3,
      });
      await interaction.editReply(messages[0] ?? `Current unresolved unlinked players in #${parsed.clanTag}:\n- none`);
      for (const message of messages.slice(1)) {
        await interaction.followUp({ ephemeral: true, content: message });
      }
    } else if (parsed.action === "compo") {
      const advice = await new CompoAdviceService().readAdvice({
        guildId: interaction.guildId,
        targetTag: `#${parsed.clanTag}`,
        mode: "actual",
        view: "auto",
      });
      await interaction.editReply(
        await buildCompoAdviceResponsePayload({
          advice,
          client: interaction.client,
        }),
      );
    } else if (parsed.action === "violations") {
      await interaction.editReply(
        await buildFwaViolationsClanDetailPayload({
          guildId: interaction.guildId,
          clanTag: `#${parsed.clanTag}`,
          client: interaction.client,
        }),
      );
    } else if (parsed.action === CLAN_HEALTH_WAR_HISTORY_ACTION) {
      const now = new Date();
      const resolvedWindow: ClanHealthHistoricalWindow = parsed.window.kind === "syncs"
        ? await historicalWindowService.resolveLatestSyncWindow({ guildId: interaction.guildId, now })
        : {
            kind: "days",
            days: parsed.window.days,
            cutoff: buildClanHealthHistoricalCutoff(now, parsed.window.days),
          };
      const rows = resolvedWindow.kind === "syncs"
        ? await historyService.listEndedByClanSyncNumbers({
            clanTag: `#${parsed.clanTag}`,
            syncNumbers: resolvedWindow.syncNumbers,
          })
        : await historyService.listEndedByClanSince({
            clanTag: `#${parsed.clanTag}`,
            cutoff: resolvedWindow.cutoff,
          });
      const displayName = rows[0]?.clanName?.trim() || `#${parsed.clanTag}`;
      const title = rows.length === 0
        ? `War History - ${displayName}`
        : `War History - ${displayName} (#${parsed.clanTag})`;
      const total = rows.length;
      const windowLabel = resolvedWindow.kind === "syncs"
        ? `Last ${resolvedWindow.requestedSyncCount} syncs`
        : `Last ${resolvedWindow.days} days`;
      const description =
        total > CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT
          ? `${windowLabel} • ${total} ended wars\nShowing latest ${CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT} of ${total} ended wars in ${windowLabel.toLowerCase()}.`
          : `${windowLabel} • ${total} ended war${total === 1 ? "" : "s"}.`;
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(0x3498db)
        .setTimestamp(new Date());
      for (const row of rows.slice(0, CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT)) {
        embed.addFields(buildWarHistoryField(row, displayName));
      }
      await interaction.editReply({ embeds: [embed] });
    } else if (parsed.action === CLAN_HEALTH_TRENDS_ACTION) {
      const now = new Date();
      const resolvedWindow: ClanHealthHistoricalWindow = parsed.window.kind === "syncs"
        ? await historicalWindowService.resolveLatestSyncWindow({ guildId: interaction.guildId, now })
        : {
            kind: "days",
            days: parsed.window.days,
            cutoff: buildClanHealthHistoricalCutoff(now, parsed.window.days),
          };
      const report = await trendService.getTrend({
        guildId: interaction.guildId,
        clanTag: `#${parsed.clanTag}`,
        window: resolvedWindow.kind === "syncs"
          ? { kind: "syncs", syncTimes: resolvedWindow.syncTimes }
          : { kind: "days", days: resolvedWindow.days, cutoff: resolvedWindow.cutoff },
        now,
      });
      await interaction.editReply({
        embeds: [buildClanHealthTrendsEmbed(report)],
      });
    }
    outcome("success");
  } catch (error) {
    outcome("failed");
    console.error(
      `[clan-health-drilldown] action=${action} guild=${interaction.guildId ?? "DM"} clan=${clanTag} user=${interaction.user.id} error=${String(error)}`,
    );
    await interaction
      .editReply("Failed to open this Clan Health detail. Please try again.")
      .catch(() => undefined);
  }
}
