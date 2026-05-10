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
  buildRaidIntelDescription,
  buildRaidIntelDistrictOptions,
  buildRaidIntelSelectedDistrictLabel,
  applyRaidIntelLayoutGrades,
  buildRaidDashboardOverviewDescription,
  buildRaidDashboardSelectChoices,
  buildRaidDashboardSingleClanDescription,
  buildRaidIntelLayoutGradeLabel,
  findRaidIntelDistrictByKey,
  findRaidDashboardClanRow,
  loadRaidIntelSeasonDetailWithQueueContext,
  loadRaidDashboardSeasonDetailWithQueueContext,
  listRaidDashboardRowsWithQueueContext,
  parseRaidSeasonTimeMs,
  type RaidDashboardClanRow,
  type RaidIntelDistrict,
  type RaidIntelLayoutGrade,
  type RaidIntelLayoutGradeLabel,
} from "../services/RaidDashboardService";
import {
  normalizeRaidTrackedClanTag,
  listRaidTrackedClansForDisplay,
  type RaidTrackedClanDisplayRow,
} from "../services/RaidTrackedClanService";
import {
  loadRaidIntelLayoutGradeLookupForSeason,
  upsertRaidIntelDistrictLayoutMark,
} from "../services/RaidIntelLayoutMarkService";
import { refreshRaidTrackedClanListWithQueueContext } from "./TrackedClan";

const RAID_DASHBOARD_TIMEOUT_MS = 10 * 60 * 1000;
const RAID_DASHBOARD_PREFIX = "raids";

type RaidsDashboardSession = {
  guildId: string | null;
  userId: string;
  selectedClanTag: string | null;
  rows: RaidDashboardClanRow[];
  refreshing: boolean;
};

type RaidIntelTrackedClanRow = RaidTrackedClanDisplayRow;

type RaidIntelSession = {
  guildId: string | null;
  userId: string;
  trackedClanTag: string;
  upgradesOverride: number | null;
  raidSeasonStartTime: Date | null;
  selectedDistrictKey: string | null;
  districtKeyMap: Map<string, RaidIntelDistrict>;
  refreshing: boolean;
};

const raidsDashboardSessions = new Map<string, RaidsDashboardSession>();
const raidsIntelSessions = new Map<string, RaidIntelSession>();

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

function createRaidIntelSessionTimer(sessionId: string): void {
  const timer = setTimeout(() => {
    raidsIntelSessions.delete(sessionId);
  }, RAID_DASHBOARD_TIMEOUT_MS);
  (timer as NodeJS.Timeout & { unref?: () => void }).unref?.();
}

