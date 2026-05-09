import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { Command } from "../Command";
import { prisma } from "../prisma";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  buildRaidDashboardOverviewDescription,
  buildRaidDashboardSelectChoices,
  buildRaidDashboardSingleClanDescription,
  findRaidDashboardClanRow,
  listRaidDashboardRows,
  type RaidDashboardClanRow,
} from "../services/RaidDashboardService";
import {
  normalizeRaidTrackedClanTag,
} from "../services/RaidTrackedClanService";
import { refreshRaidTrackedClanListWithQueueContext } from "./TrackedClan";

const RAID_DASHBOARD_TIMEOUT_MS = 10 * 60 * 1000;
const RAID_DASHBOARD_PREFIX = "raids";

type RaidsDashboardSession = {
  guildId: string | null;
  userId: string;
  selectedClanTag: string | null;
  refreshing: boolean;
};

const raidsDashboardSessions = new Map<string, RaidsDashboardSession>();

function buildRaidsCustomId(sessionId: string, action: "select" | "refresh" | "back"): string {
  return `${RAID_DASHBOARD_PREFIX}:${sessionId}:${action}`;
}

function parseRaidsCustomId(customId: string): { sessionId: string; action: "select" | "refresh" | "back" } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== RAID_DASHBOARD_PREFIX) return null;
  const sessionId = parts[1]?.trim() ?? "";
  const action = parts[2]?.trim() ?? "";
  if (!sessionId || (action !== "select" && action !== "refresh" && action !== "back")) {
    return null;
  }
  return { sessionId, action };
}

function getSession(sessionId: string): RaidsDashboardSession | null {
  return raidsDashboardSessions.get(sessionId) ?? null;
}

function createSessionTimer(sessionId: string): void {
  const timer = setTimeout(() => {
    raidsDashboardSessions.delete(sessionId);
  }, RAID_DASHBOARD_TIMEOUT_MS);
  (timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
}

function formatClanTag(tag: string): string {
  const normalized = normalizeRaidTrackedClanTag(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function buildRaidDashboardEmbed(rows: RaidDashboardClanRow[], selectedRow: RaidDashboardClanRow | null) {
  const title = selectedRow ? "Raid Clans" : "Raid Clans";
  const description = selectedRow
    ? buildRaidDashboardSingleClanDescription(selectedRow)
    : buildRaidDashboardOverviewDescription(rows);
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2);
}

function buildRaidsSelectRow(input: {
  sessionId: string;
  rows: RaidDashboardClanRow[];
  selectedClanTag: string | null;
  refreshing: boolean;
}): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildRaidsCustomId(input.sessionId, "select"))
    .setPlaceholder("Choose a raid clan")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      buildRaidDashboardSelectChoices(input.rows, input.selectedClanTag).map((option) => {
        const menuOption = new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value);
        if (option.description) {
          menuOption.setDescription(option.description);
        }
        if (option.emoji) {
          menuOption.setEmoji(option.emoji);
        }
        return menuOption;
      }),
    )
    .setDisabled(input.refreshing || input.rows.length <= 0);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildRaidsButtonRow(input: {
  sessionId: string;
  selectedClanTag: string | null;
  refreshing: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = [];
  if (input.selectedClanTag) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(buildRaidsCustomId(input.sessionId, "back"))
        .setLabel("Back to Overview")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(input.refreshing),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(buildRaidsCustomId(input.sessionId, "refresh"))
      .setEmoji("🔄")
      .setLabel(input.refreshing ? "Refreshing..." : "Refresh")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(input.refreshing),
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

async function buildRaidDashboardPayload(input: {
  sessionId: string;
  selectedClanTag: string | null;
  cocService: CoCService;
  refreshing: boolean;
}): Promise<{
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
  rows: RaidDashboardClanRow[];
}> {
  const rows = await listRaidDashboardRows({ cocService: input.cocService });
  const selectedRow = input.selectedClanTag ? findRaidDashboardClanRow(rows, input.selectedClanTag) : null;
  const effectiveSelectedTag = selectedRow ? normalizeRaidTrackedClanTag(selectedRow.clanTag) ?? selectedRow.clanTag : null;
  const embed = buildRaidDashboardEmbed(rows, selectedRow);
  const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
  if (rows.length > 0) {
    components.push(
      buildRaidsSelectRow({
        sessionId: input.sessionId,
        rows,
        selectedClanTag: effectiveSelectedTag,
        refreshing: input.refreshing,
      }),
    );
    components.push(
      buildRaidsButtonRow({
        sessionId: input.sessionId,
        selectedClanTag: effectiveSelectedTag,
        refreshing: input.refreshing,
      }),
    );
  }
  return {
    embeds: [embed],
    components,
    rows,
  };
}

async function loadRaidAutocompleteChoices(query: string): Promise<Array<{ name: string; value: string }>> {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const clans = await prisma.raidTrackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
    select: {
      clanTag: true,
      name: true,
      upgrades: true,
      joinType: true,
    },
  });
  return clans
    .map((clan) => {
      const tag = normalizeRaidTrackedClanTag(clan.clanTag);
      if (!tag) return null;
      const label = clan.name?.trim() ? `${clan.name.trim()} (#${tag})` : `#${tag}`;
      return {
        name: label.slice(0, 100),
        value: tag,
      };
    })
    .filter((choice): choice is { name: string; value: string } => {
      if (!choice) return false;
      if (!normalizedQuery) return true;
      return (
        choice.name.toLowerCase().includes(normalizedQuery) ||
        choice.value.toLowerCase().includes(normalizedQuery)
      );
    })
    .slice(0, 25);
}

