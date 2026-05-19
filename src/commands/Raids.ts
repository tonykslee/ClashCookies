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
  applyRaidIntelDefenderUpgrades,
  buildRaidDashboardOverviewDescription,
  buildRaidDashboardSelectChoices,
  buildRaidDashboardSingleClanDescription,
  buildRaidIntelLayoutGradeLabel,
  findRaidIntelDistrictByKey,
  findRaidDashboardClanRow,
  loadRaidIntelSeasonDetailWithQueueContext,
  loadRaidDashboardSeasonDetailWithQueueContext,
  listRaidDashboardRowsForSourceWithQueueContext,
  parseRaidSeasonTimeMs,
  resolveRaidIntelDefenderUpgrade,
  type RaidDashboardOverviewSourceMode,
  type RaidDashboardClanRow,
  type RaidIntelDistrict,
  type RaidIntelLayoutGrade,
  type RaidIntelLayoutGradeLabel,
} from "../services/RaidDashboardService";
import { normalizeRaidIntelLayoutGrade } from "../helper/raidIntelLayout";
import {
  normalizeRaidTrackedClanTag,
  listRaidTrackedClansForDisplay,
  loadRaidTrackedClanDisplayRowByTag,
  updateRaidTrackedClanUpgrades,
  type RaidTrackedClanDisplayRow,
} from "../services/RaidTrackedClanService";
import { listFwaTrackedClansForDisplay } from "../services/TrackedClanListService";
import { addRaidRosterMembersForGuild } from "../services/RaidRosterService";
import {
  loadRaidIntelDefenderProfileUpgradesForTags,
  upsertRaidIntelDefenderProfileUpgrades,
} from "../services/RaidIntelDefenderProfileService";
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
  sourceMode: RaidDashboardOverviewSourceMode;
  customClanTag: string | null;
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

type RaidIntelDistrictGradeArg = {
  optionName: string;
  districtDisplayName: string;
  districtMatchNames: string[];
  layoutGrade: RaidIntelLayoutGrade;
};

const RAID_INTEL_LAYOUT_GRADE_CHOICES = [
  { name: "Default", value: "DEFAULT" },
  { name: "Custom - Hard", value: "CUSTOM_HARD" },
  { name: "Custom - Medium", value: "CUSTOM_MEDIUM" },
  { name: "Custom - Easy", value: "CUSTOM_EASY" },
] as const;

const RAID_INTEL_DISTRICT_GRADE_OPTIONS = [
  {
    name: "capital_peak",
    displayName: "Capital Peak",
    matchNames: ["Capital Peak", "Capital Hall"],
  },
  {
    name: "barbarian_camp",
    displayName: "Barbarian Camp",
    matchNames: ["Barbarian Camp"],
  },
  {
    name: "wizard_valley",
    displayName: "Wizard Valley",
    matchNames: ["Wizard Valley"],
  },
  {
    name: "balloon_lagoon",
    displayName: "Balloon Lagoon",
    matchNames: ["Balloon Lagoon"],
  },
  {
    name: "builders_workshop",
    displayName: "Builder's Workshop",
    matchNames: ["Builder's Workshop", "Builders Workshop"],
  },
  {
    name: "dragon_cliffs",
    displayName: "Dragon Cliffs",
    matchNames: ["Dragon Cliffs"],
  },
  {
    name: "golem_quarry",
    displayName: "Golem Quarry",
    matchNames: ["Golem Quarry"],
  },
  {
    name: "skeleton_park",
    displayName: "Skeleton Park",
    matchNames: ["Skeleton Park"],
  },
  {
    name: "goblin_mines",
    displayName: "Goblin Mines",
    matchNames: ["Goblin Mines"],
  },
] as const;

const RAID_INTEL_SAVE_MARKS_ERROR_MESSAGE = "Failed to save raid intel layout marks.";

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

function normalizeRaidIntelDistrictMatchName(value: string): string {
  return String(value ?? "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatClanTag(tag: string): string {
  const normalized = normalizeRaidTrackedClanTag(tag);
  return normalized ? `#${normalized}` : tag.trim();
}

function normalizeRaidsOverviewSourceMode(value: string | null | undefined): RaidDashboardOverviewSourceMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "fwa") return "fwa";
  if (normalized === "custom") return "custom";
  return "raids";
}

function formatPlayerTagListForSummary(tags: string[]): string {
  return tags.length > 0 ? tags.join(", ") : "none";
}

