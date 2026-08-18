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
  CLAN_HEALTH_DEFAULT_WINDOW_DAYS,
  CLAN_HEALTH_MAX_WINDOW_DAYS,
  CLAN_HEALTH_MIN_WINDOW_DAYS,
} from "../services/ClanHealthSnapshotService";
import { ClanWarHistoryService } from "../services/ClanWarHistoryService";
import { runInactiveClanHealthDetail } from "./Inactive";
import { buildUnlinkedListLines } from "./Unlinked";
import { buildCompoAdviceResponsePayload } from "./Compo";
import { buildFwaViolationsClanDetailPayload } from "./fwa/violationsCommand";
import { buildWarHistoryField } from "./War";
import { CompoAdviceService } from "../services/CompoAdviceService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import { unlinkedMemberAlertService } from "../services/UnlinkedMemberAlertService";

const CLAN_HEALTH_NAVIGATION_PREFIX = "clan-health";
const CLAN_HEALTH_WAR_HISTORY_ACTION = "war-history" as const;
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
  | { action: typeof CLAN_HEALTH_WAR_HISTORY_ACTION; clanTag: string; historicalWindowDays: number };

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

/** Purpose: build a restart-safe bounded historical window ID for tracked Clan Health. */
export function buildClanHealthWarHistoryNavigationCustomId(
  clanTag: string,
  historicalWindowDays: number,
): string {
  const normalizedClanTag = normalizeNavigationClanTag(clanTag);
  if (!normalizedClanTag) {
    throw new Error("Invalid Clan Health navigation clan tag.");
  }
  if (
    !Number.isInteger(historicalWindowDays) ||
    historicalWindowDays < CLAN_HEALTH_MIN_WINDOW_DAYS ||
    historicalWindowDays > CLAN_HEALTH_MAX_WINDOW_DAYS
  ) {
    throw new Error("Invalid Clan Health historical window.");
  }
  return `${CLAN_HEALTH_NAVIGATION_PREFIX}:${CLAN_HEALTH_WAR_HISTORY_ACTION}:${normalizedClanTag}:${historicalWindowDays}`;
}

/** Purpose: parse and validate a Clan Health navigation custom ID without trusting user input. */
export function parseClanHealthNavigationCustomId(
  customId: string,
): ClanHealthNavigationPayload | null {
  const parts = String(customId ?? "").split(":");
  if (parts[0] !== CLAN_HEALTH_NAVIGATION_PREFIX) return null;
  if (parts.length === 4 && parts[1] === CLAN_HEALTH_WAR_HISTORY_ACTION) {
    const clanTag = normalizeNavigationClanTag(parts[2]);
    const historicalWindowDays = Number(parts[3]);
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
    return { action: CLAN_HEALTH_WAR_HISTORY_ACTION, clanTag, historicalWindowDays };
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
  historicalWindowDays = CLAN_HEALTH_DEFAULT_WINDOW_DAYS,
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
          historicalWindowDays,
        ),
      )
      .setLabel("War History")
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Purpose: execute one authorized Clan Health drilldown without mutating the originating message. */
export async function handleClanHealthNavigationButtonInteraction(
  interaction: ButtonInteraction,
  permissionService = new CommandPermissionService(),
  historyService = new ClanWarHistoryService(),
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
      const rows = await historyService.listEndedByClanSince({
        clanTag: `#${parsed.clanTag}`,
        cutoff: buildClanHealthHistoricalCutoff(new Date(), parsed.historicalWindowDays),
      });
      const displayName = rows[0]?.clanName?.trim() || `#${parsed.clanTag}`;
      const title = rows.length === 0
        ? `War History - ${displayName}`
        : `War History - ${displayName} (#${parsed.clanTag})`;
      const total = rows.length;
      const description =
        total > CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT
          ? `Last ${parsed.historicalWindowDays} days • ${total} ended wars\nShowing latest ${CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT} of ${total} ended wars in last ${parsed.historicalWindowDays} days.`
          : `Last ${parsed.historicalWindowDays} days • ${total} ended war${total === 1 ? "" : "s"}.`;
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(0x3498db)
        .setTimestamp(new Date());
      for (const row of rows.slice(0, CLAN_HEALTH_WAR_HISTORY_DISPLAY_LIMIT)) {
        embed.addFields(buildWarHistoryField(row, displayName));
      }
      await interaction.editReply({ embeds: [embed] });
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