function formatClanTag(tag: string): string {
  const normalized = normalizeRaidTrackedClanTag(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function buildRaidIntelCustomId(
  sessionId: string,
  action: "select" | "refresh" | "grade",
  grade?: RaidIntelLayoutGrade,
): string {
  return action === "grade" && grade
    ? `raids:intel:${sessionId}:grade:${grade}`
    : `raids:intel:${sessionId}:${action}`;
}

function parseRaidIntelCustomId(
  customId: string,
):
  | { sessionId: string; action: "select" | "refresh" }
  | { sessionId: string; action: "grade"; grade: RaidIntelLayoutGrade }
  | null {
  const parts = customId.split(":");
  if (parts.length < 4 || parts[0] !== "raids" || parts[1] !== "intel") return null;
  const sessionId = parts[2]?.trim() ?? "";
  const action = parts[3]?.trim() ?? "";
  if (!sessionId) return null;
  if (action === "select" || action === "refresh") {
    return { sessionId, action };
  }
  if (action === "grade") {
    const grade = parts[4]?.trim() ?? "";
    if (grade === "DEFAULT" || grade === "CUSTOM_HARD" || grade === "CUSTOM_MEDIUM" || grade === "CUSTOM_EASY") {
      return { sessionId, action, grade };
    }
  }
  return null;
}

function getRaidIntelSession(sessionId: string): RaidIntelSession | null {
  return raidsIntelSessions.get(sessionId) ?? null;
}

function buildRaidIntelGradeButtonRow(input: {
  sessionId: string;
  selectedDistrict: RaidIntelDistrict | null;
  refreshing: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  const selectedGrade = input.selectedDistrict?.grade ?? "Unmarked";
  const makeButton = (
    grade: RaidIntelLayoutGrade,
    label: string,
    style: ButtonStyle,
  ): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(buildRaidIntelCustomId(input.sessionId, "grade", grade))
      .setLabel(label)
      .setStyle(selectedGrade === buildRaidIntelLayoutGradeLabel(grade) ? ButtonStyle.Primary : style)
      .setDisabled(input.refreshing || !input.selectedDistrict);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    makeButton("DEFAULT", "Default", ButtonStyle.Secondary),
    makeButton("CUSTOM_HARD", "Hard", ButtonStyle.Secondary),
    makeButton("CUSTOM_MEDIUM", "Medium", ButtonStyle.Secondary),
    makeButton("CUSTOM_EASY", "Easy", ButtonStyle.Secondary),
  );
}

function buildRaidDashboardEmbed(
  rows: RaidDashboardClanRow[],
  selectedRow: RaidDashboardClanRow | null,
  detail: Awaited<ReturnType<typeof loadRaidDashboardSeasonDetailWithQueueContext>> | null,
) {
  const description = selectedRow
    ? buildRaidDashboardSingleClanDescription(selectedRow, detail)
    : buildRaidDashboardOverviewDescription(rows);
  return new EmbedBuilder().setDescription(description).setColor(0x5865f2);
}

function buildRaidIntelEmbed(input: {
  trackedClan: RaidIntelTrackedClanRow;
  upgrades: number | null;
  detail: Awaited<ReturnType<typeof loadRaidIntelSeasonDetailWithQueueContext>>;
  selectedDistrictLabel?: string | null;
  controlsHint?: string | null;
  districtControlsNote?: string | null;
}) {
  return new EmbedBuilder()
    .setTitle("Raid Intel")
    .setDescription(
      buildRaidIntelDescription({
        trackedClan: input.trackedClan,
        upgrades: input.upgrades,
        detail: input.detail,
        selectedDistrictLabel: input.selectedDistrictLabel,
        controlsHint: input.controlsHint,
        districtControlsNote: input.districtControlsNote,
      }),
    )
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
        menuOption.setDefault(option.selected);
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

function buildRaidIntelSelectRow(input: {
  sessionId: string;
  options: ReturnType<typeof buildRaidIntelDistrictOptions>["options"];
  selectedDistrictKey: string | null;
  refreshing: boolean;
}): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (input.options.length <= 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildRaidIntelCustomId(input.sessionId, "select"))
    .setPlaceholder("Choose a district")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      input.options.map((option) => {
        const menuOption = new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value)
          .setDefault(option.value === input.selectedDistrictKey);
        if (option.description) {
          menuOption.setDescription(option.description);
        }
        return menuOption;
      }),
    )
    .setDisabled(input.refreshing);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildRaidIntelRefreshRow(input: {
  sessionId: string;
  refreshing: boolean;
}): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildRaidIntelCustomId(input.sessionId, "refresh"))
      .setEmoji("🔄")
      .setLabel(input.refreshing ? "Refreshing..." : "Refresh")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(input.refreshing),
  );
}

