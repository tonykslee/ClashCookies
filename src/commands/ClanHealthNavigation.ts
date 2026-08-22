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
import { homeRosterService, type ClanHomeRoster, type HomeRosterMember } from "../services/HomeRosterService";

const CLAN_HEALTH_NAVIGATION_PREFIX = "clan-health";
const CLAN_HEALTH_WAR_HISTORY_ACTION = "war-history" as const;
const CLAN_HEALTH_TRENDS_ACTION = "trends" as const;
const CLAN_HEALTH_HOME_ROSTER_ACTION = "home-roster" as const;
const CLAN_HEALTH_AWAY_ACTION = "away" as const;
const CLAN_HEALTH_TRANSFERS_ACTION = "transfers" as const;
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

export type ClanHealthNavigationPayload =
  | { action: ClanHealthNavigationAction; clanTag: string }
  | {
      action: typeof CLAN_HEALTH_WAR_HISTORY_ACTION | typeof CLAN_HEALTH_TRENDS_ACTION;
      clanTag: string;
      historicalWindow: Exclude<ClanHealthHistoricalWindow, { kind: "unavailable" }>;
      historicalWindowDays?: number;
    }
  | {
      action: ClanHealthHomeNavigationAction;
      clanTag: string;
    };

type ClanHealthHomeNavigationAction =
  | typeof CLAN_HEALTH_HOME_ROSTER_ACTION
  | typeof CLAN_HEALTH_AWAY_ACTION
  | typeof CLAN_HEALTH_TRANSFERS_ACTION;

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
  historicalWindow: ClanHealthHistoricalWindow | number,
): string {
  const normalizedClanTag = normalizeNavigationClanTag(clanTag);
  if (!normalizedClanTag) {
    throw new Error("Invalid Clan Health navigation clan tag.");
  }
  if (typeof historicalWindow === "number") {
    validateClanHealthNavigationWindow(historicalWindow);
    return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${action}:${normalizedClanTag}:${historicalWindow}`;
  }
  if (historicalWindow.kind === "days") {
    validateClanHealthNavigationWindow(historicalWindow.days);
    return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${action}:${normalizedClanTag}:${historicalWindow.days}`;
  }
  return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${action}:${normalizedClanTag}:s30`;
}

/** Purpose: build the existing restart-safe War History custom ID without changing its public format. */
export function buildClanHealthWarHistoryNavigationCustomId(
  clanTag: string,
  historicalWindow: ClanHealthHistoricalWindow | number,
): string {
  return buildClanHealthWindowedNavigationCustomId(
    CLAN_HEALTH_WAR_HISTORY_ACTION,
    clanTag,
    historicalWindow,
  );
}

/** Purpose: build the restart-safe bounded Trends custom ID for tracked Clan Health. */
export function buildClanHealthTrendsNavigationCustomId(
  clanTag: string,
  historicalWindow: ClanHealthHistoricalWindow | number,
): string {
  return buildClanHealthWindowedNavigationCustomId(
    CLAN_HEALTH_TRENDS_ACTION,
    clanTag,
    historicalWindow,
  );
}

/** Purpose: build a restart-safe read-only Home leadership action custom ID. */
export function buildClanHealthHomeNavigationCustomId(
  action: ClanHealthHomeNavigationAction,
  clanTag: string,
): string {
  if (![CLAN_HEALTH_HOME_ROSTER_ACTION, CLAN_HEALTH_AWAY_ACTION, CLAN_HEALTH_TRANSFERS_ACTION].includes(action)) {
    throw new Error("Unsupported Clan Health Home navigation action.");
  }
  const normalizedClanTag = normalizeNavigationClanTag(clanTag);
  if (!normalizedClanTag) throw new Error("Invalid Clan Health navigation clan tag.");
  return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${action}:${normalizedClanTag}`;
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
    const historicalWindowValue = parts[3];
    const historicalWindowDays = Number(historicalWindowValue);
    if (historicalWindowValue === "s30") {
      if (!clanTag || parts[2] !== clanTag) return null;
      return {
        action: parts[1],
        clanTag,
        historicalWindow: {
          kind: "syncs",
          requestedSyncCount: 30,
          startSyncNumber: 0,
          endSyncNumber: 0,
          syncNumbers: [],
        },
      };
    }
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
    return {
      action: parts[1],
      clanTag,
      historicalWindow: { kind: "days", days: historicalWindowDays, cutoff: new Date(0) },
      historicalWindowDays,
    };
  }
  if (parts.length === 3 && [
    CLAN_HEALTH_HOME_ROSTER_ACTION,
    CLAN_HEALTH_AWAY_ACTION,
    CLAN_HEALTH_TRANSFERS_ACTION,
  ].includes(parts[1] as ClanHealthHomeNavigationAction)) {
    const clanTag = normalizeNavigationClanTag(parts[2]);
    if (!clanTag || parts[2] !== clanTag) return null;
    return { action: parts[1] as ClanHealthHomeNavigationAction, clanTag };
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
  historicalWindow: ClanHealthHistoricalWindow = {
    kind: "syncs",
    requestedSyncCount: 30,
    startSyncNumber: 0,
    endSyncNumber: 0,
    syncNumbers: [],
  },
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...CLAN_HEALTH_NAVIGATION_ACTIONS.map((action) =>
      new ButtonBuilder()
        .setCustomId(buildClanHealthNavigationCustomId(action, clanTag))
        .setLabel(CLAN_HEALTH_NAVIGATION_LABELS[action])
        .setStyle(ButtonStyle.Secondary),
    ),
    new ButtonBuilder()
      .setCustomId(
        buildClanHealthWarHistoryNavigationCustomId(
          clanTag,
          historicalWindow,
        ),
      )
      .setLabel("War History")
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Purpose: render the second tracked-clan navigation row for the windowed Trends drilldown. */
export function buildClanHealthTrendsNavigationRow(
  clanTag: string,
  historicalWindow: ClanHealthHistoricalWindow = {
    kind: "syncs",
    requestedSyncCount: 30,
    startSyncNumber: 0,
    endSyncNumber: 0,
    syncNumbers: [],
  },
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildClanHealthHomeNavigationCustomId(CLAN_HEALTH_HOME_ROSTER_ACTION, clanTag))
      .setLabel("View Home Roster")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildClanHealthHomeNavigationCustomId(CLAN_HEALTH_AWAY_ACTION, clanTag))
      .setLabel("View Away")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildClanHealthHomeNavigationCustomId(CLAN_HEALTH_TRANSFERS_ACTION, clanTag))
      .setLabel("View Transfers")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(
        buildClanHealthTrendsNavigationCustomId(
          clanTag,
          historicalWindow,
        ),
      )
      .setLabel("View Trends")
      .setStyle(ButtonStyle.Secondary),
  );
}

