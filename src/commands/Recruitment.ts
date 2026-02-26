import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { Prisma } from "@prisma/client";
import { Command } from "../Command";
import { truncateDiscordContent } from "../helper/discordContent";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  formatClanTag,
  getRecruitmentCooldown,
  getRecruitmentCooldownDurationMs,
  getRecruitmentTemplate,
  getTrackedClanNameMapByTags,
  listRecruitmentCooldownsForUser,
  listRecruitmentCooldownsForUserByClanTags,
  normalizeClanTag,
  parseImageUrlsCsv,
  parseRecruitmentPlatform,
  RecruitmentPlatform,
  startOrResetRecruitmentCooldown,
  toImageUrlsCsv,
  upsertRecruitmentTemplate,
} from "../services/RecruitmentService";

const RECRUITMENT_MODAL_PREFIX = "recruitment-edit";
const DISCORD_CLAN_TAG_INPUT_ID = "discord-clan-tag";
const REDDIT_SUBJECT_INPUT_ID = "reddit-subject";
const BODY_INPUT_ID = "body";
const IMAGE_URLS_INPUT_ID = "image-urls";
const DISCORD_RECRUITMENT_CHANNEL_URL =
  "https://discord.com/channels/236523452230533121/1058589765508800644";

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

function codeBlock(content: string, language = ""): string {
  const safe = content.replaceAll("```", "`\u200b``");
  return `\`\`\`${language}\n${safe}\n\`\`\``;
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
    codeBlock(input.body),
  ];

  if (input.imageUrls.length > 0) {
    lines.push("", "Suggested Image URLs:", ...input.imageUrls.map((url) => `- ${url}`));
  }

  lines.push(
    "",
    "Instructions:",
    `- Go to ${DISCORD_RECRUITMENT_CHANNEL_URL}`,
    "- Type `/post` in that channel and fill clan tag, recruitment contents, image URL, and language.",
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
    `Recruitment Contents (${sanitizedBody.length}/1024):`,
    codeBlock(sanitizedBody),
  ];

  if (input.imageUrls.length > 0) {
    lines.push("", "Suggested Image URLs:", ...input.imageUrls.map((url) => `- ${url}`));
  }

  lines.push("", input.cooldownLine);
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
    `Recruitment Contents (${noGiveawayBody.length}/1024):`,
    codeBlock(noGiveawayBody, "md"),
    "",
    "Rules:",
    "- No giveaway mentions.",
    "- Once per 7 days per account.",
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

async function handleShowSubcommand(
  interaction: ChatInputCommandInteraction,
  cocService: CoCService
): Promise<void> {
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
    await interaction.editReply("Clan is not tracked. Add it first with `/tracked-clan add`.");
    return;
  }

  const template = await getRecruitmentTemplate(clanTag, platform);
  if (!template) {
    await interaction.editReply(
      `No ${platform} recruitment template found for ${formatClanTag(
        clanTag
      )}. Use \`/recruitment edit\` with this platform first.`
    );
    return;
  }

  const cooldown = await getRecruitmentCooldown(interaction.user.id, clanTag, platform);
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

  const tracked = await findTrackedClan(clanTag);
  if (!tracked) {
    await interaction.reply({
      ephemeral: true,
      content: "Clan is not tracked. Add it first with `/tracked-clan add`.",
    });
    return;
  }

  const existing = await getRecruitmentTemplate(clanTag, platform);
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
}

async function handleCountdownStartSubcommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
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
    await interaction.editReply("Clan is not tracked. Add it first with `/tracked-clan add`.");
    return;
  }

  const existing = await getRecruitmentCooldown(interaction.user.id, clanTag, platform);
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
  await interaction.deferReply({ ephemeral: true });

  const rows = await listRecruitmentCooldownsForUser(interaction.user.id);
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
  await interaction.deferReply({ ephemeral: true });

  const tracked = await prisma.trackedClan.findMany({
    orderBy: { createdAt: "asc" },
    select: { tag: true, name: true },
  });
  if (tracked.length === 0) {
    await interaction.editReply("No tracked clans configured.");
    return;
  }

  const tags = tracked.map((row) => normalizeClanTag(row.tag));
  const cooldowns = await listRecruitmentCooldownsForUserByClanTags(interaction.user.id, tags);
  const cooldownMap = new Map<string, Date>();
  for (const row of cooldowns) {
    cooldownMap.set(`${normalizeClanTag(row.clanTag)}:${row.platform}`, row.expiresAt);
  }

  const now = Date.now();
  const platforms: RecruitmentPlatform[] = ["discord", "band", "reddit"];
  const lines: string[] = [];
  for (const clan of tracked) {
    const tag = normalizeClanTag(clan.tag);
    lines.push(`**${mapTrackedLabel(clan.name, tag)}**`);
    for (const platform of platforms) {
      const expiresAt = cooldownMap.get(`${tag}:${platform}`);
      if (!expiresAt || expiresAt.getTime() <= now) {
        lines.push(`- ${formatPlatform(platform)}: Ready now`);
      } else {
        lines.push(`- ${formatPlatform(platform)}: <t:${toUnixSeconds(expiresAt)}:R>`);
      }
    }
    lines.push("");
  }

  await interaction.editReply(truncateDiscordContent(lines.join("\n").trim()));
}

export function isRecruitmentModalCustomId(customId: string): boolean {
  return customId.startsWith(`${RECRUITMENT_MODAL_PREFIX}:`);
}

export async function handleRecruitmentModalSubmit(
  interaction: ModalSubmitInteraction
): Promise<void> {
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