async function buildRaidIntelPayload(input: {
  sessionId: string;
  guildId: string | null;
  userId: string;
  trackedClan: RaidIntelTrackedClanRow;
  upgradesOverride: number | null;
  selectedDistrictKey: string | null;
  cocService: CoCService;
  refreshing: boolean;
  source: string;
}): Promise<{
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
  detail: Awaited<ReturnType<typeof loadRaidIntelSeasonDetailWithQueueContext>>;
  raidSeasonStartTime: Date | null;
  selectedDistrictKey: string | null;
  districtKeyMap: Map<string, RaidIntelDistrict>;
}> {
  const detail = await loadRaidIntelSeasonDetailWithQueueContext({
    cocService: input.cocService,
    clanTag: input.trackedClan.clanTag,
    source: input.source,
  });

  const seasonStartMs = detail.activeSeason?.startTime
    ? parseRaidSeasonTimeMs(detail.activeSeason.startTime)
    : null;
  const seasonStart = seasonStartMs === null ? null : new Date(seasonStartMs);
  const gradeLookup =
    detail.activeSeason && input.guildId
      ? await loadRaidIntelLayoutGradeLookupForSeason({
          guildId: input.guildId,
          sourceClanTag: input.trackedClan.clanTag,
          raidSeasonStartTime: seasonStart,
        })
      : new Map<string, RaidIntelLayoutGradeLabel>();
  const markedDetail = applyRaidIntelLayoutGrades(detail, gradeLookup);
  const districtResult = buildRaidIntelDistrictOptions({ detail: markedDetail });
  const selectedDistrict =
    input.selectedDistrictKey && markedDetail.activeSeason
      ? findRaidIntelDistrictByKey(markedDetail, input.selectedDistrictKey)
      : null;
  const selectedDistrictLabel = selectedDistrict
    ? buildRaidIntelSelectedDistrictLabel(selectedDistrict)
    : null;
  const controlsHint = markedDetail.activeSeason && markedDetail.defenders.length > 0
    ? "Select a district below, then choose a layout grade."
    : null;
  const districtControlsNote = districtResult.truncated
    ? "Showing controls for first 25 districts only."
    : null;

  const embed = buildRaidIntelEmbed({
    trackedClan: input.trackedClan,
    upgrades: input.upgradesOverride ?? input.trackedClan.upgrades,
    detail: markedDetail,
    selectedDistrictLabel,
    controlsHint,
    districtControlsNote,
  });

  const components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];
  const selectRow = buildRaidIntelSelectRow({
    sessionId: input.sessionId,
    options: districtResult.options,
    selectedDistrictKey: input.selectedDistrictKey,
    refreshing: input.refreshing,
  });
  if (selectRow) {
    components.push(selectRow);
  }
  if (selectedDistrict) {
    components.push(
      buildRaidIntelGradeButtonRow({
        sessionId: input.sessionId,
        selectedDistrict,
        refreshing: input.refreshing,
      }),
    );
  }
  components.push(
    buildRaidIntelRefreshRow({
      sessionId: input.sessionId,
      refreshing: input.refreshing,
    }),
  );

  return {
    embeds: [embed],
    components,
    detail: markedDetail,
    raidSeasonStartTime: seasonStart,
    selectedDistrictKey: selectedDistrict ? input.selectedDistrictKey : null,
    districtKeyMap: new Map(markedDetail.defenders.flatMap((defender) => defender.districts.map((district) => [district.key, district] as const))),
  };
}

