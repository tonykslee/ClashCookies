import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import {
  buildDumpClanInfoCacheFromClan,
  buildDumpClanInfoContent,
  buildDumpClanInfoFallbackContent,
  extractDumpClanTagFromLink,
  deleteDumpLinkForGuildSlot,
  listDumpLinksForGuild,
  normalizeDumpLink,
  parseDumpClanInfoCache,
  updateDumpLinkClanInfoForGuildSlot,
  upsertDumpLinkForGuildSlot,
} from "../services/DumpLinkService";

function formatDumpLink(link: string): string {
  return `<${link}>`;
}

function parseDumpSlot(rawSlot: number | null | undefined): number | null {
  if (rawSlot === null || rawSlot === undefined) return null;
  if (!Number.isFinite(rawSlot)) return null;
  const slot = Math.trunc(rawSlot);
  return slot >= 1 && slot <= 3 ? slot : null;
}

async function fetchLiveDumpClanInfo(input: {
  link: string;
  cachedClanTag: string | null;
}): Promise<ReturnType<typeof buildDumpClanInfoCacheFromClan> | null> {
  const clanTag =
    extractDumpClanTagFromLink(input.link) ?? input.cachedClanTag ?? null;
  if (!clanTag) return null;

  try {
    const cocService = new CoCService();
    const clan = await cocService.getClan(clanTag);
    return buildDumpClanInfoCacheFromClan({
      clan,
      clanTag,
    });
  } catch {
    return null;
  }
}

async function renderDumpLinkBlock(input: {
  record: Awaited<ReturnType<typeof listDumpLinksForGuild>>[number];
}): Promise<string> {
  const cachedClanInfo = parseDumpClanInfoCache(input.record.clanInfoJson);
  const liveClanInfo = await fetchLiveDumpClanInfo({
    link: input.record.link,
    cachedClanTag: cachedClanInfo?.clanTag ?? null,
  });

  if (liveClanInfo) {
    await updateDumpLinkClanInfoForGuildSlot({
      guildId: input.record.guildId,
      slot: input.record.slot,
      clanInfoJson: liveClanInfo,
      clanInfoFetchedAt: new Date(),
    }).catch(() => null);
    return buildDumpClanInfoContent(liveClanInfo, input.record.link);
  }

  if (cachedClanInfo) {
    return buildDumpClanInfoContent(cachedClanInfo, input.record.link);
  }

  return buildDumpClanInfoFallbackContent(input.record.link);
}

export const Dump: Command = {
  name: "dump",
  description: "Show or update stored dump links",
  options: [
    {
      name: "edit",
      description: "Update the stored dump link",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "slot",
      description: "Dump slot to read, update, or delete",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      choices: [
        { name: "1", value: 1 },
        { name: "2", value: 2 },
        { name: "3", value: 3 },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
  ) => {
    if (!interaction.inGuild() || !interaction.guildId) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "This command can only be used in a server.",
      });
      return;
    }

    const edit = interaction.options.getString("edit", false)?.trim() ?? "";
    const slot = parseDumpSlot(interaction.options.getInteger("slot", false));
    const selectedSlot = slot ?? 1;
    if (interaction.options.getInteger("slot", false) !== null && slot === null) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Invalid dump slot. Use slot 1, 2, or 3.",
      });
      return;
    }

    if (edit) {
      const isAdmin = interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      );
      if (!isAdmin) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "not_allowed: only admins can edit the dump link.",
        });
        return;
      }

      const normalizedLink = normalizeDumpLink(edit);
      if (!normalizedLink) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "Invalid URL. Provide a valid http or https link.",
        });
        return;
      }

      const record = await upsertDumpLinkForGuildSlot({
        guildId: interaction.guildId,
        slot: selectedSlot,
        link: normalizedLink,
        updatedByDiscordUserId: interaction.user.id,
      });

      await safeReply(interaction, {
        ephemeral: true,
        content: formatDumpLink(record.link),
      });
      return;
    }

    if (slot !== null && !edit) {
      const isAdmin = interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator,
      );
      if (!isAdmin) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "not_allowed: only admins can delete dump slots.",
        });
        return;
      }

      const deleted = await deleteDumpLinkForGuildSlot({
        guildId: interaction.guildId,
        slot,
      });
      if (!deleted) {
        await safeReply(interaction, {
          ephemeral: true,
          content: `No dump link configured in slot ${slot}.`,
        });
        return;
      }

      await safeReply(interaction, {
        ephemeral: true,
        content: `Deleted dump link in slot ${slot}.`,
      });
      return;
    }

    const records = await listDumpLinksForGuild(interaction.guildId);
    if (records.length === 0) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "No dump link configured for this server.",
      });
      return;
    }

    const blocks: string[] = [];
    for (const record of records) {
      blocks.push(await renderDumpLinkBlock({ record }));
    }
    await safeReply(interaction, {
      ephemeral: true,
      content: blocks.join("\n------------\n"),
    });
  },
};
