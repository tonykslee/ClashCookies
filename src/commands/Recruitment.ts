import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { SettingsService } from "../services/SettingsService";
import {
  formatClanTag,
  getRecruitmentCooldown,
  getRecruitmentCooldownDurationMs,
  getRecruitmentTemplate,
  getTrackedClanNameMapByTags,
  listRecruitmentCooldownsForUser,
  normalizeClanTag,
  parseImageUrlsCsv,
  parseRecruitmentPlatform,
  RecruitmentPlatform,
  startOrResetRecruitmentCooldown,
  toImageUrlsCsv,
  upsertRecruitmentTemplate,
} from "../services/RecruitmentService";
import {
  autocompleteRecruitmentTimeZones,
  getDateKeyInTimeZone,
  formatRecruitmentReminderTime,
  formatRecruitmentReminderBody,
  formatRecruitmentReminderWindowSummaryInTimeZone,
  formatRecruitmentReminderRhythmSummaryInTimeZone,
  getNextRecruitmentReminderSlot,
  getRecruitmentReminderSlotCandidates,
  normalizeRecruitmentTimezone,
  recruitmentReminderService,
} from "../services/RecruitmentReminderService";
import { getSupportedSyncTimeZones } from "../services/syncTimeZone";

const RECRUITMENT_MODAL_PREFIX = "recruitment-edit";
const DISCORD_CLAN_TAG_INPUT_ID = "discord-clan-tag";
const REDDIT_SUBJECT_INPUT_ID = "reddit-subject";
const BODY_INPUT_ID = "body";
const IMAGE_URLS_INPUT_ID = "image-urls";
const DISCORD_RECRUITMENT_CHANNEL_URL =
  "https://discord.com/channels/236523452230533121/1058589765508800644";
const PANEL_TIMEOUT_MS = 10 * 60 * 1000;

const PLATFORM_CHOICES = [
  { name: "discord", value: "discord" },
  { name: "reddit", value: "reddit" },
  { name: "band", value: "band" },
] as const;

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function formatPlatform(platform: RecruitmentPlatform): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function sanitizeBodyForBand(body: string): string {
  const bannedPattern = /\b(alliance|alliances|family|families|discord|server|giveaway|giveaways)\b/i;
  return body
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !bannedPattern.test(line))
    .join("\n")
    .trim();
}

function doubleBacktickBlock(content: string): string {
  return formatRecruitmentReminderBody(content);
}

function parseModalCustomId(
  customId: string
): { userId: string; clanTag: string; platform: RecruitmentPlatform } | null {
  const parts = customId.split(":");
  if (parts.length !== 4) return null;
  if (parts[0] !== RECRUITMENT_MODAL_PREFIX) return null;
  const userId = parts[1]?.trim() ?? "";
  const clanTag = normalizeClanTag(parts[2] ?? "");
  const platform = parseRecruitmentPlatform(parts[3] ?? "");
  if (!userId || !clanTag || !platform) return null;
  return { userId, clanTag, platform };
}

function buildModalCustomId(
  userId: string,
  clanTag: string,
  platform: RecruitmentPlatform
): string {
  return `${RECRUITMENT_MODAL_PREFIX}:${userId}:${normalizeClanTag(clanTag)}:${platform}`;
}

function isValidRedditSubject(subject: string): boolean {
  const pattern =
    /^\[Recruiting\]\s+[^|]+\s+\|\s+#?[A-Z0-9]+\s+\|\s+[^|]+\s+\|\s+[^|]+\s+\|\s+FWA\s+\|\s+Discord$/i;
  return pattern.test(subject.trim());
}

function mapTrackedLabel(name: string | null | undefined, tag: string): string {
  const cleaned = name?.trim();
  return cleaned ? `${cleaned} (${formatClanTag(tag)})` : formatClanTag(tag);
}

async function findTrackedClan(clanTag: string): Promise<{ tag: string; name: string | null } | null> {
  const normalized = normalizeClanTag(clanTag);
  const row = await prisma.trackedClan.findFirst({
    where: {
      OR: [
        { tag: { equals: `#${normalized}`, mode: "insensitive" } },
        { tag: { equals: normalized, mode: "insensitive" } },
      ],
    },
    select: { tag: true, name: true },
  });
  if (!row) return null;
  return { tag: normalizeClanTag(row.tag), name: row.name?.trim() ?? null };
}

function buildDiscordShowMessage(input: {
  clanName: string;
  clanTag: string;
  body: string;
  imageUrls: string[];
  cooldownLine: string;
}): string {
  const lines = [
    `## Recruitment - Discord`,
    `Clan Tag: \`${formatClanTag(input.clanTag)}\``,
    `Clan: **${input.clanName}**`,
    "",
    `Recruitment Contents (${input.body.length}/1024):`,
    doubleBacktickBlock(input.body),
  ];

  if (input.imageUrls.length > 0) {
    lines.push("", "Suggested Image URLs:", ...input.imageUrls.map((url) => `- ${url}`));
  }

  lines.push(
    "",
    "Instructions:",
    `- Go to ${DISCORD_RECRUITMENT_CHANNEL_URL}`,
    "- Type `/post` in that channel and fill clan tag, recruitment contents, image URL, and language.",
    "- Copy/paste the body from the double-backtick block below.",
    "",
    input.cooldownLine
  );

  return lines.join("\n");
}

function buildBandShowMessage(input: {
  clanName: string;
  clanTag: string;
  body: string;
  imageUrls: string[];
  cooldownLine: string;
}): string {
  const sanitizedBody = sanitizeBodyForBand(input.body);
  const lines = [
    `## Recruitment - Band`,
    `Clan Tag: \`${formatClanTag(input.clanTag)}\``,
    `Clan: **${input.clanName}**`,
    "⚠️ Do NOT mention alliances, families, or Discord servers.",
    "",
    "Recruitment Contents:",
    doubleBacktickBlock(sanitizedBody),
  ];

  if (input.imageUrls.length > 0) {
    lines.push("", "Suggested Image URLs:", ...input.imageUrls.map((url) => `- ${url}`));
  }

  lines.push(
    "",
    "Destination:",
    "- https://www.band.us/band/67130116/post",
    "",
    input.cooldownLine,
  );
  return lines.join("\n");
}