export async function handleRaidsIntelSelectMenuInteraction(
  interaction: StringSelectMenuInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseRaidIntelCustomId(interaction.customId);
  if (!parsed || parsed.action !== "select") return;

  const session = getRaidIntelSession(parsed.sessionId);
  if (!session) {
    await interaction.reply({
      ephemeral: true,
      content: "This raid intel view expired. Run /raids intel again.",
    });
    return;
  }
  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command user can control this raid intel view.",
    });
    return;
  }

  session.selectedDistrictKey = String(interaction.values[0] ?? "").trim() || null;

  await interaction.deferUpdate();
  try {
    const trackedClans = await listRaidTrackedClansForDisplay();
    const trackedClan =
      trackedClans.find((row) => (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) === session.trackedClanTag) ??
      null;
    if (!trackedClan) {
      await interaction.editReply({
        content: `No tracked RAID clan matched ${formatClanTag(session.trackedClanTag)}.`,
        embeds: [],
        components: [],
      });
      return;
    }

    const payload = await buildRaidIntelPayload({
      sessionId: parsed.sessionId,
      guildId: session.guildId,
      userId: session.userId,
      trackedClan,
      upgradesOverride: session.upgradesOverride,
      selectedDistrictKey: session.selectedDistrictKey,
      cocService,
      refreshing: false,
      source: "raids:intel:select",
    });
    session.raidSeasonStartTime = payload.raidSeasonStartTime;
    session.selectedDistrictKey = payload.selectedDistrictKey;
    session.districtKeyMap = payload.districtKeyMap;
    await interaction.editReply({
      embeds: payload.embeds,
      components: payload.components,
    });
  } catch (err) {
    console.error(`[raids] intel select interaction failed: ${formatError(err)}`);
    await interaction.followUp({
      ephemeral: true,
      content: "Failed to update the raid intel view.",
    });
  }
}

export async function handleRaidsIntelButtonInteraction(
  interaction: ButtonInteraction,
  cocService: CoCService,
): Promise<void> {
  const parsed = parseRaidIntelCustomId(interaction.customId);
  if (!parsed || parsed.action === "select") return;

  const session = getRaidIntelSession(parsed.sessionId);
  if (!session) {
    await interaction.reply({
      ephemeral: true,
      content: "This raid intel view expired. Run /raids intel again.",
    });
    return;
  }
  if (session.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the command user can control this raid intel view.",
    });
    return;
  }

  if (session.refreshing) {
    await interaction.reply({
      ephemeral: true,
      content: "Raid intel view is already refreshing.",
    });
    return;
  }

  if (parsed.action === "grade" && !session.selectedDistrictKey) {
    await interaction.reply({
      ephemeral: true,
      content: "Select a district first.",
    });
    return;
  }

  await interaction.deferUpdate();
  session.refreshing = true;
  try {
    const trackedClans = await listRaidTrackedClansForDisplay();
    const trackedClan =
      trackedClans.find((row) => (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) === session.trackedClanTag) ??
      null;
    if (!trackedClan) {
      await interaction.editReply({
        content: `No tracked RAID clan matched ${formatClanTag(session.trackedClanTag)}.`,
        embeds: [],
        components: [],
      });
      return;
    }

    const currentPayload = await buildRaidIntelPayload({
      sessionId: parsed.sessionId,
      guildId: session.guildId,
      userId: session.userId,
      trackedClan,
      upgradesOverride: session.upgradesOverride,
      selectedDistrictKey: session.selectedDistrictKey,
      cocService,
      refreshing: false,
      source: parsed.action === "refresh" ? "raids:intel:refresh" : "raids:intel:grade",
    });
    session.raidSeasonStartTime = currentPayload.raidSeasonStartTime;
    session.selectedDistrictKey = currentPayload.selectedDistrictKey;
    session.districtKeyMap = currentPayload.districtKeyMap;

    if (parsed.action === "grade" && session.selectedDistrictKey) {
      const selectedDistrict = session.districtKeyMap.get(session.selectedDistrictKey) ?? null;
      if (!selectedDistrict) {
        await interaction.editReply({
          content: "Select a district first.",
          embeds: [],
          components: [],
        });
        return;
      }

      const mark = await upsertRaidIntelDistrictLayoutMark({
        guildId: session.guildId,
        sourceClanTag: trackedClan.clanTag,
        raidSeasonStartTime: session.raidSeasonStartTime,
        defenderTag: selectedDistrict.defenderTag ?? "",
        districtName: selectedDistrict.name,
        districtHallLevel: selectedDistrict.districtHallLevel,
        layoutGrade: parsed.grade,
        markedByDiscordUserId: interaction.user.id,
      });
      if (!mark) {
        await interaction.editReply({
          content: "Failed to save raid intel layout mark.",
          embeds: [],
          components: [],
        });
        return;
      }

      const updatedPayload = await buildRaidIntelPayload({
        sessionId: parsed.sessionId,
        guildId: session.guildId,
        userId: session.userId,
        trackedClan,
        upgradesOverride: session.upgradesOverride,
        selectedDistrictKey: session.selectedDistrictKey,
        cocService,
        refreshing: false,
        source: "raids:intel:grade",
      });
      session.raidSeasonStartTime = updatedPayload.raidSeasonStartTime;
      session.selectedDistrictKey = updatedPayload.selectedDistrictKey;
      session.districtKeyMap = updatedPayload.districtKeyMap;
      await interaction.editReply({
        embeds: updatedPayload.embeds,
        components: updatedPayload.components,
      });
      return;
    }

    await interaction.editReply({
      embeds: currentPayload.embeds,
      components: currentPayload.components,
    });
  } catch (err) {
    console.error(`[raids] intel button interaction failed: ${formatError(err)}`);
    await interaction.followUp({
      ephemeral: true,
      content: "Failed to update the raid intel view.",
    });
  } finally {
    session.refreshing = false;
  }
}