async function refreshRaidDashboardState(input: {
  cocService: CoCService;
}): Promise<void> {
  await refreshRaidTrackedClanListWithQueueContext({
    cocService: input.cocService,
  }).catch((err) => {
    console.error(`[raids] metadata refresh failed: ${formatError(err)}`);
  });
}

export async function handleRaidsSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseRaidsCustomId(interaction.customId);
  if (!parsed || parsed.action !== "select") return;

  const session = getSession(parsed.sessionId);
  if (!session) {
    await interaction.reply({
      ephemeral: true,
      content: "This raids view expired. Run `/raids` again.",
    });
    return;
  }
  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command user can control this raids view.",
    });
    return;
  }

  const selectedClanTag = normalizeRaidTrackedClanTag(interaction.values[0] ?? "") ?? null;
  session.selectedClanTag = selectedClanTag;

  await interaction.deferUpdate();
  try {
    const payload = await buildRaidDashboardPayload({
      sessionId: parsed.sessionId,
      selectedClanTag,
      cocService,
      refreshing: false,
    });
    if (payload.rows.length <= 0) {
      await interaction.message.edit({
        content: "No RAIDS tracked clans in the database.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.message.edit({
      embeds: payload.embeds,
      components: payload.components,
    });
  } catch (err) {
    console.error(`[raids] select interaction failed: ${formatError(err)}`);
    await interaction.followUp({
      ephemeral: true,
      content: "Failed to update the raids view.",
    });
  }
}

export async function handleRaidsButtonInteraction(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseRaidsCustomId(interaction.customId);
  if (!parsed || parsed.action === "select") return;

  const session = getSession(parsed.sessionId);
  if (!session) {
    await interaction.reply({
      ephemeral: true,
      content: "This raids view expired. Run `/raids` again.",
    });
    return;
  }
  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command user can control this raids view.",
    });
    return;
  }

  if (session.refreshing) {
    await interaction.reply({
      ephemeral: true,
      content: "Raids view is already refreshing.",
    });
    return;
  }

  await interaction.deferUpdate();
  session.refreshing = true;
  try {
    if (parsed.action === "refresh") {
      await refreshRaidDashboardState({ cocService });
    }

    const nextSelectedClanTag = parsed.action === "back" ? null : session.selectedClanTag;
    if (parsed.action === "back") {
      session.selectedClanTag = null;
    }
    const payload = await buildRaidDashboardPayload({
      sessionId: parsed.sessionId,
      selectedClanTag: nextSelectedClanTag,
      cocService,
      refreshing: false,
    });
    if (payload.rows.length <= 0) {
      await interaction.message.edit({
        content: "No RAIDS tracked clans in the database.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.message.edit({
      embeds: payload.embeds,
      components: payload.components,
    });
  } catch (err) {
    console.error(`[raids] button interaction failed: ${formatError(err)}`);
    await interaction.followUp({
      ephemeral: true,
      content: "Failed to update the raids view.",
    });
  } finally {
    session.refreshing = false;
  }
}

export function isRaidsSelectMenuCustomId(customId: string): boolean {
  const parsed = parseRaidsCustomId(customId);
  return parsed?.action === "select";
}

export function isRaidsButtonCustomId(customId: string): boolean {
  const parsed = parseRaidsCustomId(customId);
  return parsed?.action === "refresh" || parsed?.action === "back";
}

export const Raids: Command = {
  name: "raids",
  description: "Raid-focused dashboard for tracked RAID clans",
  options: [
    {
      name: "clan",
      description: "Tracked RAID clan to show",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
  ],
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const query = interaction.options.getFocused(true);
    if (query.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const choices = await loadRaidAutocompleteChoices(String(query.value ?? ""));
    await interaction.respond(choices);
  },
  run: async (_client: Client, interaction: ChatInputCommandInteraction, cocService: CoCService) => {
    await interaction.deferReply({ ephemeral: true });
    const requestedClan = normalizeRaidTrackedClanTag(interaction.options.getString("clan", false) ?? "");
    const rows = await listRaidDashboardRows({ cocService });
    if (rows.length <= 0) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "No RAIDS tracked clans in the database. Use `/tracked-clan raid-tags` first.",
      });
      return;
    }

    const selectedRow = requestedClan ? findRaidDashboardClanRow(rows, requestedClan) : null;
    if (requestedClan && !selectedRow) {
      await safeReply(interaction, {
        ephemeral: true,
        content: `No tracked RAID clan matched ${formatClanTag(requestedClan)}.`,
      });
      return;
    }

    const sessionId = interaction.id;
    raidsDashboardSessions.set(sessionId, {
      guildId: interaction.guildId ?? null,
      userId: interaction.user.id,
      selectedClanTag: selectedRow ? normalizeRaidTrackedClanTag(selectedRow.clanTag) ?? selectedRow.clanTag : null,
      refreshing: false,
    });
    createSessionTimer(sessionId);

    const payload = await buildRaidDashboardPayload({
      sessionId,
      selectedClanTag: selectedRow ? normalizeRaidTrackedClanTag(selectedRow.clanTag) ?? selectedRow.clanTag : null,
      cocService,
      refreshing: false,
    });
    await interaction.editReply({
      embeds: payload.embeds,
      components: payload.components,
    });
  },
};