function formatHomeRosterObservedAt(value: Date | null): string {
  return value ? `<t:${Math.floor(value.getTime() / 1000)}:R>` : "unavailable";
}

function homeRosterMemberSort(left: HomeRosterMember, right: HomeRosterMember): number {
  const rank = { AWAY: 0, UNKNOWN: 1, PRESENT: 2 };
  return rank[left.presence] - rank[right.presence] ||
    left.playerName.localeCompare(right.playerName, undefined, { sensitivity: "base" }) ||
    left.playerTag.localeCompare(right.playerTag);
}

function buildHomeRosterMemberLine(member: HomeRosterMember): string {
  const icon = member.presence === "AWAY" ? "⚠️" : member.presence === "PRESENT" ? "✅" : "❔";
  let presence = member.presence === "PRESENT"
    ? "Present"
    : member.presence === "UNKNOWN"
      ? "Current roster coverage unavailable"
      : member.currentClanTag
        ? `Away • ${member.currentClanName ? `${member.currentClanName} ` : ""}${member.currentClanTag}`
        : "Away • Current location unknown";
  if (member.pendingTransfer) {
    presence += ` ↔ Possible transfer → ${member.pendingTransfer.toClanName ?? member.pendingTransfer.toClanTag}`;
  }
  return `${icon} ${member.playerName} \`${member.playerTag}\` — ${presence}`;
}

function buildHomeRosterSummaryLines(roster: ClanHomeRoster, clanName: string): string[] {
  const lines = [
    `🏠 ${clanName} Home Roster`,
    `Reserved: **${roster.homeMemberCount}/50** • Open Home spots: **${roster.openHomeSpots}**`,
    roster.currentRosterObservedAt
      ? `Present: **${roster.presentCount}** • Away: **${roster.awayCount}**`
      : `Present/Away: **unavailable** • Unknown: **${roster.unknownCount}**`,
    `Current unassigned: **${roster.unassignedPresentCount}**`,
    `Possible transfers: **${roster.pendingTransferCount}**`,
    roster.currentRosterObservedAt
      ? `Roster observed: ${formatHomeRosterObservedAt(roster.currentRosterObservedAt)}`
      : "Current roster coverage: **unavailable**",
  ];
  return lines;
}