async function buildRaidDashboardPayload(input: {
  sessionId: string;
  selectedClanTag: string | null;
  cocService: CoCService;
  refreshing: boolean;
  source: string;
  guildId?: string | null;
  rows?: RaidDashboardClanRow[];
  detailSource?: string | null;
}): Promise<{
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
  rows: RaidDashboardClanRow[];
}> {
  const rows =
    input.rows ??
    (await listRaidDashboardRowsWithQueueContext({
      cocService: input.cocService,
      source: input.source,
      guildId: input.guildId ?? null,
    }));
  const selectedRow = input.selectedClanTag ? findRaidDashboardClanRow(rows, input.selectedClanTag) : null;
  const effectiveSelectedTag = selectedRow ? normalizeRaidTrackedClanTag(selectedRow.clanTag) ?? selectedRow.clanTag : null;
  const detail =
    selectedRow && input.detailSource
      ? await loadRaidDashboardSeasonDetailWithQueueContext({
          cocService: input.cocService,
          clanTag: selectedRow.clanTag,
          source: input.detailSource,
        })
      : null;
  const embed = buildRaidDashboardEmbed(rows, selectedRow, detail);
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
      content: "This raids view expired. Run `/raids overview` again.",
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
      source: "raids:overview:select",
      guildId: session.guildId,
      rows: session.rows,
      detailSource: selectedClanTag ? "raids:overview:detail" : null,
    });
    if (payload.rows.length <= 0) {
      await interaction.editReply({
        content: "No RAIDS tracked clans in the database.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply({
      embeds: payload.embeds,
      components: payload.components,
    });
    session.rows = payload.rows;
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
      content: "This raids view expired. Run `/raids overview` again.",
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
      source: parsed.action === "refresh" ? "raids:overview:refresh" : "raids:overview:back",
      guildId: session.guildId,
      rows: parsed.action === "refresh" ? undefined : session.rows,
      detailSource:
        nextSelectedClanTag && parsed.action === "refresh"
          ? "raids:overview:detail:refresh"
          : nextSelectedClanTag
            ? "raids:overview:detail"
            : null,
    });
    if (payload.rows.length <= 0) {
      await interaction.editReply({
        content: "No RAIDS tracked clans in the database.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply({
      embeds: payload.embeds,
      components: payload.components,
    });
    session.rows = payload.rows;
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

export function isRaidsIntelSelectMenuCustomId(customId: string): boolean {
  const parsed = parseRaidIntelCustomId(customId);
  return parsed?.action === "select";
}

export function isRaidsIntelButtonCustomId(customId: string): boolean {
  const parsed = parseRaidIntelCustomId(customId);
  return parsed?.action === "refresh" || parsed?.action === "grade";
}

export const Raids: Command = {
  name: "raids",
  description: "Raid-focused dashboard for tracked RAID clans",
  options: [
    {
      name: "overview",
      description: "View tracked RAID clans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked RAID clan to show",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "intel",
      description: "View raid intel for one tracked RAID clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan",
          description: "Tracked RAID clan to inspect",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "upgrades",
          description: "Manual upgrades value to display",
          type: ApplicationCommandOptionType.Integer,
          required: false,
          minValue: 1000,
          maxValue: 3331,
        },
      ],
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
    let subcommand: string | null = null;
    try {
      subcommand = interaction.options.getSubcommand(false);
    } catch {
      subcommand = null;
    }
    if (subcommand === "overview") {
      const requestedClan = normalizeRaidTrackedClanTag(interaction.options.getString("clan", false) ?? "");
      const rows = await listRaidDashboardRowsWithQueueContext({
        cocService,
        source: "raids:overview",
        guildId: interaction.guildId ?? null,
      });
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
        rows,
        refreshing: false,
      });
      createSessionTimer(sessionId);

      const payload = await buildRaidDashboardPayload({
        sessionId,
        selectedClanTag: selectedRow ? normalizeRaidTrackedClanTag(selectedRow.clanTag) ?? selectedRow.clanTag : null,
        cocService,
        refreshing: false,
        source: "raids:overview",
        guildId: interaction.guildId ?? null,
        rows,
        detailSource: selectedRow ? "raids:overview:detail" : null,
      });
      await interaction.editReply({
        embeds: payload.embeds,
        components: payload.components,
      });
      return;
    }

    if (subcommand === "intel") {
      const trackedClans = await listRaidTrackedClansForDisplay();
      if (trackedClans.length <= 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "No RAIDS tracked clans in the database. Use `/tracked-clan raid-tags` first.",
        });
        return;
      }

      const requestedClan = normalizeRaidTrackedClanTag(interaction.options.getString("clan", false) ?? "");
      if (!requestedClan) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Choose a tracked RAID clan with `/raids intel clan:<tag>`.",
        });
        return;
      }

      const trackedClan =
        trackedClans.find((row) => (normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag) === requestedClan) ??
        null;
      if (!trackedClan) {
        await safeReply(interaction, {
          ephemeral: true,
          content: `No tracked RAID clan matched ${formatClanTag(requestedClan)}.`,
        });
        return;
      }

      const upgradesArg = interaction.options.getInteger("upgrades", false);
      const sessionId = interaction.id;
      raidsIntelSessions.set(sessionId, {
        guildId: interaction.guildId ?? null,
        userId: interaction.user.id,
        trackedClanTag: requestedClan,
        upgradesOverride: upgradesArg ?? null,
        raidSeasonStartTime: null,
        selectedDistrictKey: null,
        districtKeyMap: new Map<string, RaidIntelDistrict>(),
        refreshing: false,
      });
      createRaidIntelSessionTimer(sessionId);

      const payload = await buildRaidIntelPayload({
        sessionId,
        guildId: interaction.guildId ?? null,
        userId: interaction.user.id,
        trackedClan,
        upgradesOverride: upgradesArg ?? null,
        selectedDistrictKey: null,
        cocService,
        refreshing: false,
        source: "raids:intel",
      });
      const session = getRaidIntelSession(sessionId);
      if (session) {
        session.raidSeasonStartTime = payload.raidSeasonStartTime;
        session.selectedDistrictKey = payload.selectedDistrictKey;
        session.districtKeyMap = payload.districtKeyMap;
      }
      await interaction.editReply({
        embeds: payload.embeds,
        components: payload.components,
      });
      return;
    }

    if (subcommand !== "overview") {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unsupported raids subcommand. Use `/raids overview` or `/raids intel`.",
      });
      return;
    }
  },
};