function buildRedditShowMessage(input: {
  clanName: string;
  clanTag: string;
  subject: string;
  body: string;
  imageUrls: string[];
  cooldownLine: string;
}): string {
  const noGiveawayBody = input.body
    .split(/\r?\n/)
    .filter((line) => !/\bgiveaway|giveaways\b/i.test(line))
    .join("\n")
    .trim();
  return [
    "## Recruitment - Reddit",
    `Clan Tag: \`${formatClanTag(input.clanTag)}\``,
    "",
    "Subject:",
    `\`${input.subject}\``,
    "",
    "Recruitment Contents:",
    doubleBacktickBlock(noGiveawayBody),
    "",
    "Rules:",
    "- No giveaway mentions.",
    "- Once per 7 days per account.",
    "",
    "Destination:",
    "- https://www.reddit.com/r/ClashOfClansRecruit/",
    "",
    input.cooldownLine,
  ].join("\n");
}

function buildCooldownLine(cooldownExpiresAt: Date | null): string {
  if (!cooldownExpiresAt) {
    return "Cooldown: Ready now (no active cooldown).";
  }
  const now = Date.now();
  if (cooldownExpiresAt.getTime() <= now) {
    return "Cooldown: Ready now.";
  }
  const unix = toUnixSeconds(cooldownExpiresAt);
  return `Cooldown: Active until <t:${unix}:F> (<t:${unix}:R>).`;
}

const RECRUITMENT_DASHBOARD_PREFIX = "recruitment-dashboard";

type RecruitmentDashboardScope = "overview" | "clan" | "schedule";
type RecruitmentDashboardOverviewTab = "timers" | "scripts" | "optimize";
type RecruitmentDashboardClanTab = "discord" | "reddit" | "band";

type RecruitmentDashboardState = {
  scope: RecruitmentDashboardScope;
  overviewTab: RecruitmentDashboardOverviewTab;
  clanTag: string | null;
  clanTab: RecruitmentDashboardClanTab;
  timezone: string;
  reminderDayKey: string | null;
  reminderTimeIso: string | null;
};

type RecruitmentDashboardTrackedClan = {
  tag: string;
  name: string | null;
  shortName: string | null;
};

type RecruitmentDashboardTemplateRow = {
  clanTag: string;
  platform: RecruitmentPlatform;
  subject: string | null;
  body: string;
  imageUrls: string[];
};

function makeRecruitmentDashboardState(input?: Partial<RecruitmentDashboardState>): RecruitmentDashboardState {
  return {
    scope: input?.scope ?? "overview",
    overviewTab: input?.overviewTab ?? "timers",
    clanTag: input?.clanTag ?? null,
    clanTab: input?.clanTab ?? "discord",
    timezone: input?.timezone ?? "America/Los_Angeles",
    reminderDayKey: input?.reminderDayKey ?? null,
    reminderTimeIso: input?.reminderTimeIso ?? null,
  };
}

function recruitmentDashboardCustomId(sessionId: string, action: string): string {
  return `${RECRUITMENT_DASHBOARD_PREFIX}:${sessionId}:${action}`;
}

function parseRecruitmentDashboardCustomId(customId: string): { sessionId: string; action: string } | null {
  const parts = String(customId ?? "").split(":");
  if (parts.length < 3) return null;
  if (parts[0] !== RECRUITMENT_DASHBOARD_PREFIX) return null;
  const sessionId = parts[1]?.trim() ?? "";
  const action = parts.slice(2).join(":").trim();
  if (!sessionId || !action) return null;
  return { sessionId, action };
}

function formatRecruitmentPlatformChoice(platform: RecruitmentPlatform): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function formatClanLabel(tag: string, name: string | null): string {
  return name?.trim() ? `${name.trim()} (${formatClanTag(tag)})` : formatClanTag(tag);
}

function fallbackTrackedClanShortLabel(name: string | null, tag: string): string {
  const source = (name?.trim() || formatClanTag(tag)).toUpperCase();
  const alphanumeric = source.replace(/[^A-Z0-9]/g, "");
  const condensed = alphanumeric.length > 0 ? alphanumeric : source.replace(/\s+/g, "");
  if (condensed.length >= 3) return condensed.slice(0, 3);
  const fallbackTag = normalizeClanTag(tag);
  return (condensed + fallbackTag).slice(0, 3);
}

function formatRecruitmentDashboardClanShortLabel(input: {
  name: string | null;
  shortName: string | null;
  tag: string;
}): string {
  const shortName = input.shortName?.trim().toUpperCase() ?? "";
  return shortName.length > 0 ? shortName : fallbackTrackedClanShortLabel(input.name, input.tag);
}

function recruitmentDashboardTimezoneKey(userId: string): string {
  return `user_timezone:${userId}`;
}

async function resolveRecruitmentDashboardTimezone(input: {
  settings: SettingsService;
  userId: string;
  timezoneSeedRaw: string | null;
}): Promise<string> {
  const provided = input.timezoneSeedRaw ? normalizeRecruitmentTimezone(input.timezoneSeedRaw) : null;
  if (input.timezoneSeedRaw && !provided) {
    throw new Error("invalid_timezone");
  }

  const rememberedRaw = await input.settings.get(recruitmentDashboardTimezoneKey(input.userId));
  const remembered = normalizeRecruitmentTimezone(rememberedRaw);
  const resolved = provided ?? remembered ?? "UTC";
  await input.settings.set(recruitmentDashboardTimezoneKey(input.userId), resolved);
  return resolved;
}

async function persistRecruitmentDashboardTimezone(
  settings: SettingsService,
  userId: string,
  timezone: string,
): Promise<void> {
  const normalized = normalizeRecruitmentTimezone(timezone) ?? "UTC";
  await settings.set(recruitmentDashboardTimezoneKey(userId), normalized);
}

function stepRecruitmentDashboardTimezone(
  currentTimezone: string,
  delta: -1 | 1,
  referenceDate = new Date(),
): string {
  const zones = getSupportedSyncTimeZones(referenceDate);
  const current = normalizeRecruitmentTimezone(currentTimezone) ?? "UTC";
  const index = zones.indexOf(current);
  const baseIndex = index >= 0 ? index : zones.indexOf("UTC");
  if (zones.length === 0 || baseIndex < 0) return "UTC";
  const nextIndex = (baseIndex + delta + zones.length) % zones.length;
  return zones[nextIndex] ?? "UTC";
}