function buildHomeRosterLines(roster: ClanHomeRoster, clanName: string): string[] {
  return [
    ...buildHomeRosterSummaryLines(roster, clanName),
    "",
    ...[...roster.members].sort(homeRosterMemberSort).map(buildHomeRosterMemberLine),
  ];
}

function buildAwayRosterLines(roster: ClanHomeRoster, clanName: string): string[] {
  if (!roster.currentRosterObservedAt) {
    return [`Home roster coverage for ${clanName} is unavailable; Away members cannot be determined yet.`];
  }
  const awayMembers = roster.members.filter((member) => member.presence === "AWAY").sort(homeRosterMemberSort);
  if (awayMembers.length === 0) {
    return [`No Home members are currently known to be away from ${clanName}.`];
  }
  return [
    `⚠️ ${clanName} Away Home Members`,
    `Roster observed: ${formatHomeRosterObservedAt(roster.currentRosterObservedAt)}`,
    "",
    ...awayMembers.map(buildHomeRosterMemberLine),
  ];
}

function buildTransferRosterLines(roster: ClanHomeRoster, clanName: string): string[] {
  const transfers = roster.members
    .filter((member) => member.pendingTransfer)
    .sort(homeRosterMemberSort);
  if (transfers.length === 0) return ["No pending Home transfer candidates."];
  return [
    `↔ Pending Home transfer candidates for ${clanName}`,
    "Read-only; no Home or candidate decision was made.",
    "",
    ...transfers.map((member) => {
      const candidate = member.pendingTransfer!;
      return `${member.playerName} \`${member.playerTag}\` — ${clanName} → ${candidate.toClanName ?? candidate.toClanTag} • qualifies ${formatHomeRosterObservedAt(candidate.startedAtSyncTime)} to ${formatHomeRosterObservedAt(candidate.qualifiedAtSyncTime)}`;
    }),
  ];
}

