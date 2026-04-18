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
  getDumpLinkForGuild,
  normalizeDumpLink,
  parseDumpClanInfoCache,
  updateDumpLinkClanInfoForGuild,
  upsertDumpLinkForGuild,
} from "../services/DumpLinkService";

function formatDumpLink(link: string): string {
  return `<${link}>`;
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

export const Dump: Command = {
  name: "dump",
  description: "Show or update the stored dump link",
  options: [
    {
      name: "edit",
      description: "Update the stored dump link",
      type: ApplicationCommandOptionType.String,
      required: false,
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

      const record = await upsertDumpLinkForGuild({
        guildId: interaction.guildId,
        link: normalizedLink,
        updatedByDiscordUserId: interaction.user.id,
      });

      await safeReply(interaction, {
        ephemeral: true,
        content: formatDumpLink(record.link),
      });
      return;
    }

    const record = await getDumpLinkForGuild(interaction.guildId);
    if (!record) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "No dump link configured for this server.",
      });
      return;
    }

    const cachedClanInfo = parseDumpClanInfoCache(record.clanInfoJson);
    const liveClanInfo = await fetchLiveDumpClanInfo({
      link: record.link,
      cachedClanTag: cachedClanInfo?.clanTag ?? null,
    });

    if (liveClanInfo) {
      await updateDumpLinkClanInfoForGuild({
        guildId: record.guildId,
        clanInfoJson: liveClanInfo,
        clanInfoFetchedAt: new Date(),
      }).catch(() => null);

      await safeReply(interaction, {
        ephemeral: true,
        content: buildDumpClanInfoContent(liveClanInfo, record.link),
      });
      return;
    }

    if (cachedClanInfo) {
      await safeReply(interaction, {
        ephemeral: true,
        content: buildDumpClanInfoContent(cachedClanInfo, record.link),
      });
      return;
    }

    await safeReply(interaction, {
      ephemeral: true,
      content: buildDumpClanInfoFallbackContent(record.link),
    });
  },
};