function buildRecruitmentDashboardTimezoneControls(input: { sessionId: string }): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(recruitmentDashboardCustomId(input.sessionId, "timezone:prev"))
      .setLabel("TZ -")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(recruitmentDashboardCustomId(input.sessionId, "timezone:next"))
      .setLabel("TZ +")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function loadRecruitmentDashboardData(guildId: string, userId: string): Promise<{
  trackedClans: RecruitmentDashboardTrackedClan[];
  templates: Map<string, RecruitmentDashboardTemplateRow>;
  cooldowns: Map<string, Date>;
}> {
  const [trackedClans, templates, cooldowns] = await Promise.all([
    prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { tag: true, name: true, shortName: true },
    }),
    prisma.recruitmentTemplate.findMany({
      where: { guildId },
      select: { clanTag: true, platform: true, subject: true, body: true, imageUrls: true },
    }),
    prisma.recruitmentCooldown.findMany({
      where: { guildId, userId },
      select: { clanTag: true, platform: true, expiresAt: true },
    }),
  ]);

  return {
    trackedClans: trackedClans.map((row) => ({
      tag: normalizeClanTag(row.tag),
      name: row.name?.trim() || null,
      shortName: row.shortName?.trim() || null,
    })),
    templates: new Map(
      templates.map((row) => [
        `${normalizeClanTag(row.clanTag)}:${String(row.platform)}`,
        {
          clanTag: normalizeClanTag(row.clanTag),
          platform: row.platform as RecruitmentPlatform,
          subject: row.subject ?? null,
          body: row.body,
          imageUrls: row.imageUrls ?? [],
        },
      ]),
    ),
    cooldowns: new Map(
      cooldowns.map((row) => [`${normalizeClanTag(row.clanTag)}:${row.platform}`, row.expiresAt]),
    ),
  };
}

function buildRecruitmentDashboardEmbed(input: {
  state: RecruitmentDashboardState;
  data: Awaited<ReturnType<typeof loadRecruitmentDashboardData>>;
  nowMs: number;
}): EmbedBuilder {
  const state = input.state;
  const tracked = input.data.trackedClans;
  const lines: string[] = [];

  lines.push(`Timezone: \`${state.timezone}\``);
  if (state.scope === "overview") {
    lines.push("Scope: Alliance Overview");
    if (state.overviewTab === "timers") {
      lines.push("", "Active recruitment timers:");
      const now = input.nowMs;
      const timerLines = tracked.flatMap((clan) => {
        const rowLines: string[] = [];
        for (const platform of ["discord", "reddit", "band"] as RecruitmentPlatform[]) {
          const key = `${clan.tag}:${platform}`;
          const expiresAt = input.data.cooldowns.get(key) ?? null;
          if (!expiresAt || expiresAt.getTime() <= now) continue;
          rowLines.push(
            `- ${formatClanLabel(clan.tag, clan.name)} | ${formatRecruitmentPlatformChoice(platform)} | <t:${toUnixSeconds(
              expiresAt,
            )}:R>`,
          );
        }
        return rowLines;
      });
      lines.push(...(timerLines.length > 0 ? timerLines : ["No active recruitment timers."]));
    } else if (state.overviewTab === "scripts") {
      lines.push("", "Stored template coverage:");
      if (tracked.length <= 0) {
        lines.push("No tracked clans configured.");
      } else {
        const tableLines = [
          "Clan".padEnd(8),
          "Discord".padEnd(10),
          "Reddit".padEnd(10),
          "Band".padEnd(10),
        ];
        const rows = tracked.map((clan) => {
          const label = formatRecruitmentDashboardClanShortLabel(clan).slice(0, 8).padEnd(8);
          const discord = input.data.templates.has(`${clan.tag}:discord`) ? "✓" : "";
          const reddit = input.data.templates.has(`${clan.tag}:reddit`) ? "✓" : "";
          const band = input.data.templates.has(`${clan.tag}:band`) ? "✓" : "";
          return [
            label,
            discord.padEnd(10),
            reddit.padEnd(10),
            band.padEnd(10),
          ].join(" | ");
        });
        lines.push("```text", tableLines.join(" | "), ...rows, "```");
      }
    } else {
      lines.push("", "Optimization guide:");
      for (const platform of ["discord", "reddit", "band"] as RecruitmentPlatform[]) {
        const now = new Date(input.nowMs);
        const windows = formatRecruitmentReminderWindowSummaryInTimeZone(platform, state.timezone, now);
        const nextSlots = getRecruitmentReminderSlotCandidates({
          platform,
          timezone: state.timezone,
          after: now,
        })
          .slice(0, 3)
          .map((slot) => `\`${formatRecruitmentReminderTime(slot, state.timezone)}\``)
          .join("\n    - ");
        lines.push(
          `- ${formatRecruitmentPlatformChoice(platform)}`,
          `  - Best windows: ${windows}`,
          `  - Rhythm: ${formatRecruitmentReminderRhythmSummaryInTimeZone(platform, state.timezone, now)}`,
          "  - Next recommended slots:",
          nextSlots ? `    - ${nextSlots}` : "    - no upcoming slots",
        );
      }
    }
  } else if (state.scope === "clan" && state.clanTag) {
    const clan = tracked.find((row) => row.tag === state.clanTag) ?? null;
    const platform = state.clanTab;
    const template = input.data.templates.get(`${state.clanTag}:${platform}`) ?? null;
    lines.push(`Scope: ${formatClanLabel(state.clanTag, clan?.name ?? null)}`);
    lines.push(`Platform: ${formatRecruitmentPlatformChoice(platform)}`);
    if (!template) {
      lines.push("", "No stored template for this platform.");
    } else if (platform === "discord") {
      lines.push("", buildDiscordShowMessage({
        clanName: clan?.name ?? state.clanTag,
        clanTag: state.clanTag,
        body: template.body,
        imageUrls: template.imageUrls,
        cooldownLine: buildCooldownLine(input.data.cooldowns.get(`${state.clanTag}:${platform}`) ?? null),
      }));
      lines.push("", "Destination:", `- ${DISCORD_RECRUITMENT_CHANNEL_URL}`);
    } else if (platform === "band") {
      lines.push("", buildBandShowMessage({
        clanName: clan?.name ?? state.clanTag,
        clanTag: state.clanTag,
        body: template.body,
        imageUrls: template.imageUrls,
        cooldownLine: buildCooldownLine(input.data.cooldowns.get(`${state.clanTag}:${platform}`) ?? null),
      }));
    } else {
      lines.push("", buildRedditShowMessage({
        clanName: clan?.name ?? state.clanTag,
        clanTag: state.clanTag,
        subject: template.subject ?? "",
        body: template.body,
        imageUrls: template.imageUrls,
        cooldownLine: buildCooldownLine(input.data.cooldowns.get(`${state.clanTag}:${platform}`) ?? null),
      }));
    }
  } else if (state.scope === "schedule" && state.clanTag) {
    const clan = tracked.find((row) => row.tag === state.clanTag) ?? null;
    const platform = state.clanTab;
    const template = input.data.templates.get(`${state.clanTag}:${platform}`) ?? null;
    const cooldown = input.data.cooldowns.get(`${state.clanTag}:${platform}`) ?? null;
    const now = new Date(input.nowMs);
    const slots = getRecruitmentReminderSlotCandidates({
      platform,
      timezone: state.timezone,
      after: now,
      cooldownExpiresAt: cooldown ?? null,
    });
    const selectedDayKey = state.reminderDayKey;
    const dayOptions = [
      ...new Map(
        slots.map((slot) => {
          const key = getDateKeyInTimeZone(slot, state.timezone);
          return [key, key] as const;
        }),
      ).values(),
    ].slice(0, 25);
    const dayLabel = selectedDayKey ?? dayOptions[0] ?? "none";
    lines.push(`Scheduling reminder for ${formatClanLabel(state.clanTag, clan?.name ?? null)}`);
    lines.push(`Platform: ${formatRecruitmentPlatformChoice(platform)}`);
    lines.push(`Timezone: \`${state.timezone}\``);
    lines.push("");
    lines.push(
      template
        ? "Select a day and time in 30-minute increments within the optimized posting windows."
        : "No stored template exists for this platform. Remind creation is unavailable.",
    );
    lines.push(
      template ? `Recommended: ${formatRecruitmentReminderRhythmSummaryInTimeZone(platform, state.timezone, now)}` : "",
    );
    if (cooldown) {
      lines.push(`Cooldown: active until <t:${toUnixSeconds(cooldown)}:R>`);
    } else {
      lines.push("Cooldown: ready now");
    }
    lines.push(`Day choice: ${dayLabel}`);
  }

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Recruitment Dashboard")
    .setDescription(truncateDiscordContent(lines.join("\n")))
    .setFooter({
      text: state.scope === "overview" ? "Alliance Overview" : state.scope === "schedule" ? "Reminder Scheduling" : "Clan View",
    });
}