/** Purpose: render persisted sync-boundary trend facts as one compact ephemeral embed. */
export function buildClanHealthTrendsEmbed(
  report: ClanHealthTrendReport,
  historicalWindowDays?: number,
): EmbedBuilder {
  const windowLabel = report.window.kind === "syncs"
    ? `Last ${report.window.requestedSyncCount} syncs`
    : `Last ${historicalWindowDays ?? report.window.days} days`;
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
    .setDescription(`Persisted sync-boundary readiness history • Last ${historicalWindowDays} days`)
    .setColor(0x3498db)
    .addFields(
      {
        name: "Coverage",
        value: report.coverage.total === 0
          ? `No sync-boundary readiness snapshots were captured for ${tag} in the last ${historicalWindowDays} days.`
          : `${report.coverage.total} captured sync boundar${report.coverage.total === 1 ? "y" : "ies"} in the selected ${historicalWindowDays}-day window.\nCaptured: ${formatDate(report.coverage.oldestSyncTime)} → ${formatDate(report.coverage.newestSyncTime)}`,
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
  embed.setDescription(`Persisted sync-boundary readiness history - ${windowLabel}`);
  embed.spliceFields(0, 1, {
    name: "Coverage",
    value: report.coverage.total === 0
      ? `No sync-boundary readiness snapshots were captured for ${tag} in the ${windowLabel}.`
      : `${report.coverage.total} captured sync boundaries in the selected ${windowLabel}.\nCaptured: ${formatDate(report.coverage.oldestSyncTime)} -> ${formatDate(report.coverage.newestSyncTime)}`,
    inline: false,
  });
  return embed;
}

function buildWarHistoryDescription(input: {
  window: ClanHealthHistoricalWindow;
  total: number;
}): string {
  const { window, total } = input;
  if (window.kind === "syncs") {
    return total > CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT
      ? `Last ${window.requestedSyncCount} syncs - ${total} ended wars\nShowing latest ${CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT} of ${total} ended wars in the selected window.`
      : `Last ${window.requestedSyncCount} syncs - ${total} ended war${total === 1 ? "" : "s"}.`;
  }
  if (window.kind === "days") {
    return total > CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT
      ? `Last ${window.days} days \u2022 ${total} ended wars\nShowing latest ${CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT} of ${total} ended wars in last ${window.days} days.`
      : `Last ${window.days} days \u2022 ${total} ended war${total === 1 ? "" : "s"}.`;
  }
  return "Latest sync range unavailable. Historical war data was not queried.";
}

/** Purpose: execute one authorized Clan Health drilldown without mutating the originating message. */
export async function handleClanHealthNavigationButtonInteraction(
  interaction: ButtonInteraction,
  permissionService = new CommandPermissionService(),
  historyService = new ClanWarHistoryService(),
  trendService = new ClanHealthTrendService(),
  historicalWindowService = new ClanHealthHistoricalWindowService(),
  homeRosterReader: Pick<typeof homeRosterService, "getClanHomeRoster"> = homeRosterService,
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
        : parsed.action === CLAN_HEALTH_HOME_ROSTER_ACTION ||
            parsed.action === CLAN_HEALTH_AWAY_ACTION ||
            parsed.action === CLAN_HEALTH_TRANSFERS_ACTION
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
    } else if (
      parsed.action === CLAN_HEALTH_HOME_ROSTER_ACTION ||
      parsed.action === CLAN_HEALTH_AWAY_ACTION ||
      parsed.action === CLAN_HEALTH_TRANSFERS_ACTION
    ) {
      const roster = await homeRosterReader.getClanHomeRoster({
        guildId: interaction.guildId,
        clanTag: `#${parsed.clanTag}`,
      });
      const clanName = roster.clanName || `#${parsed.clanTag}`;
      const lines = parsed.action === CLAN_HEALTH_HOME_ROSTER_ACTION
        ? buildHomeRosterLines(roster, clanName)
        : parsed.action === CLAN_HEALTH_AWAY_ACTION
          ? buildAwayRosterLines(roster, clanName)
          : buildTransferRosterLines(roster, clanName);
      const messages = splitDiscordLineMessages({ lines, maxMessages: 5 });
      await interaction.editReply(messages[0] ?? "No Home roster details are available.");
      for (const message of messages.slice(1)) {
        await interaction.followUp({ ephemeral: true, content: message });
      }
    } else if (parsed.action === CLAN_HEALTH_WAR_HISTORY_ACTION) {
      const resolvedWindow = parsed.historicalWindow.kind === "syncs"
        ? await historicalWindowService.resolveLatestSyncWindow({
            guildId: interaction.guildId,
          })
        : parsed.historicalWindow;
      const effectiveWindow = resolvedWindow.kind === "days"
        ? {
            kind: "days" as const,
            days: resolvedWindow.days,
            cutoff: buildClanHealthHistoricalCutoff(new Date(), resolvedWindow.days),
          }
        : resolvedWindow;
      const rows = effectiveWindow.kind === "syncs"
        ? await historyService.listEndedByClanSyncNumbers({
            clanTag: `#${parsed.clanTag}`,
            syncNumbers: effectiveWindow.syncNumbers,
          })
        : effectiveWindow.kind === "days"
          ? await historyService.listEndedByClanSince({
              clanTag: `#${parsed.clanTag}`,
              cutoff: effectiveWindow.cutoff,
            })
          : [];
      const displayName = rows[0]?.clanName?.trim() || `#${parsed.clanTag}`;
      const title = rows.length === 0
        ? `War History - ${displayName}`
        : `War History - ${displayName} (#${parsed.clanTag})`;
      const total = rows.length;
      const description = buildWarHistoryDescription({ window: effectiveWindow, total });
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
      const resolvedWindow = parsed.historicalWindow.kind === "syncs"
        ? await historicalWindowService.resolveLatestSyncWindow({
            guildId: interaction.guildId,
          })
        : parsed.historicalWindow;
      const effectiveWindow = resolvedWindow.kind === "days"
        ? {
            kind: "days" as const,
            days: resolvedWindow.days,
            cutoff: buildClanHealthHistoricalCutoff(now, resolvedWindow.days),
          }
        : resolvedWindow;
      const report = await trendService.getTrend({
        guildId: interaction.guildId,
        clanTag: `#${parsed.clanTag}`,
        window: effectiveWindow.kind === "syncs"
          ? {
              kind: "syncs",
              requestedSyncCount: effectiveWindow.requestedSyncCount,
              startSyncNumber: effectiveWindow.startSyncNumber,
              endSyncNumber: effectiveWindow.endSyncNumber,
              syncNumbers: effectiveWindow.syncNumbers,
            }
          : effectiveWindow.kind === "days"
          ? {
              kind: "days",
              days: effectiveWindow.days,
              cutoff: effectiveWindow.cutoff,
            }
          : {
              kind: "syncs",
              requestedSyncCount: 30,
              startSyncNumber: 0,
              endSyncNumber: 0,
              syncNumbers: [],
            },
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
