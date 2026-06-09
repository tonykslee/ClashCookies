import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
  AutocompleteInteraction,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import {
  getCommandTargetsFromInteraction,
  CommandPermissionService,
} from "../services/CommandPermissionService";
import { BanService, type BanListRecord } from "../services/BanService";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "../services/PlayerLinkService";

const BAN_PAGINATION_TIMEOUT_MS = 5 * 60 * 1000;
const BAN_LIST_PAGE_CHAR_LIMIT = 3500;
const BAN_LIST_ROW_CHAR_LIMIT = 420;
const BAN_LIST_EMBED_COLOR = 0x5865f2;

type BanTarget =
  | { kind: "player"; playerTag: string }
  | { kind: "user"; discordUserId: string };

export type BanDurationParseResult =
  | { kind: "valid"; expiresAt: Date | null }
  | { kind: "invalid"; message: string };

function sanitizeOptionalText(input: string | null | undefined): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateInlineText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  if (maxLength <= 3) return input.slice(0, maxLength);
  return `${input.slice(0, maxLength - 3)}...`;
}

function normalizeDisplayText(input: string | null | undefined): string | null {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function addUtcMonths(input: Date, months: number): Date {
  const target = new Date(
    Date.UTC(
      input.getUTCFullYear(),
      input.getUTCMonth() + months,
      1,
      input.getUTCHours(),
      input.getUTCMinutes(),
      input.getUTCSeconds(),
      input.getUTCMilliseconds(),
    ),
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(input.getUTCDate(), lastDayOfTargetMonth));
  return target;
}

export function parseBanDuration(
  input: string | null | undefined,
  now = new Date(),
): BanDurationParseResult {
  const trimmed = sanitizeOptionalText(input);
  if (!trimmed) {
    return { kind: "valid", expiresAt: null };
  }

  const match = /^([1-9]\d*)(mo|w|d|h)$/i.exec(trimmed);
  if (!match) {
    return {
      kind: "invalid",
      message: "invalid_duration: use 3mo, 2w, 10d, or 12h.",
    };
  }

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = String(match[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      kind: "invalid",
      message: "invalid_duration: use 3mo, 2w, 10d, or 12h.",
    };
  }

  if (unit === "mo") {
    return { kind: "valid", expiresAt: addUtcMonths(now, amount) };
  }

  const millisecondsByUnit = {
    w: 7 * 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
  } as const;

  return {
    kind: "valid",
    expiresAt: new Date(now.getTime() + amount * millisecondsByUnit[unit as keyof typeof millisecondsByUnit]),
  };
}

function resolveBanTarget(interaction: ChatInputCommandInteraction): {
  target: BanTarget | null;
  error: string | null;
} {
  const rawPlayer = interaction.options.getString("player", false);
  const rawUser = interaction.options.getUser("user", false);

  const hasPlayer = sanitizeOptionalText(rawPlayer) !== null;
  const hasUser = Boolean(rawUser);

  if (!hasPlayer && !hasUser) {
    return {
      target: null,
      error: "exactly_one_target_required: provide either player or user, but not both.",
    };
  }

  if (hasPlayer && hasUser) {
    return {
      target: null,
      error: "exactly_one_target_required: provide either player or user, but not both.",
    };
  }

  if (hasPlayer) {
    const playerTag = normalizePlayerTag(rawPlayer ?? "");
    if (!playerTag) {
      return {
        target: null,
        error: "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`.",
      };
    }
    return { target: { kind: "player", playerTag }, error: null };
  }

  const discordUserId = normalizeDiscordUserId(rawUser?.id);
  if (!discordUserId) {
    return {
      target: null,
      error: "invalid_user: expected a Discord user.",
    };
  }

  return { target: { kind: "user", discordUserId }, error: null };
}

function formatUnixTimestamp(value: Date | null | undefined): string {
  if (!value) return "indefinite";
  return `<t:${Math.floor(value.getTime() / 1000)}:R>`;
}

function formatBanClanContext(record: BanListRecord): string | null {
  const clanTag = normalizeClanTag(record.clanTag ?? "");
  if (!clanTag) return null;
  const clanName = normalizeDisplayText(record.clanName);
  return clanName
    ? `clan: ${truncateInlineText(`${clanName} (${clanTag})`, 120)}`
    : `clan: ${clanTag}`;
}

function formatBanRow(record: BanListRecord): string {
  const baseParts: string[] = [
    record.targetKind,
    record.targetKind === "PLAYER"
      ? record.playerTag ?? "unknown"
      : record.discordUserId
        ? `<@${record.discordUserId}>`
        : "unknown",
  ];

  const clanContext = formatBanClanContext(record);
  if (clanContext) {
    baseParts.push(clanContext);
  }

  if (record.targetKind === "USER") {
    const linkedTags = record.linkedPlayerTags.length > 0 ? record.linkedPlayerTags.join(", ") : "none";
    baseParts.push(`linked: ${truncateInlineText(linkedTags, 120)}`);
  }

  baseParts.push(`banned ${formatUnixTimestamp(record.createdAt)}`);
  baseParts.push(`expires ${formatUnixTimestamp(record.expiresAt)}`);
  baseParts.push(`by <@${record.bannedByDiscordUserId}>`);

  if (record.reason) {
    baseParts.push(`reason: ${truncateInlineText(record.reason, 180)}`);
  }

  return truncateInlineText(baseParts.join(" | "), BAN_LIST_ROW_CHAR_LIMIT);
}

async function autocompleteTrackedClanChoice(
  interaction: AutocompleteInteraction,
): Promise<Array<{ name: string; value: string }>> {
  const query = String(interaction.options.getFocused(true).value ?? "")
    .trim()
    .toLowerCase();
  const trackedClans = await prisma.trackedClan.findMany({
    orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
    select: { name: true, tag: true },
  });

  return trackedClans
    .map((clan) => {
      const tag = normalizeClanTag(clan.tag);
      if (!tag) return null;
      const label = normalizeDisplayText(clan.name)
        ? `${normalizeDisplayText(clan.name)} (${tag})`
        : tag;
      return { name: label.slice(0, 100), value: tag };
    })
    .filter(
      (choice): choice is { name: string; value: string } =>
        choice !== null &&
        (choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query)),
    )
    .slice(0, 25);
}