function buildRecruitmentDashboardComponents(input: {
  state: RecruitmentDashboardState;
  data: Awaited<ReturnType<typeof loadRecruitmentDashboardData>>;
  sessionId: string;
}): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
  const state = input.state;
  const tracked = input.data.trackedClans;
  const dropdown = new StringSelectMenuBuilder()
    .setCustomId(recruitmentDashboardCustomId(input.sessionId, "scope"))
    .setMinValues(1)
    .setMaxValues(1)
    .setPlaceholder("Select alliance overview or a clan");

  const menuOptions = [
    {
      label: "Alliance Overview",
      value: "overview",
      description: "Alliance-wide timers, scripts, and optimize guidance",
      default: state.scope === "overview",
    },
    ...tracked.slice(0, 24).map((clan) => ({
      label: formatClanLabel(clan.tag, clan.name).slice(0, 100),
      value: clan.tag,
      description: `Clan view for ${clan.tag}`.slice(0, 100),
      default: state.scope === "clan" && state.clanTag === clan.tag,
    })),
  ];
  dropdown.addOptions(menuOptions);
  const timezoneControls = buildRecruitmentDashboardTimezoneControls({ sessionId: input.sessionId });

  if (state.scope === "schedule") {
    const confirmEnabled = Boolean(
      state.clanTag &&
        state.reminderDayKey &&
        state.reminderTimeIso &&
        input.data.templates.has(`${state.clanTag}:${state.clanTab}`),
    );
    const scheduleButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(recruitmentDashboardCustomId(input.sessionId, "schedule:back"))
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(recruitmentDashboardCustomId(input.sessionId, "schedule:confirm"))
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!confirmEnabled),
    );
    const dayOptions = buildRecruitmentDashboardDayOptions(input.state, input.data);
    const timeOptions = buildRecruitmentDashboardTimeOptions(input.state, input.data);
    return [
      timezoneControls,
      scheduleButtons,
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(recruitmentDashboardCustomId(input.sessionId, "schedule:day"))
          .setMinValues(1)
          .setMaxValues(1)
          .setPlaceholder(dayOptions.length > 0 ? "Select a day" : "No valid days")
          .setDisabled(dayOptions.length <= 0)
          .addOptions(dayOptions.length > 0 ? dayOptions : [{ label: "No valid days", value: "none", description: "No available reminder days" }]),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(recruitmentDashboardCustomId(input.sessionId, "schedule:time"))
          .setMinValues(1)
          .setMaxValues(1)
          .setPlaceholder(timeOptions.length > 0 ? "Select a time" : "No valid times")
          .setDisabled(timeOptions.length <= 0)
          .addOptions(timeOptions.length > 0 ? timeOptions : [{ label: "No valid times", value: "none", description: "No available reminder slots" }]),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(dropdown),
    ];
  }

  if (state.scope === "overview") {
    const overviewButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(recruitmentDashboardCustomId(input.sessionId, "overview:timers"))
        .setLabel("Timers")
        .setStyle(state.overviewTab === "timers" ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(recruitmentDashboardCustomId(input.sessionId, "overview:scripts"))
        .setLabel("Scripts")
        .setStyle(state.overviewTab === "scripts" ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(recruitmentDashboardCustomId(input.sessionId, "overview:optimize"))
        .setLabel("Optimize")
        .setStyle(state.overviewTab === "optimize" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
    return [
      timezoneControls,
      overviewButtons,
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(dropdown),
    ];
  }

  const templateExists = input.data.templates.has(`${state.clanTag}:${state.clanTab}`);
  const clanButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(recruitmentDashboardCustomId(input.sessionId, "clan:discord"))
      .setLabel("Discord")
      .setStyle(state.clanTab === "discord" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(recruitmentDashboardCustomId(input.sessionId, "clan:reddit"))
      .setLabel("Reddit")
      .setStyle(state.clanTab === "reddit" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(recruitmentDashboardCustomId(input.sessionId, "clan:band"))
      .setLabel("Band")
      .setStyle(state.clanTab === "band" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(recruitmentDashboardCustomId(input.sessionId, "clan:remind"))
      .setLabel("Remind")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!templateExists),
    new ButtonBuilder()
      .setCustomId(recruitmentDashboardCustomId(input.sessionId, "clan:start-countdown"))
      .setLabel("Start countdown")
      .setStyle(ButtonStyle.Secondary),
  );
  return [
    timezoneControls,
    clanButtons,
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(dropdown),
  ];
}

function buildRecruitmentDashboardDayOptions(
  state: RecruitmentDashboardState,
  data: Awaited<ReturnType<typeof loadRecruitmentDashboardData>>,
): Array<{ label: string; value: string; description: string; default?: boolean }> {
  if (!state.clanTag) return [];
  const slots = getRecruitmentReminderSlotCandidates({
    platform: state.clanTab,
    timezone: state.timezone,
    after: new Date(),
    cooldownExpiresAt: data.cooldowns.get(`${state.clanTag}:${state.clanTab}`) ?? null,
  });
  const days = new Map<string, { label: string; value: string; description: string }>();
  for (const slot of slots) {
    const dateLabel = getDateKeyInTimeZone(slot, state.timezone);
    if (!days.has(dateLabel)) {
      days.set(dateLabel, {
        label: dateLabel.slice(0, 100),
        value: dateLabel,
        description: `Slots for ${dateLabel}`.slice(0, 100),
      });
    }
  }
  return [...days.values()].slice(0, 25).map((option) => ({
    ...option,
    default: option.value === state.reminderDayKey,
  }));
}

function buildRecruitmentDashboardTimeOptions(
  state: RecruitmentDashboardState,
  data: Awaited<ReturnType<typeof loadRecruitmentDashboardData>>,
): Array<{ label: string; value: string; description: string; default?: boolean }> {
  if (!state.clanTag || !state.reminderDayKey) return [];
  const slots = getRecruitmentReminderSlotCandidates({
    platform: state.clanTab,
    timezone: state.timezone,
    after: new Date(),
    cooldownExpiresAt: data.cooldowns.get(`${state.clanTag}:${state.clanTab}`) ?? null,
  });
  const matches = slots.filter((slot) => {
    const dateLabel = getDateKeyInTimeZone(slot, state.timezone);
    return dateLabel === state.reminderDayKey;
  });
  return matches.slice(0, 25).map((slot) => {
    const display = formatRecruitmentReminderTime(slot, state.timezone);
    return {
      label: display.slice(0, 100),
      value: slot.toISOString(),
      description: "30-minute slot".slice(0, 100),
      default: state.reminderTimeIso === slot.toISOString(),
    };
  });
}

async function handleShowSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const platformRaw = interaction.options.getString("platform", true);
  const platform = parseRecruitmentPlatform(platformRaw);
  if (!platform) {
    await interaction.editReply("Invalid platform.");
    return;
  }

  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  if (!clanTag) {
    await interaction.editReply("Invalid clan tag.");
    return;
  }

  const trackedClan = await findTrackedClan(clanTag);
  if (!trackedClan) {
    await interaction.editReply("Clan is not tracked. Add it first with `/tracked-clan configure`.");
    return;
  }

  const template = await getRecruitmentTemplate(interaction.guildId, clanTag, platform);
  if (!template) {
    await interaction.editReply(
      `No ${platform} recruitment template found for ${formatClanTag(
        clanTag
      )}. Use \`/recruitment edit\` with this platform first.`
    );
    return;
  }

  const cooldown = await getRecruitmentCooldown(interaction.guildId, interaction.user.id, clanTag, platform);
  const cooldownLine = buildCooldownLine(cooldown?.expiresAt ?? null);
  const clanName =
    trackedClan.name ??
    (await cocService.getClanName(clanTag).catch(() => null)) ??
    formatClanTag(clanTag);

  let response = "";
  if (platform === "discord") {
    response = buildDiscordShowMessage({
      clanName,
      clanTag,
      body: template.body,
      imageUrls: template.imageUrls,
      cooldownLine,
    });
  } else if (platform === "band") {
    response = buildBandShowMessage({
      clanName,
      clanTag,
      body: template.body,
      imageUrls: template.imageUrls,
      cooldownLine,
    });
  } else {
    response = buildRedditShowMessage({
      clanName,
      clanTag,
      subject: template.subject ?? "",
      body: template.body,
      imageUrls: template.imageUrls,
      cooldownLine,
    });
  }

  await interaction.editReply(truncateDiscordContent(response));
}

async function handleEditSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
    return;
  }
  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  const platformRaw = interaction.options.getString("platform", true);
  const platform = parseRecruitmentPlatform(platformRaw);
  if (!platform) {
    await interaction.reply({ ephemeral: true, content: "Invalid platform." });
    return;
  }
  if (!clanTag) {
    await interaction.reply({ ephemeral: true, content: "Invalid clan tag." });
    return;
  }

  try {
    const tracked = await findTrackedClan(clanTag);
    if (!tracked) {
      await interaction.reply({
        ephemeral: true,
        content: "Clan is not tracked. Add it first with `/tracked-clan configure`.",
      });
      return;
    }

    const existing = await getRecruitmentTemplate(interaction.guildId, clanTag, platform);
    const modal = new ModalBuilder()
      .setCustomId(buildModalCustomId(interaction.user.id, clanTag, platform))
      .setTitle(`Edit ${formatPlatform(platform)} ${formatClanTag(clanTag)}`);

    const bodyInput = new TextInputBuilder()
      .setCustomId(BODY_INPUT_ID)
      .setLabel(platform === "reddit" ? "Message body (markdown supported)" : "Recruitment body")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1024)
      .setValue(existing?.body ?? "");

    const imageUrlsInput = new TextInputBuilder()
      .setCustomId(IMAGE_URLS_INPUT_ID)
      .setLabel("Default image URLs (comma separated)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1024)
      .setValue(existing ? toImageUrlsCsv(existing.imageUrls) : "");

    const rows: Array<ActionRowBuilder<TextInputBuilder>> = [];
    if (platform === "discord") {
      const clanTagInput = new TextInputBuilder()
        .setCustomId(DISCORD_CLAN_TAG_INPUT_ID)
        .setLabel("Clan tag")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32)
        .setValue(formatClanTag(clanTag));
      rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(clanTagInput));
    }

    if (platform === "reddit") {
      const clan = await cocService.getClan(clanTag).catch(() => null);
      const requiredTh = Number(clan?.requiredTownhallLevel);
      const clanLevel = Number(clan?.clanLevel);
      const requiredThText =
        Number.isFinite(requiredTh) && requiredTh > 0
          ? `TH${requiredTh}`
          : "Required TH/Level";
      const clanLevelText =
        Number.isFinite(clanLevel) && clanLevel > 0 ? `Level ${clanLevel}` : "Clan Level";
      const clanNameText = tracked.name?.trim() || clan?.name?.trim() || "Clan Name";
      const defaultSubject =
        existing?.subject?.trim() ||
        `[Recruiting] ${clanNameText} | ${formatClanTag(
          clanTag
        )} | ${requiredThText} | ${clanLevelText} | FWA | Discord`;
      const subjectInput = new TextInputBuilder()
        .setCustomId(REDDIT_SUBJECT_INPUT_ID)
        .setLabel("Reddit post subject")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200)
        .setValue(defaultSubject);
      rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(subjectInput));
    }

    rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(bodyInput));
    rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(imageUrlsInput));
    modal.addComponents(...rows);

    await interaction.showModal(modal);
  } catch (err) {
    console.error(
      `[recruitment] edit_setup_failed guildId=${interaction.guildId} clanTag=${clanTag} platform=${platform} userId=${interaction.user.id} error=${formatError(err)}`
    );
    const content =
      "Failed to open recruitment editor. Check recruitment database migration/state and try again.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
      return;
    }
    await interaction.reply({ ephemeral: true, content });
  }
}

