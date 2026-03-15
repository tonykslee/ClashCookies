import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { DISCORD_CONTENT_LIMIT, truncateDiscordContent } from "../helper/discordContent";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";
import { CommandPermissionService } from "../services/CommandPermissionService";
import {
  createPlayerLink,
  deletePlayerLink,
  formatLinkedAtUtc,
  listPlayerLinksForClanMembers,
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "../services/PlayerLinkService";

const permissionService = new CommandPermissionService();

function canAdminBypass(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function canUseAdminCreateOverride(
  interaction: ChatInputCommandInteraction
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(["link:create:admin"], interaction);
}

async function canUseAdminDeleteOverride(
  interaction: ChatInputCommandInteraction
): Promise<boolean> {
  if (canAdminBypass(interaction)) return true;
  return permissionService.canUseAnyTarget(["link:delete:admin"], interaction);
}

function normalizeClanMemberOrder(rawMembers: unknown[]): string[] {
  const mapped = rawMembers
    .map((member, index) => {
      const row = member as { tag?: string; mapPosition?: number | null } | null;
      const tag = normalizePlayerTag(String(row?.tag ?? ""));
      const mapPosition =
        typeof row?.mapPosition === "number" && Number.isFinite(row.mapPosition)
          ? row.mapPosition
          : null;
      return { tag, index, mapPosition };
    })
    .filter((row) => row.tag.length > 0);

  mapped.sort((a, b) => {
    if (a.mapPosition !== null && b.mapPosition !== null && a.mapPosition !== b.mapPosition) {
      return a.mapPosition - b.mapPosition;
    }
    if (a.mapPosition !== null && b.mapPosition === null) return -1;
    if (a.mapPosition === null && b.mapPosition !== null) return 1;
    return a.index - b.index;
  });

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const row of mapped) {
    if (seen.has(row.tag)) continue;
    seen.add(row.tag);
    ordered.push(row.tag);
  }
  return ordered;
}

function buildChunkedLinkListMessages(header: string, rows: string[]): string[] {
  const safeHeader =
    header.length > DISCORD_CONTENT_LIMIT
      ? truncateDiscordContent(header, DISCORD_CONTENT_LIMIT)
      : header;
  const chunks: string[] = [];
  let current = safeHeader;

  for (const row of rows) {
    const safeRow =
      row.length > DISCORD_CONTENT_LIMIT
        ? truncateDiscordContent(row, DISCORD_CONTENT_LIMIT)
        : row;
    const candidate = `${current}\n${safeRow}`;
    if (candidate.length <= DISCORD_CONTENT_LIMIT) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = safeRow;
  }

  chunks.push(current);
  return chunks;
}

export const Link: Command = {
  name: "link",
  description: "Manage local Discord ↔ player links",
  options: [
    {
      name: "create",
      description: "Create a local player-tag link",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "user",
          description: "Discord user ID override (admin-only)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "delete",
      description: "Delete a local player-tag link",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "player-tag",
          description: "Player tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
    {
      name: "list",
      description: "List linked players for a clan's current roster",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "clan-tag",
          description: "Clan tag (with or without #)",
          type: ApplicationCommandOptionType.String,
          required: true,
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
    if (!interaction.guildId) {
      await interaction.reply({
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "create") {
      const rawTag = interaction.options.getString("player-tag", true);
      const normalizedTag = normalizePlayerTag(rawTag);
      if (!normalizedTag) {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }

      const requestedUserInput = interaction.options.getString("user", false)?.trim() ?? "";
      const requestedUserId = requestedUserInput
        ? normalizeDiscordUserId(requestedUserInput)
        : null;
      if (requestedUserInput && !requestedUserId) {
        await interaction.editReply("invalid_user: expected a Discord snowflake user ID.");
        return;
      }

      const targetDiscordUserId = requestedUserId ?? interaction.user.id;
      const isSelfCreate = targetDiscordUserId === interaction.user.id;
      if (!isSelfCreate) {
        const allowed = await canUseAdminCreateOverride(interaction);
        if (!allowed) {
          await interaction.editReply(
            "not_allowed: only admins can create links for another Discord user."
          );
          return;
        }
      }

      const result = await createPlayerLink({
        playerTag: normalizedTag,
        targetDiscordUserId,
        selfService: isSelfCreate,
      });

      if (result.outcome === "created") {
        const owner = isSelfCreate ? "you" : `<@${targetDiscordUserId}>`;
        await interaction.editReply(`created: ${result.playerTag} linked to ${owner}.`);
        return;
      }
      if (result.outcome === "already_linked_to_you") {
        await interaction.editReply(`already_linked_to_you: ${result.playerTag}.`);
        return;
      }
      if (result.outcome === "already_linked_to_target_user") {
        await interaction.editReply(
          `already_linked_to_target_user: ${result.playerTag} -> <@${targetDiscordUserId}>.`
        );
        return;
      }
      if (result.outcome === "already_linked_to_other_user") {
        await interaction.editReply(
          `already_linked_to_other_user: ${result.playerTag} is linked to <@${result.existingDiscordUserId}>. delete-first is required.`
        );
        return;
      }
      if (result.outcome === "invalid_tag") {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }
      await interaction.editReply("invalid_user: expected a Discord snowflake user ID.");
      return;
    }

    if (subcommand === "delete") {
      const rawTag = interaction.options.getString("player-tag", true);
      const normalizedTag = normalizePlayerTag(rawTag);
      if (!normalizedTag) {
        await interaction.editReply(
          "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
        );
        return;
      }

      const canDeleteAny = await canUseAdminDeleteOverride(interaction);
      const result = await deletePlayerLink({
        playerTag: normalizedTag,
        requestingDiscordUserId: interaction.user.id,
        allowAdminDelete: canDeleteAny,
      });

      if (result.outcome === "deleted") {
        await interaction.editReply(`deleted: ${result.playerTag}.`);
        return;
      }
      if (result.outcome === "not_found") {
        await interaction.editReply(`not_found: no active link for ${result.playerTag}.`);
        return;
      }
      if (result.outcome === "not_owner") {
        await interaction.editReply(
          `not_owner: ${result.playerTag} is linked to another Discord user.`
        );
        return;
      }
      await interaction.editReply(
        "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
      );
      return;
    }

    const rawClanTag = interaction.options.getString("clan-tag", true);
    const normalizedClanTag = normalizeClanTag(rawClanTag);
    if (!normalizedClanTag) {
      await interaction.editReply(
        "invalid_tag: use Clash tags with characters `PYLQGRJCUV0289`."
      );
      return;
    }

    let clan: Awaited<ReturnType<CoCService["getClan"]>>;
    try {
      clan = await cocService.getClan(normalizedClanTag);
    } catch {
      await interaction.editReply(`not_found: clan ${normalizedClanTag} could not be resolved.`);
      return;
    }

    const memberTags = normalizeClanMemberOrder(Array.isArray(clan?.members) ? clan.members : []);
    if (memberTags.length === 0) {
      await interaction.editReply(`empty_list: no current clan members for ${normalizedClanTag}.`);
      return;
    }

    const links = await listPlayerLinksForClanMembers({
      memberTagsInOrder: memberTags,
    });
    if (links.length === 0) {
      await interaction.editReply(
        `empty_list: no linked players found for ${normalizedClanTag}.`
      );
      return;
    }

    const lines = links.map(
      (row) =>
        `- ${row.playerTag} | <@${row.discordUserId}> (${row.discordUserId}) | linkedAt ${formatLinkedAtUtc(row.linkedAt)}`
    );
    const chunks = buildChunkedLinkListMessages(
      `linked_players: ${links.length} for ${normalizedClanTag}`,
      lines
    );
    await interaction.editReply(chunks[0] ?? "empty_list: no linked players found.");
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk });
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "clan-tag") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "")
      .trim()
      .toUpperCase()
      .replace(/^#/, "");
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((row) => {
        const normalized = normalizeClanTag(row.tag).replace(/^#/, "");
        const title = row.name?.trim() ? `${row.name.trim()} (#${normalized})` : `#${normalized}`;
        return { name: title.slice(0, 100), value: normalized };
      })
      .filter(
        (choice) =>
          choice.value.toLowerCase().includes(query.toLowerCase()) ||
          choice.name.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, 25);
    await interaction.respond(choices);
  },
};