function buildBanListPages(rows: BanListRecord[]): string[] {
  if (rows.length === 0) return ["No active bans."];

  const pages: string[] = [];
  let currentLines: string[] = [];
  let currentLength = 0;

  for (const row of rows) {
    const line = formatBanRow(row);
    const additionalLength = currentLines.length > 0 ? line.length + 1 : line.length;

    if (currentLines.length > 0 && currentLength + additionalLength > BAN_LIST_PAGE_CHAR_LIMIT) {
      pages.push(currentLines.join("\n"));
      currentLines = [line];
      currentLength = line.length;
      continue;
    }

    currentLines.push(line);
    currentLength += additionalLength;
  }

  if (currentLines.length > 0) {
    pages.push(currentLines.join("\n"));
  }

  return pages.length > 0 ? pages : ["No active bans."];
}

export function buildBanListEmbeds(rows: BanListRecord[]): EmbedBuilder[] {
  const pages = buildBanListPages(rows);
  return pages.map((description, index) =>
    new EmbedBuilder()
      .setTitle("Active Bans")
      .setDescription(description)
      .setColor(BAN_LIST_EMBED_COLOR)
      .setFooter({ text: `Page ${index + 1}/${pages.length} | Active ${rows.length}` }),
  );
}

function buildBanPaginationRow(prefix: string, page: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

function formatBanMutationMessage(input: {
  action: "created" | "updated" | "removed";
  target: BanTarget;
  expiresAt?: Date | null;
}): string {
  const targetLabel =
    input.target.kind === "player" ? input.target.playerTag : `<@${input.target.discordUserId}>`;
  const targetKindLabel = input.target.kind === "player" ? "player" : "user";

  const parts = [`${input.action}: ${targetKindLabel} ban for ${targetLabel}.`];
  if (input.action !== "removed") {
    parts.push(input.expiresAt ? `expires <t:${Math.floor(input.expiresAt.getTime() / 1000)}:R>.` : "indefinite.");
  }
  return parts.join(" ");
}

async function replyTargetValidationError(
  interaction: ChatInputCommandInteraction,
  message: string,
): Promise<void> {
  await safeReply(interaction, {
    ephemeral: true,
    content: message,
  });
}

export const Ban: Command = {
  name: "ban",
  description: "Manage persisted player and Discord-user bans",
  options: [
    {
      name: "add",
      description: "Add or update a ban",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player",
          description: "Player tag to ban",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "user",
          description: "Discord user to ban",
          type: ApplicationCommandOptionType.User,
          required: false,
        },
        {
          name: "clan",
          description: "Optional tracked clan context for the ban",
          type: ApplicationCommandOptionType.String,
          required: false,
          autocomplete: true,
        },
        {
          name: "reason",
          description: "Optional ban reason",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "duration",
          description: "Optional duration like 3mo, 2w, 10d, or 12h",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "list",
      description: "List active bans",
      type: ApplicationCommandOptionType.Subcommand,
      options: [],
    },
    {
      name: "remove",
      description: "Remove an active ban",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player",
          description: "Player tag to unban",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
        {
          name: "user",
          description: "Discord user to unban",
          type: ApplicationCommandOptionType.User,
          required: false,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService,
  ) => {
    if (!interaction.inGuild()) {
      await replyTargetValidationError(interaction, "This command can only be used in a server.");
      return;
    }

    const permissionService = new CommandPermissionService();
    const allowed = await permissionService.canUseAnyTarget(
      getCommandTargetsFromInteraction(interaction),
      interaction,
    );
    if (!allowed) {
      await replyTargetValidationError(interaction, "You do not have permission to use /ban.");
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const banService = new BanService();
    const guildId = interaction.guildId ?? "";
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "list") {
      const rows = await banService.listActiveBans({ guildId });
      const embeds = buildBanListEmbeds(rows);
      const prefix = `ban:${interaction.id}`;
      let page = 0;

      await interaction.editReply({
        embeds: [embeds[page] ?? new EmbedBuilder().setTitle("Active Bans").setDescription("No active bans.")],
        components:
          embeds.length > 1 ? [buildBanPaginationRow(prefix, page, embeds.length)] : [],
      });

      if (embeds.length <= 1) {
        return;
      }

      const replyMessage = await interaction.fetchReply();
      if (!replyMessage || !("createMessageComponentCollector" in replyMessage)) {
        return;
      }

      const collector = replyMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: BAN_PAGINATION_TIMEOUT_MS,
        filter: (button: ButtonInteraction) =>
          button.user.id === interaction.user.id &&
          (button.customId === `${prefix}:prev` || button.customId === `${prefix}:next`),
      });

      collector.on("collect", async (button: ButtonInteraction) => {
        try {
          if (button.customId === `${prefix}:prev`) {
            page = Math.max(0, page - 1);
          } else if (button.customId === `${prefix}:next`) {
            page = Math.min(embeds.length - 1, page + 1);
          }

          await button.update({
            embeds: [embeds[page] ?? embeds[0]!],
            components: [buildBanPaginationRow(prefix, page, embeds.length)],
          });
        } catch (error) {
          console.error(`ban paginator failed: ${formatError(error)}`);
          if (!button.replied && !button.deferred) {
            await button.reply({
              ephemeral: true,
              content: "Failed to update ban page.",
            });
          }
        }
      });

      collector.on("end", async () => {
        try {
          await interaction.editReply({
            embeds: [embeds[page] ?? embeds[0]!],
            components: [],
          });
        } catch {
          // no-op
        }
      });
      return;
    }

    const targetResult = resolveBanTarget(interaction);
    if (targetResult.error || !targetResult.target) {
      await replyTargetValidationError(interaction, targetResult.error ?? "exactly_one_target_required: provide either player or user, but not both.");
      return;
    }

    if (subcommand === "add") {
      const durationResult = parseBanDuration(interaction.options.getString("duration", false));
      if (durationResult.kind === "invalid") {
        await replyTargetValidationError(interaction, durationResult.message);
        return;
      }

      const reason = sanitizeOptionalText(interaction.options.getString("reason", false));
      const addInput = {
        guildId,
        reason,
        bannedByDiscordUserId: interaction.user.id,
        expiresAt: durationResult.expiresAt,
        clanTag: interaction.options.getString("clan", false),
      };

      const result =
        targetResult.target.kind === "player"
          ? await banService.addPlayerBan({
              ...addInput,
              playerTag: targetResult.target.playerTag,
            })
          : await banService.addUserBan({
              ...addInput,
              discordUserId: targetResult.target.discordUserId,
            });

      if (result.outcome === "invalid_target" || result.outcome === "invalid_clan") {
        await replyTargetValidationError(
          interaction,
          result.outcome === "invalid_clan"
            ? "invalid_clan: select a tracked clan from autocomplete or use a tracked clan tag."
            : targetResult.target.kind === "player"
              ? "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
              : "invalid_user: expected a Discord user.",
        );
        return;
      }

      await safeReply(interaction, {
        ephemeral: true,
        content: formatBanMutationMessage({
          action: result.outcome,
          target: targetResult.target,
          expiresAt: result.record?.expiresAt ?? durationResult.expiresAt,
        }),
      });
      return;
    }

    if (subcommand === "remove") {
      const result =
        targetResult.target.kind === "player"
          ? await banService.removePlayerBan({
              guildId,
              playerTag: targetResult.target.playerTag,
              removedByDiscordUserId: interaction.user.id,
            })
          : await banService.removeUserBan({
              guildId,
              discordUserId: targetResult.target.discordUserId,
              removedByDiscordUserId: interaction.user.id,
            });

      if (result.outcome === "invalid_target") {
        await replyTargetValidationError(
          interaction,
          targetResult.target.kind === "player"
            ? "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
            : "invalid_user: expected a Discord user.",
        );
        return;
      }

      if (result.outcome === "not_found") {
        await safeReply(interaction, {
          ephemeral: true,
          content:
            targetResult.target.kind === "player"
              ? `no_active_ban: ${targetResult.target.playerTag} is not actively banned.`
              : `no_active_ban: <@${targetResult.target.discordUserId}> is not actively banned.`,
        });
        return;
      }

      await safeReply(interaction, {
        ephemeral: true,
        content: formatBanMutationMessage({
          action: "removed",
          target: targetResult.target,
        }),
      });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan") {
      await interaction.respond([]);
      return;
    }

    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand !== "add") {
      await interaction.respond([]);
      return;
    }

    await interaction.respond(await autocompleteTrackedClanChoice(interaction));
  },
};