function getRaidsOverviewNoRowsMessage(sourceMode: RaidDashboardOverviewSourceMode): string {
  if (sourceMode === "fwa") {
    return "No tracked FWA clans in the database. Use `/clan configure` first.";
  }
  if (sourceMode === "custom") {
    return "No clan data could be loaded for that tag.";
  }
  return "No RAIDS tracked clans in the database. Use `/clan raid-tags` first.";
}

function getRaidsOverviewNoMatchMessage(sourceMode: RaidDashboardOverviewSourceMode, clanTag: string): string {
  if (sourceMode === "custom") {
    return `No clan matched ${formatClanTag(clanTag)}.`;
  }
  if (sourceMode === "fwa") {
    return `No tracked FWA clan matched ${formatClanTag(clanTag)}.`;
  }
  return `No tracked RAID clan matched ${formatClanTag(clanTag)}.`;
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

function buildRaidIntelDistrictGradeArgs(interaction: ChatInputCommandInteraction): RaidIntelDistrictGradeArg[] {
  const args: RaidIntelDistrictGradeArg[] = [];
  for (const option of RAID_INTEL_DISTRICT_GRADE_OPTIONS) {
    const rawGrade = interaction.options.getString(option.name, false);
    if (rawGrade === null || rawGrade === undefined || String(rawGrade).trim().length <= 0) {
      continue;
    }
    const layoutGrade = normalizeRaidIntelLayoutGrade(rawGrade);
    if (!layoutGrade) continue;
    args.push({
      optionName: option.name,
      districtDisplayName: option.displayName,
      districtMatchNames: [...option.matchNames],
      layoutGrade,
    });
  }
  return args;
}

async function applyRaidIntelDistrictGradeArgs(input: {
  guildId: string | null;
  sourceClanTag: string;
  raidSeasonStartTime: Date | null;
  detail: Awaited<ReturnType<typeof loadRaidIntelSeasonDetailWithQueueContext>>;
  districtGradeArgs: RaidIntelDistrictGradeArg[];
  markedByDiscordUserId: string;
}): Promise<string | null> {
  if (!input.guildId || !input.raidSeasonStartTime || input.districtGradeArgs.length <= 0) {
    return null;
  }
  if (!input.detail.activeSeason || input.detail.defenders.length <= 0) {
    return null;
  }

  const districtsByName = new Map<
    string,
    Array<{
      defenderTag: string | null;
      districtName: string;
      districtHallLevel: number | null;
    }>
  >();
  for (const defender of input.detail.defenders) {
    for (const district of defender.districts) {
      const normalizedName = normalizeRaidIntelDistrictMatchName(district.name);
      if (!normalizedName) continue;
      const current = districtsByName.get(normalizedName) ?? [];
      current.push({
        defenderTag: defender.defenderTag,
        districtName: district.name,
        districtHallLevel: district.districtHallLevel,
      });
      districtsByName.set(normalizedName, current);
    }
  }

  const skippedDistricts: string[] = [];
  for (const districtArg of input.districtGradeArgs) {
    const matchedDistricts = new Map<
      string,
      {
        defenderTag: string | null;
        districtName: string;
        districtHallLevel: number | null;
      }
    >();
    for (const matchName of districtArg.districtMatchNames) {
      const normalizedName = normalizeRaidIntelDistrictMatchName(matchName);
      const candidates = districtsByName.get(normalizedName) ?? [];
      for (const candidate of candidates) {
        const candidateKey = `${candidate.defenderTag ?? ""}|${candidate.districtName}`;
        matchedDistricts.set(candidateKey, candidate);
      }
    }

    if (matchedDistricts.size <= 0) {
      skippedDistricts.push(districtArg.districtDisplayName);
      continue;
    }

    for (const district of matchedDistricts.values()) {
      try {
        const mark = await upsertRaidIntelDistrictLayoutMark({
          guildId: input.guildId,
          sourceClanTag: input.sourceClanTag,
          raidSeasonStartTime: input.raidSeasonStartTime,
          defenderTag: district.defenderTag ?? "",
          districtName: district.districtName,
          districtHallLevel: district.districtHallLevel,
          layoutGrade: districtArg.layoutGrade,
          markedByDiscordUserId: input.markedByDiscordUserId,
        });
        if (!mark) {
          throw new Error(RAID_INTEL_SAVE_MARKS_ERROR_MESSAGE);
        }
      } catch (err) {
        console.error(
          `[raids] intel slash-arg save failed | clan=${input.sourceClanTag} | season=${
            input.raidSeasonStartTime?.toISOString() ?? "unknown"
          } | arg=${districtArg.optionName} | district=${district.districtName} | ${formatError(err)}`,
        );
        throw new Error(RAID_INTEL_SAVE_MARKS_ERROR_MESSAGE);
      }
    }
  }

  return skippedDistricts.length > 0
    ? skippedDistricts.map((districtName) => `Skipped: ${districtName} was not found in current intel data.`).join("\n")
    : null;
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
  detail: Awaited<ReturnType<typeof loadRaidIntelSeasonDetailWithQueueContext>>;
  selectedDistrictLabel?: string | null;
  controlsHint?: string | null;
  districtArgsNote?: string | null;
  districtControlsNote?: string | null;
  upgradesNote?: string | null;
}) {
  return new EmbedBuilder()
    .setTitle("Raid Intel")
    .setDescription(
      buildRaidIntelDescription({
        trackedClan: input.trackedClan,
        detail: input.detail,
        selectedDistrictLabel: input.selectedDistrictLabel,
        controlsHint: input.controlsHint,
        districtArgsNote: input.districtArgsNote,
        districtControlsNote: input.districtControlsNote,
        upgradesNote: input.upgradesNote,
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
  upgradesArg: number | null;
  selectedDistrictKey: string | null;
  districtGradeArgs: RaidIntelDistrictGradeArg[];
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
  const [trackedClan, trackedClans] = await Promise.all([
    loadRaidTrackedClanDisplayRowByTag({ clanTag: input.trackedClan.clanTag }),
    listRaidTrackedClansForDisplay(),
  ]);
  const currentTrackedClan = trackedClan ?? input.trackedClan;
  const trackedClanByTag = new Map(
    trackedClans.map((row) => [normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag, row] as const),
  );
  const detail = await loadRaidIntelSeasonDetailWithQueueContext({
    cocService: input.cocService,
    clanTag: currentTrackedClan.clanTag,
    source: input.source,
  });

  const defenderTags = [
    ...new Set(
      detail.defenders
        .map((defender) => normalizeRaidTrackedClanTag(defender.defenderTag ?? ""))
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ];
  let upgradesNote: string | null = null;
  if (input.upgradesArg !== null) {
    if (defenderTags.length === 1) {
      const defenderTag = defenderTags[0]!;
      const trackedDefender = trackedClanByTag.get(defenderTag) ?? null;
      if (trackedDefender) {
        const persistedTrackedDefender = await updateRaidTrackedClanUpgrades({
          clanTag: defenderTag,
          upgrades: input.upgradesArg,
        });
        if (persistedTrackedDefender) {
          trackedClanByTag.set(defenderTag, persistedTrackedDefender);
        }
      } else {
        await upsertRaidIntelDefenderProfileUpgrades({
          guildId: input.guildId,
          defenderTag,
          upgrades: input.upgradesArg,
        });
      }
    } else {
      upgradesNote = "Upgrades were not saved because the attacked clan was ambiguous.";
    }
  }

  const seasonStartMs = detail.activeSeason?.startTime
    ? parseRaidSeasonTimeMs(detail.activeSeason.startTime)
    : null;
  const seasonStart = seasonStartMs === null ? null : new Date(seasonStartMs);
  const districtArgsNote = await applyRaidIntelDistrictGradeArgs({
    guildId: input.guildId,
    sourceClanTag: currentTrackedClan.clanTag,
    raidSeasonStartTime: seasonStart,
    detail,
    districtGradeArgs: input.districtGradeArgs,
    markedByDiscordUserId: input.userId,
  });
  const gradeLookup =
    detail.activeSeason && input.guildId
        ? await loadRaidIntelLayoutGradeLookupForSeason({
          guildId: input.guildId,
          sourceClanTag: currentTrackedClan.clanTag,
          raidSeasonStartTime: seasonStart,
        })
      : new Map<string, RaidIntelLayoutGradeLabel>();
  const defenderProfileUpgradesByTag = await loadRaidIntelDefenderProfileUpgradesForTags({
    guildId: input.guildId,
    defenderTags,
  });
  const defenderUpgradesByTag = new Map<string, number | null>();
  for (const defender of detail.defenders) {
    const defenderTag = normalizeRaidTrackedClanTag(defender.defenderTag ?? "");
    if (!defenderTag) continue;
    defenderUpgradesByTag.set(
      defenderTag,
      resolveRaidIntelDefenderUpgrade({
        defenderTag,
        trackedClanByTag,
        defenderProfileUpgradesByTag,
      }),
    );
  }
  const markedDetail = applyRaidIntelLayoutGrades(
    applyRaidIntelDefenderUpgrades(detail, defenderUpgradesByTag),
    gradeLookup,
  );
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
    trackedClan: currentTrackedClan,
    detail: markedDetail,
    selectedDistrictLabel,
    controlsHint,
    districtArgsNote,
    districtControlsNote,
    upgradesNote,
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
      upgradesArg: null,
      selectedDistrictKey: session.selectedDistrictKey,
      districtGradeArgs: [],
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
      upgradesArg: null,
      selectedDistrictKey: session.selectedDistrictKey,
      districtGradeArgs: [],
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
        upgradesArg: null,
        selectedDistrictKey: session.selectedDistrictKey,
        districtGradeArgs: [],
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
  sourceMode: RaidDashboardOverviewSourceMode;
  guildId?: string | null;
  customClanTag?: string | null;
  rows?: RaidDashboardClanRow[];
  detailSource?: string | null;
}): Promise<{
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>>;
  rows: RaidDashboardClanRow[];
}> {
  const rows =
    input.rows ??
    (await listRaidDashboardRowsForSourceWithQueueContext({
      cocService: input.cocService,
      sourceMode: input.sourceMode,
      guildId: input.guildId ?? null,
      customClanTag: input.customClanTag ?? null,
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

async function loadRaidAutocompleteChoices(
  query: string,
  sourceMode: RaidDashboardOverviewSourceMode,
): Promise<Array<{ name: string; value: string }>> {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (sourceMode === "custom") {
    return [];
  }

  const clans: Array<
    | { clanTag: string; name: string | null }
    | { tag: string; name: string | null }
  > =
    sourceMode === "fwa"
      ? await listFwaTrackedClansForDisplay()
      : await prisma.raidTrackedClan.findMany({
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
      const tag = normalizeRaidTrackedClanTag("clanTag" in clan ? clan.clanTag : clan.tag);
      if (!tag) return null;
      const clanName = clan.name?.trim() ?? "";
      const label = clanName ? `${clanName} (#${tag})` : `#${tag}`;
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
      sourceMode: session.sourceMode,
      customClanTag: session.customClanTag,
      guildId: session.guildId,
      rows: session.rows,
      detailSource: selectedClanTag ? "raids:overview:detail" : null,
    });
    if (payload.rows.length <= 0) {
      await interaction.editReply({
        content: getRaidsOverviewNoRowsMessage(session.sourceMode),
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
      sourceMode: session.sourceMode,
      customClanTag: session.customClanTag,
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
        content: getRaidsOverviewNoRowsMessage(session.sourceMode),
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
          name: "type",
          description: "Raid dashboard source",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "raids", value: "raids" },
            { name: "fwa", value: "fwa" },
            { name: "custom", value: "custom" },
          ],
        },
        {
          name: "clan",
          description: "Clan tag or tracked source clan to show",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "roster",
      description: "Manage the main raids roster",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "add",
          description: "Add player tags to the main raids roster",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "tag",
              description: "Player tag or tag list to add",
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
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
        ...RAID_INTEL_DISTRICT_GRADE_OPTIONS.map((option) => ({
          name: option.name,
          description: `Pre-mark the ${option.displayName} layout grade`,
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: RAID_INTEL_LAYOUT_GRADE_CHOICES.map((choice) => ({
            name: choice.name,
            value: choice.value,
          })),
        })),
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

    const subcommand = interaction.options.getSubcommand(false);
    const sourceMode =
      subcommand === "overview"
        ? normalizeRaidsOverviewSourceMode(interaction.options.getString("type", false))
        : "raids";
    if (sourceMode === "custom") {
      await interaction.respond([]);
      return;
    }

    const choices = await loadRaidAutocompleteChoices(String(query.value ?? ""), sourceMode);
    await interaction.respond(choices);
  },
  run: async (_client: Client, interaction: ChatInputCommandInteraction, cocService: CoCService) => {
    await interaction.deferReply({ ephemeral: true });
    let subcommandGroup: string | null = null;
    let subcommand: string | null = null;
    try {
      subcommandGroup = interaction.options.getSubcommandGroup(false);
      subcommand = interaction.options.getSubcommand(false);
    } catch {
      subcommandGroup = null;
      subcommand = null;
    }
    if (subcommand === "overview") {
      const sourceMode = normalizeRaidsOverviewSourceMode(interaction.options.getString("type", false));
      const rawClan = interaction.options.getString("clan", false) ?? "";
      const requestedClan = normalizeRaidTrackedClanTag(rawClan);
      if (rawClan.trim().length > 0 && !requestedClan) {
        await safeReply(interaction, {
          ephemeral: true,
          content:
            sourceMode === "custom"
              ? "Choose a valid clan with `/raids overview type:custom clan:<tag>`."
              : sourceMode === "fwa"
                ? "Choose a valid FWA clan tag with `/raids overview type:fwa clan:<tag>`."
                : "Choose a valid RAID clan tag with `/raids overview type:raids clan:<tag>`.",
        });
        return;
      }
      if (sourceMode === "custom" && !requestedClan) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Choose a valid clan with `/raids overview type:custom clan:<tag>`.",
        });
        return;
      }

      const rows = await listRaidDashboardRowsForSourceWithQueueContext({
        cocService,
        guildId: interaction.guildId ?? null,
        sourceMode,
        customClanTag: sourceMode === "custom" ? requestedClan ?? null : null,
      });
      if (rows.length <= 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: getRaidsOverviewNoRowsMessage(sourceMode),
        });
        return;
      }

      const requestedSelection = requestedClan;
      const selectedRow = requestedSelection ? findRaidDashboardClanRow(rows, requestedSelection) : null;
      if (requestedSelection && !selectedRow) {
        await safeReply(interaction, {
          ephemeral: true,
          content: getRaidsOverviewNoMatchMessage(sourceMode, requestedSelection),
        });
        return;
      }

      const sessionId = interaction.id;
      raidsDashboardSessions.set(sessionId, {
        guildId: interaction.guildId ?? null,
        userId: interaction.user.id,
        sourceMode,
        customClanTag: sourceMode === "custom" ? requestedClan ?? null : null,
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
        sourceMode,
        customClanTag: sourceMode === "custom" ? requestedClan ?? null : null,
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

    if (subcommandGroup === "roster" && subcommand === "add") {
      if (!interaction.guildId) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "This command can only be used in a server.",
        });
        return;
      }

      const rawTags = interaction.options.getString("tag", true);
      const result = await addRaidRosterMembersForGuild({
        guildId: interaction.guildId,
        rawTags,
        createdByDiscordUserId: interaction.user.id,
      });

      await safeReply(interaction, {
        ephemeral: true,
        content: [
          "Updated RAIDS roster.",
          `added: ${formatPlayerTagListForSummary(result.added)}`,
          `already on roster: ${formatPlayerTagListForSummary(result.alreadyOnRoster)}`,
          `invalid: ${formatPlayerTagListForSummary(result.invalidTags)}`,
        ].join("\n"),
      });
      return;
    }

    if (subcommand === "intel") {
      const trackedClans = await listRaidTrackedClansForDisplay();
      if (trackedClans.length <= 0) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "No RAIDS tracked clans in the database. Use `/clan raid-tags` first.",
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

      try {
        const payload = await buildRaidIntelPayload({
          sessionId,
          guildId: interaction.guildId ?? null,
          userId: interaction.user.id,
          trackedClan,
          upgradesArg,
          selectedDistrictKey: null,
          districtGradeArgs: buildRaidIntelDistrictGradeArgs(interaction),
          cocService,
          refreshing: false,
          source: "raids:intel",
        });
        const session = getRaidIntelSession(sessionId);
        if (session) {
          session.raidSeasonStartTime = payload.raidSeasonStartTime;
          session.selectedDistrictKey = payload.selectedDistrictKey;
          session.districtKeyMap = payload.districtKeyMap;
        } else {
          raidsIntelSessions.set(sessionId, {
            guildId: interaction.guildId ?? null,
            userId: interaction.user.id,
            trackedClanTag: requestedClan,
            upgradesOverride: null,
            raidSeasonStartTime: payload.raidSeasonStartTime,
            selectedDistrictKey: payload.selectedDistrictKey,
            districtKeyMap: payload.districtKeyMap,
            refreshing: false,
          });
          createRaidIntelSessionTimer(sessionId);
        }
        await interaction.editReply({
          embeds: payload.embeds,
          components: payload.components,
        });
      } catch (err) {
        const errorMessage = formatError(err);
        if (errorMessage.includes(RAID_INTEL_SAVE_MARKS_ERROR_MESSAGE)) {
          await safeReply(interaction, {
            ephemeral: true,
            content: RAID_INTEL_SAVE_MARKS_ERROR_MESSAGE,
          });
          return;
        }
        console.error(`[raids] intel command failed: ${errorMessage}`);
        await safeReply(interaction, {
          ephemeral: true,
          content: "Failed to update the raid intel view.",
        });
      }
      return;
    }

    if (subcommand !== "overview") {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Unsupported raids subcommand. Use `/raids overview`, `/raids intel`, or `/raids roster add`.",
      });
      return;
    }
  },
};