async function handleCountdownStartSubcommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const platformRaw = interaction.options.getString("platform", true);
  const platform = parseRecruitmentPlatform(platformRaw);
  if (!platform) {
    await interaction.editReply("Invalid platform.");
    return;
  }

  const clanTag = normalizeClanTag(interaction.options.getString("clan", true));
  if (!clanTag) {
    await interaction.editReply("Invalid clan tag.");
    return;
  }

  const tracked = await findTrackedClan(clanTag);
  if (!tracked) {
    await interaction.editReply("Clan is not tracked. Add it first with `/tracked-clan configure`.");
    return;
  }

  const existing = await getRecruitmentCooldown(interaction.guildId, interaction.user.id, clanTag, platform);
  const now = Date.now();
  if (existing && existing.expiresAt.getTime() > now) {
    const unix = toUnixSeconds(existing.expiresAt);
    await interaction.editReply(
      `${formatPlatform(platform)} cooldown is already active for ${mapTrackedLabel(
        tracked.name,
        clanTag
      )}. Ready <t:${unix}:R> (at <t:${unix}:F>).`
    );
    return;
  }

  const startedAt = new Date(now);
  const expiresAt = new Date(now + getRecruitmentCooldownDurationMs(platform));
  await startOrResetRecruitmentCooldown({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    clanTag,
    platform,
    startedAt,
    expiresAt,
  });

  const unix = toUnixSeconds(expiresAt);
  await interaction.editReply(
    `${formatPlatform(platform)} cooldown started for ${mapTrackedLabel(
      tracked.name,
      clanTag
    )}. Ready <t:${unix}:R> (at <t:${unix}:F>).`
  );
}

async function handleCountdownStatusSubcommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const rows = await listRecruitmentCooldownsForUser(interaction.guildId, interaction.user.id);
  if (rows.length === 0) {
    await interaction.editReply("No active recruitment cooldowns.");
    return;
  }

  const nameByTag = await getTrackedClanNameMapByTags(rows.map((row) => row.clanTag));
  const now = Date.now();
  const lines = rows.map((row) => {
    const tag = normalizeClanTag(row.clanTag);
    const clanLabel = nameByTag.get(tag) ?? formatClanTag(tag);
    if (row.expiresAt.getTime() <= now) {
      return `${formatPlatform(row.platform)} - ${clanLabel} - Ready now`;
    }
    return `${formatPlatform(row.platform)} - ${clanLabel} - Ready <t:${toUnixSeconds(
      row.expiresAt
    )}:R>`;
  });

  await interaction.editReply(truncateDiscordContent(lines.join("\n")));
}

async function handleDashboardSubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const settings = new SettingsService();
  const timezoneSeedRaw = interaction.options.getString("timezone", false)?.trim() ?? null;
  let normalizedTimezone: string;
  try {
    normalizedTimezone = await resolveRecruitmentDashboardTimezone({
      settings,
      userId: interaction.user.id,
      timezoneSeedRaw,
    });
  } catch {
    await interaction.editReply("Invalid timezone. Use a valid IANA timezone.");
    return;
  }

  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  if (tracked.length === 0) {
    await interaction.editReply("No tracked clans configured.");
    return;
  }

  const state = makeRecruitmentDashboardState({
    scope: "overview",
    overviewTab: "timers",
    timezone: normalizedTimezone,
  });
  const sessionId = interaction.id;

  const render = async (note: string | null = null): Promise<void> => {
    const data = await loadRecruitmentDashboardData(interaction.guildId!, interaction.user.id);
    await interaction.editReply({
      content: note ?? undefined,
      embeds: [buildRecruitmentDashboardEmbed({ state, data, nowMs: Date.now() })],
      components: buildRecruitmentDashboardComponents({
        state,
        data,
        sessionId,
      }),
    });
  };

  await render();
  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({ time: PANEL_TIMEOUT_MS });

  collector.on("collect", async (component) => {
    const parsed = parseRecruitmentDashboardCustomId(component.customId);
    if (!parsed || parsed.sessionId !== sessionId) return;
    if (component.user.id !== interaction.user.id) {
      await component.reply({
        ephemeral: true,
        content: "Only the dashboard requester can use this panel.",
      });
      return;
    }

    try {
      if (component.isButton() && parsed.action === "timezone:prev") {
        await component.deferUpdate();
        state.timezone = stepRecruitmentDashboardTimezone(state.timezone, -1, new Date());
        state.reminderDayKey = null;
        state.reminderTimeIso = null;
        await persistRecruitmentDashboardTimezone(settings, interaction.user.id, state.timezone);
        await render();
        return;
      }

      if (component.isButton() && parsed.action === "timezone:next") {
        await component.deferUpdate();
        state.timezone = stepRecruitmentDashboardTimezone(state.timezone, 1, new Date());
        state.reminderDayKey = null;
        state.reminderTimeIso = null;
        await persistRecruitmentDashboardTimezone(settings, interaction.user.id, state.timezone);
        await render();
        return;
      }

      if (component.isStringSelectMenu() && parsed.action === "scope") {
        await component.deferUpdate();
        const selected = component.values[0] ?? "overview";
        if (selected === "overview") {
          state.scope = "overview";
          state.clanTag = null;
          state.overviewTab = "timers";
        } else {
          state.scope = "clan";
          state.clanTag = normalizeClanTag(selected);
          state.clanTab = "discord";
          state.reminderDayKey = null;
          state.reminderTimeIso = null;
        }
        await render();
        return;
      }

      if (component.isButton() && parsed.action.startsWith("overview:")) {
        await component.deferUpdate();
        const nextTab = parsed.action.split(":")[1] as RecruitmentDashboardOverviewTab | undefined;
        if (nextTab === "timers" || nextTab === "scripts" || nextTab === "optimize") {
          state.scope = "overview";
          state.clanTag = null;
          state.overviewTab = nextTab;
          await render();
        }
        return;
      }

      if (component.isButton() && parsed.action.startsWith("clan:")) {
        await component.deferUpdate();
        const next = parsed.action.split(":")[1] as RecruitmentDashboardClanTab | "remind" | undefined;
        if (next === "discord" || next === "reddit" || next === "band") {
          state.scope = "clan";
          state.clanTab = next;
          state.reminderDayKey = null;
          state.reminderTimeIso = null;
          await render();
          return;
        }
        if (next === "remind") {
          if (!state.clanTag) {
            await render("Select a clan first.");
            return;
          }
          const data = await loadRecruitmentDashboardData(interaction.guildId!, interaction.user.id);
          if (!data.templates.has(`${state.clanTag}:${state.clanTab}`)) {
            await render("This clan/platform has no stored template yet.");
            return;
          }
          state.scope = "schedule";
          state.reminderDayKey = null;
          state.reminderTimeIso = null;
          await render();
          return;
        }
        if (next === "start-countdown") {
          if (!state.clanTag) {
            await render("Select a clan first.");
            return;
          }
          const startedAt = new Date();
          const expiresAt = new Date(startedAt.getTime() + getRecruitmentCooldownDurationMs(state.clanTab));
          await startOrResetRecruitmentCooldown({
            guildId: interaction.guildId!,
            userId: interaction.user.id,
            clanTag: state.clanTag,
            platform: state.clanTab,
            startedAt,
            expiresAt,
          });
          await render(
            `Started ${formatRecruitmentPlatformChoice(state.clanTab)} countdown for ${formatClanLabel(
              state.clanTag,
              tracked.find((row) => row.tag === state.clanTag)?.name ?? null,
            )}.`,
          );
          return;
        }
      }

      if (component.isButton() && parsed.action === "schedule:back") {
        await component.deferUpdate();
        state.scope = "clan";
        await render();
        return;
      }

      if (component.isStringSelectMenu() && parsed.action === "schedule:day") {
        await component.deferUpdate();
        state.reminderDayKey = component.values[0] ?? null;
        const data = await loadRecruitmentDashboardData(interaction.guildId!, interaction.user.id);
        const slots = getRecruitmentReminderSlotCandidates({
          platform: state.clanTab,
          timezone: state.timezone,
          after: new Date(),
          cooldownExpiresAt:
            state.clanTag ? data.cooldowns.get(`${state.clanTag}:${state.clanTab}`) ?? null : null,
        });
        const selectedSlot =
          slots.find((slot) => {
            const dayLabel = getDateKeyInTimeZone(slot, state.timezone);
            return dayLabel === state.reminderDayKey;
          }) ?? null;
        state.reminderTimeIso = selectedSlot?.toISOString() ?? null;
        await render();
        return;
      }

      if (component.isStringSelectMenu() && parsed.action === "schedule:time") {
        await component.deferUpdate();
        state.reminderTimeIso = component.values[0] ?? null;
        await render();
        return;
      }

      if (component.isButton() && parsed.action === "schedule:confirm") {
        await component.deferUpdate();
        if (!state.clanTag || !state.reminderTimeIso || !state.reminderDayKey) {
          await render("Select a day and time before confirming.");
          return;
        }
        const selectedAt = new Date(state.reminderTimeIso);
        const data = await loadRecruitmentDashboardData(interaction.guildId!, interaction.user.id);
        const template = await getRecruitmentTemplate(
          interaction.guildId!,
          state.clanTag,
          state.clanTab,
        );
        if (!template) {
          await render("No stored template exists for that clan/platform.");
          return;
        }
        const clan = data.trackedClans.find((row) => row.tag === state.clanTag) ?? null;
        const next = getNextRecruitmentReminderSlot({
          platform: state.clanTab,
          timezone: state.timezone,
          after: selectedAt,
          cooldownExpiresAt: state.clanTag
            ? data.cooldowns.get(`${state.clanTag}:${state.clanTab}`) ?? null
            : null,
        });
        const nextReminderAt = next ?? selectedAt;
        await recruitmentReminderService.upsertRecruitmentReminderRule({
          guildId: interaction.guildId!,
          discordUserId: interaction.user.id,
          clanTag: state.clanTag,
          platform: state.clanTab,
          timezone: state.timezone,
          nextReminderAt,
          isActive: true,
          clanNameSnapshot: clan?.name ?? null,
          templateSubject: template.subject ?? null,
          templateBody: template.body,
          templateImageUrls: template.imageUrls,
        });
        await render(`Reminder saved for ${formatClanLabel(state.clanTag, clan?.name ?? null)}.`);
        return;
      }
    } catch (error) {
      console.error(`[recruitment] dashboard interaction failed error=${formatError(error)}`);
      if (!component.replied && !component.deferred) {
        await component.reply({
          ephemeral: true,
          content: "Failed to update the recruitment dashboard.",
        });
      }
    }
  });

  collector.on("end", async () => {
    try {
      await interaction.editReply({
        components: [],
      });
    } catch {
      // no-op
    }
  });
}

export function isRecruitmentModalCustomId(customId: string): boolean {
  return customId.startsWith(`${RECRUITMENT_MODAL_PREFIX}:`);
}

export async function handleRecruitmentModalSubmit(
  interaction: ModalSubmitInteraction
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ ephemeral: true, content: "This command can only be used in a server." });
    return;
  }
  const parsed = parseModalCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.userId !== interaction.user.id) {
    await interaction.reply({
      ephemeral: true,
      content: "Only the user who opened this modal can submit it.",
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const tracked = await findTrackedClan(parsed.clanTag);
  if (!tracked) {
    await interaction.editReply("Clan is no longer tracked. Add it again and retry.");
    return;
  }

  const body = interaction.fields.getTextInputValue(BODY_INPUT_ID).trim();
  const imageUrlsCsv = interaction.fields.getTextInputValue(IMAGE_URLS_INPUT_ID).trim();
  const imageUrls = parseImageUrlsCsv(imageUrlsCsv);

  if (!body) {
    await interaction.editReply("Recruitment body cannot be empty.");
    return;
  }
  if (body.length > 1024) {
    await interaction.editReply("Recruitment body must be 1024 characters or fewer.");
    return;
  }

  if (parsed.platform === "discord") {
    const inputTag = normalizeClanTag(
      interaction.fields.getTextInputValue(DISCORD_CLAN_TAG_INPUT_ID).trim()
    );
    if (!inputTag || inputTag !== parsed.clanTag) {
      await interaction.editReply(
        `Discord modal clan tag must match ${formatClanTag(parsed.clanTag)}.`
      );
      return;
    }
  }

  let subject: string | null = null;
  if (parsed.platform === "reddit") {
    subject = interaction.fields.getTextInputValue(REDDIT_SUBJECT_INPUT_ID).trim();
    if (!subject) {
      await interaction.editReply("Reddit subject cannot be empty.");
      return;
    }
    if (!isValidRedditSubject(subject)) {
      await interaction.editReply(
        "Reddit subject must match: [Recruiting] Name of Clan | #ClanTag | Required TH/Level | Clan Level | FWA | Discord"
      );
      return;
    }
  }

  await upsertRecruitmentTemplate({
    guildId: interaction.guildId,
    clanTag: parsed.clanTag,
    platform: parsed.platform,
    subject,
    body,
    imageUrls,
  });

  await interaction.editReply(
    `Saved ${parsed.platform} recruitment template for ${mapTrackedLabel(
      tracked.name,
      parsed.clanTag
    )}.`
  );
}

export const Recruitment: Command = {
  name: "recruitment",
  description: "Manage recruitment templates and posting cooldowns",
  options: [
    {
      name: "show",
      description: "Show formatted recruitment content for a platform and clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "platform",
          description: "Target platform",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [...PLATFORM_CHOICES],
        },
        {
          name: "clan",
          description: "Tracked clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "edit",
      description: "Edit stored recruitment template for a clan",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "platform",
          description: "Template platform",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [...PLATFORM_CHOICES],
        },
        {
          name: "clan",
          description: "Tracked clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: "countdown",
      description: "Start or check recruitment cooldown timers",
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [
        {
          name: "start",
          description: "Start cooldown for a platform and clan",
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: "platform",
              description: "Target platform",
              type: ApplicationCommandOptionType.String,
              required: true,
              choices: [...PLATFORM_CHOICES],
            },
            {
              name: "clan",
              description: "Tracked clan tag (with or without #)",
              type: ApplicationCommandOptionType.String,
              required: true,
              autocomplete: true,
            },
          ],
        },
        {
          name: "status",
          description: "Show your recruitment cooldown status",
          type: ApplicationCommandOptionType.Subcommand,
        },
      ],
    },
    {
      name: "dashboard",
      description: "Show readiness across all tracked clans and platforms",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "timezone",
          description: "IANA timezone to use for window display and slot selection",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    cocService: CoCService
  ) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);

    if (group === "countdown" && sub === "start") {
      await handleCountdownStartSubcommand(interaction);
      return;
    }
    if (group === "countdown" && sub === "status") {
      await handleCountdownStatusSubcommand(interaction);
      return;
    }
    if (group) {
      await interaction.reply({ ephemeral: true, content: "Unknown subcommand." });
      return;
    }

    if (sub === "show") {
      await handleShowSubcommand(interaction, cocService);
      return;
    }
    if (sub === "edit") {
      await handleEditSubcommand(interaction, cocService);
      return;
    }
    if (sub === "dashboard") {
      await handleDashboardSubcommand(interaction);
      return;
    }

    await interaction.reply({ ephemeral: true, content: "Unknown subcommand." });
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "timezone") {
      try {
        await interaction.respond(autocompleteRecruitmentTimeZones(String(focused.value ?? "")));
      } catch {
        await interaction.respond([]);
      }
      return;
    }
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    try {
      const query = String(focused.value ?? "").trim().toLowerCase();
      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true, tag: true },
      });
      const choices = tracked
        .map((row) => {
          const tag = normalizeClanTag(row.tag);
          const label = row.name?.trim() ? `${row.name.trim()} (#${tag})` : `#${tag}`;
          return { name: label.slice(0, 100), value: tag };
        })
        .filter(
          (row) =>
            row.name.toLowerCase().includes(query) || row.value.toLowerCase().includes(query)
        )
        .slice(0, 25);
      await interaction.respond(choices);
    } catch (err) {
      console.error(`[recruitment] autocomplete failed error=${formatError(err)}`);
      await interaction.respond([]);
    }
  },
};
